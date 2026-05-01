"""
Admin Routes - God Mode Control Panel

Endpoints for the admin dashboard to control:
1. Autopilot ON/OFF toggle
2. Queue management (delete, bump, inject)
3. Manual trade override (BUY/SELL)
4. Whale veto (cancel pending whale analysis)
5. Portfolio management
"""

import httpx
import logging
import asyncio
import json
import os
import re
import time
import uuid
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from src.llm.client import get_llm_client
from src.runtime.queue import ticker_queue
from src.runtime.redis_client import init_redis
import src.runtime.redis_client as rc
from src.runtime.runtime_flags import is_shutting_down
from src.runtime.runtime_queue_state import (
    get_queue_cooldown as redis_get_queue_cooldown,
    set_queue_cooldown as redis_set_queue_cooldown,
    clear_queue_cooldown as redis_clear_queue_cooldown,
    get_currently_grilling as redis_get_currently_grilling,
    set_currently_grilling as redis_set_currently_grilling,
    get_active_prediction as redis_get_active_prediction,
    set_active_prediction as redis_set_active_prediction,
    upsert_pending_whale_trade,
    get_pending_whale_trade,
    remove_pending_whale_trade,
)
from src.integrations.tradingagents_runtime import (
    build_tradingagents_run_id,
    clear_abort_request,
    clear_active_run,
    get_abort_request,
    is_abort_requested,
    load_active_run,
    request_abort,
    set_active_run,
    update_active_run,
)
from src.integrations.tradingagents_roster import (
    TRADINGAGENTS_CANONICAL_AGENTS,
    TRADINGAGENTS_PHASE_NUMBERS,
    normalize_tradingagents_agent_id,
    normalize_tradingagents_agent_name,
)
from src.integrations.tradingagents_upstream_sidecar import (
    SidecarError,
    abort_run as abort_upstream_run,
    get_artifacts as get_upstream_artifacts,
    get_run as get_upstream_run,
    start_run as start_upstream_run,
    stream_events as stream_upstream_events,
)
from src.runtime.tradingagents_decision_service import (
    SceneDialogueError,
    TRADINGAGENTS_CANONICAL_REPORT_SLOTS,
    TRADINGAGENTS_NVIDIA_SCENE_WRITER_MODELS,
    _safe_int,
    get_tradingagents_nvidia_scene_model_health,
    get_tradingagents_decision_service,
)
from src.runtime.sentiment_engine import engine
from src.runtime.automation import autonomous_trader

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])

# Track vetoed trades
_vetoed_trades: List[Dict[str, Any]] = []

# ═══════════════════════════════════════════════════════════════════════════
# COOLDOWN SYSTEM
# ═══════════════════════════════════════════════════════════════════════════

# Cooldown state - backend is source of truth
COOLDOWN_SECONDS = 60

_TA_TIMELINE_SCENE_PATTERN = re.compile(r"^TA_TIMELINE_(\d{2})_[A-Z0-9_]+$")
_TA_VALID_STATIONS: Set[str] = {
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
_TA_VALID_PATHS: Set[str] = {"direct", "detour", "loop", "idle"}
_TA_AGENT_NAMES: List[str] = [
    str(agent.get("display_name") or "").strip()
    for agent in TRADINGAGENTS_CANONICAL_AGENTS
    if str(agent.get("display_name") or "").strip()
]
_TA_AGENT_NAME_SET: Set[str] = set(_TA_AGENT_NAMES)
_TA_AGENT_STATION_DEFAULTS: Dict[str, str] = {
    str(agent.get("display_name") or "").strip(): str(agent.get("station") or "desk").strip().lower()
    for agent in TRADINGAGENTS_CANONICAL_AGENTS
    if str(agent.get("display_name") or "").strip()
}


def _is_ta_timeline_scene_key(key: Any) -> bool:
    return isinstance(key, str) and bool(_TA_TIMELINE_SCENE_PATTERN.match(key.strip()))


def _ta_timeline_phase_key(scene_key: str) -> str:
    match = _TA_TIMELINE_SCENE_PATTERN.match(str(scene_key or "").strip())
    if not match:
        return "STEP_1_ANALYSTS"
    index = _safe_int(match.group(1), 0)
    if index <= 4:
        return "STEP_1_ANALYSTS"
    if index <= 7:
        return "STEP_2_RESEARCH"
    if index == 8:
        return "STEP_3_TRADER"
    if index <= 11:
        return "STEP_4_RISK"
    return "STEP_5_PORTFOLIO"


def _clean_ta_station(value: Any, fallback: str = "desk") -> str:
    candidate = str(value or "").strip().lower()
    if candidate in _TA_VALID_STATIONS:
        return candidate
    normalized_fallback = str(fallback or "desk").strip().lower()
    return normalized_fallback if normalized_fallback in _TA_VALID_STATIONS else "desk"


def _clean_ta_path(value: Any, fallback: str = "direct") -> str:
    candidate = str(value or "").strip().lower()
    if candidate in _TA_VALID_PATHS:
        return candidate
    normalized_fallback = str(fallback or "direct").strip().lower()
    return normalized_fallback if normalized_fallback in _TA_VALID_PATHS else "direct"


def _clean_ta_animation(value: Any, fallback: str = "idle") -> str:
    candidate = str(value or "").strip()
    if candidate:
        return candidate
    normalized_fallback = str(fallback or "idle").strip()
    return normalized_fallback or "idle"


def _normalize_ta_scene_agents(raw_agents: Any, fallback_agents: Optional[List[str]] = None) -> List[str]:
    seen: Set[str] = set()
    ordered: List[str] = []
    if isinstance(raw_agents, list):
        for value in raw_agents:
            canonical = normalize_tradingagents_agent_name(value)
            if canonical and canonical in _TA_AGENT_NAME_SET and canonical not in seen:
                seen.add(canonical)
                ordered.append(canonical)
    if ordered:
        return ordered
    if isinstance(fallback_agents, list):
        for value in fallback_agents:
            canonical = normalize_tradingagents_agent_name(value)
            if canonical and canonical in _TA_AGENT_NAME_SET and canonical not in seen:
                seen.add(canonical)
                ordered.append(canonical)
    return ordered


def _normalize_ta_scene_value_map(raw_map: Any, clean_key_fn) -> Dict[str, str]:
    normalized: Dict[str, str] = {}
    if not isinstance(raw_map, dict):
        return normalized
    for raw_agent, raw_value in raw_map.items():
        if raw_agent == "default":
            cleaned = clean_key_fn(raw_value)
            if cleaned:
                normalized["default"] = cleaned
            continue
        canonical = normalize_tradingagents_agent_name(raw_agent)
        if not canonical or canonical not in _TA_AGENT_NAME_SET:
            continue
        cleaned = clean_key_fn(raw_value)
        if cleaned:
            normalized[canonical] = cleaned
    return normalized


def _normalize_ta_timeline_scene_config(raw_scene: Any, phase_scene: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    scene = raw_scene if isinstance(raw_scene, dict) else {}
    phase_cfg = phase_scene if isinstance(phase_scene, dict) else {}
    allow_empty_agents = scene.get("__allow_empty_agents") is True

    phase_agents = _normalize_ta_scene_agents(phase_cfg.get("agents"), _TA_AGENT_NAMES)
    phase_stations = _normalize_ta_scene_value_map(
        phase_cfg.get("stations"),
        lambda value: _clean_ta_station(value, "desk"),
    )
    phase_animations = _normalize_ta_scene_value_map(
        phase_cfg.get("animations"),
        lambda value: _clean_ta_animation(value, "idle"),
    )
    phase_paths = _normalize_ta_scene_value_map(
        phase_cfg.get("paths"),
        lambda value: _clean_ta_path(value, "direct"),
    )

    station_values = _normalize_ta_scene_value_map(
        scene.get("stations"),
        lambda value: _clean_ta_station(value, "desk"),
    )
    animation_values = _normalize_ta_scene_value_map(
        scene.get("animations"),
        lambda value: _clean_ta_animation(value, "idle"),
    )
    path_values = _normalize_ta_scene_value_map(
        scene.get("paths"),
        lambda value: _clean_ta_path(value, "direct"),
    )

    map_agents = [
        agent
        for agent in _TA_AGENT_NAMES
        if agent in station_values or agent in animation_values or agent in path_values
    ]
    if allow_empty_agents and isinstance(scene.get("agents"), list) and len(scene.get("agents") or []) == 0:
        selected_agents = []
    else:
        selected_agents = _normalize_ta_scene_agents(scene.get("agents"), map_agents or phase_agents or _TA_AGENT_NAMES)
    has_structured_values = bool(station_values or animation_values or path_values)
    if not selected_agents and has_structured_values:
        selected_agents = map_agents
    if not selected_agents and not allow_empty_agents:
        selected_agents = phase_agents or list(_TA_AGENT_NAMES)

    fallback_location = _clean_ta_station(phase_cfg.get("location"), "desk")
    location = _clean_ta_station(scene.get("location"), fallback_location)
    station_override_agents = _normalize_ta_scene_agents(scene.get("__station_overrides"))

    stations: Dict[str, str] = {}
    animations: Dict[str, str] = {}
    paths: Dict[str, str] = {}

    for agent_name in selected_agents:
        canonical_station = _clean_ta_station(_TA_AGENT_STATION_DEFAULTS.get(agent_name), "desk")
        inherited_station = _clean_ta_station(
            location,
            _clean_ta_station(
                station_values.get("default"),
                _clean_ta_station(
                    phase_stations.get(agent_name),
                    _clean_ta_station(phase_stations.get("default"), canonical_station),
                ),
            ),
        )
        if agent_name in station_override_agents:
            stations[agent_name] = _clean_ta_station(
                station_values.get(agent_name),
                inherited_station,
            )
        else:
            stations[agent_name] = inherited_station
        animations[agent_name] = _clean_ta_animation(
            animation_values.get(agent_name),
            _clean_ta_animation(
                animation_values.get("default"),
                _clean_ta_animation(
                    phase_animations.get(agent_name),
                    _clean_ta_animation(phase_animations.get("default"), "idle"),
                ),
            ),
        )
        paths[agent_name] = _clean_ta_path(
            path_values.get(agent_name),
            _clean_ta_path(
                path_values.get("default"),
                _clean_ta_path(
                    phase_paths.get(agent_name),
                    _clean_ta_path(phase_paths.get("default"), "direct"),
                ),
            ),
        )

    return {
        "location": location,
        "agents": selected_agents,
        "animations": animations,
        "stations": stations,
        "paths": paths,
        "__station_overrides": station_override_agents,
        "__explicit": bool(scene.get("__explicit", True)),
        "__allow_empty_agents": allow_empty_agents,
    }


def _sanitize_pipeline_scenes_config(raw_config: Any) -> Dict[str, Any]:
    if not isinstance(raw_config, dict):
        return {}

    sanitized: Dict[str, Any] = dict(raw_config)
    for key, value in list(sanitized.items()):
        if not _is_ta_timeline_scene_key(key):
            continue
        phase_key = _ta_timeline_phase_key(key)
        phase_override = sanitized.get(phase_key) if isinstance(sanitized.get(phase_key), dict) else {}
        sanitized[key] = _normalize_ta_timeline_scene_config(value, phase_override)
    return sanitized


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


TRADINGAGENTS_OLLAMA_DEFAULT_QUICK = "locooperator-4b-tools:latest"
TRADINGAGENTS_OLLAMA_DEFAULT_DEEP = "mn-12b-magmell-tools:latest"
TRADINGAGENTS_OLLAMA_FALLBACK_MODELS: List[Dict[str, str]] = [
    {"id": TRADINGAGENTS_OLLAMA_DEFAULT_QUICK, "name": "LocoOperator 4B Tools"},
    {"id": TRADINGAGENTS_OLLAMA_DEFAULT_DEEP, "name": "MN 12B Magmell Tools"},
]


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
    first = report_ids[0] if report_ids else (ids[0] if ids else TRADINGAGENTS_OLLAMA_DEFAULT_QUICK)
    quick = TRADINGAGENTS_OLLAMA_DEFAULT_QUICK if TRADINGAGENTS_OLLAMA_DEFAULT_QUICK in ids else first
    deep = TRADINGAGENTS_OLLAMA_DEFAULT_DEEP if TRADINGAGENTS_OLLAMA_DEFAULT_DEEP in ids else first
    return {"quick": quick, "deep": deep}


TRADINGAGENTS_NVIDIA_MODELS: List[Dict[str, str]] = [
    {"id": "stockmark/stockmark-2-100b-instruct", "name": "Stockmark 2 100B Instruct"},
    {"id": "minimaxai/minimax-m2.7", "name": "Minimax M2.7"},
    {"id": "qwen/qwen3-next-80b-a3b-instruct", "name": "Qwen3 Next 80B A3B Instruct"},
    {"id": "openai/gpt-oss-120b", "name": "GPT-OSS 120B"},
    {"id": "nvidia/nemotron-3-super-120b-a12b", "name": "NVIDIA Nemotron 3 Super 120B A12B"},
    {"id": "mistralai/mistral-large-3-675b-instruct-2512", "name": "Mistral Large 3 675B Instruct"},
]

# Keep this list aligned with TradingAgents-original nvidia model_catalog.
TRADINGAGENTS_NVIDIA_UPSTREAM_SAFE_MODELS = {
    "stockmark/stockmark-2-100b-instruct",
    "qwen/qwen3-next-80b-a3b-instruct",
    "nvidia/nemotron-3-super-120b-a12b",
}

TRADINGAGENTS_PROVIDER_MODEL_PRESETS: Dict[str, Dict[str, Any]] = {
    "nvidia": {
        "default_quick_model": "stockmark/stockmark-2-100b-instruct",
        "default_deep_model": "mistralai/mistral-large-3-675b-instruct-2512",
        "models": TRADINGAGENTS_NVIDIA_MODELS,
    },
    "ollama": {
        "default_quick_model": TRADINGAGENTS_OLLAMA_DEFAULT_QUICK,
        "default_deep_model": TRADINGAGENTS_OLLAMA_DEFAULT_DEEP,
        "models": TRADINGAGENTS_OLLAMA_FALLBACK_MODELS,
    },
    "openai": {
        "default_quick_model": "gpt-4o-mini",
        "default_deep_model": "gpt-4o",
        "models": [
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini"},
            {"id": "gpt-4o", "name": "GPT-4o"},
            {"id": "gpt-4.1", "name": "GPT-4.1"},
            {"id": "gpt-5.4-mini", "name": "GPT-5.4 Mini"},
            {"id": "gpt-5.4", "name": "GPT-5.4"},
        ],
    },
    "anthropic": {
        "default_quick_model": "claude-sonnet-4-6",
        "default_deep_model": "claude-opus-4-6",
        "models": [
            {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5"},
            {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6"},
            {"id": "claude-opus-4-6", "name": "Claude Opus 4.6"},
        ],
    },
    "google": {
        "default_quick_model": "gemini-2.5-flash",
        "default_deep_model": "gemini-3.1-pro-preview",
        "models": [
            {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash"},
            {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro"},
            {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash Preview"},
            {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro Preview"},
        ],
    },
    "xai": {
        "default_quick_model": "grok-4-1-fast-non-reasoning",
        "default_deep_model": "grok-4-0709",
        "models": [
            {"id": "grok-4-1-fast-non-reasoning", "name": "Grok 4.1 Fast (Non-Reasoning)"},
            {"id": "grok-4-1-fast-reasoning", "name": "Grok 4.1 Fast (Reasoning)"},
            {"id": "grok-4-0709", "name": "Grok 4"},
        ],
    },
    "openrouter": {
        "default_quick_model": "nvidia/nemotron-3-nano-30b-a3b:free",
        "default_deep_model": "z-ai/glm-4.5-air:free",
        "models": [
            {"id": "nvidia/nemotron-3-nano-30b-a3b:free", "name": "NVIDIA Nemotron 3 Nano 30B (free)"},
            {"id": "z-ai/glm-4.5-air:free", "name": "Z.AI GLM 4.5 Air (free)"},
        ],
    },
}


def _get_provider_model_map(provider: str) -> Dict[str, str]:
    preset = TRADINGAGENTS_PROVIDER_MODEL_PRESETS.get(str(provider or "").strip().lower(), {})
    models = preset.get("models", [])
    return {
        str(model.get("id") or "").strip(): str(model.get("name") or model.get("id") or "").strip()
        for model in models
        if str(model.get("id") or "").strip()
    }


def _validate_tradingagents_model_selection(provider: str, quick_model: str, deep_model: str) -> None:
    provider_key = str(provider or "").strip().lower()
    if provider_key != "nvidia":
        return

    model_map = _get_provider_model_map(provider_key)
    if not model_map:
        raise HTTPException(status_code=400, detail="NVIDIA TradingAgents models are not configured.")

    invalid: List[str] = []
    if quick_model and quick_model not in model_map:
        invalid.append(f"quickModel={quick_model}")
    if deep_model and deep_model not in model_map:
        invalid.append(f"deepModel={deep_model}")

    if not invalid:
        return

    supported = ", ".join(model_map.values())
    raise HTTPException(
        status_code=400,
        detail=(
            "Unsupported NVIDIA TradingAgents model selection: "
            + ", ".join(invalid)
            + ". Removed models cannot run this tool-driven pipeline. "
            + f"Use one of the curated NVIDIA models: {supported}."
        ),
    )


def _coerce_upstream_compatible_models(provider: str, quick_model: str, deep_model: str) -> tuple[str, str]:
    provider_key = str(provider or "").strip().lower()
    if provider_key != "nvidia":
        return quick_model, deep_model
    quick = str(quick_model or "").strip()
    deep = str(deep_model or "").strip()
    quick_ok = quick in TRADINGAGENTS_NVIDIA_UPSTREAM_SAFE_MODELS
    deep_ok = deep in TRADINGAGENTS_NVIDIA_UPSTREAM_SAFE_MODELS
    if quick_ok and deep_ok:
        return quick, deep
    fallback_quick = "stockmark/stockmark-2-100b-instruct"
    fallback_deep = "qwen/qwen3-next-80b-a3b-instruct"
    logger.warning(
        "[TA-RUN] Coercing NVIDIA models to upstream-safe pair: quick=%s deep=%s (requested quick=%s deep=%s)",
        fallback_quick,
        fallback_deep,
        quick,
        deep,
    )
    return fallback_quick, fallback_deep


# ═══════════════════════════════════════════════════════════════════════════
@router.get("/")
async def admin_index():
    """Admin root index to avoid 404."""
    return {
        "title": "AI Hedge Fund - Admin API",
        "status": "active",
        "endpoints": ["/autopilot/status", "/trading-agents/runs"]
    }

@router.get("/autopilot/status")
async def get_autopilot_status():
    """Get theatrical autopilot status."""
    from src.theatrical_autopilot import is_autopilot_running
    return {
        "running": is_autopilot_running(),
        "mode": "theatrical",
        "description": "Gossip-only 24/7 loop (no trading)",
    }


@router.post("/autopilot/start")
async def start_autopilot():
    """Start the theatrical autopilot."""
    from src.theatrical_autopilot import start_autopilot, is_autopilot_running
    
    if is_autopilot_running():
        return {"success": True, "status": "already_running"}
    
    asyncio.create_task(start_autopilot())
    
    await _broadcast_admin_event({
        "type": "autopilot_started",
        "timestamp": datetime.now().isoformat(),
    })
    
    return {"success": True, "status": "started"}


@router.post("/autopilot/stop")
async def stop_autopilot():
    """Stop the theatrical autopilot."""
    from src.theatrical_autopilot import stop_autopilot, is_autopilot_running
    
    if not is_autopilot_running():
        return {"success": True, "status": "already_stopped"}
    
    stop_autopilot()
    
    await _broadcast_admin_event({
        "type": "autopilot_stopped",
        "timestamp": datetime.now().isoformat(),
    })
    
    return {"success": True, "status": "stopped"}


# ═══════════════════════════════════════════════════════════════════════════
# TRADING AGENTS (AUTO) CONTROL
# ═══════════════════════════════════════════════════════════════════════════

# Global task tracking for manual TradingAgents runs
_active_ta_sidecar_run_id: Optional[str] = None
_active_ta_task: Optional[asyncio.Task] = None

_TA_ALLOWED_ANIMATIONS = (
    "talk",
    "read",
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
)
_TA_ALLOWED_PATHS = ("direct", "detour", "loop", "idle")
_TA_PHASE_ACTIVE_STATIONS = {
    "STEP_1_ANALYSTS": {
        "Market Analyst": "scanner",
        "Social Analyst": "cooler",
        "News Analyst": "newsstand",
        "Fundamentals Analyst": "desk",
    },
    "STEP_2_RESEARCH": {
        "Bull Researcher": "table",
        "Bear Researcher": "table",
        "Research Manager": "center",
    },
    "STEP_3_TRADER": {
        "Trader": "ticker",
    },
    "STEP_4_RISK": {
        "Aggressive Analyst": "tv",
        "Conservative Analyst": "tv",
        "Neutral Analyst": "tv",
    },
    "STEP_5_PORTFOLIO": {
        "Risk Judge": "ticker",
    },
}

_QUALITY_DRAFT_PATTERNS = [
    r"\bnow\s+that\s+i\s+have\b",
    r"\bi\s+see\s+you(?:['’]ve|\s+have)\s+provided\b",
    r"\blet\s+me\s+consolidate\b",
    r"\blet\s+me\s+gather\b",
    r"\blet\s+me\s+check\b",
    r"\blet\s+me\s+fetch\b",
    r"\blet\s+me\s+retrieve\b",
    r"\blet\s+me\s+get\b",
    r"\blet\s+me\s+search\b",
    r"\blet\s+me\s+look\b",
    r"\blet\s+me\s+verify\b",
    r"\blet\s+me\s+proceed\b",
    r"\blet\s+me\s+continue\b",
    r"\blet\s+me\s+adjust\b",
    r"\bi(?:'|’)ll\s+now\b",
    r"\bi(?:'|’)ll\s+check\b",
    r"\bi(?:'|’)ll\s+fetch\b",
    r"\bi(?:'|’)ll\s+retrieve\b",
    r"\bi(?:'|’)ll\s+gather\b",
    r"\bi(?:'|’)ll\s+search\b",
    r"\bi(?:'|’)ll\s+look\b",
    r"\bi(?:'|’)ll\s+verify\b",
    r"\bi(?:'|’)ll\s+use\s+the\b",
    r"\bi(?:'|’)ll\s+try\b",
    r"\bi(?:'|’)ll\s+analy[sz]e\b",
    r"\bi\s+will\s+(?:now\s+)?(?:check|fetch|retrieve|gather|search|look|verify|execute|retry|analy[sz]e)\b",
    r"\blet\s+me\s+start\s+with\s+retrieving\b",
    r"\blet\s+me\s+refine\s+the\s+query\b",
    r"\blet\s+me\s+retry\b",
    r"\blet\s+me\s+try\b",
    r"\bthe\s+error\s+seems\s+to\s+be\s+related\s+to\b",
    r"\bit\s+appears\s+that\s+no\s+financial\s+statement\s+data\s+is\s+available\b",
    r"\bi\s+will\s+execute\s+the\s+required\s+tool\s+call\s+first\b",
]
_QUALITY_TOOL_PATTERN = re.compile(
    r"<tool_call>|</tool_call>|[\"'](?:name|parameters|arguments|args)[\"']\s*:",
    re.IGNORECASE,
)
_QUALITY_FINAL_MARKER_PATTERN = re.compile(
    r"\b(final\s+(?:recommendation|transaction\s+proposal|decision)|executive\s+brief)\b",
    re.IGNORECASE,
)


def _looks_like_quality_draft_scaffold(text: str) -> bool:
    value = str(text or "")
    if not value:
        return False
    intro = value[:420]
    sentence_count = len(re.findall(r"[.!?]", value))
    has_structural_markers = bool(
        re.search(r"\n\s*(?:[-*•]|\d+\.)\s+", value)
        or re.search(r"^#{1,6}\s+", value, re.MULTILINE)
        or re.search(r"\n\s*\|.+\|", value)
    )
    is_substantive = (
        len(value) >= 900
        or sentence_count >= 9
        or (len(value) >= 520 and sentence_count >= 5 and has_structural_markers)
    )
    if is_substantive and _QUALITY_FINAL_MARKER_PATTERN.search(value):
        return False
    for pattern in _QUALITY_DRAFT_PATTERNS:
        if re.search(pattern, intro, re.IGNORECASE):
            return not is_substantive
    return False


async def shutdown_active_trading_agents() -> None:
    """Best-effort cancellation for active TradingAgents work during app shutdown."""
    global _active_ta_sidecar_run_id, _active_ta_task

    try:
        active_run = load_active_run()
        if active_run and active_run.get("run_id"):
            request_abort(active_run["run_id"], reason="shutdown", source="app_shutdown")
            update_active_run(active_run["run_id"], status="aborting")
    except Exception:
        pass

    active_ids = []
    if _active_ta_sidecar_run_id:
        active_ids.append(_active_ta_sidecar_run_id)
    active_run = load_active_run()
    if active_run and active_run.get("run_id"):
        active_ids.append(active_run.get("run_id"))
    for upstream_run_id in {rid for rid in active_ids if rid}:
        with suppress(Exception):
            await abort_upstream_run(upstream_run_id)

    if _active_ta_task and not _active_ta_task.done():
        _active_ta_task.cancel()

    try:
        autonomous_trader.abort_current_run()
    except Exception:
        pass

    autonomous_trader.is_analyzing = False
    if autonomous_trader._active_task is _active_ta_task:
        autonomous_trader._active_task = None
    _active_ta_sidecar_run_id = None


def _clean_report_excerpt(text: Any, limit: int = 260) -> str:
    cleaned = " ".join(str(text or "").split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3].rstrip() + "..."


def _is_valid_report_quality(text: Any) -> bool:
    raw = str(text or "").strip()
    if not raw:
        return False
    if _QUALITY_TOOL_PATTERN.search(raw):
        return False
    cleaned = re.sub(r"```[\s\S]*?```", "\n", raw)
    cleaned = re.sub(r"<tool_call>[\s\S]*?<\/tool_call>", "\n", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\{\s*\"name\"\s*:[\s\S]*?\}", "\n", cleaned)
    cleaned = re.sub(r"\{\s*\"parameters\"\s*:[\s\S]*?\}", "\n", cleaned)
    cleaned = re.sub(r"\{\s*\"arguments\"\s*:[\s\S]*?\}", "\n", cleaned)
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    if not cleaned:
        return False
    if _looks_like_quality_draft_scaffold(cleaned):
        return False
    sentence_count = len(re.findall(r"[.!?]", cleaned))
    line_breaks = cleaned.count("\n")
    has_structure = (
        len(cleaned) >= 400
        or sentence_count >= 4
        or bool(re.search(r"\n\s*(?:[-*•]|\d+\.)\s+", cleaned))
        or bool(re.search(r"^#{1,6}\s+", cleaned, re.MULTILINE))
    )
    if len(cleaned) < 120 and not has_structure and line_breaks < 2 and sentence_count < 2:
        return False
    return True


def _trim_dialogue_text(text: Any, limit: int = 180) -> str:
    cleaned = " ".join(str(text or "").split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3].rstrip() + "..."


def _normalize_scene_animation(value: Any, fallback: str = "idle") -> str:
    normalized = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if normalized == "think":
        normalized = "idle"
    if normalized in _TA_ALLOWED_ANIMATIONS:
        return normalized
    fallback_normalized = str(fallback or "idle").strip().lower().replace("-", "_").replace(" ", "_")
    if fallback_normalized == "think":
        fallback_normalized = "idle"
    return fallback_normalized if fallback_normalized in _TA_ALLOWED_ANIMATIONS else "idle"


def _normalize_scene_path(value: Any, fallback: str = "direct") -> str:
    normalized = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in _TA_ALLOWED_PATHS:
        return normalized
    fallback_normalized = str(fallback or "direct").strip().lower().replace("-", "_").replace(" ", "_")
    return fallback_normalized if fallback_normalized in _TA_ALLOWED_PATHS else "direct"


def _normalize_scene_perform(value: Any, fallback: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes"}:
            return True
        if lowered in {"false", "0", "no"}:
            return False
    return bool(fallback)


def _resolve_scene_station_map(
    scene_key: str,
    behavior_defaults: Dict[str, Dict[str, Any]],
) -> Dict[str, str]:
    phase_stations = _TA_PHASE_ACTIVE_STATIONS.get((scene_key or "").upper(), {})
    station_map: Dict[str, str] = {}
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_name = agent["display_name"]
        behavior = behavior_defaults.get(agent["id"], {})
        station_map[agent_name] = (
            phase_stations.get(agent_name)
            or behavior.get("default_station")
            or agent.get("station")
            or "desk"
        )
    return station_map


def _fallback_background_profiles(
    scene_key: str,
    behavior_defaults: Dict[str, Dict[str, Any]],
    decision_service: Any,
) -> Dict[str, Dict[str, Any]]:
    speaking_agents = set(_TA_PHASE_ACTIVE_STATIONS.get((scene_key or "").upper(), {}).keys())
    profiles: Dict[str, Dict[str, Any]] = {}
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_name = agent["display_name"]
        behavior = behavior_defaults.get(agent["id"], {})
        default_animation = _normalize_scene_animation(behavior.get("default_animation"), "idle")
        default_path = _normalize_scene_path(behavior.get("default_path"), "direct")
        animation = default_animation
        path = default_path

        with suppress(Exception):
            animation = _normalize_scene_animation(
                decision_service._scene_agent_animation(scene_key, agent_name, "SUCCESS", speaking_agents),
                default_animation,
            )
        with suppress(Exception):
            path = _normalize_scene_path(
                decision_service._scene_agent_path(scene_key, agent_name, "SUCCESS"),
                default_path,
            )

        profiles[agent_name] = {
            "animation": animation,
            "path": path,
            "perform": animation != "idle" or path != "idle",
        }
    return profiles


def _fallback_phase_dialogue_lines(
    scene_key: str,
    ticker: Optional[str],
    latest_reports: Dict[str, str],
    phase_context: str,
    decision_service: Any,
) -> List[Dict[str, Any]]:
    active_agents = list(_TA_PHASE_ACTIVE_STATIONS.get((scene_key or "").upper(), {}).keys())
    lines: List[Dict[str, Any]] = []
    for agent_name in active_agents:
        report_excerpt = (
            latest_reports.get(agent_name)
            or latest_reports.get(normalize_tradingagents_agent_id(agent_name) or "")
            or phase_context
        )
        fallback_action = "HOLD"
        with suppress(Exception):
            fallback_action = decision_service._action_from_text(report_excerpt, "HOLD")
        dialogue = ""
        with suppress(Exception):
            dialogue = decision_service._fallback_agent_summary(agent_name, ticker or "this ticker", fallback_action)
        if not dialogue:
            dialogue = report_excerpt or f"{agent_name} is working the {scene_key.lower()} report."
        lines.append({
            "agent": agent_name,
            "text": _trim_dialogue_text(dialogue),
            "timestamp": datetime.now().isoformat(),
        })
    return lines


def _fallback_foreground_summary(
    agent_name: str,
    ticker: Optional[str],
    report_excerpt: str,
    scene_key: str,
    behavior_defaults: Dict[str, Dict[str, Any]],
    decision_service: Any,
    background_profile: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    agent_id = normalize_tradingagents_agent_id(agent_name)
    behavior = behavior_defaults.get(agent_id or "", {})
    default_animation = _normalize_scene_animation(behavior.get("default_animation"), "idle")
    default_path = _normalize_scene_path(behavior.get("default_path"), "direct")
    fallback_action = "HOLD"
    with suppress(Exception):
        fallback_action = decision_service._action_from_text(report_excerpt, "HOLD")
    dialogue = ""
    with suppress(Exception):
        dialogue = decision_service._fallback_agent_summary(agent_name, ticker or "this ticker", fallback_action)
    if not dialogue:
        dialogue = report_excerpt or f"{agent_name} completed analysis for {ticker or 'this ticker'}."
    return {
        "dialogue": _trim_dialogue_text(dialogue),
        "animation": _normalize_scene_animation(
            (background_profile or {}).get("animation"),
            default_animation,
        ),
        "path": _normalize_scene_path(
            (background_profile or {}).get("path"),
            default_path,
        ),
        "perform": True,
    }


async def _infer_phase_background_profiles(
    *,
    scene_key: str,
    ticker: Optional[str],
    station_map: Dict[str, str],
    behavior_defaults: Dict[str, Dict[str, Any]],
    latest_reports: Dict[str, str],
    provider: Optional[str],
    model: Optional[str],
    phase_context: str,
    decision_service: Any,
) -> tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    fallback_profiles = _fallback_background_profiles(scene_key, behavior_defaults, decision_service)
    fallback_dialogue_lines = _fallback_phase_dialogue_lines(
        scene_key,
        ticker,
        latest_reports,
        phase_context,
        decision_service,
    )
    agent_lines = []
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_name = agent["display_name"]
        behavior = behavior_defaults.get(agent["id"], {})
        latest_report = _clean_report_excerpt(
            latest_reports.get(agent_name) or latest_reports.get(agent["id"])
        )
        agent_lines.append(
            "\n".join(
                [
                    f"- agent: {agent_name}",
                    f"  personality: {behavior.get('personality') or agent.get('personality') or 'None'}",
                    f"  station: {station_map.get(agent_name, agent.get('station', 'desk'))}",
                    f"  latest_context: {latest_report or phase_context}",
                ]
            )
        )

    prompt = (
        f"Generate background choreography for a live trading floor scene.\n"
        f"Ticker: {ticker or 'UNKNOWN'}\n"
        f"Phase: {scene_key}\n"
        "Return JSON with two keys:\n"
        '"profiles": object keyed by agent display name for all 12 agents.\n'
        '"dialogue": array of {agent, text} for ACTIVE agents in this phase only.\n'
        "Each profile value must be an object with exactly these keys:\n"
        '{ "animation": "talk|read|point|argue|sit_type|sit_back|idle|buy|sell|cheer|facepalm|hodl|rekt|copium",'
        ' "path": "direct|detour|loop|idle", "perform": true }\n'
        "Rules:\n"
        "- No dialogue field.\n"
        "- Do not change stations.\n"
        "- Use only the allowed animation/path values.\n"
        "- Dialogue lines are only for phase-active agents.\n"
        "- This is ambient background behavior for the whole phase.\n\n"
        f"Agents:\n{chr(10).join(agent_lines)}"
    )

    try:
        llm = get_llm_client()
        result = await asyncio.wait_for(
            llm.generate_json(
                prompt=prompt,
                system_prompt="You are a trading floor showrunner. Return JSON only.",
                provider=provider,
                model=model,
            ),
            timeout=12,
        )
        profiles_blob = None
        dialogue_blob = None
        if isinstance(result, dict):
            if isinstance(result.get("profiles"), dict):
                profiles_blob = result.get("profiles")
            else:
                profiles_blob = result
            if isinstance(result.get("dialogue"), list):
                dialogue_blob = result.get("dialogue")
        if not isinstance(profiles_blob, dict):
            return fallback_profiles, fallback_dialogue_lines

        profiles: Dict[str, Dict[str, Any]] = {}
        for agent in TRADINGAGENTS_CANONICAL_AGENTS:
            agent_name = agent["display_name"]
            raw = (
                profiles_blob.get(agent_name)
                or profiles_blob.get(agent["id"])
                or {}
            )
            fallback = fallback_profiles[agent_name]
            profiles[agent_name] = {
                "animation": _normalize_scene_animation(raw.get("animation"), fallback["animation"]),
                "path": _normalize_scene_path(raw.get("path"), fallback["path"]),
                "perform": _normalize_scene_perform(raw.get("perform"), fallback["perform"]),
            }
        active_agents = set(_TA_PHASE_ACTIVE_STATIONS.get((scene_key or "").upper(), {}).keys())
        dialogue_lines: List[Dict[str, Any]] = []
        if isinstance(dialogue_blob, list):
            for line in dialogue_blob:
                if not isinstance(line, dict):
                    continue
                agent_name = normalize_tradingagents_agent_name(line.get("agent")) or line.get("agent")
                if agent_name not in active_agents:
                    continue
                text = _trim_dialogue_text(line.get("text"))
                if not agent_name or not text:
                    continue
                dialogue_lines.append({
                    "agent": agent_name,
                    "text": text,
                    "timestamp": datetime.now().isoformat(),
                })
        if not dialogue_lines:
            dialogue_lines = fallback_dialogue_lines
        return profiles, dialogue_lines
    except Exception as exc:
        logger.warning("[TA-RUN] Background scene inference failed for %s: %s", scene_key, exc)
        return fallback_profiles, fallback_dialogue_lines


async def _infer_foreground_agent_summary(
    *,
    agent_name: str,
    ticker: Optional[str],
    scene_key: str,
    station: str,
    personality: Optional[str],
    report_excerpt: str,
    provider: Optional[str],
    model: Optional[str],
    behavior_defaults: Dict[str, Dict[str, Any]],
    decision_service: Any,
    background_profile: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    fallback = _fallback_foreground_summary(
        agent_name=agent_name,
        ticker=ticker,
        report_excerpt=report_excerpt,
        scene_key=scene_key,
        behavior_defaults=behavior_defaults,
        decision_service=decision_service,
        background_profile=background_profile,
    )
    if not report_excerpt:
        return fallback

    prompt = (
        f"Generate the current foreground beat for {agent_name} in a live trading floor scene.\n"
        f"Ticker: {ticker or 'UNKNOWN'}\n"
        f"Phase: {scene_key}\n"
        f"Station: {station}\n"
        f"Personality: {personality or 'None'}\n"
        f"Agent report excerpt: {report_excerpt}\n\n"
        "Return JSON only in this exact schema:\n"
        '{ "dialogue": "short in-character line",'
        ' "animation": "talk|read|point|argue|sit_type|sit_back|idle|buy|sell|cheer|facepalm|hodl|rekt|copium",'
        ' "path": "direct|detour|loop|idle", "perform": true }\n'
        "Rules:\n"
        "- Dialogue must be 1-2 short sentences, no markdown.\n"
        "- Keep dialogue under 180 characters.\n"
        "- Use only the allowed animation/path values.\n"
        "- The LLM does not choose the station.\n"
    )

    try:
        llm = get_llm_client()
        result = await asyncio.wait_for(
            llm.generate_json(
                prompt=prompt,
                system_prompt="You are a trading floor dialogue and choreography generator. Return JSON only.",
                provider=provider,
                model=model,
            ),
            timeout=12,
        )
        if isinstance(result, dict) and isinstance(result.get("summary"), dict):
            result = result.get("summary")
        if not isinstance(result, dict):
            return fallback

        dialogue = _trim_dialogue_text(result.get("dialogue")) or fallback["dialogue"]
        return {
            "dialogue": dialogue,
            "animation": _normalize_scene_animation(result.get("animation"), fallback["animation"]),
            "path": _normalize_scene_path(result.get("path"), fallback["path"]),
            "perform": _normalize_scene_perform(result.get("perform"), True),
        }
    except Exception as exc:
        logger.warning("[TA-RUN] Foreground scene inference failed for %s: %s", agent_name, exc)
        return fallback

@router.post("/trading-agents/run")
async def run_trading_agents(request: Request):
    """Trigger TradingAgents by delegating execution to the upstream CLI sidecar."""
    raise HTTPException(
        status_code=410,
        detail="Deprecated: /trading-agents/run is disabled. Use browser-direct BYOK runner.",
    )

    global _active_ta_sidecar_run_id, _active_ta_task

    def _normalize_depth(value: Any) -> str:
        candidate = str(value or "standard").strip().lower()
        if candidate not in {"quick", "standard", "deep"}:
            return "standard"
        return candidate

    def _map_depth_to_rounds(depth_value: str) -> int:
        return {"quick": 1, "standard": 3, "deep": 5}.get(depth_value, 3)

    def _phase_key_to_subphase(phase_key: Optional[str]) -> str:
        mapping = {
            "STEP_1_ANALYSTS": "analysts",
            "STEP_2_RESEARCH": "research",
            "STEP_3_TRADER": "trader",
            "STEP_4_RISK": "risk",
            "STEP_5_PORTFOLIO": "portfolio",
        }
        return mapping.get(str(phase_key or "").upper(), "init")

    def _phase_key_to_number(phase_key: Optional[str]) -> int:
        mapping = {
            "STEP_1_ANALYSTS": 1,
            "STEP_2_RESEARCH": 2,
            "STEP_3_TRADER": 3,
            "STEP_4_RISK": 4,
            "STEP_5_PORTFOLIO": 5,
        }
        return mapping.get(str(phase_key or "").upper(), 0)

    def _extract_report_text(value: Any, *, allow_summary: bool = False) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, (int, float, bool)):
            return str(value).strip()
        if isinstance(value, list):
            candidates = [_extract_report_text(item, allow_summary=allow_summary) for item in value]
            candidates = [item for item in candidates if item]
            return max(candidates, key=len) if candidates else ""
        if isinstance(value, dict):
            keys = [
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
            ]
            if allow_summary:
                keys.append("summary")
            for key in keys:
                if key in value:
                    nested = _extract_report_text(value.get(key), allow_summary=allow_summary)
                    if nested:
                        return nested
        return ""

    def _extract_decision_keyword(text_value: Any) -> str:
        upper = str(text_value or "").upper()
        for action in ("LIQUIDATE", "SELL", "ADD", "BUY", "HOLD"):
            if re.search(rf"\b{action}\b", upper):
                return action
        return "HOLD"

    def _extract_agent_reports_from_state(state: Dict[str, Any]) -> Dict[str, str]:
        invest_state = state.get("investment_debate_state") or {}
        risk_state = state.get("risk_debate_state") or {}
        source_map = {
            "market_analyst": state.get("market_report"),
            "social_analyst": state.get("sentiment_report"),
            "news_analyst": state.get("news_report"),
            "fundamentals_analyst": state.get("fundamentals_report"),
            "bull_researcher": invest_state.get("bull_history"),
            "bear_researcher": invest_state.get("bear_history"),
            "research_manager": invest_state.get("judge_decision"),
            "trader": state.get("trader_investment_plan") or state.get("investment_plan"),
            "aggressive_analyst": risk_state.get("aggressive_history"),
            "conservative_analyst": risk_state.get("conservative_history"),
            "neutral_analyst": risk_state.get("neutral_history"),
            "risk_judge": risk_state.get("judge_decision") or state.get("final_trade_decision"),
        }
        reports: Dict[str, str] = {}
        for agent_id, raw_value in source_map.items():
            report = _extract_report_text(raw_value, allow_summary=False)
            if report:
                reports[agent_id] = report
        return reports

    def _read_json_file(path_value: Optional[str]) -> Dict[str, Any]:
        if not path_value:
            return {}
        path_obj = Path(path_value)
        if not path_obj.exists():
            return {}
        try:
            return json.loads(path_obj.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _read_text_file(path_value: Optional[str]) -> str:
        if not path_value:
            return ""
        path_obj = Path(path_value)
        if not path_obj.exists():
            return ""
        try:
            return path_obj.read_text(encoding="utf-8")
        except Exception:
            return ""

    def _extract_sidecar_active_run_id(payload: Any) -> Optional[str]:
        if isinstance(payload, dict):
            candidates = [
                payload.get("detail"),
                payload.get("message"),
                payload.get("error"),
            ]
        else:
            candidates = [payload]
        for candidate in candidates:
            text = str(candidate or "")
            match = re.search(r"Run already active:\s*([^\s\"'}]+)", text)
            if match:
                return match.group(1).strip()
        return None

    try:
        body = await request.body()
        logger.info("[TA-RUN] Raw request body: %s", body.decode("utf-8")[:200])
        data = await request.json()
    except Exception as exc:
        logger.error("[TA-RUN] Failed to parse request: %s", exc)
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}")

    ticker = str(data.get("ticker") or "").strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker is required.")

    trade_date = str(data.get("date") or datetime.now().strftime("%Y-%m-%d")).strip()
    requested_depth = (
        data.get("depth")
        or data.get("research_depth")
        or data.get("researchDepth")
    )
    depth = _normalize_depth(requested_depth)
    run_id = build_tradingagents_run_id(ticker, trade_date, prefix="ta")

    from src.analytics.data_access import get_data_access

    llm_defaults = get_data_access().get_tradingagents_llm_config() or {}
    provider = str(data.get("provider") or llm_defaults.get("llm_provider") or "nvidia").strip().lower()
    quick_model = str(data.get("quickModel") or llm_defaults.get("quick_model") or "").strip()
    deep_model = str(data.get("deepModel") or llm_defaults.get("deep_model") or quick_model).strip()
    output_language = str(
        data.get("outputLanguage")
        or data.get("language")
        or llm_defaults.get("output_language")
        or "English"
    ).strip() or "English"

    if not quick_model or not deep_model:
        raise HTTPException(status_code=400, detail="quickModel and deepModel are required for upstream execution.")
    _validate_tradingagents_model_selection(provider, quick_model, deep_model)
    quick_model, deep_model = _coerce_upstream_compatible_models(provider, quick_model, deep_model)

    active_run = load_active_run()
    if active_run and not is_abort_requested(active_run.get("run_id")):
        raise HTTPException(status_code=400, detail="A TradingAgents run is already in progress.")

    if autonomous_trader.is_analyzing or (_active_ta_task and not _active_ta_task.done()):
        raise HTTPException(status_code=400, detail="A TradingAgents run is already in progress.")

    sidecar_payload = {
        "run_id": run_id,
        "ticker": ticker,
        "date": trade_date,
        "provider": provider,
        "quick_model": quick_model,
        "deep_model": deep_model,
        "research_depth": _map_depth_to_rounds(depth),
        "output_language": output_language,
    }

    try:
        try:
            sidecar_start = await start_upstream_run(sidecar_payload)
        except SidecarError as exc:
            stale_upstream_run_id = _extract_sidecar_active_run_id(exc.payload)
            if exc.status_code == 409 and stale_upstream_run_id and not load_active_run():
                logger.warning(
                    "[TA-RUN] Aborting stale sidecar active run %s before retrying start.",
                    stale_upstream_run_id,
                )
                with suppress(Exception):
                    await abort_upstream_run(stale_upstream_run_id)
                sidecar_start = await start_upstream_run(sidecar_payload)
            else:
                raise
    except SidecarError as exc:
        logger.error("[TA-RUN] Upstream sidecar start failed: %s payload=%s", exc, exc.payload)
        raise HTTPException(
            status_code=503,
            detail={
                "message": "TradingAgents upstream sidecar is unavailable.",
                "error": str(exc),
                "sidecar": exc.payload,
            },
        )

    upstream_run_id = str(sidecar_start.get("run_id") or run_id)

    from src.api.trading_floor_simple import (
        broadcast_pipeline_phase,
        agent_states,
        manager,
        portfolio_state,
        pipeline_state,
        update_ui_agent_state,
    )
    decision_service = get_tradingagents_decision_service()
    scene_report_cache: Dict[str, str] = {}
    scene_build_failures: List[Dict[str, Any]] = []
    requested_drama_level = data.get("dramaLevel") or llm_defaults.get("drama_level")
    requested_scene_preset = data.get("sceneDialoguePreset") or llm_defaults.get("scene_dialogue_preset")
    if str(requested_drama_level or "").strip():
        scene_drama_level = decision_service.normalize_scene_drama_level(requested_drama_level)
        scene_dialogue_preset = decision_service.scene_preset_from_drama_level(scene_drama_level)
    else:
        scene_dialogue_preset = decision_service.normalize_scene_dialogue_preset(requested_scene_preset)
        scene_drama_level = decision_service.scene_drama_level_from_preset(scene_dialogue_preset)

    for agent in agent_states:
        agent_states[agent].update({"status": "idle", "action": "Waiting..."})

    pipeline_state["pipeline_mode"] = "tradingagents"
    pipeline_state["ticker"] = ticker
    pipeline_state["trade_date"] = trade_date
    pipeline_state["llm_provider"] = provider
    pipeline_state["quick_model"] = quick_model
    pipeline_state["deep_model"] = deep_model
    pipeline_state["phase"] = "init"
    pipeline_state["phase_num"] = 1
    pipeline_state["active_run_id"] = run_id
    pipeline_state["research_depth"] = depth
    pipeline_state["live_step_dialogue"] = {}
    pipeline_state["ta_background_profiles"] = {}
    pipeline_state["ta_foreground_override"] = {}
    pipeline_state["llm_calls"] = 0
    pipeline_state["tool_calls"] = 0
    pipeline_state["tokens_in"] = 0
    pipeline_state["tokens_out"] = 0
    pipeline_state["attempt"] = 1
    pipeline_state["max_attempts"] = 1
    pipeline_state["output_language"] = output_language

    try:
        from src.analytics.data_access import get_data_access as _get_da
        da = _get_da()
        pipeline_scenes = da.get_config("pipeline_scenes") or {}
        payload = {
            "type": "pipeline_scenes_updated",
            "config": pipeline_scenes,
            "timestamp": datetime.now().isoformat(),
        }
        await manager.broadcast(payload)
        await rc.publish_event("trading_floor_events", "pipeline_scenes_updated", payload)
    except Exception as exc:
        logger.warning("[TA-RUN] Failed to broadcast pipeline scenes: %s", exc)

    async def _broadcast_runtime_event(payload: Dict[str, Any]) -> None:
        if is_shutting_down():
            return
        event_type = payload.get("type", "unknown")
        ws_payload = {**payload, "ws_broadcasted": True}
        await manager.broadcast(ws_payload)
        await rc.publish_event("trading_floor_events", event_type, ws_payload)

    def _normalize_sidecar_event(event: Dict[str, Any]) -> Dict[str, Any]:
        evt = dict(event or {})
        evt.setdefault("run_id", run_id)
        evt.setdefault("active_run_id", run_id)
        evt.setdefault("upstream_run_id", upstream_run_id)
        evt.setdefault("ticker", ticker)
        evt.setdefault("trade_date", trade_date)
        evt.setdefault("llm_provider", provider)
        evt.setdefault("quick_model", quick_model)
        evt.setdefault("deep_model", deep_model)
        evt.setdefault("pipeline_mode", "tradingagents")
        evt.setdefault("research_depth", depth)

        current_step = normalize_tradingagents_agent_id(
            evt.get("current_step") or evt.get("agent") or evt.get("agent_display_name")
        )
        if current_step:
            evt["current_step"] = current_step
            evt.setdefault("agent", current_step)
            evt.setdefault("agent_display_name", normalize_tradingagents_agent_name(current_step) or evt.get("agent_display_name"))

        phase_key = str(evt.get("phase_key") or "").upper()
        phase_value = str(evt.get("phase") or "").strip().lower()
        if not evt.get("sub_phase"):
            if phase_value:
                evt["sub_phase"] = phase_value
            else:
                evt["sub_phase"] = _phase_key_to_subphase(phase_key)
        if not evt.get("phase_num"):
            if current_step:
                evt["phase_num"] = TRADINGAGENTS_PHASE_NUMBERS.get(current_step, 0)
            if not evt.get("phase_num") and phase_key:
                evt["phase_num"] = _phase_key_to_number(phase_key)
        return evt

    def _resolve_event_attempt(evt: Dict[str, Any]) -> int:
        raw_value = evt.get("attempt") or pipeline_state.get("attempt") or 1
        try:
            return max(1, int(float(raw_value)))
        except Exception:
            return 1

    async def _forward_structured_event(event: Dict[str, Any]) -> None:
        evt = _normalize_sidecar_event(event)
        event_type = str(evt.get("type") or "unknown")
        attempt_number = _resolve_event_attempt(evt)
        for telemetry_key in ("llm_calls", "tool_calls", "tokens_in", "tokens_out", "attempt", "max_attempts"):
            if evt.get(telemetry_key) is not None:
                pipeline_state[telemetry_key] = evt.get(telemetry_key)
        if event_type == "run_retrying" and not evt.get("message"):
            retry_reason = str(evt.get("error_code") or "TRANSIENT_UPSTREAM_ERROR").strip().upper()
            evt["message"] = f"Retrying upstream run ({evt.get('attempt')}/{evt.get('max_attempts')}) after {retry_reason}"
        if event_type == "agent_quality_failed":
            evt.setdefault("status", "quality_failed")
            if not evt.get("message"):
                agent_label = evt.get("agent_display_name") or evt.get("agent") or "agent"
                evt["message"] = f"{agent_label} quality check failed"
        if event_type == "run_retrying":
            scene_report_cache.clear()
            scene_build_failures.clear()
            decision_service.clear_run_scene_history(run_id)
            await _broadcast_runtime_event(
                {
                    "type": "tradingagents_scene_history_reset",
                    "run_id": run_id,
                    "active_run_id": run_id,
                    "upstream_run_id": upstream_run_id,
                    "ticker": ticker,
                    "attempt": attempt_number,
                    "max_attempts": evt.get("max_attempts"),
                    "timestamp": evt.get("timestamp") or datetime.now().isoformat(),
                }
            )

        if event_type in {
            "pipeline_start",
            "phase_start",
            "agent_action",
            "agent_completed",
            "run_telemetry",
            "run_retrying",
            "agent_quality_failed",
            "final_decision",
            "run_completed",
            "run_failed",
            "run_aborted",
        }:
            phase_num = evt.get("phase_num")
            if isinstance(phase_num, str) and phase_num.isdigit():
                phase_num = int(phase_num)
            if not isinstance(phase_num, int):
                phase_num = None
            await broadcast_pipeline_phase(
                evt.get("sub_phase") or "init",
                cycle=evt.get("cycle", 1),
                action=evt.get("message", ""),
                ticker=ticker,
                trade_date=evt.get("trade_date") or trade_date,
                llm_provider=evt.get("llm_provider") or provider,
                quick_model=evt.get("quick_model") or quick_model,
                deep_model=evt.get("deep_model") or deep_model,
                phase_num=phase_num if phase_num and phase_num > 0 else None,
                pipeline_mode="tradingagents",
                active_run_id=run_id,
                current_step=evt.get("current_step"),
                agent_display_name=evt.get("agent_display_name"),
                research_depth=depth,
                message_type="pipeline_start" if event_type == "pipeline_start" else "pipeline_phase",
            )

        if event_type in {"agent_action", "agent_completed", "agent_quality_failed"}:
            agent_name = normalize_tradingagents_agent_name(evt.get("current_step") or evt.get("agent") or evt.get("agent_display_name"))
            if agent_name:
                if event_type == "agent_completed":
                    status = "completed"
                elif event_type == "agent_quality_failed":
                    status = "quality_failed"
                else:
                    status = evt.get("status") or "working"
                update_ui_agent_state(
                    agent_name,
                    status=status,
                    decision=evt.get("decision"),
                    confidence=evt.get("confidence"),
                    ticker=ticker,
                    reasoning=evt.get("report") or evt.get("raw_excerpt") or evt.get("message"),
                    station=evt.get("station"),
                )

        await _broadcast_runtime_event(evt)

        movement_cue_command: Optional[Dict[str, Any]] = None
        movement_scene_index: Optional[int] = None
        movement_scene_kind: Optional[str] = None
        if event_type == "pipeline_start":
            movement_scene_index = 0
            movement_scene_kind = "init"
        elif event_type == "agent_action" and str(evt.get("scene_stage") or "").lower() == "start":
            slot = decision_service.get_report_slot_for_agent(evt.get("current_step") or evt.get("agent"))
            movement_scene_index = _safe_int((slot or {}).get("slot"), 0) if slot else None
            movement_scene_kind = "report_started" if movement_scene_index else None

        if movement_scene_index is not None and movement_scene_kind:
            movement_cue_command = decision_service.build_timeline_movement_cue(
                ticker=ticker,
                scene_index=movement_scene_index,
                scene_kind=movement_scene_kind,
                source_agent=evt.get("current_step") or evt.get("agent"),
            )
            if movement_cue_command:
                timeline_scene_key = movement_cue_command.get("sceneKey")
                movement_payload = {
                    "run_id": run_id,
                    "active_run_id": run_id,
                    "upstream_run_id": upstream_run_id,
                    "ticker": ticker,
                    "attempt": attempt_number,
                    "scene_index": movement_scene_index,
                    "scene_key": timeline_scene_key,
                    "scene_label": movement_cue_command.get("sceneLabel"),
                    "scene_kind": movement_scene_kind,
                    "source_agent": movement_cue_command.get("sourceAgent"),
                    "source_report_slot": movement_cue_command.get("sourceReportSlot"),
                    "command": movement_cue_command,
                    "timestamp": evt.get("timestamp") or datetime.now().isoformat(),
                }
                await _broadcast_runtime_event(
                    {
                        "type": "tradingagents_scene_cue",
                        **movement_payload,
                    }
                )
                await _broadcast_runtime_event(
                    {
                        "type": "scene_command",
                        **movement_payload,
                    }
                )

        timeline_scene: Optional[Dict[str, Any]] = None
        try:
            if event_type == "pipeline_start":
                scene_report_cache.clear()
                prior_scene_rows = decision_service.list_run_scenes(run_id, attempt=attempt_number)
                timeline_scene = await decision_service.build_run_timeline_scene(
                    ticker=ticker,
                    kind="init",
                    completed_reports=scene_report_cache,
                    output_language=output_language,
                    voice_preset=scene_dialogue_preset,
                    drama_level=scene_drama_level,
                    writer_provider=provider,
                    writer_quick_model=quick_model,
                    writer_deep_model=deep_model,
                    prior_scenes=prior_scene_rows,
                )
            elif event_type == "agent_completed":
                scene_agent_id = normalize_tradingagents_agent_id(evt.get("current_step") or evt.get("agent"))
                scene_report_body = decision_service.extract_scene_source_text(evt.get("report"))
                if scene_agent_id and scene_report_body:
                    scene_report_cache[scene_agent_id] = scene_report_body
                prior_scene_rows = decision_service.list_run_scenes(run_id, attempt=attempt_number)
                timeline_scene = await decision_service.build_run_timeline_scene(
                    ticker=ticker,
                    kind="report_completed",
                    agent_id=evt.get("current_step") or evt.get("agent"),
                    report_excerpt=_clean_report_excerpt(
                        evt.get("report") or evt.get("raw_excerpt") or evt.get("message"),
                        limit=220,
                    ),
                    report_body=scene_report_body,
                    completed_reports=scene_report_cache,
                    output_language=output_language,
                    voice_preset=scene_dialogue_preset,
                    drama_level=scene_drama_level,
                    writer_provider=provider,
                    writer_quick_model=quick_model,
                    writer_deep_model=deep_model,
                    prior_scenes=prior_scene_rows,
                )
        except SceneDialogueError as scene_exc:
            scene_failure_meta = dict(getattr(scene_exc, "meta", {}) or {})
            scene_build_failures.append(
                {
                    "attempt": attempt_number,
                    "event_type": event_type,
                    "error_code": "SCENE_DIALOGUE_FAILED",
                    "message": str(scene_exc),
                    "meta": scene_failure_meta,
                    "timestamp": datetime.now().isoformat(),
                }
            )
            await _broadcast_runtime_event(
                {
                    "type": "tradingagents_scene_failed",
                    "run_id": run_id,
                    "active_run_id": run_id,
                    "upstream_run_id": upstream_run_id,
                    "ticker": ticker,
                    "attempt": attempt_number,
                    "error_code": "SCENE_DIALOGUE_FAILED",
                    "message": str(scene_exc),
                    "meta": scene_failure_meta,
                    "timestamp": datetime.now().isoformat(),
                }
            )
            logger.warning(
                "[TA-SCENE] Live scene generation failed for run_id=%s event=%s attempt=%s; upstream stream will continue and final repair will retry: %s",
                run_id,
                event_type,
                attempt_number,
                scene_exc,
            )
            timeline_scene = None

        if timeline_scene:
            scene_obj = timeline_scene.get("scene") or {}
            scene_script = scene_obj.get("script") or {}
            scene_script_meta = scene_obj.get("script_meta") or {}
            writer_source = str(scene_script.get("writer_source") or scene_script_meta.get("writer_source") or "").strip().lower()
            validation_passed = scene_script.get("validation_passed")
            if validation_passed is None:
                validation_passed = scene_script_meta.get("validation_passed")
            if writer_source != "llm" or validation_passed is not True:
                raise SceneDialogueError(
                    "SCENE_DIALOGUE_FAILED: canonical scene missing llm-validated writer metadata",
                    {
                        "attempt": attempt_number,
                        "scene_index": timeline_scene.get("scene_index"),
                        "scene_label": timeline_scene.get("scene_label"),
                        "writer_source": writer_source or None,
                        "validation_passed": validation_passed,
                    },
                )
            persisted_scene = decision_service.save_run_scene(
                run_id=run_id,
                attempt=attempt_number,
                scene_index=timeline_scene.get("scene_index"),
                scene_label=timeline_scene.get("scene_label"),
                scene_kind=timeline_scene.get("scene_kind"),
                source_agent=timeline_scene.get("source_agent"),
                source_report_slot=timeline_scene.get("source_report_slot"),
                voice_preset=timeline_scene.get("voice_preset") or scene_dialogue_preset,
                drama_level=timeline_scene.get("drama_level") or scene_drama_level,
                scene=timeline_scene.get("scene") or {},
            )
            await _broadcast_runtime_event(
                {
                    "type": "tradingagents_scene_generated",
                    "run_id": run_id,
                    "active_run_id": run_id,
                    "upstream_run_id": upstream_run_id,
                    "ticker": ticker,
                    "attempt": persisted_scene.get("attempt"),
                    "scene_index": persisted_scene.get("scene_index"),
                    "scene_key": persisted_scene.get("scene_key") or (((persisted_scene.get("scene") or {}).get("script_meta") or {}).get("scene_key")),
                    "scene_label": persisted_scene.get("scene_label"),
                    "scene_kind": persisted_scene.get("scene_kind"),
                    "source_agent": persisted_scene.get("source_agent"),
                    "source_report_slot": persisted_scene.get("source_report_slot"),
                    "voice_preset": persisted_scene.get("voice_preset"),
                    "drama_level": persisted_scene.get("drama_level"),
                    "output_language": (
                        ((persisted_scene.get("scene") or {}).get("script_meta") or {}).get("output_language")
                        or ((persisted_scene.get("scene") or {}).get("script") or {}).get("output_language")
                        or output_language
                    ),
                    "scene": persisted_scene.get("scene") or {},
                    "timestamp": persisted_scene.get("created_at") or datetime.now().isoformat(),
                }
            )
            await _broadcast_runtime_event(
                {
                    "type": "scene_command",
                    "run_id": run_id,
                    "active_run_id": run_id,
                    "upstream_run_id": upstream_run_id,
                    "ticker": ticker,
                    "attempt": persisted_scene.get("attempt"),
                    "scene_index": persisted_scene.get("scene_index"),
                    "scene_key": persisted_scene.get("scene_key") or (((persisted_scene.get("scene") or {}).get("script_meta") or {}).get("scene_key")),
                    "scene_label": persisted_scene.get("scene_label"),
                    "scene_kind": persisted_scene.get("scene_kind"),
                    "source_agent": persisted_scene.get("source_agent"),
                    "source_report_slot": persisted_scene.get("source_report_slot"),
                    "voice_preset": persisted_scene.get("voice_preset"),
                    "drama_level": persisted_scene.get("drama_level"),
                    "output_language": (
                        ((persisted_scene.get("scene") or {}).get("script_meta") or {}).get("output_language")
                        or ((persisted_scene.get("scene") or {}).get("script") or {}).get("output_language")
                        or output_language
                    ),
                    "command": decision_service.scene_package_to_command(persisted_scene.get("scene") or {}),
                    "timestamp": persisted_scene.get("created_at") or datetime.now().isoformat(),
                }
            )

    async def _broadcast_terminal_pipeline_state(
        saved_package: Optional[Dict[str, Any]] = None,
        *,
        status: str = "COMPLETE",
        action: Optional[str] = None,
        error_code: Optional[str] = None,
        message: Optional[str] = None,
    ) -> None:
        with suppress(Exception):
            terminal_status = str(status or "COMPLETE").strip().upper()
            terminal_phase = terminal_status if terminal_status in {"COMPLETE", "FAILED", "ABORTED"} else "COMPLETE"
            raw_state = (saved_package or {}).get("raw_state") or {}
            final_action = (
                action
                or (saved_package or {}).get("recommended_action")
                or (saved_package or {}).get("model_action")
                or raw_state.get("recommended_action")
                or raw_state.get("model_action")
                or ("COMPLETE" if terminal_phase == "COMPLETE" else terminal_phase)
            )
            llm_calls = (
                raw_state.get("engine_llm_calls")
                or raw_state.get("llm_calls")
                or pipeline_state.get("llm_calls", 0)
            )
            tool_calls = (
                raw_state.get("engine_tool_calls")
                or raw_state.get("tool_calls")
                or pipeline_state.get("tool_calls", 0)
            )
            tokens_in = (
                raw_state.get("tokens_in")
                or raw_state.get("prompt_tokens")
                or pipeline_state.get("tokens_in", 0)
            )
            tokens_out = (
                raw_state.get("tokens_out")
                or raw_state.get("completion_tokens")
                or pipeline_state.get("tokens_out", 0)
            )
            pipeline_state.update({
                "phase": terminal_phase,
                "ticker": ticker,
                "trade_date": trade_date,
                "llm_provider": provider,
                "quick_model": quick_model,
                "deep_model": deep_model,
                "phase_num": 5,
                "current_phase": 5,
                "pipeline_mode": "tradingagents",
                "active_run_id": run_id,
                "current_step": "risk_judge",
                "agent_display_name": "Risk Judge",
                "research_depth": depth,
                "status": terminal_status,
                "action": str(final_action or terminal_status).upper(),
                "llm_calls": llm_calls,
                "tool_calls": tool_calls,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "attempt": (saved_package or {}).get("attempt") or raw_state.get("attempt") or pipeline_state.get("attempt", 1),
                "max_attempts": (saved_package or {}).get("max_attempts") or raw_state.get("max_attempts") or pipeline_state.get("max_attempts", 1),
                "error_code": error_code,
                "message": message,
                "timestamp": datetime.now().isoformat(),
            })
            await manager.broadcast({
                "type": "pipeline_phase",
                "phase": pipeline_state.get("phase", "IDLE"),
                "ticker": pipeline_state.get("ticker"),
                "trade_date": pipeline_state.get("trade_date"),
                "llm_provider": pipeline_state.get("llm_provider"),
                "quick_model": pipeline_state.get("quick_model"),
                "deep_model": pipeline_state.get("deep_model"),
                "cycle": pipeline_state.get("cycle", 1),
                "regime": pipeline_state.get("regime"),
                "premortem_data": pipeline_state.get("premortem_data"),
                "war_room_brief": pipeline_state.get("war_room_brief"),
                "phase_num": pipeline_state.get("phase_num", 0),
                "pipeline_mode": pipeline_state.get("pipeline_mode"),
                "run_id": pipeline_state.get("active_run_id"),
                "active_run_id": pipeline_state.get("active_run_id"),
                "current_step": pipeline_state.get("current_step"),
                "agent_display_name": pipeline_state.get("agent_display_name"),
                "research_depth": pipeline_state.get("research_depth"),
                "status": pipeline_state.get("status", "WAITING"),
                "action": pipeline_state.get("action", "WAITING"),
                "llm_calls": pipeline_state.get("llm_calls", 0),
                "tool_calls": pipeline_state.get("tool_calls", 0),
                "tokens_in": pipeline_state.get("tokens_in", 0),
                "tokens_out": pipeline_state.get("tokens_out", 0),
                "attempt": pipeline_state.get("attempt", 1),
                "max_attempts": pipeline_state.get("max_attempts", 1),
                "error_code": error_code,
                "message": message,
                "timestamp": pipeline_state.get("timestamp"),
            })

    clear_abort_request()
    set_active_run(run_id=run_id, ticker=ticker, trade_date=trade_date, depth=depth)
    update_active_run(run_id, upstream_run_id=upstream_run_id, status="running")

    try:
        await asyncio.wait_for(
            asyncio.to_thread(
                decision_service.start_run_record,
                run_id,
                ticker,
                trade_date,
                depth,
                portfolio_state,
            ),
            timeout=6.0,
        )
    except asyncio.TimeoutError:
        logger.warning("[TA-RUN] start_run_record timed out for %s (run_id=%s)", ticker, run_id)
    except Exception as exc:
        logger.exception("[TA-RUN] start_run_record failed for %s (run_id=%s): %s", ticker, run_id, exc)

    await broadcast_pipeline_phase(
        "init",
        ticker=ticker,
        trade_date=trade_date,
        llm_provider=provider,
        quick_model=quick_model,
        deep_model=deep_model,
        cycle=1,
        action=f"Starting {depth.upper()} TradingAgents analysis for {ticker}...",
        status="STARTING",
        phase_num=1,
        pipeline_mode="tradingagents",
        active_run_id=run_id,
        current_step="market_analyst",
        agent_display_name=normalize_tradingagents_agent_name("market_analyst"),
        research_depth=depth,
        message_type="pipeline_start",
    )

    async def run_with_error_handling() -> None:
        global _active_ta_sidecar_run_id, _active_ta_task

        completion_event: Dict[str, Any] = {}
        artifacts_payload: Dict[str, Any] = {}
        failed_event: Dict[str, Any] = {}
        terminal_status = ""
        terminal_error = ""
        failure_meta: Dict[str, Any] = {
            "error_code": None,
            "error_message": None,
            "failed_stage": None,
            "failed_agent": None,
            "upstream_status_source": None,
        }
        retry_state: Dict[str, Any] = {
            "attempt": 1,
            "max_attempts": 1,
            "invalid_agents": [],
            "attempts": [],
        }
        stall_seconds = max(120, _safe_int(os.getenv("TRADINGAGENTS_STALL_SECONDS"), 420))
        stall_min_llm_calls = max(1, _safe_int(os.getenv("TRADINGAGENTS_STALL_MIN_LLM_CALLS"), 6))
        last_progress_monotonic = time.monotonic()
        last_progress_label = "run_started"
        live_telemetry: Dict[str, int] = {
            "llm_calls": 0,
            "tool_calls": 0,
        }

        def _mark_progress(label: str) -> None:
            nonlocal last_progress_monotonic, last_progress_label
            last_progress_monotonic = time.monotonic()
            last_progress_label = str(label or "progress")

        def _raise_if_stalled() -> None:
            nonlocal failure_meta
            observed_llm_calls = max(
                _safe_int(pipeline_state.get("llm_calls"), 0),
                _safe_int(live_telemetry.get("llm_calls"), 0),
            )
            stalled_for = time.monotonic() - last_progress_monotonic
            if observed_llm_calls < stall_min_llm_calls or stalled_for < stall_seconds:
                return
            failure_meta = {
                "error_code": "PIPELINE_STALLED",
                "error_message": (
                    f"PIPELINE_STALLED: no scene/report progress for {int(stalled_for)}s "
                    f"after {observed_llm_calls} LLM calls (last_progress={last_progress_label})."
                ),
                "failed_stage": str(pipeline_state.get("sub_phase") or pipeline_state.get("phase") or "").upper() or "ANALYSTS",
                "failed_agent": str(pipeline_state.get("current_step") or pipeline_state.get("agent_display_name") or "").strip() or None,
                "upstream_status_source": "backend_stall_guard",
            }
            raise RuntimeError(failure_meta["error_message"])

        def _update_live_telemetry_from_log(line: str) -> Dict[str, int]:
            text = str(line or "")
            if "================================== Ai Message ==================================" in text:
                live_telemetry["llm_calls"] += 1
            elif re.match(r"^\s{2}[a-zA-Z_][\w]*\s+\([^)]+\)\s*$", text):
                live_telemetry["tool_calls"] += 1
            pipeline_state["llm_calls"] = max(0, int(live_telemetry.get("llm_calls") or 0))
            pipeline_state["tool_calls"] = max(0, int(live_telemetry.get("tool_calls") or 0))
            return {
                "llm_calls": max(0, int(live_telemetry.get("llm_calls") or 0)),
                "tool_calls": max(0, int(live_telemetry.get("tool_calls") or 0)),
            }

        try:
            _active_ta_sidecar_run_id = upstream_run_id
            last_seq = 0
            stream_error: Optional[Exception] = None

            try:
                async for envelope in stream_upstream_events(upstream_run_id, from_seq=0):
                    if is_abort_requested(run_id):
                        raise asyncio.CancelledError("Abort requested")

                    seq = envelope.get("sequence")
                    if isinstance(seq, int):
                        last_seq = max(last_seq, seq)

                    kind = str(envelope.get("kind") or "").lower()
                    if kind == "raw_log":
                        line = str(envelope.get("line") or "").rstrip()
                        if line:
                            telemetry = _update_live_telemetry_from_log(line)
                            await _broadcast_runtime_event(
                                {
                                    "type": "tradingagents_raw_log",
                                    "run_id": run_id,
                                    "active_run_id": run_id,
                                    "upstream_run_id": upstream_run_id,
                                    "ticker": ticker,
                                    "line": line,
                                    "message": line,
                                    "llm_calls": telemetry.get("llm_calls"),
                                    "tool_calls": telemetry.get("tool_calls"),
                                    "level": envelope.get("level"),
                                    "timestamp": envelope.get("timestamp") or datetime.now().isoformat(),
                                }
                            )
                        _raise_if_stalled()
                        continue

                    if kind == "event":
                        event = envelope.get("event")
                        if not isinstance(event, dict):
                            continue
                        event_type = str(event.get("type") or "").lower()
                        if event_type == "log":
                            msg = str(event.get("message") or "").rstrip()
                            if msg:
                                telemetry = _update_live_telemetry_from_log(msg)
                                await _broadcast_runtime_event(
                                    {
                                        "type": "tradingagents_raw_log",
                                        "run_id": run_id,
                                        "active_run_id": run_id,
                                        "upstream_run_id": upstream_run_id,
                                        "ticker": ticker,
                                        "line": msg,
                                        "message": msg,
                                        "llm_calls": telemetry.get("llm_calls"),
                                        "tool_calls": telemetry.get("tool_calls"),
                                        "level": event.get("level"),
                                        "timestamp": event.get("timestamp") or envelope.get("timestamp") or datetime.now().isoformat(),
                                    }
                                )
                            _raise_if_stalled()
                            continue

                        event["run_id"] = run_id
                        event["active_run_id"] = run_id
                        event["upstream_run_id"] = upstream_run_id
                        await _forward_structured_event(event)

                        if event_type == "run_retrying":
                            _mark_progress("run_retrying")
                            retry_state["attempt"] = event.get("attempt") or retry_state.get("attempt") or 1
                            retry_state["max_attempts"] = event.get("max_attempts") or retry_state.get("max_attempts") or 1
                            retry_state["invalid_agents"] = event.get("invalid_agents") or []
                        elif event_type in {"pipeline_start", "phase_start", "agent_action", "agent_completed", "final_decision", "run_completed"}:
                            _mark_progress(event_type)
                        elif event_type == "agent_quality_failed":
                            current = list(retry_state.get("invalid_agents") or [])
                            current.append({
                                "agent": event.get("agent"),
                                "agent_display_name": event.get("agent_display_name"),
                                "reason": event.get("reason"),
                                "excerpt": event.get("excerpt"),
                            })
                            retry_state["invalid_agents"] = current
                        if event_type == "run_completed":
                            completion_event = event
                        elif event_type == "run_failed":
                            failed_event = event
                            retry_state["attempt"] = event.get("attempt") or retry_state.get("attempt") or 1
                            retry_state["max_attempts"] = event.get("max_attempts") or retry_state.get("max_attempts") or 1
                            retry_state["invalid_agents"] = event.get("invalid_agents") or retry_state.get("invalid_agents") or []
                            retry_state["attempts"] = event.get("attempts") or retry_state.get("attempts") or []
                            error_code = str(event.get("error_code") or "").strip().upper() or None
                            error_message = str(
                                event.get("error_message")
                                or event.get("error")
                                or event.get("message")
                                or "Upstream CLI run failed."
                            ).strip()
                            failure_meta = {
                                "error_code": error_code,
                                "error_message": error_message,
                                "failed_stage": str(event.get("failed_stage") or "").strip() or None,
                                "failed_agent": str(event.get("failed_agent") or "").strip() or None,
                                "upstream_status_source": "sidecar_event",
                            }
                            if error_code and not error_message.startswith(f"{error_code}:"):
                                error_message = f"{error_code}: {error_message}"
                            raise RuntimeError(error_message)
                        _raise_if_stalled()
                        continue

                    if kind == "terminal":
                        artifacts_payload.update(envelope.get("artifacts") or {})
                        terminal_status = str(envelope.get("status") or "").upper()
                        terminal_error = str(envelope.get("error") or "").strip()
                        if terminal_status in {"FAILED", "ABORTED"} and not completion_event:
                            raise RuntimeError(terminal_error or f"Upstream run ended with status {terminal_status}.")
                        break
                    _raise_if_stalled()
            except SidecarError as exc:
                stream_error = exc

            artifact_meta = await get_upstream_artifacts(upstream_run_id)
            artifacts_payload.update((artifact_meta or {}).get("artifacts") or {})

            sidecar_run_status = ""
            sidecar_run_error = ""
            sidecar_run_payload: Dict[str, Any] = {}
            try:
                sidecar_run_payload = await get_upstream_run(upstream_run_id)
                sidecar_run_status = str(sidecar_run_payload.get("status") or "").upper()
                sidecar_run_error = str(sidecar_run_payload.get("error") or "").strip()
                artifacts_payload.update(sidecar_run_payload.get("artifacts") or {})
            except Exception as sidecar_status_exc:
                logger.warning(
                    "[TA-RUN] Failed to fetch sidecar status for run_id=%s upstream_run_id=%s: %s",
                    run_id,
                    upstream_run_id,
                    sidecar_status_exc,
                )

            if stream_error:
                logger.warning(
                    "[TA-RUN] Event stream interrupted for run_id=%s upstream_run_id=%s last_seq=%s: %s",
                    run_id,
                    upstream_run_id,
                    last_seq,
                    stream_error,
                )

            if not completion_event and sidecar_run_status == "COMPLETED":
                completion_event = {
                    "type": "run_completed",
                    "run_id": run_id,
                    "upstream_run_id": upstream_run_id,
                    "timestamp": sidecar_run_payload.get("completed_at") or datetime.now().isoformat(),
                    "attempt": retry_state.get("attempt") or 1,
                    "max_attempts": retry_state.get("max_attempts") or 1,
                    "attempts": retry_state.get("attempts") or [],
                    "llm_calls": sidecar_run_payload.get("llm_calls"),
                    "tool_calls": sidecar_run_payload.get("tool_calls"),
                    "tokens_in": sidecar_run_payload.get("tokens_in"),
                    "tokens_out": sidecar_run_payload.get("tokens_out"),
                }
                await _forward_structured_event(dict(completion_event))

            if not completion_event and sidecar_run_status in {"FAILED", "ABORTED"}:
                sidecar_error_code = str(sidecar_run_payload.get("error_code") or "").strip().upper() or None
                sidecar_error_message = str(
                    sidecar_run_payload.get("error_message")
                    or sidecar_run_error
                    or terminal_error
                    or f"Upstream run ended with status {sidecar_run_status}."
                ).strip()
                failure_meta = {
                    "error_code": sidecar_error_code,
                    "error_message": sidecar_error_message,
                    "failed_stage": str(sidecar_run_payload.get("failed_stage") or "").strip() or None,
                    "failed_agent": str(sidecar_run_payload.get("failed_agent") or "").strip() or None,
                    "upstream_status_source": "sidecar_status",
                }
                terminal_reason = f"{sidecar_error_code}: {sidecar_error_message}" if sidecar_error_code else sidecar_error_message
                raise RuntimeError(terminal_reason)

            if not completion_event:
                raise RuntimeError("Upstream run ended without a run_completed event.")

            retry_state["attempt"] = completion_event.get("attempt") or retry_state.get("attempt") or 1
            retry_state["max_attempts"] = completion_event.get("max_attempts") or retry_state.get("max_attempts") or 1
            retry_state["attempts"] = completion_event.get("attempts") or retry_state.get("attempts") or []

            final_state = _read_json_file(artifacts_payload.get("final_state_path"))
            if not final_state:
                raise RuntimeError("Upstream run completed but final_state.json is missing or unreadable.")

            complete_report = _read_text_file(artifacts_payload.get("complete_report_path"))
            if not complete_report and isinstance(completion_event.get("complete_report"), str):
                complete_report = completion_event.get("complete_report")

            full_agent_reports = _read_json_file(artifacts_payload.get("full_agent_reports_path"))
            if not full_agent_reports:
                full_agent_reports = completion_event.get("full_agent_reports") or {}
            if not isinstance(full_agent_reports, dict):
                full_agent_reports = {}
            if not full_agent_reports:
                full_agent_reports = _extract_agent_reports_from_state(final_state)
            canonical_agent_ids = {agent.get("id") for agent in TRADINGAGENTS_CANONICAL_AGENTS if agent.get("id")}
            missing_agent_ids = sorted([agent_id for agent_id in canonical_agent_ids if not str(full_agent_reports.get(agent_id) or "").strip()])
            if missing_agent_ids:
                raise RuntimeError(f"Upstream reports incomplete: missing canonical reports for {', '.join(missing_agent_ids)}")
            # Original-parity mode: the TradingAgents graph output is the source
            # of truth. The web layer may reject missing artifacts, but it must
            # not re-score, repair, or fail accepted original-engine reports.
            engine_meta = {
                "engine_mode": completion_event.get("engine_mode") or "original_parity",
                "engine_source": completion_event.get("engine_source") or "external/TradingAgents-upstream",
                "engine_reference": completion_event.get("engine_reference") or "TradingAgents-original",
                "engine_llm_calls": completion_event.get("engine_llm_calls", completion_event.get("llm_calls")),
                "engine_tool_calls": completion_event.get("engine_tool_calls", completion_event.get("tool_calls")),
            }

            attempt_for_scenes = int(retry_state.get("attempt") or 1)
            existing_scene_indices = {
                int(item.get("scene_index"))
                for item in decision_service.list_run_scenes(run_id, attempt=attempt_for_scenes)
                if item.get("scene_index") is not None
            }
            missing_scene_indices = [index for index in range(13) if index not in existing_scene_indices]
            for missing_scene_index in missing_scene_indices:
                repair_started_at = time.perf_counter()
                try:
                    prior_scene_rows = decision_service.list_run_scenes(run_id, attempt=attempt_for_scenes)
                    if missing_scene_index == 0:
                        repaired_scene = await decision_service.build_run_timeline_scene(
                            ticker=ticker,
                            kind="init",
                            completed_reports={},
                            output_language=output_language,
                            voice_preset=scene_dialogue_preset,
                            drama_level=scene_drama_level,
                            writer_provider=provider,
                            writer_quick_model=quick_model,
                            writer_deep_model=deep_model,
                            prior_scenes=prior_scene_rows,
                        )
                    else:
                        slot = next(
                            (
                                item
                                for item in TRADINGAGENTS_CANONICAL_REPORT_SLOTS
                                if _safe_int(item.get("slot"), -1) == missing_scene_index
                            ),
                            None,
                        )
                        if not slot:
                            continue
                        repair_agent_id = slot.get("agent_id")
                        completed_reports_for_scene = {
                            item.get("agent_id"): full_agent_reports.get(item.get("agent_id"))
                            for item in TRADINGAGENTS_CANONICAL_REPORT_SLOTS
                            if _safe_int(item.get("slot"), 99) <= missing_scene_index
                            and str(full_agent_reports.get(item.get("agent_id")) or "").strip()
                        }
                        repaired_scene = await decision_service.build_run_timeline_scene(
                            ticker=ticker,
                            kind="report_completed",
                            agent_id=repair_agent_id,
                            report_excerpt=_clean_report_excerpt(full_agent_reports.get(repair_agent_id), limit=220),
                            report_body=full_agent_reports.get(repair_agent_id),
                            completed_reports=completed_reports_for_scene,
                            output_language=output_language,
                            voice_preset=scene_dialogue_preset,
                            drama_level=scene_drama_level,
                            writer_provider=provider,
                            writer_quick_model=quick_model,
                            writer_deep_model=deep_model,
                            prior_scenes=prior_scene_rows,
                        )

                    scene_obj = (repaired_scene or {}).get("scene") or {}
                    scene_script = scene_obj.get("script") or {}
                    scene_script_meta = scene_obj.get("script_meta") or {}
                    writer_source = str(scene_script.get("writer_source") or scene_script_meta.get("writer_source") or "").strip().lower()
                    validation_passed = scene_script.get("validation_passed")
                    if validation_passed is None:
                        validation_passed = scene_script_meta.get("validation_passed")
                    if not repaired_scene or writer_source != "llm" or validation_passed is not True:
                        raise SceneDialogueError(
                            "SCENE_DIALOGUE_FAILED: repaired scene missing llm-validated writer metadata",
                            {
                                "attempt": attempt_for_scenes,
                                "scene_index": missing_scene_index,
                                "writer_source": writer_source or None,
                                "validation_passed": validation_passed,
                            },
                        )
                    persisted_scene = decision_service.save_run_scene(
                        run_id=run_id,
                        attempt=attempt_for_scenes,
                        scene_index=repaired_scene.get("scene_index"),
                        scene_label=repaired_scene.get("scene_label"),
                        scene_kind=repaired_scene.get("scene_kind"),
                        source_agent=repaired_scene.get("source_agent"),
                        source_report_slot=repaired_scene.get("source_report_slot"),
                        voice_preset=repaired_scene.get("voice_preset") or scene_dialogue_preset,
                        drama_level=repaired_scene.get("drama_level") or scene_drama_level,
                        scene=repaired_scene.get("scene") or {},
                    )
                    await _broadcast_runtime_event(
                        {
                            "type": "tradingagents_scene_generated",
                            "run_id": run_id,
                            "active_run_id": run_id,
                            "upstream_run_id": upstream_run_id,
                            "ticker": ticker,
                            "attempt": persisted_scene.get("attempt"),
                            "scene_index": persisted_scene.get("scene_index"),
                            "scene_key": persisted_scene.get("scene_key") or (((persisted_scene.get("scene") or {}).get("script_meta") or {}).get("scene_key")),
                            "scene_label": persisted_scene.get("scene_label"),
                            "scene_kind": persisted_scene.get("scene_kind"),
                            "source_agent": persisted_scene.get("source_agent"),
                            "source_report_slot": persisted_scene.get("source_report_slot"),
                            "voice_preset": persisted_scene.get("voice_preset"),
                            "drama_level": persisted_scene.get("drama_level"),
                            "output_language": (
                                ((persisted_scene.get("scene") or {}).get("script_meta") or {}).get("output_language")
                                or ((persisted_scene.get("scene") or {}).get("script") or {}).get("output_language")
                                or output_language
                            ),
                            "scene": persisted_scene.get("scene") or {},
                            "repaired": True,
                            "timestamp": persisted_scene.get("created_at") or datetime.now().isoformat(),
                        }
                    )
                    logger.info(
                        "[TA-SCENE] Repaired missing canonical scene %s for run_id=%s in %.0fms",
                        missing_scene_index,
                        run_id,
                        (time.perf_counter() - repair_started_at) * 1000,
                    )
                except SceneDialogueError as scene_exc:
                    scene_failure_meta = dict(getattr(scene_exc, "meta", {}) or {})
                    scene_build_failures.append(
                        {
                            "attempt": attempt_for_scenes,
                            "event_type": "final_scene_repair",
                            "scene_index": missing_scene_index,
                            "error_code": "SCENE_DIALOGUE_FAILED",
                            "message": str(scene_exc),
                            "meta": scene_failure_meta,
                            "timestamp": datetime.now().isoformat(),
                        }
                    )
                    await _broadcast_runtime_event(
                        {
                            "type": "tradingagents_scene_failed",
                            "run_id": run_id,
                            "active_run_id": run_id,
                            "upstream_run_id": upstream_run_id,
                            "ticker": ticker,
                            "attempt": attempt_for_scenes,
                            "scene_index": missing_scene_index,
                            "error_code": "SCENE_DIALOGUE_FAILED",
                            "message": str(scene_exc),
                            "meta": scene_failure_meta,
                            "timestamp": datetime.now().isoformat(),
                        }
                    )
                    raise

            canonical_scenes = decision_service.list_run_scenes(run_id, attempt=attempt_for_scenes)
            if len(canonical_scenes) != 13:
                raise SceneDialogueError(
                    f"Expected 13 canonical scenes, found {len(canonical_scenes)}.",
                    {
                        "attempt": attempt_for_scenes,
                        "scene_count": len(canonical_scenes),
                        "scene_failures": scene_build_failures + [
                            {
                                "reason": "missing_canonical_scenes",
                                "expected": 13,
                                "actual": len(canonical_scenes),
                            }
                        ],
                    },
                )

            scene_failures: List[Dict[str, Any]] = []
            for item in canonical_scenes:
                scene_obj = item.get("scene") or {}
                script = scene_obj.get("script") or {}
                script_meta = scene_obj.get("script_meta") or {}
                writer_source = str(
                    script.get("writer_source")
                    or script_meta.get("writer_source")
                    or ""
                ).strip().lower()
                validation_passed = script.get("validation_passed")
                if validation_passed is None:
                    validation_passed = script_meta.get("validation_passed")
                if writer_source != "llm" or validation_passed is not True:
                    scene_failures.append(
                        {
                            "scene_index": item.get("scene_index"),
                            "scene_label": item.get("scene_label"),
                            "writer_source": writer_source or None,
                            "validation_passed": validation_passed,
                            "writer_error": script.get("writer_error") or script_meta.get("writer_error"),
                            "reason": "scene_not_llm_validated",
                        }
                    )
            if scene_failures:
                raise SceneDialogueError(
                    f"Canonical scene dialogue validation failed for {len(scene_failures)} scene(s).",
                    {
                        "attempt": attempt_for_scenes,
                        "scene_count": len(canonical_scenes),
                        "scene_failures": scene_failures,
                    },
                )

            decision_source = completion_event.get("decision") or completion_event.get("prediction") or final_state.get("final_trade_decision")
            decision = _extract_decision_keyword(decision_source)
            prediction = str(completion_event.get("prediction") or final_state.get("final_trade_decision") or decision)
            try:
                confidence = float(completion_event.get("confidence") or 0.0)
            except Exception:
                confidence = 0.0
            elapsed_seconds = completion_event.get("elapsed_seconds")

            run_result = {
                "run_id": run_id,
                "ticker": ticker,
                "trade_date": trade_date,
                "research_depth": depth,
                "decision": decision,
                "prediction": prediction,
                "confidence": confidence,
                "elapsed_seconds": elapsed_seconds,
                "state": final_state,
                "full_agent_reports": full_agent_reports,
                "attempt": retry_state.get("attempt"),
                "max_attempts": retry_state.get("max_attempts"),
                "invalid_agents": retry_state.get("invalid_agents") or [],
                "attempts": retry_state.get("attempts") or [],
                "llm_calls": completion_event.get("llm_calls") or final_state.get("llm_calls") or pipeline_state.get("llm_calls", 0),
                "tool_calls": completion_event.get("tool_calls") or final_state.get("tool_calls") or pipeline_state.get("tool_calls", 0),
                "tokens_in": completion_event.get("tokens_in") or final_state.get("tokens_in") or pipeline_state.get("tokens_in", 0),
                "tokens_out": completion_event.get("tokens_out") or final_state.get("tokens_out") or pipeline_state.get("tokens_out", 0),
            "run_timestamp": completion_event.get("timestamp"),
            "llm_provider": provider,
            "quick_model": quick_model,
            "deep_model": deep_model,
            **engine_meta,
        }

            package = decision_service.build_decision_package(run_result, portfolio_state)
            raw_state = dict(package.get("raw_state") or {})
            raw_state["complete_report"] = complete_report
            raw_state["upstream_artifacts"] = artifacts_payload
            raw_state["upstream_run_id"] = upstream_run_id
            raw_state["full_agent_reports"] = full_agent_reports
            raw_state["attempt"] = retry_state.get("attempt")
            raw_state["max_attempts"] = retry_state.get("max_attempts")
            raw_state["invalid_agents"] = retry_state.get("invalid_agents") or []
            raw_state["attempts"] = retry_state.get("attempts") or []
            raw_state["upstream_generated_at"] = completion_event.get("timestamp")
            raw_state["llm_provider"] = provider
            raw_state["quick_model"] = quick_model
            raw_state["deep_model"] = deep_model
            raw_state["llm_calls"] = run_result.get("llm_calls")
            raw_state["tool_calls"] = run_result.get("tool_calls")
            raw_state["tokens_in"] = run_result.get("tokens_in")
            raw_state["tokens_out"] = run_result.get("tokens_out")
            raw_state["prompt_tokens"] = run_result.get("tokens_in")
            raw_state["completion_tokens"] = run_result.get("tokens_out")
            raw_state.update(engine_meta)
            package["raw_state"] = raw_state
            package["llm_provider"] = provider
            package["quick_model"] = quick_model
            package["deep_model"] = deep_model
            package["complete_report"] = complete_report
            package["upstream_run_id"] = upstream_run_id
            package["attempt"] = retry_state.get("attempt")
            package["max_attempts"] = retry_state.get("max_attempts")
            package["invalid_agents"] = retry_state.get("invalid_agents") or []
            package["attempts"] = retry_state.get("attempts") or []
            package["upstream_generated_at"] = completion_event.get("timestamp")
            package["llm_calls"] = run_result.get("llm_calls")
            package["tool_calls"] = run_result.get("tool_calls")
            package["tokens_in"] = run_result.get("tokens_in")
            package["tokens_out"] = run_result.get("tokens_out")
            package.update(engine_meta)

            saved = decision_service.save_decision_package(package, portfolio_state)
            await rc.publish_event(
                "trading_floor_events",
                "decision_package_updated",
                {
                    "type": "decision_package_updated",
                    "run_id": run_id,
                    "package": saved,
                },
            )
            await _broadcast_terminal_pipeline_state(saved, status="COMPLETE")

        except asyncio.CancelledError:
            with suppress(Exception):
                await abort_upstream_run(upstream_run_id)
            abort_request = get_abort_request(run_id) or {}
            abort_reason = str(abort_request.get("reason") or "").strip().lower()
            user_requested_abort = abort_reason in {"user", "manual", "ui_stop", "user_stop"}
            if user_requested_abort:
                terminal_status = "ABORTED"
                terminal_message = "TradingAgents analysis aborted by user."
            else:
                terminal_status = "FAILED"
                terminal_message = "TradingAgents analysis was interrupted before completion."
            saved = decision_service.mark_run_failed(
                run_id=run_id,
                ticker=ticker,
                error_message=terminal_message,
                portfolio_state=portfolio_state,
                status=terminal_status,
            )
            if not is_shutting_down():
                await rc.publish_event(
                    "trading_floor_events",
                    "decision_package_updated",
                    {
                        "type": "decision_package_updated",
                        "run_id": run_id,
                        "package": saved,
                    },
                )
                await _broadcast_terminal_pipeline_state(
                    saved,
                    status=terminal_status,
                    action=terminal_status,
                    message=terminal_message,
                )
            raise

        except Exception as exc:
            logger.error("[TA-RUN] Upstream execution failed: %s", exc, exc_info=True)
            failed_error_code = str(failed_event.get("error_code") or "").strip().upper() if isinstance(failed_event, dict) else ""
            failed_error_message = str(
                (failed_event.get("error_message") if isinstance(failed_event, dict) else "")
                or (failed_event.get("error") if isinstance(failed_event, dict) else "")
                or (failed_event.get("message") if isinstance(failed_event, dict) else "")
                or failure_meta.get("error_message")
                or str(exc)
            ).strip()
            failed_stage = str(
                (failed_event.get("failed_stage") if isinstance(failed_event, dict) else "")
                or failure_meta.get("failed_stage")
                or ""
            ).strip() or None
            failed_agent = str(
                (failed_event.get("failed_agent") if isinstance(failed_event, dict) else "")
                or failure_meta.get("failed_agent")
                or ""
            ).strip() or None
            upstream_status_source = str(
                failure_meta.get("upstream_status_source")
                or ("sidecar_event" if isinstance(failed_event, dict) and failed_event else "backend_exception")
            ).strip()
            failed_invalid_agents = []
            if isinstance(failed_event, dict):
                failed_invalid_agents = failed_event.get("invalid_agents") or []
            scene_failure_meta: Dict[str, Any] = {}
            if isinstance(exc, SceneDialogueError):
                failed_error_code = "SCENE_DIALOGUE_FAILED"
                scene_failure_meta = dict(getattr(exc, "meta", {}) or {})
            if not failed_error_code:
                failed_error_code = str(failure_meta.get("error_code") or "").strip().upper()
            if not failed_error_code and (failed_invalid_agents or retry_state.get("invalid_agents")):
                failed_error_code = "REPORT_QUALITY_FAILED"
            if not failed_error_code:
                failed_error_code = "FAILED"
            saved = decision_service.mark_run_failed(
                run_id=run_id,
                ticker=ticker,
                error_message=failed_error_message,
                portfolio_state=portfolio_state,
                status="FAILED",
            )
            if failed_error_code == "REPORT_QUALITY_FAILED":
                raw_state = dict(saved.get("raw_state") or {})
                raw_state["attempt"] = retry_state.get("attempt")
                raw_state["max_attempts"] = retry_state.get("max_attempts")
                raw_state["invalid_agents"] = failed_invalid_agents or retry_state.get("invalid_agents") or []
                raw_state["attempts"] = failed_event.get("attempts") or retry_state.get("attempts") or []
                raw_state["llm_provider"] = provider
                raw_state["quick_model"] = quick_model
                raw_state["deep_model"] = deep_model
                saved["raw_state"] = raw_state
                saved["llm_provider"] = provider
                saved["quick_model"] = quick_model
                saved["deep_model"] = deep_model
                saved["error_code"] = failed_error_code
                saved["error_message"] = failed_error_message
                saved = decision_service.save_decision_package(saved, portfolio_state, transition="run_failed")
            elif failed_error_code == "SCENE_DIALOGUE_FAILED":
                scene_failures = scene_failure_meta.get("scene_failures") or []
                if not scene_failures and (
                    scene_failure_meta.get("scene_index") is not None
                    or scene_failure_meta.get("scene_label")
                    or scene_failure_meta.get("writer_error")
                ):
                    scene_failures = [
                        {
                            "scene_index": scene_failure_meta.get("scene_index"),
                            "scene_label": scene_failure_meta.get("scene_label"),
                            "scene_kind": scene_failure_meta.get("scene_kind"),
                            "lead_agent": scene_failure_meta.get("lead_agent"),
                            "writer_mode": scene_failure_meta.get("writer_mode"),
                            "writer_provider": scene_failure_meta.get("writer_provider"),
                            "writer_model": scene_failure_meta.get("writer_model"),
                            "writer_source": scene_failure_meta.get("writer_source"),
                            "writer_latency_ms": scene_failure_meta.get("writer_latency_ms"),
                            "writer_attempts": scene_failure_meta.get("writer_attempts") or [],
                            "validation_passed": scene_failure_meta.get("validation_passed"),
                            "writer_error": scene_failure_meta.get("writer_error"),
                            "reason": "scene_dialogue_generation_failed",
                        }
                    ]
                raw_state = dict(saved.get("raw_state") or {})
                raw_state["attempt"] = retry_state.get("attempt")
                raw_state["max_attempts"] = retry_state.get("max_attempts")
                raw_state["scene_failures"] = scene_failures
                raw_state["scene_count"] = scene_failure_meta.get("scene_count")
                raw_state["attempts"] = failed_event.get("attempts") or retry_state.get("attempts") or []
                raw_state["llm_provider"] = provider
                raw_state["quick_model"] = quick_model
                raw_state["deep_model"] = deep_model
                saved["raw_state"] = raw_state
                saved["llm_provider"] = provider
                saved["quick_model"] = quick_model
                saved["deep_model"] = deep_model
                saved["error_code"] = failed_error_code
                saved["error_message"] = failed_error_message
                saved = decision_service.save_decision_package(saved, portfolio_state, transition="run_failed")
            else:
                raw_state = dict(saved.get("raw_state") or {})
                raw_state["attempt"] = retry_state.get("attempt")
                raw_state["max_attempts"] = retry_state.get("max_attempts")
                raw_state["invalid_agents"] = failed_invalid_agents or retry_state.get("invalid_agents") or []
                raw_state["attempts"] = failed_event.get("attempts") or retry_state.get("attempts") or []
                raw_state["failed_stage"] = failed_stage
                raw_state["failed_agent"] = failed_agent
                raw_state["upstream_status_source"] = upstream_status_source
                raw_state["upstream_run_id"] = upstream_run_id
                raw_state["llm_provider"] = provider
                raw_state["quick_model"] = quick_model
                raw_state["deep_model"] = deep_model
                saved["raw_state"] = raw_state
                saved["llm_provider"] = provider
                saved["quick_model"] = quick_model
                saved["deep_model"] = deep_model
                saved["error_code"] = failed_error_code
                saved["error_message"] = failed_error_message
                saved = decision_service.save_decision_package(saved, portfolio_state, transition="run_failed")

            raw_state_common = dict(saved.get("raw_state") or {})
            if "attempt" not in raw_state_common:
                raw_state_common["attempt"] = retry_state.get("attempt")
            if "max_attempts" not in raw_state_common:
                raw_state_common["max_attempts"] = retry_state.get("max_attempts")
            if "attempts" not in raw_state_common:
                raw_state_common["attempts"] = failed_event.get("attempts") or retry_state.get("attempts") or []
            if failed_stage:
                raw_state_common["failed_stage"] = failed_stage
            if failed_agent:
                raw_state_common["failed_agent"] = failed_agent
            raw_state_common["upstream_status_source"] = upstream_status_source
            raw_state_common["upstream_run_id"] = upstream_run_id
            saved["raw_state"] = raw_state_common
            saved["error_code"] = failed_error_code
            saved["error_message"] = failed_error_message
            saved = decision_service.save_decision_package(saved, portfolio_state, transition="run_failed")
            if not is_shutting_down():
                if failed_error_code == "SCENE_DIALOGUE_FAILED":
                    await rc.publish_event(
                        "trading_floor_events",
                        "tradingagents_scene_failed",
                        {
                            "type": "tradingagents_scene_failed",
                            "run_id": run_id,
                            "upstream_run_id": upstream_run_id,
                            "attempt": retry_state.get("attempt"),
                            "max_attempts": retry_state.get("max_attempts"),
                            "scene_failures": (saved.get("raw_state") or {}).get("scene_failures") or [],
                            "message": failed_error_message,
                            "ticker": ticker,
                            "timestamp": datetime.now().isoformat(),
                        },
                    )
                await rc.publish_event(
                    "trading_floor_events",
                    "run_failed",
                    {
                        "type": "run_failed",
                        "run_id": run_id,
                        "upstream_run_id": upstream_run_id,
                        "error_code": failed_error_code or None,
                        "error_message": failed_error_message,
                        "failed_stage": failed_stage,
                        "failed_agent": failed_agent,
                        "upstream_status_source": upstream_status_source,
                        "invalid_agents": failed_invalid_agents or retry_state.get("invalid_agents") or [],
                        "scene_failures": (
                            (saved.get("raw_state") or {}).get("scene_failures") or []
                            if failed_error_code == "SCENE_DIALOGUE_FAILED"
                            else []
                        ),
                        "attempt": retry_state.get("attempt"),
                        "max_attempts": retry_state.get("max_attempts"),
                        "message": failed_error_message,
                        "ticker": ticker,
                        "timestamp": datetime.now().isoformat(),
                    },
                )
                await rc.publish_event(
                    "trading_floor_events",
                    "decision_package_updated",
                    {
                        "type": "decision_package_updated",
                        "run_id": run_id,
                        "package": saved,
                    },
                )
                await _broadcast_terminal_pipeline_state(
                    saved,
                    status="FAILED",
                    action=failed_error_code or "FAILED",
                    error_code=failed_error_code or None,
                    message=failed_error_message,
                )

        finally:
            autonomous_trader.is_analyzing = False
            if autonomous_trader._active_task is _active_ta_task:
                autonomous_trader._active_task = None
            clear_active_run(run_id)
            clear_abort_request(run_id)
            _active_ta_task = None
            _active_ta_sidecar_run_id = None

    autonomous_trader.is_analyzing = True

    def _start_background_run() -> None:
        global _active_ta_task
        _active_ta_task = asyncio.create_task(run_with_error_handling())
        autonomous_trader._active_task = _active_ta_task

    asyncio.get_running_loop().call_soon(_start_background_run)

    logger.info("[TA-RUN] Started upstream run for %s (depth=%s, run_id=%s, upstream_run_id=%s)", ticker, depth, run_id, upstream_run_id)
    return {
        "success": True,
        "ticker": ticker,
        "run_id": run_id,
        "upstream_run_id": upstream_run_id,
        "research_depth": depth,
        "upstream_rounds": _map_depth_to_rounds(depth),
    }


@router.post("/trading-agents/stop")
async def stop_trading_agents():
    """Abort current TradingAgents run."""
    raise HTTPException(
        status_code=410,
        detail="Deprecated: /trading-agents/stop is disabled. Stop runs in the browser runner.",
    )

    global _active_ta_sidecar_run_id, _active_ta_task

    aborted = False
    active_run = load_active_run()
    decision_service = get_tradingagents_decision_service()

    if active_run:
        run_id = active_run.get("run_id")
        request_abort(run_id, reason="user", source="api_stop")
        update_active_run(run_id, status="aborting")
        aborted = True

    upstream_run_id = (
        (_active_ta_sidecar_run_id or "")
        or (active_run.get("upstream_run_id") if isinstance(active_run, dict) else "")
        or (active_run.get("run_id") if isinstance(active_run, dict) else "")
    )
    if upstream_run_id:
        with suppress(Exception):
            await abort_upstream_run(str(upstream_run_id))
        aborted = True

    if _active_ta_task and not _active_ta_task.done():
        _active_ta_task.cancel()
        aborted = True

    if autonomous_trader.abort_current_run():
        aborted = True
    else:
        autonomous_trader.is_analyzing = False
        autonomous_trader._active_task = None

    if aborted:
        logger.info("[TA-RUN] Run aborted by user via shared AutonomousTrader.")
        
        await rc.publish_event("trading_floor_events", "run_aborted", {
            "type": "run_aborted",
            "message": "TradingAgents analysis aborted by user.",
            "run_id": active_run.get("run_id") if isinstance(active_run, dict) else None,
            "upstream_run_id": upstream_run_id or None,
            "timestamp": datetime.now().isoformat(),
        })
        
        # Keep the aborted result visible until the next run starts.
        from src.api.trading_floor_simple import pipeline_state, portfolio_state, manager
        saved = None
        if active_run and active_run.get("run_id") and active_run.get("ticker"):
            saved = decision_service.mark_run_failed(
                run_id=active_run["run_id"],
                ticker=active_run["ticker"],
                error_message="TradingAgents analysis aborted by user.",
                portfolio_state=portfolio_state,
                status="ABORTED",
            )
            await rc.publish_event("trading_floor_events", "decision_package_updated", {
                "type": "decision_package_updated",
                "run_id": active_run["run_id"],
                "package": saved,
            })
        raw_state = (saved or {}).get("raw_state") or {}
        pipeline_state.update({
            "phase": "ABORTED",
            "ticker": (active_run or {}).get("ticker") or pipeline_state.get("ticker"),
            "trade_date": (active_run or {}).get("trade_date") or pipeline_state.get("trade_date"),
            "llm_provider": pipeline_state.get("llm_provider"),
            "quick_model": pipeline_state.get("quick_model"),
            "deep_model": pipeline_state.get("deep_model"),
            "phase_num": 5,
            "current_phase": 5,
            "pipeline_mode": "tradingagents",
            "active_run_id": (active_run or {}).get("run_id") or pipeline_state.get("active_run_id"),
            "current_step": "risk_judge",
            "agent_display_name": "Risk Judge",
            "research_depth": (active_run or {}).get("depth") or pipeline_state.get("research_depth"),
            "status": "ABORTED",
            "action": "ABORTED",
            "llm_calls": raw_state.get("engine_llm_calls") or raw_state.get("llm_calls") or pipeline_state.get("llm_calls", 0),
            "tool_calls": raw_state.get("engine_tool_calls") or raw_state.get("tool_calls") or pipeline_state.get("tool_calls", 0),
            "attempt": raw_state.get("attempt") or pipeline_state.get("attempt", 1),
            "max_attempts": raw_state.get("max_attempts") or pipeline_state.get("max_attempts", 1),
            "timestamp": datetime.now().isoformat(),
        })
        await manager.broadcast({
            "type": "pipeline_phase",
            "phase": pipeline_state.get("phase", "IDLE"),
            "ticker": pipeline_state.get("ticker"),
            "trade_date": pipeline_state.get("trade_date"),
            "llm_provider": pipeline_state.get("llm_provider"),
            "quick_model": pipeline_state.get("quick_model"),
            "deep_model": pipeline_state.get("deep_model"),
            "cycle": pipeline_state.get("cycle", 1),
            "regime": pipeline_state.get("regime"),
            "premortem_data": pipeline_state.get("premortem_data"),
            "war_room_brief": pipeline_state.get("war_room_brief"),
            "phase_num": pipeline_state.get("phase_num", 0),
            "pipeline_mode": pipeline_state.get("pipeline_mode"),
            "run_id": pipeline_state.get("active_run_id"),
            "active_run_id": pipeline_state.get("active_run_id"),
            "current_step": pipeline_state.get("current_step"),
            "agent_display_name": pipeline_state.get("agent_display_name"),
            "research_depth": pipeline_state.get("research_depth"),
            "status": pipeline_state.get("status", "WAITING"),
            "action": pipeline_state.get("action", "WAITING"),
            "llm_calls": pipeline_state.get("llm_calls", 0),
            "tool_calls": pipeline_state.get("tool_calls", 0),
            "tokens_in": pipeline_state.get("tokens_in", 0),
            "tokens_out": pipeline_state.get("tokens_out", 0),
            "attempt": pipeline_state.get("attempt", 1),
            "max_attempts": pipeline_state.get("max_attempts", 1),
            "timestamp": pipeline_state.get("timestamp"),
        })
        _active_ta_sidecar_run_id = None
        
        return {"success": True, "message": "Run aborted."}

    # No active task, but UI state can still be stale after a failed run.
    try:
        from src.api.trading_floor_simple import pipeline_state, clear_pipeline_state
        phase = str(pipeline_state.get("phase") or "").strip().lower()
        stale_phase = phase not in {"", "idle", "ready", "complete", "failed", "aborted"}
        stale_active = bool(pipeline_state.get("active_run_id") or pipeline_state.get("run_id")) and stale_phase
        if stale_active or stale_phase:
            clear_pipeline_state()
            return {"success": True, "message": "No active run, stale UI state reset."}
    except Exception:
        pass

    return {"success": False, "message": "No active run to stop."}


@router.post("/trading-agents/terminate")
async def terminate_trading_agents():
    """Compatibility alias for stop endpoint used by older UI clients."""
    raise HTTPException(
        status_code=410,
        detail="Deprecated: /trading-agents/terminate is disabled. Stop runs in the browser runner.",
    )


@router.get("/trading-agents/runs")
async def list_trading_agents_runs(limit: int = 20):
    try:
        service = get_tradingagents_decision_service()
        runs = service.list_run_summaries(limit=limit)
        if not runs:
            runs = _artifact_run_summaries(limit=limit)
        return {
            "runs": runs,
            "runtime": service.get_scene_dialogue_runtime_info(),
        }
    except Exception as exc:
        logger.exception("[TA-RUN] Failed to list run summaries: %s", exc)
        return {"runs": [], "runtime": None}


@router.get("/trading-agents/runs/latest")
async def get_latest_trading_agents_run():
    try:
        service = get_tradingagents_decision_service()
        latest, rebalance = await asyncio.gather(
            asyncio.to_thread(service.get_latest_run_summary),
            asyncio.to_thread(service.get_latest_rebalance),
        )
        if not latest:
            artifact_runs = _artifact_run_summaries(limit=1)
            latest = artifact_runs[0] if artifact_runs else None
        return {
            "run": latest,
            "rebalance": rebalance,
            "runtime": service.get_scene_dialogue_runtime_info(),
        }
    except Exception as exc:
        logger.exception("[TA-RUN] Failed to fetch latest run summary: %s", exc)
        return {
            "run": None,
            "rebalance": None,
            "runtime": None,
        }


@router.get("/portfolio/live")
async def get_admin_portfolio_live():
    from src.api.trading_floor_simple import portfolio_state
    try:
        from src.analytics.data_access import get_data_access
        from src.api.trading_floor_simple import _run_portfolio_sync_call, sync_portfolio_state_from_sqlite

        service = get_tradingagents_decision_service()
        data_access = get_data_access()
        await _run_portfolio_sync_call(
            sync_portfolio_state_from_sqlite,
            timeout_seconds=2.0,
            fallback={},
            label="get_admin_portfolio_live sync_portfolio_state_from_sqlite",
        )

        snapshot_ts = datetime.now().isoformat()
        portfolio_snapshot = await _run_portfolio_sync_call(
            lambda: service._portfolio_rows(portfolio_state, include_policy=False),
            timeout_seconds=4.0,
            fallback={
                "rows": [],
                "total_value": portfolio_state.get("total_value", 0.0),
                "cash": portfolio_state.get("cash", 0.0),
                "cash_weight_pct": 0.0,
            },
            label="get_admin_portfolio_live portfolio_rows",
        )
        performance = await _run_portfolio_sync_call(
            lambda: service.get_performance_summary(portfolio_state, portfolio_snapshot=portfolio_snapshot),
            timeout_seconds=4.0,
            fallback={
                "starting_equity": portfolio_state.get("total_value", 0.0),
                "baseline_timestamp": None,
                "portfolio_return_pct": 0.0,
                "sp500_return_pct": 0.0,
                "realized_pnl": 0.0,
                "unrealized_pnl": 0.0,
            },
            label="get_admin_portfolio_live performance_summary",
        )
        closed_trades = await _run_portfolio_sync_call(
            lambda: data_access.list_closed_trades(limit=0),
            timeout_seconds=3.0,
            fallback=[],
            label="get_admin_portfolio_live closed_trades",
        )
        total_trades, wins, win_rate = service._compute_win_rate(closed_trades)

        rows = portfolio_snapshot.get("rows", [])
        top_weight = max((row.get("weight_pct", 0) for row in rows), default=0.0)

        return {
            "snapshot": {
                "timestamp": snapshot_ts,
                "total_value": portfolio_snapshot.get("total_value", 0.0),
                "cash": portfolio_snapshot.get("cash", 0.0),
                "cash_weight_pct": portfolio_snapshot.get("cash_weight_pct", 0.0),
                "open_positions_count": len(rows),
                "top_position_weight_pct": round(top_weight, 2),
                "position_rows": rows,
            },
            "performance": {
                "starting_equity": performance.get("starting_equity", 0.0),
                "baseline_timestamp": performance.get("baseline_timestamp"),
                "portfolio_return_pct": performance.get("portfolio_return_pct", 0.0),
                "sp500_return_pct": performance.get("sp500_return_pct", 0.0),
                "excess_return_pct": round(
                    (performance.get("portfolio_return_pct", 0.0) or 0.0)
                    - (performance.get("sp500_return_pct", 0.0) or 0.0),
                    2,
                ),
                "realized_pnl": performance.get("realized_pnl", 0.0),
                "unrealized_pnl": performance.get("unrealized_pnl", 0.0),
            },
            "trades": {
                "closed_trades_count": total_trades,
                "win_rate_pct": win_rate,
            },
        }
    except Exception as exc:
        logger.exception("[PORTFOLIO] Failed to fetch admin live snapshot: %s", exc)
        cash = float(portfolio_state.get("cash") or 0.0)
        total_value = float(portfolio_state.get("total_value") or cash)
        return {
            "snapshot": {
                "timestamp": datetime.now().isoformat(),
                "total_value": total_value,
                "cash": cash,
                "cash_weight_pct": 0.0,
                "open_positions_count": 0,
                "top_position_weight_pct": 0.0,
                "position_rows": [],
            },
            "performance": {
                "starting_equity": total_value,
                "baseline_timestamp": None,
                "portfolio_return_pct": 0.0,
                "sp500_return_pct": 0.0,
                "excess_return_pct": 0.0,
                "realized_pnl": 0.0,
                "unrealized_pnl": 0.0,
            },
            "trades": {
                "closed_trades_count": 0,
                "win_rate_pct": 0.0,
            },
        }


def _format_event(
    event_id: str,
    timestamp: str,
    source_type: str,
    source_id: str,
    ticker: Optional[str],
    category: str,
    status: str,
    headline: str,
    detail: Optional[str] = None,
    reason: Optional[str] = None,
    attempt_id: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "event_id": event_id,
        "timestamp": timestamp,
        "source_type": source_type,
        "source_id": source_id,
        "ticker": ticker,
        "category": category,
        "status": status,
        "headline": headline,
        "detail": detail,
        "reason": reason,
        "attempt_id": attempt_id,
    }


def _attempt_to_event(attempt: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    timestamp = attempt.get("completed_at") or attempt.get("created_at")
    if not timestamp:
        return None
    source_type = (attempt.get("source_type") or "UNKNOWN").upper()
    action = (attempt.get("requested_action") or "ACTION").upper()
    ticker = attempt.get("ticker")
    status = (attempt.get("status") or "UNKNOWN").upper()
    category = source_type.lower()
    headline = f"{source_type} {action}"
    if ticker:
        headline = f"{source_type} {action} {ticker}"
    detail = attempt.get("error_message") or (attempt.get("result") or {}).get("error")
    reason = (attempt.get("result") or {}).get("message")
    return _format_event(
        event_id=f"attempt-{attempt.get('attempt_id')}",
        timestamp=timestamp,
        source_type=source_type,
        source_id=attempt.get("source_id"),
        ticker=ticker,
        category=category,
        status=status,
        headline=headline,
        detail=detail,
        reason=reason,
        attempt_id=attempt.get("attempt_id"),
    )


def _run_to_events(run: Dict[str, Any]) -> List[Dict[str, Any]]:
    events = []
    run_id = run.get("run_id")
    ticker = run.get("ticker")
    status = (run.get("run_status") or "RUNNING").upper()
    if run.get("created_at"):
        events.append(_format_event(
            event_id=f"run-start-{run_id}",
            timestamp=run.get("created_at"),
            source_type="RUN",
            source_id=run_id,
            ticker=ticker,
            category="run",
            status="RUNNING",
            headline=f"Run started: {ticker or 'UNKNOWN'}",
            detail=run.get("research_depth"),
        ))
    if run.get("completed_at"):
        events.append(_format_event(
            event_id=f"run-complete-{run_id}",
            timestamp=run.get("completed_at"),
            source_type="RUN",
            source_id=run_id,
            ticker=ticker,
            category="run",
            status=status,
            headline=f"Run {status.lower()}: {ticker or 'UNKNOWN'}",
            detail=run.get("reasoning") or run.get("prediction"),
            reason=run.get("error_message"),
        ))
    return events


def _rebalance_to_events(rebalance: Dict[str, Any]) -> List[Dict[str, Any]]:
    events = []
    rebalance_id = rebalance.get("rebalance_id")
    status = (rebalance.get("approval_status") or "PENDING").upper()
    if rebalance.get("created_at"):
        events.append(_format_event(
            event_id=f"rebalance-preview-{rebalance_id}",
            timestamp=rebalance.get("created_at"),
            source_type="REBALANCE",
            source_id=rebalance_id,
            ticker=None,
            category="rebalance",
            status=status,
            headline="Rebalance preview created",
            detail=rebalance.get("error_message"),
            reason=rebalance.get("error_code"),
            attempt_id=rebalance.get("latest_attempt_id"),
        ))
    if rebalance.get("approved_at"):
        events.append(_format_event(
            event_id=f"rebalance-approved-{rebalance_id}",
            timestamp=rebalance.get("approved_at"),
            source_type="REBALANCE",
            source_id=rebalance_id,
            ticker=None,
            category="rebalance",
            status="APPROVED",
            headline="Rebalance approved",
            detail=rebalance.get("error_message"),
            reason=rebalance.get("error_code"),
            attempt_id=rebalance.get("latest_attempt_id"),
        ))
    if rebalance.get("executed_at"):
        events.append(_format_event(
            event_id=f"rebalance-executed-{rebalance_id}",
            timestamp=rebalance.get("executed_at"),
            source_type="REBALANCE",
            source_id=rebalance_id,
            ticker=None,
            category="rebalance",
            status="EXECUTED",
            headline="Rebalance executed",
            detail=rebalance.get("error_message"),
            reason=rebalance.get("error_code"),
            attempt_id=rebalance.get("latest_attempt_id"),
        ))
    return events


_TA_ACTION_PATTERN = re.compile(
    r"FINAL\s+TRANSACTION\s+PROPOSAL\s*:\s*\**\s*(BUY|SELL|HOLD|LIQUIDATE|NEUTRAL)\b",
    re.IGNORECASE,
)


def _artifact_runs_root() -> Path:
    return Path(os.getenv("UPSTREAM_RUNS_DIR", "/shared/tradingagents-runs"))


def _read_json_file(path: Path) -> Optional[Dict[str, Any]]:
    try:
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def _read_text_file(path: Path) -> str:
    try:
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def _parse_trade_date_from_run_id(run_id: str) -> Optional[str]:
    match = re.search(r"^ta-[^-]+-(\d{8})-", str(run_id or ""))
    if not match:
        return None
    raw = match.group(1)
    try:
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
    except Exception:
        return None


def _extract_action_from_text(text: str) -> Optional[str]:
    if not text:
        return None
    match = _TA_ACTION_PATTERN.search(text)
    if match:
        return str(match.group(1)).upper()
    return None


def _artifact_run_dirs(limit: Optional[int] = None) -> List[Path]:
    root = _artifact_runs_root()
    if not root.exists():
        return []
    candidates = [item for item in root.iterdir() if item.is_dir() and str(item.name).startswith("ta-")]
    candidates.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    if limit is not None and limit > 0:
        return candidates[:limit]
    return candidates


def _artifact_scene_from_detail(ticker: str, action: Optional[str], run_status: str, reasoning: str) -> Dict[str, Any]:
    status = str(run_status or "").upper()
    scene_state = "SUCCESS" if status == "COMPLETED" else ("FAILED" if status == "FAILED" else "PENDING")
    final_line = reasoning[:220] if reasoning else f"{ticker} artifact restored from sidecar runs."
    return {
        "schema_version": 1,
        "phase": "STEP_5_PORTFOLIO",
        "ticker": ticker or "UNKNOWN",
        "state": scene_state,
        "headline": "12 Portfolio Decision Report",
        "variant": "TradingAgents Timeline",
        "active_agents": ["Research Manager", "Risk Judge"],
        "lines": [
            {"speaker": "Research Manager", "text": f"{ticker} analysis restored from sidecar artifact."},
            {"speaker": "Risk Judge", "text": final_line},
        ],
        "script": {},
        "script_meta": {
            "scene_key": "TA_TIMELINE_12_PORTFOLIO",
            "scene_label": "12 Portfolio Decision Report",
            "scene_kind": "report_completed",
            "source_agent": "risk_judge",
            "source_report_slot": 12,
            "action": action,
        },
    }


def _artifact_run_detail_from_dir(run_dir: Path) -> Optional[Dict[str, Any]]:
    run_id = str(run_dir.name)
    final_state = _read_json_file(run_dir / "final_state.json") or {}
    full_reports = _read_json_file(run_dir / "full_agent_reports.json") or {}
    complete_report = _read_text_file(run_dir / "complete_report.md")

    ticker = str(final_state.get("company_of_interest") or "").strip().upper()
    if not ticker:
        parts = run_id.split("-")
        ticker = parts[1].upper() if len(parts) > 1 else "UNKNOWN"
    trade_date = str(final_state.get("trade_date") or _parse_trade_date_from_run_id(run_id) or "")

    generated_at = str(final_state.get("generated_at") or "").strip()
    fs_time = generated_at or datetime.fromtimestamp(run_dir.stat().st_mtime).isoformat()
    action = (
        _extract_action_from_text(complete_report)
        or _extract_action_from_text(str(final_state.get("risk_judge") or ""))
        or "HOLD"
    )

    reasoning = str(final_state.get("risk_judge") or "").strip()
    if not reasoning:
        reasoning = complete_report[:4000] if complete_report else ""
    report_excerpt = (complete_report or reasoning or "").strip()[:800]
    run_status = "COMPLETED"

    agent_reports: List[Dict[str, Any]] = []
    report_sections: Dict[str, bool] = {}
    for slot in TRADINGAGENTS_CANONICAL_REPORT_SLOTS:
        agent_id = str(slot.get("agent_id") or "")
        label = str(slot.get("label") or agent_id)
        display_name = normalize_tradingagents_agent_name(agent_id) or agent_id
        report_text = str(full_reports.get(agent_id) or final_state.get(agent_id) or "").strip()
        if not report_text:
            continue
        report_sections[agent_id] = True
        agent_reports.append({
            "agent": display_name,
            "agent_id": agent_id,
            "label": label,
            "report": report_text,
            "summary": report_text[:300],
        })

    raw_state = dict(full_reports) if isinstance(full_reports, dict) else {}
    if complete_report:
        raw_state.setdefault("final_trade_decision", complete_report)
    if action:
        raw_state.setdefault("recommended_action", action)
        raw_state.setdefault("model_action", action)

    scene = _artifact_scene_from_detail(ticker=ticker, action=action, run_status=run_status, reasoning=reasoning)
    report_sections_completed = len(report_sections)

    return {
        "run_id": run_id,
        "ticker": ticker,
        "trade_date": trade_date,
        "research_depth": None,
        "llm_provider": "nvidia",
        "quick_model": None,
        "deep_model": None,
        "schema_version": 1,
        "run_status": run_status,
        "model_action": action,
        "recommended_action": action,
        "execution_mode": None,
        "prediction": f"{ticker} artifact rehydrated",
        "reasoning": reasoning,
        "report_excerpt": report_excerpt,
        "confidence": 0.0,
        "approval_status": "PENDING",
        "proposed_quantity": None,
        "approved_quantity": None,
        "suggested_quantity": None,
        "current_shares": 0,
        "projected_weight_pct": None,
        "rebalance_needed": False,
        "portfolio_revision_at_completion": 0,
        "latest_attempt_id": None,
        "error_code": None,
        "error_message": None,
        "superseded_by_run_id": None,
        "sentiment": {},
        "eligibility": {
            "position_exists": False,
            "current_shares": 0,
            "can_buy": True,
            "can_add": False,
            "can_sell": False,
            "can_liquidate": False,
        },
        "sizing": {},
        "portfolio_risk": {},
        "scene": scene,
        "scene_count": max(1, report_sections_completed + 1),
        "latest_scene_index": 12 if report_sections_completed >= 12 else report_sections_completed,
        "latest_scene_label": "12 Portfolio Decision Report" if report_sections_completed >= 12 else "00 INIT",
        "latest_scene_attempt": 1,
        "performance": {},
        "agent_reports": agent_reports,
        "complete_report": complete_report,
        "attempt": 1,
        "max_attempts": 1,
        "invalid_agents": [],
        "attempts": [{"attempt": 1, "status": "completed", "started_at": fs_time, "completed_at": fs_time}],
        "upstream_generated_at": fs_time,
        "raw_state": raw_state,
        "reportSections": report_sections,
        "reportSectionsCompleted": report_sections_completed,
        "created_at": fs_time,
        "completed_at": fs_time,
        "approved_at": None,
        "executed_at": None,
    }


def _artifact_run_summary(detail: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "run_id": detail.get("run_id"),
        "ticker": detail.get("ticker"),
        "trade_date": detail.get("trade_date"),
        "research_depth": detail.get("research_depth"),
        "llm_provider": detail.get("llm_provider"),
        "quick_model": detail.get("quick_model"),
        "deep_model": detail.get("deep_model"),
        "schema_version": detail.get("schema_version", 1),
        "run_status": detail.get("run_status"),
        "model_action": detail.get("model_action"),
        "recommended_action": detail.get("recommended_action"),
        "execution_mode": detail.get("execution_mode"),
        "prediction": detail.get("prediction"),
        "reasoning": detail.get("reasoning"),
        "report_excerpt": detail.get("report_excerpt"),
        "confidence": detail.get("confidence", 0.0),
        "approval_status": detail.get("approval_status"),
        "error_code": detail.get("error_code"),
        "error_message": detail.get("error_message"),
        "scene": detail.get("scene") or {},
        "scene_count": detail.get("scene_count", 1),
        "latest_scene_index": detail.get("latest_scene_index"),
        "latest_scene_label": detail.get("latest_scene_label"),
        "latest_scene_attempt": detail.get("latest_scene_attempt", 1),
        "performance": detail.get("performance") or {},
        "agent_reports": detail.get("agent_reports") or [],
        "complete_report": detail.get("complete_report") or "",
        "attempt": detail.get("attempt"),
        "max_attempts": detail.get("max_attempts"),
        "invalid_agents": detail.get("invalid_agents") or [],
        "attempts": detail.get("attempts") or [],
        "upstream_generated_at": detail.get("upstream_generated_at"),
        "created_at": detail.get("created_at"),
        "completed_at": detail.get("completed_at"),
        "approved_at": detail.get("approved_at"),
        "executed_at": detail.get("executed_at"),
    }


def _artifact_run_detail(run_id: str) -> Optional[Dict[str, Any]]:
    run_dir = _artifact_runs_root() / str(run_id or "").strip()
    if not run_dir.exists() or not run_dir.is_dir():
        return None
    return _artifact_run_detail_from_dir(run_dir)


def _artifact_run_summaries(limit: int = 20) -> List[Dict[str, Any]]:
    summaries: List[Dict[str, Any]] = []
    for run_dir in _artifact_run_dirs(limit=limit):
        detail = _artifact_run_detail_from_dir(run_dir)
        if not detail:
            continue
        summaries.append(_artifact_run_summary(detail))
    return summaries


@router.get("/execution/events")
async def get_execution_events(limit: int = 50):
    service = get_tradingagents_decision_service()
    attempts = service.list_execution_attempts(limit=limit * 2)
    runs = service.list_runs(limit=limit)
    rebalances = service.list_rebalances(limit=limit)

    events: List[Dict[str, Any]] = []
    for attempt in attempts:
        event = _attempt_to_event(attempt)
        if event:
            events.append(event)
    for run in runs:
        events.extend(_run_to_events(run))
    for rebalance in rebalances:
        events.extend(_rebalance_to_events(rebalance))

    events = [event for event in events if event.get("timestamp")]
    events.sort(key=lambda item: item["timestamp"], reverse=True)
    return {"events": events[:limit]}


@router.get("/execution/rationale/latest")
async def get_latest_execution_rationale():
    service = get_tradingagents_decision_service()
    latest_run = service.get_latest_run_summary()
    if latest_run and (
        latest_run.get("reasoning")
        or latest_run.get("prediction")
        or latest_run.get("report_excerpt")
        or latest_run.get("error_message")
    ):
        updated_at = latest_run.get("completed_at") or latest_run.get("created_at")
        return {
            "context_type": "run",
            "context_id": latest_run.get("run_id"),
            "ticker": latest_run.get("ticker"),
            "action": latest_run.get("recommended_action") or latest_run.get("model_action"),
            "status": latest_run.get("run_status"),
            "headline": f"{latest_run.get('ticker') or 'RUN'} {latest_run.get('run_status') or 'UPDATE'}",
            "reasoning": latest_run.get("reasoning"),
            "prediction": latest_run.get("prediction"),
            "report_excerpt": latest_run.get("report_excerpt"),
            "agent_reports": latest_run.get("agent_reports") or [],
            "error_message": latest_run.get("error_message"),
            "updated_at": updated_at,
        }

    latest_rebalance = service.get_latest_rebalance()
    if latest_rebalance:
        scene = latest_rebalance.get("scene") or {}
        lines = scene.get("lines") or []
        reasoning = None
        if lines:
            reasoning = lines[0].get("text")
        updated_at = (
            latest_rebalance.get("executed_at")
            or latest_rebalance.get("approved_at")
            or latest_rebalance.get("created_at")
        )
        return {
            "context_type": "rebalance",
            "context_id": latest_rebalance.get("rebalance_id"),
            "ticker": None,
            "action": "REBALANCE",
            "status": latest_rebalance.get("approval_status"),
            "headline": "Rebalance package update",
            "reasoning": reasoning or latest_rebalance.get("error_message"),
            "prediction": None,
            "report_excerpt": None,
            "agent_reports": [],
            "error_message": latest_rebalance.get("error_message"),
            "updated_at": updated_at,
        }

    attempts = service.list_execution_attempts(limit=1)
    if attempts:
        attempt = attempts[0]
        updated_at = attempt.get("completed_at") or attempt.get("created_at")
        result = attempt.get("result") or {}
        return {
            "context_type": "attempt",
            "context_id": attempt.get("attempt_id"),
            "ticker": attempt.get("ticker"),
            "action": attempt.get("requested_action"),
            "status": attempt.get("status"),
            "headline": f"{attempt.get('source_type')} {attempt.get('requested_action')}",
            "reasoning": attempt.get("error_message") or result.get("error") or result.get("message"),
            "prediction": None,
            "report_excerpt": None,
            "agent_reports": [],
            "error_message": attempt.get("error_message"),
            "updated_at": updated_at,
        }

    return {
        "context_type": "none",
        "context_id": None,
        "ticker": None,
        "action": None,
        "status": None,
        "headline": "No recent events",
        "reasoning": None,
        "prediction": None,
        "report_excerpt": None,
        "agent_reports": [],
        "error_message": None,
        "updated_at": None,
    }


@router.get("/trading-agents/runs/{run_id}")
async def get_trading_agents_run(run_id: str):
    service = get_tradingagents_decision_service()
    run = service.get_run(run_id)
    if not run:
        run = _artifact_run_detail(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    run["runtime"] = service.get_scene_dialogue_runtime_info()
    return run


@router.post("/trading-agents/runs/{run_id}/approve")
async def approve_trading_agents_run(run_id: str, request: Request):
    service = get_tradingagents_decision_service()
    data = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    idempotency_key = request.headers.get("X-Idempotency-Key") or str(uuid.uuid4())
    from src.api.trading_floor_simple import (
        broadcast_live_portfolio_state,
        portfolio_manager,
        portfolio_state,
        sync_portfolio_state_from_sqlite,
    )
    sync_portfolio_state_from_sqlite()

    result = await service.approve_run(
        run_id=run_id,
        action=data.get("action"),
        quantity=data.get("quantity"),
        idempotency_key=idempotency_key,
        portfolio_manager=portfolio_manager,
        portfolio_state=portfolio_state,
    )
    run = service.get_run(run_id)
    if run:
        await rc.publish_event("trading_floor_events", "decision_package_updated", {
            "type": "decision_package_updated",
            "run_id": run_id,
            "package": run,
        })
        if run.get("scene"):
            await _broadcast_admin_event({
                "type": "scene_command",
                "command": service.scene_package_to_command(run["scene"]),
            })

    status = result.get("status")
    if result.get("success"):
        await broadcast_live_portfolio_state()
        return result
    if status in {"STALE", "REBALANCE_REQUIRED", "BLOCKED"}:
        return JSONResponse(status_code=409, content=result)
    return JSONResponse(status_code=400, content=result)


@router.post("/trading-agents/runs/{run_id}/reject")
async def reject_trading_agents_run(run_id: str, request: Request):
    service = get_tradingagents_decision_service()
    data = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    idempotency_key = request.headers.get("X-Idempotency-Key") or str(uuid.uuid4())
    from src.api.trading_floor_simple import portfolio_state, sync_portfolio_state_from_sqlite
    sync_portfolio_state_from_sqlite()

    result = service.reject_run(
        run_id=run_id,
        reason=data.get("reason") or "Decision rejected by operator.",
        idempotency_key=idempotency_key,
        portfolio_state=portfolio_state,
    )
    run = service.get_run(run_id)
    if run and run.get("scene"):
        await rc.publish_event("trading_floor_events", "decision_package_updated", {
            "type": "decision_package_updated",
            "run_id": run_id,
            "package": run,
        })
        await _broadcast_admin_event({
            "type": "scene_command",
            "command": service.scene_package_to_command(run["scene"]),
        })

    if result.get("success"):
        return result
    if result.get("status") == "STALE":
        return JSONResponse(status_code=409, content=result)
    return JSONResponse(status_code=400, content=result)


@router.get("/trading-agents/runs/{run_id}/scene")
async def get_trading_agents_run_scene(run_id: str):
    service = get_tradingagents_decision_service()
    return {"scene": service.get_run_scene(run_id)}


@router.get("/trading-agents/runs/{run_id}/scenes")
async def get_trading_agents_run_scenes(run_id: str):
    service = get_tradingagents_decision_service()
    return {"scenes": service.get_run_scenes(run_id)}


@router.get("/trading-agents/runs/{run_id}/sentiment")
async def get_trading_agents_run_sentiment(run_id: str):
    service = get_tradingagents_decision_service()
    return {"sentiment": service.get_run_sentiment(run_id)}


@router.post("/scene_command")
async def broadcast_scene_command(request: Request):
    """Bridge for React to broadcast scene commands to all clients."""
    data = await request.json()
    payload = {
        "type": "scene_command",
        "command": data,
        "timestamp": datetime.now().isoformat(),
    }
    try:
        from src.api.trading_floor_simple import manager
        await manager.broadcast(payload)
    except Exception as exc:
        logger.warning("[SCENE_COMMAND] Direct websocket broadcast failed: %s", exc)
    await _broadcast_admin_event({**payload, "ws_broadcasted": True})
    return {"success": True, "command": data, "timestamp": payload["timestamp"]}


# ═══════════════════════════════════════════════════════════════════════════
# QUEUE MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/queue")
async def get_admin_queue():
    """Get full queue status for admin panel."""
    status = await ticker_queue.get_status()

    cooldown = await redis_get_queue_cooldown()
    currently_grilling = await redis_get_currently_grilling()
    
    return {
        "queue_size": status["queue_size"],
        "tier_counts": status["tier_counts"],
        "top_10": await ticker_queue.peek_top(10),
        "recent_processed": status["recent_processed"],
        "total_pot": status.get("total_pot", 0),
        "contributors": status.get("contributors", []),
        "cooldown": cooldown,
        "currently_grilling": currently_grilling,
    }


@router.post("/queue/delete")
async def delete_from_queue(request: Request):
    """Remove a ticker from the queue."""
    data = await request.json()
    ticker = data.get("ticker", "").upper()
    
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker required")
    
    # Remove from Redis
    await init_redis()
    removed = await rc.redis_client.zrem("ticker_queue", ticker)
    await rc.redis_client.hdel("ticker_queue_data", ticker)
    
    if removed:
        await _broadcast_admin_event({
            "type": "queue_item_deleted",
            "ticker": ticker,
            "timestamp": datetime.now().isoformat(),
        })
        
        return {"success": True, "ticker": ticker, "removed": True}
    
    return {"success": False, "message": f"{ticker} not in queue"}


@router.post("/queue/bump")
async def admin_bump_ticker(request: Request):
    """Bump a ticker to the top of the queue."""
    data = await request.json()
    ticker = data.get("ticker", "").upper()
    amount = data.get("amount", 100.0)  # Default to whale tier
    
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker required")
    
    success = await ticker_queue.bump_ticker(ticker, amount)
    
    if success:
        await _broadcast_admin_event({
            "type": "queue_item_bumped",
            "ticker": ticker,
            "amount": amount,
            "timestamp": datetime.now().isoformat(),
        })
        
        return {"success": True, "ticker": ticker, "new_bid": amount}
    
    return {"success": False, "message": "Failed to bump ticker"}


@router.post("/queue/inject")
async def inject_ticker(request: Request):
    """Inject a custom ticker into the queue."""
    data = await request.json()
    ticker = data.get("ticker", "").upper()
    tier = data.get("tier", 3)  # Default to whale
    user = data.get("user", "ADMIN")
    
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker required")
    
    # Calculate bid amount based on tier (5-tier system)
    bid_amounts = {1: 0.0, 2: 1.0, 3: 5.0, 4: 10.0, 5: 25.0}
    bid = bid_amounts.get(tier, 0.0)
    
    success = await ticker_queue.add_ticker(
        ticker=ticker,
        user=user,
        bid_amount=bid,
        is_system_alert=True,
    )
    
    if success:
        await _broadcast_admin_event({
            "type": "queue_item_injected",
            "ticker": ticker,
            "tier": tier,
            "admin": True,
            "timestamp": datetime.now().isoformat(),
        })
        
        return {
            "success": True,
            "ticker": ticker,
            "tier": tier,
            "position": "top" if tier == 3 else "priority",
        }
    
    return {"success": False, "message": "Failed to inject ticker"}


@router.post("/queue/clear")
async def clear_queue():
    """Clear the entire queue."""
    if not await ticker_queue._ensure_redis():
        return {"success": True, "cleared": 0}

    # Get all tickers
    all_tickers = await rc.redis_client.zrange("ticker_queue", 0, -1)

    # Delete all
    if all_tickers:
        await ticker_queue.clear()
    
    await _broadcast_admin_event({
        "type": "queue_cleared",
        "count": len(all_tickers),
        "timestamp": datetime.now().isoformat(),
    })
    
    return {"success": True, "cleared": len(all_tickers)}


# ═══════════════════════════════════════════════════════════════════════════
# MANUAL TRADE OVERRIDE
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/trade/buy")
async def admin_buy(request: Request):
    """
    Manual BUY override - Admin forces a buy.
    
    The system will execute the trade but animate it as if the Oracle did it.
    """
    data = await request.json()
    ticker = data.get("ticker", "").upper()
    shares_raw = data.get("shares", 1)
    reason = data.get("reason", "Admin override")
    
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker required")
        
    try:
        shares = int(float(shares_raw))
    except ValueError:
        shares = 1

    from src.api.trading_floor_simple import portfolio_manager, portfolio_state
    
    # We need current price
    try:
        import yfinance as yf
        t_data = yf.Ticker(ticker)
        hist = t_data.history(period="5d")
        if hist.empty:
            raise Exception("No market data")
        price = float(hist["Close"].iloc[-1])
    except Exception as e:
        logger.error(f"Failed to get price for {ticker}: {e}")
        return {"success": False, "message": f"Failed to get market price: {e}"}

    # Execute trade using internal manager
    execution = portfolio_manager._execute_trade(ticker, "BUY", shares, price, portfolio_state)
    
    if not execution['success']:
        return {"success": False, "message": execution['reason']}
        
    # Update position tracker for new shares
    portfolio_manager._register_position_entry(ticker, price)
    
    # Record trace in portfolio manager history for the Vault UI
    trade_record = {
        'timestamp': datetime.now().isoformat(),
        'symbol': ticker,
        'action': 'BUY',
        'quantity': shares,
        'price': price,
        'value': shares * price,
        'oracle_confidence': 1.0,  # Admin is always confident
        'oracle_reasoning': reason,
        'portfolio_value_before': execution['portfolio_value_before'],
        'portfolio_value_after': execution['new_portfolio_value'],
        'agent_name': 'Admin'
    }
    portfolio_manager.trade_history.append(trade_record)
    
    trade_event = {
        "type": "trade_executed",
        "action": "BUY",
        "ticker": ticker,
        "shares": shares,
        "price": price,
        "symbol": ticker,  # Ensure symbol is present for UI
        "reason": reason,
        "admin_initiated": True,
        "timestamp": datetime.now().isoformat(),
        "portfolio_value_after": execution['new_portfolio_value']
    }
    
    await _broadcast_admin_event(trade_event)
    
    logger.info(f"📈 ADMIN BUY: {shares} shares of {ticker} @ ${price:.2f} - {reason}")
    
    return {
        "success": True,
        "action": "BUY",
        "ticker": ticker,
        "shares": shares,
        "price": price,
        "message": f"Buy order executed for {shares} shares of {ticker} @ ${price:.2f}",
    }


@router.post("/trade/sell")
async def admin_sell(request: Request):
    """
    Manual SELL override - Admin forces a sell.
    """
    data = await request.json()
    ticker = data.get("ticker", "").upper()
    shares_raw = data.get("shares", "all")  # "all" or number
    reason = data.get("reason", "Admin override")
    
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker required")
        
    from src.api.trading_floor_simple import portfolio_manager, portfolio_state
    
    if ticker not in portfolio_state.get("positions", {}):
        return {"success": False, "message": f"No position in {ticker} to sell"}
        
    current_shares = portfolio_state["positions"][ticker]
    
    if str(shares_raw).lower() == "all":
        shares = current_shares
    else:
        try:
            shares = int(float(shares_raw))
            shares = min(shares, current_shares)
        except ValueError:
            shares = current_shares

    # We need current price
    try:
        import yfinance as yf
        t_data = yf.Ticker(ticker)
        hist = t_data.history(period="5d")
        if hist.empty:
            raise Exception("No market data")
        price = float(hist["Close"].iloc[-1])
    except Exception as e:
        logger.error(f"Failed to get price for {ticker}: {e}")
        return {"success": False, "message": f"Failed to get market price: {e}"}

    # Execute trade using internal manager
    execution = portfolio_manager._execute_trade(ticker, "SELL", shares, price, portfolio_state, exit_reason=f"ADMIN_SELL: {reason}")
    
    if not execution['success']:
        return {"success": False, "message": execution['reason']}
    
    # Record trace in portfolio manager history for the Vault UI
    trade_record = {
        'timestamp': datetime.now().isoformat(),
        'symbol': ticker,
        'action': 'SELL',
        'quantity': shares,
        'price': price,
        'value': shares * price,
        'oracle_confidence': 1.0,
        'oracle_reasoning': reason,
        'portfolio_value_before': execution['portfolio_value_before'],
        'portfolio_value_after': execution['new_portfolio_value'],
        'agent_name': 'Admin'
    }
    portfolio_manager.trade_history.append(trade_record)
    
    trade_event = {
        "type": "trade_executed",
        "action": "SELL",
        "ticker": ticker,
        "shares": shares,
        "price": price,
        "symbol": ticker,  # Ensure symbol is present for UI
        "reason": reason,
        "admin_initiated": True,
        "timestamp": datetime.now().isoformat(),
        "portfolio_value_after": execution['new_portfolio_value']
    }
    
    await _broadcast_admin_event(trade_event)
    
    logger.info(f"📉 ADMIN SELL: {shares} shares of {ticker} @ ${price:.2f} - {reason}")
    
    return {
        "success": True,
        "action": "SELL",
        "ticker": ticker,
        "shares": shares,
        "price": price,
        "message": f"Sell order executed for {shares} shares of {ticker} @ ${price:.2f}",
    }


# ═══════════════════════════════════════════════════════════════════════════
# WHALE VETO
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/veto/{ticker}")
async def veto_whale_analysis(ticker: str):
    """
    Veto a whale's analysis/trade request.
    
    The JRPG box will show: "The Board of Directors has overridden the Oracle."
    """
    ticker = ticker.upper()
    
    veto_event = {
        "type": "whale_veto",
        "ticker": ticker,
        "message": "The Board of Directors (Risk Management) has overridden the Oracle. Trade canceled.",
        "admin_initiated": True,
        "timestamp": datetime.now().isoformat(),
    }
    
    _vetoed_trades.append(veto_event)
    
    await _broadcast_admin_event(veto_event)
    
    logger.info(f"🚫 VETO: {ticker} analysis/trade canceled by admin")
    
    return {
        "success": True,
        "ticker": ticker,
        "message": "Trade vetoed. The Board has spoken.",
    }


@router.get("/veto/list")
async def get_vetoed_trades():
    """Get list of vetoed trades."""
    return {
        "vetoed": _vetoed_trades[-20:],  # Last 20
        "total": len(_vetoed_trades),
    }


# ═══════════════════════════════════════════════════════════════════════════
# WHALE TRADE APPROVALS (Tier 5)
# ═══════════════════════════════════════════════════════════════════════════

WHALe_APPROVAL_TTL_SECONDS = 30


def _normalize_trade_action(verdict: str) -> Optional[str]:
    v = (verdict or "").upper().replace("_", " ").strip()
    if v in {"STRONG BUY", "BUY"}:
        return "BUY"
    if v in {"SELL"}:
        return "SELL"
    return None


async def _propose_whale_trade(prediction: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Convert a Tier-5 prediction into a pending trade request.

    IMPORTANT: This does not execute a trade. It only proposes one.
    """
    ticker = (prediction.get("ticker") or "").upper().strip()
    action = _normalize_trade_action(prediction.get("verdict") or prediction.get("action") or "")
    if not ticker or not action:
        return None

    from src.api.trading_floor_simple import portfolio_manager, portfolio_state
    from src.runtime.finance_db_client import fetch_quote

    # Resolve price
    price = float(prediction.get("current_price") or 0.0)
    if price <= 0:
        try:
            quote = await fetch_quote(ticker)
            price = float((quote or {}).get("price") or (quote or {}).get("last_price") or 0.0)
        except Exception:
            price = 0.0
    if price <= 0:
        return None

    positions = portfolio_state.get("positions", {}) or {}
    cash = float(portfolio_state.get("cash", 0.0) or 0.0)
    total_value = float(portfolio_state.get("total_value", portfolio_manager.initial_capital) or 0.0)

    quantity = 0
    if action == "BUY":
        reserve = total_value * float(portfolio_manager.risk_limits.get("min_cash_reserve", 0.05) or 0.05)
        available_cash = max(0.0, cash - reserve)
        max_pos_value = total_value * float(portfolio_manager.risk_limits.get("max_single_position", 0.02) or 0.02)
        target_value = min(available_cash, max_pos_value)
        quantity = int(target_value / price) if price > 0 else 0
    elif action == "SELL":
        quantity = int(positions.get(ticker, 0) or 0)

    if quantity <= 0:
        return None

    trade_id = uuid.uuid4().hex[:12]
    created_ts = float(time.time())
    expires_ts = created_ts + WHALe_APPROVAL_TTL_SECONDS

    conf = prediction.get("confidence")
    try:
        conf_pct = int(float(conf))
    except Exception:
        conf_pct = 0

    return {
        "id": trade_id,
        "status": "pending",
        "ticker": ticker,
        "action": action,
        "quantity": quantity,
        "price": round(price, 4),
        "confidence_pct": conf_pct,
        "reasoning": (prediction.get("tl_dr") or "")[:300],
        "tier": prediction.get("tier"),
        "tier_name": prediction.get("tier_name"),
        "sponsor": prediction.get("sponsor"),
        "donation_amount": prediction.get("donation_amount"),
        "created_ts": created_ts,
        "expires_ts": expires_ts,
        "created_at": datetime.now().isoformat(),
        "expires_at": datetime.fromtimestamp(expires_ts).isoformat(),
    }


async def _execute_pending_whale_trade(trade: Dict[str, Any], decided_by: str) -> Dict[str, Any]:
    """Execute a pending whale trade through PortfolioManager risk gates."""
    from src.api.trading_floor_simple import portfolio_manager, portfolio_state
    from src.runtime.models import TradingDecision

    decision = TradingDecision(
        symbol=trade["ticker"],
        action=trade["action"],
        quantity=int(trade["quantity"]),
        confidence=max(0.0, min(1.0, float(trade.get("confidence_pct", 0)) / 100.0)),
        reasoning=str(trade.get("reasoning") or "Tier-5 whale proposal")[:400],
        risk_score=0.5,
        expected_return=0.0,
        time_horizon="intraday",
        agent_consensus={},
        agent_name="RiskManager" if decided_by != "admin" else "Admin",
    )

    execution = await portfolio_manager.execute_oracle_decision(decision, portfolio_state)

    # Broadcast trade event (public-safe)
    await _broadcast_admin_event(
        {
            "type": "trade_executed",
            "trade": {
                "action": execution.action,
                "quantity": execution.quantity,
                "symbol": execution.symbol,
                "price": execution.price,
                "reason": execution.reason,
            },
            "timestamp": datetime.now().isoformat(),
        }
    )

    return {
        "success": bool(execution.success),
        "reason": execution.reason,
        "execution": {
            "symbol": execution.symbol,
            "action": execution.action,
            "quantity": execution.quantity,
            "price": execution.price,
            "value": execution.value,
            "timestamp": execution.timestamp,
        },
    }


async def _whale_trade_timeout(trade_id: str) -> None:
    """If admin does nothing for 30s, let the risk manager decide."""
    await asyncio.sleep(WHALe_APPROVAL_TTL_SECONDS)
    trade = await get_pending_whale_trade(trade_id)
    if not trade or trade.get("status") != "pending":
        return

    # Mark as timed out and let the risk manager attempt execution.
    try:
        res = await _execute_pending_whale_trade(trade, decided_by="risk_manager")
        trade["status"] = "executed_by_risk_manager" if res.get("success") else "rejected_by_risk_manager"
        trade["decided_at"] = datetime.now().isoformat()
        trade["decision"] = res
    except Exception as e:
        trade["status"] = "error"
        trade["error"] = str(e)

    # Remove from pending set regardless (end of approval window)
    await remove_pending_whale_trade(trade_id)

    await _broadcast_admin_event(
        {
            "type": "pending_whale_trade_resolved",
            "trade": trade,
            "timestamp": datetime.now().isoformat(),
        }
    )


@router.post("/whale-trades/{trade_id}/approve")
async def approve_whale_trade(trade_id: str):
    trade = await get_pending_whale_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Pending whale trade not found")
    if trade.get("status") != "pending":
        return {"success": False, "message": f"Trade already resolved: {trade.get('status')}"}

    # Reject approvals after expiry (risk manager will decide/has decided)
    if float(time.time()) > float(trade.get("expires_ts") or 0):
        return {"success": False, "message": "Approval window expired"}

    res = await _execute_pending_whale_trade(trade, decided_by="admin")
    trade["status"] = "approved_executed" if res.get("success") else "approved_rejected"
    trade["decided_at"] = datetime.now().isoformat()
    trade["decision"] = res

    await remove_pending_whale_trade(trade_id)

    await _broadcast_admin_event(
        {
            "type": "pending_whale_trade_resolved",
            "trade": trade,
            "timestamp": datetime.now().isoformat(),
        }
    )

    return {"success": True, "trade": trade}


@router.post("/whale-trades/{trade_id}/veto")
async def veto_whale_trade(trade_id: str):
    trade = await get_pending_whale_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Pending whale trade not found")

    trade["status"] = "vetoed"
    trade["decided_at"] = datetime.now().isoformat()

    await remove_pending_whale_trade(trade_id)

    # Public-safe veto broadcast
    await _broadcast_admin_event(
        {
            "type": "whale_veto",
            "ticker": trade.get("ticker"),
            "message": "The Board of Directors (Risk Management) has overridden the Oracle. Trade canceled.",
            "admin_initiated": True,
            "timestamp": datetime.now().isoformat(),
        }
    )

    await _broadcast_admin_event(
        {
            "type": "pending_whale_trade_resolved",
            "trade": trade,
            "timestamp": datetime.now().isoformat(),
        }
    )

    return {"success": True, "trade": trade}


# ═══════════════════════════════════════════════════════════════════════════
# PROCESS NEXT QUEUE ITEM
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/queue/process-next")
async def process_next_in_queue(request: Request = None):
    """
    Manually process the next item in the queue.
    
    This triggers the tiered analysis based on the item's tier.
    Respects cooldown unless override is requested.
    Also cleans up stale free-tier items before processing.
    """
    # First, cleanup expired free-tier items
    decayed = await ticker_queue.cleanup_expired_items(_broadcast_admin_event)
    if decayed:
        logger.info(f"Cleaned up {len(decayed)} stale free-tier items")
    
    # Check for override flag
    override_cooldown = False
    if request:
        try:
            data = await request.json()
            override_cooldown = data.get("override_cooldown", False)
        except:
            pass
    
    # Check cooldown (Redis canonical)
    cooldown = await redis_get_queue_cooldown()
    if cooldown.get("active") and not override_cooldown:
        return {
            "success": False,
            "status": "cooldown",
            "cooldown_ends_at": cooldown.get("ends_at"),
            "remaining_seconds": cooldown.get("remaining_seconds", 0),
            "message": f"Cooldown active. {cooldown.get('remaining_seconds', 0)}s remaining. Use override_cooldown=true to force.",
        }
    
    item = await ticker_queue.get_next()
    
    if not item:
        return {"success": False, "message": "Queue is empty"}
    
    ticker = item["ticker"]
    tier = item.get("tier", 1)
    bid = item.get("total_bid", 0)
    requester = item.get("requester", "unknown")
    
    # Set currently grilling
    currently_grilling = {
        "ticker": ticker,
        "tier": tier,
        "tier_name": ticker_queue.get_tier_name(tier),
        "sponsor": requester,
        "amount": bid,
        "started_at": datetime.now().isoformat(),
    }
    await redis_set_currently_grilling(currently_grilling)
    
    # Broadcast currently grilling
    await _broadcast_admin_event({
        "type": "currently_grilling",
        **currently_grilling,
    })
    
    # Broadcast cooldown start
    cooldown_state = await redis_set_queue_cooldown(COOLDOWN_SECONDS)
    await _broadcast_admin_event({
        "type": "queue_cooldown_start",
        "cooldown_ends_at": cooldown_state.get("ends_at"),
        "remaining_seconds": cooldown_state.get("remaining_seconds", 0),
    })
    
    # Import and run the tiered analysis
    from src.runtime.tiered_analyzer import run_tiered_analysis
    
    # Create completion callback
    async def on_analysis_complete(result):
        await redis_set_currently_grilling(None)
        
        # Broadcast grilling complete
        action = result.get("verdict") or result.get("final_action") or result.get("action") or "HOLD"
        conf_pct = result.get("confidence")
        try:
            conf_pct = float(conf_pct)
        except Exception:
            conf_pct = 0.0

        await _broadcast_admin_event({
            "type": "grilling_complete",
            "ticker": ticker,
            "action": action,
            "confidence": conf_pct / 100.0 if conf_pct > 1 else conf_pct,
        })

        # Persist active prediction for Big Reveal (Redis canonical)
        try:
            active = {
                "ticker": ticker,
                "verdict": action,
                "confidence": int(conf_pct) if conf_pct else 0,
                "targets": result.get("targets") or {},
                "tl_dr": result.get("tl_dr") or "",
                "tier": result.get("tier") or tier,
                "tier_name": result.get("tier_name") or ticker_queue.get_tier_name(tier),
                "sponsor": requester,
                "donation_amount": bid,
                "trade_authorized": bool(result.get("trade_authorized", False)),
                "timestamp": datetime.now().isoformat(),
            }
            await redis_set_active_prediction(active)

            # Tier 5: create an approval-gated pending whale trade (never auto-buy)
            try:
                if int(active.get("tier") or 1) == 5 and bool(active.get("trade_authorized")):
                    pending = await _propose_whale_trade(active)
                    if pending:
                        await upsert_pending_whale_trade(pending)
                        asyncio.create_task(_whale_trade_timeout(pending["id"]))
                        await _broadcast_admin_event({
                            "type": "pending_whale_trade",
                            "trade": pending,
                            "timestamp": datetime.now().isoformat(),
                        })
            except Exception as e:
                logger.debug(f"Failed to create pending whale trade: {e}")
        except Exception as e:
            logger.debug(f"Failed to set active prediction: {e}")
        
        # Broadcast cooldown end
        await _broadcast_admin_event({
            "type": "queue_cooldown_end",
        })
    
    # Run analysis in background with completion callback
    async def run_with_callback():
        try:
            result = await run_tiered_analysis(
                ticker=ticker,
                tier=tier,
                donation_amount=bid,
                broadcast=_broadcast_analysis_event,
                sponsor=requester,
                source="queue",
            )
            await on_analysis_complete(result)
        except Exception as e:
            logger.error(f"Analysis error: {e}")
            await redis_set_currently_grilling(None)
            await _broadcast_admin_event({
                "type": "grilling_complete",
                "ticker": ticker,
                "error": str(e),
            })
    
    asyncio.create_task(run_with_callback())
    
    return {
        "success": True,
        "ticker": ticker,
        "tier": tier,
        "requester": requester,
        "message": f"Started TIER {tier} analysis for {ticker}",
    }


# ═══════════════════════════════════════════════════════════════════════════
# BROADCAST HELPERS
# ═══════════════════════════════════════════════════════════════════════════

async def _broadcast_admin_event(event: Dict[str, Any]):
    """Broadcast admin event via Redis pub/sub."""
    try:
        await init_redis()
        import json
        
        # Check if Redis is available
        if rc.redis_client is None:
            logger.warning("Redis not available, skipping broadcast")
            return
            
        await rc.redis_client.publish(
            "trading_floor_events",
            json.dumps(event)
        )
    except Exception as e:
        logger.error(f"Error broadcasting admin event: {e}")
        # Don't re-raise - just log and continue
        # The scene command will still be dispatched to WebSocket clients directly


async def _broadcast_analysis_event(event: Dict[str, Any]):
    """Broadcast analysis event via Redis pub/sub."""
    try:
        await init_redis()
        import json
        
        # Check if Redis is available
        if rc.redis_client is None:
            logger.warning("Redis not available, skipping analysis broadcast")
            return
            
        await rc.redis_client.publish(
            "trading_floor_events",
            json.dumps(event)
        )
    except Exception as e:
        logger.error(f"Error broadcasting analysis event: {e}")


# ═══════════════════════════════════════════════════════════════════════════
# SYSTEM STATUS
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/status")
async def get_admin_status():
    """Get overall system status for admin dashboard."""
    from src.theatrical_autopilot import is_autopilot_running
    
    queue_status = await ticker_queue.get_status()
    cooldown = await redis_get_queue_cooldown()
    currently_grilling = await redis_get_currently_grilling()
    
    decision_service = get_tradingagents_decision_service()

    return {
        "autopilot": {
            "running": is_autopilot_running(),
            "mode": "theatrical",
        },
        "queue": {
            "size": queue_status["queue_size"],
            "tier_counts": queue_status["tier_counts"],
            "total_pot": queue_status.get("total_pot", 0),
        },
        "cooldown": cooldown,
        "currently_grilling": currently_grilling,
        "veto_count": len(_vetoed_trades),
        "tradingagents_runtime": decision_service.get_scene_dialogue_runtime_info(),
        "timestamp": datetime.now().isoformat(),
    }


# ═══════════════════════════════════════════════════════════════════════════
# COOLDOWN OVERRIDE
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/queue/override-cooldown")
async def override_cooldown():
    """
    Override the cooldown - allows immediate processing for whale donations.
    """
    await redis_clear_queue_cooldown()
    
    await _broadcast_admin_event({
        "type": "cooldown_overridden",
        "timestamp": datetime.now().isoformat(),
    })
    
    return {"success": True, "message": "Cooldown overridden. Ready to process."}


@router.post("/broadcast-ui-settings")
async def broadcast_ui_settings(settings: Dict[str, Any]):
    """
    Persist and broadcast UI settings (visibility, marquee speed, lighting, etc.).
    """
    try:
        from src.analytics.db import get_analytics_db

        db = get_analytics_db()
        for key, value in settings.items():
            db.set_live_config(str(key), value, "Updated via /api/admin/broadcast-ui-settings")
        settings = db.get_all_live_config() or settings
    except Exception as e:
        logger.error(f"Failed to persist broadcast UI settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    await _broadcast_admin_event({
        "type": "broadcast_settings",
        "data": settings,
        "timestamp": datetime.now().isoformat(),
    })
    return {"success": True, "message": "UI settings broadcasted.", "config": settings}


# ═══════════════════════════════════════════════════════════════════════════
# PREDICTION HISTORY
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/predictions/history")
async def get_prediction_history(count: int = 5):
    """
    Get recent prediction history for the Recent Calls ledger.
    """
    from src.runtime.prediction_history import get_prediction_history
    
    predictions = await get_prediction_history(count)
    return {"predictions": predictions}


@router.post("/predictions/record")
async def record_prediction_endpoint(request: Request):
    """
    Record a completed prediction to the history.
    Called internally when analysis completes.
    """
    from src.runtime.prediction_history import record_prediction
    
    data = await request.json()
    
    prediction = await record_prediction(
        ticker=data.get("ticker"),
        verdict=data.get("verdict"),
        confidence=data.get("confidence"),
        current_price=data.get("current_price"),
        targets=data.get("targets"),
        tl_dr=data.get("tl_dr"),
        tier=data.get("tier"),
        sponsor=data.get("sponsor"),
    )
    
    return {"success": True, "prediction": prediction}


# ═══════════════════════════════════════════════════════════════════════════
# ACTIVE PREDICTION MANAGEMENT (Big Reveal)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/predictions/active")
async def get_active_prediction():
    """
    Get the current Big Reveal prediction being displayed.
    Returns None if no prediction is active.
    """
    return {"prediction": await redis_get_active_prediction()}


@router.post("/predictions/set-active")
async def set_active_prediction(request: Request):
    """
    Set the active prediction for Big Reveal display.
    Called internally when analysis completes.
    """
    data = await request.json()
    active = {
        "ticker": data.get("ticker"),
        "verdict": data.get("verdict"),
        "confidence": data.get("confidence"),
        "targets": data.get("targets"),
        "tl_dr": data.get("tl_dr"),
        "tier": data.get("tier"),
        "sponsor": data.get("sponsor"),
        "current_price": data.get("current_price"),
        "timestamp": datetime.now().isoformat(),
    }
    await redis_set_active_prediction(active)
    
    await _broadcast_admin_event({
        "type": "prediction_reveal_started",
        "prediction": active,
        "timestamp": datetime.now().isoformat(),
    })
    
    return {"success": True, "prediction": active}


@router.post("/predictions/end-reveal")
async def end_reveal_early():
    """
    End the Big Reveal early and move prediction to history.
    Admin can use this if the prediction needs to be removed quickly.
    """
    active = await redis_get_active_prediction()
    if not active:
        return {"success": False, "message": "No active prediction to end"}
    
    # Record to history
    from src.runtime.prediction_history import record_prediction
    prediction = await record_prediction(
        ticker=active.get("ticker"),
        verdict=active.get("verdict"),
        confidence=active.get("confidence"),
        current_price=active.get("current_price"),
        targets=active.get("targets"),
        tl_dr=active.get("tl_dr"),
        tier=active.get("tier"),
        sponsor=active.get("sponsor"),
    )

    ended_prediction = active
    await redis_set_active_prediction(None)
    
    await _broadcast_admin_event({
        "type": "prediction_reveal_ended",
        "prediction": ended_prediction,
        "timestamp": datetime.now().isoformat(),
    })
    
    logger.info(f"Ended Big Reveal early: {ended_prediction.get('ticker')}")
    
    return {"success": True, "prediction": ended_prediction}


@router.post("/predictions/{ticker}/toggle-win-loss")
async def toggle_prediction_win_loss(ticker: str, request: Request):
    """
    Manually toggle win/loss status for a prediction in history.
    Used when auto-pricing script isn't running.
    """
    data = await request.json()
    is_win = data.get("is_win", True)
    timestamp = data.get("timestamp")
    
    from src.runtime.prediction_history import update_prediction_performance
    
    # Set performance based on win/loss
    performance_pct = 5.0 if is_win else -5.0
    
    updated = await update_prediction_performance(
        ticker=ticker,
        timestamp=timestamp,
        current_price=0,  # Unknown
        performance_pct=performance_pct,
    )
    
    if updated:
        await _broadcast_admin_event({
            "type": "prediction_win_loss_toggled",
            "ticker": ticker,
            "is_win": is_win,
            "performance_pct": performance_pct,
            "timestamp": datetime.now().isoformat(),
        })
        
        return {"success": True, "ticker": ticker, "is_win": is_win}
    
    return {"success": False, "message": f"Prediction not found: {ticker}"}


# ═══════════════════════════════════════════════════════════════════════════
# FORCE ANALYZE (Bypass Queue)
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/queue/force-analyze")
async def force_analyze_ticker(request: Request):
    """
    Force immediate analysis of a ticker, bypassing the queue.
    Used for testing or urgent analysis requests.
    """
    data = await request.json()
    ticker = data.get("ticker", "").upper()
    tier = data.get("tier", 3)
    
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker required")
    
    # Set currently grilling
    currently_grilling = {
        "ticker": ticker,
        "tier": tier,
        "tier_name": ticker_queue.get_tier_name(tier),
        "sponsor": "ADMIN_FORCE",
        "amount": 0,
        "started_at": datetime.now().isoformat(),
    }
    await redis_set_currently_grilling(currently_grilling)
    
    # Broadcast currently grilling
    await _broadcast_admin_event({
        "type": "currently_grilling",
        **currently_grilling,
    })
    
    # Start cooldown
    cooldown_state = await redis_set_queue_cooldown(COOLDOWN_SECONDS)
    await _broadcast_admin_event({
        "type": "queue_cooldown_start",
        "cooldown_ends_at": cooldown_state.get("ends_at"),
        "remaining_seconds": cooldown_state.get("remaining_seconds", 0),
    })
    
    # Import and run the tiered analysis
    from src.runtime.tiered_analyzer import run_tiered_analysis
    
    async def run_force_analysis():
        try:
            result = await run_tiered_analysis(
                ticker=ticker,
                tier=tier,
                donation_amount=0,
                broadcast=_broadcast_analysis_event,
                sponsor="ADMIN_FORCE",
                source="admin_force",
            )
            
            # Set active prediction for Big Reveal
            if result:
                verdict = result.get("verdict") or "HOLD"
                conf = result.get("confidence") or 0
                active = {
                    "ticker": ticker,
                    "verdict": verdict,
                    "confidence": int(conf) if conf else 0,
                    "targets": result.get("targets", {}),
                    "tl_dr": result.get("tl_dr", ""),
                    "tier": tier,
                    "tier_name": result.get("tier_name") or ticker_queue.get_tier_name(tier),
                    "sponsor": "ADMIN_FORCE",
                    "current_price": result.get("current_price"),
                    "timestamp": datetime.now().isoformat(),
                }
                await redis_set_active_prediction(active)
                
                await _broadcast_admin_event({
                    "type": "prediction_reveal_started",
                    "prediction": active,
                })
            
            await redis_set_currently_grilling(None)
            
            await _broadcast_admin_event({
                "type": "grilling_complete",
                "ticker": ticker,
                "action": (result.get("verdict") if result else "HOLD"),
            })
            
            await _broadcast_admin_event({
                "type": "queue_cooldown_end",
            })
            
        except Exception as e:
            logger.error(f"Force analysis error: {e}")
            await redis_set_currently_grilling(None)
            await _broadcast_admin_event({
                "type": "grilling_complete",
                "ticker": ticker,
                "error": str(e),
            })
    
    asyncio.create_task(run_force_analysis())
    
    await _broadcast_admin_event({
        "type": "queue_force_analyzed",
        "ticker": ticker,
        "tier": tier,
        "timestamp": datetime.now().isoformat(),
    })
    
    return {
        "success": True,
        "ticker": ticker,
        "tier": tier,
        "message": f"Started forced TIER {tier} analysis for {ticker}",
    }


# ═══════════════════════════════════════════════════════════════════════════
# PIPELINE SCENE CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/pipeline_scenes")
async def get_pipeline_scenes():
    """Get saved pipeline scene configurations from DB."""
    try:
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        data = da.get_config("pipeline_scenes")
        sanitized = _sanitize_pipeline_scenes_config(data or {})
        if isinstance(data, dict) and sanitized != data:
            da.set_config("pipeline_scenes", sanitized)
        return sanitized if sanitized is not None else {}
    except Exception as e:
        return {}
    return {}


@router.post("/pipeline_scenes")
async def save_pipeline_scenes(request: Request):
    """Save pipeline scene configurations to DB."""
    data = await request.json()
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Config payload must be an object")
    try:
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        existing = da.get_config("pipeline_scenes") or {}
        if not isinstance(existing, dict):
            existing = {}
        merged = {**existing, **data}
        sanitized = _sanitize_pipeline_scenes_config(merged)
        da.set_config("pipeline_scenes", sanitized)
        saved_patch = {key: sanitized.get(key) for key in data.keys()}
        payload = {
            "type": "pipeline_scenes_updated",
            "config": sanitized,
            "timestamp": datetime.now().isoformat(),
        }
        try:
            from src.api.trading_floor_simple import manager
            await manager.broadcast(payload)
        except Exception:
            pass
        await _broadcast_admin_event(payload)
        await rc.publish_event("trading_floor_events", "pipeline_scenes_updated", payload)
        return {"success": True, "saved": saved_patch, "config": sanitized}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════
# MAP PERSISTENCE
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/map")
async def get_room_map():
    """Get the saved room map from DB."""
    try:
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        room_map = da.get_config("room_map")
        if room_map is None:
            return {}
        
        # Standardize floats/values for JSON serialization
        try:
            from src.api.trading_floor_simple import _sanitize_floats
            return _sanitize_floats(room_map)
        except ImportError:
            return room_map
            
    except Exception as e:
        logger.error(f"Error getting room map: {e}")
        return {}


@router.post("/map")
async def save_room_map(request: Request):
    """Save the room map to DB."""
    try:
        data = await request.json()
        if "map" not in data:
            raise HTTPException(status_code=400, detail="Map data is required")
        
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        da.set_config("room_map", data["map"])

        payload = {
            "type": "map_updated",
            "map": data["map"],
            "timestamp": datetime.now().isoformat(),
        }

        try:
            from src.api.trading_floor_simple import manager
            await manager.broadcast(payload)
        except Exception:
            pass

        await _broadcast_admin_event(payload)
        await rc.publish_event("trading_floor_events", "map_updated", payload)

        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════
# LLM ZONE CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════

# Default LLM config for each zone
DEFAULT_ZONE_LLM_CONFIG = {
    "zone_1_harvester": {
        "provider": "none",
        "model": "deterministic",
        "description": "Zone 1: HARVESTER - Deterministic data collection ($0 cost)",
    },
    "zone_2_triage": {
        "provider": "finbert",
        "model": "finbert-api",
        "description": "Zone 2: TRIAGE - FinBERT sentiment analysis ($0 cost)",
    },
    "zone_3_war_room": {
        "provider": "openai",
        "model": "gpt-4o",
        "description": "Zone 3: WAR ROOM - Thesis generation (PAID)",
    },
    "zone_4_risk_manager": {
        "provider": "none",
        "model": "deterministic",
        "description": "Zone 4: RISK MANAGER - Deterministic risk checks ($0 cost)",
    },
}


@router.get("/llm/zones")
async def get_zone_llm_config():
    """
    Get LLM configuration for each Lean Swarm zone.
    
    Zone 1 (HARVESTER): Deterministic - no LLM
    Zone 2 (TRIAGE): FinBERT API - sentiment analysis
    Zone 3 (WAR ROOM): Frontier LLM - thesis generation (PAID)
    Zone 4 (RISK MANAGER): Deterministic - no LLM
    """
    try:
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        saved_config = da.get_config("zone_llm_config") or {}
        
        # Merge with defaults
        config = {**DEFAULT_ZONE_LLM_CONFIG, **saved_config}
        return config
    except Exception as e:
        logger.error(f"Failed to get zone LLM config: {e}")
        return DEFAULT_ZONE_LLM_CONFIG


@router.post("/llm/zones/{zone}")
async def set_zone_llm_config(zone: str, request: Request):
    """
    Set LLM provider/model for a specific zone.
    
    Args:
        zone: Zone identifier (zone_1_harvester, zone_2_triage, zone_3_war_room, zone_4_risk_manager)
        
    Body:
        provider: LLM provider (openai, anthropic, google, finbert, none)
        model: Model identifier (gpt-4o, claude-3-opus, gemini-pro, etc.)
    """
    valid_zones = [
        "zone_1_harvester",
        "zone_2_triage", 
        "zone_3_war_room",
        "zone_4_risk_manager",
    ]
    
    if zone not in valid_zones:
        raise HTTPException(
            status_code=400, 
            detail=f"Invalid zone. Must be one of: {', '.join(valid_zones)}"
        )
    
    data = await request.json()
    provider = data.get("provider", "none")
    model = data.get("model", "deterministic")
    
    try:
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        
        # Get existing config
        saved_config = da.get_config("zone_llm_config") or {}
        
        # Update the specific zone
        saved_config[zone] = {
            "provider": provider,
            "model": model,
            "description": DEFAULT_ZONE_LLM_CONFIG.get(zone, {}).get("description", ""),
            "updated_at": datetime.now().isoformat(),
        }
        
        # Save back
        da.set_config("zone_llm_config", saved_config)
        
        await _broadcast_admin_event({
            "type": "zone_llm_config_updated",
            "zone": zone,
            "provider": provider,
            "model": model,
            "timestamp": datetime.now().isoformat(),
        })
        
        logger.info(f"[ADMIN] Updated {zone}: provider={provider}, model={model}")
        
        return {"success": True, "zone": zone, "provider": provider, "model": model}
        
    except Exception as e:
        logger.error(f"Failed to set zone LLM config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/llm/providers")
async def get_available_llm_providers():
    """
    Get list of available LLM providers and their models.
    Mirrors localhost:8001/admin configuration.
    """
    nvidia_models = TRADINGAGENTS_PROVIDER_MODEL_PRESETS.get("nvidia", {}).get("models", [])
    return {
        "providers": [
            {
                "id": "none",
                "name": "Deterministic",
                "models": [{"id": "deterministic", "name": "Rule-based (No LLM)"}],
                "cost": "$0",
            },
            {
                "id": "finbert",
                "name": "FinBERT API",
                "models": [{"id": "finbert-api", "name": "FinBERT Sentiment API"}],
                "cost": "$0",
            },
            {
                "id": "openai",
                "name": "OpenAI",
                "models": [
                    {"id": "gpt-4o", "name": "GPT-4o"},
                    {"id": "gpt-4o-mini", "name": "GPT-4o Mini"},
                    {"id": "gpt-4-turbo", "name": "GPT-4 Turbo"},
                    {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo"},
                ],
                "cost": "PAID",
            },
            {
                "id": "nvidia",
                "name": "NVIDIA API",
                "models": nvidia_models,
                "cost": "PAID",
            },
            {
                "id": "anthropic",
                "name": "Anthropic",
                "models": [
                    {"id": "claude-3-opus", "name": "Claude 3 Opus"},
                    {"id": "claude-3-sonnet", "name": "Claude 3 Sonnet"},
                    {"id": "claude-3-haiku", "name": "Claude 3 Haiku"},
                ],
                "cost": "PAID",
            },
            {
                "id": "google",
                "name": "Google AI",
                "models": [
                    {"id": "gemini-pro", "name": "Gemini Pro"},
                    {"id": "gemini-ultra", "name": "Gemini Ultra"},
                ],
                "cost": "PAID",
            },
        ]
    }


# ═══════════════════════════════════════════════════════════════════════════
# TRADINGAGENTS CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/tradingagents/config")
async def get_tradingagents_config():
    """Get the persisted TradingAgents LLM configuration with defaults."""
    raise HTTPException(
        status_code=410,
        detail="Deprecated: runner config is browser-managed (BYOK) and no longer served by backend.",
    )


@router.post("/tradingagents/config")
async def update_tradingagents_config(request: Request):
    """Update the persistent TradingAgents LLM configuration in the DB."""
    raise HTTPException(
        status_code=410,
        detail="Deprecated: runner config is browser-managed (BYOK) and no longer persisted by backend.",
    )


@router.get("/tradingagents/models")
async def list_tradingagents_models(provider: str = "nvidia"):
    """Discover available models for the selected TradingAgents provider."""
    raise HTTPException(
        status_code=410,
        detail="Deprecated: runner models are now selected client-side (manual input + presets).",
    )


@router.get("/tradingagents/models/health")
async def list_tradingagents_model_health(provider: str = "nvidia"):
    """Return last-tested model health for TradingAgents scene JSON routing."""
    raise HTTPException(
        status_code=410,
        detail="Deprecated: scene model health is no longer backend-served for runner mode.",
    )


@router.post("/tradingagents/config/test")
async def test_tradingagents_provider_connection(request: Request):
    """Test connection to the selected TradingAgents provider."""
    raise HTTPException(
        status_code=410,
        detail="Deprecated: provider test is now browser-direct in BYOK mode.",
    )


@router.post("/sentiment/analyze")
async def analyze_sentiment(request: Request):
    """Analyze real-time sentiment from text"""
    data = await request.json()
    text = data.get("text", "")
    result = engine.analyze(text)
    return result


