"""
Pydantic Models for Final Decision
"""
from pydantic import BaseModel
from typing import Literal, Optional
from datetime import datetime

from .market_data import MarketData
from .voice_opinion import VoiceOpinion


class PricePrediction(BaseModel):
    """Oracle's price prediction."""
    target_price: float
    timeframe: str  # "1_week", "1_month", "3_months"
    upside_potential: float  # percentage
    downside_risk: float  # percentage
    confidence: float


class FinalDecision(BaseModel):
    """The Oracle's final decision."""
    action: Literal["STRONG_BUY", "BUY", "HOLD", "SELL", "STRONG_SELL", "AVOID"]
    confidence: float  # 0-1
    reasoning: str
    
    # Vote summary
    buy_votes: int
    sell_votes: int
    hold_votes: int
    avoid_votes: int
    
    # Weighted consensus
    weighted_score: float  # -1 (sell) to 1 (buy)
    
    # Price prediction
    price_prediction: Optional[PricePrediction] = None
    
    # Risk assessment
    risk_level: Literal["LOW", "MEDIUM", "HIGH", "EXTREME"]
    key_risks: list[str]
    
    # Key catalysts
    bullish_factors: list[str]
    bearish_factors: list[str]
    
    timestamp: str = datetime.now().isoformat()


class DebateLog(BaseModel):
    """Log of the voice debate."""
    rounds: int
    opinions: list[VoiceOpinion]
    consensus_reached: bool
    majority_action: str
    debate_summary: str
    key_disagreements: list[str]


class AnalysisResponse(BaseModel):
    """Complete analysis response."""
    ticker: str
    market_data: MarketData
    voice_opinions: list[VoiceOpinion]
    debate_log: DebateLog
    final_decision: FinalDecision
    analyzed_at: str = datetime.now().isoformat()
