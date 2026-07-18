"""
TradingAgents Service Wrapper - Phase 3

Process-isolated, async-safe wrapper around TradingAgents.
This is the MINIMAL wrapper that works with ANY decision schema.
The detailed adapter will be added after deep schema inspection.
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import logging
from typing import Dict, Any, Optional

# Add TradingAgents to path
TA_PATH = Path(__file__).resolve().parents[1] / "TradingAgents-original"
sys.path.insert(0, str(TA_PATH))

from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

logger = logging.getLogger(__name__)


class TradingAgentsService:
    """
    Process-isolated TradingAgents service wrapper.
    
    Uses ThreadPoolExecutor to avoid blocking the async event loop.
    Includes timeout protection and comprehensive error handling.
    """
    
    def __init__(
        self, 
        config: Optional[Dict[str, Any]] = None,
        timeout_seconds: int = 600,  # 10 minutes timeout
        debug: bool = False
    ):
        """
        Initialize TradingAgents service.
        
        Args:
            config: Optional LLM configuration (provider, models, etc.)
            timeout_seconds: Timeout for propagate() calls
            debug: Enable debug logging
        """
        self.timeout_seconds = timeout_seconds
        self.debug = debug
        self.executor = ThreadPoolExecutor(max_workers=2)
        self.graph = None
        self.current_config_hash = None
        
        # If config is provided at init, initialize the graph
        if config:
            self._initialize_graph(config)
        else:
            logger.info("TradingAgentsService initialized without explicit config. Will load from DB on first analyze().")
    
    def _initialize_graph(self, config: dict):
        """Initialize or re-initialize TradingAgentsGraph with the provided config."""
        try:
            # Merge with defaults
            final_config = DEFAULT_CONFIG.copy()
            
            # Map adapter/UI keys to TradingAgents internal keys
            # UI uses 'llm_provider', 'deep_model', 'quick_model'
            inner_mapping = {
                "llm_provider": "llm_provider",
                "deep_model": "deep_think_llm",
                "quick_model": "quick_think_llm",
                "max_debate_rounds": "max_debate_rounds"
            }
            
            for src_key, dst_key in inner_mapping.items():
                if src_key in config:
                    final_config[dst_key] = config[src_key]
            
            # Also allow direct keys
            for k, v in config.items():
                if k in final_config:
                    final_config[k] = v
            
            logger.info(f"Initializing TradingAgentsGraph: {final_config.get('llm_provider')} | {final_config.get('deep_think_llm')}")
            
            self.graph = TradingAgentsGraph(debug=self.debug, config=final_config)
            
            # Store a simple hash/representation to detect changes
            self.current_config_hash = str(sorted(final_config.items()))
            
            logger.info("✓ TradingAgentsGraph initialized successfully")
        except Exception as e:
            logger.error(f"✗ Failed to initialize TradingAgentsGraph: {e}")
            raise
    
    async def analyze(
        self, 
        ticker: str, 
        trade_date: str,
        run_config: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Run TradingAgents analysis on a single ticker with optional run-scoped config.
        
        Args:
            ticker: Stock symbol (e.g., "NVDA")
            trade_date: Analysis date (e.g., "2026-03-24")
            run_config: Optional configuration snapshot for THIS specific run
            
        Returns:
            Result dict with status, decision, state, and metadata
        """
        start_time = asyncio.get_event_loop().time()
        
        # 1. Resolve Configuration
        try:
            target_config = run_config
            if not target_config:
                # Load from DB if no run-scoped config provided
                from src.analytics.data_access import get_data_access
                da = get_data_access()
                target_config = da.get_tradingagents_llm_config()
            
            # 2. Check if we need to (re)initialize the graph
            config_slug = str(sorted(target_config.items()))
            if self.graph is None or config_slug != self.current_config_hash:
                logger.info("Config change detected or first run. (Re)initializing graph...")
                self._initialize_graph(target_config)
                
        except Exception as e:
            return {
                "ticker": ticker,
                "status": "error",
                "error": f"Failed to resolve config or initialize graph: {str(e)}",
                "elapsed_seconds": 0
            }
        
        # 3. Execute Analysis
        try:
            logger.info(f"Starting analysis for {ticker} @ {trade_date}")
            
            # Run propagate() in thread pool to avoid blocking event loop
            loop = asyncio.get_event_loop()
            state, decision = await asyncio.wait_for(
                loop.run_in_executor(
                    self.executor,
                    lambda: self.graph.propagate(ticker, trade_date)
                ),
                timeout=self.timeout_seconds
            )
            
            elapsed = asyncio.get_event_loop().time() - start_time
            
            logger.info(f"✓ Analysis complete for {ticker} in {elapsed:.2f}s")
            logger.info(f"  Decision: {decision}")
            
            # Include the config used in the results for auditability
            return {
                "ticker": ticker,
                "trade_date": trade_date,
                "status": "success",
                "decision": decision,
                "state": state,
                "config_snapshot": target_config, # Critical for audit trail
                "elapsed_seconds": elapsed,
                "latency_ms": int(elapsed * 1000)
            }
            
        except asyncio.TimeoutError:
            elapsed = asyncio.get_event_loop().time() - start_time
            logger.error(f"✗ TIMEOUT for {ticker} after {elapsed:.2f}s")
            
            return {
                "ticker": ticker,
                "trade_date": trade_date,
                "status": "timeout",
                "error": f"Analysis exceeded timeout ({self.timeout_seconds}s)",
                "elapsed_seconds": elapsed,
                "latency_ms": int(elapsed * 1000)
            }
            
        except Exception as e:
            elapsed = asyncio.get_event_loop().time() - start_time
            logger.error(f"✗ ERROR for {ticker}: {str(e)}")
            
            return {
                "ticker": ticker,
                "trade_date": trade_date,
                "status": "error",
                "error": str(e),
                "error_type": type(e).__name__,
                "elapsed_seconds": elapsed,
                "latency_ms": int(elapsed * 1000)
            }
    
    def shutdown(self):
        """Clean up resources."""
        logger.info("Shutting down TradingAgents service...")
        if self.executor:
            self.executor.shutdown(wait=True)
        logger.info("✓ TradingAgents service shut down")


# Convenience function for testing
async def test_service():
    """Test the service wrapper."""
    from datetime import datetime
    
    service = TradingAgentsService(debug=True)
    
    print("\n" + "="*80)
    print("TRADINGAGENTS SERVICE TEST")
    print("="*80 + "\n")
    
    result = await service.analyze("NVDA", "2026-03-24")
    
    print("\n" + "="*80)
    print("RESULT")
    print("="*80)
    print(f"Status: {result['status']}")
    print(f"Ticker: {result['ticker']}")
    print(f"Decision: {result.get('decision', 'N/A')}")
    print(f"Elapsed: {result.get('elapsed_seconds', 0):.2f}s")
    
    if result['status'] == 'success':
        print(f"\nState keys ({len(result['state'])}):")
        for key in result['state'].keys():
            print(f"  • {key}")
    
    elif result['status'] in ['timeout', 'error']:
        print(f"Error: {result.get('error', 'Unknown error')}")
    
    service.shutdown()
    
    return result


if __name__ == "__main__":
    # Run test
    asyncio.run(test_service())
