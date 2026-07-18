"""
TradingAgents Phase Definitions for Metro Flow

These phases reflect TradingAgents' actual internal architecture:
- Analysts (market, social, news, fundamentals)
- Researchers (bull/bear debate)
- Trader (synthesizes proposal)
- Risk (aggressive/conservative/neutral review)
- Risk Judge (final decision)

NOT the old 9-phase pipeline.
"""

from src.integrations.tradingagents_roster import TRADINGAGENTS_CANONICAL_AGENTS


TRADINGAGENTS_AGENTS = {
    agent["id"]: {
        "name": agent["display_name"],
        "portrait": f"/portraits/{agent['id']}.png",
        "role": agent["personality"],
    }
    for agent in TRADINGAGENTS_CANONICAL_AGENTS
}

# TradingAgents-native phases
TRADINGAGENTS_PHASES = [
    {
        "id": "analysts",
        "label": "ANALYSTS",
        "icon": "📊",
        "description": "Multi-analyst team analysis",
        "agents": ["market_analyst", "social_analyst", "news_analyst", "fundamentals_analyst"],
    },
    {
        "id": "researchers",
        "label": "RESEARCH",
        "icon": "⚖️",
        "description": "Bull/bear researcher debate",
        "agents": ["bull_researcher", "bear_researcher", "research_manager"],
    },
    {
        "id": "trader",
        "label": "TRADER",
        "icon": "📈",
        "description": "Trader synthesizes proposal",
        "agents": ["trader"],
    },
    {
        "id": "risk",
        "label": "RISK",
        "icon": "⚖️",
        "description": "Risk management review",
        "agents": ["aggressive_analyst", "conservative_analyst", "neutral_analyst", "risk_judge"],
    },
]

# Research depth presets (derive from backend-provided research_depth)
TRADINGAGENTS_PRESETS = {
    "quick": [
        "analysts",
        "researchers",
        "trader",
        "risk",
    ],
    "standard": [
        "analysts",
        "researchers",
        "trader",
        "risk",
    ],
    "deep": [
        "analysts",
        "researchers",
        "trader",
        "risk",
    ],
}


def get_visible_phases(research_depth: str) -> list:
    """Get phases to display for given research depth."""
    return TRADINGAGENTS_PRESETS.get(research_depth, TRADINGAGENTS_PRESETS["standard"])


def get_phase_metadata(phase_id: str) -> dict:
    """Get metadata for a phase."""
    for phase in TRADINGAGENTS_PHASES:
        if phase["id"] == phase_id:
            return phase
    return {}


def get_agent_metadata(agent_id: str) -> dict:
    """Get metadata for an agent."""
    return TRADINGAGENTS_AGENTS.get(agent_id, {})
