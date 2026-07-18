"""
TradingAgents + Original Pipeline - Unified Phase Configuration

CRITICAL: Two-layer system
==========================
Layer 1: pipeline_mode (original | tradingagents)
Layer 2: research_depth (quick | standard | deep)

Frontend NEVER guesses - backend drives everything via:
  - pipeline_mode
  - research_depth
  - phase
  - current_step

Usage:
  from src.integrations.pipeline_config import PIPELINE_CONFIG, get_visible_phases

  visible_phases = get_visible_phases(pipeline_mode, research_depth)
  # Returns: PIPELINE_CONFIG[pipeline_mode][research_depth]
"""

from src.integrations.tradingagents_roster import TRADINGAGENTS_CANONICAL_AGENTS


TA_AGENT_METADATA = {
    agent["id"]: {
        "name": agent["display_name"],
        "portrait": f"{agent['id']}.png",
        "role": agent["personality"],
    }
    for agent in TRADINGAGENTS_CANONICAL_AGENTS
}

TA_STATION_MAP = {
    agent["id"]: agent["station"] for agent in TRADINGAGENTS_CANONICAL_AGENTS
}

# =============================================================================
# PIPELINE CONFIG - TWO-LAYER SYSTEM
# =============================================================================

PIPELINE_CONFIG = {
    # =========================================================================
    # MODE 1: ORIGINAL 8-PHASE PIPELINE
    # =========================================================================
    "original": {
        "quick": [
            {"id": "regime", "label": "REGIME", "icon": "🌐", "steps": ["market regime"], "agents": ["regime_detector"]},
            {"id": "scout", "label": "SCOUT", "icon": "🔍", "steps": ["heuristic scan"], "agents": ["scout"]},
            {"id": "agents", "label": "AGENTS", "icon": "👥", "steps": ["technical", "fundamental"], "agents": ["Technical", "Fundamental"]},
            {"id": "oracle", "label": "ORACLE", "icon": "🔮", "steps": ["synthesis"], "agents": ["oracle"]},
            {"id": "portfolio", "label": "PORTFOLIO", "icon": "💰", "steps": ["execute"], "agents": ["portfolio_manager"]},
        ],
        "standard": [
            {"id": "regime", "label": "REGIME", "icon": "🌐", "steps": ["market regime"], "agents": ["regime_detector"]},
            {"id": "scout", "label": "SCOUT", "icon": "🔍", "steps": ["heuristic scan", "LLM ranking"], "agents": ["scout"]},
            {"id": "pre_mortem", "label": "PRE-MORTEM", "icon": "💭", "steps": ["scenario analysis", "veto check"], "agents": ["risk_analyst"]},
            {"id": "war_room", "label": "WAR ROOM", "icon": "🎯", "steps": ["macro context", "sentiment brief"], "agents": ["macro", "sentiment"]},
            {"id": "agents", "label": "AGENTS", "icon": "👥", "steps": ["technical", "fundamental", "sentiment", "news", "risk", "growth", "value", "momentum", "contrarian", "macro"], "agents": ["Warren", "Charlie", "Technical", "Fundamental", "Sentiment", "Risk", "Momentum", "Value", "Growth", "Contrarian"]},
            {"id": "inquisition", "label": "INQUISITION", "icon": "⚖️", "steps": ["vote counting", "consensus check"], "agents": []},
            {"id": "oracle", "label": "ORACLE", "icon": "🔮", "steps": ["synthesis", "regime weights", "conviction scoring"], "agents": ["oracle"]},
            {"id": "portfolio", "label": "PORTFOLIO", "icon": "💰", "steps": ["risk checks", "execute", "log lesson"], "agents": ["portfolio_manager"]},
        ],
        "deep": [
            {"id": "regime", "label": "REGIME", "icon": "🌐", "steps": ["market regime", "macro context"], "agents": ["regime_detector"]},
            {"id": "scout", "label": "SCOUT", "icon": "🔍", "steps": ["heuristic scan", "LLM ranking", "deep filter"], "agents": ["scout"]},
            {"id": "pre_mortem", "label": "PRE-MORTEM", "icon": "💭", "steps": ["scenario analysis", "veto check", "risk assessment"], "agents": ["risk_analyst"]},
            {"id": "war_room", "label": "WAR ROOM", "icon": "🎯", "steps": ["macro context", "sentiment brief", "sector analysis"], "agents": ["macro", "sentiment"]},
            {"id": "agents", "label": "AGENTS", "icon": "👥", "steps": ["technical", "fundamental", "sentiment", "news", "risk", "growth", "value", "momentum", "contrarian", "macro", "activist", "valuation"], "agents": ["Warren", "Charlie", "Technical", "Fundamental", "Sentiment", "Risk", "Momentum", "Value", "Growth", "Contrarian", "Activist", "Valuation"]},
            {"id": "inquisition", "label": "INQUISITION", "icon": "⚖️", "steps": ["vote counting", "consensus check", "dissenter ID"], "agents": []},
            {"id": "oracle", "label": "ORACLE", "icon": "🔮", "steps": ["synthesis", "regime weights", "conviction scoring", "kelly sizing"], "agents": ["oracle"]},
            {"id": "portfolio", "label": "PORTFOLIO", "icon": "💰", "steps": ["risk checks", "execute", "log lesson", "cleanup"], "agents": ["portfolio_manager"]},
        ],
    },

    # =========================================================================
    # MODE 2: TRADINGAGENTS PIPELINE (NATIVE PHASES)
    # =========================================================================
    "tradingagents": {
        "quick": [
            {"id": "analysts", "label": "ANALYSTS", "icon": "📊", "station": "scanner", "agents": ["market_analyst", "social_analyst", "news_analyst", "fundamentals_analyst"], "steps": ["market", "social", "news", "fundamentals"], "llm_calls": 4, "description": "Canonical analyst team"},
            {"id": "researchers", "label": "RESEARCH", "icon": "⚖️", "station": "table", "agents": ["bull_researcher", "bear_researcher", "research_manager"], "steps": ["bull case", "bear case", "synthesis"], "llm_calls": 3, "description": "Bull/bear debate + research synthesis"},
            {"id": "trader", "label": "TRADER", "icon": "📈", "station": "ticker", "agents": ["trader"], "steps": ["trade construction"], "llm_calls": 1, "description": "Trader converts research into a plan"},
            {"id": "risk", "label": "RISK", "icon": "⚖️", "station": "tv", "agents": ["aggressive_analyst", "conservative_analyst", "neutral_analyst", "risk_judge"], "steps": ["aggressive case", "conservative case", "neutral case", "risk decision"], "llm_calls": 4, "description": "Canonical risk team"},
        ],
        "standard": [
            {"id": "analysts", "label": "ANALYSTS", "icon": "📊", "station": "scanner", "agents": ["market_analyst", "social_analyst", "news_analyst", "fundamentals_analyst"], "steps": ["market", "social", "news", "fundamentals"], "llm_calls": 4, "description": "Canonical analyst team"},
            {"id": "researchers", "label": "RESEARCH", "icon": "⚖️", "station": "table", "agents": ["bull_researcher", "bear_researcher", "research_manager"], "steps": ["bull case", "bear case", "synthesis"], "llm_calls": 3, "description": "Bull/bear debate + research synthesis"},
            {"id": "trader", "label": "TRADER", "icon": "📈", "station": "ticker", "agents": ["trader"], "steps": ["trade construction"], "llm_calls": 1, "description": "Trader converts research into a plan"},
            {"id": "risk", "label": "RISK", "icon": "⚖️", "station": "tv", "agents": ["aggressive_analyst", "conservative_analyst", "neutral_analyst", "risk_judge"], "steps": ["aggressive case", "conservative case", "neutral case", "risk decision"], "llm_calls": 4, "description": "Canonical risk team"},
        ],
        "deep": [
            {"id": "analysts", "label": "ANALYSTS", "icon": "📊", "station": "scanner", "agents": ["market_analyst", "social_analyst", "news_analyst", "fundamentals_analyst"], "steps": ["market", "social", "news", "fundamentals"], "llm_calls": 4, "description": "Canonical analyst team"},
            {"id": "researchers", "label": "RESEARCH", "icon": "⚖️", "station": "table", "agents": ["bull_researcher", "bear_researcher", "research_manager"], "steps": ["bull case", "bear case", "synthesis"], "llm_calls": 3, "description": "Bull/bear debate + research synthesis"},
            {"id": "trader", "label": "TRADER", "icon": "📈", "station": "ticker", "agents": ["trader"], "steps": ["trade construction"], "llm_calls": 1, "description": "Trader converts research into a plan"},
            {"id": "risk", "label": "RISK", "icon": "⚖️", "station": "tv", "agents": ["aggressive_analyst", "conservative_analyst", "neutral_analyst", "risk_judge"], "steps": ["aggressive case", "conservative case", "neutral case", "risk decision"], "llm_calls": 4, "description": "Canonical risk team"},
        ],
    },
}


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def get_visible_phases(pipeline_mode: str, research_depth: str = None) -> list:
    """
    Get visible phases for given pipeline mode and research depth.
    
    MANDATORY: Backend drives everything. Frontend NEVER guesses.
    
    Args:
        pipeline_mode: "original" | "tradingagents"
        research_depth: "quick" | "standard" | "deep"
    
    Returns:
        Array of phase definitions
    """
    # Validate pipeline_mode
    if pipeline_mode not in PIPELINE_CONFIG:
        pipeline_mode = "original"
    
    # Validate research_depth
    if research_depth not in PIPELINE_CONFIG[pipeline_mode]:
        research_depth = "standard"
    
    return PIPELINE_CONFIG[pipeline_mode][research_depth]


def get_phase_metadata(phase_id: str, pipeline_mode: str, research_depth: str = None) -> dict:
    """Get metadata for a specific phase."""
    phases = get_visible_phases(pipeline_mode, research_depth)
    for phase in phases:
        if phase["id"] == phase_id:
            return phase
    return {}


def get_agent_metadata(agent_id: str) -> dict:
    """Get metadata for an agent."""
    
    agent_metadata = {
        # Original agents
        "regime_detector": {"name": "Regime Detector", "portrait": "regime.png", "role": "Market regime classification"},
        "scout": {"name": "Scout", "portrait": "scout.png", "role": "Stock scanning and ranking"},
        "macro": {"name": "Macro Analyst", "portrait": "macro.png", "role": "Macro economic context"},
        "sentiment": {"name": "Sentiment Analyst", "portrait": "sentiment.png", "role": "Social/news sentiment"},
        "Warren": {"name": "Warren", "portrait": "warren.png", "role": "Value investing"},
        "Charlie": {"name": "Charlie", "portrait": "charlie.png", "role": "Conglomerate analysis"},
        "Technical": {"name": "Technical Analyst", "portrait": "technical.png", "role": "Price patterns and indicators"},
        "Fundamental": {"name": "Fundamental Analyst", "portrait": "fundamental.png", "role": "Financial statement analysis"},
        "Risk": {"name": "Risk Analyst", "portrait": "risk.png", "role": "Risk assessment"},
        "Momentum": {"name": "Momentum Trader", "portrait": "momentum.png", "role": "Trend following"},
        "Value": {"name": "Value Investor", "portrait": "value.png", "role": "Intrinsic value"},
        "Growth": {"name": "Growth Investor", "portrait": "growth.png", "role": "Growth potential"},
        "Contrarian": {"name": "Contrarian", "portrait": "contrarian.png", "role": "Opposite thinking"},
        "oracle": {"name": "Oracle", "portrait": "oracle.png", "role": "Final synthesis"},
        "portfolio_manager": {"name": "Portfolio Manager", "portrait": "pm.png", "role": "Final decision"},
        
        # TradingAgents agents
        **TA_AGENT_METADATA,
    }
    
    return agent_metadata.get(agent_id, {"name": agent_id, "portrait": "default.png", "role": "Unknown"})


def get_station_for_agent(agent_id: str) -> str:
    """Map agent to station for Metro Flow."""
    
    station_map = {
        # Original agents
        "regime_detector": "scanner",
        "scout": "scanner",
        "Technical": "scanner",
        "Momentum": "scanner",
        "Warren": "desk",
        "Charlie": "desk",
        "Fundamental": "desk",
        "Value": "desk",
        "Growth": "desk",
        "macro": "tv",
        "sentiment": "tv",
        "Risk": "tv",
        "Contrarian": "cooler",
        "oracle": "table",
        "portfolio_manager": "desk",
        
        # TradingAgents agents
        **TA_STATION_MAP,
    }
    
    return station_map.get(agent_id, "desk")


# =============================================================================
# SCENE AGENT MAP FOR SHOWRUNNER
# =============================================================================

SCENE_AGENT_MAP = {
    # Original pipeline scenes
    "original_regime": ["regime_detector"],
    "original_scout": ["scout"],
    "original_pre_mortem": ["risk_analyst"],
    "original_war_room": ["macro", "sentiment"],
    "original_agents": ["Warren", "Charlie", "Technical", "Fundamental", "Sentiment", "Risk", "Momentum", "Value", "Growth", "Contrarian"],
    "original_inquisition": [],  # No specific agents, all at table
    "original_oracle": ["oracle"],
    "original_portfolio": ["portfolio_manager"],
    
    # TradingAgents quick scenes
    "tradingagents_quick_analysts": ["market_analyst", "social_analyst", "news_analyst", "fundamentals_analyst"],
    "tradingagents_quick_debate": ["bull_researcher", "bear_researcher", "research_manager"],
    "tradingagents_quick_trader": ["trader"],
    "tradingagents_quick_risk": ["aggressive_analyst", "conservative_analyst", "neutral_analyst", "risk_judge"],
    
    # TradingAgents standard scenes
    "tradingagents_standard_analysts": ["market_analyst", "social_analyst", "news_analyst", "fundamentals_analyst"],
    "tradingagents_standard_debate": ["bull_researcher", "bear_researcher", "research_manager"],
    "tradingagents_standard_trader": ["trader"],
    "tradingagents_standard_risk": ["aggressive_analyst", "conservative_analyst", "neutral_analyst", "risk_judge"],
    
    # TradingAgents deep scenes
    "tradingagents_deep_analysts": ["market_analyst", "social_analyst", "news_analyst", "fundamentals_analyst"],
    "tradingagents_deep_debate": ["bull_researcher", "bear_researcher", "research_manager"],
    "tradingagents_deep_trader": ["trader"],
    "tradingagents_deep_risk": ["aggressive_analyst", "conservative_analyst", "neutral_analyst", "risk_judge"],
}


# =============================================================================
# EXAMPLE USAGE
# =============================================================================

if __name__ == "__main__":
    print("="*80)
    print("PIPELINE CONFIG - TWO-LAYER SYSTEM")
    print("="*80)
    
    # Example 1: Get original pipeline phases
    print("\n1. ORIGINAL PIPELINE (standard):")
    original_phases = get_visible_phases("original", "standard")
    for phase in original_phases:
        print(f"  {phase['icon']} {phase['label']}: {phase['steps']}")
    
    # Example 2: Get TradingAgents quick phases
    print("\n2. TRADINGAGENTS QUICK:")
    quick_phases = get_visible_phases("tradingagents", "quick")
    for phase in quick_phases:
        print(f"  {phase['icon']} {phase['label']}: {phase['steps']}")
    
    # Example 3: Get TradingAgents standard phases
    print("\n3. TRADINGAGENTS STANDARD:")
    standard_phases = get_visible_phases("tradingagents", "standard")
    for phase in standard_phases:
        print(f"  {phase['icon']} {phase['label']}: {phase['steps']}")
    
    # Example 4: Get TradingAgents deep phases
    print("\n4. TRADINGAGENTS DEEP:")
    deep_phases = get_visible_phases("tradingagents", "deep")
    for phase in deep_phases:
        print(f"  {phase['icon']} {phase['label']}: {phase['steps']}")
    
    # Example 5: Get agent metadata
    print("\n5. AGENT METADATA:")
    agent = get_agent_metadata("bull_researcher")
    print(f"  {agent['name']}: {agent['role']}")
    
    # Example 6: Get station for agent
    print("\n6. AGENT STATION:")
    station = get_station_for_agent("trader")
    print(f"  trader -> {station}")
