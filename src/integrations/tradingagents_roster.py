"""
Canonical TradingAgents roster and UI mappings.

This module is the single source of truth for the TradingAgents 12-agent setup
used by the v3 admin / trading-floor UI.
"""

from __future__ import annotations

from typing import Dict, List, Optional


TRADINGAGENTS_CANONICAL_AGENTS: List[Dict] = [
    {
        "id": "market_analyst",
        "display_name": "Market Analyst",
        "short_label": "Market",
        "station": "scanner",
        "color": "#9370DB",
        "personality": "Tracks price action, structure, and technical momentum.",
        "position": {"x": 112, "y": 96},
        "aliases": ["Market", "market", "market analyst", "market_analyst"],
    },
    {
        "id": "social_analyst",
        "display_name": "Social Analyst",
        "short_label": "Social",
        "station": "cooler",
        "color": "#1E90FF",
        "personality": "Reads crowd psychology, meme flow, and retail sentiment.",
        "position": {"x": 272, "y": 96},
        "aliases": ["Social", "social", "social analyst", "social_analyst"],
    },
    {
        "id": "news_analyst",
        "display_name": "News Analyst",
        "short_label": "News",
        "station": "newsstand",
        "color": "#4ECDC4",
        "personality": "Monitors breaking headlines, filings, and catalysts.",
        "position": {"x": 496, "y": 96},
        "aliases": ["News", "news", "news analyst", "news_analyst"],
    },
    {
        "id": "fundamentals_analyst",
        "display_name": "Fundamentals Analyst",
        "short_label": "Fundamentals",
        "station": "desk",
        "color": "#BA55D3",
        "personality": "Underwrites balance sheet quality and valuation.",
        "position": {"x": 208, "y": 192},
        "aliases": ["Fundamentals", "fundamental", "fundamentals analyst", "fundamentals_analyst"],
    },
    {
        "id": "bull_researcher",
        "display_name": "Bull Researcher",
        "short_label": "Bull",
        "station": "table",
        "color": "#F8B500",
        "personality": "Builds the strongest upside case.",
        "position": {"x": 400, "y": 192},
        "aliases": ["Bull", "bull", "bull researcher"],
    },
    {
        "id": "bear_researcher",
        "display_name": "Bear Researcher",
        "short_label": "Bear",
        "station": "table",
        "color": "#FF4500",
        "personality": "Builds the strongest downside case.",
        "position": {"x": 432, "y": 192},
        "aliases": ["Bear", "bear", "bear researcher"],
    },
    {
        "id": "research_manager",
        "display_name": "Research Manager",
        "short_label": "RM",
        "station": "table",
        "color": "#32CD32",
        "personality": "Synthesizes the debate.",
        "position": {"x": 496, "y": 288},
        "aliases": ["RM", "research manager", "research_manager"],
    },
    {
        "id": "trader",
        "display_name": "Trader",
        "short_label": "Trader",
        "station": "ticker",
        "color": "#7851A9",
        "personality": "Turns research into a concrete trade plan.",
        "position": {"x": 272, "y": 176},
        "aliases": ["Trader", "trader"],
    },
    {
        "id": "aggressive_analyst",
        "display_name": "Aggressive Analyst",
        "short_label": "Aggr",
        "station": "desk",
        "color": "#FF0000",
        "personality": "Favors high-growth, high-risk momentum.",
        "position": {"x": 240, "y": 192},
        "aliases": ["Aggr", "aggressive", "aggressive analyst"],
    },
    {
        "id": "conservative_analyst",
        "display_name": "Conservative Analyst",
        "short_label": "Cons",
        "station": "desk",
        "color": "#0000FF",
        "personality": "Prioritizes capital preservation and yield.",
        "position": {"x": 176, "y": 192},
        "aliases": ["Cons", "conservative", "conservative analyst"],
    },
    {
        "id": "neutral_analyst",
        "display_name": "Neutral Analyst",
        "short_label": "Neutral",
        "station": "desk",
        "color": "#808080",
        "personality": "Evaluates balanced index-like exposure.",
        "position": {"x": 144, "y": 288},
        "aliases": ["Neutral", "neutral analyst"],
    },
    {
        "id": "risk_judge",
        "display_name": "Risk Judge",
        "short_label": "Judge",
        "station": "ticker",
        "color": "#B22222",
        "personality": "Final gatekeeper for portfolio concentration and risk caps.",
        "position": {"x": 304, "y": 176},
        "aliases": ["Judge", "risk judge", "risk_judge"],
    },
]


TRADINGAGENTS_AGENT_BY_ID: Dict[str, Dict] = {
    agent["id"]: agent for agent in TRADINGAGENTS_CANONICAL_AGENTS
}

TRADINGAGENTS_AGENT_IDS: List[str] = [agent["id"] for agent in TRADINGAGENTS_CANONICAL_AGENTS]
TRADINGAGENTS_AGENT_DISPLAY_NAMES: List[str] = [
    agent["display_name"] for agent in TRADINGAGENTS_CANONICAL_AGENTS
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

TRADINGAGENTS_PHASE_NUMBERS: Dict[str, int] = {
    "market_analyst": 1,
    "social_analyst": 1,
    "news_analyst": 1,
    "fundamentals_analyst": 1,
    "bull_researcher": 2,
    "bear_researcher": 2,
    "research_manager": 2,
    "trader": 3,
    "aggressive_analyst": 4,
    "conservative_analyst": 4,
    "neutral_analyst": 4,
    "risk_judge": 5,
}


def normalize_tradingagents_agent_id(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None

    raw = str(value).strip()
    if not raw:
        return None

    lowered = raw.lower().replace("-", "_").replace(" ", "_")

    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        if lowered == agent["id"]:
            return agent["id"]
        if lowered == agent["display_name"].lower().replace(" ", "_"):
            return agent["id"]
        if lowered == agent["short_label"].lower().replace(" ", "_"):
            return agent["id"]
        for alias in agent["aliases"]:
            alias_key = str(alias).strip().lower().replace("-", "_").replace(" ", "_")
            if lowered == alias_key:
                return agent["id"]

    return None


def normalize_tradingagents_agent_name(value: Optional[str]) -> Optional[str]:
    agent_id = normalize_tradingagents_agent_id(value)
    if not agent_id:
        return None
    return TRADINGAGENTS_AGENT_BY_ID[agent_id]["display_name"]


def build_tradingagents_canvas_agents(canvas_config: Optional[Dict] = None) -> Dict[str, Dict]:
    canvas_config = canvas_config or {}
    agents: Dict[str, Dict] = {}

    for agent in TRADINGAGENTS_CANONICAL_AGENTS:
        canvas_info = canvas_config.get(agent["id"], {})
        agents[agent["id"]] = {
            "name": agent["id"],
            "displayName": agent["display_name"],
            "shortLabel": agent["short_label"],
            "personality": agent["personality"],
            "position": canvas_info.get("position", agent["position"]),
            "color": canvas_info.get("color", agent["color"]),
            "active": canvas_info.get("active", True),
            "provider": "tradingagents",
            "model": None,
            "station": agent["station"],
            "aliases": agent["aliases"],
        }

    return agents


def build_tradingagents_ui_states() -> Dict[str, Dict]:
    return {
        agent["display_name"]: {
            "status": "idle",
            "decision": None,
            "confidence": None,
            "ticker": None,
            "reasoning": None,
            "station": agent["station"],
        }
        for agent in TRADINGAGENTS_CANONICAL_AGENTS
    }
