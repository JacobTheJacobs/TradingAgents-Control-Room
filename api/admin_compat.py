"""
Compatibility admin router.

Provides the minimum `/api/admin/*` endpoints needed by the Scene Editor when
the full admin_routes module is unavailable.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import contextlib
import hashlib
import json
import logging
import os
import re
from pathlib import Path
from datetime import datetime
from datetime import timedelta
from typing import Any, Dict, List, Optional, Set
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
try:
    from cryptography.fernet import Fernet, InvalidToken
except Exception:  # pragma: no cover - optional dependency fallback
    Fernet = None  # type: ignore
    InvalidToken = Exception  # type: ignore
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


def _first_not_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _strict_parity_mode_enabled() -> bool:
    # Legacy compat toggle removed: admin-compat now always runs strict parity
    # so UI execution uses the same canonical TradingAgents path.
    return True


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
    "provider_api_key": "",
    "provider_base_url": "",
    "provider_api_keys": {},
    "provider_base_urls": {},
    "auto_scene_writer_enabled": False,
    "auto_scene_writer_provider": "",
    "auto_scene_writer_model": "",
}


def _resolve_ollama_root_url() -> str:
    raw = (
        os.getenv("OLLAMA_API_URL")
        or os.getenv("OLLAMA_HOST")
        or os.getenv("OLLAMA_BASE_URL")
        or "http://localhost:11434"
    )
    base = str(raw).strip().rstrip("/")
    if not base:
        return "http://localhost:11434"

    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    if path.endswith("/v1"):
        path = path[:-3]
    return urlunsplit((parts.scheme, parts.netloc, path or "", parts.query, parts.fragment)).rstrip("/")


def _ollama_tags_url() -> str:
    return f"{_resolve_ollama_root_url()}/api/tags"


def _is_ollama_embedding_model(model: Dict[str, Any]) -> bool:
    model_id = str(model.get("name") or model.get("model") or model.get("id") or "").strip().lower()
    details = model.get("details") if isinstance(model.get("details"), dict) else {}
    family = str(details.get("family") or "").lower()
    families = " ".join(str(item or "").lower() for item in details.get("families") or [])
    non_text_markers = ("embed", "embedding", "whisper", "speech", "audio")
    return (
        any(marker in model_id for marker in non_text_markers)
        or "embed" in family
        or "bert" in family
        or "embed" in families
        or "bert" in families
    )


async def _discover_ollama_models() -> List[Dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(_ollama_tags_url())
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        logger.warning("[TA-MODELS] Failed to discover Ollama models from %s: %s", _ollama_tags_url(), exc)
        return []

    rows: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for item in data.get("models") or []:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("name") or item.get("model") or "").strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        details = item.get("details") if isinstance(item.get("details"), dict) else {}
        label_parts = [model_id]
        parameter_size = str(details.get("parameter_size") or "").strip()
        quantization = str(details.get("quantization_level") or "").strip()
        if parameter_size:
            label_parts.append(parameter_size)
        if quantization and quantization.lower() != "unknown":
            label_parts.append(quantization)
        rows.append(
            {
                "id": model_id,
                "name": " - ".join(label_parts),
                "parameter_size": parameter_size or None,
                "quantization": quantization or None,
                "usable_for_reports": not _is_ollama_embedding_model(item),
                "usable_for_scene_writer": not _is_ollama_embedding_model(item),
            }
        )
    return rows


def _resolve_ollama_model_defaults(models: List[Dict[str, Any]]) -> Dict[str, str]:
    ids = [str(model.get("id") or "").strip() for model in models if str(model.get("id") or "").strip()]
    report_ids = [
        str(model.get("id") or "").strip()
        for model in models
        if str(model.get("id") or "").strip() and model.get("usable_for_reports") is not False
    ]
    first = report_ids[0] if report_ids else (ids[0] if ids else "")
    preset = _provider_defaults("ollama")
    quick = str(preset.get("default_quick_model") or "").strip()
    deep = str(preset.get("default_deep_model") or "").strip()
    if quick and quick not in ids:
        quick = first
    if deep and deep not in ids:
        deep = first
    return {"quick": quick or first, "deep": deep or first}
_TA_CONFIG_STORE_KEY = "tradingagents_config"
_ta_config_loaded = False
_TA_CONFIG_ENCRYPTION_ENV = "TA_CONFIG_ENCRYPTION_KEY"
_TA_SECRET_PREFIX = "enc:v1:"
_ta_cipher_cache_raw: Optional[str] = None
_ta_cipher_cache: Optional[Any] = None
_ta_cipher_error_logged = False
_ta_cipher_missing_logged = False

_active_runs: Dict[str, Dict[str, Any]] = {}
_active_run_tasks: Dict[str, asyncio.Task] = {}
_active_run_watchdogs: Dict[str, asyncio.Task] = {}
_run_records: Dict[str, Dict[str, Any]] = {}
_active_upstream_runs: Dict[str, Dict[str, Any]] = {}
_RUNNING_STATUSES = {"running", "starting", "retrying", "aborting"}
_RUNS_ARTIFACTS_DIR = Path(str(os.getenv("TRADINGAGENTS_RUNS_DIR") or "/shared/tradingagents-runs"))
_run_records_hydrated_once = False
_run_records_loaded_from_db_once = False


def _build_run_signature(
    *,
    ticker: str,
    trade_date: str,
    provider: str,
    quick_model: str,
    deep_model: str,
    depth: str,
    output_language: str,
    drama_level: str,
    auto_scene_writer_enabled: bool,
    auto_scene_writer_provider: str,
    auto_scene_writer_model: str,
) -> Dict[str, str]:
    return {
        "ticker": str(ticker or "").strip().upper(),
        "trade_date": str(trade_date or "").strip(),
        "provider": str(provider or "").strip().lower(),
        "quick_model": str(quick_model or "").strip(),
        "deep_model": str(deep_model or "").strip(),
        "depth": _normalize_depth(depth),
        "output_language": str(output_language or "English").strip() or "English",
        "drama_level": _normalize_drama_level(drama_level),
        "auto_scene_writer_enabled": "1" if _coerce_bool(auto_scene_writer_enabled, False) else "0",
        "auto_scene_writer_provider": str(auto_scene_writer_provider or "").strip().lower(),
        "auto_scene_writer_model": str(auto_scene_writer_model or "").strip(),
    }


def _run_record_signature(record: Dict[str, Any]) -> Dict[str, str]:
    raw_state = _as_dict(record.get("raw_state"))
    return _build_run_signature(
        ticker=str(record.get("ticker") or "").strip().upper(),
        trade_date=str(raw_state.get("trade_date") or "").strip(),
        provider=str(record.get("llm_provider") or "").strip().lower(),
        quick_model=str(record.get("quick_model") or "").strip(),
        deep_model=str(record.get("deep_model") or "").strip(),
        depth=str(record.get("research_depth") or "standard"),
        output_language=str(record.get("output_language") or "English"),
        drama_level=str(record.get("drama_level") or "medium"),
        auto_scene_writer_enabled=_coerce_bool(record.get("auto_scene_writer_enabled"), False),
        auto_scene_writer_provider=str(record.get("auto_scene_writer_provider") or ""),
        auto_scene_writer_model=str(record.get("auto_scene_writer_model") or ""),
    )


def _find_latest_completed_run_by_signature(signature: Dict[str, str]) -> Optional[Dict[str, Any]]:
    _load_run_records_from_db(limit=800)
    if not _run_records:
        _hydrate_run_records_from_artifacts(limit=800)
    matched: List[Dict[str, Any]] = []
    for row in _run_records.values():
        status = str(row.get("run_status") or row.get("status") or "").strip().upper()
        if status not in {"COMPLETED", "COMPLETE"}:
            continue
        if _run_record_signature(row) == signature:
            matched.append(row)
    if not matched:
        return None
    return max(matched, key=lambda row: str(row.get("completed_at") or row.get("created_at") or ""))

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
TRADINGAGENTS_STEP_TO_SCENE: Dict[str, str] = {
    "market_analyst": "STEP_1_ANALYSTS",
    "social_analyst": "STEP_1_ANALYSTS",
    "news_analyst": "STEP_1_ANALYSTS",
    "fundamentals_analyst": "STEP_1_ANALYSTS",
    "bull_researcher": "STEP_2_RESEARCH",
    "bear_researcher": "STEP_2_RESEARCH",
    "research_manager": "STEP_2_RESEARCH",
    "trader": "STEP_3_TRADER",
    "aggressive_analyst": "STEP_4_RISK",
    "conservative_analyst": "STEP_4_RISK",
    "neutral_analyst": "STEP_4_RISK",
    "risk_judge": "STEP_5_PORTFOLIO",
}

_TA_TIMELINE_SCENES: List[Dict[str, Any]] = [
    {"index": 0, "key": "TA_TIMELINE_00_INIT", "label": "00 INIT", "name": "INIT", "agent_id": None},
    {"index": 1, "key": "TA_TIMELINE_01_MARKET", "label": "01 Market Report", "name": "Market Report", "agent_id": "market_analyst"},
    {"index": 2, "key": "TA_TIMELINE_02_SENTIMENT", "label": "02 Sentiment Report", "name": "Sentiment Report", "agent_id": "social_analyst"},
    {"index": 3, "key": "TA_TIMELINE_03_NEWS", "label": "03 News Report", "name": "News Report", "agent_id": "news_analyst"},
    {"index": 4, "key": "TA_TIMELINE_04_FUNDAMENTALS", "label": "04 Fundamentals Report", "name": "Fundamentals Report", "agent_id": "fundamentals_analyst"},
    {"index": 5, "key": "TA_TIMELINE_05_BULL", "label": "05 Bull Researcher Report", "name": "Bull Researcher Report", "agent_id": "bull_researcher"},
    {"index": 6, "key": "TA_TIMELINE_06_BEAR", "label": "06 Bear Researcher Report", "name": "Bear Researcher Report", "agent_id": "bear_researcher"},
    {"index": 7, "key": "TA_TIMELINE_07_MANAGER", "label": "07 Research Manager Report", "name": "Research Manager Report", "agent_id": "research_manager"},
    {"index": 8, "key": "TA_TIMELINE_08_TRADER", "label": "08 Trader Plan Report", "name": "Trader Plan Report", "agent_id": "trader"},
    {"index": 9, "key": "TA_TIMELINE_09_AGGRESSIVE", "label": "09 Aggressive Analyst Report", "name": "Aggressive Analyst Report", "agent_id": "aggressive_analyst"},
    {"index": 10, "key": "TA_TIMELINE_10_CONSERVATIVE", "label": "10 Conservative Analyst Report", "name": "Conservative Analyst Report", "agent_id": "conservative_analyst"},
    {"index": 11, "key": "TA_TIMELINE_11_NEUTRAL", "label": "11 Neutral Analyst Report", "name": "Neutral Analyst Report", "agent_id": "neutral_analyst"},
    {"index": 12, "key": "TA_TIMELINE_12_PORTFOLIO", "label": "12 Portfolio Decision Report", "name": "Portfolio Decision Report", "agent_id": "risk_judge"},
]
_TA_TIMELINE_BY_INDEX = {row["index"]: row for row in _TA_TIMELINE_SCENES}
_TA_TIMELINE_BY_AGENT = {row["agent_id"]: row for row in _TA_TIMELINE_SCENES if row["agent_id"]}
_TA_AGENT_DEFAULT_ANIMATION = {
    "market_analyst": "sit_back",
    "social_analyst": "talk",
    "news_analyst": "sit_back",
    "fundamentals_analyst": "sit_back",
    "bull_researcher": "talk",
    "bear_researcher": "talk",
    "research_manager": "point",
    "trader": "talk",
    "aggressive_analyst": "talk",
    "conservative_analyst": "sit_back",
    "neutral_analyst": "idle",
    "risk_judge": "point",
}
_TA_ALLOWED_SCENE_ANIMATIONS = {
    "talk",
    "point",
    "argue",
    "sit_type",
    "sit_back",
    "idle",
    "buy",
    "sell",
    "cheer",
    "facepalm",
    "hodl",
    "rekt",
    "copium",
}
_TA_ALLOWED_SCENE_STATIONS = {
    "desk",
    "cooler",
    "table",
    "tv",
    "scanner",
    "center",
    "newsstand",
    "window",
    "ticker",
}
_TA_ALLOWED_SCENE_PATHS = {"direct", "detour", "loop", "idle"}
_TA_CANONICAL_AGENT_IDS = [str(agent.get("id") or "").strip() for agent in TRADINGAGENTS_CANONICAL_AGENTS if str(agent.get("id") or "").strip()]
_TA_CANONICAL_AGENT_NAMES_BY_ID = {
    str(agent.get("id") or "").strip(): str(agent.get("display_name") or "").strip()
    for agent in TRADINGAGENTS_CANONICAL_AGENTS
    if str(agent.get("id") or "").strip() and str(agent.get("display_name") or "").strip()
}
_TA_DRAMA_LEVELS = {"low", "medium", "high"}
_TA_STATION_CYCLE_BY_DRAMA: Dict[str, List[str]] = {
    "low": ["desk", "scanner", "tv", "newsstand", "table", "window"],
    "medium": ["desk", "scanner", "tv", "newsstand", "table", "cooler", "window", "center"],
    "high": ["center", "table", "cooler", "scanner", "tv", "window", "newsstand", "desk"],
}
_TA_FOCAL_STATION_BY_SCENE: Dict[int, str] = {
    0: "center",
    1: "scanner",
    2: "cooler",
    3: "newsstand",
    4: "desk",
    5: "table",
    6: "table",
    7: "center",
    8: "desk",
    9: "table",
    10: "table",
    11: "table",
    12: "center",
}

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


def _provider_defaults(provider: str) -> Dict[str, Any]:
    return TRADINGAGENTS_PROVIDER_MODEL_PRESETS.get(provider, TRADINGAGENTS_PROVIDER_MODEL_PRESETS["nvidia"])


_PROVIDER_API_KEY_ENV_ALIASES: Dict[str, List[str]] = {
    "openai": ["OPENAI_API_KEY"],
    "anthropic": ["ANTHROPIC_API_KEY"],
    "nvidia": ["NVIDIA_API_KEY", "NGC_API_KEY"],
    "google": ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    "xai": ["XAI_API_KEY"],
    "deepseek": ["DEEPSEEK_API_KEY"],
    "qwen": ["QWEN_API_KEY"],
    "glm": ["GLM_API_KEY"],
    "openrouter": ["OPENROUTER_API_KEY"],
    "azure": ["AZURE_OPENAI_API_KEY", "AZURE_API_KEY"],
    "ollama": [],
}

_PROVIDER_BASE_URL_ENV_ALIASES: Dict[str, List[str]] = {
    "openai": ["OPENAI_BASE_URL"],
    "anthropic": ["ANTHROPIC_BASE_URL"],
    "nvidia": ["NVIDIA_BASE_URL"],
    "google": ["GOOGLE_BASE_URL"],
    "xai": ["XAI_BASE_URL"],
    "deepseek": ["DEEPSEEK_BASE_URL"],
    "qwen": ["QWEN_BASE_URL"],
    "glm": ["GLM_BASE_URL"],
    "openrouter": ["OPENROUTER_BASE_URL"],
    "azure": ["AZURE_OPENAI_ENDPOINT", "AZURE_BASE_URL"],
    "ollama": ["OLLAMA_HOST"],
}


def _first_env_value(*names: str) -> str:
    for name in names:
        value = str(os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def _provider_env_credentials(provider: str) -> tuple[str, str]:
    provider_key = str(provider or "").strip().lower()
    api_key_names = _PROVIDER_API_KEY_ENV_ALIASES.get(provider_key, [])
    base_url_names = _PROVIDER_BASE_URL_ENV_ALIASES.get(provider_key, [])
    return _first_env_value(*api_key_names), _first_env_value(*base_url_names)


def _mask_secret(value: str) -> str:
    secret = str(value or "").strip()
    if not secret:
        return ""
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:4]}...{secret[-2:]}"


def _derive_fernet_key(raw: str) -> bytes:
    digest = hashlib.sha256(raw.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def _get_ta_secret_cipher() -> Optional[Any]:
    global _ta_cipher_cache_raw, _ta_cipher_cache, _ta_cipher_error_logged, _ta_cipher_missing_logged
    raw = str(os.getenv(_TA_CONFIG_ENCRYPTION_ENV) or "").strip()
    if not raw:
        if not _ta_cipher_missing_logged:
            logger.warning(
                "TA config secrets are stored as plaintext in DB. Set %s to encrypt provider API keys at rest.",
                _TA_CONFIG_ENCRYPTION_ENV,
            )
            _ta_cipher_missing_logged = True
        _ta_cipher_cache_raw = None
        _ta_cipher_cache = None
        return None
    if raw == _ta_cipher_cache_raw and _ta_cipher_cache is not None:
        return _ta_cipher_cache
    if Fernet is None:
        if not _ta_cipher_error_logged:
            logger.error(
                "cryptography package unavailable; cannot enable TA config encryption. Keys remain plaintext."
            )
            _ta_cipher_error_logged = True
        return None
    try:
        raw_bytes = raw.encode("utf-8")
        key_bytes = raw_bytes
        # Accept either a ready Fernet key or any passphrase-like string.
        if len(raw) != 44:
            key_bytes = _derive_fernet_key(raw)
        cipher = Fernet(key_bytes)
        _ta_cipher_cache_raw = raw
        _ta_cipher_cache = cipher
        return cipher
    except Exception as exc:
        if not _ta_cipher_error_logged:
            logger.error("Invalid %s value; cannot encrypt TA config keys: %s", _TA_CONFIG_ENCRYPTION_ENV, exc)
            _ta_cipher_error_logged = True
        _ta_cipher_cache_raw = None
        _ta_cipher_cache = None
        return None


def _is_encrypted_secret(value: Any) -> bool:
    return str(value or "").startswith(_TA_SECRET_PREFIX)


def _encrypt_secret(value: Any) -> str:
    secret = str(value or "").strip()
    if not secret:
        return ""
    if _is_encrypted_secret(secret):
        return secret
    cipher = _get_ta_secret_cipher()
    if cipher is None:
        return secret
    token = cipher.encrypt(secret.encode("utf-8")).decode("utf-8")
    return f"{_TA_SECRET_PREFIX}{token}"


def _decrypt_secret(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if not _is_encrypted_secret(raw):
        return raw
    cipher = _get_ta_secret_cipher()
    if cipher is None:
        return ""
    token = raw[len(_TA_SECRET_PREFIX):]
    try:
        return cipher.decrypt(token.encode("utf-8")).decode("utf-8").strip()
    except InvalidToken:
        logger.error("Failed to decrypt TA provider API key from DB (invalid token).")
        return ""
    except Exception as exc:
        logger.error("Failed to decrypt TA provider API key from DB: %s", exc)
        return ""


def _decrypt_secret_map(values: Any) -> Dict[str, str]:
    rows = _as_dict(values)
    decrypted: Dict[str, str] = {}
    for provider_id, raw_value in rows.items():
        provider_key = str(provider_id or "").strip().lower()
        if not provider_key:
            continue
        plain = _decrypt_secret(raw_value)
        if plain:
            decrypted[provider_key] = plain
    return decrypted


def _encrypt_secret_map(values: Any) -> Dict[str, str]:
    rows = _as_dict(values)
    encrypted: Dict[str, str] = {}
    for provider_id, raw_value in rows.items():
        provider_key = str(provider_id or "").strip().lower()
        secret = str(raw_value or "").strip()
        if not provider_key or not secret:
            continue
        encrypted[provider_key] = _encrypt_secret(secret)
    return encrypted


def _ta_config_store_payload() -> Dict[str, Any]:
    payload = dict(_ta_config)
    # Credentials are env-only. Never persist provider API keys in DB.
    payload["provider_api_key"] = ""
    payload["provider_api_keys"] = {}
    return payload


def _load_ta_config_from_store() -> None:
    global _ta_config_loaded
    if _ta_config_loaded:
        return
    _ta_config_loaded = True
    try:
        da = _get_data_access()
        stored = _as_dict(da.get_config(_TA_CONFIG_STORE_KEY))
    except Exception:
        return
    if not stored:
        return
    for key in (
        "llm_provider",
        "quick_model",
        "deep_model",
        "output_language",
        "drama_level",
        "scene_dialogue_preset",
        "provider_base_url",
        "provider_base_urls",
        "auto_scene_writer_enabled",
        "auto_scene_writer_provider",
        "auto_scene_writer_model",
    ):
        if key in stored:
            _ta_config[key] = stored.get(key)
    # Credentials are env-only. Keep in-memory/store key fields empty.
    _ta_config["provider_api_key"] = ""
    _ta_config["provider_api_keys"] = {}
    provider = str(_ta_config.get("llm_provider") or "nvidia").strip().lower()
    provider_base_urls = _as_dict(_ta_config.get("provider_base_urls"))
    _ta_config["provider_base_urls"] = provider_base_urls
    _ta_config["auto_scene_writer_enabled"] = _coerce_bool(_ta_config.get("auto_scene_writer_enabled"), False)
    loaded_auto_scene_writer_provider = str(_ta_config.get("auto_scene_writer_provider") or "").strip().lower()
    _ta_config["auto_scene_writer_provider"] = (
        loaded_auto_scene_writer_provider
        if loaded_auto_scene_writer_provider in TRADINGAGENTS_PROVIDER_MODEL_PRESETS
        else ""
    )
    _ta_config["auto_scene_writer_model"] = str(_ta_config.get("auto_scene_writer_model") or "").strip()
    _persist_ta_config_to_store()


def _persist_ta_config_to_store() -> None:
    try:
        da = _get_data_access()
        da.set_config(_TA_CONFIG_STORE_KEY, _ta_config_store_payload())
    except Exception:
        return


def _public_ta_config() -> Dict[str, Any]:
    config = dict(_ta_config)
    provider_api_key = str(config.pop("provider_api_key", "") or "").strip()
    provider_api_keys = _as_dict(config.pop("provider_api_keys", {}))
    provider_base_urls = _as_dict(config.pop("provider_base_urls", {}))
    masked_map: Dict[str, str] = {}
    configured_map: Dict[str, bool] = {}
    for provider_id, raw_value in provider_api_keys.items():
        provider_key = str(provider_id or "").strip().lower()
        if not provider_key:
            continue
        secret = str(raw_value or "").strip()
        configured_map[provider_key] = bool(secret)
        masked_map[provider_key] = _mask_secret(secret)
    config["provider_api_keys_configured"] = configured_map
    config["provider_api_keys_masked"] = masked_map
    config["provider_base_urls"] = {
        str(provider_id or "").strip().lower(): str(url or "").strip()
        for provider_id, url in provider_base_urls.items()
        if str(provider_id or "").strip()
    }
    config["provider_api_key_configured"] = bool(provider_api_key)
    config["provider_api_key_masked"] = _mask_secret(provider_api_key)
    config["auto_scene_writer_enabled"] = _coerce_bool(config.get("auto_scene_writer_enabled"), False)
    config["auto_scene_writer_provider"] = str(config.get("auto_scene_writer_provider") or "").strip().lower() or None
    config["auto_scene_writer_model"] = str(config.get("auto_scene_writer_model") or "").strip() or None
    config["provider_api_key_storage"] = "encrypted" if _get_ta_secret_cipher() else "plaintext"
    if not _get_ta_secret_cipher():
        config["provider_api_key_storage_warning"] = (
            f"Set {_TA_CONFIG_ENCRYPTION_ENV} to encrypt provider API keys at rest in DB."
        )
    return config


def _normalize_provider_and_models_for_compat_run(
    provider: str,
    quick_model: str,
    deep_model: str,
) -> tuple[str, str, str, Optional[str]]:
    normalized_provider = str(provider or "nvidia").strip().lower()
    normalized_quick = str(quick_model or "").strip()
    normalized_deep = str(deep_model or "").strip() or normalized_quick
    notice: Optional[str] = None

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


async def _emit_scene_runtime_warning(
    run_id: str,
    *,
    scene_index: Optional[int],
    message: str,
    source_agent: Optional[str] = None,
) -> None:
    warning_text = str(message or "").strip() or "Scene generation warning."
    scene_label = _timeline_scene_label_for_index(scene_index) if isinstance(scene_index, int) and scene_index >= 0 else "unknown scene"
    merged = f"Scene warning ({scene_label}): {warning_text}"
    timestamp = _now_iso()
    await _broadcast({
        "type": "streamed_news",
        "run_id": run_id,
        "active_run_id": run_id,
        "data": {
            "title": "Scene Generation Warning",
            "message": merged,
            "level": "warning",
            "source_agent": source_agent or "system",
            "timestamp": timestamp,
        },
        "timestamp": timestamp,
    })
    await _broadcast({
        "type": "MARQUEE_UPDATE",
        "run_id": run_id,
        "active_run_id": run_id,
        "data": {"text": merged},
        "timestamp": timestamp,
    })


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


def _iso_from_run_id(run_id: str) -> Optional[str]:
    match = re.search(r"-(\d{8}T\d{12})-", str(run_id or ""))
    if not match:
        return None
    raw = match.group(1)
    try:
        return datetime.strptime(raw, "%Y%m%dT%H%M%S%f").isoformat()
    except Exception:
        return None


def _ticker_from_run_id(run_id: str) -> str:
    parts = str(run_id or "").split("-")
    if len(parts) >= 2 and parts[1]:
        return parts[1].upper()
    return "NVDA"


def _hydrate_run_records_from_artifacts(*, limit: int = 200, force: bool = False) -> None:
    global _run_records_hydrated_once
    if _run_records_hydrated_once and not force:
        return
    if not _RUNS_ARTIFACTS_DIR.exists():
        _run_records_hydrated_once = True
        return

    run_dirs = [
        path for path in _RUNS_ARTIFACTS_DIR.iterdir()
        if path.is_dir() and path.name.startswith("ta-")
    ]
    run_dirs.sort(key=lambda path: path.stat().st_mtime, reverse=True)

    for run_dir in run_dirs[: max(1, min(limit, 1000))]:
        run_id = run_dir.name
        if run_id in _run_records:
            continue

        final_state = _read_json_file(run_dir / "final_state.json")
        full_agent_reports = _read_json_file(run_dir / "full_agent_reports.json")
        complete_report = _read_text_file(run_dir / "complete_report.md")
        if not final_state and not full_agent_reports and not complete_report:
            continue

        created_at = (
            _iso_from_run_id(run_id)
            or _normalize_report_text(final_state.get("generated_at"))
            or datetime.fromtimestamp(run_dir.stat().st_mtime).isoformat()
        )
        completed_at = _normalize_report_text(final_state.get("generated_at")) or created_at
        ticker = (
            _normalize_report_text(final_state.get("company_of_interest"))
            or _normalize_report_text(final_state.get("ticker"))
            or _ticker_from_run_id(run_id)
        ).upper()
        trade_date = (
            _normalize_report_text(final_state.get("trade_date"))
            or (created_at[:10] if len(created_at) >= 10 else datetime.now().strftime("%Y-%m-%d"))
        )

        canonical_reports = _canonical_reports_from_payload(full_agent_reports, final_state, complete_report)
        if not complete_report:
            complete_report = _normalize_report_text(
                final_state.get("final_trade_decision")
                or final_state.get("final_decision")
                or final_state.get("risk_judge")
            )
        decision = _extract_decision(
            final_state.get("recommended_action")
            or final_state.get("final_decision")
            or final_state.get("final_trade_decision")
            or complete_report
        )

        depth = _normalize_depth(final_state.get("research_depth"))
        quick_model = _normalize_report_text(final_state.get("quick_model"))
        deep_model = _normalize_report_text(final_state.get("deep_model"))
        llm_provider = _normalize_report_text(final_state.get("llm_provider"))

        telemetry = {
            "attempt": _safe_int(final_state.get("attempt"), 1),
            "max_attempts": _safe_int(final_state.get("max_attempts"), 1),
            "llm_calls": _safe_int(final_state.get("llm_calls"), 0),
            "tool_calls": _safe_int(final_state.get("tool_calls"), 0),
            "tokens_in": _safe_int(final_state.get("tokens_in"), 0),
            "tokens_out": _safe_int(final_state.get("tokens_out"), 0),
        }

        artifacts = {
            "save_path": str(run_dir),
            "final_state_path": str(run_dir / "final_state.json"),
            "full_agent_reports_path": str(run_dir / "full_agent_reports.json"),
            "complete_report_path": str(run_dir / "complete_report.md"),
        }

        _run_records[run_id] = {
            "run_id": run_id,
            "ticker": ticker,
            "run_status": "COMPLETED",
            "status": "complete",
            "created_at": created_at,
            "completed_at": completed_at,
            "research_depth": depth,
            "quick_model": quick_model,
            "deep_model": deep_model,
            "llm_provider": llm_provider,
            "output_language": _normalize_report_text(final_state.get("output_language")) or "English",
            "drama_level": _normalize_drama_level(final_state.get("drama_level")),
            "auto_scene_writer_enabled": _coerce_bool(final_state.get("auto_scene_writer_enabled"), False),
            "auto_scene_writer_provider": _normalize_report_text(final_state.get("auto_scene_writer_provider")).lower(),
            "auto_scene_writer_model": _normalize_report_text(final_state.get("auto_scene_writer_model")),
            "agent_reports": _build_agent_reports(canonical_reports),
            "attempt": telemetry["attempt"],
            "max_attempts": telemetry["max_attempts"],
            "llm_calls": telemetry["llm_calls"],
            "tool_calls": telemetry["tool_calls"],
            "tokens_in": telemetry["tokens_in"],
            "tokens_out": telemetry["tokens_out"],
            "scene_history": [],
            "scene_count": 0,
            "latest_scene_index": None,
            "latest_scene_label": None,
            "latest_scene_kind": None,
            "latest_scene_attempt": None,
            "recommended_action": decision,
            "model_action": decision,
            "prediction": _normalize_report_text(final_state.get("final_trade_decision") or final_state.get("final_decision") or decision),
            "reasoning": complete_report[:4000],
            "report_excerpt": _excerpt(complete_report, 800),
            "complete_report": complete_report,
            "raw_state": _build_raw_state(
                final_state,
                canonical_reports,
                complete_report=complete_report,
                decision=decision,
                trade_date=trade_date,
                depth=depth,
                quick_model=quick_model,
                deep_model=deep_model,
                llm_provider=llm_provider,
                artifacts=artifacts,
                telemetry=telemetry,
                attempts=[],
            ),
        }

    _run_records_hydrated_once = True


def _persist_run_record_to_db(run_id: str, record: Dict[str, Any]) -> None:
    if not run_id or not isinstance(record, dict):
        return
    try:
        da = _get_data_access()
        da.upsert_tradingagents_run(run_id, record)
    except Exception:
        logger.exception("Failed persisting TradingAgents run %s to DB", run_id)


def _overlay_live_pipeline_telemetry(run_id: str, row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row or {})
    row_status = str(out.get("status") or "").strip().lower()
    # Terminal records must reflect finalized run artifacts only.
    if row_status in {"complete", "completed", "failed", "aborted", "canceled", "cancelled"}:
        return out
    try:
        from src.api.trading_floor_compat import pipeline_state

        active_run_id = str(pipeline_state.get("active_run_id") or "").strip()
        live_status = str(pipeline_state.get("status") or "").strip().lower()
        if run_id and active_run_id == run_id and live_status in {"running", "retrying"}:
            out["status"] = live_status
            out["run_status"] = "RUNNING" if live_status == "running" else "RETRYING"
            for key in ("llm_calls", "tool_calls", "tokens_in", "tokens_out", "attempt", "max_attempts"):
                if key in pipeline_state:
                    out[key] = _safe_int(pipeline_state.get(key), out.get(key, 0))
    except Exception:
        pass
    return out


def _load_run_records_from_db(*, limit: int = 200, force: bool = False) -> None:
    global _run_records_loaded_from_db_once
    if _run_records_loaded_from_db_once and not force:
        return
    try:
        da = _get_data_access()
        rows = da.get_tradingagents_runs(limit=max(1, min(limit, 1000)))
    except Exception:
        logger.exception("Failed loading TradingAgents runs from DB")
        rows = []

    for row in rows:
        payload = _as_dict(row)
        run_id = str(payload.get("run_id") or "").strip()
        if not run_id:
            continue
        _run_records[run_id] = payload

    _run_records_loaded_from_db_once = True


def _load_run_record_from_db(run_id: str) -> Optional[Dict[str, Any]]:
    run_id = str(run_id or "").strip()
    if not run_id:
        return None
    try:
        da = _get_data_access()
        row = da.get_tradingagents_run(run_id)
    except Exception:
        logger.exception("Failed loading TradingAgents run %s from DB", run_id)
        return None
    payload = _as_dict(row)
    if not payload:
        return None
    payload["run_id"] = run_id
    _run_records[run_id] = payload
    return payload


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
    if _strict_parity_mode_enabled():
        # In strict 1:1 mode, do not enforce admin-side age aborts.
        # Canonical TradingAgents runtime controls completion/failure.
        strict_timeout_seconds = 10**9
    else:
        strict_timeout_seconds = _safe_int(os.getenv("UPSTREAM_STRICT_TIMEOUT_SECONDS_QUICK"), 1800)
        strict_timeout_seconds = max(120, strict_timeout_seconds)
    now_utc = datetime.utcnow()

    async def _force_timeout_if_overdue(run_id: str, row: Dict[str, Any]) -> None:
        created_raw = str(row.get("created_at") or "").strip()
        if not created_raw:
            return
        try:
            created_dt = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
            if created_dt.tzinfo is not None:
                created_dt = created_dt.astimezone(tz=None).replace(tzinfo=None)
        except Exception:
            return
        elapsed = (now_utc - created_dt).total_seconds()
        if elapsed < strict_timeout_seconds:
            return
        upstream_run_id = str((_as_dict(row.get("raw_state")).get("upstream_run_id") or run_id)).strip()
        with contextlib.suppress(Exception):
            await abort_upstream_run(upstream_run_id)
        row["run_status"] = "FAILED"
        row["status"] = "failed"
        row["completed_at"] = row.get("completed_at") or _now_iso()
        row["error_code"] = row.get("error_code") or "UPSTREAM_TIMEOUT"
        row["error_message"] = row.get("error_message") or f"Strict run exceeded timeout ({strict_timeout_seconds}s)."
        row["reasoning"] = row.get("reasoning") or row["error_message"]
        row["report_excerpt"] = _excerpt(row["error_message"], 300)
        _run_records[run_id] = row
        _persist_run_record_to_db(run_id, row)

    try:
        health = await get_upstream_health()
    except SidecarError:
        return
    active_run_id = str((health or {}).get("active_run_id") or "").strip()
    active_status = str((health or {}).get("active_status") or "").strip().lower()
    if active_run_id and active_status == "running":
        # Even with active worker, fail fast if strict runtime exceeds SLA.
        row = _run_records.get(active_run_id)
        if isinstance(row, dict):
            await _force_timeout_if_overdue(active_run_id, row)
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
    # If sidecar has no active run, any persisted RUNNING rows are stale.
    # Mark them failed so UI never shows "running forever" after orphaned workers.
    if not active_run_id:
        now_iso = _now_iso()
        for run_id, row in list(_run_records.items()):
            status = str(row.get("status") or "").strip().lower()
            run_status = str(row.get("run_status") or "").strip().upper()
            if status in _RUNNING_STATUSES or run_status in {"RUNNING", "STARTING", "RETRYING", "ABORTING"}:
                # Confirm this run is also missing from sidecar runtime. If yes, fail fast.
                sidecar_missing = False
                try:
                    upstream_run_id = str((_as_dict(row.get("raw_state")).get("upstream_run_id") or run_id)).strip()
                    await get_upstream_run(upstream_run_id)
                except SidecarError:
                    sidecar_missing = True
                except Exception:
                    sidecar_missing = False

                if sidecar_missing:
                    age_seconds = _run_age_seconds(row)
                    if age_seconds is not None and age_seconds < 90:
                        continue
                    row["run_status"] = "FAILED"
                    row["status"] = "failed"
                    row["completed_at"] = row.get("completed_at") or now_iso
                    row["error_code"] = row.get("error_code") or "UPSTREAM_ORPHANED"
                    row["error_message"] = row.get("error_message") or "Upstream worker is not active for this run."
                    row["reasoning"] = row.get("reasoning") or row["error_message"]
                    row["report_excerpt"] = _excerpt(row["error_message"], 300)
                    _persist_run_record_to_db(run_id, row)


async def _force_abort_active_tradingagents_runs(reason: str = "preempted by new run") -> List[str]:
    await _reconcile_local_active_runs_from_sidecar_health()
    stopped_run_ids: List[str] = []

    for run_id, run in list(_active_runs.items()):
        if str(run.get("status") or "").lower() not in _RUNNING_STATUSES:
            continue

        upstream_meta = _active_upstream_runs.get(run_id) or {}
        upstream_run_id = str(upstream_meta.get("upstream_run_id") or run_id)
        task = _active_run_tasks.get(run_id)
        if task and not task.done():
            task.cancel()
        sidecar_run: Dict[str, Any] = {}
        try:
            await abort_upstream_run(upstream_run_id)
            with contextlib.suppress(Exception):
                sidecar_run = await get_upstream_run(upstream_run_id)
        except SidecarError as exc:
            logger.warning("Compat forced abort failed for %s: %s", run_id, exc)

        record = _run_records.get(run_id)
        if record:
            if sidecar_run:
                _materialize_failed_run(
                    run_id,
                    record,
                    sidecar_run=sidecar_run,
                    failure_event={
                        "type": "run_aborted",
                        "error_code": "RUN_PREEMPTED",
                        "error": reason,
                        "error_message": reason,
                    },
                )
            else:
                record["run_status"] = "ABORTED"
                record["status"] = "aborted"
                record["completed_at"] = _now_iso()
                record["error_code"] = "RUN_PREEMPTED"
                record["error_message"] = reason
                record["reasoning"] = reason
                record["report_excerpt"] = _excerpt(reason, 300)
            _persist_run_record_to_db(run_id, record)

        stopped_run_ids.append(run_id)
        _active_runs.pop(run_id, None)
        _active_upstream_runs.pop(run_id, None)
        _active_run_tasks.pop(run_id, None)

    return stopped_run_ids


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


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "enabled"}:
            return True
        if normalized in {"0", "false", "no", "off", "disabled"}:
            return False
    return bool(default)


def _normalize_depth(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"quick", "shallow", "1"}:
        return "quick"
    if raw in {"deep", "5"}:
        return "deep"
    if raw in {"standard", "normal", "medium", "3"}:
        return "standard"
    return "standard"


def _normalize_trade_date(value: Any, *, clamp_to_last_completed_day: bool = True) -> str:
    raw = str(value or "").strip()
    try:
        parsed = datetime.strptime(raw, "%Y-%m-%d").date()
    except Exception:
        parsed = datetime.now().date()
    today = datetime.now().date()
    # Original pipeline is most stable on completed market days.
    if clamp_to_last_completed_day and parsed >= today:
        parsed = today - timedelta(days=1)
    return parsed.strftime("%Y-%m-%d")


def _normalize_drama_level(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"low", "1", "calm", "minimal"}:
        return "low"
    if raw in {"high", "3", "intense", "max"}:
        return "high"
    if raw in {"medium", "2", "normal", "standard"}:
        return "medium"
    return "medium"


def _scene_drama_level_for_record(record: Dict[str, Any]) -> str:
    if isinstance(record, dict):
        direct = record.get("drama_level")
        if direct is not None:
            return _normalize_drama_level(direct)
        raw_state = _as_dict(record.get("raw_state"))
        if raw_state.get("drama_level") is not None:
            return _normalize_drama_level(raw_state.get("drama_level"))
    return _normalize_drama_level(_ta_config.get("drama_level"))


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


def _normalize_scene_dialogue_line(value: Any, *, max_words: int = 8, fallback: str = "No update.") -> str:
    text = _normalize_report_text(value)
    words = [part for part in text.split() if part]
    if words:
        return " ".join(words[: max(1, max_words)])
    fallback_words = [part for part in str(fallback or "").split() if part]
    if fallback_words:
        return " ".join(fallback_words[: max(1, max_words)])
    return "Update pending."


def _excerpt(text: Any, limit: int = 280) -> str:
    cleaned = _normalize_report_text(text)
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(1, limit - 3)].rstrip() + "..."


def _timeline_scene_for_index(scene_index: int) -> Optional[Dict[str, Any]]:
    return _TA_TIMELINE_BY_INDEX.get(scene_index)


def _timeline_scene_for_agent(agent_id: str) -> Optional[Dict[str, Any]]:
    return _TA_TIMELINE_BY_AGENT.get(agent_id)


def _timeline_scene_index_for_agent(agent_id: str) -> Optional[int]:
    row = _timeline_scene_for_agent(agent_id)
    return int(row["index"]) if row else None


def _timeline_scene_label_for_index(scene_index: int) -> str:
    row = _timeline_scene_for_index(scene_index)
    if row:
        return str(row.get("label") or f"{scene_index:02d} SCENE")
    return f"{scene_index:02d} SCENE"


def _timeline_scene_key_for_index(scene_index: int) -> str:
    row = _timeline_scene_for_index(scene_index)
    if row:
        return str(row.get("key") or "")
    return ""


def _timeline_scene_agent_for_index(scene_index: int) -> Optional[str]:
    row = _timeline_scene_for_index(scene_index)
    if not row:
        return None
    return row.get("agent_id")


def _timeline_scene_kind_for_index(scene_index: int) -> str:
    return "init" if int(scene_index) == 0 else "report_completed"


def _build_writer_meta(record: Dict[str, Any], scene_index: int) -> Dict[str, Any]:
    writer_model = str(record.get("deep_model") or record.get("quick_model") or "")
    scene_label = _timeline_scene_label_for_index(scene_index)
    scene_key = _timeline_scene_key_for_index(scene_index)
    return {
        "scene_key": scene_key,
        "scene_label": scene_label,
        "source_report_slot": scene_index,
        "writer_source": "deterministic",
        "validation_passed": True,
        "writer_model": writer_model,
        "writer_latency_ms": None,
    }


_TA_DETERMINISTIC_DIALOGUE_BASE: Dict[str, str] = {
    "market_analyst": "Price trend remains in focus.",
    "social_analyst": "Social sentiment is still shifting.",
    "news_analyst": "Catalyst scan remains active.",
    "fundamentals_analyst": "Valuation checks are still running.",
    "bull_researcher": "Upside case remains intact.",
    "bear_researcher": "Downside risks remain active.",
    "research_manager": "Synthesis is underway across teams.",
    "trader": "Execution plan is under review.",
    "aggressive_analyst": "Seeking momentum entry points.",
    "conservative_analyst": "Risk controls stay strict.",
    "neutral_analyst": "Balanced stance until confirmation.",
    "risk_judge": "Position sizing remains under review.",
}

_TA_DETERMINISTIC_DIALOGUE_INIT: Dict[str, str] = {
    "market_analyst": "Charts loaded, trend checks starting.",
    "social_analyst": "Feeds connected, sentiment scan ready.",
    "news_analyst": "Newswire synced, catalysts queued.",
    "fundamentals_analyst": "Financials loaded, baseline set.",
    "bull_researcher": "Bull lens active, upside watchlist ready.",
    "bear_researcher": "Bear lens active, downside watchlist ready.",
    "research_manager": "Research lanes set, handoffs aligned.",
    "trader": "Order framework loaded, timing rules set.",
    "aggressive_analyst": "High-beta triggers armed and monitored.",
    "conservative_analyst": "Capital protection guardrails are active.",
    "neutral_analyst": "Neutral baseline established for arbitration.",
    "risk_judge": "Risk court open, criteria locked.",
}

_TA_DETERMINISTIC_SCENE_FOCAL_LINES: Dict[int, str] = {
    1: "Market structure mapped, handing off signal.",
    2: "Sentiment pulse logged, crowd read passed.",
    3: "Headlines triaged, catalysts forwarded to team.",
    4: "Fundamentals checked, valuation notes now ready.",
    5: "Bull thesis framed, upside triggers identified.",
    6: "Bear thesis framed, downside triggers identified.",
    7: "Research merged, conviction level now set.",
    8: "Trade plan drafted, entries and exits set.",
    9: "Aggressive sizing case prepared for debate.",
    10: "Conservative guardrails set, downside protected first.",
    11: "Neutral balance set, awaiting final arbitration.",
    12: "Final risk ruling issued, proceed disciplined.",
}


def _build_deterministic_dialogue_map(scene_index: int, active_agent_id: Optional[str]) -> Dict[str, str]:
    if int(scene_index) == 0:
        lines = dict(_TA_DETERMINISTIC_DIALOGUE_INIT)
    else:
        lines = dict(_TA_DETERMINISTIC_DIALOGUE_BASE)
        focal_line = _TA_DETERMINISTIC_SCENE_FOCAL_LINES.get(int(scene_index))
        if focal_line and active_agent_id and active_agent_id in lines:
            lines[active_agent_id] = focal_line

    for agent_id_key in _TA_CANONICAL_AGENT_IDS:
        if agent_id_key not in lines:
            display_name = _TA_CANONICAL_AGENT_NAMES_BY_ID.get(agent_id_key, agent_id_key)
            lines[agent_id_key] = f"{display_name} update pending."
    return lines


def _build_scene_agents() -> List[str]:
    return [str(agent.get("display_name") or "") for agent in TRADINGAGENTS_CANONICAL_AGENTS if str(agent.get("display_name") or "")]


def _active_animation_for_scene(scene_index: int, drama_level: str) -> str:
    if scene_index <= 0:
        return "talk" if drama_level != "low" else "sit_back"
    if drama_level == "high":
        return {
            1: "sit_back",
            2: "talk",
            3: "point",
            4: "sit_back",
            5: "cheer",
            6: "argue",
            7: "point",
            8: "buy",
            9: "cheer",
            10: "facepalm",
            11: "hodl",
            12: "point",
        }.get(scene_index, "talk")
    if drama_level == "low":
        return "sit_back" if scene_index <= 4 else "talk"
    return "talk"


def _build_scene_station_targets(
    active_agent_id: Optional[str],
    *,
    scene_index: int = 0,
    drama_level: str = "medium",
) -> List[Dict[str, Any]]:
    targets: List[Dict[str, Any]] = []
    normalized_drama = _normalize_drama_level(drama_level)
    cycle = _TA_STATION_CYCLE_BY_DRAMA.get(normalized_drama) or _TA_STATION_CYCLE_BY_DRAMA["medium"]
    focal_station = _TA_FOCAL_STATION_BY_SCENE.get(int(scene_index), "center")
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_id = str(agent.get("id") or "").strip()
        name = str(agent.get("display_name") or "").strip()
        if not name:
            continue
        station = str(agent.get("station") or "desk").strip().lower() or "desk"
        if active_agent_id and agent_id == active_agent_id:
            station = focal_station
        else:
            canonical_index = _TA_CANONICAL_AGENT_IDS.index(agent_id) if agent_id in _TA_CANONICAL_AGENT_IDS else 0
            station = cycle[(canonical_index + max(0, int(scene_index))) % len(cycle)]
        targets.append({"agent": name, "station": station if station in _TA_ALLOWED_SCENE_STATIONS else "desk"})
    if active_agent_id:
        active_name = normalize_tradingagents_agent_name(active_agent_id) or active_agent_id
        active_station = focal_station if focal_station in _TA_ALLOWED_SCENE_STATIONS else "desk"
        for row in targets:
            if row["agent"] == active_name:
                row["station"] = active_station
                break
    return targets


def _build_scene_animations(
    active_agent_id: Optional[str],
    *,
    scene_index: int = 0,
    drama_level: str = "medium",
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    normalized_drama = _normalize_drama_level(drama_level)
    scene_anim_seed = max(0, int(scene_index))
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_id = str(agent.get("id") or "").strip()
        name = str(agent.get("display_name") or "").strip()
        if not agent_id or not name:
            continue
        animation = _TA_AGENT_DEFAULT_ANIMATION.get(agent_id, "idle")
        if active_agent_id and agent_id == active_agent_id:
            animation = _active_animation_for_scene(scene_anim_seed, normalized_drama)
        elif normalized_drama == "high":
            idx = _TA_CANONICAL_AGENT_IDS.index(agent_id) if agent_id in _TA_CANONICAL_AGENT_IDS else 0
            swing = (scene_anim_seed + idx) % 5
            if swing == 0:
                animation = "talk"
            elif swing == 1:
                animation = "sit_back"
            elif swing == 2:
                animation = "point"
            elif swing == 3:
                animation = "argue"
            else:
                animation = _TA_AGENT_DEFAULT_ANIMATION.get(agent_id, "idle")
        elif normalized_drama == "low" and animation in {"argue", "buy", "sell", "cheer", "facepalm", "rekt", "copium"}:
            animation = "talk" if agent_id in {"social_analyst", "bull_researcher", "bear_researcher", "trader"} else "idle"
        rows.append({"agent": name, "animation": animation})
    return rows


def _build_scene_paths(
    active_agent_id: Optional[str],
    *,
    scene_index: int = 0,
    drama_level: str = "medium",
) -> Dict[str, str]:
    rows: Dict[str, str] = {}
    normalized_drama = _normalize_drama_level(drama_level)
    active_name = normalize_tradingagents_agent_name(active_agent_id) if active_agent_id else None
    scene_seed = max(0, int(scene_index))
    for idx, agent in enumerate(TRADINGAGENTS_CANONICAL_AGENTS):
        name = str(agent.get("display_name") or "").strip()
        if not name:
            continue
        if active_name and name == active_name:
            rows[name] = "loop" if normalized_drama == "high" else "direct"
            continue
        if normalized_drama == "low":
            rows[name] = "detour" if (scene_seed + idx) % 4 == 0 else "direct"
        elif normalized_drama == "high":
            rows[name] = "loop" if (scene_seed + idx) % 3 == 0 else "detour"
        else:
            rows[name] = "detour" if (scene_seed + idx) % 2 == 0 else "direct"
    return rows


def _build_scene_movement_plan(
    active_agent_id: Optional[str],
    *,
    scene_index: int = 0,
    drama_level: str = "medium",
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    station_map = {
        row.get("agent"): row.get("station")
        for row in _build_scene_station_targets(
            active_agent_id,
            scene_index=scene_index,
            drama_level=drama_level,
        )
    }
    path_map = _build_scene_paths(
        active_agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    active_name = normalize_tradingagents_agent_name(active_agent_id) if active_agent_id else None
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        name = str(agent.get("display_name") or "").strip()
        station = str(station_map.get(name) or agent.get("station") or "desk").strip().lower() or "desk"
        if not name:
            continue
        mode = str(path_map.get(name) or ("direct" if active_name and name == active_name else "direct")).strip().lower()
        rows.append(
            {
                "agent": name,
                "from": station,
                "to": station,
                "mode": mode,
                "path": mode,
            }
        )
    return rows


def _normalize_scene_enum(value: Any, allowed: set[str], fallback: str, field_name: str, agent_id: str) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in allowed:
        return normalized
    fallback_value = str(fallback or "").strip().lower().replace("-", "_").replace(" ", "_")
    if fallback_value in allowed:
        return fallback_value
    raise RuntimeError(
        f"SCENE_DIALOGUE_FAILED: invalid {field_name}='{value}' for {agent_id}; allowed={sorted(allowed)}"
    )


def _scene_history_entry_for_index(record: Dict[str, Any], scene_index: int, attempt: int) -> Optional[Dict[str, Any]]:
    for row in list(record.get("scene_history") or []):
        if _coerce_scene_index(row.get("scene_index"), -1) != int(scene_index):
            continue
        row_attempt = _safe_int(row.get("attempt"), attempt)
        if row_attempt == int(attempt):
            return row
    return None


def _scene_writer_enabled_for_record(record: Dict[str, Any]) -> bool:
    value = record.get("auto_scene_writer_enabled")
    if value is None:
        value = _ta_config.get("auto_scene_writer_enabled", False)
    return _coerce_bool(value, False)


def _scene_writer_provider_for_record(record: Dict[str, Any]) -> str:
    override_provider = str(record.get("auto_scene_writer_provider") or "").strip().lower()
    if override_provider and override_provider in TRADINGAGENTS_PROVIDER_MODEL_PRESETS:
        return override_provider
    return str(record.get("llm_provider") or _ta_config.get("llm_provider") or "nvidia").strip().lower()


def _scene_writer_model_for_record(record: Dict[str, Any], *, provider: Optional[str] = None) -> str:
    override_model = str(record.get("auto_scene_writer_model") or "").strip()
    if override_model:
        return override_model
    selected_provider = str(provider or record.get("llm_provider") or "nvidia").strip().lower()
    defaults = _provider_defaults(selected_provider)
    run_provider = str(record.get("llm_provider") or "").strip().lower()
    if selected_provider and run_provider and selected_provider != run_provider:
        return str(defaults.get("default_deep_model") or defaults.get("default_quick_model") or record.get("deep_model") or record.get("quick_model") or "").strip()
    return str(record.get("deep_model") or record.get("quick_model") or "")


def _scene_writer_provider_credentials(run_id: str, provider: str) -> tuple[str, str]:
    provider_key = str(provider or "").strip().lower()
    env_key, env_base = _provider_env_credentials(provider_key)
    return env_key, env_base


def _build_scene_writer_system_prompt() -> str:
    allowed_animations = ", ".join(sorted(_TA_ALLOWED_SCENE_ANIMATIONS))
    allowed_stations = ", ".join(sorted(_TA_ALLOWED_SCENE_STATIONS))
    allowed_paths = ", ".join(sorted(_TA_ALLOWED_SCENE_PATHS))
    return (
        "You are a strict TradingAgents scene JSON writer.\n"
        "Return ONLY a single valid JSON object with this exact shape:\n"
        "{\n"
        '  "dialogue": { "<agent_id>": "<short line>", ... },\n'
        '  "animations": { "<agent_id>": "<animation>", ... },\n'
        '  "stations": { "<agent_id>": "<station>", ... },\n'
        '  "paths": { "<agent_id>": "<path>", ... }\n'
        "}\n"
        "Rules:\n"
        f"- Include ALL canonical agent ids exactly once in each map: {', '.join(_TA_CANONICAL_AGENT_IDS)}.\n"
        "- Dialogue must contain 12 non-empty lines (one per canonical agent). No narration fields.\n"
        f"- Allowed animations: {allowed_animations}.\n"
        f"- Allowed stations: {allowed_stations}.\n"
        f"- Allowed paths: {allowed_paths}.\n"
        "- Each dialogue line must be <= 8 words.\n"
        "- Keep dialogue concise and in-character for financial analysis workflow.\n"
        "- Do not include markdown fences or extra keys."
    )


def _build_scene_writer_user_prompt(
    *,
    record: Dict[str, Any],
    scene_index: int,
    agent_id: Optional[str],
    report_text: str,
    ticker: str,
    trade_date: str,
) -> str:
    scene_meta = _timeline_scene_for_index(scene_index) or {}
    canonical_reports = _extract_reports_from_state(_as_dict(record.get("raw_state")))
    reports_block = []
    for candidate_id in _TA_CANONICAL_AGENT_IDS:
        report = _normalize_report_text(canonical_reports.get(candidate_id))
        if not report:
            continue
        reports_block.append(f"- {candidate_id}: {report[:1200]}")
    if not reports_block:
        reports_block.append("- no completed reports yet")
    focal_agent = agent_id or "system"
    focal_report = _normalize_report_text(report_text) or "Timeline initialization."
    return (
        f"Ticker: {ticker}\n"
        f"Trade date: {trade_date}\n"
        f"Scene index: {scene_index:02d}\n"
        f"Scene key: {scene_meta.get('key')}\n"
        f"Scene label: {scene_meta.get('label')}\n"
        f"Scene name: {scene_meta.get('name')}\n"
        f"Focal agent: {focal_agent}\n"
        f"Focal report excerpt:\n{focal_report[:2000]}\n\n"
        "Canonical report context:\n"
        f"{chr(10).join(reports_block)}\n\n"
        "Generate a canonical scene for this timeline step."
    )


async def _call_scene_writer_json(
    *,
    run_id: str,
    provider: str,
    model: str,
    prompt: str,
    system_prompt: str,
) -> Dict[str, Any]:
    provider_norm = str(provider or "").strip().lower()
    model_norm = str(model or "").strip()
    if not model_norm:
        raise RuntimeError("SCENE_DIALOGUE_FAILED: auto scene writer model is empty")

    if provider_norm == "nvidia":
        api_key, base_url = _scene_writer_provider_credentials(run_id, provider_norm)
        if not api_key:
            raise RuntimeError("SCENE_DIALOGUE_FAILED: NVIDIA scene writer key is missing")
        api_root = str(base_url or "https://integrate.api.nvidia.com/v1").rstrip("/")
        payload = {
            "model": model_norm,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
            "top_p": 0.95,
            "stream": False,
            "max_tokens": 3072,
            "response_format": {"type": "json_object"},
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(f"{api_root}/chat/completions", json=payload, headers=headers)
            if response.status_code in {400, 500, 502, 503, 504}:
                retry_payload = dict(payload)
                retry_payload.pop("response_format", None)
                response = await client.post(f"{api_root}/chat/completions", json=retry_payload, headers=headers)
            response.raise_for_status()
            data = response.json()
        content = ((((data or {}).get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        if not content:
            raise RuntimeError("SCENE_DIALOGUE_FAILED: NVIDIA scene writer returned empty payload")
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise RuntimeError("SCENE_DIALOGUE_FAILED: NVIDIA scene writer returned invalid JSON") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("SCENE_DIALOGUE_FAILED: scene writer JSON payload must be an object")
        return parsed

    from src.llm.client import get_llm_client

    llm_client = get_llm_client()
    parsed = await llm_client.generate_scene_json(
        prompt=prompt,
        system_prompt=system_prompt,
        provider=provider_norm,
        model=model_norm,
        temperature=0.2,
    )
    if not isinstance(parsed, dict):
        raise RuntimeError("SCENE_DIALOGUE_FAILED: scene writer JSON payload must be an object")
    return parsed


def _build_scene_payload_from_writer_output(
    run_id: str,
    record: Dict[str, Any],
    *,
    scene_index: int,
    agent_id: Optional[str],
    ticker: str,
    trade_date: str,
    writer_output: Dict[str, Any],
    writer_model: str,
    writer_latency_ms: Optional[int],
) -> Dict[str, Any]:
    dialogue_map = _as_dict(writer_output.get("dialogue"))
    animations_map = _as_dict(writer_output.get("animations"))
    stations_map = _as_dict(writer_output.get("stations"))
    paths_map = _as_dict(writer_output.get("paths"))
    if not dialogue_map or not animations_map or not stations_map or not paths_map:
        raise RuntimeError("SCENE_DIALOGUE_FAILED: scene writer JSON missing required maps")

    canonical_lines: List[Dict[str, Any]] = []
    station_targets: List[Dict[str, Any]] = []
    animations: List[Dict[str, Any]] = []
    agent_paths: Dict[str, str] = {}
    movement_plan: List[Dict[str, Any]] = []
    drama_level = _scene_drama_level_for_record(record)
    defaults_station_map = {
        row["agent"]: row["station"]
        for row in _build_scene_station_targets(
            agent_id,
            scene_index=scene_index,
            drama_level=drama_level,
        )
        if row.get("agent")
    }
    defaults_animation_map = {
        row["agent"]: row["animation"]
        for row in _build_scene_animations(
            agent_id,
            scene_index=scene_index,
            drama_level=drama_level,
        )
        if row.get("agent")
    }
    default_paths_map = _build_scene_paths(
        agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    active_name = normalize_tradingagents_agent_name(agent_id) if agent_id else None

    for order, agent_id_key in enumerate(_TA_CANONICAL_AGENT_IDS, start=1):
        display_name = _TA_CANONICAL_AGENT_NAMES_BY_ID.get(agent_id_key)
        if not display_name:
            raise RuntimeError(f"SCENE_DIALOGUE_FAILED: canonical roster missing display name for {agent_id_key}")
        dialogue_line = _normalize_scene_dialogue_line(
            dialogue_map.get(agent_id_key),
            fallback=_normalize_scene_dialogue_line(
                dialogue_map.get(display_name),
                fallback=f"{display_name} update pending.",
            ),
        )
        animation_value = _normalize_scene_enum(
            animations_map.get(agent_id_key),
            _TA_ALLOWED_SCENE_ANIMATIONS,
            defaults_animation_map.get(display_name, "idle"),
            "animation",
            agent_id_key,
        )
        station_value = _normalize_scene_enum(
            stations_map.get(agent_id_key),
            _TA_ALLOWED_SCENE_STATIONS,
            defaults_station_map.get(display_name, "desk"),
            "station",
            agent_id_key,
        )
        path_value = _normalize_scene_enum(
            paths_map.get(agent_id_key),
            _TA_ALLOWED_SCENE_PATHS,
            default_paths_map.get(display_name, "direct"),
            "path",
            agent_id_key,
        )
        canonical_lines.append({"order": order, "speaker": display_name, "text": dialogue_line})
        animations.append({"agent": display_name, "animation": animation_value})
        station_targets.append({"agent": display_name, "station": station_value})
        agent_paths[display_name] = path_value
        movement_plan.append(
            {
                "agent": display_name,
                "from": defaults_station_map.get(display_name, "desk"),
                "to": station_value,
                "mode": path_value,
                "path": path_value,
            }
        )

    if len(canonical_lines) != len(_TA_CANONICAL_AGENT_IDS):
        raise RuntimeError("SCENE_DIALOGUE_FAILED: dialogue coverage must include exactly 12 canonical agents")

    writer_meta = _build_writer_meta(record, scene_index)
    writer_meta["writer_source"] = "auto_llm"
    writer_meta["writer_model"] = writer_model
    writer_meta["writer_latency_ms"] = writer_latency_ms
    writer_meta["validation_passed"] = True
    return {
        "run_id": run_id,
        "phase": TRADINGAGENTS_STEP_TO_SCENE.get(agent_id or "", "STEP_1_ANALYSTS"),
        "ticker": ticker,
        "trade_date": trade_date,
        "headline": _timeline_scene_label_for_index(scene_index),
        "state": "completed",
        "variant": "TradingAgents Timeline",
        "active_agents": [active_name] if active_name else [],
        "station_targets": station_targets,
        "animations": animations,
        "agent_paths": agent_paths,
        "movement_plan": movement_plan,
        "lines": canonical_lines,
        "script": dict(writer_meta),
        "script_meta": dict(writer_meta),
    }


async def _build_auto_written_scene_payload(
    run_id: str,
    record: Dict[str, Any],
    *,
    scene_index: int,
    agent_id: Optional[str],
    report_text: str,
    ticker: str,
    trade_date: str,
) -> Dict[str, Any]:
    provider = _scene_writer_provider_for_record(record)
    writer_model = _scene_writer_model_for_record(record, provider=provider)
    prompt = _build_scene_writer_user_prompt(
        record=record,
        scene_index=scene_index,
        agent_id=agent_id,
        report_text=report_text,
        ticker=ticker,
        trade_date=trade_date,
    )
    system_prompt = _build_scene_writer_system_prompt()
    started_at = datetime.now()
    writer_output = await _call_scene_writer_json(
        run_id=run_id,
        provider=provider,
        model=writer_model,
        prompt=prompt,
        system_prompt=system_prompt,
    )
    latency_ms = int((datetime.now() - started_at).total_seconds() * 1000)
    return _build_scene_payload_from_writer_output(
        run_id,
        record,
        scene_index=scene_index,
        agent_id=agent_id,
        ticker=ticker,
        trade_date=trade_date,
        writer_output=writer_output,
        writer_model=writer_model,
        writer_latency_ms=latency_ms,
    )


def _build_canonical_scene_payload(
    run_id: str,
    record: Dict[str, Any],
    *,
    scene_index: int,
    agent_id: Optional[str],
    report_text: str,
    ticker: str,
    trade_date: str,
    state: str = "running",
) -> Dict[str, Any]:
    scene_label = _timeline_scene_label_for_index(scene_index)
    writer_meta = _build_writer_meta(record, scene_index)
    drama_level = _scene_drama_level_for_record(record)
    station_targets = _build_scene_station_targets(
        agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    animations = _build_scene_animations(
        agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    agent_paths = _build_scene_paths(
        agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    movement_plan = _build_scene_movement_plan(
        agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    active_name = normalize_tradingagents_agent_name(agent_id) if agent_id else None
    dialogue_map = _build_deterministic_dialogue_map(scene_index, agent_id)
    canonical_lines: List[Dict[str, Any]] = []
    for order, agent_id_key in enumerate(_TA_CANONICAL_AGENT_IDS, start=1):
        display_name = _TA_CANONICAL_AGENT_NAMES_BY_ID.get(agent_id_key)
        if not display_name:
            continue
        canonical_lines.append(
            {
                "order": order,
                "speaker": display_name,
                "text": _normalize_scene_dialogue_line(
                    dialogue_map.get(agent_id_key),
                    fallback=f"{display_name} update pending.",
                ),
            }
        )

    return {
        "run_id": run_id,
        "phase": TRADINGAGENTS_STEP_TO_SCENE.get(agent_id or "", "STEP_1_ANALYSTS"),
        "ticker": ticker,
        "trade_date": trade_date,
        "headline": scene_label,
        "state": state,
        "variant": "TradingAgents Timeline",
        "active_agents": [active_name] if active_name else [],
        "station_targets": station_targets,
        "animations": animations,
        "agent_paths": agent_paths,
        "movement_plan": movement_plan,
        "lines": canonical_lines,
        "script": dict(writer_meta),
        "script_meta": dict(writer_meta),
    }


def _build_movement_cue_command(
    run_id: str,
    *,
    scene_index: int,
    agent_id: Optional[str],
    ticker: str,
    trade_date: str,
) -> Dict[str, Any]:
    scene_label = _timeline_scene_label_for_index(scene_index)
    writer_meta = {
        "scene_key": _timeline_scene_key_for_index(scene_index),
        "scene_label": scene_label,
        "source_report_slot": scene_index,
    }
    drama_level = _scene_drama_level_for_record(_as_dict(_run_records.get(run_id)))
    station_targets = _build_scene_station_targets(
        agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    animations = _build_scene_animations(
        agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    agent_paths = _build_scene_paths(
        agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    movement_plan = _build_scene_movement_plan(
        agent_id,
        scene_index=scene_index,
        drama_level=drama_level,
    )
    active_name = normalize_tradingagents_agent_name(agent_id) if agent_id else None

    return {
        "type": "PLAY_STEP_SCENE",
        "runId": run_id,
        "ticker": ticker,
        "trade_date": trade_date,
        "phase": TRADINGAGENTS_STEP_TO_SCENE.get(agent_id or "", "STEP_1_ANALYSTS"),
        "headline": scene_label,
        "variant": "TradingAgents Timeline",
        "agents": _build_scene_agents(),
        "activeAgents": [active_name] if active_name else [],
        "agentStations": {row["agent"]: row["station"] for row in station_targets},
        "agentAnimations": {row["agent"]: row["animation"] for row in animations},
        "agentPaths": agent_paths,
        "movementPlan": movement_plan,
        "dialogue": [],
        "scriptMeta": writer_meta,
    }


def _coerce_scene_index(value: Any, default: int = -1) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except Exception:
        return default


def _upsert_scene_history_entry(record: Dict[str, Any], entry: Dict[str, Any]) -> None:
    history = list(record.get("scene_history") or [])
    scene_index = _coerce_scene_index(entry.get("scene_index"), 0)
    replaced = False
    for idx, row in enumerate(history):
        if _coerce_scene_index(row.get("scene_index"), -1) == scene_index:
            history[idx] = {**row, **entry}
            replaced = True
            break
    if not replaced:
        history.append(entry)
    history.sort(key=lambda row: _coerce_scene_index(row.get("scene_index"), 9999))
    record["scene_history"] = history
    record["scene_count"] = len(history)
    if history:
        latest = history[-1]
        record["latest_scene_index"] = latest.get("scene_index")
        record["latest_scene_label"] = latest.get("scene_label")
        record["latest_scene_kind"] = latest.get("scene_kind")
        record["latest_scene_attempt"] = latest.get("attempt")


def _extract_decision(text_value: Any) -> str:
    upper = str(text_value or "").upper().strip()
    if not upper:
        return "HOLD"
    if upper in {"BUY", "SELL", "HOLD", "ADD", "LIQUIDATE"}:
        return upper

    explicit_match = re.search(
        r"(?:FINAL\s+TRANSACTION\s+PROPOSAL|FINAL\s+DECISION|RATING)\s*[:\-]\s*(BUY|SELL|HOLD|ADD|LIQUIDATE)\b",
        upper,
    )
    if explicit_match:
        return explicit_match.group(1)

    for action in ("LIQUIDATE", "SELL", "BUY", "HOLD", "ADD"):
        if re.search(rf"\b{action}\b", upper):
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


def _extract_reports_from_complete_report_markdown(complete_report: str) -> Dict[str, str]:
    text = _normalize_report_text(complete_report)
    if not text:
        return {}
    # Parse sections like "## Aggressive Analyst Report" from complete_report.md.
    pattern = re.compile(r"^##\s+(.+?)\s*$([\s\S]*?)(?=^##\s+|\Z)", flags=re.MULTILINE)
    section_map: Dict[str, str] = {}
    for match in pattern.finditer(text):
        header = str(match.group(1) or "").strip().lower()
        body = _normalize_report_text(match.group(2))
        if not body:
            continue
        section_map[header] = body

    canonical: Dict[str, str] = {}
    alias_to_agent_id = {
        "market analyst report": "market_analyst",
        "social analyst report": "social_analyst",
        "news analyst report": "news_analyst",
        "fundamentals analyst report": "fundamentals_analyst",
        "bull researcher report": "bull_researcher",
        "bear researcher report": "bear_researcher",
        "research manager report": "research_manager",
        "trader report": "trader",
        "trader plan report": "trader",
        "aggressive analyst report": "aggressive_analyst",
        "conservative analyst report": "conservative_analyst",
        "neutral analyst report": "neutral_analyst",
        "portfolio decision report": "risk_judge",
    }
    for header, body in section_map.items():
        agent_id = alias_to_agent_id.get(header)
        if agent_id and body:
            canonical[agent_id] = body
    return canonical


def _canonical_reports_from_payload(
    full_agent_reports: Dict[str, Any],
    final_state: Dict[str, Any],
    complete_report: str = "",
) -> Dict[str, str]:
    state_reports = _extract_reports_from_state(final_state)
    markdown_reports = _extract_reports_from_complete_report_markdown(complete_report)
    reports: Dict[str, str] = {}
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_id = agent["id"]
        report = _normalize_report_text(full_agent_reports.get(agent_id))
        if not report:
            report = state_reports.get(agent_id, "")
        if not report:
            report = markdown_reports.get(agent_id, "")
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


def _upstream_sidecar_payload(
    run_id: str,
    payload: Dict[str, Any],
    provider: str,
    quick_model: str,
    deep_model: str,
    depth: str,
    output_language: str,
    provider_api_key: str = "",
    provider_base_url: str = "",
) -> Dict[str, Any]:
    normalized_trade_date = _normalize_trade_date(payload.get("date") or datetime.now().strftime("%Y-%m-%d"))
    sidecar_payload: Dict[str, Any] = {
        "run_id": run_id,
        "ticker": str(payload.get("ticker") or "NVDA").strip().upper(),
        "date": normalized_trade_date,
        "provider": provider,
        "quickModel": quick_model,
        "deepModel": deep_model,
        "researchDepth": depth,
        "outputLanguage": output_language,
    }
    if provider_api_key:
        sidecar_payload["providerApiKey"] = provider_api_key
    if provider_base_url:
        sidecar_payload["providerBaseUrl"] = provider_base_url
    return sidecar_payload


def _seed_run_record(
    run_id: str,
    payload: Dict[str, Any],
    *,
    provider: str,
    quick_model: str,
    deep_model: str,
    depth: str,
    output_language: str,
    auto_scene_writer_enabled: bool,
    auto_scene_writer_provider: str,
    auto_scene_writer_model: str,
    drama_level: str,
    strict_parity_mode: bool = False,
) -> Dict[str, Any]:
    now = _now_iso()
    # UI date is source of truth: do not auto-shift/clamp to prior day.
    trade_date = _normalize_trade_date(
        payload.get("date") or datetime.now().strftime("%Y-%m-%d"),
        clamp_to_last_completed_day=False,
    )
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
        "drama_level": _normalize_drama_level(drama_level),
        "auto_scene_writer_enabled": _coerce_bool(auto_scene_writer_enabled, False),
        "auto_scene_writer_provider": str(auto_scene_writer_provider or "").strip().lower(),
        "auto_scene_writer_model": str(auto_scene_writer_model or "").strip(),
        "agent_reports": [],
        "attempt": 1,
        "max_attempts": 1,
        "llm_calls": 0,
        "tool_calls": 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "scene_history": [],
        "scene_count": 0,
        "latest_scene_index": None,
        "latest_scene_label": None,
        "latest_scene_kind": None,
        "latest_scene_attempt": None,
        "raw_state": {
            "trade_date": trade_date,
            "research_depth": depth,
            "quick_model": quick_model,
            "deep_model": deep_model,
            "llm_provider": provider,
            "drama_level": _normalize_drama_level(drama_level),
            "auto_scene_writer_enabled": _coerce_bool(auto_scene_writer_enabled, False),
            "auto_scene_writer_provider": str(auto_scene_writer_provider or "").strip().lower(),
            "auto_scene_writer_model": str(auto_scene_writer_model or "").strip(),
            **copy.deepcopy(_RAW_STATE_BASE),
        },
    }


async def _emit_scene_history_reset(run_id: str, ticker: str, attempt: int = 1) -> None:
    await _broadcast({
        "type": "tradingagents_scene_history_reset",
        "run_id": run_id,
        "active_run_id": run_id,
        "ticker": ticker,
        "attempt": attempt,
        "timestamp": _now_iso(),
    })


async def _emit_scene_cue(
    run_id: str,
    record: Dict[str, Any],
    *,
    scene_index: int,
    agent_id: Optional[str],
    ticker: str,
    trade_date: str,
    attempt: int,
) -> None:
    scene_label = _timeline_scene_label_for_index(scene_index)
    scene_kind = "init" if scene_index == 0 else "report_started"
    source_slot = scene_index if scene_index > 0 else 0
    command = _build_movement_cue_command(
        run_id,
        scene_index=scene_index,
        agent_id=agent_id,
        ticker=ticker,
        trade_date=trade_date,
    )
    await _broadcast({
        "type": "tradingagents_scene_cue",
        "run_id": run_id,
        "active_run_id": run_id,
        "ticker": ticker,
        "attempt": attempt,
        "scene_index": scene_index,
        "scene_key": _timeline_scene_key_for_index(scene_index),
        "scene_label": scene_label,
        "scene_kind": scene_kind,
        "source_agent": agent_id,
        "source_report_slot": source_slot,
        "command": command,
        "timestamp": _now_iso(),
    })


async def _emit_scene_generated(
    run_id: str,
    record: Dict[str, Any],
    *,
    scene_index: int,
    agent_id: Optional[str],
    report_text: str,
    ticker: str,
    trade_date: str,
    attempt: int,
    scene_kind: Optional[str] = None,
) -> None:
    existing_entry = _scene_history_entry_for_index(record, scene_index, attempt)
    if existing_entry and existing_entry.get("scene"):
        return
    if _scene_writer_enabled_for_record(record):
        try:
            if int(scene_index) == 0:
                init_timeout_raw = str(os.getenv("TA_SCENE_INIT_TIMEOUT_SEC") or "8").strip()
                try:
                    init_timeout = max(2.0, float(init_timeout_raw))
                except Exception:
                    init_timeout = 8.0
                canonical_scene = await asyncio.wait_for(
                    _build_auto_written_scene_payload(
                        run_id,
                        record,
                        scene_index=scene_index,
                        agent_id=agent_id,
                        report_text=report_text,
                        ticker=ticker,
                        trade_date=trade_date,
                    ),
                    timeout=init_timeout,
                )
            else:
                canonical_scene = await _build_auto_written_scene_payload(
                    run_id,
                    record,
                    scene_index=scene_index,
                    agent_id=agent_id,
                    report_text=report_text,
                    ticker=ticker,
                    trade_date=trade_date,
                )
        except Exception as exc:
            message = str(exc)
            if int(scene_index) == 0:
                logger.warning(
                    "Scene writer init fallback for %s scene 00 after error: %s",
                    run_id,
                    message,
                )
                await _emit_scene_runtime_warning(
                    run_id,
                    scene_index=0,
                    source_agent=agent_id,
                    message=(
                        f"Init scene writer failed; used deterministic fallback. "
                        f"Reason: {message}"
                    ),
                )
                canonical_scene = _build_canonical_scene_payload(
                    run_id,
                    record,
                    scene_index=scene_index,
                    agent_id=agent_id,
                    report_text=report_text,
                    ticker=ticker,
                    trade_date=trade_date,
                    state="completed",
                )
            else:
                logger.warning(
                    "Scene writer fallback for %s scene %s after error: %s",
                    run_id,
                    _timeline_scene_label_for_index(scene_index),
                    message,
                )
                await _emit_scene_runtime_warning(
                    run_id,
                    scene_index=int(scene_index),
                    source_agent=agent_id,
                    message=(
                        f"Auto scene writer failed; used deterministic fallback. "
                        f"Reason: {message}"
                    ),
                )
                canonical_scene = _build_canonical_scene_payload(
                    run_id,
                    record,
                    scene_index=scene_index,
                    agent_id=agent_id,
                    report_text=report_text,
                    ticker=ticker,
                    trade_date=trade_date,
                    state="completed",
                )
    else:
        canonical_scene = _build_canonical_scene_payload(
            run_id,
            record,
            scene_index=scene_index,
            agent_id=agent_id,
            report_text=report_text,
            ticker=ticker,
            trade_date=trade_date,
            state="completed",
        )
    scene_label = _timeline_scene_label_for_index(scene_index)
    resolved_kind = scene_kind or _timeline_scene_kind_for_index(scene_index)
    source_slot = scene_index if scene_index > 0 else 0
    source_agent = agent_id or _timeline_scene_agent_for_index(scene_index)
    entry = {
        "run_id": run_id,
        "attempt": attempt,
        "scene_index": scene_index,
        "scene_key": _timeline_scene_key_for_index(scene_index),
        "scene_label": scene_label,
        "scene_kind": resolved_kind,
        "source_agent": source_agent,
        "source_report_slot": source_slot,
        "scene": canonical_scene,
        "command": None,
        "timestamp": _now_iso(),
    }
    _upsert_scene_history_entry(record, entry)
    await _broadcast({
        "type": "tradingagents_scene_generated",
        "run_id": run_id,
        "active_run_id": run_id,
        "ticker": ticker,
        "attempt": attempt,
        "scene_index": scene_index,
        "scene_key": _timeline_scene_key_for_index(scene_index),
        "scene_label": scene_label,
        "scene_kind": resolved_kind,
        "source_agent": source_agent,
        "source_report_slot": source_slot,
        "scene": canonical_scene,
        "timestamp": entry["timestamp"],
    })


def _missing_canonical_scene_indexes(record: Dict[str, Any]) -> List[int]:
    seen = {_coerce_scene_index(row.get("scene_index"), -1) for row in list(record.get("scene_history") or [])}
    return [idx for idx in range(13) if idx not in seen]


async def _set_idle_pipeline_state(
    run_id: Optional[str] = None,
    *,
    status: str = "idle",
    action: str = "Awaiting pipeline activation.",
    clear_run_context: bool = False,
) -> None:
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
        # Idle view must not look like a live stuck run.
        pipeline_state["llm_calls"] = 0
        pipeline_state["tool_calls"] = 0
        pipeline_state["tokens_in"] = 0
        pipeline_state["tokens_out"] = 0
        pipeline_state["agents_completed"] = 0
        pipeline_state["reports_completed"] = 0
        pipeline_state["attempt"] = 1
        pipeline_state["max_attempts"] = 1
        if clear_run_context:
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
    strict_parity_mode = _strict_parity_mode_enabled()
    event_type = str(evt.get("type") or "").strip().lower()
    agent_id = normalize_tradingagents_agent_id(
        evt.get("current_step") or evt.get("agent") or evt.get("agent_display_name")
    )
    display_name = normalize_tradingagents_agent_name(agent_id or evt.get("agent_display_name") or evt.get("agent")) or evt.get("agent_display_name")
    phase_num = _safe_int(evt.get("phase_num"), TRADINGAGENTS_PHASE_NUMBERS.get(agent_id or "", pipeline_state.get("phase_num", 0)))
    phase = str(evt.get("phase") or _phase_name_for_agent(agent_id)).upper()
    timestamp = str(evt.get("timestamp") or _now_iso())
    record = _run_records.get(run_id)
    run_attempt = _safe_int(evt.get("attempt"), _safe_int((record or {}).get("attempt"), 1))
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
    if event_type == "run_retrying":
        pipeline_state["status"] = "retrying"
    elif event_type in {"run_completed", "run_failed", "run_aborted"}:
        pipeline_state["status"] = pipeline_state.get("status") or "running"
    else:
        pipeline_state["status"] = "running"
    pipeline_state["action"] = evt.get("message") or evt.get("action") or pipeline_state.get("action")
    pipeline_state["attempt"] = _safe_int(evt.get("attempt"), pipeline_state.get("attempt", 1))
    pipeline_state["max_attempts"] = _safe_int(evt.get("max_attempts"), pipeline_state.get("max_attempts", 1))
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
        if strict_parity_mode and event_type == "run_telemetry":
            for key in ("reports_completed", "agents_completed"):
                value = _safe_int(pipeline_state.get(key), record.get(key, 0))
                record[key] = value
                record["raw_state"][key] = value

    should_emit_pipeline_start_scene_init = event_type == "pipeline_start" and record is not None
    if should_emit_pipeline_start_scene_init:
        # New run must start from clean live counters/state.
        for key in ("llm_calls", "tool_calls", "tokens_in", "tokens_out", "agents_completed", "reports_completed"):
            pipeline_state[key] = 0
        pipeline_state["attempt"] = _safe_int(evt.get("attempt"), 1)
        pipeline_state["max_attempts"] = _safe_int(evt.get("max_attempts"), 1)
        for agent_state in agent_states.values():
            agent_state["status"] = "idle"
            agent_state["confidence"] = 0.0
            agent_state["message"] = "Awaiting pipeline activation."
            agent_state["last_update"] = timestamp
            agent_state.pop("reasoning", None)

        for key in ("llm_calls", "tool_calls", "tokens_in", "tokens_out", "reports_completed", "agents_completed"):
            record[key] = 0
            record["raw_state"][key] = 0
        record["scene_history"] = []
        record["scene_count"] = 0
        record["latest_scene_index"] = None
        record["latest_scene_label"] = None
        record["latest_scene_kind"] = None
        record["latest_scene_attempt"] = None

    if (not strict_parity_mode) and event_type == "agent_action" and record and agent_id:
        scene_index = _timeline_scene_index_for_agent(agent_id)
        if scene_index is not None:
            await _emit_scene_cue(
                run_id,
                record,
                scene_index=scene_index,
                agent_id=agent_id,
                ticker=pipeline_state.get("ticker") or "---",
                trade_date=str(pipeline_state.get("trade_date") or ""),
                attempt=run_attempt,
            )

    if display_name and display_name in agent_states and event_type in {"agent_action", "agent_completed"}:
        agent_state = agent_states[display_name]
        agent_state["status"] = "completed" if event_type == "agent_completed" else str(evt.get("status") or "analyzing")
        agent_state["message"] = evt.get("message") or evt.get("action") or agent_state.get("message")
        agent_state["reasoning"] = evt.get("report") or evt.get("raw_excerpt") or agent_state.get("reasoning")
        agent_state["last_update"] = timestamp
        completed_count = sum(1 for state in agent_states.values() if str(state.get("status") or "").lower() == "completed")
        pipeline_state["reports_completed"] = completed_count
        pipeline_state["agents_completed"] = completed_count
        if record:
            record["reports_completed"] = completed_count
            record["agents_completed"] = completed_count

    if record and agent_id and event_type == "agent_completed":
        report_text = _normalize_report_text(evt.get("report") or evt.get("raw_excerpt"))
        scene_index = _timeline_scene_index_for_agent(agent_id)
        if scene_index is None and (not strict_parity_mode):
            await _emit_scene_runtime_warning(
                run_id,
                scene_index=None,
                source_agent=agent_id,
                message=f"No canonical timeline slot for agent {agent_id}; skipping scene emission.",
            )
            scene_index = -1
        if not report_text:
            report_text = _normalize_report_text(evt.get("message"))
        if not report_text:
            report_text = _normalize_report_text(_extract_reports_from_state(_as_dict(record.get("raw_state"))).get(agent_id))
        if not report_text:
            fallback_name = normalize_tradingagents_agent_name(agent_id) or agent_id
            report_text = f"{fallback_name} report completed."
        if (not strict_parity_mode) and (not _normalize_report_text(evt.get("report") or evt.get("raw_excerpt"))):
            await _emit_scene_runtime_warning(
                run_id,
                scene_index=scene_index if scene_index >= 0 else None,
                source_agent=agent_id,
                message=f"Missing report text for {agent_id}; using deterministic scene fallback line.",
            )
        record["raw_state"][agent_id] = report_text
        for raw_path in _AGENT_RAW_STATE_PATHS.get(agent_id, []):
            _set_nested(record["raw_state"], raw_path, report_text)
        _upsert_live_agent_report(record, agent_id, report_text)
        if (not strict_parity_mode) and scene_index >= 0:
            await _emit_scene_generated(
                run_id,
                record,
                scene_index=scene_index,
                agent_id=agent_id,
                report_text=report_text,
                ticker=pipeline_state.get("ticker") or "---",
                trade_date=str(pipeline_state.get("trade_date") or ""),
                attempt=run_attempt,
                scene_kind="report_completed",
            )

    terminal_event = event_type in {"run_completed", "run_failed", "run_aborted"}

    if event_type == "run_retrying":
        pipeline_state["status"] = "retrying"
    elif event_type == "run_completed":
        pipeline_state["phase"] = "COMPLETE"
        pipeline_state["phase_num"] = 5
        pipeline_state["status"] = "complete"
        pipeline_state["action"] = evt.get("decision") or evt.get("message") or pipeline_state.get("action")
        pipeline_state["active_run_id"] = None
    elif event_type == "run_failed":
        pipeline_state["phase"] = "FAILED"
        pipeline_state["status"] = "failed"
        pipeline_state["action"] = evt.get("error_message") or evt.get("error") or "Run failed"
        pipeline_state["active_run_id"] = None
    elif event_type == "run_aborted":
        pipeline_state["phase"] = "ABORTED"
        pipeline_state["status"] = "aborted"
        pipeline_state["action"] = evt.get("message") or "Run aborted"
        pipeline_state["active_run_id"] = None

    await _broadcast({
        **evt,
        "run_id": run_id,
        "active_run_id": None if terminal_event else run_id,
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

    if should_emit_pipeline_start_scene_init and record:
        await _emit_scene_history_reset(run_id, pipeline_state.get("ticker") or "---", run_attempt)
        await _emit_scene_cue(
            run_id,
            record,
            scene_index=0,
            agent_id=None,
            ticker=pipeline_state.get("ticker") or "---",
            trade_date=str(pipeline_state.get("trade_date") or ""),
            attempt=run_attempt,
        )
        await _emit_scene_generated(
            run_id,
            record,
            scene_index=0,
            agent_id=None,
            report_text="TradingAgents canonical timeline initialized.",
            ticker=pipeline_state.get("ticker") or "---",
            trade_date=str(pipeline_state.get("trade_date") or ""),
            attempt=run_attempt,
            scene_kind="init",
        )

    if record:
        _persist_run_record_to_db(run_id, record)


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
    canonical_reports = _canonical_reports_from_payload(file_reports, final_state, complete_report)
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
        final_state.get("recommended_action")
        or completion_event.get("decision")
        or completion_event.get("prediction")
        or final_state.get("final_decision")
        or final_state.get("final_trade_decision")
        or complete_report
    )
    attempts = completion_event.get("attempts") or []
    telemetry = {
        # Use None-aware precedence so valid zeros from final_state are preserved.
        "attempt": _first_not_none(
            final_state.get("attempt"),
            completion_event.get("attempt"),
            sidecar_run.get("attempt"),
            1,
        ),
        "max_attempts": _first_not_none(
            final_state.get("max_attempts"),
            completion_event.get("max_attempts"),
            sidecar_run.get("max_attempts"),
            1,
        ),
        "llm_calls": _first_not_none(
            final_state.get("llm_calls"),
            completion_event.get("llm_calls"),
            sidecar_run.get("llm_calls"),
            0,
        ),
        "tool_calls": _first_not_none(
            final_state.get("tool_calls"),
            completion_event.get("tool_calls"),
            sidecar_run.get("tool_calls"),
            0,
        ),
        "tokens_in": _first_not_none(
            final_state.get("tokens_in"),
            completion_event.get("tokens_in"),
            sidecar_run.get("tokens_in"),
            0,
        ),
        "tokens_out": _first_not_none(
            final_state.get("tokens_out"),
            completion_event.get("tokens_out"),
            sidecar_run.get("tokens_out"),
            0,
        ),
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
    record["final_decision"] = decision
    record["final_trade_decision"] = decision
    record["prediction"] = str(
        final_state.get("final_trade_decision")
        or final_state.get("final_decision")
        or completion_event.get("prediction")
        or decision
    )
    record["reasoning"] = complete_report[:4000]
    record["report_excerpt"] = _excerpt(complete_report, 800)
    record["complete_report"] = complete_report
    record["agent_reports"] = _build_agent_reports(canonical_reports)
    record["reports_generated"] = len(record["agent_reports"])
    record["agents_completed"] = len(record["agent_reports"])
    record["reports_completed"] = len(record["agent_reports"])
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
    event_type = str(failure_event.get("type") or "").strip().lower()
    event_error_code = str(failure_event.get("error_code") or "").strip().upper()
    status = str(sidecar_run.get("status") or "").upper()
    if event_type == "run_aborted" or event_error_code in {"RUN_PREEMPTED", "RUN_ABORTED"}:
        status = "ABORTED"
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


async def _backfill_missing_canonical_scenes(run_id: str, record: Dict[str, Any]) -> None:
    ticker = str(record.get("ticker") or "---").upper()
    trade_date = str((record.get("raw_state") or {}).get("trade_date") or "")
    attempt = _safe_int(record.get("attempt"), 1)
    raw_state = _as_dict(record.get("raw_state"))
    reports_by_state = _extract_reports_from_state(raw_state)
    # Always ensure INIT exists.
    if 0 in _missing_canonical_scene_indexes(record):
        await _emit_scene_generated(
            run_id,
            record,
            scene_index=0,
            agent_id=None,
            report_text="TradingAgents canonical timeline initialized.",
            ticker=ticker,
            trade_date=trade_date,
            attempt=attempt,
            scene_kind="init",
        )
    for scene_index in _missing_canonical_scene_indexes(record):
        if scene_index == 0:
            continue
        agent_id = _timeline_scene_agent_for_index(scene_index)
        if not agent_id:
            continue
        report_text = _normalize_report_text(reports_by_state.get(agent_id) or raw_state.get(agent_id))
        if not report_text:
            continue
        await _emit_scene_generated(
            run_id,
            record,
            scene_index=scene_index,
            agent_id=agent_id,
            report_text=report_text,
            ticker=ticker,
            trade_date=trade_date,
            attempt=attempt,
            scene_kind="report_completed",
        )


async def _pump_upstream_run(run_id: str, upstream_run_id: str) -> None:
    completion_event: Optional[Dict[str, Any]] = None
    failure_event: Optional[Dict[str, Any]] = None
    strict_parity_mode = _strict_parity_mode_enabled()
    try:
        async for envelope in stream_upstream_events(upstream_run_id):
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
            elif kind == "raw_log":
                # Pass upstream stdout/stderr lines into live UI state so
                # strict parity runs visibly progress while non-streaming
                # propagate() is still executing.
                line = str(envelope.get("line") or "").strip()
                if not line:
                    continue
                await _apply_live_event(
                    run_id,
                    {
                        # Frontend listens for this exact type for live console streaming.
                        "type": "tradingagents_raw_log",
                        "run_id": run_id,
                        "line": line,
                        "message": line,
                        "action": line,
                        "phase": "ANALYSTS",
                        "phase_num": 1,
                        "timestamp": str(envelope.get("timestamp") or _now_iso()),
                    },
                )
            elif kind == "terminal":
                continue

        sidecar_run = await get_upstream_run(upstream_run_id)
        artifacts_payload = await get_upstream_artifacts(upstream_run_id)
        record = _run_records.get(run_id)
        if not record:
            return

        if str(sidecar_run.get("status") or "").upper() == "COMPLETED":
            if not completion_event:
                raise RuntimeError("Upstream run ended without a run_completed event.")
            _materialize_completed_run(
                run_id,
                record,
                completion_event=completion_event,
                sidecar_run=sidecar_run,
                artifacts_payload=artifacts_payload,
            )
            if not strict_parity_mode:
                await _backfill_missing_canonical_scenes(run_id, record)
                missing_scene_indexes = _missing_canonical_scene_indexes(record)
                if missing_scene_indexes:
                    missing_labels = ", ".join(_timeline_scene_label_for_index(idx) for idx in missing_scene_indexes)
                    await _emit_scene_runtime_warning(
                        run_id,
                        scene_index=None,
                        source_agent=None,
                        message=f"Missing canonical timeline scenes: {missing_labels}. Reports are still available.",
                    )
            if run_id in _active_runs:
                _active_runs[run_id]["status"] = "completed"
            _persist_run_record_to_db(run_id, record)
            # Keep UI counters in strict lockstep with finalized persisted row.
            with contextlib.suppress(Exception):
                from src.api.trading_floor_compat import pipeline_state

                pipeline_state["status"] = "complete"
                pipeline_state["phase"] = "COMPLETE"
                pipeline_state["phase_num"] = 5
                pipeline_state["llm_calls"] = _safe_int(record.get("llm_calls"), 0)
                pipeline_state["tool_calls"] = _safe_int(record.get("tool_calls"), 0)
                pipeline_state["tokens_in"] = _safe_int(record.get("tokens_in"), 0)
                pipeline_state["tokens_out"] = _safe_int(record.get("tokens_out"), 0)
                pipeline_state["reports_completed"] = len(record.get("agent_reports") or [])
                pipeline_state["agents_completed"] = len(record.get("agent_reports") or [])
                pipeline_state["action"] = (
                    record.get("recommended_action")
                    or record.get("model_action")
                    or pipeline_state.get("action")
                )
                pipeline_state["timestamp"] = _now_iso()
                await _broadcast(
                    {
                        "type": "pipeline_state",
                        "pipeline_state": dict(pipeline_state),
                        "timestamp": pipeline_state["timestamp"],
                    }
                )
        else:
            _materialize_failed_run(run_id, record, sidecar_run=sidecar_run, failure_event=failure_event)
            if run_id in _active_runs:
                _active_runs[run_id]["status"] = record["status"]
            _persist_run_record_to_db(run_id, record)

    except Exception as exc:
        logger.exception("Compat upstream run failed for %s", run_id)
        with contextlib.suppress(Exception):
            await abort_upstream_run(upstream_run_id)
        record = _run_records.get(run_id)
        if record:
            record["run_status"] = "FAILED"
            record["status"] = "failed"
            record["completed_at"] = _now_iso()
            error_text = str(exc)
            error_code = "SCENE_DIALOGUE_FAILED" if "SCENE_DIALOGUE_FAILED" in error_text else "UPSTREAM_ERROR"
            record["error_code"] = error_code
            record["error_message"] = str(exc)
            record["reasoning"] = str(exc)
            record["report_excerpt"] = _excerpt(exc, 300)
            _persist_run_record_to_db(run_id, record)
        if run_id in _active_runs:
            _active_runs[run_id]["status"] = "failed"
        await _apply_live_event(
            run_id,
            {
                "type": "run_failed",
                "run_id": run_id,
                "error_code": "SCENE_DIALOGUE_FAILED" if "SCENE_DIALOGUE_FAILED" in str(exc) else "UPSTREAM_ERROR",
                "error": str(exc),
                "error_message": str(exc),
                "timestamp": _now_iso(),
            },
        )
    finally:
        await _set_idle_pipeline_state(
            run_id,
            status="idle",
            action="Awaiting pipeline activation.",
            clear_run_context=True,
        )
        _active_run_tasks.pop(run_id, None)
        watchdog = _active_run_watchdogs.pop(run_id, None)
        if watchdog and not watchdog.done():
            watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await watchdog
        _active_upstream_runs.pop(run_id, None)


def _run_wall_timeout_seconds(depth: str) -> int:
    if _strict_parity_mode_enabled():
        # Keep strict parity mode aligned to original runtime behavior by
        # avoiding API-layer forced wall aborts.
        return max(24 * 60 * 60, _safe_int(os.getenv("UPSTREAM_STRICT_TIMEOUT_SECONDS_QUICK"), 0))
    depth_key = _normalize_depth(depth)
    defaults = {"quick": 30 * 60, "standard": 40 * 60, "deep": 60 * 60}
    env_key = {
        "quick": "UPSTREAM_RUN_WALL_TIMEOUT_SECONDS_QUICK",
        "standard": "UPSTREAM_RUN_WALL_TIMEOUT_SECONDS_STANDARD",
        "deep": "UPSTREAM_RUN_WALL_TIMEOUT_SECONDS_DEEP",
    }.get(depth_key, "UPSTREAM_RUN_WALL_TIMEOUT_SECONDS_STANDARD")
    raw = os.getenv(env_key) or os.getenv("UPSTREAM_RUN_WALL_TIMEOUT_SECONDS")
    if raw:
        try:
            return max(120, int(float(raw)))
        except Exception:
            pass
    return defaults.get(depth_key, defaults["standard"])


async def _run_watchdog_timeout(run_id: str, upstream_run_id: str, timeout_seconds: int) -> None:
    try:
        await asyncio.sleep(max(1, int(timeout_seconds)))
        row = _run_records.get(run_id) or {}
        status = str(row.get("status") or "").strip().lower()
        if status not in _RUNNING_STATUSES:
            return
        with contextlib.suppress(Exception):
            await abort_upstream_run(upstream_run_id)
        row["run_status"] = "FAILED"
        row["status"] = "failed"
        row["completed_at"] = _now_iso()
        row["error_code"] = "UPSTREAM_TIMEOUT"
        row["error_message"] = f"Run exceeded wall timeout ({int(timeout_seconds)}s)."
        row["reasoning"] = row["error_message"]
        row["report_excerpt"] = _excerpt(row["error_message"], 300)
        _run_records[run_id] = row
        _persist_run_record_to_db(run_id, row)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Run watchdog failed for run_id=%s", run_id)


def _run_age_seconds(row: Dict[str, Any]) -> Optional[float]:
    created_raw = str((row or {}).get("created_at") or "").strip()
    if not created_raw:
        return None
    try:
        created_dt = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
        if created_dt.tzinfo is not None:
            created_dt = created_dt.astimezone(tz=None).replace(tzinfo=None)
        return max(0.0, (datetime.utcnow() - created_dt).total_seconds())
    except Exception:
        return None


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


async def _force_fail_if_orphaned_running_row(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict):
        return row
    status = str(row.get("status") or "").strip().lower()
    run_status = str(row.get("run_status") or "").strip().upper()
    if status not in _RUNNING_STATUSES and run_status not in {"RUNNING", "STARTING", "RETRYING", "ABORTING"}:
        return row
    age_seconds = _run_age_seconds(row)
    if age_seconds is not None and age_seconds < 90:
        return row
    # In strict parity mode, propagate() is non-streaming and can legitimately
    # stay at zero telemetry for several minutes. Do not fail it early.
    strict_parity_mode = _strict_parity_mode_enabled()
    if (
        (not strict_parity_mode)
        and age_seconds is not None
        and age_seconds >= 180
        and _safe_int(row.get("llm_calls"), 0) == 0
        and _safe_int(row.get("tool_calls"), 0) == 0
        and _safe_int(row.get("tokens_in"), 0) == 0
        and _safe_int(row.get("tokens_out"), 0) == 0
    ):
        row["run_status"] = "FAILED"
        row["status"] = "failed"
        row["completed_at"] = row.get("completed_at") or _now_iso()
        row["error_code"] = row.get("error_code") or "UPSTREAM_STALLED_ZERO_PROGRESS"
        row["error_message"] = row.get("error_message") or "Run stalled with zero progress."
        row["reasoning"] = row.get("reasoning") or row["error_message"]
        row["report_excerpt"] = _excerpt(row["error_message"], 300)
        run_id = str(row.get("run_id") or "").strip()
        if run_id:
            _run_records[run_id] = row
            _persist_run_record_to_db(run_id, row)
        return row

    try:
        health = await get_upstream_health()
    except Exception:
        return row
    active_run_id = str((health or {}).get("active_run_id") or "").strip()
    if active_run_id:
        return row

    upstream_run_id = str((_as_dict(row.get("raw_state")).get("upstream_run_id") or row.get("run_id") or "")).strip()
    if upstream_run_id:
        try:
            await get_upstream_run(upstream_run_id)
            return row
        except SidecarError:
            pass
        except Exception:
            return row

    row["run_status"] = "FAILED"
    row["status"] = "failed"
    row["completed_at"] = row.get("completed_at") or _now_iso()
    row["error_code"] = row.get("error_code") or "UPSTREAM_ORPHANED"
    row["error_message"] = row.get("error_message") or "Upstream worker is not active for this run."
    row["reasoning"] = row.get("reasoning") or row["error_message"]
    row["report_excerpt"] = _excerpt(row["error_message"], 300)
    run_id = str(row.get("run_id") or "").strip()
    if run_id:
        _run_records[run_id] = row
        _persist_run_record_to_db(run_id, row)
    return row


@router.get("/tradingagents/config")
async def get_tradingagents_config():
    _load_ta_config_from_store()
    return _public_ta_config()


@router.post("/tradingagents/config")
async def set_tradingagents_config(request: Request):
    _load_ta_config_from_store()
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Config payload must be an object")

    provider = str(payload.get("llm_provider") or _ta_config.get("llm_provider") or "nvidia").strip().lower()
    targeted_base_provider = str(payload.get("provider_base_url_provider") or "").strip().lower()
    has_targeted_base_update = bool(targeted_base_provider and "provider_base_url" in payload)
    defaults = _provider_defaults(provider)
    _ta_config["llm_provider"] = provider
    _ta_config["quick_model"] = str(payload.get("quick_model") or _ta_config.get("quick_model") or defaults.get("default_quick_model"))
    _ta_config["deep_model"] = str(payload.get("deep_model") or _ta_config.get("deep_model") or defaults.get("default_deep_model"))
    _ta_config["output_language"] = str(payload.get("output_language") or _ta_config.get("output_language") or "English")
    _ta_config["drama_level"] = str(payload.get("drama_level") or _ta_config.get("drama_level") or "medium")
    _ta_config["scene_dialogue_preset"] = str(payload.get("scene_dialogue_preset") or _ta_config.get("scene_dialogue_preset") or "buy_side_pod")
    if "auto_scene_writer_enabled" in payload:
        _ta_config["auto_scene_writer_enabled"] = _coerce_bool(payload.get("auto_scene_writer_enabled"), False)
    else:
        _ta_config["auto_scene_writer_enabled"] = _coerce_bool(_ta_config.get("auto_scene_writer_enabled"), False)
    if "auto_scene_writer_provider" in payload:
        candidate_provider = str(payload.get("auto_scene_writer_provider") or "").strip().lower()
        _ta_config["auto_scene_writer_provider"] = (
            candidate_provider if candidate_provider in TRADINGAGENTS_PROVIDER_MODEL_PRESETS else ""
        )
    else:
        candidate_provider = str(_ta_config.get("auto_scene_writer_provider") or "").strip().lower()
        _ta_config["auto_scene_writer_provider"] = (
            candidate_provider if candidate_provider in TRADINGAGENTS_PROVIDER_MODEL_PRESETS else ""
        )
    if "auto_scene_writer_model" in payload:
        _ta_config["auto_scene_writer_model"] = str(payload.get("auto_scene_writer_model") or "").strip()
    else:
        _ta_config["auto_scene_writer_model"] = str(_ta_config.get("auto_scene_writer_model") or "").strip()
    if "provider_base_urls" in payload and isinstance(payload.get("provider_base_urls"), dict):
        next_provider_base_urls: Dict[str, str] = {}
        for provider_id, value in payload.get("provider_base_urls", {}).items():
            normalized = str(provider_id or "").strip().lower()
            base_url = str(value or "").strip()
            if normalized:
                next_provider_base_urls[normalized] = base_url
        _ta_config["provider_base_urls"] = next_provider_base_urls
        _ta_config["provider_base_url"] = str(next_provider_base_urls.get(provider) or "").strip()
    # Credentials are env-only. Never store API keys in config/DB.
    _ta_config["provider_api_key"] = ""
    _ta_config["provider_api_keys"] = {}
    if "provider_base_url_provider" in payload and "provider_base_url" in payload:
        provider_id = str(payload.get("provider_base_url_provider") or "").strip().lower()
        if provider_id:
            provider_base_urls = _as_dict(_ta_config.get("provider_base_urls"))
            base_url = str(payload.get("provider_base_url") or "").strip()
            if base_url:
                provider_base_urls[provider_id] = base_url
            else:
                provider_base_urls.pop(provider_id, None)
            _ta_config["provider_base_urls"] = provider_base_urls
            if provider_id == provider:
                _ta_config["provider_base_url"] = base_url
    _persist_ta_config_to_store()
    return {"success": True, "config": _public_ta_config()}


@router.get("/tradingagents/models")
async def list_tradingagents_models(provider: str = "nvidia"):
    provider = str(provider or "nvidia").strip().lower()
    if provider == "ollama":
        discovered_models = await _discover_ollama_models()
        if discovered_models:
            defaults = _resolve_ollama_model_defaults(discovered_models)
            return {
                "success": True,
                "provider": provider,
                "models": discovered_models,
                "default_quick_model": defaults.get("quick"),
                "default_deep_model": defaults.get("deep"),
            }
    preset = _provider_defaults(provider)
    return {
        "success": True,
        "provider": provider,
        "models": preset.get("models", []),
        "default_quick_model": preset.get("default_quick_model"),
        "default_deep_model": preset.get("default_deep_model"),
    }


@router.get("/tradingagents/models/health")
async def list_tradingagents_models_health(provider: str = "nvidia"):
    provider = str(provider or "nvidia").strip().lower()
    if provider == "ollama":
        discovered_models = await _discover_ollama_models()
        source_models = discovered_models if discovered_models else _provider_defaults(provider).get("models", [])
    else:
        source_models = _provider_defaults(provider).get("models", [])
    models: List[Dict[str, Any]] = []
    for index, model in enumerate(source_models, start=1):
        models.append({
            **model,
            "usable_for_scene_writer": True if provider == "nvidia" else None,
            "status": "compat_mode",
            "latency_ms": None,
            "failure_reason": None,
            "last_tested_at": None,
            "scene_writer_rank": index if provider == "nvidia" else None,
        })
    return {
        "success": True,
        "provider": provider,
        "scene_writer_models": [m["id"] for m in models[:3]] if provider == "nvidia" else [],
        "models": models,
    }


@router.get("/trading-agents/upstream/health")
async def trading_agents_upstream_health():
    try:
        health = await get_upstream_health()
        return {"success": True, "health": health}
    except SidecarError as exc:
        return {
            "success": False,
            "error": str(exc),
            "status_code": exc.status_code,
            "payload": exc.payload,
        }


@router.get("/trading-agents/upstream/runs/{run_id}")
async def trading_agents_upstream_run(run_id: str):
    try:
        run = await get_upstream_run(run_id)
        return {"success": True, "run": run}
    except SidecarError as exc:
        return {
            "success": False,
            "error": str(exc),
            "status_code": exc.status_code,
            "payload": exc.payload,
        }


@router.post("/trading-agents/run")
async def run_trading_agents(request: Request):
    _load_ta_config_from_store()
    strict_parity_mode = _strict_parity_mode_enabled()
    payload = await request.json()
    ticker = str(payload.get("ticker") or "NVDA").strip().upper()
    trade_date = _normalize_trade_date(
        payload.get("date") or datetime.now().strftime("%Y-%m-%d"),
        clamp_to_last_completed_day=not strict_parity_mode,
    )
    provider = str(payload.get("provider") or _ta_config.get("llm_provider") or "nvidia").strip().lower()
    quick_model = str(payload.get("quickModel") or payload.get("quick_model") or _ta_config.get("quick_model") or "").strip()
    deep_model = str(payload.get("deepModel") or payload.get("deep_model") or _ta_config.get("deep_model") or quick_model).strip()
    depth = _normalize_depth(payload.get("depth") or payload.get("research_depth"))
    drama_level = _normalize_drama_level(
        payload.get("dramaLevel")
        or payload.get("drama_level")
        or _ta_config.get("drama_level")
        or "medium"
    )
    output_language = str(payload.get("outputLanguage") or payload.get("output_language") or _ta_config.get("output_language") or "English").strip() or "English"
    auto_scene_writer_enabled = _coerce_bool(
        payload.get("autoSceneWriterEnabled")
        if "autoSceneWriterEnabled" in payload
        else payload.get("auto_scene_writer_enabled")
        if "auto_scene_writer_enabled" in payload
        else _ta_config.get("auto_scene_writer_enabled", False),
        False,
    )
    auto_scene_writer_provider = str(
        payload.get("autoSceneWriterProvider")
        or payload.get("auto_scene_writer_provider")
        or _ta_config.get("auto_scene_writer_provider")
        or ""
    ).strip().lower()
    if auto_scene_writer_provider and auto_scene_writer_provider not in TRADINGAGENTS_PROVIDER_MODEL_PRESETS:
        auto_scene_writer_provider = ""
    auto_scene_writer_model = str(
        payload.get("autoSceneWriterModel")
        or payload.get("auto_scene_writer_model")
        or _ta_config.get("auto_scene_writer_model")
        or ""
    ).strip()
    force_new_run = _coerce_bool(
        payload.get("forceNewRun")
        if "forceNewRun" in payload
        else payload.get("force_new_run"),
        False,
    )
    if strict_parity_mode:
        # In strict parity, always execute a fresh run.
        force_new_run = True
        # Scene writer side-features must stay off for 1:1 engine parity.
        auto_scene_writer_enabled = False
        auto_scene_writer_provider = ""
        auto_scene_writer_model = ""
    provider_base_urls = _as_dict(_ta_config.get("provider_base_urls"))
    env_provider_api_key, env_provider_base_url = _provider_env_credentials(provider)
    provider_api_key = str(
        env_provider_api_key
        or ""
    ).strip()
    provider_base_url = str(
        env_provider_base_url
        or payload.get("providerBaseUrl")
        or payload.get("provider_base_url")
        or provider_base_urls.get(provider)
        or _ta_config.get("provider_base_url")
        or ""
    ).strip()
    provider, quick_model, deep_model, provider_notice = _normalize_provider_and_models_for_compat_run(
        provider,
        quick_model,
        deep_model,
    )

    if provider != "ollama" and not provider_api_key:
        raise HTTPException(
            status_code=400,
            detail={"message": f"Missing API key for provider '{provider}'. Configure it in .env."},
        )
    run_id = build_tradingagents_run_id(ticker, trade_date, prefix="ta")

    await _reconcile_local_active_runs_from_sidecar_health()
    preempted_run_ids: List[str] = []

    sidecar_payload = _upstream_sidecar_payload(
        run_id,
        payload,
        provider=provider,
        quick_model=quick_model,
        deep_model=deep_model,
        depth=depth,
        output_language=output_language,
        provider_api_key=provider_api_key,
        provider_base_url=provider_base_url,
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
        "provider_api_key": provider_api_key,
        "provider_base_url": provider_base_url,
    }
    _run_records[run_id] = _seed_run_record(
        run_id,
        payload,
        provider=provider,
        quick_model=quick_model,
        deep_model=deep_model,
        depth=depth,
        output_language=output_language,
        auto_scene_writer_enabled=auto_scene_writer_enabled,
        auto_scene_writer_provider=auto_scene_writer_provider,
        auto_scene_writer_model=auto_scene_writer_model,
        drama_level=drama_level,
        strict_parity_mode=strict_parity_mode,
    )
    _run_records[run_id]["raw_state"]["upstream_run_id"] = upstream_run_id
    if provider_notice:
        _run_records[run_id]["raw_state"]["compat_provider_notice"] = provider_notice
        _run_records[run_id]["reasoning"] = provider_notice
        _run_records[run_id]["report_excerpt"] = _excerpt(provider_notice, 300)
    _persist_run_record_to_db(run_id, _run_records[run_id])
    preempt_note = ""
    if preempted_run_ids:
        if len(preempted_run_ids) == 1:
            preempt_note = f"Previous run canceled: {preempted_run_ids[0]}."
        else:
            preempt_note = f"Canceled {len(preempted_run_ids)} previous runs."
    start_message = "Starting TradingAgents pipeline..."
    if preempt_note:
        start_message = f"{preempt_note} {start_message}"
    start_action = f"Starting {depth.upper()} TradingAgents analysis for {ticker}..."
    if strict_parity_mode:
        start_action = f"{start_action} (strict parity mode)"
    if preempt_note:
        start_action = f"{preempt_note} {start_action}"
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
            "message": start_message,
            "action": start_action,
            "preempted_run_ids": preempted_run_ids,
            "timestamp": now,
        },
    )

    task = asyncio.create_task(_pump_upstream_run(run_id, upstream_run_id))
    _active_run_tasks[run_id] = task
    # Always enforce API-layer wall timeout as a last-resort guard so UI
    # cannot remain RUNNING forever when upstream startup stalls.
    watchdog_seconds = _run_wall_timeout_seconds(depth)
    _active_run_watchdogs[run_id] = asyncio.create_task(
        _run_watchdog_timeout(run_id, upstream_run_id, watchdog_seconds)
    )

    response_payload: Dict[str, Any] = {"success": True, "run_id": run_id, "status": "started", "ticker": ticker}
    if preempted_run_ids:
        response_payload["preempted_run_ids"] = preempted_run_ids
    if provider_notice:
        response_payload["notice"] = provider_notice
    return response_payload


@router.post("/trading-agents/stop")
async def stop_trading_agents(force_reset: bool = True):
    await _reconcile_local_active_runs_from_sidecar_health()
    if not any(str(run.get("status") or "").lower() in _RUNNING_STATUSES for run in _active_runs.values()):
        with contextlib.suppress(Exception):
            health = await get_upstream_health()
            active_run_id = str((health or {}).get("active_run_id") or "").strip()
            active_status = str((health or {}).get("active_status") or "").strip().lower()
            if active_run_id and active_status == "running":
                await _sync_active_run_from_sidecar(active_run_id)
    stopped_any = False
    stopped_run_ids: List[str] = []
    for run_id, run in list(_active_runs.items()):
        if str(run.get("status") or "").lower() not in {"running", "starting", "retrying", "aborting"}:
            continue
        upstream_meta = _active_upstream_runs.get(run_id) or {}
        upstream_run_id = str(upstream_meta.get("upstream_run_id") or run_id)
        task = _active_run_tasks.get(run_id)
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            stopped_any = True
        sidecar_run: Dict[str, Any] = {}
        try:
            await abort_upstream_run(upstream_run_id)
            stopped_any = True
            with contextlib.suppress(Exception):
                sidecar_run = await get_upstream_run(upstream_run_id)
        except SidecarError as exc:
            logger.warning("Compat sidecar abort failed for %s: %s", run_id, exc)
        record = _run_records.get(run_id)
        if record:
            if sidecar_run:
                _materialize_failed_run(
                    run_id,
                    record,
                    sidecar_run=sidecar_run,
                    failure_event={
                        "type": "run_aborted",
                        "error": "Run aborted by user",
                        "error_message": "Run aborted by user",
                    },
                )
            else:
                record["run_status"] = "ABORTING"
                record["status"] = "aborting"
            _persist_run_record_to_db(run_id, record)
        run["status"] = str((record or {}).get("status") or "aborting")
        stopped_run_ids.append(run_id)
        _active_runs.pop(run_id, None)
        _active_upstream_runs.pop(run_id, None)
        _active_run_tasks.pop(run_id, None)
        watchdog = _active_run_watchdogs.pop(run_id, None)
        if watchdog and not watchdog.done():
            watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await watchdog

    # Cancel/clear any orphan pump tasks that were left without an active run record.
    for orphan_run_id, task in list(_active_run_tasks.items()):
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            stopped_any = True
            stopped_run_ids.append(orphan_run_id)
        _active_run_tasks.pop(orphan_run_id, None)
        watchdog = _active_run_watchdogs.pop(orphan_run_id, None)
        if watchdog and not watchdog.done():
            watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await watchdog
        _active_runs.pop(orphan_run_id, None)
        _active_upstream_runs.pop(orphan_run_id, None)

    if force_reset:
        await _set_idle_pipeline_state(
            status="idle",
            action="Awaiting pipeline activation.",
            clear_run_context=True,
        )

    return {
        "success": True,
        "status": "stopped" if stopped_any else "idle",
        "stopped": stopped_any,
        "stopped_run_ids": stopped_run_ids,
        "message": "Pipeline stopped and live state cleared." if force_reset else "Pipeline stop requested.",
    }


@router.get("/trading-agents/runs")
async def list_trading_agents_runs(limit: int = 20):
    requested_limit = max(1, min(limit, 100))
    _load_run_records_from_db(limit=max(50, requested_limit * 4))
    await _reconcile_local_active_runs_from_sidecar_health()
    if not _run_records:
        _hydrate_run_records_from_artifacts(limit=max(50, requested_limit * 4))
        for persisted_run_id, persisted_row in _run_records.items():
            _persist_run_record_to_db(persisted_run_id, persisted_row)
    rows: List[Dict[str, Any]] = []
    for row in _run_records.values():
        normalized = _overlay_live_pipeline_telemetry(str(row.get("run_id") or ""), row)
        normalized = await _force_fail_if_orphaned_running_row(normalized)
        rows.append(normalized)
    rows = sorted(rows, key=lambda item: item.get("created_at") or "", reverse=True)
    return {"success": True, "runs": rows[:requested_limit]}


@router.get("/trading-agents/runs/latest")
async def latest_trading_agents_run():
    _load_run_records_from_db(limit=300)
    await _reconcile_local_active_runs_from_sidecar_health()
    if not _run_records:
        _hydrate_run_records_from_artifacts(limit=300)
        for persisted_run_id, persisted_row in _run_records.items():
            _persist_run_record_to_db(persisted_run_id, persisted_row)
    if not _run_records:
        return {"success": False, "message": "No runs found."}
    latest = max(_run_records.values(), key=lambda row: row.get("created_at") or "")
    latest = await _force_fail_if_orphaned_running_row(latest)
    latest_run_id = str(latest.get("run_id") or "").strip()
    return _overlay_live_pipeline_telemetry(latest_run_id, latest)


@router.get("/trading-agents/runs/{run_id}")
async def get_trading_agents_run(run_id: str):
    _load_run_records_from_db(limit=500)
    await _reconcile_local_active_runs_from_sidecar_health()
    if run_id not in _run_records:
        row = _load_run_record_from_db(run_id)
        if not row:
            _hydrate_run_records_from_artifacts(limit=1000, force=True)
            hydrated = _run_records.get(run_id)
            if hydrated:
                _persist_run_record_to_db(run_id, hydrated)
    row = _run_records.get(run_id)
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    row = await _force_fail_if_orphaned_running_row(row)
    return _overlay_live_pipeline_telemetry(run_id, row)


@router.post("/trading-agents/runs/{run_id}/approve")
async def ta_only_reject_approve_surface(run_id: str):
    raise _ta_only_not_supported(f"/admin/trading-agents/runs/{run_id}/approve")


@router.post("/trading-agents/runs/{run_id}/reject")
async def ta_only_reject_reject_surface(run_id: str):
    raise _ta_only_not_supported(f"/admin/trading-agents/runs/{run_id}/reject")


@router.get("/pipeline_scenes")
async def get_pipeline_scenes():
    raise _ta_only_not_supported("/admin/pipeline_scenes")


@router.post("/pipeline_scenes")
async def save_pipeline_scenes(request: Request):
    raise _ta_only_not_supported("/admin/pipeline_scenes")


@router.post("/scene_command")
async def broadcast_scene_command(request: Request):
    raise _ta_only_not_supported("/admin/scene_command")


def _ta_only_not_supported(endpoint: str) -> HTTPException:
    return HTTPException(
        status_code=501,
        detail={
            "message": f"{endpoint} is not supported in TA-only strict runtime.",
            "supported_surfaces": ["Trade", "History Runs", "Final Reports"],
            "code": "TA_ONLY_NOT_SUPPORTED",
        },
    )


@router.api_route("/autopilot/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def ta_only_autopilot_not_supported(path: str):
    raise _ta_only_not_supported(f"/admin/autopilot/{path}")


@router.api_route("/queue/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def ta_only_queue_not_supported(path: str):
    raise _ta_only_not_supported(f"/admin/queue/{path}")


@router.api_route("/manual-trade/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def ta_only_manual_trade_not_supported(path: str):
    raise _ta_only_not_supported(f"/admin/manual-trade/{path}")
