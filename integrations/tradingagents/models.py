from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Any, List, Optional
from enum import Enum

class TradingSignal(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"
    STRONG_BUY = "STRONG_BUY"
    STRONG_SELL = "STRONG_SELL"

@dataclass
class AnalystReports:
    """Consolidated reports from TradingAgents analysts."""
    market: str = ""
    sentiment: str = ""
    news: str = ""
    fundamentals: str = ""
    bull: str = ""
    bear: str = ""
    research_manager: str = ""
    trader: str = ""
    aggressive: str = ""
    conservative: str = ""
    neutral: str = ""
    risk_judge: str = ""

@dataclass
class TradingDecision:
    """
    The UNIFIED CONTRACT for all trading decisions in the system.
    This replaces the legacy 8-phase result format.
    """
    ticker: str
    signal: TradingSignal
    confidence: float  # 0.0 to 1.0
    reasoning: str    # Summary reasoning for the decision
    
    # Rich metadata for observability
    reports: AnalystReports = field(default_factory=AnalystReports)
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    
    # Execution metadata
    execution_id: str = field(default_factory=lambda: str(datetime.now().timestamp()))
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_legacy_dict(self) -> Dict[str, Any]:
        """
        Map to the legacy dict format used by the current execution history and UI.
        This provides a shim until Phase 3 (Frontend Rewrite) is complete.
        """
        return {
            "ticker": self.ticker,
            "prediction": self.signal.value,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "analyst_reports": {
                "market": self.reports.market,
                "sentiment": self.reports.sentiment,
                "news": self.reports.news,
                "fundamentals": self.reports.fundamentals,
                "bull": self.reports.bull,
                "bear": self.reports.bear,
                "research_manager": self.reports.research_manager,
                "trader": self.reports.trader,
                "aggressive": self.reports.aggressive,
                "conservative": self.reports.conservative,
                "neutral": self.reports.neutral,
                "risk_judge": self.reports.risk_judge
            },
            "timestamp": self.timestamp,
            "execution_id": self.execution_id,
            "source": "TradingAgents"
        }
