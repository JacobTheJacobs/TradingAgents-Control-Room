"""
Pydantic Models for Voice Opinions
Trading-R1: Opinion-Quote-Source Enforcement for anti-hallucination
"""
from pydantic import BaseModel, field_validator
from typing import Literal, Optional
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class VoiceOpinion(BaseModel):
    """Opinion from a single voice agent with Trading-R1 Opinion-Quote-Source enforcement."""
    voice_id: str
    voice_name: str
    emoji: str
    archetype: str
    
    action: Literal["BUY", "SELL", "HOLD", "AVOID"]
    confidence: float  # 0-1
    reasoning: str
    catchphrase: str
    
    # Detailed analysis
    key_factors: list[str]
    risks_identified: list[str]
    
    weight: float  # Voice weight for final calculation
    timestamp: str = datetime.now().isoformat()
    
    # Trading-R1: Opinion-Quote-Source Enforcement (anti-hallucination)
    opinion: str = ""  # One-sentence opinion
    quote: str = ""    # Exact quote from news/data source
    source: str = ""   # Source name (e.g., "MarketWatch", "SEC Filing")
    
    @field_validator('opinion', 'quote', 'source')
    @classmethod
    def validate_opinion_quote_source(cls, v: str, info) -> str:
        """Validate that opinion, quote, and source are not empty for BUY/SELL actions."""
        # Only validate if this is a BUY or SELL action
        if hasattr(info.data, 'get'):
            action = info.data.get('action', 'HOLD')
            if action in ['BUY', 'SELL'] and not v.strip():
                logger.warning(f"[Trading-R1] Missing {info.field_name} for {action} action - potential hallucination")
        return v
    
    def is_valid_ope(self) -> bool:
        """Check if this opinion follows OQS format (required for BUY/SELL)."""
        if self.action in ['BUY', 'SELL']:
            return bool(self.opinion.strip() and self.quote.strip() and self.source.strip())
        return True  # HOLD/AVOID don't require OQS
