"""
Compatibility admin router.

Provides the minimum `/api/admin/*` endpoints needed by the Scene Editor when
the full admin_routes module is unavailable.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import time
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from src.integrations.tradingagents_roster import (
    TRADINGAGENTS_AGENT_BY_ID,
    TRADINGAGENTS_CANONICAL_AGENTS,
    TRADINGAGENTS_PHASE_NUMBERS,
    normalize_tradingagents_agent_id,
    normalize_tradingagents_agent_name,
)
from src.integrations.tradingagents_runtime import build_tradingagents_run_id
from src.integrations.tradingagents_upstream_sidecar import (
    SidecarError,
    abort_run as abort_upstream_run,
    get_artifacts as get_upstream_artifacts,
    get_health as get_upstream_health,
    get_run as get_upstream_run,
    start_run as start_upstream_run,
    stream_events as stream_upstream_events,
)

router = APIRouter(prefix="/admin", tags=["admin-compat"])
logger = logging.getLogger(__name__)


def _get_data_access():
    from src.analytics.data_access import get_data_access
    return get_data_access()


def _as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _scene_config_signal() -> Dict[str, Any]:
    scenes = {}
    try:
        scenes = _as_dict(_get_data_access().get_config("pipeline_scenes"))
    except Exception:
        scenes = {}
    missing = len(scenes) == 0
    return {
        "scene_config_missing": missing,
        "scene_config_warning": (
            "Pipeline scenes config is missing. Timeline animation/pathfinding is disabled until scenes are saved."
            if missing else None
        ),
    }


TRADINGAGENTS_PROVIDER_MODEL_PRESETS: Dict[str, Dict[str, Any]] = {
    "nvidia": {
        "default_quick_model": "stockmark/stockmark-2-100b-instruct",
        "default_deep_model": "qwen/qwen3-next-80b-a3b-instruct",
        "models": [
            {"id": "stockmark/stockmark-2-100b-instruct", "name": "Stockmark 2 100B Instruct"},
            {"id": "qwen/qwen3-next-80b-a3b-instruct", "name": "Qwen3 Next 80B A3B Instruct"},
            {"id": "nvidia/nemotron-3-super-120b-a12b", "name": "NVIDIA Nemotron 3 Super 120B A12B"},
        ],
    },
    "openai": {
        "default_quick_model": "gpt-5.4-mini",
        "default_deep_model": "gpt-5.4",
        "models": [
            {"id": "gpt-5.4-mini", "name": "GPT-5.4 Mini"},
            {"id": "gpt-5.4-nano", "name": "GPT-5.4 Nano"},
            {"id": "gpt-5.4", "name": "GPT-5.4"},
            {"id": "gpt-4.1", "name": "GPT-4.1"},
            {"id": "gpt-5.2", "name": "GPT-5.2"},
            {"id": "gpt-5.4-pro", "name": "GPT-5.4 Pro"},
        ],
    },
    "anthropic": {
        "default_quick_model": "claude-sonnet-4-6",
        "default_deep_model": "claude-opus-4-6",
        "models": [
            {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6"},
            {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5"},
            {"id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5"},
            {"id": "claude-opus-4-6", "name": "Claude Opus 4.6"},
            {"id": "claude-opus-4-5", "name": "Claude Opus 4.5"},
        ],
    },
    "google": {
        "default_quick_model": "gemini-3-flash-preview",
        "default_deep_model": "gemini-3.1-pro-preview",
        "models": [
            {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash"},
            {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash"},
            {"id": "gemini-3.1-flash-lite-preview", "name": "Gemini 3.1 Flash Lite"},
            {"id": "gemini-2.5-flash-lite", "name": "Gemini 2.5 Flash Lite"},
            {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro"},
            {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro Preview"},
        ],
    },
    "xai": {
        "default_quick_model": "grok-4-1-fast-non-reasoning",
        "default_deep_model": "grok-4-0709",
        "models": [
            {"id": "grok-4-1-fast-non-reasoning", "name": "Grok 4.1 Fast (Non-Reasoning)"},
            {"id": "grok-4-fast-non-reasoning", "name": "Grok 4 Fast (Non-Reasoning)"},
            {"id": "grok-4-1-fast-reasoning", "name": "Grok 4.1 Fast (Reasoning)"},
            {"id": "grok-4-0709", "name": "Grok 4"},
            {"id": "grok-4-fast-reasoning", "name": "Grok 4 Fast (Reasoning)"},
        ],
    },
    "deepseek": {
        "default_quick_model": "deepseek-chat",
        "default_deep_model": "deepseek-reasoner",
        "models": [
            {"id": "deepseek-chat", "name": "DeepSeek V3.2"},
            {"id": "deepseek-reasoner", "name": "DeepSeek V3.2 (thinking)"},
            {"id": "custom", "name": "Custom model ID"},
        ],
    },
    "qwen": {
        "default_quick_model": "qwen3.5-flash",
        "default_deep_model": "qwen3.6-plus",
        "models": [
            {"id": "qwen3.5-flash", "name": "Qwen 3.5 Flash"},
            {"id": "qwen-plus", "name": "Qwen Plus"},
            {"id": "qwen3.6-plus", "name": "Qwen 3.6 Plus"},
            {"id": "qwen3.5-plus", "name": "Qwen 3.5 Plus"},
            {"id": "qwen3-max", "name": "Qwen 3 Max"},
            {"id": "custom", "name": "Custom model ID"},
        ],
    },
    "glm": {
        "default_quick_model": "glm-4.7",
        "default_deep_model": "glm-5.1",
        "models": [
            {"id": "glm-4.7", "name": "GLM-4.7"},
            {"id": "glm-5", "name": "GLM-5"},
            {"id": "glm-5.1", "name": "GLM-5.1"},
            {"id": "custom", "name": "Custom model ID"},
        ],
    },
    "azure": {
        "default_quick_model": "gpt-5.4-mini",
        "default_deep_model": "gpt-5.4",
        "models": [
            {"id": "gpt-5.4-mini", "name": "GPT-5.4 Mini (deployment name allowed)"},
            {"id": "gpt-5.4", "name": "GPT-5.4 (deployment name allowed)"},
            {"id": "custom", "name": "Custom deployment/model ID"},
        ],
    },
    "openrouter": {
        "default_quick_model": "",
        "default_deep_model": "",
        "models": [
            {"id": "custom", "name": "Dynamic from OpenRouter (or custom model ID)"},
        ],
    },
    "ollama": {
        "default_quick_model": "qwen3:latest",
        "default_deep_model": "glm-4.7-flash:latest",
        "models": [
            {"id": "qwen3:latest", "name": "Qwen3:latest (8B, local)"},
            {"id": "gpt-oss:latest", "name": "GPT-OSS:latest (20B, local)"},
            {"id": "glm-4.7-flash:latest", "name": "GLM-4.7-Flash:latest (30B, local)"},
        ],
    },
}

_ta_config: Dict[str, Any] = {
    "llm_provider": "nvidia",
    "quick_model": TRADINGAGENTS_PROVIDER_MODEL_PRESETS["nvidia"]["default_quick_model"],
    "deep_model": TRADINGAGENTS_PROVIDER_MODEL_PRESETS["nvidia"]["default_deep_model"],
    "output_language": "English",
    "drama_level": "medium",
    "scene_dialogue_preset": "buy_side_pod",
}

_active_runs: Dict[str, Dict[str, Any]] = {}
_active_run_tasks: Dict[str, asyncio.Task] = {}
_run_records: Dict[str, Dict[str, Any]] = {}
_active_upstream_runs: Dict[str, Dict[str, Any]] = {}
_RUNNING_STATUSES = {"running", "starting", "retrying", "aborting"}

_TA_AGENT_FLOW = [
    ("market_analyst", "Market Analyst", 1, "ANALYSTS"),
    ("social_analyst", "Social Analyst", 1, "ANALYSTS"),
    ("news_analyst", "News Analyst", 1, "ANALYSTS"),
    ("fundamentals_analyst", "Fundamentals Analyst", 1, "ANALYSTS"),
    ("bull_researcher", "Bull Researcher", 2, "RESEARCH"),
    ("bear_researcher", "Bear Researcher", 2, "RESEARCH"),
    ("research_manager", "Research Manager", 2, "RESEARCH"),
    ("trader", "Trader", 3, "TRADER"),
    ("aggressive_analyst", "Aggressive Analyst", 4, "RISK"),
    ("conservative_analyst", "Conservative Analyst", 4, "RISK"),
    ("neutral_analyst", "Neutral Analyst", 4, "RISK"),
    ("risk_judge", "Risk Judge", 5, "PORTFOLIO"),
]

_RAW_STATE_BASE: Dict[str, Any] = {
    "investment_debate_state": {
        "bull_history": "",
        "bear_history": "",
        "judge_decision": "",
        "current_response": "",
    },
    "risk_debate_state": {
        "aggressive_history": "",
        "conservative_history": "",
        "neutral_history": "",
        "judge_decision": "",
        "current_aggressive_response": "",
        "current_conservative_response": "",
        "current_neutral_response": "",
    },
}

_AGENT_RAW_STATE_PATHS: Dict[str, List[List[str]]] = {
    "market_analyst": [["market_report"]],
    "social_analyst": [["sentiment_report"]],
    "news_analyst": [["news_report"]],
    "fundamentals_analyst": [["fundamentals_report"]],
    "bull_researcher": [["investment_debate_state", "bull_history"], ["investment_debate_state", "current_response"]],
    "bear_researcher": [["investment_debate_state", "bear_history"]],
    "research_manager": [["investment_debate_state", "judge_decision"], ["investment_plan"]],
    "trader": [["trader_investment_plan"]],
    "aggressive_analyst": [["risk_debate_state", "aggressive_history"], ["risk_debate_state", "current_aggressive_response"]],
    "conservative_analyst": [["risk_debate_state", "conservative_history"], ["risk_debate_state", "current_conservative_response"]],
    "neutral_analyst": [["risk_debate_state", "neutral_history"], ["risk_debate_state", "current_neutral_response"]],
    "risk_judge": [["risk_debate_state", "judge_decision"], ["final_trade_decision"], ["final_decision"]],
}

_SCENE_TIMELINE_SLOTS: List[Tuple[int, str, str, Optional[str], str]] = [
    (0, "TA_TIMELINE_00_INIT", "INIT", None, "INIT"),
    (1, "TA_TIMELINE_01_MARKET_REPORT", "Market Report", "market_analyst", "MARKET REPORT"),
    (2, "TA_TIMELINE_02_SENTIMENT_REPORT", "Sentiment Report", "social_analyst", "SENTIMENT REPORT"),
    (3, "TA_TIMELINE_03_NEWS_REPORT", "News Report", "news_analyst", "NEWS REPORT"),
    (4, "TA_TIMELINE_04_FUNDAMENTALS_REPORT", "Fundamentals Report", "fundamentals_analyst", "FUNDAMENTALS REPORT"),
    (5, "TA_TIMELINE_05_BULL_RESEARCHER_REPORT", "Bull Researcher Report", "bull_researcher", "BULL RESEARCHER REPORT"),
    (6, "TA_TIMELINE_06_BEAR_RESEARCHER_REPORT", "Bear Researcher Report", "bear_researcher", "BEAR RESEARCHER REPORT"),
    (7, "TA_TIMELINE_07_RESEARCH_MANAGER_REPORT", "Research Manager Report", "research_manager", "RESEARCH MANAGER REPORT"),
    (8, "TA_TIMELINE_08_TRADER_PLAN_REPORT", "Trader Plan Report", "trader", "TRADER PLAN REPORT"),
    (9, "TA_TIMELINE_09_AGGRESSIVE_ANALYST_REPORT", "Aggressive Analyst Report", "aggressive_analyst", "AGGRESSIVE ANALYST REPORT"),
    (10, "TA_TIMELINE_10_CONSERVATIVE_ANALYST_REPORT", "Conservative Analyst Report", "conservative_analyst", "CONSERVATIVE ANALYST REPORT"),
    (11, "TA_TIMELINE_11_NEUTRAL_ANALYST_REPORT", "Neutral Analyst Report", "neutral_analyst", "NEUTRAL ANALYST REPORT"),
    (12, "TA_TIMELINE_12_PORTFOLIO_DECISION_REPORT", "Portfolio Decision Report", "risk_judge", "PORTFOLIO DECISION REPORT"),
]

_SCENE_SLOT_BY_AGENT_ID: Dict[str, Tuple[int, str, str, Optional[str], str]] = {
    slot_agent: slot
    for slot in _SCENE_TIMELINE_SLOTS
    for slot_agent in [slot[3]]
    if slot_agent
}

_SCENE_SLOT_KEY_ALIASES: Dict[str, List[str]] = {
    "TA_TIMELINE_00_INIT": ["TA_TIMELINE_00_INIT"],
    "TA_TIMELINE_01_MARKET_REPORT": ["TA_TIMELINE_01_MARKET_REPORT", "TA_TIMELINE_01_MARKET"],
    "TA_TIMELINE_02_SENTIMENT_REPORT": ["TA_TIMELINE_02_SENTIMENT_REPORT", "TA_TIMELINE_02_SENTIMENT"],
    "TA_TIMELINE_03_NEWS_REPORT": ["TA_TIMELINE_03_NEWS_REPORT", "TA_TIMELINE_03_NEWS"],
    "TA_TIMELINE_04_FUNDAMENTALS_REPORT": ["TA_TIMELINE_04_FUNDAMENTALS_REPORT", "TA_TIMELINE_04_FUNDAMENTALS"],
    "TA_TIMELINE_05_BULL_RESEARCHER_REPORT": ["TA_TIMELINE_05_BULL_RESEARCHER_REPORT", "TA_TIMELINE_05_BULL"],
    "TA_TIMELINE_06_BEAR_RESEARCHER_REPORT": ["TA_TIMELINE_06_BEAR_RESEARCHER_REPORT", "TA_TIMELINE_06_BEAR"],
    "TA_TIMELINE_07_RESEARCH_MANAGER_REPORT": ["TA_TIMELINE_07_RESEARCH_MANAGER_REPORT", "TA_TIMELINE_07_RESEARCH_MANAGER", "TA_TIMELINE_07_MANAGER"],
    "TA_TIMELINE_08_TRADER_PLAN_REPORT": ["TA_TIMELINE_08_TRADER_PLAN_REPORT", "TA_TIMELINE_08_TRADER"],
    "TA_TIMELINE_09_AGGRESSIVE_ANALYST_REPORT": ["TA_TIMELINE_09_AGGRESSIVE_ANALYST_REPORT", "TA_TIMELINE_09_AGGRESSIVE"],
    "TA_TIMELINE_10_CONSERVATIVE_ANALYST_REPORT": ["TA_TIMELINE_10_CONSERVATIVE_ANALYST_REPORT", "TA_TIMELINE_10_CONSERVATIVE"],
    "TA_TIMELINE_11_NEUTRAL_ANALYST_REPORT": ["TA_TIMELINE_11_NEUTRAL_ANALYST_REPORT", "TA_TIMELINE_11_NEUTRAL"],
    "TA_TIMELINE_12_PORTFOLIO_DECISION_REPORT": ["TA_TIMELINE_12_PORTFOLIO_DECISION_REPORT", "TA_TIMELINE_12_PORTFOLIO"],
}


def _default_scene_timeline_status() -> Dict[str, Dict[str, Any]]:
    status_map: Dict[str, Dict[str, Any]] = {}
    for index, scene_key, scene_label, _, scene_label_upper in _SCENE_TIMELINE_SLOTS:
        status_map[str(index)] = {
            "scene_index": index,
            "scene_key": scene_key,
            "scene_label": scene_label_upper,
            "status": "pending",
            "reason": None,
            "warning": None,
            "attempt": None,
            "scene_kind": None,
            "updated_at": None,
        }
    return status_map


def _resolve_scene_override_config(pipeline_scenes: Dict[str, Any], scene_key: str) -> tuple[str, Dict[str, Any]]:
    key_candidates = _SCENE_SLOT_KEY_ALIASES.get(scene_key) or [scene_key]
    for candidate in key_candidates:
        value = _as_dict(pipeline_scenes.get(candidate))
        if value:
            return candidate, value
    return scene_key, {}


def _provider_defaults(provider: str) -> Dict[str, Any]:
    return TRADINGAGENTS_PROVIDER_MODEL_PRESETS.get(provider, TRADINGAGENTS_PROVIDER_MODEL_PRESETS["nvidia"])


def _normalize_provider_and_models_for_compat_run(
    provider: str,
    quick_model: str,
    deep_model: str,
) -> tuple[str, str, str, Optional[str]]:
    normalized_provider = str(provider or "nvidia").strip().lower()
    normalized_quick = str(quick_model or "").strip()
    normalized_deep = str(deep_model or "").strip() or normalized_quick
    notice: Optional[str] = None

    # Compat runtime cannot reliably access host-local Ollama; avoid hard transport failure.
    if normalized_provider == "ollama":
        fallback = _provider_defaults("nvidia")
        normalized_provider = "nvidia"
        normalized_quick = str(fallback.get("default_quick_model") or normalized_quick or "")
        normalized_deep = str(fallback.get("default_deep_model") or normalized_deep or normalized_quick)
        notice = "Provider 'ollama' is unavailable in compat runtime; using NVIDIA defaults."

    if not normalized_quick or not normalized_deep:
        defaults = _provider_defaults(normalized_provider)
        normalized_quick = normalized_quick or str(defaults.get("default_quick_model") or "")
        normalized_deep = normalized_deep or str(defaults.get("default_deep_model") or normalized_quick)

    return normalized_provider, normalized_quick, normalized_deep, notice


async def _broadcast(payload: Dict[str, Any]) -> None:
    try:
        from src.api.trading_floor_compat import broadcast_payload
        await broadcast_payload(payload)
    except Exception:
        pass


def _phase_for_step(index: int) -> tuple[int, str]:
    _, _, phase_num, phase_name = _TA_AGENT_FLOW[index]
    return phase_num, phase_name


def _phase_name_for_agent(agent_id: Optional[str]) -> str:
    for candidate_id, _, _, phase_name in _TA_AGENT_FLOW:
        if candidate_id == agent_id:
            return phase_name
    return "ANALYSTS"


def _now_iso() -> str:
    return datetime.now().isoformat()


def _extract_active_run_id_from_sidecar_payload(payload: Any) -> Optional[str]:
    candidates: List[str] = []
    if isinstance(payload, str):
        candidates.append(payload)
    elif isinstance(payload, dict):
        for key in ("detail", "message", "error", "reason"):
            value = payload.get(key)
            if isinstance(value, str):
                candidates.append(value)
        nested_detail = payload.get("detail")
        if isinstance(nested_detail, dict):
            for key in ("message", "error", "detail"):
                value = nested_detail.get(key)
                if isinstance(value, str):
                    candidates.append(value)
    pattern = re.compile(r"run already active:\s*([A-Za-z0-9._:-]+)", flags=re.IGNORECASE)
    for text in candidates:
        match = pattern.search(text)
        if match:
            return match.group(1).strip()
    return None


async def _sync_active_run_from_sidecar(active_run_id: str) -> None:
    active_run_id = str(active_run_id or "").strip()
    if not active_run_id:
        return
    ticker = "UNKNOWN"
    try:
        sidecar_run = await get_upstream_run(active_run_id)
        request_payload = sidecar_run.get("request") if isinstance(sidecar_run, dict) else {}
        if isinstance(request_payload, dict):
            ticker = str(request_payload.get("ticker") or ticker).strip().upper() or ticker
    except Exception:
        pass
    _active_runs[active_run_id] = {
        "ticker": ticker,
        "started_at": _now_iso(),
        "status": "running",
    }
    _active_upstream_runs[active_run_id] = {
        "upstream_run_id": active_run_id,
        "ticker": ticker,
    }


async def _reconcile_local_active_runs_from_sidecar_health() -> None:
    try:
        health = await get_upstream_health()
    except SidecarError:
        return
    active_run_id = str((health or {}).get("active_run_id") or "").strip()
    active_status = str((health or {}).get("active_status") or "").strip().lower()
    if active_run_id and active_status == "running":
        await _sync_active_run_from_sidecar(active_run_id)
        return

    stale_local_run_ids = [
        run_id
        for run_id, run in list(_active_runs.items())
        if str(run.get("status") or "").lower() in _RUNNING_STATUSES
    ]
    for run_id in stale_local_run_ids:
        _active_runs.pop(run_id, None)
        _active_upstream_runs.pop(run_id, None)


def _read_json_file(path_value: Any) -> Dict[str, Any]:
    if not path_value:
        return {}
    path = Path(str(path_value))
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _read_text_file(path_value: Any) -> str:
    if not path_value:
        return ""
    path = Path(str(path_value))
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except Exception:
        return default


def _normalize_depth(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"quick", "shallow", "1"}:
        return "quick"
    if raw in {"deep", "5"}:
        return "deep"
    if raw in {"standard", "normal", "medium", "3"}:
        return "standard"
    return "standard"


def _normalize_report_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value).strip()
    if isinstance(value, list):
        for item in value:
            candidate = _normalize_report_text(item)
            if candidate:
                return candidate
        return ""
    if isinstance(value, dict):
        for key in (
            "report",
            "final_trade_decision",
            "final_decision",
            "judge_decision",
            "current_response",
            "reasoning",
            "content",
            "text",
            "message",
            "output",
            "analysis",
            "decision",
        ):
            candidate = _normalize_report_text(value.get(key))
            if candidate:
                return candidate
    return ""


def _excerpt(text: Any, limit: int = 280) -> str:
    cleaned = _normalize_report_text(text)
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(1, limit - 3)].rstrip() + "..."


def _strip_markdown_noise(text: str) -> str:
    cleaned = str(text or "")
    cleaned = re.sub(r"`+", "", cleaned)
    cleaned = re.sub(r"[*_#>|~]+", " ", cleaned)
    cleaned = re.sub(r"\[(.*?)\]\((.*?)\)", r"\1", cleaned)
    cleaned = re.sub(r"\b\d+\.\s*", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _compact_scene_dialogue_line(value: Any, *, soft_limit: int = 160, hard_limit: int = 180) -> str:
    text = _strip_markdown_noise(_normalize_report_text(value))
    if not text:
        return ""
    decision_match = re.search(r"\b(BUY|SELL|HOLD|LIQUIDATE)\b", text, flags=re.IGNORECASE)
    if decision_match and "rating" in text.lower():
        decision = decision_match.group(1).upper()
        text = f"Rating {decision}. {text}"
    sentence_split = re.split(r"(?<=[.!?])\s+", text)
    if sentence_split and sentence_split[0]:
        first_sentence = sentence_split[0].strip()
        if len(first_sentence) >= 36:
            text = first_sentence
    if len(text) <= soft_limit:
        return text
    clipped = text[:hard_limit].rsplit(" ", 1)[0].strip()
    if not clipped:
        clipped = text[:hard_limit].strip()
    return clipped.rstrip(".,;:") + "..."


def _extract_decision(text_value: Any) -> str:
    upper = str(text_value or "").upper()
    for action in ("LIQUIDATE", "SELL", "ADD", "BUY", "HOLD"):
        if action in upper:
            return action
    return "HOLD"


def _extract_reports_from_state(state: Dict[str, Any]) -> Dict[str, str]:
    debate = state.get("investment_debate_state") or {}
    risk = state.get("risk_debate_state") or {}
    reports = {
        "market_analyst": _normalize_report_text(state.get("market_report")),
        "social_analyst": _normalize_report_text(state.get("sentiment_report")),
        "news_analyst": _normalize_report_text(state.get("news_report")),
        "fundamentals_analyst": _normalize_report_text(state.get("fundamentals_report")),
        "bull_researcher": _normalize_report_text(debate.get("bull_history")),
        "bear_researcher": _normalize_report_text(debate.get("bear_history")),
        "research_manager": _normalize_report_text(debate.get("judge_decision") or state.get("investment_plan")),
        "trader": _normalize_report_text(state.get("trader_investment_plan")),
        "aggressive_analyst": _normalize_report_text(risk.get("aggressive_history")),
        "conservative_analyst": _normalize_report_text(risk.get("conservative_history")),
        "neutral_analyst": _normalize_report_text(risk.get("neutral_history")),
        "risk_judge": _normalize_report_text(risk.get("judge_decision") or state.get("final_trade_decision")),
    }
    return {key: value for key, value in reports.items() if value}


def _canonical_reports_from_payload(
    full_agent_reports: Dict[str, Any],
    final_state: Dict[str, Any],
) -> Dict[str, str]:
    reports: Dict[str, str] = {}
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_id = agent["id"]
        report = _normalize_report_text(full_agent_reports.get(agent_id))
        if not report:
            report = _extract_reports_from_state(final_state).get(agent_id, "")
        if report:
            reports[agent_id] = report
    return reports


def _build_raw_state(
    final_state: Dict[str, Any],
    reports: Dict[str, str],
    *,
    complete_report: str,
    decision: str,
    trade_date: str,
    depth: str,
    quick_model: str,
    deep_model: str,
    llm_provider: str,
    artifacts: Dict[str, Any],
    telemetry: Dict[str, Any],
    attempts: List[Dict[str, Any]],
) -> Dict[str, Any]:
    raw_state = copy.deepcopy(_RAW_STATE_BASE)
    for agent_id, report in reports.items():
        raw_state[agent_id] = report
        for raw_path in _AGENT_RAW_STATE_PATHS.get(agent_id, []):
            _set_nested(raw_state, raw_path, report)
    for key, value in (final_state or {}).items():
        if isinstance(value, dict) and isinstance(raw_state.get(key), dict):
            raw_state[key].update(value)
        else:
            raw_state.setdefault(key, value)
    raw_state["trade_date"] = trade_date
    raw_state["research_depth"] = depth
    raw_state["quick_model"] = quick_model
    raw_state["deep_model"] = deep_model
    raw_state["llm_provider"] = llm_provider
    raw_state["final_trade_decision"] = raw_state.get("final_trade_decision") or decision
    raw_state["final_decision"] = raw_state.get("final_decision") or decision
    raw_state["complete_report"] = complete_report
    raw_state["upstream_artifacts"] = artifacts
    raw_state["attempt"] = telemetry.get("attempt")
    raw_state["max_attempts"] = telemetry.get("max_attempts")
    raw_state["attempts"] = attempts
    raw_state["llm_calls"] = telemetry.get("llm_calls", 0)
    raw_state["tool_calls"] = telemetry.get("tool_calls", 0)
    raw_state["tokens_in"] = telemetry.get("tokens_in", 0)
    raw_state["tokens_out"] = telemetry.get("tokens_out", 0)
    return raw_state


def _build_agent_reports(reports: Dict[str, str]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_id = agent["id"]
        report = _normalize_report_text(reports.get(agent_id))
        if not report:
            continue
        rows.append({
            "agent": agent["display_name"],
            "report": report,
            "reasoning": report,
            "summary": _excerpt(report, 220),
        })
    return rows


def _upsert_live_agent_report(record: Dict[str, Any], agent_id: str, report_text: str) -> None:
    if not record or not agent_id or not report_text:
        return
    display_name = normalize_tradingagents_agent_name(agent_id) or agent_id
    rows = list(record.get("agent_reports") or [])
    next_rows: List[Dict[str, Any]] = []
    replaced = False
    for row in rows:
        row_agent_id = normalize_tradingagents_agent_id(row.get("agent"))
        if row_agent_id == agent_id:
            next_rows.append({
                "agent": display_name,
                "report": report_text,
                "reasoning": report_text,
                "summary": _excerpt(report_text, 220),
            })
            replaced = True
        else:
            next_rows.append(row)
    if not replaced:
        next_rows.append({
            "agent": display_name,
            "report": report_text,
            "reasoning": report_text,
            "summary": _excerpt(report_text, 220),
        })
    record["agent_reports"] = next_rows


def _default_scene_location_for_phase(phase: str) -> str:
    phase_key = str(phase or "").upper()
    if phase_key == "RESEARCH":
        return "table"
    if phase_key == "TRADER":
        return "ticker"
    if phase_key in {"RISK", "PORTFOLIO"}:
        return "scanner"
    return "scanner"


def _build_scene_entry_from_event(run_id: str, evt: Dict[str, Any], *, event_type: str) -> Optional[Dict[str, Any]]:
    if event_type not in {"pipeline_start", "agent_action", "agent_completed"}:
        return None
    pipeline_scenes = _as_dict(_get_data_access().get_config("pipeline_scenes"))
    if not pipeline_scenes:
        return None

    agent_id = normalize_tradingagents_agent_id(
        evt.get("current_step") or evt.get("agent") or evt.get("agent_display_name")
    )
    phase = str(evt.get("phase") or _phase_name_for_agent(agent_id)).upper() or "ANALYSTS"
    if event_type == "pipeline_start":
        scene_slot = _SCENE_TIMELINE_SLOTS[0]
        scene_kind = "init"
    else:
        scene_slot = _SCENE_SLOT_BY_AGENT_ID.get(agent_id or "")
        if not scene_slot:
            return None
        scene_kind = "report_completed" if event_type == "agent_completed" else "report_started"
    scene_index, scene_key, scene_label, slot_agent_id, scene_label_upper = scene_slot
    resolved_scene_key, scene_override = _resolve_scene_override_config(pipeline_scenes, scene_key)

    speaker = (
        normalize_tradingagents_agent_name(agent_id)
        or normalize_tradingagents_agent_name(evt.get("agent_display_name"))
        or evt.get("agent_display_name")
        or evt.get("agent")
        or "SYSTEM"
    )
    configured_agents = scene_override.get("agents")
    if isinstance(configured_agents, list) and configured_agents:
        scene_agents = [
            normalize_tradingagents_agent_name(item) or str(item)
            for item in configured_agents
            if str(item or "").strip()
        ]
    else:
        scene_agents = []

    stations_cfg = _as_dict(scene_override.get("stations"))
    animations_cfg = _as_dict(scene_override.get("animations"))
    paths_cfg = _as_dict(scene_override.get("paths"))
    scene_location = str(scene_override.get("location") or stations_cfg.get("default") or "").strip()

    missing_reasons: List[str] = []
    if not scene_override:
        missing_reasons.append("slot config not found")
    if not scene_agents:
        missing_reasons.append("agents list is empty")
    if not scene_location:
        missing_reasons.append("location/default station is missing")
    if not stations_cfg:
        missing_reasons.append("stations map is empty")
    if not animations_cfg:
        missing_reasons.append("animations map is empty")
    if not paths_cfg:
        missing_reasons.append("paths map is empty")

    if not missing_reasons:
        for agent_name in scene_agents:
            if not (stations_cfg.get(agent_name) or stations_cfg.get("default")):
                missing_reasons.append(f"station missing for {agent_name}")
            if not (animations_cfg.get(agent_name) or animations_cfg.get("default")):
                missing_reasons.append(f"animation missing for {agent_name}")
            if not (paths_cfg.get(agent_name) or paths_cfg.get("default")):
                missing_reasons.append(f"path missing for {agent_name}")

    if missing_reasons:
        warning = f"Scene slot {scene_index:02d} missing config: {', '.join(missing_reasons)}."
        return {
            "run_id": run_id,
            "scene_index": scene_index,
            "scene_key": resolved_scene_key,
            "scene_label": scene_label_upper,
            "scene_kind": scene_kind,
            "source_agent": slot_agent_id or agent_id,
            "source_report_slot": scene_index if slot_agent_id else 0,
            "attempt": _safe_int(evt.get("attempt"), 1),
            "created_at": str(evt.get("timestamp") or _now_iso()),
            "scene": None,
            "scene_status": "missing_config",
            "scene_warning": warning,
            "scene_config_missing_slot": True,
        }

    station_targets: List[Dict[str, str]] = []
    animations: List[Dict[str, str]] = []
    movement_plan: List[Dict[str, str]] = []
    agent_paths: Dict[str, str] = {}
    for agent_name in scene_agents:
        station = str(stations_cfg.get(agent_name) or stations_cfg.get("default") or scene_location)
        if event_type == "agent_action" and agent_name == speaker:
            default_anim = "analyzing"
        elif event_type == "agent_completed" and agent_name == speaker:
            default_anim = "completed"
        else:
            default_anim = "idle"
        animation = str(animations_cfg.get(agent_name) or animations_cfg.get("default") or default_anim)
        path_style = str(paths_cfg.get(agent_name) or paths_cfg.get("default") or "direct")
        station_targets.append({"agent": agent_name, "station": station})
        animations.append({"agent": agent_name, "animation": animation})
        movement_plan.append({"agent": agent_name, "station": station, "path": path_style})
        agent_paths[agent_name] = path_style

    dialogue_text = _compact_scene_dialogue_line(
        evt.get("dialogue")
        or evt.get("raw_excerpt")
        or evt.get("message")
        or (f"{speaker} analyzing..." if event_type == "agent_action" else f"{speaker} completed report.")
    )
    dialogue_line = {"speaker": speaker, "text": dialogue_text}
    scene = {
        "phase": phase,
        "ticker": str(evt.get("ticker") or "---").upper(),
        "headline": scene_label,
        "state": "completed" if event_type == "agent_completed" else "running",
        "active_agents": scene_agents,
        "dialogue": [dialogue_line],
        "station_targets": station_targets,
        "animations": animations,
        "agent_paths": agent_paths,
        "movement_plan": movement_plan,
        "script": {
            "dialogue": [dialogue_line],
            "scene_key": resolved_scene_key,
            "writer_source": "llm",
            "writer_model": "compat-scene-writer",
            "validation_passed": True,
            "scene_label": scene_label,
        },
        "script_meta": {
            "scene_key": resolved_scene_key,
            "scene_index": scene_index,
            "scene_label": scene_label,
            "source_agent": slot_agent_id or agent_id,
            "source_report_slot": scene_index,
            "timeline_kind": "tradingagents",
            "writer_source": "llm",
            "writer_model": "compat-scene-writer",
            "validation_passed": True,
        },
        "variant": "TradingAgents Timeline",
    }

    return {
        "run_id": run_id,
        "scene_index": scene_index,
        "scene_key": resolved_scene_key,
        "scene_label": scene_label_upper,
        "scene_kind": scene_kind,
        "source_agent": slot_agent_id or agent_id,
        "source_report_slot": scene_index if slot_agent_id else 0,
        "attempt": _safe_int(evt.get("attempt"), 1),
        "created_at": str(evt.get("timestamp") or _now_iso()),
        "scene": scene,
        "scene_status": "generated",
        "scene_warning": None,
        "scene_config_missing_slot": False,
    }


def _upsert_scene_history_entry(record: Dict[str, Any], entry: Dict[str, Any]) -> None:
    history = list(record.get("scene_history") or [])
    scene_index = _safe_int(entry.get("scene_index"), -1)
    replaced = False
    for idx, existing in enumerate(history):
        if _safe_int(existing.get("scene_index"), -2) == scene_index:
            history[idx] = entry
            replaced = True
            break
    if not replaced:
        history.append(entry)
    history.sort(key=lambda item: _safe_int(item.get("scene_index"), 999))
    record["scene_history"] = history
    if scene_index >= 0:
        record["latest_scene_index"] = scene_index
    timeline_status = record.get("scene_timeline_status")
    if not isinstance(timeline_status, dict):
        timeline_status = _default_scene_timeline_status()
    slot_key = str(scene_index)
    slot = dict(timeline_status.get(slot_key) or {})
    slot.update(
        {
            "scene_index": scene_index,
            "scene_key": entry.get("scene_key"),
            "scene_label": entry.get("scene_label"),
            "status": entry.get("scene_status") or ("generated" if entry.get("scene") else "pending"),
            "reason": entry.get("scene_status"),
            "warning": entry.get("scene_warning"),
            "attempt": entry.get("attempt"),
            "scene_kind": entry.get("scene_kind"),
            "updated_at": entry.get("created_at"),
        }
    )
    timeline_status[slot_key] = slot
    record["scene_timeline_status"] = timeline_status


def _upstream_sidecar_payload(
    run_id: str,
    payload: Dict[str, Any],
    provider: str,
    quick_model: str,
    deep_model: str,
    depth: str,
    output_language: str,
) -> Dict[str, Any]:
    return {
        "run_id": run_id,
        "ticker": str(payload.get("ticker") or "NVDA").strip().upper(),
        "date": str(payload.get("date") or datetime.now().strftime("%Y-%m-%d")),
        "provider": provider,
        "quickModel": quick_model,
        "deepModel": deep_model,
        "researchDepth": depth,
        "outputLanguage": output_language,
    }


def _seed_run_record(
    run_id: str,
    payload: Dict[str, Any],
    *,
    provider: str,
    quick_model: str,
    deep_model: str,
    depth: str,
    output_language: str,
) -> Dict[str, Any]:
    now = _now_iso()
    trade_date = str(payload.get("date") or datetime.now().strftime("%Y-%m-%d"))
    return {
        "run_id": run_id,
        "ticker": str(payload.get("ticker") or "NVDA").strip().upper(),
        "run_status": "RUNNING",
        "status": "running",
        "created_at": now,
        "completed_at": None,
        "research_depth": depth,
        "quick_model": quick_model,
        "deep_model": deep_model,
        "llm_provider": provider,
        "output_language": output_language,
        "agent_reports": [],
        "attempt": 1,
        "max_attempts": 1,
        "llm_calls": 0,
        "tool_calls": 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "scene_history": [],
        "latest_scene_index": 0,
        "scene_timeline_status": _default_scene_timeline_status(),
        "raw_state": {
            "trade_date": trade_date,
            "research_depth": depth,
            "quick_model": quick_model,
            "deep_model": deep_model,
            "llm_provider": provider,
            **copy.deepcopy(_RAW_STATE_BASE),
        },
    }


async def _set_idle_pipeline_state(run_id: Optional[str] = None, *, status: str = "idle", action: str = "Awaiting pipeline activation.") -> None:
    try:
        from src.api.trading_floor_compat import agent_states, broadcast_payload, pipeline_state

        for agent_name, agent_state in agent_states.items():
            agent_state["status"] = "idle"
            agent_state["message"] = action
            agent_state["last_update"] = _now_iso()
            agent_state.pop("reasoning", None)

        pipeline_state["phase"] = "IDLE"
        pipeline_state["phase_num"] = 0
        pipeline_state["status"] = status
        pipeline_state["action"] = action
        pipeline_state["active_run_id"] = None
        pipeline_state["run_id"] = None
        pipeline_state["current_step"] = None
        pipeline_state["agent_display_name"] = None
        pipeline_state["timestamp"] = _now_iso()
        await broadcast_payload({"type": "pipeline_state", "pipeline_state": dict(pipeline_state), "timestamp": pipeline_state["timestamp"]})
    except Exception:
        if run_id:
            logger.exception("Failed to reset compat pipeline state for %s", run_id)


async def _apply_live_event(run_id: str, event: Dict[str, Any]) -> None:
    try:
        from src.api.trading_floor_compat import agent_states, pipeline_state
    except Exception:
        return

    evt = dict(event or {})
    event_type = str(evt.get("type") or "").strip().lower()
    agent_id = normalize_tradingagents_agent_id(
        evt.get("current_step") or evt.get("agent") or evt.get("agent_display_name")
    )
    display_name = normalize_tradingagents_agent_name(agent_id or evt.get("agent_display_name") or evt.get("agent")) or evt.get("agent_display_name")
    phase_num = _safe_int(evt.get("phase_num"), TRADINGAGENTS_PHASE_NUMBERS.get(agent_id or "", pipeline_state.get("phase_num", 0)))
    phase = str(evt.get("phase") or _phase_name_for_agent(agent_id)).upper()
    timestamp = str(evt.get("timestamp") or _now_iso())
    record = _run_records.get(run_id)
    pipeline_state["pipeline_mode"] = "tradingagents"
    pipeline_state["active_run_id"] = run_id
    pipeline_state["run_id"] = run_id
    pipeline_state["ticker"] = str(evt.get("ticker") or pipeline_state.get("ticker") or "---").upper()
    if evt.get("trade_date"):
        pipeline_state["trade_date"] = evt.get("trade_date")
    if evt.get("llm_provider") is not None:
        pipeline_state["llm_provider"] = evt.get("llm_provider")
    if evt.get("quick_model") is not None:
        pipeline_state["quick_model"] = evt.get("quick_model")
    if evt.get("deep_model") is not None:
        pipeline_state["deep_model"] = evt.get("deep_model")
    if evt.get("research_depth") is not None:
        pipeline_state["research_depth"] = _normalize_depth(evt.get("research_depth"))
    if phase_num:
        pipeline_state["phase_num"] = phase_num
    if phase:
        pipeline_state["phase"] = phase
    pipeline_state["current_step"] = agent_id or pipeline_state.get("current_step")
    pipeline_state["agent_display_name"] = display_name or pipeline_state.get("agent_display_name")
    pipeline_state["status"] = evt.get("status") or pipeline_state.get("status") or "running"
    pipeline_state["action"] = evt.get("message") or evt.get("action") or pipeline_state.get("action")
    pipeline_state["attempt"] = _safe_int(evt.get("attempt"), pipeline_state.get("attempt", 1))
    pipeline_state["max_attempts"] = _safe_int(evt.get("max_attempts"), pipeline_state.get("max_attempts", 1))
    if "scene_config_missing" in evt:
        pipeline_state["scene_config_missing"] = bool(evt.get("scene_config_missing"))
    if "scene_config_warning" in evt:
        pipeline_state["scene_config_warning"] = evt.get("scene_config_warning")
    for key in ("llm_calls", "tool_calls", "tokens_in", "tokens_out", "agents_completed", "reports_completed"):
        if evt.get(key) is not None:
            pipeline_state[key] = _safe_int(evt.get(key), pipeline_state.get(key, 0))
    pipeline_state["timestamp"] = timestamp

    if record:
        record["run_status"] = "RUNNING"
        record["status"] = "running"
        for key in ("llm_calls", "tool_calls", "tokens_in", "tokens_out", "attempt", "max_attempts"):
            if evt.get(key) is not None:
                record[key] = _safe_int(evt.get(key), record.get(key, 0 if key not in {"attempt", "max_attempts"} else 1))
                record["raw_state"][key] = record[key]

    if display_name and display_name in agent_states and event_type in {"agent_action", "agent_completed"}:
        agent_state = agent_states[display_name]
        agent_state["status"] = "completed" if event_type == "agent_completed" else str(evt.get("status") or "analyzing")
        agent_state["message"] = evt.get("message") or evt.get("action") or agent_state.get("message")
        agent_state["reasoning"] = evt.get("report") or evt.get("raw_excerpt") or agent_state.get("reasoning")
        agent_state["last_update"] = timestamp

    if record and agent_id and event_type == "agent_completed":
        report_text = _normalize_report_text(evt.get("report") or evt.get("raw_excerpt"))
        if report_text:
            record["raw_state"][agent_id] = report_text
            for raw_path in _AGENT_RAW_STATE_PATHS.get(agent_id, []):
                _set_nested(record["raw_state"], raw_path, report_text)
            _upsert_live_agent_report(record, agent_id, report_text)

    if display_name and agent_id:
        scene_slot = _SCENE_SLOT_BY_AGENT_ID.get(agent_id)
        if scene_slot:
            live_scene_key = scene_slot[1]
            dialogue_map = _as_dict(pipeline_state.get("live_step_dialogue"))
            lines = list(dialogue_map.get(live_scene_key) or [])
            lines.append(
                {
                    "agent": display_name,
                    "text": _compact_scene_dialogue_line(evt.get("raw_excerpt") or evt.get("message") or ""),
                    "timestamp": timestamp,
                }
            )
            dialogue_map[live_scene_key] = lines[-8:]
            pipeline_state["live_step_dialogue"] = dialogue_map

    if event_type == "run_retrying":
        pipeline_state["status"] = "retrying"
    elif event_type == "run_completed":
        pipeline_state["phase"] = "COMPLETE"
        pipeline_state["phase_num"] = 5
        pipeline_state["status"] = "complete"
        pipeline_state["action"] = evt.get("decision") or evt.get("message") or pipeline_state.get("action")
    elif event_type == "run_failed":
        pipeline_state["phase"] = "FAILED"
        pipeline_state["status"] = "failed"
        pipeline_state["action"] = evt.get("error_message") or evt.get("error") or "Run failed"
    elif event_type == "run_aborted":
        pipeline_state["phase"] = "ABORTED"
        pipeline_state["status"] = "aborted"
        pipeline_state["action"] = evt.get("message") or "Run aborted"

    if record and event_type in {"pipeline_start", "agent_action", "agent_completed"}:
        generated_scene_entry = _build_scene_entry_from_event(run_id, evt, event_type=event_type)
        if generated_scene_entry:
            _upsert_scene_history_entry(record, generated_scene_entry)
            if generated_scene_entry.get("scene"):
                await _broadcast(
                    {
                        "type": "tradingagents_scene_generated",
                        "run_id": run_id,
                        "active_run_id": run_id,
                        "scene_index": generated_scene_entry.get("scene_index"),
                        "scene_key": generated_scene_entry.get("scene_key"),
                        "scene_label": generated_scene_entry.get("scene_label"),
                        "scene_kind": generated_scene_entry.get("scene_kind"),
                        "source_agent": generated_scene_entry.get("source_agent"),
                        "source_report_slot": generated_scene_entry.get("source_report_slot"),
                        "attempt": generated_scene_entry.get("attempt"),
                        "timestamp": generated_scene_entry.get("created_at"),
                        "scene": generated_scene_entry.get("scene"),
                    }
                )
            else:
                await _broadcast(
                    {
                        "type": "tradingagents_scene_slot_missing",
                        "run_id": run_id,
                        "active_run_id": run_id,
                        "scene_index": generated_scene_entry.get("scene_index"),
                        "scene_key": generated_scene_entry.get("scene_key"),
                        "scene_label": generated_scene_entry.get("scene_label"),
                        "scene_kind": generated_scene_entry.get("scene_kind"),
                        "source_agent": generated_scene_entry.get("source_agent"),
                        "source_report_slot": generated_scene_entry.get("source_report_slot"),
                        "attempt": generated_scene_entry.get("attempt"),
                        "timestamp": generated_scene_entry.get("created_at"),
                        "scene_config_missing_slot": True,
                        "scene_config_warning": generated_scene_entry.get("scene_warning"),
                    }
                )

    await _broadcast({
        **evt,
        "run_id": run_id,
        "active_run_id": run_id,
        "current_step": agent_id or evt.get("current_step"),
        "agent_display_name": display_name or evt.get("agent_display_name"),
        "phase": pipeline_state.get("phase"),
        "phase_num": pipeline_state.get("phase_num"),
        "ticker": pipeline_state.get("ticker"),
        "trade_date": pipeline_state.get("trade_date"),
        "quick_model": pipeline_state.get("quick_model"),
        "deep_model": pipeline_state.get("deep_model"),
        "research_depth": pipeline_state.get("research_depth"),
        "llm_provider": pipeline_state.get("llm_provider"),
        "timestamp": timestamp,
    })


def _materialize_completed_run(
    run_id: str,
    record: Dict[str, Any],
    *,
    completion_event: Dict[str, Any],
    sidecar_run: Dict[str, Any],
    artifacts_payload: Dict[str, Any],
) -> Dict[str, Any]:
    artifacts = dict(artifacts_payload.get("artifacts") or {})
    final_state = _read_json_file(artifacts.get("final_state_path"))
    if not final_state:
        raise RuntimeError("Upstream run completed but final_state.json is missing or unreadable.")
    file_reports = _read_json_file(artifacts.get("full_agent_reports_path"))
    complete_report = _read_text_file(artifacts.get("complete_report_path"))
    if not file_reports:
        file_reports = completion_event.get("full_agent_reports") or {}
    if not isinstance(file_reports, dict):
        file_reports = {}
    canonical_reports = _canonical_reports_from_payload(file_reports, final_state)
    missing_agent_ids = sorted(
        agent["id"] for agent in TRADINGAGENTS_CANONICAL_AGENTS if not _normalize_report_text(canonical_reports.get(agent["id"]))
    )
    if missing_agent_ids:
        raise RuntimeError(f"Upstream reports incomplete: missing canonical reports for {', '.join(missing_agent_ids)}")
    if not complete_report:
        complete_report = _normalize_report_text(completion_event.get("complete_report"))
    if not complete_report:
        raise RuntimeError("Upstream run completed but complete_report.md is missing or unreadable.")

    decision = _extract_decision(
        completion_event.get("decision")
        or completion_event.get("prediction")
        or final_state.get("final_trade_decision")
        or complete_report
    )
    attempts = completion_event.get("attempts") or []
    telemetry = {
        "attempt": completion_event.get("attempt") or sidecar_run.get("attempt") or 1,
        "max_attempts": completion_event.get("max_attempts") or sidecar_run.get("max_attempts") or 1,
        "llm_calls": completion_event.get("llm_calls") or sidecar_run.get("llm_calls") or 0,
        "tool_calls": completion_event.get("tool_calls") or sidecar_run.get("tool_calls") or 0,
        "tokens_in": completion_event.get("tokens_in") or sidecar_run.get("tokens_in") or 0,
        "tokens_out": completion_event.get("tokens_out") or sidecar_run.get("tokens_out") or 0,
    }

    record["run_status"] = "COMPLETED"
    record["status"] = "complete"
    record["completed_at"] = sidecar_run.get("completed_at") or completion_event.get("timestamp") or _now_iso()
    record["attempt"] = telemetry["attempt"]
    record["max_attempts"] = telemetry["max_attempts"]
    record["llm_calls"] = _safe_int(telemetry["llm_calls"], 0)
    record["tool_calls"] = _safe_int(telemetry["tool_calls"], 0)
    record["tokens_in"] = _safe_int(telemetry["tokens_in"], 0)
    record["tokens_out"] = _safe_int(telemetry["tokens_out"], 0)
    record["recommended_action"] = decision
    record["model_action"] = decision
    record["prediction"] = str(completion_event.get("prediction") or final_state.get("final_trade_decision") or decision)
    record["reasoning"] = complete_report[:4000]
    record["report_excerpt"] = _excerpt(complete_report, 800)
    record["complete_report"] = complete_report
    record["agent_reports"] = _build_agent_reports(canonical_reports)
    record["raw_state"] = _build_raw_state(
        final_state,
        canonical_reports,
        complete_report=complete_report,
        decision=decision,
        trade_date=str(record["raw_state"].get("trade_date") or final_state.get("trade_date") or record.get("created_at", "")[:10]),
        depth=str(record.get("research_depth") or "standard"),
        quick_model=str(record.get("quick_model") or ""),
        deep_model=str(record.get("deep_model") or ""),
        llm_provider=str(record.get("llm_provider") or ""),
        artifacts=artifacts,
        telemetry=telemetry,
        attempts=attempts if isinstance(attempts, list) else [],
    )
    return record


def _materialize_failed_run(
    run_id: str,
    record: Dict[str, Any],
    *,
    sidecar_run: Dict[str, Any],
    failure_event: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    failure_event = failure_event or {}
    status = str(sidecar_run.get("status") or "").upper()
    record["run_status"] = "ABORTED" if status == "ABORTED" else "FAILED"
    record["status"] = "aborted" if status == "ABORTED" else "failed"
    record["completed_at"] = sidecar_run.get("completed_at") or _now_iso()
    record["attempt"] = sidecar_run.get("attempt") or failure_event.get("attempt") or record.get("attempt") or 1
    record["max_attempts"] = sidecar_run.get("max_attempts") or failure_event.get("max_attempts") or record.get("max_attempts") or 1
    record["llm_calls"] = _safe_int(sidecar_run.get("llm_calls"), record.get("llm_calls", 0))
    record["tool_calls"] = _safe_int(sidecar_run.get("tool_calls"), record.get("tool_calls", 0))
    record["tokens_in"] = _safe_int(sidecar_run.get("tokens_in"), record.get("tokens_in", 0))
    record["tokens_out"] = _safe_int(sidecar_run.get("tokens_out"), record.get("tokens_out", 0))
    record["error_code"] = sidecar_run.get("error_code") or failure_event.get("error_code")
    record["error_message"] = sidecar_run.get("error_message") or failure_event.get("error_message") or failure_event.get("error")
    record["reasoning"] = str(record.get("error_message") or "Upstream run failed.")
    record["report_excerpt"] = _excerpt(record["reasoning"], 300)
    return record


async def _pump_upstream_run(run_id: str, upstream_run_id: str) -> None:
    completion_event: Optional[Dict[str, Any]] = None
    failure_event: Optional[Dict[str, Any]] = None
    last_seq = 0
    reconnect_delay_seconds = 1.25
    recovery_window_seconds = 90.0
    recovery_started_at: Optional[float] = None
    last_stream_error: Optional[BaseException] = None

    async def _reconcile_sidecar_terminal_state() -> Optional[str]:
        nonlocal completion_event, failure_event

        sidecar_run = await get_upstream_run(upstream_run_id)
        record = _run_records.get(run_id)
        if not record:
            return "missing_record"

        sidecar_status = str(sidecar_run.get("status") or "").upper()
        if sidecar_status == "COMPLETED":
            artifacts_payload = await get_upstream_artifacts(upstream_run_id)
            if not completion_event:
                completion_event = {
                    "type": "run_completed",
                    "run_id": run_id,
                    "timestamp": sidecar_run.get("completed_at") or _now_iso(),
                    "attempt": sidecar_run.get("attempt") or 1,
                    "max_attempts": sidecar_run.get("max_attempts") or 1,
                    "llm_calls": sidecar_run.get("llm_calls"),
                    "tool_calls": sidecar_run.get("tool_calls"),
                    "tokens_in": sidecar_run.get("tokens_in"),
                    "tokens_out": sidecar_run.get("tokens_out"),
                }
                await _apply_live_event(run_id, completion_event)
            _materialize_completed_run(
                run_id,
                record,
                completion_event=completion_event,
                sidecar_run=sidecar_run,
                artifacts_payload=artifacts_payload,
            )
            _active_runs[run_id]["status"] = "completed"
            return "completed"

        if sidecar_status in {"FAILED", "ABORTED"}:
            if not failure_event:
                error_message = str(
                    sidecar_run.get("error_message")
                    or sidecar_run.get("error")
                    or f"Upstream run ended with status {sidecar_status}."
                ).strip()
                failure_event = {
                    "type": "run_aborted" if sidecar_status == "ABORTED" else "run_failed",
                    "run_id": run_id,
                    "timestamp": sidecar_run.get("completed_at") or _now_iso(),
                    "error_code": sidecar_run.get("error_code"),
                    "error_message": error_message,
                    "error": error_message,
                    "attempt": sidecar_run.get("attempt"),
                    "max_attempts": sidecar_run.get("max_attempts"),
                }
                await _apply_live_event(run_id, failure_event)
            _materialize_failed_run(run_id, record, sidecar_run=sidecar_run, failure_event=failure_event)
            _active_runs[run_id]["status"] = record["status"]
            return "failed"

        return None

    try:
        while True:
            saw_envelope = False
            try:
                async for envelope in stream_upstream_events(upstream_run_id, from_seq=last_seq):
                    saw_envelope = True
                    recovery_started_at = None
                    last_stream_error = None

                    seq = envelope.get("sequence")
                    if isinstance(seq, int):
                        last_seq = max(last_seq, seq)

                    kind = str(envelope.get("kind") or "").lower()
                    if kind == "event":
                        evt = dict(envelope.get("event") or {})
                        if not evt:
                            continue
                        event_type = str(evt.get("type") or "").lower()
                        if event_type == "run_completed":
                            completion_event = evt
                        elif event_type in {"run_failed", "run_aborted"}:
                            failure_event = evt
                        await _apply_live_event(run_id, evt)
                    elif kind == "terminal":
                        break
            except SidecarError as exc:
                last_stream_error = exc

            try:
                terminal_outcome = await _reconcile_sidecar_terminal_state()
            except SidecarError as exc:
                last_stream_error = exc
                terminal_outcome = None
            if terminal_outcome in {"completed", "failed", "missing_record"}:
                break

            if recovery_started_at is None:
                recovery_started_at = time.monotonic()
            recovery_elapsed = time.monotonic() - recovery_started_at
            if recovery_elapsed >= recovery_window_seconds:
                if last_stream_error:
                    raise RuntimeError(
                        f"Sidecar stream recovery deadline exceeded ({int(recovery_window_seconds)}s): {last_stream_error}"
                    ) from last_stream_error
                raise RuntimeError(
                    f"Sidecar stream recovery deadline exceeded ({int(recovery_window_seconds)}s) while upstream remained non-terminal."
                )

            # Stream ended/disconnected without terminal status; reconnect from last seen sequence.
            if not saw_envelope and last_stream_error is None:
                logger.warning(
                    "Compat stream ended without terminal status for run_id=%s upstream_run_id=%s seq=%s; reconnecting.",
                    run_id,
                    upstream_run_id,
                    last_seq,
                )
            elif last_stream_error is not None:
                logger.warning(
                    "Compat stream interrupted for run_id=%s upstream_run_id=%s seq=%s; reconnecting: %s",
                    run_id,
                    upstream_run_id,
                    last_seq,
                    last_stream_error,
                )
            await asyncio.sleep(reconnect_delay_seconds)

    except Exception as exc:
        logger.exception("Compat upstream run failed for %s", run_id)
        error_text = str(exc)
        lowered = error_text.lower()
        error_code = None
        if "recovery deadline exceeded" in lowered:
            error_code = "STREAM_RECOVERY_TIMEOUT"
        elif "sidecar stream request failed" in lowered:
            error_code = "STREAM_RECOVERY_FAILED"
        record = _run_records.get(run_id)
        if record:
            record["run_status"] = "FAILED"
            record["status"] = "failed"
            record["completed_at"] = _now_iso()
            if error_code:
                record["error_code"] = error_code
            record["error_message"] = str(exc)
            record["reasoning"] = str(exc)
            record["report_excerpt"] = _excerpt(exc, 300)
        if run_id in _active_runs:
            _active_runs[run_id]["status"] = "failed"
        failed_event = {
            "type": "run_failed",
            "run_id": run_id,
            "error": str(exc),
            "error_message": str(exc),
            "timestamp": _now_iso(),
        }
        if error_code:
            failed_event["error_code"] = error_code
        await _apply_live_event(run_id, failed_event)
    finally:
        await _set_idle_pipeline_state(run_id, status="idle", action="Awaiting pipeline activation.")
        _active_run_tasks.pop(run_id, None)
        _active_upstream_runs.pop(run_id, None)


def _set_nested(target: Dict[str, Any], path: List[str], value: Any) -> None:
    if not path:
        return
    cursor = target
    for segment in path[:-1]:
        existing = cursor.get(segment)
        if not isinstance(existing, dict):
            existing = {}
            cursor[segment] = existing
        cursor = existing
    cursor[path[-1]] = value


@router.get("/tradingagents/config")
async def get_tradingagents_config():
    raise HTTPException(
        status_code=410,
        detail="Deprecated: runner config is browser-managed (BYOK) and no longer served by backend.",
    )


@router.post("/tradingagents/config")
async def set_tradingagents_config(request: Request):
    raise HTTPException(
        status_code=410,
        detail="Deprecated: runner config is browser-managed (BYOK) and no longer persisted by backend.",
    )


@router.get("/tradingagents/models")
async def list_tradingagents_models(provider: str = "nvidia"):
    raise HTTPException(
        status_code=410,
        detail="Deprecated: runner models are now selected client-side (manual input + presets).",
    )


@router.get("/tradingagents/models/health")
async def list_tradingagents_models_health(provider: str = "nvidia"):
    raise HTTPException(
        status_code=410,
        detail="Deprecated: scene model health is no longer backend-served for runner mode.",
    )


@router.post("/trading-agents/run")
async def run_trading_agents(request: Request):
    raise HTTPException(
        status_code=410,
        detail="Deprecated: /trading-agents/run is disabled. Use browser-direct BYOK runner.",
    )

    payload = await request.json()
    ticker = str(payload.get("ticker") or "NVDA").strip().upper()
    trade_date = str(payload.get("date") or datetime.now().strftime("%Y-%m-%d"))
    provider = str(payload.get("provider") or _ta_config.get("llm_provider") or "nvidia").strip().lower()
    quick_model = str(payload.get("quickModel") or payload.get("quick_model") or _ta_config.get("quick_model") or "").strip()
    deep_model = str(payload.get("deepModel") or payload.get("deep_model") or _ta_config.get("deep_model") or quick_model).strip()
    depth = _normalize_depth(payload.get("depth") or payload.get("research_depth"))
    output_language = str(payload.get("outputLanguage") or payload.get("output_language") or _ta_config.get("output_language") or "English").strip() or "English"
    provider, quick_model, deep_model, provider_notice = _normalize_provider_and_models_for_compat_run(
        provider,
        quick_model,
        deep_model,
    )
    run_id = build_tradingagents_run_id(ticker, trade_date, prefix="ta")

    await _reconcile_local_active_runs_from_sidecar_health()
    active_local_run = next(
        (
            (run_key, run)
            for run_key, run in _active_runs.items()
            if str(run.get("status") or "").lower() in _RUNNING_STATUSES
        ),
        None,
    )
    if active_local_run:
        active_run_id, _ = active_local_run
        raise HTTPException(
            status_code=409,
            detail={
                "message": "A TradingAgents run is already in progress.",
                "active_run_id": active_run_id,
            },
        )

    sidecar_payload = _upstream_sidecar_payload(
        run_id,
        payload,
        provider=provider,
        quick_model=quick_model,
        deep_model=deep_model,
        depth=depth,
        output_language=output_language,
    )

    try:
        sidecar_start = await start_upstream_run(sidecar_payload)
    except SidecarError as exc:
        active_run_id = _extract_active_run_id_from_sidecar_payload(exc.payload)
        if exc.status_code == 409:
            if active_run_id:
                await _sync_active_run_from_sidecar(active_run_id)
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "TradingAgents upstream run already active.",
                    "active_run_id": active_run_id,
                    "sidecar": exc.payload,
                },
            )
        logger.error("Compat sidecar start failed: %s payload=%s", exc, exc.payload)
        raise HTTPException(
            status_code=exc.status_code or 503,
            detail={
                "message": "TradingAgents upstream sidecar is unavailable.",
                "error": str(exc),
                "sidecar": exc.payload,
            },
        )

    upstream_run_id = str(sidecar_start.get("run_id") or run_id)
    now = _now_iso()
    _active_runs[run_id] = {"ticker": ticker, "started_at": now, "status": "running"}
    _active_upstream_runs[run_id] = {
        "upstream_run_id": upstream_run_id,
        "ticker": ticker,
        "trade_date": trade_date,
    }
    _run_records[run_id] = _seed_run_record(
        run_id,
        payload,
        provider=provider,
        quick_model=quick_model,
        deep_model=deep_model,
        depth=depth,
        output_language=output_language,
    )
    _run_records[run_id]["raw_state"]["upstream_run_id"] = upstream_run_id
    if provider_notice:
        _run_records[run_id]["raw_state"]["compat_provider_notice"] = provider_notice
        _run_records[run_id]["reasoning"] = provider_notice
        _run_records[run_id]["report_excerpt"] = _excerpt(provider_notice, 300)
    scene_signal = _scene_config_signal()
    await _apply_live_event(
        run_id,
        {
            "type": "pipeline_start",
            "run_id": run_id,
            "ticker": ticker,
            "trade_date": trade_date,
            "llm_provider": provider,
            "quick_model": quick_model,
            "deep_model": deep_model,
            "research_depth": depth,
            "phase": "ANALYSTS",
            "phase_num": 1,
            "status": "running",
            "message": "Starting TradingAgents pipeline...",
            "timestamp": now,
            **scene_signal,
        },
    )
    await _apply_live_event(
        run_id,
        {
            "type": "agent_action",
            "run_id": run_id,
            "ticker": ticker,
            "trade_date": trade_date,
            "llm_provider": provider,
            "quick_model": quick_model,
            "deep_model": deep_model,
            "research_depth": depth,
            "phase": "ANALYSTS",
            "phase_num": 1,
            "current_step": "market_analyst",
            "agent": "market_analyst",
            "agent_display_name": "Market Analyst",
            "scene_stage": "start",
            "status": "working",
            "message": f"Market Analyst analyzing {ticker}...",
            "raw_excerpt": f"Market Analyst started analysis for {ticker}.",
            "timestamp": _now_iso(),
            **scene_signal,
        },
    )

    task = asyncio.create_task(_pump_upstream_run(run_id, upstream_run_id))
    _active_run_tasks[run_id] = task

    response_payload: Dict[str, Any] = {"success": True, "run_id": run_id, "status": "started", "ticker": ticker}
    if provider_notice:
        response_payload["notice"] = provider_notice
    return response_payload


@router.post("/trading-agents/stop")
async def stop_trading_agents():
    raise HTTPException(
        status_code=410,
        detail="Deprecated: /trading-agents/stop is disabled. Stop runs in the browser runner.",
    )

    await _reconcile_local_active_runs_from_sidecar_health()
    stopped_any = False
    for run_id, run in list(_active_runs.items()):
        if str(run.get("status") or "").lower() not in {"running", "starting", "retrying", "aborting"}:
            continue
        upstream_meta = _active_upstream_runs.get(run_id) or {}
        upstream_run_id = str(upstream_meta.get("upstream_run_id") or run_id)
        try:
            await abort_upstream_run(upstream_run_id)
            stopped_any = True
        except SidecarError as exc:
            logger.warning("Compat sidecar abort failed for %s: %s", run_id, exc)
        run["status"] = "aborting"
        if run_id in _run_records:
            _run_records[run_id]["run_status"] = "ABORTING"
            _run_records[run_id]["status"] = "aborting"
    await _set_idle_pipeline_state(status="idle", action="Awaiting pipeline activation.")
    return {"success": True, "status": "stopped" if stopped_any else "idle", "stopped": stopped_any}


@router.get("/trading-agents/runs")
async def list_trading_agents_runs(limit: int = 20):
    rows = sorted(
        _run_records.values(),
        key=lambda row: row.get("created_at") or "",
        reverse=True,
    )
    return {"success": True, "runs": rows[: max(1, min(limit, 100))]}


@router.get("/trading-agents/runs/latest")
async def latest_trading_agents_run():
    if not _run_records:
        return {"success": False, "message": "No runs found."}
    latest = max(_run_records.values(), key=lambda row: row.get("created_at") or "")
    return latest


@router.get("/trading-agents/runs/{run_id}")
async def get_trading_agents_run(run_id: str):
    row = _run_records.get(run_id)
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    return row


@router.get("/pipeline_scenes")
async def get_pipeline_scenes():
    try:
        da = _get_data_access()
        return _as_dict(da.get_config("pipeline_scenes"))
    except Exception:
        return {}


@router.post("/pipeline_scenes")
async def save_pipeline_scenes(request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Config payload must be an object")

    da = _get_data_access()
    existing = _as_dict(da.get_config("pipeline_scenes"))
    merged = {**existing, **payload}
    da.set_config("pipeline_scenes", merged)

    ws_payload = {
        "type": "pipeline_scenes_updated",
        "config": merged,
        "timestamp": datetime.now().isoformat(),
    }
    try:
        from src.api.trading_floor_compat import broadcast_payload
        await broadcast_payload(ws_payload)
    except Exception:
        pass

    saved_patch = {key: merged.get(key) for key in payload.keys()}
    return {"success": True, "saved": saved_patch, "config": merged}


@router.get("/map")
async def get_room_map():
    try:
        da = _get_data_access()
        room_map = da.get_config("room_map")
        return room_map if room_map is not None else []
    except Exception:
        return []


@router.post("/map")
async def save_room_map(request: Request):
    payload = await request.json()
    if not isinstance(payload, dict) or "map" not in payload:
        raise HTTPException(status_code=400, detail="Map data is required")

    da = _get_data_access()
    da.set_config("room_map", payload["map"])

    ws_payload = {
        "type": "map_updated",
        "map": payload["map"],
        "timestamp": datetime.now().isoformat(),
    }
    try:
        from src.api.trading_floor_compat import broadcast_payload
        await broadcast_payload(ws_payload)
    except Exception:
        pass

    return {"success": True, "map": payload["map"]}


@router.post("/scene_command")
async def broadcast_scene_command(request: Request):
    command = await request.json()
    payload = {
        "type": "scene_command",
        "command": command,
        "timestamp": datetime.now().isoformat(),
    }
    try:
        from src.api.trading_floor_compat import broadcast_payload
        await broadcast_payload(payload)
    except Exception:
        pass
    return {"success": True, "command": command, "timestamp": payload["timestamp"]}
