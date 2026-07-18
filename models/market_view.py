"""
MarketView - Agent's accumulated market intelligence
"""
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
import json

@dataclass
class MarketView:
    """Each agent accumulates market intelligence by visiting stations"""

    # Market data by symbol
    prices: Dict[str, Dict] = field(default_factory=dict)
    sentiment: Dict[str, Dict] = field(default_factory=dict)
    fundamentals: Dict[str, Dict] = field(default_factory=dict)

    # Data freshness tracking
    staleness: Dict[str, datetime] = field(default_factory=dict)

    # Injected market events
    injected_events: List[Dict] = field(default_factory=list)

    def update_prices(self, symbol: str, data: Dict):
        """Update price data from Ticker Board visit"""
        self.prices[symbol] = {
            **data,
            'timestamp': datetime.now(),
            'source': 'ticker_board'
        }
        self.staleness[f'prices_{symbol}'] = datetime.now()

    def update_sentiment(self, symbol: str, data: Dict):
        """Update sentiment data from TV visit"""
        self.sentiment[symbol] = {
            **data,
            'timestamp': datetime.now(),
            'source': 'tv_station'
        }
        self.staleness[f'sentiment_{symbol}'] = datetime.now()

    def update_fundamentals(self, symbol: str, data: Dict):
        """Update fundamental data from Newsstand visit"""
        self.fundamentals[symbol] = {
            **data,
            'timestamp': datetime.now(),
            'source': 'newsstand'
        }
        self.staleness[f'fundamentals_{symbol}'] = datetime.now()

    def is_fresh(self, data_type: str, symbol: str, max_age_seconds: int) -> bool:
        """Check if data is fresh enough for trading decisions"""
        key = f'{data_type}_{symbol}'
        if key not in self.staleness:
            return False

        age = (datetime.now() - self.staleness[key]).total_seconds()
        return age <= max_age_seconds

    def can_trade(self, agent_personality: str, symbol: str) -> bool:
        """Check if agent has sufficient fresh data to make trading decisions"""
        requirements = {
            'technical': {'prices': 120},  # Technical needs fresh prices < 2min
            'fundamental': {'fundamentals': 300, 'prices': 180},  # Fundamental needs fresh fundamentals < 5min
            'sentiment': {'sentiment': 180, 'prices': 120},  # Sentiment needs fresh sentiment < 3min
            'risk': {'prices': 120, 'fundamentals': 300},  # Risk needs both
            'momentum': {'prices': 60},  # Momentum needs very fresh prices
            'value': {'fundamentals': 600, 'prices': 180},  # Value can use older fundamentals
            'growth': {'fundamentals': 300, 'prices': 120},
            'contrarian': {'sentiment': 180, 'prices': 120},
            'oracle': {'prices': 120}  # Oracle synthesizes all
        }

        reqs = requirements.get(agent_personality, {'prices': 120})

        for data_type, max_age in reqs.items():
            if not self.is_fresh(data_type, symbol, max_age):
                return False

        return True
