from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Any, Optional, Literal

@dataclass
class PipelineDecision:
    """
    Normalized contract for all trading decisions across the system.
    This replaces fragmented TradingDecision models.
    """
    ticker: str
    action: Literal["BUY", "SELL", "HOLD", "LIQUIDATE", "STRONG_BUY", "STRONG_SELL"]
    quantity: float = 0.0
    confidence: float = 0.0  # 0.0 to 1.0
    reasoning: str = ""
    prediction: Optional[str] = None  # e.g., "BULLISH", "BEARISH", "NEUTRAL"
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    # Rich analysis reports for observability
    reports: Dict[str, str] = field(default_factory=dict)
    
    # Execution metadata
    execution_id: Optional[str] = None
    agent_name: str = "Oracle"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "ticker": self.ticker,
            "action": self.action,
            "quantity": self.quantity,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "prediction": self.prediction,
            "timestamp": self.timestamp,
            "metadata": self.metadata,
            "reports": self.reports,
            "execution_id": self.execution_id,
            "agent_name": self.agent_name
        }