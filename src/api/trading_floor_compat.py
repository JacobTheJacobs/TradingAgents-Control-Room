"""
Compatibility Trading Floor router.

Keeps core Trading Floor endpoints online when the full trading_floor_simple
runtime cannot import (for example, after deep cleanup of legacy modules).
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from src.integrations.tradingagents_roster import (
    TRADINGAGENTS_AGENT_BY_ID,
    TRADINGAGENTS_AGENT_DISPLAY_NAMES,
    TRADINGAGENTS_CANONICAL_AGENTS,
    build_tradingagents_canvas_agents,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["trading-floor-compat"])
_ACTIVE_WS_CLIENTS: set[WebSocket] = set()


def _default_agents() -> Dict[str, Dict[str, Any]]:
    names = [
        "Market Analyst",
        "News Analyst",
        "Social Analyst",
        "Fundamentals Analyst",
        "Bull Researcher",
        "Bear Researcher",
        "Research Manager",
        "Trader",
        "Aggressive Analyst",
        "Conservative Analyst",
        "Neutral Analyst",
        "Risk Judge",
    ]
    return {
        name: {
            "name": name,
            "status": "idle",
            "confidence": 0.0,
            "message": "Awaiting pipeline activation.",
            "last_update": datetime.now().isoformat(),
        }
        for name in names
    }


portfolio_state: Dict[str, Any] = {
    "cash": 1_100_000.0,
    "total_value": 1_100_000.0,
    "daily_pnl": 0.0,
    "positions": {},
}

pipeline_state: Dict[str, Any] = {
    "phase": "IDLE",
    "ticker": "---",
    "trade_date": None,
    "cycle": 0,
    "regime": None,
    "phase_num": 0,
    "pipeline_mode": "manual",
    "active_run_id": None,
    "run_id": None,
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
    "live_step_dialogue": {},
}

agent_states: Dict[str, Dict[str, Any]] = _default_agents()
trading_mode = "stopped"


def _load_admin_config_dict(key: str) -> Dict[str, Any]:
    try:
        from src.analytics.data_access import get_data_access
        data = get_data_access().get_config(key)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _compat_agent_behavior_defaults() -> Dict[str, Dict[str, Any]]:
    defaults: Dict[str, Dict[str, Any]] = {}
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_id = str(agent.get("id") or "").strip()
        if not agent_id:
            continue
        defaults[agent_id] = {
            "id": agent_id,
            "displayName": agent.get("display_name") or agent_id,
            "personality": agent.get("personality"),
            "default_animation": "idle",
            "default_station": agent.get("station") or "desk",
            "default_path": "direct",
            "active": True,
        }
    return defaults


def _load_agent_behavior_defaults() -> Dict[str, Dict[str, Any]]:
    configured = _load_admin_config_dict("agent_behavior_defaults")
    if configured:
        return configured
    return _compat_agent_behavior_defaults()


def _flow_state_payload() -> Dict[str, Any]:
    pipeline_scenes = _load_admin_config_dict("pipeline_scenes")
    scene_config_missing = len(pipeline_scenes) == 0
    scene_config_warning = pipeline_state.get("scene_config_warning")
    if not scene_config_warning and scene_config_missing:
        scene_config_warning = (
            "Pipeline scenes config is missing. Save timeline scenes to enable animation/pathfinding."
        )
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
        "pipeline_mode": pipeline_state.get("pipeline_mode", "manual"),
        "run_id": pipeline_state.get("active_run_id"),
        "active_run_id": pipeline_state.get("active_run_id"),
        "current_step": pipeline_state.get("current_step"),
        "agent_display_name": pipeline_state.get("agent_display_name"),
        "status": pipeline_state.get("status"),
        "action": pipeline_state.get("action"),
        "research_depth": pipeline_state.get("research_depth"),
        "llm_calls": pipeline_state.get("llm_calls", 0),
        "tool_calls": pipeline_state.get("tool_calls", 0),
        "tokens_in": pipeline_state.get("tokens_in", 0),
        "tokens_out": pipeline_state.get("tokens_out", 0),
        "agents_completed": pipeline_state.get("agents_completed", 0),
        "reports_completed": pipeline_state.get("reports_completed", 0),
        "attempt": pipeline_state.get("attempt", 1),
        "max_attempts": pipeline_state.get("max_attempts", 1),
        "timestamp": datetime.now().isoformat(),
        "agent_states": agent_states,
        "live_step_dialogue": pipeline_state.get("live_step_dialogue", {}),
        "pipeline_scenes": pipeline_scenes,
        "agent_behavior_defaults": _load_agent_behavior_defaults(),
        "scene_config_missing": scene_config_missing,
        "scene_config_warning": scene_config_warning,
    }


async def broadcast_payload(payload: Dict[str, Any]) -> None:
    dead_clients = []
    message = json.dumps(payload)
    for ws in list(_ACTIVE_WS_CLIENTS):
        try:
            await ws.send_text(message)
        except Exception:
            dead_clients.append(ws)
    for ws in dead_clients:
        _ACTIVE_WS_CLIENTS.discard(ws)


@router.get("/flow/state")
async def get_flow_state():
    return _flow_state_payload()


@router.get("/mode")
async def get_mode():
    return {"mode": trading_mode}


@router.post("/mode/{mode}")
async def set_mode(mode: str):
    global trading_mode
    if mode not in {"automatic", "manual", "stopped"}:
        raise HTTPException(status_code=400, detail="Mode must be: automatic, manual, or stopped")
    previous = trading_mode
    trading_mode = mode
    pipeline_state["pipeline_mode"] = mode
    pipeline_state["timestamp"] = datetime.now().isoformat()
    return {"success": True, "mode": mode, "previous": previous}


@router.get("/agents")
async def get_agents():
    return {"agents": agent_states, "timestamp": datetime.now().isoformat()}


@router.get("/agents/canvas-config")
async def get_agents_canvas_config():
    merged = build_tradingagents_canvas_agents({})
    return {
        "agents": merged,
        "short_names": TRADINGAGENTS_AGENT_DISPLAY_NAMES,
        "agent_ids": list(merged.keys()),
    }


@router.get("/agents/personalities")
async def get_agents_personalities():
    agents = {}
    behavior_defaults = {}
    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        agent_id = agent["id"]
        display_name = agent["display_name"]
        runtime_state = agent_states.get(display_name, {})
        agents[agent_id] = {
            "name": agent_id,
            "displayName": display_name,
            "shortLabel": agent["short_label"],
            "personality": agent["personality"],
            "active": True,
            "provider": "tradingagents",
            "model": None,
            "color": agent["color"],
            "position": agent["position"],
            "on_canvas": True,
            "status": runtime_state.get("status", "idle"),
            "station": agent["station"],
            "default_animation": "idle",
            "default_station": agent["station"],
            "default_path": "direct",
        }
        behavior_defaults[agent_id] = {
            "id": agent_id,
            "displayName": display_name,
            "personality": agent["personality"],
            "default_animation": "idle",
            "default_station": agent["station"],
            "default_path": "direct",
            "active": True,
        }
    return {
        "agents": agents,
        "behavior_defaults": behavior_defaults,
        "timestamp": datetime.now().isoformat(),
    }


@router.get("/portfolio")
async def get_portfolio():
    return {
        **portfolio_state,
        "portfolio": {
            **portfolio_state,
            "position_rows": [],
            "position_details": {},
            "performance_summary": {
                "portfolio_return_pct": 0.0,
                "sp500_return_pct": 0.0,
                "alpha_pct": 0.0,
                "position_rows": [],
                "cash_weight_pct": 100.0,
            },
            "analytics": {
                "total_value": portfolio_state["total_value"],
                "cash": portfolio_state["cash"],
                "positions_count": 0,
                "total_trades": 0,
                "profitable_trades": 0,
                "win_rate": 0.0,
                "daily_pnl": portfolio_state["daily_pnl"],
                "total_return": 0.0,
            },
            "closed_trades": [],
        },
        "position_tracker": {},
        "position_details": {},
        "position_rows": [],
        "cash_weight_pct": 100.0,
        "performance_summary": {
            "portfolio_return_pct": 0.0,
            "sp500_return_pct": 0.0,
            "alpha_pct": 0.0,
            "position_rows": [],
            "cash_weight_pct": 100.0,
        },
        "spy_benchmark": {
            "aggregate": {"fund_return": 0.0, "spy_return": 0.0, "alpha": 0.0},
            "by_position": {},
        },
        "analytics": {
            "total_value": portfolio_state["total_value"],
            "cash": portfolio_state["cash"],
            "positions_count": 0,
            "total_trades": 0,
            "profitable_trades": 0,
            "win_rate": 0.0,
            "daily_pnl": portfolio_state["daily_pnl"],
            "total_return": 0.0,
        },
        "execution_history": [],
        "closed_trades": [],
        "timestamp": datetime.now().isoformat(),
    }


@router.get("/state")
async def get_state():
    return {
        "agent_states": agent_states,
        "portfolio": portfolio_state,
        "pipeline_state": _flow_state_payload(),
        "timestamp": datetime.now().isoformat(),
    }


@router.get("/schedule/phase")
async def get_schedule_phase():
    return {
        "current_phase": {"phase": "closed", "market_open": False},
        "next_phase": "closed",
        "seconds_until_next": 0,
        "llm_active": False,
        "gossip_active": False,
        "timestamp": datetime.now().isoformat(),
    }


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    _ACTIVE_WS_CLIENTS.add(websocket)
    pipeline_scenes = _load_admin_config_dict("pipeline_scenes")
    agent_behavior_defaults = _load_agent_behavior_defaults()
    initial_payload = {
        "type": "initial_state",
        "agents": agent_states,
        "portfolio": {
            **portfolio_state,
            "position_tracker": {},
            "position_details": {},
            "position_rows": [],
            "performance_summary": {
                "portfolio_return_pct": 0.0,
                "sp500_return_pct": 0.0,
                "alpha_pct": 0.0,
                "position_rows": [],
                "cash_weight_pct": 100.0,
            },
            "benchmark": {"daily_alpha_24h": 0.0},
        },
        "schedule": {"phase": "closed", "market_open": False},
        "pipeline_state": _flow_state_payload(),
        "pipeline_scenes": pipeline_scenes,
        "agent_behavior_defaults": agent_behavior_defaults,
        "timestamp": datetime.now().isoformat(),
    }
    await websocket.send_text(json.dumps(initial_payload))

    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive_text(), timeout=25.0)
                parsed = {}
                try:
                    parsed = json.loads(message)
                except Exception:
                    parsed = {}
                if parsed.get("type") == "ping":
                    await websocket.send_text(
                        json.dumps({"type": "pong", "timestamp": datetime.now().isoformat()})
                    )
            except asyncio.TimeoutError:
                await websocket.send_text(
                    json.dumps({"type": "heartbeat", "timestamp": datetime.now().isoformat()})
                )
    except WebSocketDisconnect:
        logger.info("Compat websocket client disconnected")
        _ACTIVE_WS_CLIENTS.discard(websocket)
        return
    except Exception as exc:
        logger.warning("Compat websocket error: %s", exc)
        _ACTIVE_WS_CLIENTS.discard(websocket)
        return
