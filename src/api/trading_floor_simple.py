"""
Trading Floor API - WebSocket and HTTP endpoints for the 24/7 Autonomous Trading Floor
"""
import asyncio
import json
import logging
import uuid
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger(__name__)
import math
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Request
import httpx
import yfinance as yf


def _sanitize_floats(obj):
    """Replace inf/nan floats with None recursively so JSON serialization succeeds."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize_floats(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_floats(v) for v in obj]
    return obj


# Canvas config now lives in SQLite app_config.
CANVAS_CONFIG_PATH = Path("data/agents_canvas.json")
CANVAS_CONFIG_KEY = "agents_canvas_config"
EXECUTION_HISTORY_FILE = Path("data/execution_history.json")
EXECUTION_HISTORY_MIGRATION_KEY = "execution_history_db_migration"
LEGACY_LIVE_CONFIG_PATH = Path("src/live_config.json")


def _canvas_data_access():
    from src.analytics.data_access import get_data_access
    return get_data_access()


def _normalize_canvas_config(payload: Any) -> Dict[str, Any]:
    return payload if isinstance(payload, dict) else {}


def _seed_canvas_config_if_missing() -> Dict[str, Any]:
    data_access = _canvas_data_access()
    current = _normalize_canvas_config(data_access.get_config(CANVAS_CONFIG_KEY))
    if current:
        return current

    legacy_payload: Dict[str, Any] = {}
    if CANVAS_CONFIG_PATH.exists():
        try:
            loaded = json.loads(CANVAS_CONFIG_PATH.read_text(encoding="utf-8"))
            legacy_payload = _normalize_canvas_config(loaded)
        except Exception as exc:
            logger.warning("Could not import legacy canvas config file: %s", exc)

    if not data_access.set_config(CANVAS_CONFIG_KEY, legacy_payload):
        raise RuntimeError("Failed to persist canvas config in DB")

    if CANVAS_CONFIG_PATH.exists():
        try:
            CANVAS_CONFIG_PATH.unlink(missing_ok=True)
        except Exception:
            logger.warning("Failed removing legacy canvas config file after DB import")

    return legacy_payload


def load_canvas_config() -> dict:
    """Load canvas configuration from DB app_config."""
    data_access = _canvas_data_access()
    config = _normalize_canvas_config(data_access.get_config(CANVAS_CONFIG_KEY))
    if config:
        return config
    return _seed_canvas_config_if_missing()


def save_canvas_config(config: dict):
    """Persist canvas configuration to DB app_config."""
    payload = _normalize_canvas_config(config)
    if not _canvas_data_access().set_config(CANVAS_CONFIG_KEY, payload):
        raise RuntimeError("Failed to save canvas configuration to DB")


def _migrate_live_config_if_needed() -> Dict[str, Any]:
    from src.analytics.db import get_analytics_db

    db = get_analytics_db()
    current = db.get_all_live_config() or {}
    if current:
        return current

    if not LEGACY_LIVE_CONFIG_PATH.exists():
        return current

    try:
        legacy_payload = json.loads(LEGACY_LIVE_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Could not parse legacy live config JSON: %s", exc)
        return current

    if not isinstance(legacy_payload, dict):
        return current

    for key, value in legacy_payload.items():
        db.set_live_config(str(key), value, "Imported from legacy live_config.json")

    try:
        LEGACY_LIVE_CONFIG_PATH.unlink(missing_ok=True)
    except Exception:
        logger.warning("Failed to remove legacy live config JSON after DB import")

    return db.get_all_live_config() or {}


def _migrate_execution_history_if_needed() -> None:
    from src.analytics.data_access import get_data_access

    data_access = get_data_access()
    migration_marker = data_access.get_config(EXECUTION_HISTORY_MIGRATION_KEY) or {}
    if migration_marker.get("done"):
        return

    inserted = 0
    if EXECUTION_HISTORY_FILE.exists():
        try:
            payload = json.loads(EXECUTION_HISTORY_FILE.read_text(encoding="utf-8"))
            if isinstance(payload, list):
                inserted = data_access.import_execution_history(payload)
        except Exception as exc:
            logger.warning("Failed to import legacy execution history JSON: %s", exc)

    marker_payload = {
        "done": True,
        "inserted": inserted,
        "completed_at": datetime.now().isoformat(),
    }
    if not data_access.set_config(EXECUTION_HISTORY_MIGRATION_KEY, marker_payload):
        raise RuntimeError("Failed to persist execution history migration marker")

    if EXECUTION_HISTORY_FILE.exists():
        try:
            EXECUTION_HISTORY_FILE.unlink(missing_ok=True)
        except Exception:
            logger.warning("Failed to remove legacy execution history JSON after DB import")


def get_next_available_position(canvas_config: dict) -> dict:
    """Find next available canvas position for a new agent."""
    # Get all occupied positions
    occupied = set()
    for agent_cfg in canvas_config.values():
        pos = agent_cfg.get("position", {})
        if pos:
            occupied.add((pos.get("x"), pos.get("y")))
    
    # Grid positions (based on room layout)
    # Row 1 (y=112): x = 64, 128, 192, 256, 320, 384, 448, 512, 576
    # Row 2 (y=176): x = 64, 128, 192, 256, 320, 384, 448, 512, 576
    # Row 3 (y=240): x = 64, 128, 192, 256, 320, 384, 448, 512, 576
    for y in [112, 176, 240]:
        for x in [64, 128, 192, 256, 320, 384, 448, 512, 576]:
            if (x, y) not in occupied:
                return {"x": x, "y": y}
    
    # Fallback: random position
    return {"x": 320, "y": 176}


def generate_random_color() -> str:
    """Generate a random hex color for new agents."""
    import random
    colors = [
        "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7",
        "#DDA0DD", "#98D8C8", "#F7DC6F", "#BB8FCE", "#85C1E9",
        "#F8B500", "#00CEC9", "#E056FD", "#686DE0", "#30336B"
    ]
    return random.choice(colors)


def _normalize_tradingagents_roster_key(value: Optional[str]) -> Optional[str]:
    return normalize_tradingagents_agent_id(value)


def _purge_roster_aliases(mapping: dict, canonical_id: str) -> dict:
    next_mapping = {}
    for key, value in (mapping or {}).items():
        normalized_key = _normalize_tradingagents_roster_key(key)
        if normalized_key and normalized_key == canonical_id and key != canonical_id:
            continue
        next_mapping[key] = value
    return next_mapping


def _get_canonical_agent_defaults(agent_id: str) -> Dict:
    agent = TRADINGAGENTS_AGENT_BY_ID[agent_id]
    return {
        "provider": "auto",
        "model": None,
        "personality": agent.get("personality", ""),
        "active": True,
        "default_animation": {
            "market_analyst": "sit_type",
            "social_analyst": "talk",
            "news_analyst": "read",
            "fundamentals_analyst": "read",
            "bull_researcher": "talk",
            "bear_researcher": "talk",
            "research_manager": "point",
            "trader": "talk",
            "aggressive_analyst": "talk",
            "conservative_analyst": "read",
            "neutral_analyst": "idle",
            "risk_judge": "point",
        }.get(agent_id, "idle"),
        "default_station": agent.get("station", "desk"),
        "default_path": "direct",
    }


_VALID_TRADINGAGENTS_STATIONS = {
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

_VALID_TRADINGAGENTS_PATHS = {"direct", "detour", "loop", "idle"}


def _clean_tradingagents_animation(value: Optional[str], fallback: str) -> str:
    cleaned = str(value or "").strip()
    return cleaned or fallback


def _clean_tradingagents_station(value: Optional[str], fallback: str) -> str:
    cleaned = str(value or "").strip().lower()
    return cleaned if cleaned in _VALID_TRADINGAGENTS_STATIONS else fallback


def _clean_tradingagents_path(value: Optional[str], fallback: str) -> str:
    cleaned = str(value or "").strip().lower()
    return cleaned if cleaned in _VALID_TRADINGAGENTS_PATHS else fallback


def _build_tradingagents_agent_profiles() -> Tuple[Dict[str, Dict], Dict[str, Dict]]:
    from src.llm.llm_config import load_config

    config = load_config()
    agent_config = config.get("agent_config", {})
    canvas_config = load_canvas_config()

    normalized_config = {}
    for key, cfg in agent_config.items():
        canonical_id = _normalize_tradingagents_roster_key(key)
        if canonical_id:
            normalized_config[canonical_id] = {**normalized_config.get(canonical_id, {}), **cfg}

    personalities: Dict[str, Dict] = {}
    behavior_defaults: Dict[str, Dict] = {}
    runtime_states = get_ui_agent_states_snapshot()

    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_id = agent["id"]
        display_name = agent["display_name"]
        default_cfg = _get_canonical_agent_defaults(agent_id)
        cfg = {**default_cfg, **normalized_config.get(agent_id, {})}
        canvas_info = canvas_config.get(agent_id, {})
        runtime_info = runtime_states.get(display_name, {})

        default_station = _clean_tradingagents_station(
            cfg.get("default_station"),
            default_cfg["default_station"],
        )
        default_animation = _clean_tradingagents_animation(
            cfg.get("default_animation"),
            default_cfg["default_animation"],
        )
        default_path = _clean_tradingagents_path(
            cfg.get("default_path"),
            default_cfg["default_path"],
        )

        personalities[agent_id] = {
            "name": agent_id,
            "displayName": display_name,
            "shortLabel": agent["short_label"],
            "personality": cfg.get("personality", agent["personality"]),
            "active": canvas_info.get("active", cfg.get("active", True)),
            "provider": cfg.get("provider", "auto"),
            "model": cfg.get("model"),
            "color": canvas_info.get("color", agent["color"]),
            "position": canvas_info.get("position", agent["position"]),
            "on_canvas": True,
            "status": runtime_info.get("status", "idle"),
            "station": default_station,
            "default_animation": default_animation,
            "default_station": default_station,
            "default_path": default_path,
        }

        behavior_defaults[agent_id] = {
            "id": agent_id,
            "displayName": display_name,
            "personality": personalities[agent_id]["personality"],
            "default_animation": default_animation,
            "default_station": default_station,
            "default_path": default_path,
            "active": personalities[agent_id]["active"],
        }

    return personalities, behavior_defaults


def get_tradingagents_agent_behavior_defaults() -> Dict[str, Dict]:
    _, behavior_defaults = _build_tradingagents_agent_profiles()
    return behavior_defaults

# Import the complete intelligence pipeline
from src.models.market_view import MarketView
from src.runtime.models import TradingDecision
from src.runtime.oracle import quick_oracle_decision
from src.runtime.scout import ScoutClient
from src.runtime.collaboration import collaboration_engine
from src.runtime.activity import (
    activity_logger, TradeLog, AgentActivityLog, 
    DataFetchLog
)
from src.runtime.state_manager import state_manager
from src.runtime.queue import ticker_queue
from src.llm.scene_generator import (
    generate_scene_script, 
    load_scriptwriter_config,
    save_scriptwriter_config,
    get_available_providers
)
from src.llm.scene_scheduler import get_scene_scheduler
from src.runtime.news_brain import bake_stage_package_for_news_item

# --- Backend Seams (Mission 3) Integration ---
from src.runtime.ws_broadcast_service import get_ws_service
from src.runtime.portfolio_service import get_portfolio_service
from src.runtime.pipeline_service import get_pipeline_service
from src.runtime.tradingagents_decision_service import get_tradingagents_decision_service
from src.integrations.tradingagents_roster import (
    build_tradingagents_canvas_agents,
    build_tradingagents_ui_states,
    normalize_tradingagents_agent_name,
    normalize_tradingagents_agent_id,
    TRADINGAGENTS_AGENT_BY_ID,
    TRADINGAGENTS_AGENT_DISPLAY_NAMES,
    TRADINGAGENTS_CANONICAL_AGENTS,
)

class WsWrapper:
    """Wrapper to bridge legacy ConnectionManager signature to new WsBroadcastService."""
    def __init__(self, service, channel):
        self.service = service
        self.channel = channel
    async def connect(self, ws):
        return await self.service.connect(ws, self.channel)
    def disconnect(self, ws):
        return self.service.disconnect(ws, self.channel)
    async def broadcast(self, msg):
        return await self.service.broadcast(msg, self.channel)
    @property
    def active_connections(self):
        if self.channel == "main": return self.service.active_connections
        return self.service.provider_stats_connections

_ws = get_ws_service()
_ps = get_portfolio_service()
_pipe = get_pipeline_service()

# Proxies to maintain backward compatibility across 4k+ lines of code
manager = WsWrapper(_ws, "main")
provider_stats_manager = WsWrapper(_ws, "provider-stats")
portfolio_manager = _ps.manager
portfolio_state = _ps.state
pipeline_state = _pipe.state
# --- End of Mission 3 Integration ---

router = APIRouter(tags=["trading-floor"])


PIPELINE_FEED_OPTIONS = ("market", "aggregated", "world", "company")

PIPELINE_CONFIG_DEFAULTS = {
    "provider": "nvidia",
    "model": "nvidia/llama-3.1-nemotron-70b-instruct",
    "bake_batch_size": 3,
    "scene_duration_sec": 180,
    "min_lines_per_agent": 2,
    "max_lines_per_agent": 3,
    "min_words_per_line": 8,
    "max_words_per_line": 18,
    "include_portfolio_context": True,
    "include_market_context": True,
}

_live_stage_state: Dict[str, Any] = {
    "current_package_id": None,
    "current_news_id": None,
    "current_package": None,
    "last_played_at": None,
}


class _LegacyStoreFallback:
    def __init__(self):
        self._settings: Dict[str, Any] = {}

    def get_setting(self, key: str, default: Any = None) -> Any:
        return self._settings.get(key, default)

    def set_setting(self, key: str, value: Any) -> None:
        self._settings[key] = value

    def get_recent_scripts(self, limit: int = 20) -> List[Dict[str, Any]]:
        return []


_legacy_store_fallback = _LegacyStoreFallback()


def _store():
    return _legacy_store_fallback


def _coerce_bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _build_raw_payload_json(payload: Any) -> str:
    try:
        return json.dumps(payload or {}, ensure_ascii=False, default=str)
    except Exception:
        return "{}"


def _classify_manual_source(url: str) -> Tuple[str, str]:
    host = (urlparse(url).netloc or "").lower()
    if "sec.gov" in host:
        return "filing", "SEC"
    if "bloomberg.com" in host:
        return "news", "Bloomberg"
    if "reuters.com" in host:
        return "news", "Reuters"
    if "wsj.com" in host:
        return "news", "WSJ"
    if "ft.com" in host:
        return "news", "Financial Times"
    return "manual", host or "manual-link"


async def _extract_manual_url_payload(_url: str) -> Dict[str, str]:
    # RSS/url scraping legacy removed; keep endpoint behavior with neutral payload.
    return {"headline": "", "summary": "", "body": ""}


def _sanitize_pipeline_config(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    current_llm = load_scriptwriter_config() or {}
    merged = {
        **PIPELINE_CONFIG_DEFAULTS,
        "provider": current_llm.get("provider", PIPELINE_CONFIG_DEFAULTS["provider"]),
        "model": current_llm.get("model", PIPELINE_CONFIG_DEFAULTS["model"]),
        "scene_duration_sec": int(current_llm.get("scene_duration_sec", PIPELINE_CONFIG_DEFAULTS["scene_duration_sec"]) or PIPELINE_CONFIG_DEFAULTS["scene_duration_sec"]),
        "min_lines_per_agent": int(current_llm.get("min_lines_per_agent", PIPELINE_CONFIG_DEFAULTS["min_lines_per_agent"]) or PIPELINE_CONFIG_DEFAULTS["min_lines_per_agent"]),
        "max_lines_per_agent": int(current_llm.get("max_lines_per_agent", PIPELINE_CONFIG_DEFAULTS["max_lines_per_agent"]) or PIPELINE_CONFIG_DEFAULTS["max_lines_per_agent"]),
        "min_words_per_line": int(current_llm.get("min_words_per_line", PIPELINE_CONFIG_DEFAULTS["min_words_per_line"]) or PIPELINE_CONFIG_DEFAULTS["min_words_per_line"]),
        "max_words_per_line": int(current_llm.get("max_words_per_line", PIPELINE_CONFIG_DEFAULTS["max_words_per_line"]) or PIPELINE_CONFIG_DEFAULTS["max_words_per_line"]),
        "bake_batch_size": int(current_llm.get("batch_size", PIPELINE_CONFIG_DEFAULTS["bake_batch_size"]) or PIPELINE_CONFIG_DEFAULTS["bake_batch_size"]),
        **(_store().get_setting("trading_floor_pipeline_config", {}) or {}),
        **(raw or {}),
    }
    merged["bake_batch_size"] = max(1, min(25, int(merged.get("bake_batch_size") or PIPELINE_CONFIG_DEFAULTS["bake_batch_size"])))
    merged["scene_duration_sec"] = max(30, min(1200, int(merged.get("scene_duration_sec") or PIPELINE_CONFIG_DEFAULTS["scene_duration_sec"])))
    merged["min_lines_per_agent"] = max(1, min(10, int(merged.get("min_lines_per_agent") or PIPELINE_CONFIG_DEFAULTS["min_lines_per_agent"])))
    merged["max_lines_per_agent"] = max(merged["min_lines_per_agent"], min(12, int(merged.get("max_lines_per_agent") or PIPELINE_CONFIG_DEFAULTS["max_lines_per_agent"])))
    merged["min_words_per_line"] = max(4, min(40, int(merged.get("min_words_per_line") or PIPELINE_CONFIG_DEFAULTS["min_words_per_line"])))
    merged["max_words_per_line"] = max(merged["min_words_per_line"], min(60, int(merged.get("max_words_per_line") or PIPELINE_CONFIG_DEFAULTS["max_words_per_line"])))
    merged["include_portfolio_context"] = _coerce_bool(merged.get("include_portfolio_context"), True)
    merged["include_market_context"] = _coerce_bool(merged.get("include_market_context"), True)
    merged["provider"] = str(merged.get("provider") or PIPELINE_CONFIG_DEFAULTS["provider"]).strip()
    merged["model"] = str(merged.get("model") or PIPELINE_CONFIG_DEFAULTS["model"]).strip()
    return merged


def _load_pipeline_config() -> Dict[str, Any]:
    return _sanitize_pipeline_config({})


def _save_pipeline_config(raw_updates: Dict[str, Any]) -> Dict[str, Any]:
    config = _sanitize_pipeline_config(raw_updates)
    _store().set_setting(
        "trading_floor_pipeline_config",
        {
            "include_portfolio_context": config["include_portfolio_context"],
            "include_market_context": config["include_market_context"],
        },
    )
    save_scriptwriter_config({
        "provider": config["provider"],
        "model": config["model"],
        "batch_size": config["bake_batch_size"],
        "scene_duration_sec": config["scene_duration_sec"],
        "min_lines_per_agent": config["min_lines_per_agent"],
        "max_lines_per_agent": config["max_lines_per_agent"],
        "min_words_per_line": config["min_words_per_line"],
        "max_words_per_line": config["max_words_per_line"],
    })
    return _load_pipeline_config()


 


def _serialize_stage_package(package: Optional[Dict[str, Any]], include_full: bool = False) -> Optional[Dict[str, Any]]:
    if not package:
        return None
    stage_payload = package.get("stage_payload") or {}
    context = package.get("context") or {}
    source = stage_payload.get("source") or context.get("source") or {}
    item = {
        "id": package.get("id"),
        "news_id": package.get("news_id"),
        "status": package.get("status"),
        "headline": package.get("headline") or stage_payload.get("headline") or "Market update",
        "ticker": stage_payload.get("ticker") or source.get("ticker") or "",
        "source_label": source.get("source_label") or source.get("source") or "Unknown",
        "source_type": source.get("source_type") or "",
        "summary": stage_payload.get("summary") or context.get("summary") or "",
        "reasoning": stage_payload.get("reasoning") or context.get("reasoning") or "",
        "prediction": stage_payload.get("prediction") or context.get("prediction") or "",
        "agents": stage_payload.get("agents") or (package.get("script") or {}).get("agents") or [],
        "dialogue_count": len(stage_payload.get("dialogue") or (package.get("script") or {}).get("dialogue") or []),
        "created_at": package.get("created_at"),
        "updated_at": package.get("updated_at"),
        "error": package.get("error"),
        "playback_started_at": package.get("playback_started_at"),
        "playback_completed_at": package.get("playback_completed_at"),
        "validation_attempts": package.get("validation_attempts") or 0,
    }
    if include_full:
        item["script"] = package.get("script") or {}
        item["actions"] = package.get("actions") or {}
        item["stage_payload"] = stage_payload
        item["context"] = context
    return item


def _serialize_pipeline_news_for_ui(item: Dict[str, Any]) -> Dict[str, Any]:
    title = item.get("normalized_headline") or item.get("title") or "Market update"
    source = item.get("source_label") or item.get("source") or item.get("source_type") or "news"
    return {
        "id": item.get("id"),
        "title": title,
        "text": title,
        "source": source,
        "source_label": source,
        "ticker": item.get("ticker") or "",
        "url": item.get("url") or "",
        "summary": item.get("normalized_summary") or item.get("summary") or "",
        "sentiment": item.get("sentiment") or 0,
        "timestamp": item.get("published") or item.get("created_at") or datetime.now().isoformat(),
    }


async def _broadcast_pipeline_news_items(items: List[Dict[str, Any]]) -> None:
    news_items = [_serialize_pipeline_news_for_ui(item) for item in (items or []) if item]
    news_items = [item for item in news_items if item.get("title") or item.get("text")]
    if not news_items:
        return

    marquee_text = " | ".join(
        f"[{item.get('source_label') or item.get('source') or 'NEWS'}] {item.get('title') or item.get('text')}"
        for item in news_items[:20]
    )
    await manager.broadcast({
        "type": "LIVE_NEWS_FEED",
        "data": {"articles": news_items[:20]},
    })
    await manager.broadcast({
        "type": "MARQUEE_UPDATE",
        "data": {"text": marquee_text},
    })
    for item in news_items[:20]:
        await manager.broadcast({
            "type": "streamed_news",
            "data": item,
        })


def _build_pipeline_portfolio_snapshot() -> Dict[str, Any]:
    sync_portfolio_state_from_sqlite()
    position_details = sync_open_position_prices_from_market()
    decision_service = get_tradingagents_decision_service()
    portfolio_rows = decision_service._portfolio_rows(portfolio_state)
    performance = decision_service.get_performance_summary(portfolio_state)
    top_rows = []
    for row in (portfolio_rows.get("rows") or [])[:8]:
        top_rows.append({
            "ticker": row.get("ticker"),
            "shares": row.get("shares"),
            "current_price": row.get("current_price"),
            "market_value": row.get("market_value"),
            "weight_pct": row.get("weight_pct"),
            "pnl_pct": row.get("pnl_pct"),
        })
    return {
        "timestamp": datetime.now().isoformat(),
        "cash": portfolio_state.get("cash", 0.0),
        "total_value": portfolio_rows.get("total_value", portfolio_state.get("total_value", 0.0)),
        "cash_weight_pct": portfolio_rows.get("cash_weight_pct", 0.0),
        "positions": top_rows,
        "position_details": {
            ticker: {
                "shares": details.get("shares"),
                "entry_price": details.get("entry_price"),
                "current_price": details.get("current_price"),
            }
            for ticker, details in (position_details or {}).items()
        },
        "performance": {
            "portfolio_return_pct": performance.get("portfolio_return_pct", 0.0),
            "sp500_return_pct": performance.get("sp500_return_pct", 0.0),
            "alpha_pct": performance.get("alpha_pct", 0.0),
            "unrealized_pnl": performance.get("unrealized_pnl", 0.0),
            "realized_pnl": performance.get("realized_pnl", 0.0),
        },
    }


def _build_pipeline_market_context(news_item: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    sync_portfolio_state_from_sqlite()
    decision_service = get_tradingagents_decision_service()
    performance = decision_service.get_performance_summary(portfolio_state)
    context = {
        "timestamp": datetime.now().isoformat(),
        "pipeline_phase": pipeline_state.get("phase", "IDLE"),
        "pipeline_ticker": pipeline_state.get("ticker", "---"),
        "portfolio_return_pct": performance.get("portfolio_return_pct", 0.0),
        "sp500_return_pct": performance.get("sp500_return_pct", 0.0),
        "alpha_pct": performance.get("alpha_pct", 0.0),
    }
    if news_item:
        context.update({
            "item_ticker": (news_item.get("ticker") or "").strip().upper(),
            "source_type": news_item.get("source_type") or "",
            "source_label": news_item.get("source_label") or news_item.get("source") or "",
            "sentiment": news_item.get("sentiment", 0),
        })
    return context


def _build_pipeline_status() -> Dict[str, Any]:
    store = _store()
    config = _load_pipeline_config()
    next_package = store.list_stage_packages(status="baked", limit=1)
    return {
        "timestamp": datetime.now().isoformat(),
        "config": config,
        "inputs": {
            "counts": store.count_news_statuses(),
            "last_import_at": store.get_setting("pipeline_last_import_at"),
            "last_import_count": store.get_setting("pipeline_last_import_count", 0),
            "last_import_inserted": store.get_setting("pipeline_last_import_inserted", 0),
        },
        "packages": {
            "counts": store.count_script_statuses(),
            "last_bake_at": store.get_setting("pipeline_last_bake_at"),
            "last_bake_count": store.get_setting("pipeline_last_bake_count", 0),
        },
        "next_playable_package": _serialize_stage_package(next_package[0] if next_package else None),
        "active_stage": {
            "current_package_id": _live_stage_state.get("current_package_id"),
            "current_news_id": _live_stage_state.get("current_news_id"),
            "current_package": _live_stage_state.get("current_package"),
            "last_played_at": _live_stage_state.get("last_played_at"),
            "running": bool(_live_stage_state.get("current_package")),
        },
    }

# ============================================================================
# EXPANDED TRADING UNIVERSE - 30+ Stocks Across Sectors
# ============================================================================
TRADING_UNIVERSE = {
    "tech": ["AAPL", "MSFT", "GOOGL", "NVDA", "META", "AMZN", "TSLA"],
    "finance": ["JPM", "BAC", "GS", "V", "MA"],
    "healthcare": ["JNJ", "UNH", "PFE", "ABBV"],
    "energy": ["XOM", "CVX", "COP"],
    "consumer": ["WMT", "HD", "MCD", "NKE", "COST"],
    "industrial": ["CAT", "BA", "GE"],
    "etfs": ["SPY", "QQQ", "IWM", "DIA"]
}

# Flatten to single list for easy access
ALL_TICKERS = [ticker for sector in TRADING_UNIVERSE.values() for ticker in sector]

# Initialize the AI systems
scout_client = ScoutClient()  # Scout API client
scout_screener = scout_client  # Alias for backward compatibility

# Agent MarketViews - each agent accumulates intelligence
agent_market_views = {
    "Warren": MarketView(),
    "Charlie": MarketView(), 
    "Technical": MarketView(),
    "Fundamental": MarketView(),
    "Sentiment": MarketView(),
    "Risk": MarketView(),
    "Momentum": MarketView(),
    "Value": MarketView(),
    "Growth": MarketView(),
    "Contrarian": MarketView(),
    "Oracle": MarketView(),
    "Scout": MarketView(),
    "Macro": MarketView(),
    "Activist": MarketView(),
    "Valuation": MarketView(),
}

# Agent state management
agent_states = {
    "Warren": {"position": {"x": 192, "y": 112}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "value"},
    "Charlie": {"position": {"x": 128, "y": 112}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "contrarian"},
    "Technical": {"position": {"x": 256, "y": 112}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "technical"},
    "Fundamental": {"position": {"x": 320, "y": 112}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "fundamental"},
    "Sentiment": {"position": {"x": 384, "y": 112}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "sentiment"},
    "Risk": {"position": {"x": 448, "y": 112}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "risk"},
    "Momentum": {"position": {"x": 512, "y": 112}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "momentum"},
    "Value": {"position": {"x": 192, "y": 176}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "value"},
    "Growth": {"position": {"x": 256, "y": 176}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "growth"},
    "Contrarian": {"position": {"x": 320, "y": 176}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "contrarian"},
    "Oracle": {"position": {"x": 384, "y": 176}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "oracle"},
    "Scout": {"position": {"x": 544, "y": 112}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "scout"},
    "Macro": {"position": {"x": 448, "y": 176}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "macro"},
    "Activist": {"position": {"x": 512, "y": 176}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "activist"},
    "Valuation": {"position": {"x": 576, "y": 176}, "status": "idle", "fatigue": 0, "last_action": None, "personality": "valuation"},
}

# Canonical TradingAgents UI state exposed to the v3 canvas/admin surfaces.
ui_agent_states = build_tradingagents_ui_states()

# ============================================================================
# PIPELINE STATE + BROADCAST
# ============================================================================

# Trading mode: "automatic" (full pipeline + trades), "manual" (user-initiated analysis only), "stopped"
trading_mode = "stopped"  # Start stopped - user picks mode from landing page

async def broadcast_pipeline_phase(
    phase: str,
    ticker: str = None,
    trade_date: str = None,
    llm_provider: str = None,
    quick_model: str = None,
    deep_model: str = None,
    cycle: int = None,
    regime: str = None,
    premortem_data: dict = None,
    war_room_brief: str = None,
    action: str = None,
    status: str = None,
    phase_num: int = None,
    pipeline_mode: str = None,
    active_run_id: str = None,
    current_step: str = None,
    agent_display_name: str = None,
    research_depth: str = None,
    message_type: str = "pipeline_phase"
):
    """Update global pipeline state and broadcast to all WebSocket clients."""
    pipeline_state["phase"] = phase
    if ticker is not None:
        pipeline_state["ticker"] = ticker
    if trade_date is not None:
        pipeline_state["trade_date"] = trade_date
    if llm_provider is not None:
        pipeline_state["llm_provider"] = llm_provider
    if quick_model is not None:
        pipeline_state["quick_model"] = quick_model
    if deep_model is not None:
        pipeline_state["deep_model"] = deep_model
    if cycle is not None:
        pipeline_state["cycle"] = cycle
    if regime is not None:
        pipeline_state["regime"] = regime
    if premortem_data is not None:
        pipeline_state["premortem_data"] = premortem_data
    if war_room_brief is not None:
        pipeline_state["war_room_brief"] = war_room_brief
    if action is not None:
        pipeline_state["action"] = action
        pipeline_state["status"] = action
    if status is not None:
        pipeline_state["status"] = status
    if phase_num is not None:
        pipeline_state["phase_num"] = phase_num
    if pipeline_mode is not None:
        pipeline_state["pipeline_mode"] = pipeline_mode
    if active_run_id is not None:
        pipeline_state["active_run_id"] = active_run_id
    if current_step is not None:
        pipeline_state["current_step"] = current_step
    if agent_display_name is not None:
        pipeline_state["agent_display_name"] = agent_display_name
    if research_depth is not None:
        pipeline_state["research_depth"] = research_depth
    pipeline_state["timestamp"] = datetime.now().isoformat()
    
    # Redis-backed queue telemetry should not break manual analysis updates.
    try:
        queue_status = await ticker_queue.get_status()
    except Exception as exc:
        logger.warning(f"Queue status unavailable during phase broadcast: {exc}")
        queue_status = {
            "connected": False,
            "size": 0,
            "current_ticker": None,
            "items": [],
        }

    await manager.broadcast({
        "type": message_type,
        "phase": phase,
        "ticker": pipeline_state["ticker"],
        "trade_date": pipeline_state.get("trade_date"),
        "llm_provider": pipeline_state.get("llm_provider"),
        "quick_model": pipeline_state.get("quick_model"),
        "deep_model": pipeline_state.get("deep_model"),
        "cycle": pipeline_state["cycle"],
        "regime": pipeline_state["regime"],
        "premortem_data": pipeline_state["premortem_data"],
        "war_room_brief": pipeline_state["war_room_brief"],
        "phase_num": pipeline_state.get("phase_num", 0),
        "pipeline_mode": pipeline_state.get("pipeline_mode"),
        "run_id": pipeline_state.get("active_run_id"),
        "active_run_id": pipeline_state.get("active_run_id"),
        "current_step": pipeline_state.get("current_step"),
        "agent_display_name": pipeline_state.get("agent_display_name"),
        "research_depth": pipeline_state.get("research_depth"),
        "status": pipeline_state.get("status", ""),
        "action": pipeline_state.get("action", ""),
        "queue_status": queue_status,
        "timestamp": pipeline_state["timestamp"],
    })

def clear_pipeline_state():
    """Reset the global pipeline state to clean defaults."""
    # 1. Reset analyst states to idle/fresh
    global agent_states, ui_agent_states
    for agent in agent_states:
        agent_states[agent].update({
            "status": "idle",
            "fatigue": 0,
            "last_action": None,
            "report": None,
            "evidence": None
        })
    ui_agent_states = build_tradingagents_ui_states()
        
    # 2. Reset standard pipeline fields
    pipeline_state.update({
        "phase": "IDLE",
        "ticker": None,
        "trade_date": None,
        "llm_provider": None,
        "quick_model": None,
        "deep_model": None,
        "cycle": 1,
        "regime": None,
        "premortem_data": None,
        "war_room_brief": None,
        "action": "WAITING",
        "status": "WAITING",
        "phase_num": 0,
        "pipeline_mode": None,
        "active_run_id": None,
        "current_step": None,
        "agent_display_name": None,
        "research_depth": None,
        "step_script": None,
        "step_script_meta": None,
        "live_step_dialogue": {},
        "ta_background_profiles": {},
        "ta_foreground_override": {},
        "agent_behavior_defaults": {},
        "llm_calls": 0,
        "tool_calls": 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "attempt": 1,
        "max_attempts": 1,
        "timestamp": datetime.now().isoformat()
    })
    
    # 3. Purge any stale TradingAgents keys
    keys_to_purge = [
        "ta_run_id", "ta_phase", "ta_status", 
        "prediction", "confidence", "final_decision"
    ]
    for k in keys_to_purge:
        if k in pipeline_state:
            del pipeline_state[k]


def update_ui_agent_state(agent_name: Optional[str], **updates):
    """Update canonical TradingAgents UI state without touching legacy agent internals."""
    if not agent_name:
        return

    display_name = normalize_tradingagents_agent_name(agent_name)
    if not display_name:
        return

    state = ui_agent_states.setdefault(display_name, {
        "status": "idle",
        "decision": None,
        "confidence": None,
        "ticker": None,
        "reasoning": None,
        "station": None,
    })
    state.update({k: v for k, v in updates.items() if v is not None})


def get_ui_agent_states_snapshot() -> Dict[str, Dict]:
    """Return a full canonical TradingAgents state object for UI consumers."""
    snapshot = build_tradingagents_ui_states()
    for agent_name, state in ui_agent_states.items():
        if agent_name in snapshot:
            snapshot[agent_name].update(state)
        else:
            snapshot[agent_name] = state
    return snapshot


def sync_portfolio_state_from_sqlite() -> Dict[str, Any]:
    """Refresh in-memory portfolio state from SQLite so admin reads stay consistent."""
    from src.analytics.data_access import get_data_access

    data_access = get_data_access()
    latest_state = data_access.get_latest_portfolio_state() or {}
    position_details = data_access.get_position_details() or {}
    positions = {
        ticker: int((details or {}).get("shares") or 0)
        for ticker, details in position_details.items()
        if int((details or {}).get("shares") or 0) > 0
    }

    portfolio_state["positions"] = positions
    if latest_state:
        portfolio_state["cash"] = latest_state.get("cash", portfolio_state.get("cash", 1100000.0))
        portfolio_state["total_value"] = latest_state.get("total_value", portfolio_state.get("total_value", 1100000.0))
        portfolio_state["daily_pnl"] = latest_state.get("daily_pnl", portfolio_state.get("daily_pnl", 0.0))
    if "portfolio_revision" not in portfolio_state:
        portfolio_state["portfolio_revision"] = 0
    try:
        portfolio_state["portfolio_revision"] = int(data_access.get_meta("portfolio_revision", portfolio_state["portfolio_revision"]) or portfolio_state["portfolio_revision"])
    except Exception:
        pass
    return {
        "latest_state": latest_state,
        "position_details": position_details,
    }


def sync_open_position_prices_from_market() -> Dict[str, Dict[str, Any]]:
    """Refresh current_price marks for open positions from the market data path."""
    from src.analytics.data_access import get_data_access

    data_access = get_data_access()
    position_details = data_access.get_position_details() or {}
    refreshed: Dict[str, Dict[str, Any]] = {}
    for ticker, details in position_details.items():
        shares = int((details or {}).get("shares") or 0)
        if shares <= 0:
            continue
        live_price = 0.0
        try:
            live_price = float(portfolio_manager._get_ticker_price(ticker) or 0.0)
        except Exception as exc:
            logger.warning("Price refresh failed for %s: %s", ticker, exc)
        if live_price > 0:
            try:
                data_access.update_position_price(ticker, live_price)
            except Exception as exc:
                logger.warning("Failed to persist position price for %s: %s", ticker, exc)
            updated = {**details, "current_price": live_price}
        else:
            updated = details
        refreshed[ticker] = updated
    return refreshed


async def _run_portfolio_sync_call(
    func,
    *args,
    timeout_seconds: float = 4.0,
    fallback=None,
    label: str = "portfolio sync call",
):
    """Run blocking portfolio helpers off the event loop with a safety timeout."""
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(func, *args),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        logger.warning("%s timed out after %.1fs", label, timeout_seconds)
    except Exception as exc:
        logger.warning("%s failed: %s", label, exc)
    return fallback


async def broadcast_live_portfolio_state() -> Dict[str, Any]:
    """Push the latest portfolio state to all connected clients immediately."""
    sqlite_snapshot = await _run_portfolio_sync_call(
        sync_portfolio_state_from_sqlite,
        timeout_seconds=2.0,
        fallback={},
        label="sync_portfolio_state_from_sqlite",
    ) or {}
    position_details = dict(sqlite_snapshot.get("position_details") or {})
    decision_service = get_tradingagents_decision_service()
    from src.analytics.data_access import get_data_access

    data_access = get_data_access()
    portfolio_view = await _run_portfolio_sync_call(
        decision_service._portfolio_rows,
        portfolio_state,
        timeout_seconds=4.0,
        fallback={"rows": [], "total_value": portfolio_state.get("total_value", 0.0), "cash_weight_pct": 0.0},
        label="broadcast_live_portfolio_state portfolio_rows",
    )
    performance = await _run_portfolio_sync_call(
        decision_service.get_performance_summary,
        portfolio_state,
        timeout_seconds=4.0,
        fallback={
            "portfolio_return_pct": 0.0,
            "sp500_return_pct": 0.0,
            "alpha_pct": 0.0,
            "unrealized_pnl": 0.0,
            "realized_pnl": 0.0,
            "win_rate": 0.0,
            "position_rows": [],
            "cash_weight_pct": 0.0,
        },
        label="broadcast_live_portfolio_state performance_summary",
    )
    analytics = await _run_portfolio_sync_call(
        portfolio_manager.get_portfolio_analytics,
        portfolio_state,
        timeout_seconds=3.0,
        fallback={
            "total_value": portfolio_state.get("total_value", 0.0),
            "cash": portfolio_state.get("cash", 0.0),
            "positions_count": len(portfolio_state.get("positions", {}) or {}),
            "total_trades": 0,
            "profitable_trades": 0,
            "win_rate": 0.0,
            "daily_pnl": portfolio_state.get("daily_pnl", 0.0),
            "total_return": 0.0,
        },
        label="broadcast_live_portfolio_state analytics",
    )
    spy_benchmark = {
        "aggregate": {
            "fund_return": performance.get("portfolio_return_pct", 0.0),
            "spy_return": performance.get("sp500_return_pct", 0.0),
            "alpha": performance.get("alpha_pct", 0.0),
        },
        "by_position": {},
    }
    closed_trades = data_access.list_closed_trades(limit=20)
    payload = {
        "type": "portfolio_update",
        "portfolio": {
            "cash": portfolio_state.get("cash", 0.0),
            "total_value": portfolio_view["total_value"],
            "daily_pnl": portfolio_state.get("daily_pnl", 0.0),
            "positions": dict(portfolio_state.get("positions", {}) or {}),
            "position_tracker": dict(portfolio_manager.position_tracker or {}),
            "position_rows": portfolio_view["rows"],
            "position_details": position_details,
            "performance_summary": performance,
            "cash_weight_pct": portfolio_view["cash_weight_pct"],
            "analytics": analytics,
            "closed_trades": closed_trades,
            "benchmark": {
                "daily_alpha_24h": performance.get("alpha_pct", 0.0),
                "daily_spy_return_24h": performance.get("sp500_return_pct", 0.0),
                "cumulative_alpha": performance.get("alpha_pct", 0.0),
                "cumulative_spy_return": performance.get("sp500_return_pct", 0.0),
            },
        },
        "cash": portfolio_state.get("cash", 0.0),
        "total_value": portfolio_view["total_value"],
        "daily_pnl": portfolio_state.get("daily_pnl", 0.0),
        "positions": dict(portfolio_state.get("positions", {}) or {}),
        "position_tracker": dict(portfolio_manager.position_tracker or {}),
        "position_rows": portfolio_view["rows"],
        "position_details": position_details,
        "performance_summary": performance,
        "analytics": analytics,
        "spy_benchmark": spy_benchmark,
        "closed_trades": closed_trades,
        "timestamp": datetime.now().isoformat(),
    }
    await manager.broadcast(payload)
    try:
        from src.runtime.redis_client import publish_event

        await publish_event("trading_floor_events", "portfolio_update", payload)
    except Exception as exc:
        logger.warning("Portfolio redis broadcast failed: %s", exc)
    return payload

# Portfolio loading is now handled by PortfolioService

# Market data cache
market_data_cache = {}
cache_timestamp = None

# Portfolio cache (5 second TTL)
_portfolio_cache = None
_portfolio_cache_time = None

# Performance history tracking (time-series data)
performance_history = []

async def update_performance_history():
    """Update performance history - called periodically"""
    try:
        # Get current performance
        spy = yf.Ticker("SPY")
        spy_hist = spy.history(period="1d")
        
        if not spy_hist.empty:
            spy_price = float(spy_hist["Close"].iloc[-1])
            spy_open = float(spy_hist["Open"].iloc[0])
            spy_daily_return = ((spy_price - spy_open) / spy_open) * 100
            
            initial_capital = 1100000.0
            current_value = portfolio_state["total_value"]
            fund_daily_return = ((current_value - initial_capital) / initial_capital) * 100
            alpha = fund_daily_return - spy_daily_return
            
            # Add to history
            performance_history.append({
                'timestamp': datetime.now().isoformat(),
                'fund_value': current_value,
                'spy_price': spy_price,
                'fund_return': fund_daily_return,
                'spy_return': spy_daily_return,
                'alpha': alpha,
                'beating_spy': alpha > 0
            })
            
            # Keep last 24 hours (288 points at 5-min intervals)
            if len(performance_history) > 288:
                performance_history[:] = performance_history[-288:]
                
            logger.info(f"📊 Performance history updated: {len(performance_history)} data points")
    except Exception as e:
        logger.error(f"Error updating performance history: {e}")

# WebSocket managers are now handled by WsBroadcastService via WsWrapper

# Import usage tracker and add demo data
from src.llm.usage_tracker import get_usage_tracker

# Add demo data for visualization
async def init_demo_stats():
    """Initialize demo stats for visualization"""
    tracker = get_usage_tracker()
    import time
    
    # Add some demo requests to show how it looks
    demo_providers = [
        ("nvidia", "nvidia/llama-3.1-70b-instruct", 15),
        ("openrouter", "openai/gpt-4o", 8),
        ("groq", "llama-3.1-70b-versatile", 12),
        ("google", "gemini-1.5-pro", 5),
    ]
    
    for provider, model, count in demo_providers:
        for i in range(count):
            await tracker.record_request(
                provider=provider,
                model=model,
                tokens=100 + i * 10,
                response_time=500 + i * 100,
                error=False
            )
            time.sleep(0.01)  # Small delay between records

# Initialize demo stats lazily (not at import time - no event loop)
# asyncio.create_task(init_demo_stats()) is called when router is mounted

@router.websocket("/ws/provider-stats")
async def provider_stats_websocket(websocket: WebSocket):
    """WebSocket endpoint for real-time LLM provider stats"""
    await provider_stats_manager.connect(websocket)
    
    tracker = get_usage_tracker()
    
    # Send initial stats
    initial_stats = await tracker.get_stats()
    await websocket.send_text(json.dumps({
        "type": "provider_stats",
        "providers": initial_stats,
        "timestamp": datetime.now().isoformat()
    }))
    
    try:
        while True:
            # Keep connection alive and send periodic updates
            await asyncio.sleep(5)  # Update every 5 seconds
            
            stats = await tracker.get_stats()
            await websocket.send_text(json.dumps({
                "type": "provider_stats",
                "providers": stats,
                "timestamp": datetime.now().isoformat()
            }))
            
    except WebSocketDisconnect:
        provider_stats_manager.disconnect(websocket)

@router.get("/api/provider-config")
async def get_provider_config():
    """Get provider configuration for UI"""
    from src.llm.providers_config import get_provider_metadata
    return get_provider_metadata()

@router.get("/api/provider-stats")
async def get_provider_stats():
    """HTTP endpoint to get current provider stats"""
    tracker = get_usage_tracker()
    summary = tracker.get_summary()
    return {
        "providers": summary,
        "timestamp": datetime.now().isoformat()
    }

# ============================================================================
# TICKER QUEUE ENDPOINTS
# ============================================================================

@router.get("/queue")
async def get_queue():
    """Get the current ticker analysis queue."""
    return await ticker_queue.get_status()

@router.post("/queue/analyze")
async def add_to_queue(request: Request):
    """Add a ticker to the processing queue."""
    try:
        data = await request.json()
        ticker = data.get("ticker")
        user = data.get("user", "viewer")
        
        if not ticker:
            raise HTTPException(status_code=400, detail="Ticker is required")
            
        success = await ticker_queue.add_ticker(ticker, user, bid_amount=0.0)
        
        if success:
            await manager.broadcast({
                "type": "queue_update",
                "status": await ticker_queue.get_status(),
                "event": f"New ticker added: {ticker} by {user}"
            })
            return {"success": True, "message": f"Added {ticker} to queue"}
        return {"success": False, "message": f"Failed to add {ticker}"}
        
    except Exception as e:
        logger.error(f"Error adding to queue: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/queue/bump")
async def bump_in_queue(request: Request):
    """Bump a ticker in the queue (!bump simulation)."""
    try:
        data = await request.json()
        ticker = data.get("ticker")
        amount = data.get("amount", 0.0)
        user = data.get("user", "whale")
        
        if not ticker or amount <= 0:
            raise HTTPException(status_code=400, detail="Ticker and positive amount required")
            
        success = await ticker_queue.bump_ticker(ticker, amount)
        
        if success:
            await manager.broadcast({
                "type": "queue_update",
                "status": await ticker_queue.get_status(),
                "event": f"💰 {ticker} BUMPED by ${amount}!"
            })
            return {"success": True, "message": f"Bumped {ticker} by ${amount}"}
        return {"success": False, "message": f"Failed to bump {ticker}"}
        
    except Exception as e:
        logger.error(f"Error bumping in queue: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/queue/clear")
async def clear_queue():
    """Clear all items from the incoming request queue."""
    try:
        cleared = await ticker_queue.clear()
        if not cleared:
            return {"success": True, "message": "Queue storage unavailable; nothing to clear."}
        
        await manager.broadcast({
            "type": "queue_update",
            "status": {"queue_size": 0, "top_5": [], "total_pot": 0},
            "event": "Queue cleared"
        })
        
        return {"success": True, "message": "Queue cleared"}
        
    except Exception as e:
        logger.error(f"Error clearing queue: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# STATUS ENDPOINTS (For BroadcastPanel)
# ============================================================================

@router.get("/news-buffer/status")
async def get_news_buffer_status():
    """Get status of the news refueling buffer."""
    try:
        from src.llm.news_buffer import get_news_buffer
    except ModuleNotFoundError:
        return {
            "status": "DISABLED",
            "reason": "news_buffer module unavailable",
            "queue_size": 0,
            "pending": 0,
            "timestamp": datetime.now().isoformat(),
        }

    buffer = get_news_buffer()
    return await buffer.get_status()

@router.get("/brain/status")
async def get_brain_status():
    """Get status of the script-generating brain."""
    store = _store()
    
    last_gen = store.get_setting("brain_last_generated")
    last_count = store.get_setting("brain_last_generated_count")
    llm_calls = store.get_setting("brain_llm_calls")
    
    # Simple heuristic for "thinking" status
    is_thinking = False
    try:
        if last_gen:
            last_dt = datetime.fromisoformat(last_gen)
            if (datetime.now() - last_dt).total_seconds() < 60:
                is_thinking = True
    except: pass
    
    return {
        "status": "THINKING" if is_thinking else "READY",
        "last_generated": last_gen,
        "last_count": last_count,
        "llm_calls": llm_calls,
        "timestamp": datetime.now().isoformat()
    }

@router.get("/brain/scripts")
async def get_brain_scripts(status: str = "queued", limit: int = 20, lite: bool = False):
    """Get scripts from the brain queue.
    
    Args:
        status: Filter by status (queued, completed, all)
        limit: Maximum number of scripts to return
        lite: If true, return minimal fields
    """
    store = _store()
    
    # Get scripts from news store
    scripts = store.get_recent_scripts(limit=limit) or []
    
    # Format scripts
    result = []
    for script in scripts:
        if lite:
            result.append({
                "id": script.get("id"),
                "title": script.get("title", "")[:50],
                "status": script.get("status", "queued"),
                "timestamp": script.get("created_at", ""),
            })
        else:
            result.append({
                "id": script.get("id"),
                "title": script.get("title", ""),
                "content": script.get("content", ""),
                "status": script.get("status", "queued"),
                "agent": script.get("agent", ""),
                "timestamp": script.get("created_at", ""),
            })
    
    # Get counts for brain status
    scripts_queued = len([s for s in scripts if s.get("status") == "queued"])
    news_scripted = store.get_setting("brain_last_generated_count") or 0
    
    return {
        "scripts": result,
        "scripts_queued": scripts_queued,
        "news_scripted": news_scripted,
        "total": len(result),
        "timestamp": datetime.now().isoformat()
    }

@router.get("/brain/scripts/{script_id}")
async def get_brain_script(script_id: str):
    """Get a specific script by ID."""
    store = _store()
    
    # Try to get from recent news
    recent = store.get_recent_scripts(limit=100) or []
    for script in recent:
        if str(script.get("id")) == str(script_id):
            return {
                "id": script.get("id"),
                "title": script.get("title", ""),
                "content": script.get("content", ""),
                "status": script.get("status", "queued"),
                "agent": script.get("agent", ""),
                "timestamp": script.get("created_at", ""),
            }
    
    return {"error": "Script not found", "id": script_id}, 404

@router.get("/stage/status")
async def get_stage_status():
    """Get status of the DB-backed live stage."""
    status = _build_pipeline_status()
    current_package = status["active_stage"].get("current_package") or {}
    next_package = status.get("next_playable_package") or {}
    stage_payload = current_package.get("stage_payload") or current_package
    return {
        "running": status["active_stage"].get("running", False),
        "current_package_id": status["active_stage"].get("current_package_id"),
        "current_headline": current_package.get("headline") or stage_payload.get("headline"),
        "current_package": current_package or None,
        "last_script_ts": status["active_stage"].get("last_played_at"),
        "next_scene_eta_sec": 0 if next_package else None,
        "next_package": next_package or None,
        "settings": {
            "scriptsPerWindow": 1,
            "windowMinutes": 1,
        },
        "timestamp": status.get("timestamp"),
    }

@router.get("/engine/status")
async def get_engine_status():
    """Get status of the trading analysis engine (pipeline)."""
    # Use existing pipeline_state (bridged from PipelineService)
    # Ensure it has labels expected by BroadcastPanel
    return {
        "phase": pipeline_state.get("phase", "IDLE"),
        "ticker": pipeline_state.get("ticker", "---"),
        "cycle": pipeline_state.get("cycle", 0),
        "status": "ACTIVE" if pipeline_state.get("phase") != "IDLE" else "AWAITING...",
        "timestamp": pipeline_state.get("timestamp", datetime.now().isoformat())
    }


@router.get("/pipeline/status")
async def get_pipeline_status():
    """Canonical admin status for pipeline intake + baked package playback."""
    return _build_pipeline_status()


@router.get("/pipeline/config")
async def get_pipeline_config():
    """Get DB-backed trading-floor pipeline config."""
    return _load_pipeline_config()


@router.post("/pipeline/config")
async def update_pipeline_config(request: Request):
    """Update DB-backed trading-floor pipeline config."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    config = _save_pipeline_config(payload or {})
    return {"success": True, "config": config}


@router.post("/pipeline/inputs/import-server-feed")
async def import_pipeline_server_feed(request: Request):
    """Import articles from one server-managed feed into the DB-backed input queue."""
    from src.llm.news_buffer import get_news_buffer

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    server_feed = str(payload.get("server_feed") or "market").strip().lower()
    if server_feed not in PIPELINE_FEED_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported server_feed '{server_feed}'")

    ticker = str(payload.get("ticker") or "").strip().upper()
    limit = max(1, min(100, int(payload.get("limit") or 20)))

    buffer = get_news_buffer()
    articles = await buffer.scrape_news([server_feed], ticker=ticker, limit=limit)
    items = []
    for article in articles:
        items.append({
            **article,
            "input_type": "server_feed",
            "source_type": server_feed,
            "source_label": server_feed.upper(),
            "normalized_headline": article.get("title") or "",
            "normalized_summary": article.get("summary") or "",
            "normalized_body": article.get("summary") or "",
            "extraction_status": "ready",
            "status": "queued",
        })

    store = _store()
    inserted = store.insert_news_items(items)
    now = datetime.now().isoformat()
    store.set_setting("pipeline_last_import_at", now)
    store.set_setting("pipeline_last_import_count", len(items))
    store.set_setting("pipeline_last_import_inserted", inserted)
    if inserted > 0:
        await _broadcast_pipeline_news_items(items[:20])

    return {
        "success": True,
        "server_feed": server_feed,
        "requested": len(items),
        "inserted": inserted,
        "timestamp": now,
    }


@router.post("/pipeline/inputs/enqueue-url")
async def enqueue_pipeline_input_url(request: Request):
    """Queue one manual URL for later stage-package baking."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    url = str(payload.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    ticker = str(payload.get("ticker") or "").strip().upper()
    headline_override = str(payload.get("headline_override") or "").strip()
    notes_override = str(payload.get("notes_override") or "").strip()
    source_type, source_label = _classify_manual_source(url)

    extraction_status = "ready"
    extracted = {"headline": "", "summary": "", "body": ""}
    extraction_error = None
    try:
        extracted = await _extract_manual_url_payload(url)
        if not any(extracted.values()):
            extraction_status = "empty"
    except Exception as exc:
        extraction_status = "fetch_failed"
        extraction_error = str(exc)

    normalized_headline = headline_override or extracted.get("headline") or ""
    normalized_summary = extracted.get("summary") or notes_override or ""
    normalized_body = extracted.get("body") or notes_override or normalized_summary
    needs_review = False
    review_reason = None
    if extraction_status != "ready" and not headline_override:
        needs_review = True
        review_reason = f"Extraction status: {extraction_status}"
    if not normalized_headline:
        needs_review = True
        review_reason = review_reason or "Missing headline"
        fallback_host = urlparse(url).netloc or "manual-link"
        normalized_headline = f"Needs review: {fallback_host}"

    item = {
        "title": normalized_headline,
        "source": source_label,
        "source_label": source_label,
        "source_type": source_type,
        "url": url,
        "summary": normalized_summary,
        "ticker": ticker,
        "input_type": "manual_url",
        "headline_override": headline_override,
        "notes_override": notes_override,
        "normalized_headline": normalized_headline,
        "normalized_summary": normalized_summary,
        "normalized_body": normalized_body,
        "extraction_status": extraction_status,
        "review_reason": review_reason,
        "raw_payload_json": _build_raw_payload_json({
            "url": url,
            "source_type": source_type,
            "extracted": extracted,
            "extraction_status": extraction_status,
            "error": extraction_error,
        }),
        "error": extraction_error,
        "status": "needs_review" if needs_review else "queued",
    }

    store = _store()
    inserted = store.insert_news_items([item])
    now = datetime.now().isoformat()
    store.set_setting("pipeline_last_import_at", now)
    store.set_setting("pipeline_last_import_count", 1)
    store.set_setting("pipeline_last_import_inserted", inserted)
    if inserted > 0:
        await _broadcast_pipeline_news_items([item])

    return {
        "success": inserted > 0,
        "duplicate": inserted == 0,
        "inserted": inserted,
        "item": {
            "url": url,
            "ticker": ticker,
            "source_type": source_type,
            "source_label": source_label,
            "headline": normalized_headline,
            "extraction_status": extraction_status,
            "review_reason": review_reason,
            "status": "needs_review" if needs_review else "queued",
            "error": extraction_error,
        },
    }


@router.get("/pipeline/inputs")
async def list_pipeline_inputs(
    status: Optional[str] = None,
    status_group: Optional[str] = None,
    source_id: Optional[int] = None,
    limit: int = 50,
):
    """List recent queued/processed pipeline inputs."""
    store = _store()
    items = store.list_inputs(
        status=status,
        status_group=status_group,
        source_id=source_id,
        limit=max(1, min(limit, 200)),
    )
    return {
        "items": items,
        "total": len(items),
        "status_group": status_group,
        "counts": store.count_news_statuses(),
        "timestamp": datetime.now().isoformat(),
    }


@router.patch("/pipeline/inputs/{input_id}")
async def update_pipeline_input(input_id: int, request: Request):
    """Update a queued input (review/repair)."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    updates = {
        "normalized_headline": payload.get("normalized_headline") or payload.get("headline"),
        "normalized_summary": payload.get("normalized_summary") or payload.get("summary"),
        "normalized_body": payload.get("normalized_body") or payload.get("body"),
        "ticker": payload.get("ticker"),
        "review_reason": payload.get("review_reason"),
        "error": payload.get("error"),
    }
    status = payload.get("status") or "queued"
    updates["status"] = status

    store = _store()
    updated = store.update_input(input_id, updates)
    if not updated:
        raise HTTPException(status_code=404, detail="Input not found")
    return {"success": True, "item": updated, "timestamp": datetime.now().isoformat()}


@router.post("/pipeline/bake")
async def bake_pipeline_inputs(request: Request):
    """Bake queued inputs into persisted full-roster stage packages."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    store = _store()
    config = _load_pipeline_config()
    batch_size = max(1, min(25, int(payload.get("batch_size") or config["bake_batch_size"])))
    provider = str(payload.get("provider") or config["provider"]).strip()
    model = str(payload.get("model") or config["model"]).strip()

    inputs = store.take_inputs_for_bake(batch_size)
    if not inputs:
        return {"success": False, "message": "No queued inputs to bake", "baked_count": 0}

    portfolio_snapshot = _build_pipeline_portfolio_snapshot() if config.get("include_portfolio_context") else {}
    baked_items = []
    errors = []

    for item in inputs:
        market_context = _build_pipeline_market_context(item) if config.get("include_market_context") else {}
        result = await bake_stage_package_for_news_item(
            news_item=item,
            script_cfg={
                "provider": provider,
                "model": model,
                "scene_duration_sec": config["scene_duration_sec"],
                "min_lines_per_agent": config["min_lines_per_agent"],
                "max_lines_per_agent": config["max_lines_per_agent"],
                "min_words_per_line": config["min_words_per_line"],
                "max_words_per_line": config["max_words_per_line"],
            },
            provider=provider,
            model=model,
            portfolio_snapshot=portfolio_snapshot,
            market_context=market_context,
        )

        if not result.get("success"):
            error_message = result.get("error") or "Bake failed"
            store.mark_input_error(int(item["id"]), error_message)
            errors.append({"news_id": item["id"], "headline": item.get("title"), "error": error_message})
            continue

        package_id = store.insert_stage_package({
            "news_id": item["id"],
            "headline": result["headline"],
            "script": result["script"],
            "actions": result["actions"],
            "stage_payload": result["stage_payload"],
            "context": result["context"],
            "provider": result["provider"],
            "model": result["model"],
            "status": "baked",
            "validation_attempts": result.get("validation_attempts", 0),
        })

        if not package_id:
            error_message = "Failed to persist baked package"
            store.mark_input_error(int(item["id"]), error_message)
            errors.append({"news_id": item["id"], "headline": item.get("title"), "error": error_message})
            continue

        store.mark_input_baked(int(item["id"]), int(package_id))
        baked_items.append(store.get_stage_package_by_id(int(package_id)))

    now = datetime.now().isoformat()
    store.set_setting("pipeline_last_bake_at", now)
    store.set_setting("pipeline_last_bake_count", len(baked_items))

    return {
        "success": len(baked_items) > 0,
        "requested": len(inputs),
        "baked_count": len(baked_items),
        "packages": [_serialize_stage_package(item, include_full=True) for item in baked_items if item],
        "errors": errors,
        "timestamp": now,
    }


@router.get("/stage/packages")
async def list_stage_packages(status: Optional[str] = None, limit: int = 50):
    """List persisted stage packages for admin rundown and playback."""
    store = _store()
    items = store.list_stage_packages(status=status, limit=max(1, min(limit, 200)))
    return {
        "items": [_serialize_stage_package(item, include_full=True) for item in items],
        "total": len(items),
        "counts": store.count_script_statuses(),
        "timestamp": datetime.now().isoformat(),
    }


@router.post("/stage/play/{package_id}")
async def play_stage_package(package_id: int):
    """Replay one persisted stage package on the live stage."""
    store = _store()
    package = store.get_stage_package_by_id(package_id)
    if not package:
        raise HTTPException(status_code=404, detail=f"Package {package_id} not found")

    if package.get("status") == "error":
        raise HTTPException(status_code=400, detail="Cannot play a package in error state")

    stage_payload = package.get("stage_payload") or {}
    if not stage_payload:
        raise HTTPException(status_code=400, detail="Package is missing stage payload")

    await manager.broadcast({
        "type": "scene_command",
        "command": {
            **stage_payload,
            "packageId": package_id,
        },
    })

    store.mark_package_status(package_id, "played")
    if package.get("news_id"):
        store.mark_input_played(int(package["news_id"]))

    full_package = store.get_stage_package_by_id(package_id)
    serialized = _serialize_stage_package(full_package, include_full=True)
    _live_stage_state.update({
        "current_package_id": package_id,
        "current_news_id": package.get("news_id"),
        "current_package": serialized,
        "last_played_at": datetime.now().isoformat(),
    })

    return {
        "success": True,
        "package": serialized,
        "timestamp": _live_stage_state["last_played_at"],
    }

@router.post("/stream-news")
async def stream_news(request: Request):
    """Stream news to all connected WebSocket clients and add to scene buffer."""
    try:
        data = await request.json()
        news_items = data.get("news", [])
        
        if not news_items:
            return {"success": False, "message": "No news items to stream"}
        
        # Add to scene scheduler buffer
        scheduler = get_scene_scheduler(manager.broadcast)
        scheduler.add_news(news_items)
        
        broadcast_count = 0
        for item in news_items:
            message = {
                "type": "streamed_news",
                "data": item
            }
            await manager.broadcast(message)
            broadcast_count += 1
            logger.info(f"Broadcast news: {item.get('title', '')[:50]}")
        
        return {
            "success": True, 
            "message": f"Streamed {broadcast_count} news items to {len(manager.active_connections)} clients",
            "clients": len(manager.active_connections),
            "buffer_size": len(scheduler.news_buffer)
        }
        
    except Exception as e:
        logger.error(f"Error streaming news: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/stream-buffer")
async def stream_buffer_to_floor(count: int = 5):
    """Stream headlines from Redis buffer to trading floor."""
    from src.llm.news_buffer import get_news_buffer
    
    buffer = get_news_buffer()
    headlines = await buffer.peek_headlines(count)
    
    if not headlines:
        return {"success": False, "message": "Buffer is empty"}
    
    # Broadcast as LIVE_NEWS_FEED event
    await manager.broadcast({
        "type": "LIVE_NEWS_FEED",
        "data": {"articles": headlines}
    })
    
    # Broadcast as MARQUEE_UPDATE event
    marquee_text = " | ".join([f"[{h.get('source', '')}] {h.get('title', '')}" for h in headlines])
    await manager.broadcast({
        "type": "MARQUEE_UPDATE",
        "data": {"text": marquee_text}
    })
    
    logger.info(f"Streamed {len(headlines)} headlines from buffer to {len(manager.active_connections)} clients")
    
    return {
        "success": True,
        "streamed": len(headlines),
        "clients": len(manager.active_connections)
    }

# ============================================================================
# SCRIPTWRITER ENDPOINTS
# ============================================================================

@router.get("/scriptwriter/config")
async def get_scriptwriter_config():
    """Get current scriptwriter LLM configuration."""
    return load_scriptwriter_config()

@router.post("/scriptwriter/config")
async def update_scriptwriter_config(request: Request):
    """Update scriptwriter LLM configuration."""
    try:
        data = await request.json()
        current = load_scriptwriter_config()
        current.update(data)
        save_scriptwriter_config(current)
        return {"success": True, "config": current}
    except Exception as e:
        logger.error(f"Error updating scriptwriter config: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/scriptwriter/providers")
async def list_scriptwriter_providers():
    """Get available LLM providers and models."""
    return {"providers": get_available_providers()}

@router.post("/generate-scenes")
async def generate_scenes(request: Request = None):
    """Generate and schedule 3 scenes from buffered news or live news API."""
    import httpx
    
    try:
        logger.info("🎬 generate_scenes endpoint called")
        scheduler = get_scene_scheduler(manager.broadcast)
        logger.info(f"   scheduler obtained, news_buffer size: {scheduler.get_buffer_size()}")
        
        # Optional: Add news from request - handle empty body gracefully
        if request:
            try:
                body = await request.body()
                if body:
                    data = await request.json()
                    news_items = data.get("news", [])
                    if news_items:
                        scheduler.add_news(news_items)
            except Exception as e:
                logger.warning(f"Could not parse request body: {e}, continuing with buffer")
        
        headlines = scheduler.get_top_headlines(3)
        logger.info(f"   headlines count: {len(headlines)}, headlines: {headlines}")
        
        # Fetch live news from finance_db_api if buffer is empty
        if len(headlines) < 3:
            logger.info("   Buffer empty, fetching live news from finance_db_api...")
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    # Try market news endpoint (works without OpenBB)
                    response = await client.get("http://localhost:8000/api/v2/news/market?limit=10&include_reddit=false")
                    if response.status_code == 200:
                        news_data = response.json()
                        articles = news_data.get("articles", [])
                        if articles:
                            # Add to buffer
                            for article in articles[:10]:
                                if isinstance(article, dict) and article.get("title"):
                                    sentiment_data = article.get("sentiment", {})
                                    sentiment_score = sentiment_data.get("score", 0) if isinstance(sentiment_data, dict) else 0
                                    scheduler.news_buffer.append({
                                        "title": article.get("title", ""),
                                        "sentiment": sentiment_score
                                    })
                            logger.info(f"   Fetched {len(articles)} live news articles")
                            headlines = scheduler.get_top_headlines(3)
            except Exception as e:
                logger.warning(f"Failed to fetch live news: {e}")
        
        # Use fallback headlines if still empty after trying live news
        if len(headlines) < 3:
            logger.info("   Using fallback headlines - no live news available")
            headlines = [
                "Markets show mixed signals amid economic uncertainty",
                "Tech sector rallies on strong earnings expectations",
                "Federal Reserve signals potential rate adjustments"
            ]
        
        # Generate scene script (1 LLM call)
        logger.info("   calling generate_scene_script...")
        scenes_data = await generate_scene_script(headlines)
        logger.info(f"   scenes_data received: {scenes_data}")
        scenes = scenes_data.get("scenes", [])
        
        if not scenes:
            return {"success": False, "message": "No scenes generated"}
        
        # Start drip-feeding scenes
        asyncio.create_task(scheduler.start_drip_feed(scenes))
        
        return {
            "success": True,
            "message": f"Generated {len(scenes)} scenes, drip-feeding over ~{len(scenes) * scheduler.scene_interval}s",
            "headlines_used": headlines,
            "scene_count": len(scenes)
        }
    except Exception as e:
        logger.error(f"Error generating scenes: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/scene/stop")
async def stop_scene_drip():
    """Stop the current scene drip-feed."""
    scheduler = get_scene_scheduler()
    if scheduler:
        scheduler.stop()
        return {"success": True, "message": "Scene drip-feed stopped"}
    return {"success": False, "message": "No scheduler active"}

@router.post("/api/test-provider")
async def test_provider(request: dict = {}):
    """Test endpoint to record a demo LLM request"""
    tracker = get_usage_tracker()
    
    provider = request.get('provider', 'nvidia')
    prompt = request.get('prompt', 'Test prompt')
    
    # Record a test request
    await tracker.record_request(
        provider=provider,
        model="default-model",
        tokens=len(prompt.split()) * 2,
        response_time=500.0 + (hash(provider) % 1000),
        error=False
    )
    
    return {
        "success": True,
        "message": "Test request recorded",
        "provider": provider,
        "model": "default-model"
    }

@router.post("/api/test-provider-real")
async def test_provider_real(request: Request):
    """Real LLM test - makes actual API calls to the specified provider"""
    import time
    import json
    tracker = get_usage_tracker()
    
    # Read raw body
    body = await request.body()
    try:
        data = json.loads(body) if body else {}
    except:
        data = {}
    
    provider = data.get('provider', 'nvidia')
    prompt = data.get('prompt', 'Say "OK" if you receive this.')
    model = data.get('model', None)  # User-selected model
    
    start_time = time.time()
    error_occurred = False
    error_msg = ""
    response_text = ""
    
    # Fallback models if none selected
    provider_models = {
        'nvidia': ['nvidia/llama-3.1-8b-instruct', 'nvidia/llama-3.2-1b-instruct', 'nvidia/llama-3.2-3b-instruct'],
        'groq': ['llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
        'ollama': ['llama3.2:3b', 'qwen2.5:3b', 'phi3.5:3.8b'],
        'openrouter': ['meta-llama/llama-3.1-8b-instruct', 'google/gemma-2-9b-it'],
        'google': ['gemini-2.0-flash'],
        'sambanova': ['Meta-Llama-3.1-8B-Instruct'],
        'huggingface': ['meta-llama/Llama-3.1-8B-Instruct'],
    }
    
    # Use user-selected model, or fall back to first in list
    models = provider_models.get(provider, [])
    if not model:
        model = models[0] if models else None
    
    try:
        # Import the LLM router
        from src.llm.router import get_router
        from src.llm.providers import get_provider_config
        
        # Get config for the specific provider
        config = get_provider_config(provider)
        
        if not config or not config.api_key:
            raise Exception(f"No API key found for provider: {provider}")
        
        # Create a router with just this provider
        router = get_router(providers=[provider])
        
        # Make the actual call with the selected or fallback model
        if model:
            response_text = await router.generate(prompt, model=model)
        else:
            response_text = await router.generate(prompt)
        
    except Exception as e:
        error_occurred = True
        error_msg = str(e)
        response_text = f"Error: {error_msg}"
    
    response_time = (time.time() - start_time) * 1000  # ms
    
    # Record the request in tracker
    model_used = model if model else "default-model"
    await tracker.record_request(
        provider=provider,
        model=model_used,
        tokens=len(prompt.split()) + len(response_text.split()),
        response_time=response_time,
        error=error_occurred
    )
    
    return {
        "success": not error_occurred,
        "provider": provider,
        "prompt": prompt,
        "response": response_text,
        "response_time_ms": round(response_time, 2),
        "error": error_msg if error_occurred else None
    }

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time trading floor updates
    
    Broadcasts:
    - Schedule phase changes
    - Price updates during trading hours
    - Auto-exit notifications
    """
    await manager.connect(websocket)

    async def _send_ws_payload(payload: Dict[str, Any]) -> bool:
        try:
            await websocket.send_text(json.dumps(_sanitize_floats(payload)))
            return True
        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected during send")
            return False
        except RuntimeError as exc:
            if "close message has been sent" in str(exc):
                logger.info("WebSocket closed before send completed")
                return False
            raise
    
    # Import schedule functions
    from src.runtime.schedule import get_phase_info, is_trading_hours, should_liquidate
    from src.runtime.redis_client import load_state_from_redis
    
    r_agents, r_portfolio, r_pipeline, r_position_tracker, r_trade_history = await load_state_from_redis()
    
    # Restore position tracker and trade history if available
    # MERGE with SQLite data - SQLite is source of truth for positions
    if r_position_tracker:
        # Start with Redis data
        merged_tracker = r_position_tracker.copy()
        # SQLite entries take precedence (overwrite Redis for same ticker)
        for ticker, info in portfolio_manager.position_tracker.items():
            merged_tracker[ticker] = info
        portfolio_manager.position_tracker = merged_tracker
        logger.info(f"[STARTUP] Merged position_tracker: {len(portfolio_manager.position_tracker)} entries from Redis + SQLite")
    else:
        # No Redis data, use SQLite data (already loaded in __init__)
        logger.info(f"[STARTUP] Using position_tracker from SQLite: {len(portfolio_manager.position_tracker)} entries")
    if r_trade_history:
        portfolio_manager.trade_history = r_trade_history
    
    # Send initial state
    sqlite_snapshot = await _run_portfolio_sync_call(
        sync_portfolio_state_from_sqlite,
        timeout_seconds=2.0,
        fallback={},
        label="ws initial sync_portfolio_state_from_sqlite",
    ) or {}
    position_details = dict(sqlite_snapshot.get("position_details") or {})
    decision_service = get_tradingagents_decision_service()
    portfolio_view = await _run_portfolio_sync_call(
        decision_service._portfolio_rows,
        portfolio_state,
        timeout_seconds=4.0,
        fallback={"rows": [], "total_value": portfolio_state.get("total_value", 0.0), "cash_weight_pct": 0.0},
        label="ws initial portfolio_rows",
    )
    performance = await _run_portfolio_sync_call(
        decision_service.get_performance_summary,
        portfolio_state,
        timeout_seconds=4.0,
        fallback={
            "portfolio_return_pct": 0.0,
            "sp500_return_pct": 0.0,
            "alpha_pct": 0.0,
            "position_rows": [],
            "cash_weight_pct": 0.0,
        },
        label="ws initial performance_summary",
    )
    pipeline_scenes = {}
    try:
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        pipeline_scenes = da.get_config("pipeline_scenes") or {}
    except Exception:
        pipeline_scenes = {}
    agent_behavior_defaults = {}
    try:
        agent_behavior_defaults = get_tradingagents_agent_behavior_defaults()
    except Exception:
        agent_behavior_defaults = {}
    initial_message = {
        "type": "initial_state",
        "agents": get_ui_agent_states_snapshot(),
        "portfolio": {
            **(r_portfolio if r_portfolio else portfolio_state),
            "total_value": portfolio_view["total_value"],
            "position_tracker": portfolio_manager.position_tracker,
            "position_details": position_details,
            "position_rows": portfolio_view["rows"],
            "performance_summary": performance,
            "benchmark": {
                "daily_alpha_24h": performance["alpha_pct"],
            },
        },
        "schedule": get_phase_info(),
        "pipeline_state": pipeline_state,
        "pipeline_scenes": pipeline_scenes,
        "agent_behavior_defaults": agent_behavior_defaults,
        "timestamp": datetime.now().isoformat()
    }
    logger.info(f"📤 Sending initial state to WebSocket client")
    if not await _send_ws_payload(initial_message):
        manager.disconnect(websocket)
        return
    
    # Background task for periodic updates
    last_phase = None
    update_counter = 0
    
    try:
        while True:
            # Wait for incoming messages with timeout for periodic updates
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=2.0)
                message = json.loads(data)
                
                if message.get("type") == "ping":
                    if not await _send_ws_payload({
                        "type": "pong",
                        "timestamp": datetime.now().isoformat()
                    }):
                        break
                elif message.get("type") == "streamed_news":
                    # Broadcast streamed news to ALL connected clients (from admin panel)
                    await manager.broadcast(message)
                    news_title = message.get('data', {}).get('title', '')[:50]
                    logger.info(f"Broadcast streamed news: {news_title}")
            except asyncio.TimeoutError:
                # Timeout - send periodic update
                pass
            
            # Periodic updates every 2 seconds
            update_counter += 1
            
            # Check for phase change
            current_phase_info = get_phase_info()
            current_phase = current_phase_info.get("phase")
            
            if current_phase != last_phase:
                last_phase = current_phase
                if not await _send_ws_payload({
                    "type": "phase_update",
                    "data": current_phase_info,
                    "llm_active": current_phase == "pre_market",
                    "timestamp": datetime.now().isoformat()
                }):
                    break
                logger.info(f"📤 Phase change broadcast: {current_phase}")
            
            # Price updates during trading hours (every 10 cycles = ~20 seconds)
            if is_trading_hours() and update_counter % 10 == 0:
                price_updates = await _get_position_prices()
                if price_updates:
                    if not await _send_ws_payload({
                        "type": "price_update",
                        "data": price_updates,
                        "portfolio_value": _calculate_portfolio_with_prices(price_updates),
                        "timestamp": datetime.now().isoformat()
                    }):
                        break
            
            # Check for EOD liquidation
            if should_liquidate():
                if not await _send_ws_payload({
                    "type": "liquidation_warning",
                    "message": "3:45 PM EST - Time Decay Rule triggered. Liquidating all positions.",
                    "timestamp": datetime.now().isoformat()
                }):
                    break
                
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    finally:
        manager.disconnect(websocket)

async def start_redis_listener():
    """Listens to Redis events from the Brain and broadcasts them to the WebSockets."""
    from src.runtime.redis_client import init_redis
    import src.runtime.redis_client as rc
    import asyncio
    import json

    degraded_logged = False

    try:
        while True:
            pubsub = None
            try:
                if not await init_redis() or rc.redis_client is None:
                    if not degraded_logged:
                        logger.warning("⚠️ Redis unavailable; trading floor listener is running in DB-only degraded mode.")
                        degraded_logged = True
                    await asyncio.sleep(15.0)
                    continue

                degraded_logged = False
                pubsub = rc.redis_client.pubsub()
                await pubsub.subscribe("trading_floor_events")
                logger.info("🎧 Subscribed to Redis channel: trading_floor_events")

                async for message in pubsub.listen():
                    if message["type"] == "message":
                        try:
                            data = json.loads(message["data"])
                            if data.get("ws_broadcasted"):
                                continue
                            await manager.broadcast(data)
                        except Exception as e:
                            logger.error(f"Error broadcasting redis message: {e}")
            except asyncio.CancelledError:
                logger.info("Redis listener cancelled")
                raise
            except Exception as e:
                await rc.mark_redis_unavailable(f"listener: {e}")
                logger.warning("⚠️ Redis listener degraded; retrying in 15s: %s", e)
                await asyncio.sleep(15.0)
            finally:
                if pubsub is not None:
                    try:
                        await pubsub.unsubscribe("trading_floor_events")
                    except Exception:
                        pass
                    try:
                        await pubsub.close()
                    except Exception:
                        pass
    except asyncio.CancelledError:
        return


async def _get_position_prices() -> Dict:
    """Get current prices for all held positions"""
    positions = portfolio_state.get("positions", {})
    if not positions:
        return {}
    
    prices = {}
    for symbol in positions.keys():
        try:
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period="1d")
            if not hist.empty:
                prices[symbol] = {
                    "price": float(hist["Close"].iloc[-1]),
                    "shares": positions[symbol],
                }
        except Exception as e:
            logger.debug(f"Could not get price for {symbol}: {e}")
    
    return prices


def _calculate_portfolio_with_prices(price_updates: Dict) -> float:
    """Calculate total portfolio value with latest prices"""
    total = portfolio_state.get("cash", 0)
    for symbol, data in price_updates.items():
        total += data["price"] * data["shares"]
    return total


@router.get("/agents")
async def get_agents():
    """Get current agent states"""
    return {
        "agents": get_ui_agent_states_snapshot(),
        "timestamp": datetime.now().isoformat()
    }


@router.get("/schedule/phase")
async def get_schedule_phase():
    """Get current schedule phase and market status"""
    from src.runtime.schedule import get_phase_info, get_next_phase, is_llm_active, should_run_gossip_engine
    
    phase_info = get_phase_info()
    next_phase, seconds_until = get_next_phase()
    
    return {
        "current_phase": phase_info,
        "next_phase": next_phase.value,
        "seconds_until_next": seconds_until,
        "llm_active": is_llm_active(),
        "gossip_active": should_run_gossip_engine(),
        "timestamp": datetime.now().isoformat()
    }


@router.get("/mode")
async def get_mode():
    """Get current trading mode"""
    global trading_mode
    return {"mode": trading_mode}


@router.post("/mode/{mode}")
async def set_mode(mode: str):
    """Set trading mode: automatic, manual, or stopped"""
    global trading_mode
    if mode not in ("automatic", "manual", "stopped"):
        raise HTTPException(status_code=400, detail="Mode must be: automatic, manual, or stopped")

    old_mode = trading_mode
    trading_mode = mode

    # Control the autonomous trader
    try:
        from src.runtime.automation import autonomous_trader
        if mode == "automatic" and old_mode != "automatic":
            # Start the autonomous loop if not already running
            if not autonomous_trader.running:
                import asyncio
                asyncio.create_task(autonomous_trader.start())
                logger.info("Autonomous trading loop STARTED (mode=automatic)")
            for agent_name in agent_states:
                agent_states[agent_name]["status"] = "active"
                agent_states[agent_name]["fatigue"] = 0
        elif mode != "automatic" and old_mode == "automatic":
            # Stop the autonomous loop
            autonomous_trader.stop()
            logger.info("Autonomous trading loop STOPPED (mode=%s)", mode)
            for agent_name in agent_states:
                agent_states[agent_name]["status"] = "idle"
    except Exception as e:
        logger.warning("Could not control autonomous trader: %s", e)

    await manager.broadcast({
        "type": "mode_changed",
        "mode": mode,
        "previous": old_mode,
        "timestamp": datetime.now().isoformat()
    })

    return {"success": True, "mode": mode, "previous": old_mode}


@router.post("/simulation/start")
async def start_simulation():
    """Start the autonomous simulation (legacy - use /mode/automatic)"""
    return await set_mode("automatic")


@router.post("/simulation/stop")
async def stop_simulation():
    """Stop the autonomous simulation (legacy - use /mode/stopped)"""
    return await set_mode("stopped")


# ============================================
# THEATRICAL AUTOPILOT ROUTES
# ============================================

@router.post("/theatrical/start")
async def start_theatrical_autopilot():
    """Start the theatrical autopilot (gossip-only, no trading)"""
    try:
        from src.theatrical_autopilot import start_autopilot, is_autopilot_running
        
        if is_autopilot_running():
            return {"success": True, "status": "already_running", "message": "Theatrical autopilot already running"}
        
        # Start in background
        import asyncio
        asyncio.create_task(start_autopilot())
        
        logger.info("Theatrical autopilot STARTED")
        return {"success": True, "status": "started", "message": "Theatrical autopilot started"}
    except Exception as e:
        logger.error(f"Failed to start theatrical autopilot: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/theatrical/stop")
async def stop_theatrical_autopilot():
    """Stop the theatrical autopilot"""
    try:
        from src.theatrical_autopilot import stop_autopilot, is_autopilot_running
        
        if not is_autopilot_running():
            return {"success": True, "status": "already_stopped", "message": "Theatrical autopilot not running"}
        
        stop_autopilot()
        
        logger.info("Theatrical autopilot STOPPED")
        return {"success": True, "status": "stopped", "message": "Theatrical autopilot stopped"}
    except Exception as e:
        logger.error(f"Failed to stop theatrical autopilot: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/theatrical/status")
async def get_theatrical_status():
    """Get theatrical autopilot status"""
    try:
        from src.theatrical_autopilot import is_autopilot_running
        return {
            "running": is_autopilot_running(),
            "mode": "theatrical" if is_autopilot_running() else "idle"
        }
    except Exception as e:
        return {"running": False, "mode": "error", "error": str(e)}


@router.post("/agents/{agent_name}/action")
async def trigger_agent_action(agent_name: str, action: dict):
    """Trigger a specific action for an agent - with COMPLETE AI PIPELINE"""
    if agent_name not in agent_states:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    action_type = action.get("type", "unknown")
    
    # REAL MARKET DATA OPERATIONS WITH MARKETVIEW UPDATES
    real_data = None
    if action_type == "TICKER":
        # Real price data from Yahoo Finance + MarketView update
        real_data = await get_real_ticker_data(agent_name)
    elif action_type == "TV":
        # Real news sentiment + MarketView update
        real_data = await get_real_news_sentiment(agent_name)
    elif action_type == "NEWS":
        # Real fundamental data + MarketView update
        real_data = await get_real_fundamentals(agent_name)
    elif action_type == "DESK":
        # COMPLETE ORACLE INTELLIGENCE PIPELINE
        real_data = await execute_oracle_analysis(agent_name)
    elif action_type == "SCANNER":
        # SCOUT'S MARKET SCANNING (Scout agent only)
        if agent_name == "Scout":
            real_data = await scout_scan_market(agent_name)
        else:
            real_data = {"type": "error", "message": "Only Scout can use SCANNER station"}
    
    # Update agent state
    agent_states[agent_name]["status"] = "active"
    agent_states[agent_name]["last_action"] = action_type
    agent_states[agent_name]["fatigue"] += 1
    
    # Broadcast with real data
    broadcast_message = {
        "type": "agent_action",
        "agent": agent_name,
        "action": action,
        "real_data": real_data,
        "timestamp": datetime.now().isoformat()
    }
    logger.info(f"📡 Broadcasting agent action: {agent_name} - {action_type} to {len(manager.active_connections)} connections")
    await manager.broadcast(broadcast_message)
    
    return {"success": True, "agent": agent_name, "action": action, "real_data": real_data}


async def get_real_ticker_data(agent_name: str = None):
    """Fetch REAL current market prices and update agent's MarketView - EXPANDED UNIVERSE"""
    try:
        # Select random sample from expanded universe (10 tickers per fetch)
        import random
        symbols = random.sample(ALL_TICKERS, min(10, len(ALL_TICKERS)))
        data = {}
        
        for symbol in symbols:
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period="1d")
            if not hist.empty:
                current_price = float(hist["Close"].iloc[-1])
                prev_close = float(hist["Open"].iloc[0])
                change_pct = ((current_price - prev_close) / prev_close) * 100
                
                price_data = {
                    "price": current_price,
                    "change_pct": change_pct,
                    "volume": int(hist["Volume"].iloc[-1]),
                    "high": float(hist["High"].iloc[-1]),
                    "low": float(hist["Low"].iloc[-1])
                }
                
                data[symbol] = price_data
                
                # Update agent's MarketView if specified
                if agent_name and agent_name in agent_market_views:
                    agent_market_views[agent_name].update_prices(symbol, price_data)
        
        # Log data fetch
        if agent_name:
            activity_logger.log_data_fetch(DataFetchLog(
                timestamp=datetime.now().isoformat(),
                agent_name=agent_name,
                data_type="prices",
                symbols=list(data.keys()),
                source="Yahoo Finance",
                success=True
            ))
            
            # Log agent activity
            activity_logger.log_agent_activity(AgentActivityLog(
                timestamp=datetime.now().isoformat(),
                agent_name=agent_name,
                activity_type="TICKER",
                data_received={"symbols_count": len(data)},
                result="success",
                fatigue_level=agent_states.get(agent_name, {}).get("fatigue", 0)
            ))
        
        return {"type": "ticker_data", "symbols": data, "source": "Yahoo Finance LIVE"}
    except Exception as e:
        logger.error(f"Error fetching real ticker data: {e}")
        
        # Log failed fetch
        if agent_name:
            activity_logger.log_data_fetch(DataFetchLog(
                timestamp=datetime.now().isoformat(),
                agent_name=agent_name,
                data_type="prices",
                symbols=[],
                source="Yahoo Finance",
                success=False,
                error=str(e)
            ))
        
        return {"type": "ticker_data", "error": str(e)}


async def get_real_news_sentiment(agent_name: str = None):
    """Fetch REAL news headlines and sentiment, update agent's MarketView"""
    try:
        # Get real news from Yahoo Finance
        spy = yf.Ticker("SPY")
        news = spy.news if hasattr(spy, 'news') else []
        
        headlines = []
        sentiment_score = 0.0
        
        if news and len(news) > 0:
            for item in news[:5]:  # Top 5 headlines
                headline_data = {
                    "title": item.get("title", ""),
                    "publisher": item.get("publisher", ""),
                    "link": item.get("link", "")
                }
                headlines.append(headline_data)
                
                # Simple sentiment scoring (can be enhanced with real NLP)
                title = item.get("title", "").lower()
                if any(word in title for word in ["surge", "rally", "gain", "up", "bull", "high", "strong"]):
                    sentiment_score += 0.2
                elif any(word in title for word in ["drop", "fall", "crash", "down", "bear", "low", "weak"]):
                    sentiment_score -= 0.2
        else:
            # Fallback: Generate sample headlines if API fails
            logger.warning("No news from Yahoo Finance, using fallback data")
            headlines = [
                {"title": "Market shows mixed signals amid economic data", "publisher": "Market Watch", "link": ""},
                {"title": "Tech stocks lead market activity", "publisher": "Financial Times", "link": ""},
                {"title": "Investors monitor Fed policy signals", "publisher": "Reuters", "link": ""},
                {"title": "S&P 500 maintains steady performance", "publisher": "Bloomberg", "link": ""},
                {"title": "Trading volume remains elevated", "publisher": "CNBC", "link": ""}
            ]
            sentiment_score = 0.1  # Slightly positive
        
        sentiment_data = {
            "headlines": headlines,
            "sentiment_score": max(-1.0, min(1.0, sentiment_score)),
            "news_count": len(headlines)
        }
        
        # Update agent's MarketView if specified
        if agent_name and agent_name in agent_market_views:
            agent_market_views[agent_name].update_sentiment("SPY", sentiment_data)
        
        return {"type": "news_sentiment", "data": sentiment_data, "source": "Yahoo Finance News LIVE"}
    except Exception as e:
        logger.error(f"Error fetching real news: {e}")
        # Return fallback data on error
        fallback_data = {
            "headlines": [
                {"title": "Market analysis continues", "publisher": "Market News", "link": ""},
                {"title": "Economic indicators reviewed", "publisher": "Financial Press", "link": ""},
                {"title": "Trading activity monitored", "publisher": "Market Watch", "link": ""}
            ],
            "sentiment_score": 0.0,
            "news_count": 3
        }
        return {"type": "news_sentiment", "data": fallback_data, "source": "Fallback Data"}


async def get_real_fundamentals(agent_name: str = None):
    """Fetch REAL fundamental data, update agent's MarketView - EXPANDED UNIVERSE"""
    try:
        # Select fundamentals from expanded universe (5 random stocks)
        import random
        symbols = random.sample(ALL_TICKERS, min(5, len(ALL_TICKERS)))
        data = {}
        
        for symbol in symbols:
            ticker = yf.Ticker(symbol)
            info = ticker.info
            
            fundamental_data = {
                "pe_ratio": info.get("trailingPE", 0),
                "market_cap": info.get("marketCap", 0),
                "revenue_growth": info.get("revenueGrowth", 0),
                "profit_margin": info.get("profitMargins", 0),
                "analyst_target": info.get("targetMeanPrice", 0),
                "debt_to_equity": info.get("debtToEquity", 0),
                "roe": info.get("returnOnEquity", 0)
            }
            
            data[symbol] = fundamental_data
            
            # Update agent's MarketView if specified
            if agent_name and agent_name in agent_market_views:
                agent_market_views[agent_name].update_fundamentals(symbol, fundamental_data)
        
        return {"type": "fundamentals", "symbols": data, "source": "Yahoo Finance Fundamentals LIVE"}
    except Exception as e:
        logger.error(f"Error fetching real fundamentals: {e}")
        return {"type": "fundamentals", "error": str(e)}


async def execute_oracle_analysis(agent_name: str, symbol: str = None, use_fast_oracle: bool = True):
    """
    Execute Oracle intelligence pipeline:
    - use_fast_oracle=True: Fast heuristic-based decisions (< 1 second)
    - use_fast_oracle=False: Full 11-voice LLM pipeline (30-60 seconds)
    
    Agent MarketView → Oracle Analysis → Portfolio Manager → Trade Execution
    """
    try:
        # If no symbol specified, select from expanded universe based on agent's data
        if not symbol:
            market_view = agent_market_views.get(agent_name)
            if market_view and market_view.prices:
                # Pick a symbol the agent has data for
                import random
                available_symbols = list(market_view.prices.keys())
                symbol = random.choice(available_symbols) if available_symbols else random.choice(ALL_TICKERS)
            else:
                # Pick random from expanded universe
                import random
                symbol = random.choice(ALL_TICKERS)
        
        symbol = symbol.upper()
        
        # Check if agent has sufficient data to trade
        agent_personality = {
            "Warren": "value", "Charlie": "contrarian", "Technical": "technical",
            "Fundamental": "fundamental", "Sentiment": "sentiment", "Risk": "risk",
            "Momentum": "momentum", "Value": "value", "Growth": "growth",
            "Contrarian": "contrarian", "Oracle": "oracle"
        }.get(agent_name, "neutral")
        
        market_view = agent_market_views.get(agent_name)
        
        # Debug logging
        logger.info(f"🔍 {agent_name} attempting to trade {symbol}")
        logger.info(f"   Personality: {agent_personality}")
        logger.info(f"   Has prices: {symbol in market_view.prices if market_view else False}")
        logger.info(f"   Has fundamentals: {symbol in market_view.fundamentals if market_view else False}")
        logger.info(f"   Has sentiment: {symbol in market_view.sentiment if market_view else False}")
        
        if market_view:
            logger.info(f"   Staleness keys: {list(market_view.staleness.keys())}")
            can_trade = market_view.can_trade(agent_personality, symbol)
            logger.info(f"   Can trade: {can_trade}")
        
        if not market_view or not market_view.can_trade(agent_personality, symbol):
            return {
                "type": "trade_analysis",
                "error": f"{agent_name} needs more market data before trading {symbol}",
                "required_data": f"Agent needs fresh data for {agent_personality} analysis",
                "debug_info": {
                    "personality": agent_personality,
                    "has_prices": symbol in market_view.prices if market_view else False,
                    "has_fundamentals": symbol in market_view.fundamentals if market_view else False,
                    "has_sentiment": symbol in market_view.sentiment if market_view else False,
                    "staleness_keys": list(market_view.staleness.keys()) if market_view else []
                }
            }
        
        # Choose Oracle engine
        if use_fast_oracle:
            # Fast Oracle: Heuristic-based decision (< 1 second)
            logger.info(f"⚡ {agent_name} using Quick Oracle for {symbol}...")
            
            # Get current price from market view
            price_data = market_view.prices.get(symbol, {})
            current_price = price_data.get('current_price', 0) if isinstance(price_data, dict) else 0
            
            # Call quick oracle API
            decision_result = await quick_oracle_decision(
                ticker=symbol,
                current_price=current_price,
                agent_personality=agent_personality
            )
            
            # Convert to TradingDecision object
            trading_decision = TradingDecision(
                symbol=decision_result.symbol,
                action=decision_result.action,
                quantity=decision_result.quantity,
                confidence=decision_result.confidence,
                reasoning=decision_result.reasoning,
                risk_score=decision_result.risk_score,
                expected_return=decision_result.expected_return,
                time_horizon=decision_result.time_horizon,
                agent_consensus={agent_name: decision_result.action}
            )
        else:
            # Full Oracle: Not implemented via API - use fast oracle fallback
            logger.info(f"🧠 {agent_name} using Quick Oracle (full pipeline via API not available)...")
            price_data = market_view.prices.get(symbol, {})
            current_price = price_data.get('current_price', 0) if isinstance(price_data, dict) else 0
            
            decision_result = await quick_oracle_decision(
                ticker=symbol,
                current_price=current_price,
                agent_personality=agent_personality
            )
            
            trading_decision = TradingDecision(
                symbol=decision_result.symbol,
                action=decision_result.action,
                quantity=decision_result.quantity,
                confidence=decision_result.confidence,
                reasoning=decision_result.reasoning,
                risk_score=decision_result.risk_score,
                expected_return=decision_result.expected_return,
                time_horizon=decision_result.time_horizon,
                agent_consensus={agent_name: decision_result.action}
            )
        
        # Portfolio Manager evaluates the decision - basic risk checks
        should_execute = (
            trading_decision.confidence >= 0.55 and
            trading_decision.risk_score <= 0.8 and
            trading_decision.action in ("BUY", "SELL")
        )
        
        if should_execute:
            # Execute the trade through Portfolio Manager
            execution_result = await portfolio_manager.execute_oracle_decision(
                trading_decision, portfolio_state
            )
            
            if execution_result.success:
                # Log successful trade
                activity_logger.log_trade(TradeLog(
                    timestamp=datetime.now().isoformat(),
                    agent_name=agent_name,
                    symbol=symbol,
                    action=execution_result.action,
                    quantity=execution_result.quantity,
                    price=execution_result.price,
                    value=execution_result.value,
                    oracle_confidence=trading_decision.confidence,
                    oracle_reasoning=trading_decision.reasoning,
                    success=True,
                    portfolio_value_before=execution_result.portfolio_impact.get('portfolio_value_before', 0) if execution_result.portfolio_impact else 0,
                    portfolio_value_after=execution_result.portfolio_impact.get('new_portfolio_value', 0) if execution_result.portfolio_impact else 0
                ))
                
                # Log agent activity
                activity_logger.log_agent_activity(AgentActivityLog(
                    timestamp=datetime.now().isoformat(),
                    agent_name=agent_name,
                    activity_type="DESK",
                    symbol=symbol,
                    result=f"{execution_result.action} {execution_result.quantity} @ ${execution_result.price:.2f}",
                    fatigue_level=agent_states.get(agent_name, {}).get("fatigue", 0)
                ))
                
                # Update performance history after successful trade
                await update_performance_history()
                
                return {
                    "type": "trade_executed",
                    "agent": agent_name,
                    "symbol": symbol,
                    "action": execution_result.action,
                    "quantity": execution_result.quantity,
                    "price": execution_result.price,
                    "value": execution_result.value,
                    "oracle_confidence": trading_decision.confidence,
                    "oracle_reasoning": trading_decision.reasoning,
                    "portfolio_impact": execution_result.portfolio_impact,
                    "oracle_type": "FAST" if use_fast_oracle else "FULL",
                    "source": "ORACLE INTELLIGENCE PIPELINE"
                }
            else:
                # Log rejected trade (but NOT HOLD decisions)
                if trading_decision.action != "HOLD":
                    activity_logger.log_trade(TradeLog(
                        timestamp=datetime.now().isoformat(),
                        agent_name=agent_name,
                        symbol=symbol,
                        action=trading_decision.action,
                        quantity=trading_decision.quantity,
                        price=execution_result.price,
                        value=execution_result.value,
                        oracle_confidence=trading_decision.confidence,
                        oracle_reasoning=trading_decision.reasoning,
                        success=False,
                        rejection_reason=execution_result.reason
                    ))
                
                return {
                    "type": "trade_rejected",
                    "agent": agent_name,
                    "symbol": symbol,
                    "reason": execution_result.reason,
                    "oracle_decision": trading_decision.action,
                    "oracle_type": "FAST" if use_fast_oracle else "FULL",
                    "source": "PORTFOLIO MANAGER RISK CONTROL"
                }
        else:
            # Log rejected trade (Oracle risk check) - but NOT HOLD decisions
            if trading_decision.action != "HOLD":
                activity_logger.log_trade(TradeLog(
                    timestamp=datetime.now().isoformat(),
                    agent_name=agent_name,
                    symbol=symbol,
                    action=trading_decision.action,
                    quantity=trading_decision.quantity,
                    price=0.0,
                    value=0.0,
                    oracle_confidence=trading_decision.confidence,
                    oracle_reasoning=trading_decision.reasoning,
                    success=False,
                    rejection_reason="Oracle risk assessment failed"
                ))
            
            return {
                "type": "trade_rejected",
                "agent": agent_name,
                "symbol": symbol,
                "reason": "Oracle risk assessment failed",
                "oracle_confidence": trading_decision.confidence,
                "oracle_type": "FAST" if use_fast_oracle else "FULL",
                "source": "ORACLE RISK MANAGEMENT"
            }
            
    except Exception as e:
        logger.error(f"Error in Oracle analysis: {e}")
        import traceback
        traceback.print_exc()
        return {
            "type": "oracle_error",
            "agent": agent_name,
            "symbol": symbol,
            "error": str(e)
        }


@router.get("/performance")
async def get_performance():
    """Get performance metrics vs S&P 500"""
    try:
        # Get SPY data for benchmark
        spy = yf.Ticker("SPY")
        spy_hist = spy.history(period="1d")
        
        if spy_hist.empty:
            return {
                'spy_price': 0,
                'spy_return': 0,
                'fund_return': 0,
                'alpha': 0,
                'beating_spy': False
            }
        
        spy_price = float(spy_hist["Close"].iloc[-1])
        spy_open = float(spy_hist["Open"].iloc[0])
        spy_daily_return = ((spy_price - spy_open) / spy_open) * 100
        
        # Calculate fund daily return
        initial_capital = 1100000.0
        current_value = portfolio_state["total_value"]
        fund_daily_return = ((current_value - initial_capital) / initial_capital) * 100
        
        alpha = fund_daily_return - spy_daily_return
        
        return {
            'spy_price': spy_price,
            'spy_return': spy_daily_return,
            'fund_return': fund_daily_return,
            'alpha': alpha,
            'beating_spy': alpha > 0
        }
        
    except Exception as e:
        logger.error(f"Error calculating performance: {e}")
        return {
            'spy_price': 0,
            'spy_return': 0,
            'fund_return': 0,
            'alpha': 0,
            'beating_spy': False
        }


@router.get("/performance/history")
async def get_performance_history():
    """Get historical performance data for charting"""
    return {
        "history": performance_history,
        "count": len(performance_history),
        "latest": performance_history[-1] if performance_history else None
    }


# ═══════════════════════════════════════════════════════════════════════
# ANALYTICS ENDPOINTS — LLM usage, per-cycle, per-agent, per-provider
# ═══════════════════════════════════════════════════════════════════════

@router.get("/analytics/cycles")
async def analytics_cycles(limit: int = 50):
    """All cycle summaries with LLM usage breakdown."""
    try:
        from src.analytics.db import get_analytics_db
        return {"cycles": get_analytics_db().get_all_cycle_summaries(limit=limit), "timestamp": datetime.now().isoformat()}
    except Exception as e:
        logger.error(f"analytics_cycles error: {e}")
        return {"cycles": [], "error": str(e)}


@router.get("/analytics/cycle/{cycle_num}")
async def analytics_cycle_detail(cycle_num: int):
    """Full breakdown for a single cycle (all phases + decisions)."""
    try:
        from src.analytics.db import get_analytics_db
        return get_analytics_db().get_cycle_summary(cycle_num)
    except Exception as e:
        logger.error(f"analytics_cycle_detail error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/analytics/agents")
async def analytics_agents():
    """Decision stats for every agent (BUY%/SELL%/HOLD%, avg confidence, LLM calls)."""
    try:
        from src.analytics.db import get_analytics_db
        return {"agents": get_analytics_db().get_agent_stats(),
                "timestamp": datetime.now().isoformat()}
    except Exception as e:
        logger.error(f"analytics_agents error: {e}")
        return {"agents": {}, "error": str(e)}


@router.get("/analytics/agent/{agent_name}")
async def analytics_agent_detail(agent_name: str, limit: int = 100):
    """Full decision history for one agent."""
    try:
        from src.analytics.db import get_analytics_db
        db = get_analytics_db()
        return {
            "agent": agent_name,
            "stats": db.get_agent_stats(agent_name).get(agent_name, {}),
            "history": db.get_agent_decision_history(agent_name, limit=limit),
            "timestamp": datetime.now().isoformat(),
        }
    except Exception as e:
        logger.error(f"analytics_agent_detail error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/analytics/llm-calls")
async def analytics_llm_calls(
    limit: int = 100,
    phase: str = None,
    agent: str = None,
    cycle: int = None,
):
    """Recent LLM calls with optional filtering by phase / agent / cycle."""
    try:
        from src.analytics.db import get_analytics_db
        return {
            "calls": get_analytics_db().get_recent_llm_calls(
                limit=limit, phase=phase, agent=agent, cycle=cycle
            ),
            "timestamp": datetime.now().isoformat(),
        }
    except Exception as e:
        logger.error(f"analytics_llm_calls error: {e}")
        return {"calls": [], "error": str(e)}


@router.get("/analytics/provider-breakdown")
async def analytics_provider_breakdown(cycle: int = None):
    """Aggregated LLM usage per provider (calls, tokens, avg latency, errors)."""
    try:
        from src.analytics.db import get_analytics_db
        return {
            "providers": get_analytics_db().get_provider_breakdown(cycle=cycle),
            "cycle": cycle,
            "timestamp": datetime.now().isoformat(),
        }
    except Exception as e:
        logger.error(f"analytics_provider_breakdown error: {e}")
        return {"providers": {}, "error": str(e)}


@router.get("/spy-benchmark")
async def get_spy_benchmark():
    """Get SPY benchmark data for comparison"""
    def _compute_spy_benchmark_sync() -> Dict[str, Any]:
        spy = yf.Ticker("SPY")
        spy_hist = spy.history(period="1d")

        if spy_hist.empty:
            return {
                'spy_price': 0,
                'alpha': 0,
                'beating_spy': False
            }

        spy_price = float(spy_hist["Close"].iloc[-1])

        initial_capital = 1100000.0
        current_value = portfolio_state["total_value"]
        fund_return = ((current_value - initial_capital) / initial_capital) * 100
        spy_return = 0
        alpha = fund_return - spy_return

        return {
            'spy_price': spy_price,
            'alpha': alpha,
            'beating_spy': alpha > 0
        }

    fallback = {
        'spy_price': 0,
        'alpha': 0,
        'beating_spy': False
    }
    result = await _run_portfolio_sync_call(
        _compute_spy_benchmark_sync,
        timeout_seconds=4.0,
        fallback=fallback,
        label="get_spy_benchmark",
    )
    if result is fallback:
        logger.error("Error getting SPY benchmark: falling back to zero snapshot")
    return result


def sanitize_float(value):
    """Convert problematic float values (inf, -inf, nan) to None"""
    import math
    if isinstance(value, float):
        if math.isinf(value) or math.isnan(value):
            return None
    return value

def sanitize_dict(obj):
    """Recursively sanitize dictionary values to handle infinity values"""
    if isinstance(obj, dict):
        return {key: sanitize_dict(value) for key, value in obj.items()}
    elif isinstance(obj, list):
        return [sanitize_dict(item) for item in obj]
    elif isinstance(obj, float):
        import math
        if math.isinf(obj) or math.isnan(obj):
            return None
        return obj
    else:
        return obj


async def calculate_spy_benchmark_since_entry(position_tracker: Dict) -> Dict:
    """
    Calculate SPY performance from each position's entry date.
    Returns per-position SPY benchmark data and aggregate fund vs SPY performance.
    """
    try:
        if not position_tracker:
            return {
                'by_position': {},
                'aggregate': {'fund_return': 0, 'spy_return': 0, 'alpha': 0}
            }
        
        spy = yf.Ticker("SPY")
        spy_benchmark_by_position = {}
        
        # Get the earliest entry date for aggregate calculation
        earliest_entry = None
        
        for symbol, tracker in position_tracker.items():
            entry_time = tracker.get('entry_time')
            entry_price = tracker.get('entry_price', 0)
            
            if not entry_time:
                continue
            
            # Parse entry_time - could be datetime object or ISO string
            try:
                if isinstance(entry_time, str):
                    entry_dt = datetime.fromisoformat(entry_time.replace('Z', '+00:00').replace('+00:00', ''))
                elif hasattr(entry_time, 'date'):
                    entry_dt = entry_time
                else:
                    continue
                
                entry_date = entry_dt.date()
            except Exception as parse_err:
                logger.warning(f"Failed to parse entry_time for {symbol}: {parse_err}")
                continue
                
            # Track earliest entry for aggregate
            if earliest_entry is None or entry_dt < earliest_entry:
                earliest_entry = entry_dt
            
            try:
                # Get SPY history from entry date to now
                end_date = datetime.now().date()
                
                # Use period='1d' if same day, otherwise use date range
                if entry_date >= end_date:
                    spy_hist = spy.history(period="1d")
                else:
                    spy_hist = spy.history(start=entry_date, end=end_date)
                
                if len(spy_hist) > 0:
                    # For same-day: use Open as entry, Close as current
                    # For multi-day: use first Close as entry, last Close as current
                    if entry_date >= end_date and len(spy_hist) == 1:
                        spy_entry_price = float(spy_hist["Open"].iloc[0])
                        spy_current_price = float(spy_hist["Close"].iloc[-1])
                    else:
                        spy_entry_price = float(spy_hist["Close"].iloc[0])
                        spy_current_price = float(spy_hist["Close"].iloc[-1])
                    spy_return_pct = ((spy_current_price - spy_entry_price) / spy_entry_price) * 100 if spy_entry_price > 0 else 0
                    
                    spy_benchmark_by_position[symbol] = {
                        'entry_time': entry_time.isoformat() if hasattr(entry_time, 'isoformat') else str(entry_time),
                        'spy_entry_price': round(spy_entry_price, 2),
                        'spy_current_price': round(spy_current_price, 2),
                        'spy_return_pct': round(spy_return_pct, 2)
                    }
            except Exception as e:
                logger.warning(f"Failed to get SPY benchmark for {symbol}: {e}")
                spy_benchmark_by_position[symbol] = {
                    'entry_time': entry_time.isoformat() if hasattr(entry_time, 'isoformat') else str(entry_time),
                    'spy_entry_price': 0,
                    'spy_current_price': 0,
                    'spy_return_pct': 0,
                    'error': str(e)
                }
        
        # Calculate aggregate fund vs SPY from earliest position
        aggregate = {'fund_return': 0, 'spy_return': 0, 'alpha': 0}
        if earliest_entry:
            try:
                entry_date = earliest_entry.date() if hasattr(earliest_entry, 'date') else earliest_entry
                end_date = datetime.now().date()
                
                if entry_date >= end_date:
                    spy_hist = spy.history(period="1d")
                else:
                    spy_hist = spy.history(start=entry_date, end=end_date)
                
                if len(spy_hist) > 0:
                    # For same-day: use Open as entry, Close as current
                    if entry_date >= end_date and len(spy_hist) == 1:
                        spy_entry = float(spy_hist["Open"].iloc[0])
                        spy_current = float(spy_hist["Close"].iloc[-1])
                    else:
                        spy_entry = float(spy_hist["Close"].iloc[0])
                        spy_current = float(spy_hist["Close"].iloc[-1])
                    spy_return = ((spy_current - spy_entry) / spy_entry) * 100 if spy_entry > 0 else 0
                    
                    # Fund return from initial capital
                    initial_capital = 1100000.0
                    current_value = portfolio_state.get("total_value", initial_capital)
                    fund_return = ((current_value - initial_capital) / initial_capital) * 100 if initial_capital > 0 else 0
                    
                    aggregate = {
                        'fund_return': round(fund_return, 2),
                        'spy_return': round(spy_return, 2),
                        'alpha': round(fund_return - spy_return, 2),
                        'beating_spy': fund_return > spy_return,
                        'entry_date': entry_date.isoformat() if hasattr(entry_date, 'isoformat') else str(entry_date)
                    }
            except Exception as e:
                logger.error(f"Failed to calculate aggregate SPY benchmark: {e}")
        
        return {
            'by_position': spy_benchmark_by_position,
            'aggregate': aggregate
        }
        
    except Exception as e:
        logger.error(f"Error calculating SPY benchmark: {e}")
        return {
            'by_position': {},
            'aggregate': {'fund_return': 0, 'spy_return': 0, 'alpha': 0},
            'error': str(e)
        }


# [DELETED DUPLICATE /portfolio - RECENTRALIZED AT BOTTOM OF FILE]
        portfolio_value = portfolio_state["cash"]
        position_values = {}
        failed_symbols = []
        
        for symbol, quantity in portfolio_state["positions"].items():
            try:
                ticker = yf.Ticker(symbol)
                hist = ticker.history(period="1d")
                if not hist.empty:
                    current_price = float(hist["Close"].iloc[-1])
                    position_value = quantity * current_price
                    portfolio_value += position_value
                    position_values[symbol] = {
                        "quantity": quantity,
                        "price": current_price,
                        "value": position_value
                    }
                else:
                    # No price data - try to use last known price from market_view
                    if symbol in market_view.prices:
                        current_price = market_view.prices[symbol].get("current_price", 0)
                        if current_price > 0:
                            position_value = quantity * current_price
                            portfolio_value += position_value
                            position_values[symbol] = {
                                "quantity": quantity,
                                "price": current_price,
                                "value": position_value,
                                "note": "Using cached price"
                            }
                        else:
                            failed_symbols.append(symbol)
                    else:
                        failed_symbols.append(symbol)
            except Exception as e:
                logger.warning(f"Failed to get price for {symbol}: {e}")
                # Try to use cached price from market_view
                if symbol in market_view.prices:
                    current_price = market_view.prices[symbol].get("current_price", 0)
                    if current_price > 0:
                        position_value = quantity * current_price
                        portfolio_value += position_value
                        position_values[symbol] = {
                            "quantity": quantity,
                            "price": current_price,
                            "value": position_value,
                            "note": "Using cached price (API failed)"
                        }
                    else:
                        failed_symbols.append(symbol)
                else:
                    failed_symbols.append(symbol)
        
        if failed_symbols:
            logger.error(f"⚠️  Could not get prices for: {', '.join(failed_symbols)}")
        
        # Update portfolio state with current values
        portfolio_value = sanitize_float(portfolio_value)
        portfolio_state["total_value"] = portfolio_value
        
        # Recalculate daily P&L based on current market prices
        # daily_start_value is set at the beginning of each trading day
        daily_pnl = portfolio_value - portfolio_manager.daily_start_value
        daily_pnl = sanitize_float(daily_pnl)
        portfolio_state["daily_pnl"] = daily_pnl
        
        # Calculate performance vs starting capital
        initial_capital = 1100000.0
        total_return = ((portfolio_value - initial_capital) / initial_capital) * 100 if initial_capital != 0 else 0
        total_return = sanitize_float(total_return)
        
        # Calculate SPY benchmark from entry dates
        position_tracker = getattr(portfolio_manager, 'position_tracker', {})
        spy_benchmark = await calculate_spy_benchmark_since_entry(position_tracker)
        
        result = {
            "portfolio": portfolio_state,
            "position_details": position_values,
            "position_tracker": position_tracker,
            "trade_history": getattr(portfolio_manager, 'trade_history', [])[-50:],
            "total_return": total_return,
            "spy_benchmark": spy_benchmark,
            "timestamp": datetime.now().isoformat(),
            "source": "REAL MARKET PRICES"
        }
        
        # Sanitize the entire result to handle any infinity values
        result = sanitize_dict(result)
        
        # Update cache
        _portfolio_cache = result
        _portfolio_cache_time = now
        
        return result
    except Exception as e:
        logger.error(f"Error calculating real portfolio value: {e}")
        return {
            "portfolio": portfolio_state,
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }


@router.get("/market-data/{symbol}")
async def get_real_market_data(symbol: str):
    """Get REAL market data for a symbol"""
    symbol = symbol.upper()
    
    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period="5d")
        info = ticker.info
        
        if hist.empty:
            raise HTTPException(status_code=404, detail=f"No data found for {symbol}")
        
        current_price = float(hist["Close"].iloc[-1])
        prev_close = float(hist["Close"].iloc[-2]) if len(hist) > 1 else current_price
        change = current_price - prev_close
        change_pct = (change / prev_close) * 100 if prev_close != 0 else 0
        
        return {
            "symbol": symbol,
            "current_price": current_price,
            "change": change,
            "change_pct": change_pct,
            "volume": int(hist["Volume"].iloc[-1]),
            "high_52w": float(hist["High"].max()),
            "low_52w": float(hist["Low"].min()),
            "market_cap": info.get("marketCap", 0),
            "pe_ratio": info.get("trailingPE", 0),
            "timestamp": datetime.now().isoformat(),
            "source": "Yahoo Finance REAL DATA"
        }
        
    except Exception as e:
        logger.error(f"Error fetching real market data for {symbol}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch real data: {str(e)}")


@router.get("/oracle/performance")
async def get_oracle_performance():
    """Get Oracle and agent performance metrics"""
    try:
        portfolio_analytics = portfolio_manager.get_portfolio_analytics(portfolio_state)
        spy_performance = await portfolio_manager.calculate_spy_performance()
        
        return {
            "oracle_stats": {
                "total_decisions": 0,
                "recent_decisions": [],
                "market_events": [],
                "note": "Oracle metrics now tracked via API service"
            },
            "agent_performance": {},
            "portfolio_analytics": portfolio_analytics,
            "spy_benchmark": spy_performance,
            "timestamp": datetime.now().isoformat(),
            "source": "ORACLE INTELLIGENCE SYSTEM (via API)"
        }
    except Exception as e:
        logger.error(f"Error getting Oracle performance: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/agents/{agent_name}/marketview")
async def get_agent_marketview(agent_name: str):
    """Get agent's accumulated MarketView intelligence"""
    if agent_name not in agent_market_views:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    market_view = agent_market_views[agent_name]
    
    return {
        "agent": agent_name,
        "market_view": {
            "prices": market_view.prices,
            "sentiment": market_view.sentiment,
            "fundamentals": market_view.fundamentals,
            "data_freshness": {k: v.isoformat() for k, v in market_view.staleness.items()},
            "can_trade_symbols": {
                symbol: market_view.can_trade(
                    agent_states[agent_name].get("personality", "neutral"), 
                    symbol
                ) for symbol in ["AAPL", "MSFT", "GOOGL", "SPY"]
            }
        },
        "timestamp": datetime.now().isoformat()
    }


@router.post("/oracle/trigger-analysis/{symbol}")
async def trigger_oracle_analysis(symbol: str):
    """Manually trigger Oracle analysis for a symbol"""
    try:
        # Use quick oracle via API
        decision_result = await quick_oracle_decision(
            ticker=symbol.upper(),
            current_price=0,  # Will be fetched by API
            agent_personality="oracle"
        )
        
        trading_decision = TradingDecision(
            symbol=decision_result.symbol,
            action=decision_result.action,
            quantity=decision_result.quantity,
            confidence=decision_result.confidence,
            reasoning=decision_result.reasoning,
            risk_score=decision_result.risk_score,
            expected_return=decision_result.expected_return,
            time_horizon=decision_result.time_horizon,
            agent_consensus={"Oracle": decision_result.action}
        )
        
        return {
            "symbol": symbol.upper(),
            "oracle_decision": {
                "action": trading_decision.action,
                "quantity": trading_decision.quantity,
                "confidence": trading_decision.confidence,
                "reasoning": trading_decision.reasoning,
                "risk_score": trading_decision.risk_score,
                "expected_return": trading_decision.expected_return,
                "agent_consensus": trading_decision.agent_consensus
            },
            "would_execute": (
                trading_decision.confidence >= 0.55 and
                trading_decision.risk_score <= 0.8 and
                trading_decision.action in ("BUY", "SELL")
            ),
            "timestamp": datetime.now().isoformat(),
            "source": "MANUAL ORACLE TRIGGER (via API)"
        }
    except Exception as e:
        logger.error(f"Error in manual Oracle analysis: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/market-events/{event_type}")
async def inject_market_event(event_type: str, description: str = ""):
    """Inject market events that affect all agents"""
    try:
        # Market events now broadcast only (oracle_engine removed)
        
        # Broadcast to all connected clients
        await manager.broadcast({
            "type": "market_event",
            "event_type": event_type,
            "description": description,
            "timestamp": datetime.now().isoformat(),
            "message": f"🚨 MARKET EVENT: {event_type.upper()} - All agents react!"
        })
        
        return {
            "success": True,
            "event_type": event_type,
            "description": description,
            "message": "Market event injected - agents will react"
        }
    except Exception as e:
        logger.error(f"Error injecting market event: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/debug/marketview/{agent_name}")
async def debug_agent_marketview(agent_name: str):
    """Debug endpoint to inspect agent's MarketView in detail"""
    if agent_name not in agent_market_views:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    market_view = agent_market_views[agent_name]
    agent_personality = agent_states[agent_name].get("personality", "neutral")
    
    # Check can_trade for all major symbols
    symbols = ALL_TICKERS[:10]  # Check first 10 tickers
    trade_status = {}
    
    for symbol in symbols:
        can_trade = market_view.can_trade(agent_personality, symbol)
        trade_status[symbol] = {
            "can_trade": can_trade,
            "has_prices": symbol in market_view.prices,
            "has_fundamentals": symbol in market_view.fundamentals,
            "has_sentiment": symbol in market_view.sentiment,
            "price_fresh": market_view.is_fresh("prices", symbol, 180) if symbol in market_view.prices else False,
            "fundamental_fresh": market_view.is_fresh("fundamentals", symbol, 600) if symbol in market_view.fundamentals else False,
            "sentiment_fresh": market_view.is_fresh("sentiment", symbol, 180) if symbol in market_view.sentiment else False
        }
    
    return {
        "agent": agent_name,
        "personality": agent_personality,
        "market_view": {
            "prices": {k: {**v, "timestamp": v.get("timestamp").isoformat() if v.get("timestamp") else None} 
                      for k, v in market_view.prices.items()},
            "fundamentals": {k: {**v, "timestamp": v.get("timestamp").isoformat() if v.get("timestamp") else None} 
                           for k, v in market_view.fundamentals.items()},
            "sentiment": {k: {**v, "timestamp": v.get("timestamp").isoformat() if v.get("timestamp") else None} 
                        for k, v in market_view.sentiment.items()},
            "staleness": {k: v.isoformat() for k, v in market_view.staleness.items()}
        },
        "trade_status": trade_status,
        "timestamp": datetime.now().isoformat()
    }


# ============================================================================
# SCOUT AGENT - MARKET SCANNING & TICKER DISCOVERY
# ============================================================================

async def scout_scan_market(agent_name: str = "Scout"):
    """Scout scans market for new opportunities"""
    try:
        logger.info(f"🔍 {agent_name} scanning market for opportunities...")
        
        # Run market scan
        scan_result = await scout_client.scan_market(max_scan=50)
        opportunities = scan_result.opportunities if hasattr(scan_result, 'opportunities') else []
        
        # Check if any opportunities should be proposed
        proposals = []
        for opp in opportunities:
            if scout_screener.should_propose_ticker(opp, ALL_TICKERS):
                proposal = await scout_screener.create_proposal(opp)
                proposals.append(proposal)
                logger.info(f"💡 Scout proposes {opp['symbol']} (score: {opp['score']})")
        
        # Log Scout activity
        activity_logger.log_agent_activity(AgentActivityLog(
            timestamp=datetime.now().isoformat(),
            agent_name=agent_name,
            activity_type="SCANNER",
            data_received={"opportunities_found": len(opportunities), "proposals": len(proposals)},
            result="success",
            fatigue_level=agent_states.get(agent_name, {}).get("fatigue", 0)
        ))
        
        return {
            "type": "market_scan",
            "opportunities": opportunities,
            "proposals": proposals,
            "stats": scout_screener.get_proposal_stats(),
            "source": "Scout Market Scanner"
        }
        
    except Exception as e:
        logger.error(f"Error in Scout market scan: {e}")
        import traceback
        traceback.print_exc()
        return {
            "type": "market_scan",
            "error": str(e)
        }


@router.get("/scout/opportunities")
async def get_scout_opportunities():
    """Get Scout's latest market opportunities"""
    try:
        scan_result = await scout_screener.scan_market(max_scan=30)
        opportunities = scan_result.opportunities if hasattr(scan_result, 'opportunities') else []
        return {
            "opportunities": opportunities,
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/scout/stats")
async def get_scout_stats():
    """Get Scout's performance statistics"""
    try:
        stats = scout_screener.get_proposal_stats()
        universe = await scout_screener.get_universe()
        return {
            "stats": stats,
            "current_universe_size": len(ALL_TICKERS),
            "scan_universe_size": len(universe),
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/scout/propose-ticker")
async def scout_propose_ticker(symbol: str):
    """Manually trigger Scout to propose a specific ticker"""
    try:
        # Score the ticker
        opportunity = await scout_screener.score_opportunity(symbol.upper())
        
        if not opportunity:
            raise HTTPException(status_code=404, detail=f"Could not score {symbol}")
        
        # Check if should propose
        if scout_screener.should_propose_ticker(opportunity, ALL_TICKERS):
            proposal = await scout_screener.create_proposal(opportunity)
            
            # Broadcast proposal
            await manager.broadcast({
                "type": "ticker_proposal",
                "proposal": proposal,
                "timestamp": datetime.now().isoformat()
            })
            
            return {
                "success": True,
                "proposal": proposal,
                "message": f"Scout proposes adding {symbol} to universe"
            }
        else:
            return {
                "success": False,
                "opportunity": opportunity,
                "message": f"{symbol} does not meet proposal criteria (score: {opportunity['score']})"
            }
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/scout/add-ticker/{symbol}")
async def add_ticker_to_universe(symbol: str):
    """Add a ticker to the trading universe (after approval)"""
    try:
        symbol = symbol.upper()
        
        if symbol in ALL_TICKERS:
            return {
                "success": False,
                "message": f"{symbol} already in universe"
            }
        
        # Add to universe
        ALL_TICKERS.append(symbol)
        
        # Determine sector (simplified)
        ticker = yf.Ticker(symbol)
        info = ticker.info
        sector = info.get('sector', 'Unknown')
        
        # Add to appropriate sector in TRADING_UNIVERSE
        if sector in TRADING_UNIVERSE:
            TRADING_UNIVERSE[sector].append(symbol)
        else:
            # Add to misc category
            if 'misc' not in TRADING_UNIVERSE:
                TRADING_UNIVERSE['misc'] = []
            TRADING_UNIVERSE['misc'].append(symbol)
        
        # Broadcast update
        await manager.broadcast({
            "type": "universe_updated",
            "symbol": symbol,
            "sector": sector,
            "total_tickers": len(ALL_TICKERS),
            "timestamp": datetime.now().isoformat()
        })
        
        logger.info(f"✅ Added {symbol} to trading universe (total: {len(ALL_TICKERS)})")
        
        return {
            "success": True,
            "symbol": symbol,
            "sector": sector,
            "total_tickers": len(ALL_TICKERS),
            "message": f"{symbol} added to universe"
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# COLLABORATION ENDPOINTS
# ============================================================================

@router.post("/collaborate/initiate")
async def initiate_collaboration(agent1: str, agent2: str, topic: str):
    """Initiate a collaboration session between two agents"""
    try:
        # Agent trust scores now default to 0.5 (API-based tracking TBD)
        trust1 = 0.5
        trust2 = 0.5
        
        # Start collaboration
        session = collaboration_engine.initiate_collaboration(
            agent1, agent2, topic, trust1, trust2
        )
        
        # Broadcast to frontend
        await manager.broadcast({
            "type": "collaboration_started",
            "session_id": session.session_id,
            "participants": session.participants,
            "topic": session.topic,
            "timestamp": datetime.now().isoformat()
        })
        
        return {
            "success": True,
            "session": {
                "session_id": session.session_id,
                "participants": session.participants,
                "topic": session.topic,
                "status": session.status
            }
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/collaborate/vote")
async def submit_vote(session_id: str, agent_name: str, stance: str, 
                     confidence: float, reasoning: str):
    """Agent submits vote in collaboration"""
    try:
        # Agent trust score defaults to 0.5 (API-based tracking TBD)
        trust_score = 0.5
        
        # Submit vote
        success = collaboration_engine.submit_vote(
            session_id, agent_name, stance, confidence, reasoning, trust_score
        )
        
        if not success:
            raise HTTPException(status_code=404, detail="Session not found or agent not participant")
        
        # Get updated session
        session = collaboration_engine.active_sessions.get(session_id)
        
        if session and session.status == "complete":
            # Broadcast consensus
            await manager.broadcast({
                "type": "collaboration_complete",
                "session_id": session_id,
                "consensus": session.consensus,
                "confidence": session.confidence,
                "timestamp": datetime.now().isoformat()
            })
        
        return {
            "success": True,
            "vote_recorded": True,
            "session_status": session.status if session else "unknown"
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/collaborate/active")
async def get_active_collaborations():
    """Get all active collaboration sessions"""
    try:
        sessions = collaboration_engine.get_active_sessions()
        
        return {
            "active_sessions": [
                {
                    "session_id": s.session_id,
                    "participants": s.participants,
                    "topic": s.topic,
                    "status": s.status,
                    "votes": s.votes,
                    "consensus": s.consensus
                }
                for s in sessions
            ],
            "count": len(sessions)
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/collaborate/stats")
async def get_collaboration_stats():
    """Get collaboration statistics"""
    try:
        stats = collaboration_engine.get_collaboration_stats()
        return {
            "stats": stats,
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/collaborate/dialogue/{agent_name}")
async def get_agent_dialogue(agent_name: str, stance: str, topic: str):
    """Generate dialogue for an agent"""
    try:
        # Get agent personality
        personality = agent_states.get(agent_name, {}).get("personality", "value")
        
        # Generate dialogue
        dialogue = collaboration_engine.generate_dialogue(
            agent_name, personality, stance, topic
        )
        
        return {
            "agent": agent_name,
            "dialogue": dialogue,
            "stance": stance,
            "topic": topic
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# LOGGING ENDPOINTS
# ============================================================================

@router.get("/logs/trades")
async def get_trade_logs(limit: int = 50, agent_name: Optional[str] = None):
    """Get trade history logs"""
    return {
        "trades": activity_logger.get_trade_history(limit=limit, agent_name=agent_name),
        "total_trades": activity_logger.stats['total_trades'],
        "successful_trades": activity_logger.stats['successful_trades'],
        "rejected_trades": activity_logger.stats['rejected_trades'],
        "timestamp": datetime.now().isoformat()
    }

@router.get("/logs/agent/{agent_name}")
async def get_agent_logs(agent_name: str, limit: int = 50):
    """Get activity logs for specific agent"""
    if agent_name not in agent_states:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    return {
        "agent": agent_name,
        "activities": activity_logger.get_agent_activity(agent_name, limit=limit),
        "total_actions": activity_logger.stats['agent_actions'].get(agent_name, 0),
        "timestamp": datetime.now().isoformat()
    }

@router.get("/logs/activities")
async def get_all_activities(limit: int = 100):
    """Get recent activities for all agents"""
    return {
        "activities": activity_logger.get_all_agent_activities(limit=limit),
        "agent_action_counts": activity_logger.stats['agent_actions'],
        "timestamp": datetime.now().isoformat()
    }

@router.get("/logs/data-fetches")
async def get_data_fetch_logs(limit: int = 50, agent_name: Optional[str] = None):
    """Get market data fetch logs"""
    return {
        "data_fetches": activity_logger.get_data_fetch_history(limit=limit, agent_name=agent_name),
        "total_fetches": activity_logger.stats['total_data_fetches'],
        "failed_fetches": activity_logger.stats['failed_data_fetches'],
        "success_rate": activity_logger.get_statistics()['data_fetch_success_rate'],
        "timestamp": datetime.now().isoformat()
    }

@router.get("/logs/system")
async def get_system_logs(limit: int = 50):
    """Get system event logs"""
    return {
        "events": activity_logger.get_system_events(limit=limit),
        "timestamp": datetime.now().isoformat()
    }

@router.get("/logs/statistics")
async def get_log_statistics():
    """Get overall logging statistics"""
    return {
        "statistics": activity_logger.get_statistics(),
        "timestamp": datetime.now().isoformat()
    }

@router.post("/logs/export")
async def export_logs():
    """Export all logs to JSON file"""
    try:
        filepath = f"logs/trading_floor_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        activity_logger.export_logs(filepath)
        return {
            "success": True,
            "filepath": filepath,
            "message": "Logs exported successfully"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


# ============================================================================
# STATE MANAGEMENT ENDPOINTS
# ============================================================================

@router.get("/state")
async def get_current_state():
    """Get current trading floor state"""
    return {
        "agent_states": agent_states,
        "portfolio_state": portfolio_state,
        "timestamp": datetime.now().isoformat()
    }

@router.post("/state/save")
async def save_state():
    """Manually save current state"""
    try:
        state_data = {
            'portfolio': portfolio_state,
            'agent_states': agent_states,
            'position_tracker': portfolio_manager.position_tracker,
            'trade_history': portfolio_manager.trade_history,
            'statistics': activity_logger.get_statistics()
        }
        
        success = state_manager.save_state(state_data)
        
        if success:
            return {
                "success": True,
                "message": "State saved successfully",
                "timestamp": datetime.now().isoformat()
            }
        else:
            raise HTTPException(status_code=500, detail="Failed to save state")
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Save failed: {str(e)}")

@router.get("/state/load")
async def load_state():
    """Load saved state"""
    try:
        state_data = state_manager.load_state()
        
        if state_data:
            # Restore portfolio state
            global portfolio_state
            portfolio_state.update(state_data.get('portfolio', {}))
            
            # Restore agent states
            global agent_states
            for agent_name, state in state_data.get('agent_states', {}).items():
                if agent_name in agent_states:
                    agent_states[agent_name].update(state)
            
            # Restore position tracker and trade history
            if 'position_tracker' in state_data:
                portfolio_manager.position_tracker = state_data['position_tracker']
            if 'trade_history' in state_data:
                portfolio_manager.trade_history = state_data['trade_history']
            
            return {
                "success": True,
                "message": "State loaded successfully",
                "loaded_from": state_data.get('saved_at', 'unknown'),
                "portfolio_value": portfolio_state['total_value']
            }
        else:
            return {
                "success": False,
                "message": "No saved state found"
            }
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Load failed: {str(e)}")

@router.get("/state/backups")
async def get_backups():
    """Get list of available state backups"""
    try:
        backups = state_manager.get_backup_list()
        return {
            "backups": backups,
            "count": len(backups),
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get backups: {str(e)}")

@router.post("/state/restore/{backup_filename}")
async def restore_backup(backup_filename: str):
    """Restore state from a specific backup"""
    try:
        success = state_manager.restore_from_backup(backup_filename)
        
        if success:
            # Reload the restored state
            await load_state()
            
            return {
                "success": True,
                "message": f"State restored from {backup_filename}",
                "timestamp": datetime.now().isoformat()
            }
        else:
            raise HTTPException(status_code=404, detail="Backup not found")
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Restore failed: {str(e)}")

@router.get("/state/status")
async def get_state_status():
    """Get state management status"""
    try:
        backups = state_manager.get_backup_list()
        latest_backup = backups[0] if backups else None
        
        return {
            "auto_save_enabled": True,
            "auto_save_interval": "5 minutes",
            "total_backups": len(backups),
            "latest_backup": latest_backup,
            "state_directory": state_manager.state_dir,
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get status: {str(e)}")


# ============================================================================
# FLOW MONITORING ENDPOINTS
# ============================================================================

@router.get("/agents/flow/{agent_name}")
async def get_agent_flow(agent_name: str):
    """Get detailed flow state for a specific agent"""
    if agent_name not in agent_states:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    agent_state = agent_states[agent_name]
    
    # Get recent activities for this agent
    recent_activities = activity_logger.get_agent_activities(agent_name, limit=10)
    
    # Get recent trades for this agent
    recent_trades = [
        log for log in activity_logger.get_trade_logs(limit=50)
        if log.get('agent_name') == agent_name
    ][:5]
    
    # Get last decision if available
    last_decision = None
    if agent_name in agent_market_views:
        market_view = agent_market_views[agent_name]
        # Try to get last decision from recent activities
        for activity in recent_activities:
            if activity.get('activity_type') == 'DESK':
                last_decision = activity.get('data_received', {})
                break
    
    return {
        "agent_name": agent_name,
        "current_state": agent_state,
        "recent_activities": recent_activities,
        "recent_trades": recent_trades,
        "last_decision": last_decision,
        "market_view_summary": {
            "prices_tracked": len(agent_market_views.get(agent_name, MarketView()).prices) if agent_name in agent_market_views else 0,
            "fundamentals_tracked": len(agent_market_views.get(agent_name, MarketView()).fundamentals) if agent_name in agent_market_views else 0
        }
    }

@router.get("/flow/summary")
async def get_flow_summary():
    """Get summary of all agents' flow states"""
    summary = {
        "timestamp": datetime.now().isoformat(),
        "agents": {},
        "fund_stats": {
            "portfolio_value": portfolio_state["total_value"],
            "cash": portfolio_state["cash"],
            "positions_count": len(portfolio_state["positions"]),
            "daily_pnl": portfolio_state.get("daily_pnl", 0)
        }
    }
    
    for agent_name, state in agent_states.items():
        # Determine current flow step based on status and last action
        current_step = "idle"
        if state["status"] == "active":
            action = state.get("last_action", "")
            if action in ["TICKER", "TV", "NEWS", "SCANNER"]:
                current_step = "fetch_data"
            elif action == "DESK":
                current_step = "oracle_decide"
            elif action == "COOLER":
                current_step = "at_station"
            elif action == "WALK":
                current_step = "moving"
        
        summary["agents"][agent_name] = {
            "status": state["status"],
            "last_action": state.get("last_action", "idle"),
            "fatigue": state.get("fatigue", 0),
            "current_step": current_step,
            "iteration": state.get("iteration", 0)
        }
    
    return summary


@router.get("/flow/state")
async def get_flow_state():
    """Get current pipeline state for MetroFlow UI polling."""
    try:
        snapshot = get_ui_agent_states_snapshot()
    except Exception as exc:
        logger.warning("flow/state snapshot error: %s", exc)
        snapshot = {}
    try:
        return {
            "phase": pipeline_state.get("phase", "IDLE"),
            "ticker": pipeline_state.get("ticker", "---"),
            "trade_date": pipeline_state.get("trade_date"),
            "llm_provider": pipeline_state.get("llm_provider"),
            "quick_model": pipeline_state.get("quick_model"),
            "deep_model": pipeline_state.get("deep_model"),
            "cycle": pipeline_state.get("cycle", 0),
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
            "llm_calls": pipeline_state.get("llm_calls", 0),
            "tool_calls": pipeline_state.get("tool_calls", 0),
            "tokens_in": pipeline_state.get("tokens_in", 0),
            "tokens_out": pipeline_state.get("tokens_out", 0),
            "attempt": pipeline_state.get("attempt", 1),
            "max_attempts": pipeline_state.get("max_attempts", 1),
            "timestamp": pipeline_state.get("timestamp"),
            "agent_states": snapshot,
        }
    except Exception as exc:
        logger.warning("flow/state fallback error: %s", exc)
        return {
            "phase": "IDLE",
            "ticker": "---",
            "trade_date": None,
            "llm_provider": None,
            "quick_model": None,
            "deep_model": None,
            "cycle": 0,
            "regime": None,
            "premortem_data": None,
            "war_room_brief": None,
            "phase_num": 0,
            "pipeline_mode": None,
            "run_id": None,
            "active_run_id": None,
            "current_step": None,
            "agent_display_name": None,
            "research_depth": None,
            "llm_calls": 0,
            "tool_calls": 0,
            "tokens_in": 0,
            "tokens_out": 0,
            "attempt": 1,
            "max_attempts": 1,
            "timestamp": datetime.now().isoformat(),
            "agent_states": snapshot,
        }


# ============================================================================
# MANUAL ANALYSIS ENDPOINT
# ============================================================================

# Track running manual analyses
_manual_analyses: Dict[str, dict] = {}


@router.post("/manual/analyze/{ticker}")
async def manual_analyze(ticker: str):
    """Run the full AI pipeline on a user-specified ticker (manual mode).

    Uses the manual pipeline under src.manual to compute regime, market data,
    agent opinions, oracle decision, and quant-anchored predictions without
    executing any trades.
    """
    ticker = ticker.upper().strip()
    if not ticker or len(ticker) > 10:
        raise HTTPException(status_code=400, detail="Invalid ticker")

    analysis_id = f"{ticker}_{datetime.now().strftime('%H%M%S')}"

    from src.manual.pipeline import run_manual_analysis

    try:
        result = await run_manual_analysis(
            ticker=ticker,
            analysis_id=analysis_id,
            broadcast=manager.broadcast,
            status_store=_manual_analyses,
        )
        return _sanitize_floats(result)
    except HTTPException:
        # Pass through HTTP errors from the pipeline
        raise
    except Exception as e:
        logger.error(f"Manual analysis error for {ticker}: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


@router.get("/manual/status/{analysis_id}")
async def manual_analysis_status(analysis_id: str):
    """Check status of a running manual analysis."""
    if analysis_id not in _manual_analyses:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return _manual_analyses[analysis_id]


@router.get("/manual/recent")
async def manual_recent():
    """Get recent manual analyses."""
    return {
        "analyses": list(_manual_analyses.values()),
        "total": len(_manual_analyses),
    }


@router.get("/prediction-accuracy")
async def prediction_accuracy():
    """Get prediction accuracy report across all recorded predictions."""
    try:
        from src.runtime.prediction import check_actuals, get_accuracy_report
        # First check for any newly matured predictions
        await check_actuals()
        # Then return the full report
        return await get_accuracy_report()
    except Exception as e:
        logger.error(f"Prediction accuracy error: {e}")
        return {"error": str(e), "total_predictions": 0}


# ============================================================================
# LLM CONTROL CENTER API
# ============================================================================

@router.get("/llm/config")
async def llm_get_config():
    """Get full LLM config (phase_config + agent_config + provider_overrides)."""
    from src.llm.llm_config import load_config
    return load_config()


@router.put("/llm/config")
async def llm_update_config(request: Request):
    """Update full LLM config."""
    from src.llm.llm_config import load_config, save_config
    body = await request.json()
    config = load_config()
    if "phase_config" in body:
        config["phase_config"].update(body["phase_config"])
    if "agent_config" in body:
        config["agent_config"].update(body["agent_config"])
    if "provider_overrides" in body:
        config["provider_overrides"].update(body["provider_overrides"])
    save_config(config)
    return config


@router.get("/llm/phases")
async def llm_get_phases():
    """Get all phase configs with usage stats from analytics DB."""
    from src.llm.llm_config import load_config
    config = load_config()
    phases = config["phase_config"]

    # Merge analytics stats
    try:
        from src.analytics.db import get_analytics_db
        db = get_analytics_db()
        for phase_name in phases:
            rows = db.get_recent_llm_calls(limit=100, phase=phase_name)
            total = len(rows)
            errors = sum(1 for r in rows if not r.get("success", True))
            avg_ms = sum(r.get("response_time_ms", 0) for r in rows) / max(total, 1)
            phases[phase_name]["stats"] = {
                "total_calls": total,
                "errors": errors,
                "avg_response_time": round(avg_ms, 1),
            }
    except Exception:
        pass

    return {"phases": phases}


@router.put("/llm/phase/{phase_name}")
async def llm_update_phase(phase_name: str, request: Request):
    """Update one phase config."""
    from src.llm.llm_config import set_phase_config
    from dataclasses import asdict
    body = await request.json()
    result = set_phase_config(phase_name, body)
    return {"phase": phase_name, "config": asdict(result)}


@router.get("/llm/agents")
async def llm_get_agents():
    """Get all agent configs with usage stats."""
    from src.llm.llm_config import load_config
    config = load_config()
    agents = config["agent_config"]

    try:
        from src.analytics.db import get_analytics_db
        db = get_analytics_db()
        for agent_name in agents:
            stats = db.get_agent_stats(agent_name)
            if stats:
                agents[agent_name]["stats"] = stats
    except Exception:
        pass

    return {"agents": agents}


@router.put("/llm/agent/{agent_name}")
async def llm_update_agent(agent_name: str, request: Request):
    """Update one agent config."""
    from src.llm.llm_config import set_agent_config
    from dataclasses import asdict
    body = await request.json()
    result = set_agent_config(agent_name, body)
    return {"agent": agent_name, "config": asdict(result)}


# ============================================================================
# AGENT PERSONALITY MANAGEMENT
# ============================================================================

@router.get("/agents/personalities")
async def get_agent_personalities():
    """Get the canonical TradingAgents roster with personality + canvas state."""
    personalities, behavior_defaults = _build_tradingagents_agent_profiles()
    return {"agents": personalities, "behavior_defaults": behavior_defaults}


@router.put("/agents/{agent_name}/personality")
async def update_agent_personality(agent_name: str, request: Request):
    """Update a canonical TradingAgents personality and/or active status."""
    from src.llm.llm_config import load_config, save_config
    body = await request.json()

    canonical_id = _normalize_tradingagents_roster_key(agent_name)
    if not canonical_id:
        raise HTTPException(status_code=400, detail="Only canonical TradingAgents agents can be updated.")

    config = load_config()
    agent_config = _purge_roster_aliases(config.get("agent_config", {}), canonical_id)
    agent_config[canonical_id] = {
        **_get_canonical_agent_defaults(canonical_id),
        **agent_config.get(canonical_id, {}),
    }

    if "personality" in body:
        agent_config[canonical_id]["personality"] = body["personality"]
    if "active" in body:
        agent_config[canonical_id]["active"] = body["active"]
    if "provider" in body:
        agent_config[canonical_id]["provider"] = body["provider"]
    if "model" in body:
        agent_config[canonical_id]["model"] = body["model"]
    if "default_animation" in body:
        agent_config[canonical_id]["default_animation"] = _clean_tradingagents_animation(
            body["default_animation"],
            _get_canonical_agent_defaults(canonical_id)["default_animation"],
        )
    if "default_station" in body:
        agent_config[canonical_id]["default_station"] = _clean_tradingagents_station(
            body["default_station"],
            _get_canonical_agent_defaults(canonical_id)["default_station"],
        )
    if "default_path" in body:
        agent_config[canonical_id]["default_path"] = _clean_tradingagents_path(
            body["default_path"],
            _get_canonical_agent_defaults(canonical_id)["default_path"],
        )

    config["agent_config"] = agent_config
    save_config(config)

    canvas_config = load_canvas_config()
    canvas_config = _purge_roster_aliases(canvas_config, canonical_id)
    canonical_agent = TRADINGAGENTS_AGENT_BY_ID[canonical_id]
    canvas_entry = canvas_config.get(canonical_id, {
        "displayName": canonical_agent["display_name"],
        "position": canonical_agent["position"],
        "color": canonical_agent["color"],
        "active": True,
    })
    if "active" in body:
        canvas_entry["active"] = body["active"]
    canvas_entry["displayName"] = canonical_agent["display_name"]
    canvas_config[canonical_id] = canvas_entry
    save_canvas_config(canvas_config)

    from src.llm.scene_generator import load_agent_personalities
    import src.llm.scene_generator as sg
    sg.AGENT_PERSONALITIES = load_agent_personalities()
    sg.AVAILABLE_AGENTS = list(sg.AGENT_PERSONALITIES.keys())

    _, behavior_defaults = _build_tradingagents_agent_profiles()
    pipeline_state["agent_behavior_defaults"] = behavior_defaults

    payload = {
        "type": "agent_behavior_defaults_updated",
        "agent": canonical_id,
        "config": behavior_defaults.get(canonical_id, {}),
        "agent_behavior_defaults": behavior_defaults,
        "timestamp": datetime.now().isoformat(),
    }
    await manager.broadcast(payload)
    try:
        from src.runtime.redis_client import publish_event
        await publish_event("trading_floor_events", "agent_behavior_defaults_updated", payload)
    except Exception:
        pass

    return {
        "success": True,
        "agent": canonical_id,
        "display_name": canonical_agent["display_name"],
        "config": {
            **agent_config[canonical_id],
            **behavior_defaults.get(canonical_id, {}),
        },
        "agent_behavior_defaults": behavior_defaults,
    }


@router.post("/agents/add")
async def add_new_agent(request: Request):
    raise HTTPException(status_code=400, detail="The TradingAgents roster is fixed to the canonical 12 agents.")


@router.delete("/agents/{agent_name}")
async def delete_agent(agent_name: str):
    """Deactivate a canonical TradingAgents agent (soft delete)."""
    from src.llm.llm_config import load_config, save_config

    canonical_id = _normalize_tradingagents_roster_key(agent_name)
    if not canonical_id:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

    config = load_config()
    agent_config = _purge_roster_aliases(config.get("agent_config", {}), canonical_id)
    agent_config[canonical_id] = {
        **_get_canonical_agent_defaults(canonical_id),
        **agent_config.get(canonical_id, {}),
        "active": False,
    }
    config["agent_config"] = agent_config
    save_config(config)

    from src.llm.scene_generator import load_agent_personalities
    import src.llm.scene_generator as sg
    sg.AGENT_PERSONALITIES = load_agent_personalities()
    sg.AVAILABLE_AGENTS = list(sg.AGENT_PERSONALITIES.keys())

    return {"success": True, "message": f"Agent '{canonical_id}' deactivated"}


@router.put("/agents/{old_name}/rename")
async def rename_agent(old_name: str, request: Request):
    raise HTTPException(status_code=400, detail="Canonical TradingAgents names cannot be renamed.")


@router.get("/agents/canvas-config")
async def get_canvas_config():
    """Return merged agent config for frontend canvas (positions, colors, names, personalities)."""
    canvas_config = load_canvas_config()
    merged = build_tradingagents_canvas_agents(canvas_config)

    return {
        "agents": merged,
        "short_names": TRADINGAGENTS_AGENT_DISPLAY_NAMES,
        "agent_ids": list(merged.keys()),
    }


@router.put("/agents/{agent_name}/canvas")
async def update_agent_canvas(agent_name: str, request: Request):
    """Update a canonical TradingAgents canvas config (position, color, active)."""
    body = await request.json()

    canonical_id = _normalize_tradingagents_roster_key(agent_name)
    if not canonical_id:
        raise HTTPException(status_code=400, detail="Only canonical TradingAgents agents can be updated.")

    canonical_agent = TRADINGAGENTS_AGENT_BY_ID[canonical_id]
    canvas_config = load_canvas_config()
    canvas_config = _purge_roster_aliases(canvas_config, canonical_id)
    canvas_config[canonical_id] = {
        "displayName": canonical_agent["display_name"],
        "position": canvas_config.get(canonical_id, {}).get("position", canonical_agent["position"]),
        "color": canvas_config.get(canonical_id, {}).get("color", canonical_agent["color"]),
        "active": canvas_config.get(canonical_id, {}).get("active", True),
    }
    if "position" in body:
        canvas_config[canonical_id]["position"] = body["position"]
    if "color" in body:
        canvas_config[canonical_id]["color"] = body["color"]
    if "active" in body:
        canvas_config[canonical_id]["active"] = body["active"]

    save_canvas_config(canvas_config)

    return {"success": True, "agent": canonical_id, "canvas": canvas_config[canonical_id]}


@router.delete("/agents/{agent_name}/canvas")
async def remove_agent_from_canvas(agent_name: str):
    """Remove a canonical agent from canvas (soft delete - sets active=false)."""
    canonical_id = _normalize_tradingagents_roster_key(agent_name)
    if not canonical_id:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found in canvas config")

    canvas_config = load_canvas_config()
    canvas_config = _purge_roster_aliases(canvas_config, canonical_id)
    canonical_agent = TRADINGAGENTS_AGENT_BY_ID[canonical_id]
    canvas_config[canonical_id] = {
        "displayName": canonical_agent["display_name"],
        "position": canvas_config.get(canonical_id, {}).get("position", canonical_agent["position"]),
        "color": canvas_config.get(canonical_id, {}).get("color", canonical_agent["color"]),
        "active": False,
    }
    save_canvas_config(canvas_config)

    return {"success": True, "message": f"Agent '{canonical_id}' removed from canvas"}


@router.get("/llm/providers")
async def llm_get_providers():
    """Get all providers: merged from providers_config.json + overrides + live stats."""
    from finance_db_api.llm.providers_config import get_provider_metadata
    from src.llm.llm_config import get_provider_overrides
    from src.llm.usage_tracker import get_usage_tracker

    metadata = get_provider_metadata()
    overrides = get_provider_overrides()
    tracker = get_usage_tracker()
    all_stats = await tracker.get_stats()

    # Get which providers are actually loaded in the router
    loaded = set()
    try:
        from src.llm.client import get_llm_client
        client = get_llm_client()
        # Fallback to metadata keys if client cannot be reached
        loaded = {k.lower() for k in metadata.keys()}
    except Exception as e:
        logger.warning(f"Could not reach LLM client for loaded status: {e}")

    providers = {}
    for key, meta in metadata.items():
        provider_stats = all_stats.get(key, {})
        override = overrides.get(key, {})
        providers[key] = {
            **meta,
            "key": key,
            "loaded": key in loaded,
            "override": override,
            "stats": provider_stats,
            "has_key": bool(provider_stats) or key in loaded,
        }

    return {"providers": providers}


@router.put("/llm/provider/{name}")
async def llm_update_provider(name: str, request: Request):
    """Update a provider override (enable/disable, change model, etc.)."""
    from src.llm.llm_config import set_provider_override
    body = await request.json()
    set_provider_override(name, body)
    return {"provider": name, "override": body}


@router.post("/llm/provider")
async def llm_add_provider(request: Request):
    """Add a new provider override."""
    from src.llm.llm_config import set_provider_override
    body = await request.json()
    name = body.pop("name", body.pop("key", None))
    if not name:
        raise HTTPException(status_code=400, detail="Provider name/key required")
    set_provider_override(name, body)
    return {"provider": name, "override": body}


@router.delete("/llm/provider/{name}")
async def llm_delete_provider(name: str):
    """Remove a provider override."""
    from src.llm.llm_config import delete_provider_override
    deleted = delete_provider_override(name)
    return {"provider": name, "deleted": deleted}


@router.post("/llm/test/{provider_name}")
async def llm_test_provider(provider_name: str, request: Request):
    """Test a specific provider/model combo."""
    from src.llm.router import get_router
    import time

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    model = body.get("model")

    rtr = get_router()
    provider = rtr._find_provider(provider_name)
    if not provider:
        return {"success": False, "error": f"Provider '{provider_name}' not loaded"}

    original_model = provider.current_model
    if model and model in provider.models:
        provider._current_model_index = provider.models.index(model)

    try:
        start = time.time()
        result = await provider.generate("Say HELLO in one word.", None)
        elapsed = (time.time() - start) * 1000
        return {
            "success": True,
            "provider": provider_name,
            "model": provider.current_model,
            "response": result[:200],
            "response_time_ms": round(elapsed, 1),
        }
    except Exception as e:
        return {
            "success": False,
            "provider": provider_name,
            "model": provider.current_model,
            "error": str(e)[:300],
        }
    finally:
        if model and original_model in provider.models:
            provider._current_model_index = provider.models.index(original_model)


@router.get("/llm/usage")
async def llm_get_usage():
    """Real-time usage: calls by phase, by agent, by provider."""
    from src.llm.usage_tracker import get_usage_tracker

    tracker = get_usage_tracker()
    provider_stats = await tracker.get_stats()

    # Get analytics DB breakdown
    phase_stats = {}
    agent_stats = {}
    try:
        from src.analytics.db import get_analytics_db
        db = get_analytics_db()
        # Provider breakdown from DB
        provider_breakdown = db.get_provider_breakdown()

        # Phase breakdown
        for phase in ["scout", "pre_mortem", "war_room", "agents", "oracle", "predictions"]:
            rows = db.get_recent_llm_calls(limit=500, phase=phase)
            if rows:
                total = len(rows)
                errors = sum(1 for r in rows if not r.get("success", True))
                avg_ms = sum(r.get("response_time_ms", 0) for r in rows) / max(total, 1)
                phase_stats[phase] = {"total_calls": total, "errors": errors, "avg_response_time_ms": round(avg_ms, 1)}

        # Agent breakdown
        for agent_name in ["Warren", "Charlie", "Technical", "Fundamental", "Sentiment",
                           "Risk", "Momentum", "Value", "Growth", "Contrarian",
                           "Macro", "Activist", "Valuation"]:
            stats = db.get_agent_stats(agent_name)
            if stats:
                agent_stats[agent_name] = stats
    except Exception:
        provider_breakdown = {}

    return {
        "provider_stats": provider_stats,
        "provider_breakdown": provider_breakdown,
        "phase_stats": phase_stats,
        "agent_stats": agent_stats,
    }


@router.post("/llm/reset-stats")
async def llm_reset_stats():
    """Reset usage tracker stats."""
    from src.llm.usage_tracker import get_usage_tracker
    tracker = get_usage_tracker()
    return {"status": "reset"}


@router.get("/llm/provider-health")
async def llm_provider_health():
    """Merged health: in-memory tracker + config metadata per provider."""
    from src.llm.usage_tracker import get_usage_tracker
    tracker = get_usage_tracker()
    provider_stats = tracker.provider_stats  # sync dict

    PROVIDER_META = {
        "nvidia":      {"emoji": "\U0001f7e2", "rpm_limit": 40},
        "openrouter":  {"emoji": "\U0001f500", "rpm_limit": 200},
        "google":      {"emoji": "\U0001f535", "rpm_limit": 60},
        "sambanova":   {"emoji": "\U0001f7e3", "rpm_limit": 30},
        "groq":        {"emoji": "\u26a1",      "rpm_limit": 30},
        "huggingface": {"emoji": "\U0001f917", "rpm_limit": 30},
        "ollama":      {"emoji": "\U0001f999", "rpm_limit": 999},
        "cloudflare":  {"emoji": "\u2601\ufe0f",  "rpm_limit": 40},
        "cerebras":    {"emoji": "\U0001f9e0", "rpm_limit": 30},
        "cohere":      {"emoji": "\U0001f536", "rpm_limit": 30},
    }

    result = {}
    for name, meta in PROVIDER_META.items():
        ps = provider_stats.get(name, {})
        calls = ps.get("calls", 0)
        errors = ps.get("failures", 0)
        result[name] = {
            "name": name,
            "emoji": meta["emoji"],
            "rpm_limit": meta["rpm_limit"],
            "calls": calls,
            "tokens": ps.get("tokens", 0),
            "errors": errors,
            "error_rate": round(errors / max(calls, 1) * 100, 1),
            "status": "error" if calls > 0 and errors > calls * 0.5 else "active",
        }
    return {"providers": result, "timestamp": datetime.now().isoformat()}


@router.get("/llm/route-analytics")
async def llm_route_analytics():
    """Phase/agent breakdown + hourly trend from SQLite analytics DB."""
    try:
        from src.analytics.db import get_analytics_db
        db = get_analytics_db()

        with db._conn() as conn:
            phase_rows = conn.execute("""
                SELECT phase,
                       COUNT(*) AS calls,
                       SUM(total_tokens) AS tokens,
                       AVG(response_time_ms) AS avg_ms,
                       SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS errors
                FROM llm_calls
                WHERE phase IS NOT NULL
                GROUP BY phase ORDER BY calls DESC
            """).fetchall()

            agent_rows = conn.execute("""
                SELECT agent_name,
                       COUNT(*) AS calls,
                       SUM(total_tokens) AS tokens,
                       AVG(response_time_ms) AS avg_ms,
                       SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS errors
                FROM llm_calls
                WHERE agent_name IS NOT NULL
                GROUP BY agent_name ORDER BY calls DESC LIMIT 20
            """).fetchall()

            trend_rows = conn.execute("""
                SELECT strftime('%Y-%m-%dT%H:00', timestamp) AS hour,
                       COUNT(*) AS calls,
                       SUM(total_tokens) AS tokens,
                       AVG(response_time_ms) AS avg_ms
                FROM llm_calls
                WHERE timestamp >= datetime('now', '-24 hours')
                GROUP BY hour ORDER BY hour ASC
            """).fetchall()

        return {
            "phase_breakdown": [dict(r) for r in phase_rows],
            "agent_breakdown": [dict(r) for r in agent_rows],
            "hourly_trend": [dict(r) for r in trend_rows],
            "timestamp": datetime.now().isoformat(),
        }
    except Exception as e:
        logger.error(f"llm_route_analytics error: {e}")
        return {"phase_breakdown": [], "agent_breakdown": [], "hourly_trend": [], "error": str(e)}


# ============================================================================
# GOD MODE / DIRECTOR'S CONSOLE ENDPOINTS
# ============================================================================

@router.post("/admin/kill_switch")
async def admin_kill_switch():
    """Immediately liquidate the portfolio."""
    from src.runtime.redis_client import publish_event
    logger.warning("🚨 GOD MODE: KILL SWITCH ACTIVATED 🚨")
    
    # Actually liquidate the portfolio state
    liquidations = await portfolio_manager.liquidate_all_positions(portfolio_state)
    
    # Force a mock agent decision to SELL (for UI visual cues)
    await publish_event("trading_floor_events", "agent_decision", {
        "ticker": "ALL",
        "majority": "SELL",
        "consensus": True,
        "disagreements": 0,
        "message": "DIRECTOR OVERRIDE: LIQUIDATE EVERYTHING"
    })
    
    # Broadcast individual trade execution events for each liquidation
    for trade in liquidations:
        await publish_event("trading_floor_events", "trade_executed", {
            "type": "trade_executed",
            "symbol": trade.symbol,
            "action": trade.action,
            "quantity": trade.quantity,
            "price": trade.price,
            "value": trade.value,
            "timestamp": trade.timestamp,
            "reason": "Director Intervention: Kill Switch"
        })

    # Broadcast a final portfolio update
    await publish_event("trading_floor_events", "portfolio_update", {
        "portfolio": portfolio_state,
        "timestamp": datetime.now().isoformat()
    })
    
    # Broadcast the global kill_switch trigger
    await publish_event("trading_floor_events", "kill_switch", {
        "timestamp": datetime.now().isoformat(),
        "reason": "Director Intervention"
    })
    return {"status": "Kill switch activated", "liquidations": len(liquidations)}


@router.post("/admin/queue_set")
async def admin_queue_set(request: Request):
    """Manually override the ticker queue."""
    body = await request.json()
    tickers = body.get("tickers", [])
    
    if not isinstance(tickers, list):
        raise HTTPException(status_code=400, detail="tickers must be a list of strings")
    
    # Clear and set queue
    await ticker_queue.clear()
    for t in tickers:
        await ticker_queue.add_ticker(t.upper(), priority=100.0, requester="Director")
        
    return {"status": "Queue overridden", "queue": await ticker_queue.get_status()}


@router.post("/admin/voice_of_god")
async def admin_voice_of_god(request: Request):
    """Force the Oracle to say a specific message."""
    from src.runtime.redis_client import publish_event
    body = await request.json()
    message = body.get("message")
    
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
        
    logger.info(f"🎤 GOD MODE: {message}")
    
    await publish_event("trading_floor_events", "voice_of_god", {
        "message": message,
        "timestamp": datetime.now().isoformat()
    })
    
    return {"status": "Message sent"}


async def _save_live_config_payload(body: Dict[str, Any], source: str) -> Dict[str, Any]:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Config payload must be a JSON object")

    try:
        from src.analytics.db import get_analytics_db

        _migrate_live_config_if_needed()
        db = get_analytics_db()
        for key, value in body.items():
            db.set_live_config(str(key), value, f"Updated via {source}")

        current_config = db.get_all_live_config()
        return {"status": "Config updated", "config": current_config}
    except Exception as e:
        logger.error(f"Failed to update live_config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/config")
async def admin_update_config(request: Request):
    """Update live configuration in SQLite (live_config table)."""
    body = await request.json()
    return await _save_live_config_payload(body, "/admin/config")


# ============================================================================
# NEWS BUFFER API (Redis-backed FIFO queue for cost optimization)
# ============================================================================

@router.get("/news-buffer/status")
async def get_news_buffer_status():
    """Get news buffer status: size, last scrape, top headlines."""
    from src.llm.news_buffer import get_news_buffer
    buffer = get_news_buffer()
    return await buffer.get_status()


@router.post("/news-buffer/refill")
async def refill_news_buffer():
    """Manually trigger scrape and refill the buffer."""
    from src.llm.news_buffer import get_news_buffer
    buffer = get_news_buffer()
    
    try:
        articles = await buffer.scrape_news()
        if not articles:
            return {"success": False, "message": "No articles found", "count": 0}
        
        pushed = await buffer.push_headlines(articles)
        return {
            "success": True,
            "message": f"Pushed {pushed} articles to buffer",
            "scraped": len(articles),
            "pushed": pushed
        }
    except Exception as e:
        logger.error(f"Failed to refill news buffer: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/news-buffer/clear")
async def clear_news_buffer():
    """Clear the entire news buffer."""
    from src.llm.news_buffer import get_news_buffer
    buffer = get_news_buffer()
    success = await buffer.clear_buffer()
    return {"success": success, "message": "Buffer cleared" if success else "Failed to clear buffer"}


@router.post("/news-buffer/trim")
async def trim_news_buffer(max_size: int = None):
    """Trim buffer to max size (removes oldest articles)."""
    from src.llm.news_buffer import get_news_buffer
    buffer = get_news_buffer()
    result = await buffer.trim_buffer(max_size)
    return result


@router.post("/news-buffer/set-max-size")
async def set_news_buffer_max_size(max_size: int):
    """Set the maximum buffer size."""
    from src.llm.news_buffer import set_max_buffer_size, get_max_buffer_size
    new_size = set_max_buffer_size(max_size)
    return {"success": True, "max_size": new_size}


@router.get("/news-buffer/pop")
async def pop_headline_from_buffer():
    """Pop a single headline from the buffer."""
    from src.llm.news_buffer import get_news_buffer
    buffer = get_news_buffer()
    headline = await buffer.pop_headline()
    
    if headline:
        return {"success": True, "headline": headline}
    return {"success": False, "message": "Buffer is empty"}


@router.post("/news-buffer/start-auto")
async def start_auto_news_scrape(interval_minutes: int = 60):
    """Start automatic hourly news scraping."""
    from src.llm.news_buffer import start_auto_scrape, is_auto_scrape_running
    
    if is_auto_scrape_running():
        return {"success": False, "message": "Auto-scrape already running"}
    
    success = await start_auto_scrape(interval_minutes)
    return {
        "success": success,
        "message": f"Auto-scrape started (interval: {interval_minutes} min)" if success else "Failed to start"
    }


@router.post("/news-buffer/stop-auto")
async def stop_auto_news_scrape():
    """Stop automatic news scraping."""
    from src.llm.news_buffer import stop_auto_scrape
    success = await stop_auto_scrape()
    return {
        "success": success,
        "message": "Auto-scrape stopped" if success else "Auto-scrape was not running"
    }


@router.get("/news-buffer/auto-status")
async def get_auto_scrape_status():
    """Check if auto-scrape is running and return interval."""
    from src.llm.news_buffer import is_auto_scrape_running, get_auto_scrape_interval
    return {
        "running": is_auto_scrape_running(),
        "interval_minutes": get_auto_scrape_interval()
    }


# ==================== AUTO GOSSIP ENDPOINTS ====================

@router.post("/gossip/start")
async def start_auto_gossip(interval_minutes: int = 5):
    """Start automatic gossip during dead hours."""
    from src.llm.auto_gossip import get_auto_gossip_manager
    
    auto_manager = get_auto_gossip_manager()
    auto_manager.set_ws_manager(manager)  # Pass the WebSocket manager
    
    result = await auto_manager.start(interval_minutes)
    return result


# Storage for generated gossips (in-memory, max 20)
_generated_gossips = []

import uuid
from datetime import datetime


def _store_gossip(
    headline: str,
    headline_data: dict,
    dialogue: list,
    agents: list,
    provider: str = None,
    model: str = None,
    fallback: bool = False,
    sent_to_frontend: bool = False,
    broadcast_clients: int = 0,
    error: str = None
) -> dict:
    """Store a generated gossip for display with full metadata."""
    global _generated_gossips
    
    gossip_entry = {
        "id": str(uuid.uuid4())[:8],
        "headline": headline,
        "headline_data": headline_data,
        "dialogue": dialogue,
        "agents": agents,
        "provider": provider,
        "model": model,
        "fallback": fallback,
        "sent_to_frontend": sent_to_frontend,
        "broadcast_clients": broadcast_clients,
        "error": error,
        "timestamp": datetime.now().isoformat()
    }
    
    _generated_gossips.insert(0, gossip_entry)
    # Keep only last 20
    _generated_gossips = _generated_gossips[:20]
    
    logger.info(f"Stored gossip: {headline[:50]}... (sent={sent_to_frontend}, clients={broadcast_clients})")
    return gossip_entry


@router.get("/gossip/recent")
async def get_recent_gossips(count: int = 5):
    """Get recently generated gossips."""
    global _generated_gossips
    return {"gossips": _generated_gossips[:count]}


@router.post("/gossip/stop")
async def stop_auto_gossip():
    """Stop automatic gossip."""
    from src.llm.auto_gossip import get_auto_gossip_manager
    
    manager = get_auto_gossip_manager()
    result = await manager.stop()
    return result


@router.get("/gossip/status")
async def get_gossip_status():
    """Check auto-gossip status."""
    from src.llm.auto_gossip import get_auto_gossip_manager
    
    auto_manager = get_auto_gossip_manager()
    status = auto_manager.get_status()
    # Add count of stored gossips
    status["stored_gossips"] = len(_generated_gossips)
    return status


@router.post("/gossip/trigger")
async def trigger_gossip_now():
    """Manually trigger one gossip cycle."""
    from src.llm.auto_gossip import get_auto_gossip_manager
    
    auto_manager = get_auto_gossip_manager()
    # Ensure ws_manager is set
    if not auto_manager.ws_manager:
        auto_manager.set_ws_manager(manager)
    result = await auto_manager.trigger_now()
    
    if result:
        # Broadcast to WebSocket clients
        broadcast_result = await auto_manager.broadcast_gossip(result)
        
        # Store for display with broadcast status
        gossip_entry = _store_gossip(
            headline=result.get("headline", ""),
            headline_data=result.get("headline_data"),
            dialogue=result.get("dialogue", []),
            agents=result.get("agents_used", []),
            provider=result.get("provider"),
            model=result.get("model"),
            fallback=result.get("fallback", False),
            sent_to_frontend=broadcast_result.get("success", False),
            broadcast_clients=broadcast_result.get("clients", 0),
            error=broadcast_result.get("error")
        )
        
        return {
            "success": True,
            "gossip": gossip_entry,
            "broadcast": broadcast_result
        }
    else:
        return {
            "success": False,
            "message": "Failed to generate gossip (buffer empty or error)"
        }


@router.get("/gossip/preview")
async def preview_gossip_generation():
    """Preview a gossip generation and broadcast to frontend."""
    from src.llm.gossip_generator import generate_gossip_dialogue, select_random_agents
    from src.llm.news_buffer import get_news_buffer
    
    # Get a real headline from the buffer
    buffer = get_news_buffer()
    headline = await buffer.pop_headline()
    
    if not headline:
        # Fallback to a sample headline if buffer is empty
        headline = {"title": "Markets rally on Fed news", "source": "sample"}
    
    agents = select_random_agents(3)
    headline_title = headline.get("title", str(headline)) if isinstance(headline, dict) else headline
    
    result = await generate_gossip_dialogue(headline_title, agents)
    
    # Broadcast to WebSocket clients
    broadcast_result = {"success": False, "clients": 0}
    if result.get("success") and result.get("dialogue"):
        try:
            message = {
                "type": "gossip_dialogue",
                "data": {
                    "headline": headline_title,
                    "dialogue": result.get("dialogue", []),
                    "timestamp": datetime.now().isoformat(),
                    "agents": result.get("agents_used", [])
                }
            }
            await manager.broadcast(message)
            broadcast_result = {
                "success": True,
                "clients": len(manager.active_connections)
            }
            logger.info(f"Broadcast gossip to {broadcast_result['clients']} clients")
        except Exception as e:
            logger.error(f"Failed to broadcast gossip: {e}")
            broadcast_result = {"success": False, "clients": 0, "error": str(e)}
    
    # Store for display with broadcast status
    gossip_entry = _store_gossip(
        headline=headline_title,
        headline_data=headline if isinstance(headline, dict) else None,
        dialogue=result.get("dialogue", []),
        agents=[a.get("name") for a in agents],
        provider=result.get("provider"),
        model=result.get("model"),
        fallback=result.get("fallback", False),
        sent_to_frontend=broadcast_result.get("success", False),
        broadcast_clients=broadcast_result.get("clients", 0),
        error=result.get("error")
    )
    
    return {
        "success": True,
        "headline": headline_title,
        "headline_data": headline if isinstance(headline, dict) else None,
        "agents": agents,
        "result": result,
        "gossip_entry": gossip_entry,
        "broadcast": broadcast_result
    }


# ============================================
# ADMIN EXECUTION ENDPOINTS
# ============================================

@router.get("/execute/status")
async def get_hybrid_execution_status():
    """
    Get current execution state.
    Returns whether the system is currently analyzing and the cycle count.
    """
    from src.runtime.automation import autonomous_trader
    from src.integrations.tradingagents_runtime import is_abort_requested, load_active_run
    
    # Check if manual pipeline is active
    manual_phase = pipeline_state.get("phase", "IDLE").upper()
    active_run = load_active_run()
    active_run_id = active_run.get("run_id") if active_run else None
    shared_manual_active = bool(active_run and active_run.get("status") == "running" and not is_abort_requested(active_run_id))

    if manual_phase not in ["IDLE", "COMPLETE", "READY", "AWAITING RUN..."] and not autonomous_trader.is_analyzing and not shared_manual_active:
        clear_pipeline_state()
        manual_phase = "IDLE"

    is_manual_analyzing = shared_manual_active or manual_phase not in ["IDLE", "COMPLETE", "READY", "AWAITING RUN..."]
    decision_service = get_tradingagents_decision_service()
    latest_run = decision_service.get_latest_run_summary()
    latest_rebalance = decision_service.get_latest_rebalance()
    
    return {
        "is_analyzing": autonomous_trader.is_analyzing or is_manual_analyzing,
        "cycle": pipeline_state.get("cycle", autonomous_trader.cycle_count),
        "running": autonomous_trader.running or is_manual_analyzing,
        "llm_enabled": autonomous_trader.llm_enabled,
        "phase": manual_phase if is_manual_analyzing else "IDLE",
        "ticker": pipeline_state.get("ticker", ""),
        "total_phases": 12,
        "current_phase": pipeline_state.get("phase_num", 0),
        "status_message": pipeline_state.get("status", "System Ready"),
        "latest_run": latest_run,
        "latest_rebalance": latest_rebalance,
    }


@router.post("/execute/pipeline")
async def execute_pipeline(request: dict = None):
    """
    Mode B: Run full 8-phase pipeline with automatic execution.
    Optional ticker override to analyze specific ticker.
    """
    request = request or {}
    ticker_override = request.get("ticker")
    run_rebalance = request.get("rebalance", True)
    
    logger.info(f"[PIPELINE EXECUTE] Starting 8-phase pipeline (ticker={ticker_override or 'auto'})")
    
    try:
        from src.runtime.automation import autonomous_trader
        
        # Run single cycle
        result = await autonomous_trader.execute_single_cycle(
            ticker_override=ticker_override,
            run_rebalance=run_rebalance
        )
        
        # Record execution history
        _record_execution({
            "cycle": result["cycle"],
            "ticker": result.get("ticker"),
            "action": "PIPELINE",
            "success": result["success"],
            "message": f"Cycle #{result['cycle']} complete",
            "trigger": "manual"
        })
        
        return {
            "success": result["success"],
            "cycle": result["cycle"],
            "ticker": result["ticker"],
            "rebalance_actions": result["rebalance_actions"],
            "error": result["error"]
        }
        
    except Exception as e:
        logger.error(f"Pipeline execution failed: {e}")
        # Record failed execution
        _record_execution({
            "cycle": 0,
            "ticker": ticker_override,
            "action": "PIPELINE",
            "success": False,
            "message": str(e),
            "trigger": "manual"
        })
        raise HTTPException(status_code=500, detail=str(e))


# ============================================
# EXECUTION HISTORY ENDPOINTS
# ============================================

def _record_execution(entry: dict):
    """Record a pipeline execution to history (DB only)."""
    from src.analytics.data_access import get_data_access

    _migrate_execution_history_if_needed()
    data_access = get_data_access()
    data_access.record_execution(
        cycle=entry.get("cycle"),
        ticker=entry.get("ticker"),
        action=entry.get("action", "HOLD"),
        success=entry.get("success", False),
        message=entry.get("message", ""),
        trigger=entry.get("trigger", "manual"),
    )
    return entry


@router.get("/execute/history")
async def get_execution_history(count: int = 20):
    """Get recent pipeline execution history from SQLite."""
    from src.analytics.data_access import get_data_access

    _migrate_execution_history_if_needed()
    data_access = get_data_access()
    history = data_access.get_execution_history(limit=count)
    return {"history": history}


# ============================================================================
# PORTFOLIO & PERFORMANCE ENDPOINTS
# ============================================================================

@router.get("/portfolio")
async def get_portfolio():
    """Get full portfolio state, including cash, value, and position details."""
    try:
        decision_service = get_tradingagents_decision_service()
        from src.analytics.data_access import get_data_access
        data_access = get_data_access()
        sqlite_state = await _run_portfolio_sync_call(
            sync_portfolio_state_from_sqlite,
            timeout_seconds=2.0,
            fallback={},
            label="get_portfolio sync_portfolio_state_from_sqlite",
        ) or {}
        sqlite_state["position_details"] = dict(sqlite_state.get("position_details") or {})
        portfolio_view = await _run_portfolio_sync_call(
            decision_service._portfolio_rows,
            portfolio_state,
            timeout_seconds=4.0,
            fallback={"rows": [], "total_value": portfolio_state.get("total_value", 0.0), "cash_weight_pct": 0.0},
            label="get_portfolio portfolio_rows",
        )
        performance = await _run_portfolio_sync_call(
            decision_service.get_performance_summary,
            portfolio_state,
            timeout_seconds=4.0,
            fallback={
                "portfolio_return_pct": 0.0,
                "sp500_return_pct": 0.0,
                "alpha_pct": 0.0,
                "position_rows": [],
                "cash_weight_pct": 0.0,
            },
            label="get_portfolio performance_summary",
        )
        risk = decision_service.compute_portfolio_risk_snapshot(portfolio_state)
        latest_run = decision_service.get_latest_run_summary()
        latest_rebalance = decision_service.get_latest_rebalance()
        history = data_access.get_execution_history(limit=20)
        analytics = await _run_portfolio_sync_call(
            portfolio_manager.get_portfolio_analytics,
            portfolio_state,
            timeout_seconds=3.0,
            fallback={
                "total_value": portfolio_state.get("total_value", 0.0),
                "cash": portfolio_state.get("cash", 0.0),
                "positions_count": len(portfolio_state.get("positions", {}) or {}),
                "total_trades": 0,
                "profitable_trades": 0,
                "win_rate": 0.0,
                "daily_pnl": portfolio_state.get("daily_pnl", 0.0),
                "total_return": 0.0,
            },
            label="get_portfolio analytics",
        )
        
        return {
            "cash": portfolio_state.get("cash", 1100000.0),
            "total_value": portfolio_view["total_value"],
            "daily_pnl": portfolio_state.get("daily_pnl", 0.0),
            "positions": portfolio_state.get("positions", {}),
            "portfolio": {
                "cash": portfolio_state.get("cash", 1100000.0),
                "total_value": portfolio_view["total_value"],
                "daily_pnl": portfolio_state.get("daily_pnl", 0.0),
                "positions": portfolio_state.get("positions", {}),
                "position_rows": portfolio_view["rows"],
                "cash_weight_pct": portfolio_view["cash_weight_pct"],
                "position_details": sqlite_state["position_details"],
                "performance_summary": performance,
                "analytics": analytics,
                "closed_trades": data_access.list_closed_trades(limit=20),
                "benchmark": {
                    "daily_alpha_24h": performance["alpha_pct"],
                    "daily_spy_return_24h": performance["sp500_return_pct"],
                    "cumulative_alpha": performance["alpha_pct"],
                    "cumulative_spy_return": performance["sp500_return_pct"],
                },
            },
            "position_tracker": portfolio_manager.position_tracker,
            "position_details": sqlite_state["position_details"],
            "position_rows": portfolio_view["rows"],
            "cash_weight_pct": portfolio_view["cash_weight_pct"],
            "performance_summary": performance,
            "spy_benchmark": {
                "aggregate": {
                    "fund_return": performance["portfolio_return_pct"],
                    "spy_return": performance["sp500_return_pct"],
                    "alpha": performance["alpha_pct"],
                },
                "by_position": {},
            },
            "portfolio_risk": risk,
            "latest_run": latest_run,
            "latest_rebalance": latest_rebalance,
            "analytics": analytics,
            "execution_history": history,
            "closed_trades": data_access.list_closed_trades(limit=20),
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Error fetching portfolio: {e}")
        return {
            "cash": portfolio_state.get("cash", 1100000.0),
            "total_value": portfolio_state.get("total_value", 1100000.0),
            "positions": {},
            "error": str(e)
        }


@router.get("/benchmark/baseline")
async def get_benchmark_baseline():
    """Get fund performance vs SPY baseline."""
    try:
        decision_service = get_tradingagents_decision_service()
        summary = decision_service.get_performance_summary(portfolio_state)
        return {
            "fund_return_pct": summary["portfolio_return_pct"],
            "spy_return_pct": summary["sp500_return_pct"],
            "alpha_pct": summary["alpha_pct"],
            "beating_spy": summary["alpha_pct"] > 0,
            "history": performance_history[-50:] if performance_history else [],
            "snapshot": summary,
        }
    except Exception as e:
        logger.error(f"Error fetching benchmark: {e}")
        return {"error": str(e)}


@router.get("/performance/summary")
async def get_performance_summary():
    """First-class portfolio vs S&P model used by admin surfaces."""
    decision_service = get_tradingagents_decision_service()
    await _run_portfolio_sync_call(
        sync_portfolio_state_from_sqlite,
        timeout_seconds=2.0,
        fallback={},
        label="get_performance_summary sync_portfolio_state_from_sqlite",
    )
    return await _run_portfolio_sync_call(
        decision_service.get_performance_summary,
        portfolio_state,
        timeout_seconds=4.0,
        fallback={
            "portfolio_return_pct": 0.0,
            "sp500_return_pct": 0.0,
            "alpha_pct": 0.0,
            "position_rows": [],
            "cash_weight_pct": 0.0,
        },
        label="get_performance_summary performance_summary",
    )


# ============================================
# SQLITE DATA ACCESS ENDPOINTS
# ============================================

@router.get("/db/positions")
async def get_db_positions():
    """Get all positions from SQLite database"""
    try:
        from src.analytics.data_access import get_data_access
        data_access = get_data_access()
        positions = data_access.get_position_details()
        return {"positions": positions}
    except Exception as e:
        logger.error(f"Failed to get positions from SQLite: {e}")
        return {"positions": {}}


@router.get("/db/blocklist")
async def get_db_blocklist():
    """Get active blocklist from SQLite database"""
    try:
        from src.analytics.data_access import get_data_access
        data_access = get_data_access()
        # Clean up expired entries first
        data_access.cleanup_expired_blocklist()
        blocklist = data_access.get_blocklist_details()
        return {"blocklist": blocklist}
    except Exception as e:
        logger.error(f"Failed to get blocklist from SQLite: {e}")
        return {"blocklist": []}


@router.post("/db/blocklist/add")
async def add_to_blocklist(ticker: str, reason: str = "Manual add", hours: int = 24):
    """Add ticker to blocklist"""
    try:
        from src.analytics.data_access import get_data_access
        data_access = get_data_access()
        data_access.add_to_blocklist(ticker.upper(), reason, hours)
        return {"success": True, "message": f"{ticker} added to blocklist for {hours}h"}
    except Exception as e:
        logger.error(f"Failed to add to blocklist: {e}")
        return {"success": False, "error": str(e)}


@router.delete("/db/blocklist/{ticker}")
async def remove_from_blocklist(ticker: str):
    """Remove ticker from blocklist"""
    try:
        from src.analytics.data_access import get_data_access
        data_access = get_data_access()
        data_access.remove_from_blocklist(ticker.upper())
        return {"success": True, "message": f"{ticker} removed from blocklist"}
    except Exception as e:
        logger.error(f"Failed to remove from blocklist: {e}")
        return {"success": False, "error": str(e)}


@router.get("/db/agent-accuracy")
async def get_agent_accuracy():
    """Get agent accuracy stats from SQLite - THE ALPHA QUERY"""
    try:
        from src.analytics.data_access import get_data_access
        data_access = get_data_access()
        stats = data_access.get_agent_accuracy_stats()
        top_agents = data_access.get_top_agents(limit=5)
        return {
            "stats": stats,
            "top_agents": top_agents
        }
    except Exception as e:
        logger.error(f"Failed to get agent accuracy: {e}")
        return {"stats": {}, "top_agents": []}


@router.get("/db/trade-memory")
async def get_trade_memory(limit: int = 50):
    """Get trade memory from SQLite"""
    try:
        from src.analytics.data_access import get_data_access
        data_access = get_data_access()
        memories = data_access.get_trade_memories(limit=limit)
        return {"memories": memories}
    except Exception as e:
        logger.error(f"Failed to get trade memory: {e}")
        return {"memories": []}


@router.get("/execute/history/{history_id}/details")
async def get_execution_run_details(history_id: int):
    """Get full details for an execution run from SQLite"""
    try:
        from src.analytics.data_access import get_data_access
        _migrate_execution_history_if_needed()
        data_access = get_data_access()
        details = data_access.get_execution_details(history_id)
        if not details:
            raise HTTPException(status_code=404, detail="Execution record not found")
        return details
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get execution details: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/execute/history/{history_id}/script")
async def get_execution_run_script(history_id: int):
    """Get the script (oracle reasoning) for an execution run"""
    try:
        from src.analytics.data_access import get_data_access
        _migrate_execution_history_if_needed()
        data_access = get_data_access()
        details = data_access.get_execution_details(history_id)
        if not details:
            raise HTTPException(status_code=404, detail="Execution record not found")
            
        # The script is stored in trade_memory.oracle_reasoning if joined
        tm = details.get("trade_memory", {})
        script = tm.get("oracle_reasoning", "No script available for this run.")
        
        return {"script": script}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get execution script: {e}")
        raise HTTPException(status_code=500, detail=str(e))


