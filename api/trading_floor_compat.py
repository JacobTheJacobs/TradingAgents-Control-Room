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


def _flow_state_payload() -> Dict[str, Any]:
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


@router.get("/state")
async def get_state():
    return {
        "agent_states": agent_states,
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
    initial_payload = {
        "type": "initial_state",
        "agents": agent_states,
        "schedule": {"phase": "closed", "market_open": False},
        "pipeline_state": _flow_state_payload(),
        "pipeline_scenes": {},
        "agent_behavior_defaults": {},
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
