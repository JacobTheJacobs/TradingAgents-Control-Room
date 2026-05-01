import sys
import os
import asyncio
import logging
from datetime import datetime
from typing import Dict, Any, Optional

# Add trading_agents_ref to sys.path
EXTERNAL_TA_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../trading_agents_ref"))
if EXTERNAL_TA_PATH not in sys.path:
    sys.path.append(EXTERNAL_TA_PATH)

try:
    from tradingagents.graph.trading_graph import TradingAgentsGraph
    from tradingagents.default_config import DEFAULT_CONFIG
except ImportError:
    logging.error(f"Failed to import TradingAgents from {EXTERNAL_TA_PATH}")
    TradingAgentsGraph = None
    DEFAULT_CONFIG = {}

from .models import TradingDecision, AnalystReports, TradingSignal

logger = logging.getLogger(__name__)

class TradingAgentsService:
    """
    Adapter service for the TradingAgents framework.
    Manages graph execution and mapping to unified contracts.
    """
    
    def __init__(self, config_override: Optional[Dict[str, Any]] = None):
        if TradingAgentsGraph is None:
            raise RuntimeError("TradingAgents library not found in external path.")
            
        self.config = DEFAULT_CONFIG.copy()
        
        # Provider Detection & Auto-Configuration
        google_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        openai_key = os.getenv("OPENAI_API_KEY")
        
        if google_key:
            logger.info("[TA-SERVICE] Google Gemini detected. Switching provider to 'google'.")
            self.config.update({
                "llm_provider": "google",
                "deep_think_llm": "gemini-2.0-pro-exp-02-05",  # Optimal for deep reasoning
                "quick_think_llm": "gemini-2.0-flash",        # Optimal for speed
                "api_key": google_key
            })
        elif openai_key:
            logger.info("[TA-SERVICE] OpenAI detected. Switching provider to 'openai'.")
            self.config.update({
                "llm_provider": "openai",
                "deep_think_llm": "o1-mini",
                "quick_think_llm": "gpt-4o-mini",
                "api_key": openai_key
            })
        else:
            logger.warning("[TA-SERVICE] No Cloud LLM keys found. Falling back to local Ollama.")
            # Keep default config (Ollama)

        if config_override:
            self.config.update(config_override)
            
        # Ensure results dir exists
        os.makedirs(self.config.get("results_dir", "./results"), exist_ok=True)
        
        self.graph = TradingAgentsGraph(config=self.config)

    async def run_analysis(self, ticker: str, trade_date: Optional[str] = None) -> TradingDecision:
        """
        Run a single TradingAgents analysis cycle for a ticker.
        """
        if not trade_date:
            trade_date = datetime.now().strftime("%Y-%m-%d")
            
        logger.info(f"[TA-SERVICE] Starting analysis for {ticker} on {trade_date}")
        
        # Run the graph (using to_thread if propagation is synchronous)
        # Assuming propagate is synchronous based on previous view_file
        loop = asyncio.get_event_loop()
        final_state, processed_signal = await loop.run_in_executor(
            None, self.graph.propagate, ticker, trade_date
        )
        
        # Map processed signal to our TradingSignal enum
        signal_map = {
            "BUY": TradingSignal.BUY,
            "SELL": TradingSignal.SELL,
            "HOLD": TradingSignal.HOLD,
            "STRONG_BUY": TradingSignal.STRONG_BUY,
            "STRONG_SELL": TradingSignal.STRONG_SELL
        }
        
        signal_str = (processed_signal or "HOLD").upper()
        signal = signal_map.get(signal_str, TradingSignal.HOLD)
        
        # Extract reports
        reports = AnalystReports(
            market=final_state.get("market_report", ""),
            sentiment=final_state.get("sentiment_report", ""),
            news=final_state.get("news_report", ""),
            fundamentals=final_state.get("fundamentals_report", ""),
            bull=final_state.get("investment_debate_state", {}).get("bull_history", ""),
            bear=final_state.get("investment_debate_state", {}).get("bear_history", ""),
            research_manager=final_state.get("investment_debate_state", {}).get("judge_decision", ""),
            trader=final_state.get("trader_investment_plan", ""),
            aggressive=final_state.get("risk_debate_state", {}).get("aggressive_history", ""),
            conservative=final_state.get("risk_debate_state", {}).get("conservative_history", ""),
            neutral=final_state.get("risk_debate_state", {}).get("neutral_history", ""),
            risk_judge=final_state.get("risk_debate_state", {}).get("judge_decision", "")
        )
        
        # Estimate confidence from the debate or signal (Shim for now)
        confidence = 0.7  # Default if not extracted
        
        # Create the decision contract
        decision = TradingDecision(
            ticker=ticker,
            signal=signal,
            confidence=confidence,
            reasoning=final_state.get("final_trade_decision", "No specific reasoning provided."),
            reports=reports
        )
        
        logger.info(f"[TA-SERVICE] Analysis complete for {ticker}: {signal.value}")
        return decision

# Global singleton
_service = None

def get_tradingagents_service() -> TradingAgentsService:
    global _service
    if _service is None:
        _service = TradingAgentsService()
    return _service
