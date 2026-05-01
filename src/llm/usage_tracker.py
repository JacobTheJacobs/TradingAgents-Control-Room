"""
LLM Usage Tracker - Tracks token usage and costs across providers
"""

from typing import Dict, Optional
from dataclasses import dataclass, field
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


@dataclass
class UsageStats:
    """Usage statistics for a single LLM call"""
    provider: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    success: bool = True
    latency_ms: float = 0.0


class UsageTracker:
    """
    Tracks LLM usage and costs across all providers.
    Provides statistics and summaries for monitoring.
    """
    
    # Cost per 1K tokens (approximate, as of 2024)
    COSTS_PER_1K = {
        # OpenAI
        'gpt-4': {'prompt': 0.03, 'completion': 0.06},
        'gpt-4-turbo': {'prompt': 0.01, 'completion': 0.03},
        'gpt-4o': {'prompt': 0.005, 'completion': 0.015},
        'gpt-4o-mini': {'prompt': 0.00015, 'completion': 0.0006},
        'gpt-3.5-turbo': {'prompt': 0.0005, 'completion': 0.0015},
        
        # Anthropic
        'claude-3-opus': {'prompt': 0.015, 'completion': 0.075},
        'claude-3-sonnet': {'prompt': 0.003, 'completion': 0.015},
        'claude-3-haiku': {'prompt': 0.00025, 'completion': 0.00125},
        'claude-3.5-sonnet': {'prompt': 0.003, 'completion': 0.015},
        
        # Google
        'gemini-pro': {'prompt': 0.00025, 'completion': 0.0005},
        'gemini-1.5-pro': {'prompt': 0.00125, 'completion': 0.005},
        'gemini-1.5-flash': {'prompt': 0.000075, 'completion': 0.0003},
        
        # Groq
        'llama-3.1-70b': {'prompt': 0.00059, 'completion': 0.00079},
        'llama-3.1-8b': {'prompt': 0.00005, 'completion': 0.00008},
        'mixtral-8x7b': {'prompt': 0.00024, 'completion': 0.00024},
        
        # DeepSeek
        'deepseek-chat': {'prompt': 0.00014, 'completion': 0.00028},
        'deepseek-coder': {'prompt': 0.00014, 'completion': 0.00028},
        
        # Default fallback
        'default': {'prompt': 0.001, 'completion': 0.002},
    }
    
    def __init__(self):
        self.stats: list[UsageStats] = []
        self.total_cost = 0.0
        self.total_tokens = 0
        self.provider_stats: Dict[str, Dict] = {}
    
    def calculate_cost(self, model: str, prompt_tokens: int, completion_tokens: int) -> float:
        """Calculate cost in USD for a given model and token counts."""
        model_key = model.lower()
        
        # Find matching cost structure
        cost_structure = None
        for key in self.COSTS_PER_1K:
            if key in model_key:
                cost_structure = self.COSTS_PER_1K[key]
                break
        
        if cost_structure is None:
            cost_structure = self.COSTS_PER_1K['default']
        
        prompt_cost = (prompt_tokens / 1000) * cost_structure['prompt']
        completion_cost = (completion_tokens / 1000) * cost_structure['completion']
        
        return prompt_cost + completion_cost
    
    def record_usage(
        self,
        provider: str,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        success: bool = True,
        latency_ms: float = 0.0,
    ) -> UsageStats:
        """Record a single LLM usage event."""
        total_tokens = prompt_tokens + completion_tokens
        cost = self.calculate_cost(model, prompt_tokens, completion_tokens)
        
        stats = UsageStats(
            provider=provider,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            cost_usd=cost,
            success=success,
            latency_ms=latency_ms,
        )
        
        self.stats.append(stats)
        self.total_cost += cost
        self.total_tokens += total_tokens
        
        # Update provider stats
        if provider not in self.provider_stats:
            self.provider_stats[provider] = {
                'calls': 0,
                'tokens': 0,
                'cost': 0.0,
                'successes': 0,
                'failures': 0,
            }
        
        self.provider_stats[provider]['calls'] += 1
        self.provider_stats[provider]['tokens'] += total_tokens
        self.provider_stats[provider]['cost'] += cost
        if success:
            self.provider_stats[provider]['successes'] += 1
        else:
            self.provider_stats[provider]['failures'] += 1
        
        logger.debug(f"Recorded usage: {provider}/{model} - {total_tokens} tokens, ${cost:.4f}")
        
        return stats
    
    def get_summary(self) -> Dict:
        """Get a summary of all usage."""
        return {
            'total_calls': len(self.stats),
            'total_tokens': self.total_tokens,
            'total_cost_usd': self.total_cost,
            'providers': self.provider_stats.copy(),
            'recent_calls': len([s for s in self.stats[-100:] if s.success]),
        }


# Global instance
_usage_tracker: Optional[UsageTracker] = None


def get_usage_tracker() -> UsageTracker:
    """Get the global usage tracker instance."""
    global _usage_tracker
    if _usage_tracker is None:
        _usage_tracker = UsageTracker()
    return _usage_tracker
