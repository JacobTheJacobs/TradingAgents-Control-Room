"""
TradingAgents Worker Service

CRITICAL: TradingAgents runs 130-210 seconds per ticker with Ollama.
DO NOT run inside websocket handler or main async loop.

This worker provides:
- Process isolation (runs in thread pool)
- Event streaming (websocket just broadcasts events)
- State persistence (for replay/debugging)
- Timeout protection
"""

import asyncio
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional, AsyncIterator
from concurrent.futures import ThreadPoolExecutor
import logging

from src.integrations.tradingagents_runtime import build_tradingagents_run_id

logger = logging.getLogger(__name__)


class TradingAgentsWorker:
    """
    Isolated worker for TradingAgents runs.
    
    IMPORTANT:
    - Runs in separate thread pool (not main async loop)
    - Websocket just streams events (doesn't execute)
    - State persisted for replay/debugging
    - Event callback is PASSIVE (observability only)
    """
    
    def __init__(self, max_workers: int = 2):
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self._runs: Dict[str, Dict] = {}
        self._events: Dict[str, list] = {}
    
    def _record_event(self, run_id: str, event: Dict):
        """PASSIVE event recording - observability only."""
        if run_id not in self._events:
            self._events[run_id] = []
        
        # MANDATORY: Enforce event contract fields
        # Every event MUST have: schema_version, run_id, source
        event_with_metadata = {
            "schema_version": 1,
            "run_id": run_id,
            "source": "tradingagents",
            **event,  # Merge in the actual event data
        }
        
        self._events[run_id].append(event_with_metadata)
    
    async def submit(
        self,
        ticker: str,
        trade_date: str,
        cycle: int,
        research_depth: str = "standard",
    ) -> str:
        """
        Submit TradingAgents run to worker pool.
        Returns run_id immediately.
        """
        
        run_id = build_tradingagents_run_id(
            ticker,
            trade_date,
            cycle=cycle,
            prefix="ta-worker",
        )
        
        self._runs[run_id] = {
            "run_id": run_id,
            "ticker": ticker,
            "trade_date": trade_date,
            "cycle": cycle,
            "research_depth": research_depth,
            "status": "pending",
            "submitted_at": datetime.utcnow().isoformat() + "Z",
        }
        
        # Submit to thread pool
        loop = asyncio.get_event_loop()
        
        def _run_in_thread():
            """Execute TradingAgents in isolated thread."""
            import sys
            from pathlib import Path
            
            PROJECT_ROOT = Path(__file__).parent.parent.parent
            sys.path.insert(0, str(PROJECT_ROOT))
            
            from src.integrations.tradingagents_runner import TradingAgentsRunner
            
            def event_callback(event):
                self._record_event(run_id, event)
            
            runner = TradingAgentsRunner(
                research_depth=research_depth,
                event_callback=event_callback,
            )
            
            result = asyncio.run(runner.run(ticker, trade_date, cycle))
            return result
        
        future = loop.run_in_executor(self.executor, _run_in_thread)
        self._runs[run_id]["future"] = future
        self._runs[run_id]["status"] = "running"
        
        return run_id
    
    async def stream_events(self, run_id: str) -> AsyncIterator[Dict]:
        """Stream events for a run."""
        
        if run_id not in self._runs:
            raise ValueError(f"Unknown run_id: {run_id}")
        
        seen_events = 0
        
        while True:
            events = self._events.get(run_id, [])
            
            while seen_events < len(events):
                yield events[seen_events]
                seen_events += 1
            
            run_data = self._runs[run_id]
            
            if run_data["status"] == "complete":
                while seen_events < len(events):
                    yield events[seen_events]
                    seen_events += 1
                break
            
            await asyncio.sleep(0.1)
    
    async def get_result(self, run_id: str) -> Dict[str, Any]:
        """Get final result of a run (blocks until complete)."""
        
        if run_id not in self._runs:
            raise ValueError(f"Unknown run_id: {run_id}")
        
        run_data = self._runs[run_id]
        future = run_data.get("future")
        
        if not future:
            raise ValueError(f"Run not started: {run_id}")
        
        result = await future
        
        run_data["status"] = "complete"
        run_data["result"] = result
        run_data["completed_at"] = datetime.utcnow().isoformat() + "Z"
        
        # Persist state for replay/debugging
        state_dir = Path("state/tradingagents_runs")
        state_dir.mkdir(parents=True, exist_ok=True)
        
        state_file = state_dir / f"{run_id}.json"
        
        with open(state_file, 'w') as f:
            json.dump(result, f, indent=2, default=str)
        
        logger.info(f"Persisted state: {state_file}")
        
        return result
