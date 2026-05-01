"""
TradingAgents Execution Contract

EXECUTION SPLIT (EXPLICIT):
===========================

TradingAgents decides:
  - DIRECTION: BUY/SELL/HOLD
  - REASONING: analyst reports, debate logs, risk review
  - STATE: full context for UI/replay/showrunner

Our app decides:
  - POSITION SIZING: 0.02 fixed rule (NOT from TradingAgents)
  - RISK CAPS: max position 10%, sector limits
  - COOLDOWN: 7-day cooldown enforcement
  - BROKER EXECUTION: timing, order type, routing

This is NOT "100% original TradingAgents behavior."
This is a clean architectural split.

EVENT CONTRACT:
===============
All events include:
  - schema_version: 1
  - run_id: "cycle-7-NVDA-20260324"
  - source: "tradingagents"

This enables replay/history/showrunner evolution.
"""

from typing import Dict, Any, Optional
from datetime import datetime
from pydantic import BaseModel, Field


class TradingAgentsExecution(BaseModel):
    """
    Execution contract for TradingAgents decisions.
    
    TradingAgents provides: decision (BUY/SELL/HOLD)
    Our app provides: mechanical execution details
    """
    
    # From TradingAgents (100% original)
    source: str = "tradingagents"
    ticker: str
    decision: str  # "BUY", "SELL", or "HOLD" - directly from TradingAgents
    trade_date: str
    
    # Execution metadata (for logging/audit)
    cycle: int
    research_depth: str
    elapsed_seconds: float
    
    # Our app's execution rules (MECHANICAL, no interpretation)
    execution_rule: str = "broker_fixed_size_v1"
    position_size: float = Field(default=0.02, description="Fixed allocation rule, not from TradingAgents")
    risk_cap: float = Field(default=0.05, description="Max position size allowed")
    
    # Timestamps
    decision_timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    
    # Display-only metadata (NEVER gates execution)
    display_metadata: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Parser-derived fields for UI display only. Never used for execution decisions."
    )
    
    class Config:
        json_schema_extra = {
            "example": {
                "source": "tradingagents",
                "ticker": "NVDA",
                "decision": "BUY",
                "trade_date": "2026-03-24",
                "cycle": 12,
                "research_depth": "standard",
                "elapsed_seconds": 187.3,
                "execution_rule": "broker_fixed_size_v1",
                "position_size": 0.02,
                "risk_cap": 0.05,
                "decision_timestamp": "2026-03-24T14:32:15.123Z",
                "display_metadata": {
                    "inferred_confidence": 0.85,
                    "inferred_thesis": "AI infrastructure demand...",
                    "parser_warnings": [],
                }
            }
        }


class TradingAgentsDisplayMetadata(BaseModel):
    """
    Parser-derived metadata for UI display.
    
    IMPORTANT: These fields are DISPLAY ONLY.
    They NEVER gate or override execution.
    
    If you want to gate execution, do it in YOUR code,
    not based on these derived fields.
    """
    
    # Inferred from text (heuristics, not native TradingAgents fields)
    inferred_confidence: Optional[float] = Field(
        default=None,
        description="Confidence inferred from text cues (NOT native to TradingAgents)"
    )
    inferred_position_hint: Optional[str] = Field(
        default=None,
        description="Position size hint from text (NOT native to TradingAgents)"
    )
    inferred_thesis: Optional[str] = Field(
        default=None,
        description="Thesis summary extracted from text"
    )
    inferred_risk_notes: Optional[str] = Field(
        default=None,
        description="Risk warnings extracted from text"
    )
    
    # Parser quality metadata (for transparency)
    parser_quality: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Metadata about parsing reliability"
    )
    
    # Report lengths (useful for UI)
    report_lengths: Optional[Dict[str, int]] = Field(
        default=None,
        description="Character counts for each report"
    )


def create_execution_contract(
    ticker: str,
    decision: str,
    trade_date: str,
    cycle: int,
    research_depth: str,
    elapsed_seconds: float,
    position_size: float = 0.02,
    display_metadata: Optional[Dict[str, Any]] = None,
) -> TradingAgentsExecution:
    """
    Create execution contract from TradingAgents output.
    
    This is the ONLY way to execute TradingAgents decisions:
    - decision comes DIRECTLY from TradingAgents
    - position_size is a FIXED RULE in our app
    - display_metadata is for UI only, never gates execution
    """
    
    return TradingAgentsExecution(
        ticker=ticker,
        decision=decision,  # Direct from TradingAgents, no modification
        trade_date=trade_date,
        cycle=cycle,
        research_depth=research_depth,
        elapsed_seconds=elapsed_seconds,
        position_size=position_size,
        display_metadata=display_metadata,
    )


def should_execute(execution: TradingAgentsExecution) -> tuple[bool, str]:
    """
    Determine if execution should proceed.
    
    This uses ONLY:
    - TradingAgents decision (BUY/SELL/HOLD)
    - Our app's mechanical rules (position size caps, cooldowns, etc.)
    
    NOT:
    - Parser-derived confidence
    - Inferred position hints
    - Display metadata of any kind
    """
    
    if execution.decision == "HOLD":
        return False, "TradingAgents decision is HOLD"
    
    if execution.decision not in ["BUY", "SELL"]:
        return False, f"Invalid decision: {execution.decision}"
    
    # Check mechanical risk caps (our app's rules, not TradingAgents)
    if execution.position_size > execution.risk_cap:
        return False, f"Position size {execution.position_size} exceeds risk cap {execution.risk_cap}"
    
    # Add cooldown checks, market hours checks, etc. here
    
    return True, "Execution approved"


# Example usage
if __name__ == "__main__":
    # Create execution contract from TradingAgents output
    execution = create_execution_contract(
        ticker="NVDA",
        decision="BUY",  # Directly from TradingAgents
        trade_date="2026-03-24",
        cycle=1,
        research_depth="standard",
        elapsed_seconds=187.3,
        position_size=0.02,  # Our app's fixed rule
        display_metadata={
            "inferred_confidence": 0.85,
            "inferred_thesis": "Strong AI infrastructure demand...",
            "parser_quality": {
                "confidence_source": "text_cue_high_conviction",
                "warnings": [],
            }
        }
    )
    
    print("Execution Contract:")
    print(execution.model_dump_json(indent=2))
    
    # Check if should execute
    should_exec, reason = should_execute(execution)
    print(f"\nShould execute: {should_exec}")
    print(f"Reason: {reason}")
