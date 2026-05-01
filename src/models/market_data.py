"""
Pydantic Models for Market Data - Enhanced with 50+ fields
"""
from pydantic import BaseModel
from typing import Optional, Literal
from datetime import datetime


class TechnicalData(BaseModel):
    """Technical analysis indicators - Enhanced with 15+ fields."""
    # Price Data
    current_price: float
    open: float
    high: float
    low: float
    volume: int
    avg_volume: float = 0  # Average volume for context
    
    # 52-Week Range
    week_52_high: float = 0
    week_52_low: float = 0
    week_52_change: float = 0  # Percentage change
    
    # Moving Averages
    sma_20: float
    sma_50: float
    sma_200: float
    ema_12: float = 0
    ema_26: float = 0
    
    # Momentum Indicators
    rsi: float  # 0-100
    macd: float
    macd_signal: float
    macd_histogram: float = 0
    stochastic_k: float = 0  # %K line
    stochastic_d: float = 0  # %D line
    
    # Volatility Indicators
    bollinger_upper: float
    bollinger_lower: float
    bollinger_mid: float = 0
    atr: float = 0  # Average True Range
    beta: float = 1.0  # Volatility vs market
    
    # Trend Indicators
    adx: float = 0  # Average Directional Index (0-100)
    vwap: float = 0  # Volume Weighted Average Price
    trend: str  # "bullish" | "bearish" | "sideways"
    trend_strength: str = "moderate"  # "weak" | "moderate" | "strong"

class NewsItem(BaseModel):
    """Single news article."""
    title: str
    source: str
    url: str
    published_at: str
    sentiment: float  # -1 to 1
    related_tickers: list[str] = []

class AnalystRating(BaseModel):
    """Analyst rating data."""
    firm: str
    rating: str  # "buy" | "hold" | "sell"
    price_target: float = 0
    date: str = ""

class NewsData(BaseModel):
    """Aggregated news and sentiment data - Enhanced."""
    items: list[NewsItem]
    overall_sentiment: float
    positive_count: int
    negative_count: int
    neutral_count: int
    sentiment_label: str  # "bullish" | "bearish" | "neutral"
    
    # Analyst Data
    analyst_ratings: list[AnalystRating] = []
    avg_price_target: float = 0
    num_buy_ratings: int = 0
    num_hold_ratings: int = 0
    num_sell_ratings: int = 0
    analyst_consensus: str = "hold"  # "buy" | "hold" | "sell"

class FundamentalData(BaseModel):
    """Fundamental analysis data."""
    # Valuation Metrics
    pe_ratio: float = 0
    forward_pe: float = 0
    peg_ratio: float = 0
    price_to_book: float = 0
    price_to_sales: float = 0
    ev_to_ebitda: float = 0
    
    # Financial Metrics
    market_cap: float = 0
    enterprise_value: float = 0
    eps: float = 0
    revenue: float = 0
    revenue_growth: float = 0
    profit_margin: float = 0
    operating_margin: float = 0
    free_cash_flow: float = 0
    
    # Balance Sheet
    debt_to_equity: float = 0
    current_ratio: float = 0
    quick_ratio: float = 0
    
    # Ownership
    insider_ownership: float = 0
    institutional_ownership: float = 0
    
    # Dividends
    dividend_yield: float = 0
    payout_ratio: float = 0

class MarketData(BaseModel):
    """Combined market data for analysis."""
    ticker: str
    technical: TechnicalData
    fundamental: FundamentalData
    news: NewsData
    fetched_at: str = datetime.now().isoformat()
    
    def to_summary(self) -> str:
        """Generate a text summary for LLM consumption."""
        tech = self.technical
        fund = self.fundamental
        news = self.news
        
        return f"""
=== MARKET DATA FOR {self.ticker} ===

📊 TECHNICAL ANALYSIS:
• Price: ${tech.current_price:.2f} (52wk: ${tech.week_52_low:.2f} - ${tech.week_52_high:.2f})
• RSI: {tech.rsi:.1f}
• MACD: {tech.macd:.2f} vs Signal: {tech.macd_signal:.2f}
• Trend: {tech.trend.upper()} ({tech.trend_strength})
• Beta: {tech.beta:.2f} | ATR: {tech.atr:.2f}
• ADX: {tech.adx:.1f} | Stochastic: {tech.stochastic_k:.1f}

📈 FUNDAMENTALS:
• P/E: {fund.pe_ratio:.1f} | Forward P/E: {fund.forward_pe:.1f} | PEG: {fund.peg_ratio:.2f}
• EPS: ${fund.eps:.2f} | EV/EBITDA: {fund.ev_to_ebitda:.1f}
• Market Cap: ${fund.market_cap/1e9:.1f}B | EV: ${fund.enterprise_value/1e9:.1f}B
• Revenue Growth: {fund.revenue_growth:.1f}% | Profit Margin: {fund.profit_margin:.1f}%
• FCF: ${fund.free_cash_flow/1e9:.1f}B | Debt/Equity: {fund.debt_to_equity:.2f}
• Insider Own: {fund.insider_ownership:.1f}% | Institutional: {fund.institutional_ownership:.1f}%

📰 NEWS & ANALYST SENTIMENT:
• News: {news.sentiment_label.upper()} ({news.overall_sentiment:.2f})
• Analyst Consensus: {news.analyst_consensus} | Avg Target: ${news.avg_price_target:.2f}
• Ratings: Buy={news.num_buy_ratings} | Hold={news.num_hold_ratings} | Sell={news.num_sell_ratings}
"""
