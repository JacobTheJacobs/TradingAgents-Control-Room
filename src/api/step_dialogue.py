"""
Step Dialogue Endpoint - LLM-generated dialogue for pipeline phases.

Generates step-specific dialogue scripts for the trading floor animation system.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.llm.client import get_llm_client
from src.llm.scene_generator import load_agent_personalities, load_scriptwriter_config

try:
    from src.runtime.finance_db_client import fetch_news as runtime_fetch_news
except Exception:
    runtime_fetch_news = None

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/step-dialogue", tags=["step-dialogue"])


# Step scene configurations (mirrors `src/v3/react-app/src/config/stepScenes.js`)
STEP_SCENES = {
    "STEP_1_ANALYSTS": {
        "phase": 1,
        "name": "Analyst Team",
        "agents": ["Market Analyst", "Social Analyst", "News Analyst", "Fundamentals Analyst"],
        "system_prompt": """You are writing dialogue for the Analyst Team scene.
Market Analyst reviews price action and structure.
Social Analyst reads crowd psychology and retail positioning.
News Analyst scans catalysts, filings, and headline risk.
Fundamentals Analyst checks business quality, valuation, and earnings durability.
Keep lines short, crisp, and role-specific.""",
    },
    "STEP_2_RESEARCH": {
        "phase": 2,
        "name": "Research Team",
        "agents": ["Bull Researcher", "Bear Researcher", "Research Manager"],
        "system_prompt": """You are writing dialogue for the Research Team scene.
Bull Researcher makes the upside case, Bear Researcher attacks the thesis, and Research Manager synthesizes.
Keep lines short and adversarial but useful.""",
    },
    "STEP_3_TRADER": {
        "phase": 3,
        "name": "Trader",
        "agents": ["Trader"],
        "system_prompt": """You are writing dialogue for the Trader scene.
The Trader is turning research into a concrete trade setup, entry, and sizing plan.
Keep it specific and concise.""",
    },
    "STEP_4_RISK": {
        "phase": 4,
        "name": "Risk Management",
        "agents": ["Aggressive Analyst", "Conservative Analyst", "Neutral Analyst"],
        "system_prompt": """You are writing dialogue for the Risk Management scene.
Aggressive Analyst pushes for upside capture, Conservative Analyst defends downside protection, and Neutral Analyst balances the tradeoff.
Keep the dialogue sharp, short, and decision-oriented.""",
    },
    "STEP_5_PORTFOLIO": {
        "phase": 5,
        "name": "Portfolio Management",
        "agents": ["Risk Judge"],
        "system_prompt": """You are writing dialogue for the Portfolio Management scene.
Risk Judge is acting as the portfolio manager and delivering the final portfolio call.
Keep it concise, final, and high-conviction.""",
    },
}

# Phase order for full script generation
PHASE_ORDER = [key for key, _ in sorted(STEP_SCENES.items(), key=lambda item: item[1].get("phase", 0))]

# Agent personalities for scriptwriting context
AGENT_PERSONALITIES = load_agent_personalities()


def _normalize_phase_key(phase: str) -> str:
    return phase.upper().replace("-", "_").strip()


def _sanitize_text(value: str, max_len: int = 220) -> str:
    text = (value or "").replace("\n", " ").replace("\r", " ").strip()
    if len(text) > max_len:
        return text[: max_len - 3].rstrip() + "..."
    return text


def _normalize_news_items(raw: Any, limit: int = 5) -> List[Dict[str, Any]]:
    if not raw:
        return []

    items = []
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        for key in ("articles", "news", "results", "data", "items"):
            if isinstance(raw.get(key), list):
                items = raw.get(key)
                break

    if not items:
        return []

    normalized = []
    seen_titles = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        title = item.get("title") or item.get("headline") or item.get("text") or ""
        title = title.strip()
        if not title or title in seen_titles:
            continue
        seen_titles.add(title)

        sentiment = item.get("weighted_sentiment", item.get("sentiment", 0))
        if isinstance(sentiment, dict):
            sentiment = sentiment.get("score", 0)

        normalized.append({
            "title": _sanitize_text(title, 160),
            "source": item.get("source") or item.get("publisher") or item.get("provider") or "Unknown",
            "url": item.get("url") or item.get("link") or "",
            "published": item.get("published") or item.get("published_at") or item.get("date") or "",
            "sentiment": sentiment or 0,
            "summary": _sanitize_text(item.get("summary") or item.get("description") or "", 220),
        })

        if len(normalized) >= limit:
            break

    return normalized


async def _fetch_ticker_news(ticker: Optional[str], limit: int = 5) -> List[Dict[str, Any]]:
    if not ticker:
        return []

    news_data = None
    if runtime_fetch_news is not None:
        try:
            news_data = await runtime_fetch_news(ticker, limit=limit)
        except Exception:
            news_data = None

    normalized = _normalize_news_items(news_data, limit=limit)
    if normalized:
        return normalized

    # Fallback to yfinance if finance_db_api is unavailable
    try:
        import yfinance as yf
        fallback_items = yf.Ticker(ticker).news
        return _normalize_news_items(fallback_items, limit=limit)
    except Exception:
        return []


def _build_full_script_prompt(
    ticker: Optional[str],
    regime: Optional[str],
    news: List[Dict[str, Any]],
    agent_decisions: Optional[Dict[str, Any]] = None,
    action: Optional[str] = None,
    confidence: Optional[float] = None,
) -> str:
    agent_lines = "\n".join(
        f"- {name}: {desc}" for name, desc in AGENT_PERSONALITIES.items()
    )

    news_lines = "\n".join(
        f"- {item.get('title')} ({item.get('source', 'Unknown')})"
        for item in news
    ) or "- No major headlines found."

    phase_lines = []
    for key in PHASE_ORDER:
        scene = STEP_SCENES.get(key, {})
        agents = ", ".join(scene.get("agents", []))
        guidance = scene.get("system_prompt", "").strip().replace("\n", " ")
        phase_lines.append(f"{key}: {scene.get('name', key)} | Agents: {agents} | Guidance: {guidance}")

    context_parts = [
        f"Ticker: {ticker or 'UNKNOWN'}",
        f"Market Regime: {regime or 'UNKNOWN'}",
    ]
    if action:
        context_parts.append(f"Risk Decision: {action}")
    if confidence is not None:
        context_parts.append(f"Decision Confidence: {confidence:.0%}")
    if agent_decisions:
        decisions_str = ", ".join(
            f"{k}: {v.get('action', 'N/A')}"
            for k, v in agent_decisions.items()
            if isinstance(v, dict)
        )
        if decisions_str:
            context_parts.append(f"Agent Decisions: {decisions_str}")

    context = "\n".join(context_parts)
    phase_block = "\n".join(phase_lines)

    return f"""{context}

News headlines:
{news_lines}

Agent personalities:
{agent_lines}

Write a full 5-step trading floor script. Each step must contain 2-4 total dialogue lines.
Each line should be 1-2 short sentences, punchy, and in-character.
Use ONLY the allowed agent names for each phase.

Phase requirements:
{phase_block}

Return ONLY valid JSON, no markdown, no extra keys, using this structure:
- phases: object
- STEP_1_ANALYSTS/STEP_2_RESEARCH/STEP_3_TRADER/STEP_4_RISK/STEP_5_PORTFOLIO: each has headline + dialogue
- dialogue: array of objects with agent and text fields
"""


def _validate_full_script(result: Any, ticker: Optional[str], action: Optional[str]) -> Dict[str, Any]:
    phases_payload = {}
    if isinstance(result, dict):
        phases_payload = result.get("phases", result)

    if not isinstance(phases_payload, dict):
        phases_payload = {}

    script: Dict[str, Any] = {}

    for key in PHASE_ORDER:
        scene = STEP_SCENES.get(key, {})
        allowed_agents = set(scene.get("agents", []))
        if "all" in allowed_agents:
            allowed_agents = set(AGENT_PERSONALITIES.keys())

        raw_phase = None
        for phase_key, phase_val in phases_payload.items():
            if _normalize_phase_key(phase_key) == key:
                raw_phase = phase_val
                break

        dialogue_raw = []
        headline = scene.get("name", key)

        if isinstance(raw_phase, dict):
            headline = raw_phase.get("headline") or headline
            dialogue_raw = raw_phase.get("dialogue") or raw_phase.get("lines") or []
        elif isinstance(raw_phase, list):
            dialogue_raw = raw_phase

        validated_lines = []
        for line in dialogue_raw:
            if not isinstance(line, dict):
                continue
            agent = line.get("agent") or line.get("speaker") or ""
            agent = agent.strip()
            text = line.get("text") or line.get("line") or ""
            text = _sanitize_text(text, 200)
            if not agent or not text:
                continue
            if allowed_agents and agent not in allowed_agents:
                continue
            validated_lines.append({"agent": agent, "text": text})
            if len(validated_lines) >= 6:
                break

        if not validated_lines:
            fallback = get_fallback_dialogue(key, ticker, action)
            validated_lines = [{"agent": d["agent"], "text": d["text"]} for d in fallback]

        script[key] = {
            "headline": _sanitize_text(headline, 80),
            "dialogue": validated_lines,
        }

    return script


async def generate_full_step_script(
    ticker: Optional[str],
    regime: Optional[str],
    cycle: Optional[int] = None,
    agent_decisions: Optional[Dict[str, Any]] = None,
    action: Optional[str] = None,
    confidence: Optional[float] = None,
    news: Optional[List[Dict[str, Any]]] = None,
    llm_enabled: bool = True,
    provider_override: Optional[str] = None,
    model_override: Optional[str] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    news_items = news if news is not None else await _fetch_ticker_news(ticker)
    script_id = str(uuid4())
    generated_at = datetime.now().isoformat()

    meta = {
        "script_id": script_id,
        "generated_at": generated_at,
        "ticker": ticker,
        "regime": regime,
        "cycle": cycle,
        "news": news_items,
    }

    config = load_scriptwriter_config()
    provider = provider_override or config.get("provider")
    model = model_override or config.get("model")
    if not llm_enabled or not config.get("enabled", True):
        meta["source"] = "fallback"
        return _validate_full_script({}, ticker, action), meta

    prompt = _build_full_script_prompt(
        ticker=ticker,
        regime=regime,
        news=news_items,
        agent_decisions=agent_decisions,
        action=action,
        confidence=confidence,
    )

    try:
        llm = get_llm_client()
        result = await llm.generate_json(
            prompt=prompt,
            system_prompt="You are a professional trading floor scriptwriter. Output JSON only.",
            provider=provider,
            model=model,
        )
        meta["source"] = "llm"
        meta["llm_provider"] = provider
        meta["llm_model"] = model
        return _validate_full_script(result, ticker, action), meta
    except Exception as e:
        logger.warning(f"Full step script generation failed: {e}")
        meta["source"] = "fallback"
        meta["error"] = str(e)
        return _validate_full_script({}, ticker, action), meta


class StepDialogueRequest(BaseModel):
    """Request model for step dialogue generation."""
    step: str
    ticker: Optional[str] = None
    regime: Optional[str] = None
    agent_decisions: Optional[Dict[str, Any]] = None
    action: Optional[str] = None  # BUY, SELL, HOLD
    confidence: Optional[float] = None


class StepScriptRequest(BaseModel):
    """Request model for full step script generation."""
    ticker: Optional[str] = None
    regime: Optional[str] = None
    cycle: Optional[int] = None
    agent_decisions: Optional[Dict[str, Any]] = None
    action: Optional[str] = None
    confidence: Optional[float] = None
    news: Optional[List[Dict[str, Any]]] = None


class DialogueLine(BaseModel):
    """Single dialogue line from an agent."""
    agent: str
    text: str


class StepDialogueResponse(BaseModel):
    """Response model for step dialogue."""
    step: str
    headline: str
    dialogue: List[DialogueLine]


class StepScriptPhase(BaseModel):
    """Phase-level script block."""
    headline: str
    dialogue: List[DialogueLine]


class StepScriptEnvelope(BaseModel):
    """Response model for full step script."""
    script: Dict[str, StepScriptPhase]
    meta: Dict[str, Any]


def get_fallback_dialogue(step: str, ticker: str = None, action: str = None) -> List[Dict[str, str]]:
    """Generate fallback dialogue when LLM is unavailable."""
    step_upper = step.upper().replace("-", "_")
    
    fallbacks = {
        "STEP_1_ANALYSTS": [
            {"agent": "Market Analyst", "text": f"{ticker or 'This ticker'} is testing structure. I want confirmation through key levels."},
            {"agent": "Social Analyst", "text": "Retail chatter is loud, but conviction still needs filtering."},
            {"agent": "News Analyst", "text": "Headline flow is active. The catalyst path matters more than the noise."},
            {"agent": "Fundamentals Analyst", "text": "The business quality holds up, but valuation still decides the upside."},
        ],
        "STEP_2_RESEARCH": [
            {"agent": "Bull Researcher", "text": "Upside is there if execution stays clean and the market pays for the story."},
            {"agent": "Bear Researcher", "text": "If the story cracks, downside can move faster than the upside."},
            {"agent": "Research Manager", "text": "Good. Keep the edge cases, drop the fluff, and tighten the thesis."},
        ],
        "STEP_3_TRADER": [
            {"agent": "Trader", "text": "I can build the trade, but entry, size, and invalidation need to stay disciplined."},
        ],
        "STEP_4_RISK": [
            {"agent": "Aggressive Analyst", "text": "There is edge here if we size into the upside fast."},
            {"agent": "Conservative Analyst", "text": "Then cap the downside first. No trade survives bad sizing."},
            {"agent": "Neutral Analyst", "text": "Balance conviction against cash, concentration, and what can still go wrong."},
        ],
        "STEP_5_PORTFOLIO": [
            {"agent": "Risk Judge", "text": f"Understood. Current risk call is {action or 'HOLD'} until the setup improves."},
        ],
    }
    
    return fallbacks.get(step_upper, [
        {"agent": "Risk Judge", "text": "Proceed, but keep the reasoning tight."},
    ])


@router.post("", response_model=StepDialogueResponse)
async def generate_step_dialogue(request: StepDialogueRequest):
    """
    Generate dialogue script for a pipeline step.
    
    Uses LLM to generate contextual dialogue based on:
    - Current pipeline phase
    - Ticker being analyzed
    - Market regime
    - Agent decisions from analysis
    """
    step = request.step.upper().replace("-", "_")
    
    # Get scene configuration
    scene = STEP_SCENES.get(step)
    if not scene:
        raise HTTPException(status_code=400, detail=f"Unknown step: {request.step}")
    
    # Build context for LLM
    context_parts = [f"Current Phase: {scene['name']}"]
    if request.ticker:
        context_parts.append(f"Ticker: {request.ticker}")
    if request.regime:
        context_parts.append(f"Market Regime: {request.regime}")
    if request.action:
        context_parts.append(f"Decision: {request.action}")
    if request.confidence is not None:
        context_parts.append(f"Confidence: {request.confidence:.0%}")
    if request.agent_decisions:
        decisions_str = ", ".join(
            f"{k}: {v.get('action', 'N/A')}" 
            for k, v in request.agent_decisions.items() 
            if isinstance(v, dict)
        )
        if decisions_str:
            context_parts.append(f"Agent Decisions: {decisions_str}")
    
    context = "\n".join(context_parts)
    agents_list = ", ".join(scene["agents"])
    
    prompt = f"""{context}

Write dialogue for this trading floor scene. Each agent should speak 1-2 lines.
Available agents for this phase: {agents_list}

Return a JSON array of dialogue lines in this exact format:
[{{"agent": "AgentName", "text": "Their dialogue line"}}]

Example:
[{{"agent": "Market Analyst", "text": "Price is coiling into a clean decision point."}}, {{"agent": "Risk Judge", "text": "Then define the downside before you touch size."}}]

Now generate the dialogue:"""

    try:
        llm = get_llm_client()
        result = await llm.generate_json(
            prompt=prompt,
            system_prompt=scene["system_prompt"],
        )
        
        # Handle different response formats
        dialogue = []
        if isinstance(result, dict):
            if "dialogue" in result:
                dialogue = result["dialogue"]
            elif "lines" in result:
                dialogue = result["lines"]
            else:
                # Try to find any array in the response
                for key, value in result.items():
                    if isinstance(value, list):
                        dialogue = value
                        break
                else:
                    dialogue = [result]
        elif isinstance(result, list):
            dialogue = result
        
        # Validate dialogue format
        validated = []
        for line in dialogue:
            if isinstance(line, dict) and "agent" in line and "text" in line:
                validated.append(DialogueLine(agent=line["agent"], text=line["text"]))
        
        if not validated:
            raise ValueError("No valid dialogue lines in LLM response")
        
        logger.info(f"Generated {len(validated)} dialogue lines for step {step}")
        
        return StepDialogueResponse(
            step=request.step,
            headline=scene["name"],
            dialogue=validated,
        )
        
    except Exception as e:
        logger.warning(f"LLM dialogue generation failed for step {step}: {e}")
        
        # Fall back to static dialogue
        fallback = get_fallback_dialogue(step, request.ticker, request.action)
        dialogue = [DialogueLine(agent=d["agent"], text=d["text"]) for d in fallback]
        
        return StepDialogueResponse(
            step=request.step,
            headline=scene["name"],
            dialogue=dialogue,
        )


@router.post("/full", response_model=StepScriptEnvelope)
async def generate_full_script(request: StepScriptRequest):
    """Generate a full 5-step dialogue script in a single LLM call."""
    script, meta = await generate_full_step_script(
        ticker=request.ticker,
        regime=request.regime,
        cycle=request.cycle,
        agent_decisions=request.agent_decisions,
        action=request.action,
        confidence=request.confidence,
        news=request.news,
        llm_enabled=True,
    )
    return StepScriptEnvelope(script=script, meta=meta)


@router.get("/scenes")
async def get_available_scenes():
    """Get list of available step scenes with their configurations."""
    return {
        "scenes": {
            key: {
                "phase": value["phase"],
                "name": value["name"],
                "agents": value["agents"],
            }
            for key, value in STEP_SCENES.items()
        }
    }
