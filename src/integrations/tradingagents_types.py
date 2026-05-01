"""
TradingAgents Decision Contract

Single source of truth for all trading decisions.
No dual-pipeline compatibility - TradingAgents ONLY.
"""
from dataclasses import dataclass
from typing import Literal, Any, Optional
from datetime import datetime


@dataclass
class TradingDecision:
    """
    Unified trading decision from TradingAgents.
    
    This is the ONLY decision contract used throughout the system.
    All API endpoints, WebSocket payloads, and execution history 
    use this exact shape.
    """
    symbol: str
    action: Literal["BUY", "SELL", "HOLD", "LIQUIDATE"]
    quantity: Optional[float]
    prediction: str  # e.g., "BULLISH", "BEARISH", "NEUTRAL"
    confidence: Optional[float]  # 0.0 to 1.0
    reasoning: str  # Summary of why this decision was made
    timestamp: datetime = None
    metadata: dict[str, Any] = None
    
    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.now()
        if self.metadata is None:
            self.metadata = {}
    
    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "symbol": self.symbol,
            "action": self.action,
            "quantity": self.quantity,
            "prediction": self.prediction,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "metadata": self.metadata or {}
        }
    
    @classmethod
    def from_tradingagents_result(cls, result: dict) -> "TradingDecision":
        """
        Create TradingDecision from TradingAgents raw output.
        
        This is the ONLY place that parses TradingAgents raw format.
        All other code consumes the clean TradingDecision object.
        """
        # Extract from TradingAgents result format
        # (Adjust based on actual TradingAgents output structure)
        return cls(
            symbol=result.get("ticker", result.get("symbol", "UNKNOWN")),
            action=cls._map_action(result.get("action", result.get("decision", "HOLD"))),
            quantity=result.get("quantity", result.get("size", None)),
            prediction=result.get("prediction", result.get("direction", "NEUTRAL")),
            confidence=result.get("confidence", result.get("probability", None)),
            reasoning=result.get("reasoning", result.get("rationale", result.get("summary", ""))),
            metadata={
                "run_id": result.get("run_id"),
                "cycle": result.get("cycle"),
                "research_depth": result.get("research_depth", "standard"),
                "raw_result": result  # Keep full result for debugging
            }
        )
    
    @staticmethod
    def _map_action(raw_action: str) -> str:
        """Normalize action strings to standard format."""
        if not raw_action:
            return "HOLD"
        
        action_upper = raw_action.upper().strip()
        
        # Map various action representations
        if action_upper in ["BUY", "LONG", "ENTER_LONG", "OPEN_LONG"]:
            return "BUY"
        elif action_upper in ["SELL", "SHORT", "ENTER_SHORT", "OPEN_SHORT"]:
            return "SELL"
        elif action_upper in ["LIQUIDATE", "EXIT", "CLOSE", "FLATTEN"]:
            return "LIQUIDATE"
        else:
            return "HOLD"
