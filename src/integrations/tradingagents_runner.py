"""
TradingAgents Runner - Clean Black-Box Wrapper

Preserves TradingAgents logic 100%.
Only adds: event emission, progress tracking, logging.
"""

import asyncio
import concurrent.futures
import os
import sys
from pathlib import Path
from typing import Dict, Any, Optional, Callable, List, Union
from datetime import datetime
import json
import io
import contextlib
import threading
import re
import logging
import time
from urllib.parse import urlsplit, urlunsplit

from src.integrations.tradingagents_adapter import adapt_decision
from src.integrations.tradingagents_runtime import is_abort_requested
from src.integrations.tradingagents_runtime import build_tradingagents_run_id
from src.integrations.tradingagents_roster import (
    TRADINGAGENTS_PHASE_NUMBERS,
    normalize_tradingagents_agent_id,
)

# Add TradingAgents to path
TA_PATH = Path(__file__).parent.parent.parent / "trading_agents_ref"
sys.path.insert(0, str(TA_PATH))

from tradingagents.default_config import DEFAULT_CONFIG

logger = logging.getLogger(__name__)


def _resolve_ollama_root_url() -> str:
    raw = (
        os.getenv("OLLAMA_API_URL")
        or os.getenv("OLLAMA_HOST")
        or os.getenv("OLLAMA_BASE_URL")
        or "http://localhost:11434"
    )
    base = str(raw).strip().rstrip("/")
    if not base:
        return "http://localhost:11434"
    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    if path.endswith("/v1"):
        path = path[:-3]
    return urlunsplit((parts.scheme, parts.netloc, path or "", parts.query, parts.fragment)).rstrip("/")


def _resolve_ollama_backend_url() -> str:
    configured = os.getenv("TA_OLLAMA_BASE_URL") or os.getenv("TA_LLM_BACKEND_URL")
    if configured:
        base = str(configured).strip().rstrip("/")
        if base:
            return base if base.endswith("/v1") else f"{base}/v1"
    root = _resolve_ollama_root_url()
    return f"{root}/v1"


def _infer_local_model_timeout_seconds(*model_names: Any) -> float:
    max_size_b = 0.0
    for model_name in model_names:
        raw = str(model_name or "").lower()
        if not raw:
            continue
        for match in re.finditer(r"(\d+(?:\.\d+)?)\s*b\b", raw):
            try:
                max_size_b = max(max_size_b, float(match.group(1)))
            except (TypeError, ValueError):
                continue

    if max_size_b >= 30:
        return 900.0
    if max_size_b >= 14:
        return 720.0
    if max_size_b >= 9:
        return 480.0
    return 180.0


def _load_tradingagents_graph():
    try:
        from tradingagents.graph.trading_graph import TradingAgentsGraph
        return TradingAgentsGraph
    except ModuleNotFoundError as exc:
        missing = getattr(exc, "name", "") or ""
        if missing == "langgraph":
            raise RuntimeError(
                "TradingAgents dependency missing: langgraph. "
                "Install it in this venv or use offline wheels, then restart the backend."
            ) from exc
        raise
    except Exception as exc:
        raise RuntimeError(
            "TradingAgents failed to import. Check dependencies and try again."
        ) from exc



class TradingAgentsRunner:
    """
    Clean wrapper around TradingAgents that preserves 100% original logic.
    
    Responsibilities:
    - Initialize TradingAgents with config
    - Emit progress events for UI
    - Stream logs to console
    - Return original decision + state (unmodified)
    

    Does NOT:
    - Modify TradingAgents prompts or graph
    - Override or reinterpret the decision
    - Gate execution on derived fields
    """
    
    def __init__(
        self,
        config: Optional[Dict[str, Any]] = None,
        event_callback: Optional[Callable[[Dict], None]] = None,
        **kwargs,
    ):
        self.config_snapshot: Optional[Dict[str, Any]] = config
        self.event_callback = event_callback
        self.research_depth = str(kwargs.get("research_depth") or "standard").strip().lower()
        
        
        self._current_cycle: Optional[int] = None
        self._current_ticker: Optional[str] = None
        self._current_date: Optional[str] = None
        self._current_phase: Optional[str] = None
        self._seen_nodes: set = set()
        self._seen_tool_nodes: set = set()
        self._completed_agents: set = set()
        self._best_report_by_agent: Dict[str, Dict[str, Any]] = {}
        self._started_phases: set = set()
        self._llm_call_count: int = 0
        self._tool_call_count: int = 0
        self._abort_event = threading.Event()
        self._run_id: Optional[str] = None
        self._graph_chunk_tasks: set = set()
        self._last_event_time: float = 0.0
        self._keepalive_interval: float = 30.0  # seconds
        self._current_agent: Optional[str] = None
        self._current_tool: Optional[str] = None
        self._retry_count: int = 0
        self._max_retries: int = 3  # Default, can be overridden by config
        
        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            self.loop = asyncio.get_event_loop()
        
        # Ensure TA_PATH exists and is absolute
        if not TA_PATH.exists():
            print(f"[TA] CRITICAL: trading_agents_ref NOT FOUND at {TA_PATH}")

    @property
    def is_aborted(self) -> bool:
        return self._abort_event.is_set() or is_abort_requested(self._run_id)

    def abort(self) -> None:
        """Signal the runner to stop emitting new work/results."""
        self._abort_event.set()
        self._request_cancel_graph_tasks()

    def _request_cancel_graph_tasks(self) -> None:
        if not self._graph_chunk_tasks:
            return
        try:
            self.loop.call_soon_threadsafe(self._cancel_graph_chunk_tasks_sync)
        except Exception:
            pass

    def _cancel_graph_chunk_tasks_sync(self) -> None:
        for task in list(self._graph_chunk_tasks):
            if not task.done():
                task.cancel()
        
    async def _emit_event(
        self,
        event_type: str,
        phase: str,
        message: str,
        agent: Optional[str] = None,
        raw_excerpt: Optional[str] = None,
        decision: Optional[str] = None,
        current_step: Optional[str] = None,
        progress: float = 0.0,
        source: str = "tradingagents",
        **kwargs,
    ):
        """Emit normalized event for Metro Flow / Console / Showrunner.
        
        Format compatible with existing UnifiedPipeline events.
        Event callback must be PASSIVE (observability only) - never affects logic.
        """
        if self.is_aborted and event_type not in {"run_aborted", "run_failed"}:
            return
        
        # Map TradingAgents phases to existing UnifiedPipeline phases
        phase_map = {
            "init": "data_collection",
            "analysts": "agent_analysis",
            "researchers": "agent_analysis",
            "trader": "final_decision",
            "risk": "final_decision",
            "portfolio": "final_decision",
        }
        
        unified_phase = phase_map.get(phase, "agent_analysis")
        
        # Generate run_id for replay/history/showrunner
        run_id = self._run_id or f"cycle-{self._current_cycle}-{self._current_ticker}-{datetime.utcnow().strftime('%Y%m%d')}"
        
        event = {
            # VERSIONING (for replay/history/showrunner)
            "schema_version": 1,
            "run_id": run_id,
            "source": source,
            
            # Standard UnifiedPipeline format
            "type": event_type.lower(),
            "phase": unified_phase,
            "sub_phase": phase,
            "current_step": current_step,  # NEW: for two-layer rendering
            "agent": agent,
            "action": message.lower().replace(" ", "_"),
            "ticker": self._current_ticker,
            "cycle": self._current_cycle,
            "progress": progress,
            
            # TradingAgents-specific metadata
            "pipeline_mode": "tradingagents",
            "research_depth": self.research_depth,
            "message": message,
            "raw_excerpt": raw_excerpt[:200] if raw_excerpt else None,
            "decision": decision,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "llm_calls": self._llm_call_count,
            "tool_calls": self._tool_call_count,
            
            # Station assignment (for animation sync)
            "station": self._get_station_for_agent(agent),
            "animation": self._get_animation_for_station(self._get_station_for_agent(agent)),
            "highlight": True if event_type == "agent_completed" else False
        }
        
        # Merge additional metadata (prediction, confidence, etc.)
        event.update(kwargs)
        
        if self.event_callback:
            if asyncio.iscoroutinefunction(self.event_callback):
                await self.event_callback(event)
            else:
                self.event_callback(event)
    
    def _get_station_for_agent(self, agent: Optional[str]) -> str:
        """Map TradingAgents agent to existing station assignments."""
        agent_key = normalize_tradingagents_agent_id(agent)

        station_map = {
            "market_analyst": "scanner",
            "social_analyst": "cooler",
            "news_analyst": "newsstand",
            "fundamentals_analyst": "desk",
            "bull_researcher": "table",
            "bear_researcher": "table",
            "research_manager": "table",
            "aggressive_analyst": "tv",
            "conservative_analyst": "tv",
            "neutral_analyst": "tv",
            "trader": "ticker",
            "risk_judge": "ticker",
        }

        return station_map.get(agent_key or "", "desk")
    
    def _get_animation_for_station(self, station: str) -> str:
        """Map station to animation (from existing STATION_ANIMATIONS)."""
        
        animation_map = {
            "scanner": "sit_type",
            "desk": "sit_back",
            "tv": "read",
            "cooler": "drink",
            "table": "talk",
        }
        
        return animation_map.get(station, "idle")
    
    def _get_phase_from_sender(self, sender: str) -> str:
        """Map TradingAgents internal sender to phase name."""

        phase_map = {
            "Market Analyst": "analysts",
            "Social Analyst": "analysts",
            "News Analyst": "analysts",
            "Fundamentals Analyst": "analysts",
            "Bull Researcher": "researchers",
            "Bear Researcher": "researchers",
            "Research Manager": "researchers",
            "Aggressive Analyst": "risk",
            "Conservative Analyst": "risk",
            "Neutral Analyst": "risk",
            "Trader": "trader",
            "Risk Judge": "portfolio",
        }

        return phase_map.get(sender, "unknown")

    def _has_meaningful_output(self, value: Any) -> bool:
        if value is None:
            return False
        if isinstance(value, str):
            return bool(value.strip())
        if isinstance(value, dict):
            return any(self._has_meaningful_output(v) for v in value.values())
        if isinstance(value, (list, tuple, set)):
            return any(self._has_meaningful_output(v) for v in value)
        return bool(value)

    def _extract_report_text(self, value: Any, allow_summary: bool = False) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, (int, float, bool)):
            return str(value).strip()
        if isinstance(value, list):
            parts = [
                self._extract_report_text(item, allow_summary=allow_summary)
                for item in value
            ]
            parts = [p for p in parts if p]
            if not parts:
                return ""
            best_text = ""
            best_score = -1
            for candidate in parts:
                if not candidate:
                    continue
                if self._display_ready_report(candidate):
                    score = self._report_quality(candidate)
                    if score > best_score:
                        best_score = score
                        best_text = candidate
            if best_text:
                return best_text.strip()
            return max(parts, key=lambda item: len(str(item).strip())).strip()
        if isinstance(value, dict):
            candidate_keys = [
                "report",
                "final_trade_decision",
                "final_decision",
                "judge_decision",
                "current_response",
                "reasoning",
                "content",
                "text",
                "message",
                "output",
                "analysis",
                "decision",
            ]
            if allow_summary:
                candidate_keys.append("summary")
            for key in candidate_keys:
                if key in value:
                    nested = self._extract_report_text(value.get(key), allow_summary=allow_summary)
                    if nested:
                        return nested
        return ""

    def _looks_like_tool_noise(self, text: str) -> bool:
        value = str(text or "")
        if not value.strip():
            return True
        if re.search(r"final\s+(?:recommendation|transaction\s+proposal)|\bbuy\b|\bsell\b|\bhold\b|\bliquidate\b", value, re.IGNORECASE):
            return False
        return bool(re.search(r"i[’']?ll\s+try|i[’']?ll\s+try\s+a\s+different|let\s+me\s+correct|i[’']?ll\s+help\s+you\s+conduct|<tool_call>|[\"']name[\"']\s*:|[\"']parameters[\"']\s*:", value, re.IGNORECASE))

    def _looks_like_draft_scaffold(self, text: str) -> bool:
        value = str(text or "")
        return bool(re.search(
            r"now\s+that\s+i\s+have|i\s+see\s+you(?:['’]ve|\s+have)\s+provided|let\s+me\s+consolidate|let\s+me\s+gather|let\s+me\s+(?:attempt|reattempt)|it\s+appears\s+that\s+no\s+financial\s+statement\s+data\s+is\s+available|i\s+will\s+execute\s+the\s+required\s+tool\s+call\s+first",
            value,
            re.IGNORECASE,
        ))

    def _is_header_only_report(self, text: str) -> bool:
        cleaned = str(text or "").strip()
        if not cleaned:
            return True
        lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
        if not lines:
            return True
        header_pattern = re.compile(
            r"^FINAL\s+(?:RECOMMENDATION|TRANSACTION\s+PROPOSAL|ACTION)\s*[:\-\s]*\**\s*(BUY|SELL|HOLD|LIQUIDATE|NEUTRAL)?\**$",
            re.IGNORECASE,
        )
        if len(lines) == 1 and header_pattern.match(lines[0]):
            return True
        if len(lines) == 2 and header_pattern.match(lines[0]) and len(lines[1]) < 20:
            return True
        return False

    def _display_ready_report(self, text: str) -> bool:
        if not text or not str(text).strip():
            return False
        cleaned = str(text)
        cleaned = re.sub(r"```[\s\S]*?```", "\n", cleaned)
        cleaned = re.sub(r"<tool_call>[\s\S]*?<\/tool_call>", "\n", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\{\s*\"name\"\s*:[\s\S]*?\}", "\n", cleaned)
        cleaned = re.sub(r"\{\s*\"parameters\"\s*:[\s\S]*?\}", "\n", cleaned)
        cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
        if not cleaned:
            return False
        if self._is_header_only_report(cleaned):
            return False
        if re.search(r'^\s*[\{\[]', cleaned.strip()) and re.search(r'["\']name["\']\s*:', cleaned):
            return False
        lowered = cleaned.lower()
        if any(phrase in lowered for phrase in ("i'll try", "let me help", "i'll help you", "i will try", "i'll try a different", "i’ll try", "i’ll help you")):
            return False
        sentence_count = len(re.findall(r"[.!?]", cleaned))
        line_breaks = cleaned.count("\n")
        has_structure = (
            len(cleaned.strip()) >= 400 or
            line_breaks >= 3 or
            bool(re.search(r"\n\s*(?:[-*•]|\d+\.)\s+", cleaned)) or
            bool(re.search(r"^#{1,6}\s+", cleaned, re.MULTILINE))
        )
        if self._looks_like_tool_noise(text) and not has_structure:
            return False
        if self._looks_like_draft_scaffold(cleaned) and not has_structure:
            return False
        if (
            len(cleaned.strip()) < 80
            and not re.search(r"\n\s*(?:[-*•]|\d+\.)\s+", cleaned)
            and line_breaks < 1
            and sentence_count < 1
        ):
            return False
        return True

    def _report_quality(self, text: str) -> int:
        if not text:
            return 0
        length_score = len(text.strip())
        lines = text.splitlines()
        bonus = 0
        if re.search(r"\baction\s+plan\b|\bexecutive\s+summary\b", text, re.IGNORECASE):
            bonus += 200
        if len(lines) >= 4:
            bonus += 50
        if re.search(r"\n\s*(?:[-*•]|\d+\.)\s+", text):
            bonus += 50
        return length_score + bonus

    def _stringify_output(self, value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, (dict, list)):
            try:
                return json.dumps(value, ensure_ascii=True, default=str)
            except Exception:
                return str(value)
        return str(value).strip()

    def _coerce_mapping(self, value: Any) -> Dict[str, Any]:
        if isinstance(value, dict):
            return value
        if hasattr(value, "items"):
            try:
                return dict(value.items())
            except Exception:
                return {}
        return {}

    def _merge_patch_into_state(self, full_state: Dict[str, Any], patch: Dict[str, Any]) -> None:
        for key, value in patch.items():
            if (
                key in full_state
                and isinstance(full_state[key], list)
                and isinstance(value, list)
            ):
                full_state[key].extend(value)
            elif (
                key in full_state
                and isinstance(full_state[key], dict)
                and isinstance(value, dict)
            ):
                merged = dict(full_state[key])
                merged.update(value)
                full_state[key] = merged
            else:
                full_state[key] = value

    async def _emit_phase_scene_start(self, phase_key: str) -> None:
        if phase_key in self._started_phases:
            return

        phase_defs = {
            "STEP_1_ANALYSTS": {
                "lead": "Market Analyst",
                "message": "Analyst Team started",
            },
            "STEP_2_RESEARCH": {
                "lead": "Bull Researcher",
                "message": "Research Team started",
            },
            "STEP_3_TRADER": {
                "lead": "Trader",
                "message": "Trader started",
            },
            "STEP_4_RISK": {
                "lead": "Aggressive Analyst",
                "message": "Risk Management started",
            },
            "STEP_5_PORTFOLIO": {
                "lead": "Risk Judge",
                "message": "Portfolio Management started",
            },
        }

        phase_def = phase_defs.get(phase_key)
        if not phase_def:
            return

        lead_name = phase_def["lead"]
        lead_id = normalize_tradingagents_agent_id(lead_name)
        if not lead_id:
            return

        self._started_phases.add(phase_key)
        working_text = f"{lead_name} is working the {phase_key.lower()} step."

        print(f"\n{'='*20} {phase_key} START {'='*20}")
        print(f"[{lead_name}] {phase_def['message']}")
        print(working_text)
        print(f"{'='*50}\n")

        await self._emit_event(
            event_type="agent_action",
            phase=self._get_phase_from_sender(lead_name),
            agent=lead_id,
            current_step=lead_id,
            message=phase_def["message"],
            raw_excerpt=working_text,
            phase_num=TRADINGAGENTS_PHASE_NUMBERS.get(lead_id, 0),
            agent_display_name=lead_name,
            scene_stage="start",
            status="working",
            highlight=True,
        )

    async def _emit_agent_completion_from_output(
        self,
        agent_name: str,
        output: Any,
    ) -> None:
        agent_id = normalize_tradingagents_agent_id(agent_name)
        if not agent_id:
            return

        report_content_str = self._extract_report_text(output, allow_summary=False)
        if not self._display_ready_report(report_content_str):
            return

        score = self._report_quality(report_content_str)
        existing = self._best_report_by_agent.get(agent_id)
        if existing:
            existing_score = existing.get("score", 0)
            existing_text = existing.get("text", "")
            if score <= existing_score and report_content_str.strip() == str(existing_text).strip():
                return
            if score <= existing_score:
                return

        self._best_report_by_agent[agent_id] = {
            "score": score,
            "text": report_content_str,
        }
        self._completed_agents.add(agent_id)
        self._llm_call_count += 1

        try:
            excerpt = report_content_str.strip().replace("\r", " ")
            if len(excerpt) > 240:
                excerpt = excerpt[:237].rstrip() + "..."
            safe_excerpt = excerpt.encode("ascii", "replace").decode("ascii")
            logger.info("[TA] %s analysis complete (score=%s, run_id=%s): %s", agent_name, score, self._run_id, safe_excerpt)
        except Exception:
            pass

        await self._emit_event(
            event_type="agent_completed",
            phase=self._get_phase_from_sender(agent_name),
            agent=agent_id,
            current_step=agent_id,
            message=f"{agent_name} analysis complete",
            raw_excerpt=report_content_str[:500],
            report=report_content_str,
            phase_num=TRADINGAGENTS_PHASE_NUMBERS.get(agent_id or "", 0),
            agent_display_name=agent_name,
        )

    async def _process_tool_chunk(self, node_name: str, node_state: Any) -> None:
        if not isinstance(node_name, str) or not node_name.startswith("tools_"):
            return
        if node_name in self._seen_tool_nodes:
            return

        self._seen_tool_nodes.add(node_name)
        self._tool_call_count += 1

        tool_agent_map = {
            "tools_market": "Market Analyst",
            "tools_social": "Social Analyst",
            "tools_news": "News Analyst",
            "tools_fundamentals": "Fundamentals Analyst",
        }
        agent_name = tool_agent_map.get(node_name)
        agent_id = normalize_tradingagents_agent_id(agent_name) if agent_name else None
        
        # Track current agent and tool for keepalive events
        if agent_id:
            self._current_agent = agent_id
        self._current_tool = node_name
        
        message = f"{agent_name or node_name} tool pass"
        tool_excerpt = self._stringify_output(node_state)[:200]

        print(f"\n{'='*20} TOOL CALL {'='*20}")
        print(f"[{node_name}] {message}")
        if tool_excerpt:
            print(tool_excerpt)
        print(f"{'='*50}\n")

        await self._emit_event(
            event_type="tool_call",
            phase=self._get_phase_from_sender(agent_name) if agent_name else (self._current_phase or "analysts"),
            agent=agent_id,
            current_step=agent_id,
            message=message,
            raw_excerpt=tool_excerpt or None,
            tool_node=node_name,
            status="running",
            highlight=False,
        )

    async def _process_state_patch(self, patch: Dict[str, Any], full_state: Dict[str, Any]) -> None:
        if not isinstance(patch, dict):
            return

        report_mappings = {
            "market_report": "Market Analyst",
            "sentiment_report": "Social Analyst",
            "news_report": "News Analyst",
            "fundamentals_report": "Fundamentals Analyst",
            "trader_investment_plan": "Trader",
        }

        for report_key, agent_name in report_mappings.items():
            report_value = full_state.get(report_key, patch.get(report_key))
            if not self._has_meaningful_output(report_value):
                continue
            await self._emit_agent_completion_from_output(agent_name, report_value)
            if report_key == "fundamentals_report":
                await self._emit_phase_scene_start("STEP_2_RESEARCH")
            elif report_key == "trader_investment_plan":
                await self._emit_phase_scene_start("STEP_4_RISK")

        invest_state = self._coerce_mapping(
            full_state.get("investment_debate_state", patch.get("investment_debate_state"))
        )
        if invest_state:
            bull_history = invest_state.get("bull_history")
            bear_history = invest_state.get("bear_history")
            research_judge = invest_state.get("judge_decision")

            if self._has_meaningful_output(bull_history):
                await self._emit_agent_completion_from_output("Bull Researcher", bull_history)
            if self._has_meaningful_output(bear_history):
                await self._emit_agent_completion_from_output("Bear Researcher", bear_history)
            if self._has_meaningful_output(research_judge):
                await self._emit_agent_completion_from_output("Research Manager", research_judge)
                await self._emit_phase_scene_start("STEP_3_TRADER")

        risk_state = self._coerce_mapping(
            full_state.get("risk_debate_state", patch.get("risk_debate_state"))
        )
        if risk_state:
            if self._has_meaningful_output(risk_state.get("aggressive_history")):
                await self._emit_agent_completion_from_output(
                    "Aggressive Analyst",
                    risk_state.get("aggressive_history"),
                )
            if self._has_meaningful_output(risk_state.get("conservative_history")):
                await self._emit_agent_completion_from_output(
                    "Conservative Analyst",
                    risk_state.get("conservative_history"),
                )
            if self._has_meaningful_output(risk_state.get("neutral_history")):
                await self._emit_agent_completion_from_output(
                    "Neutral Analyst",
                    risk_state.get("neutral_history"),
                )
            if (
                self._has_meaningful_output(risk_state.get("aggressive_history"))
                and self._has_meaningful_output(risk_state.get("conservative_history"))
                and self._has_meaningful_output(risk_state.get("neutral_history"))
            ):
                await self._emit_phase_scene_start("STEP_5_PORTFOLIO")
            if self._has_meaningful_output(risk_state.get("judge_decision")):
                await self._emit_phase_scene_start("STEP_5_PORTFOLIO")
                await self._emit_agent_completion_from_output(
                    "Risk Judge",
                    risk_state.get("judge_decision"),
                )

    async def _process_node_chunk(self, node_name: str, node_state: Dict, full_state: Dict):
        """Process a single graph node chunk and emit corresponding UI events."""
        if self.is_aborted:
            return
        if not isinstance(node_state, dict):
            return

        # Only emit progress for canonical TradingAgents (skip tool/clear nodes)
        agent_id = normalize_tradingagents_agent_id(node_name)
        if not agent_id:
            return
        
        # Track current agent for keepalive events
        # Clear current_tool since we've moved to agent processing
        self._current_agent = agent_id
        self._current_tool = None

        if agent_id not in self._seen_nodes:
            self._seen_nodes.add(agent_id)
            working_text = f"{node_name} is analyzing {self._current_ticker or 'the active ticker'}."
            await self._emit_event(
                event_type="agent_action",
                phase=self._get_phase_from_sender(node_name),
                agent=agent_id,
                current_step=agent_id,
                message=f"{node_name} started",
                raw_excerpt=working_text,
                phase_num=TRADINGAGENTS_PHASE_NUMBERS.get(agent_id or "", 0),
                agent_display_name=node_name,
                scene_stage="start",
                status="working",
                highlight=True,
            )
        
        # 1. Map report keys
        report_keys = {
            "Market Analyst": "market_report",
            "Social Analyst": "sentiment_report",
            "News Analyst": "news_report",
            "Fundamentals Analyst": "fundamentals_report",
            "Bull Researcher": "bull_report",
            "Bear Researcher": "bear_report",
            "Research Manager": "investment_plan",
            "Aggressive Analyst": "aggressive_report",
            "Conservative Analyst": "conservative_report",
            "Neutral Analyst": "neutral_report",
            "Risk Judge": "risk_report",
            "Trader": "trader_investment_plan",
        }
        
        report_key = report_keys.get(node_name)
        report_content = node_state.get(report_key) if report_key else None
        if not self._has_meaningful_output(report_content):
            return

        await self._emit_agent_completion_from_output(node_name, report_content)
    
    async def run(
        self,
        ticker: str,
        trade_date: str,
        cycle: int = 1,
        run_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Run TradingAgents analysis.
        """
        self._current_ticker = ticker
        self._current_cycle = int(cycle)
        self._current_date = trade_date
        self._seen_nodes = set()  # Reset node tracking for new run
        self._seen_tool_nodes = set()
        self._completed_agents = set()
        self._best_report_by_agent = {}
        self._started_phases = set()
        self._llm_call_count = 0
        self._tool_call_count = 0
        self._abort_event.clear()
        self._graph_chunk_tasks = set()
        
        # Generate consistent run_id
        self._run_id = run_id or build_tradingagents_run_id(
            ticker,
            trade_date,
            cycle=cycle,
            prefix="ta",
        )
        
        # Set active run ID if possible (for telemetry capture)
        try:
            from src.api.trading_floor_simple import pipeline_state
            pipeline_state["active_run_id"] = self._run_id
            pipeline_state["status"] = "INITIALIZING..."
            pipeline_state["phase"] = "init"
            pipeline_state["phase_num"] = 1
        except Exception:
            pass
        
        start_time = datetime.utcnow()
        
        # Emit pipeline start
        await self._emit_event(
            event_type="pipeline_start",
            phase="init",
            message=f"Starting TradingAgents analysis for {ticker}",
        )
        await self._emit_phase_scene_start("STEP_1_ANALYSTS")
        
        # 1. Resolve Configuration (preserve all original settings)
        config = DEFAULT_CONFIG.copy()
        
        # If we have a snapshot, use it
        if self.config_snapshot:
            # Map UI keys to TradingAgents keys
            snap = self.config_snapshot
            if snap and isinstance(snap, dict):
                inner_mapping = {
                    "llm_provider": "llm_provider",
                    "deep_model": "deep_think_llm",
                    "quick_model": "quick_think_llm",
                    "max_debate_rounds": "max_debate_rounds"
                }
                for src_key, dst_key in inner_mapping.items():
                    if src_key in snap:
                        config[dst_key] = snap[src_key]
                
                # Allow direct keys
                for k, v in snap.items():
                    if k in config:
                        config[k] = v
        
        # 2. Sanitize Ticker (Prevent duplication like NVDANVDA)
        if ticker:
            # Simple heuristic: if the first half is same as second half
            mid = len(ticker) // 2
            if len(ticker) > 2 and ticker[:mid] == ticker[mid:]:
                print(f"[TA] Sanitizing doubled ticker: {ticker} -> {ticker[:mid]}")
                ticker = ticker[:mid]
            self._current_ticker = ticker

        # 3. Apply Model Fallbacks (Ollama Safety)
        if config.get("llm_provider") == "ollama":
            try:
                import httpx
                # Robust availability check (ASYNC to prevent event loop lag)
                async with httpx.AsyncClient() as client:
                    resp = await client.get(f"{_resolve_ollama_root_url()}/api/tags", timeout=1.5)
                    if resp.status_code == 200:
                        available_models = [m["name"] for m in resp.json().get("models", [])]
                        
                        # Check and fallback
                        for m_key in ["deep_think_llm", "quick_think_llm"]:
                            curr = config.get(m_key)
                            if curr and curr not in available_models:
                                # Try to find a sensible fallback in available models
                                fallback = next((m for m in available_models if "mistral" in m or "llama" in m), available_models[0] if available_models else "mistral:7b")
                                print(f"[TA] Model '{curr}' not found. Falling back to '{fallback}'")
                                config[m_key] = fallback
                    else:
                        print(f"[TA] Ollama check failed with status {resp.status_code}")
            except Exception as e:
                print(f"[TA] Ollama fallback check skip: {e}")
                if config.get("deep_think_llm") == "qwen2.5-7b-instruct-1m":
                    config["deep_think_llm"] = "mistral:7b"

        # 4. Depth-driven debate configuration
        depth_rounds = {
            "quick": 1,
            "standard": 3,
            "deep": 5,
        }
        rounds = depth_rounds.get(self.research_depth, depth_rounds["standard"])
        config["max_debate_rounds"] = rounds
        config["max_risk_discuss_rounds"] = rounds

        # Guard against indefinite local-provider hangs.
        # These values are honored by TradingAgentsGraph -> LLM client construction.
        if str(config.get("llm_provider", "")).lower() == "ollama":
            config["backend_url"] = config.get("backend_url") or _resolve_ollama_backend_url()
            timeout_env = os.getenv("TA_OLLAMA_TIMEOUT_SECONDS") or os.getenv("TA_LLM_TIMEOUT_SECONDS")
            retries_env = os.getenv("TA_OLLAMA_MAX_RETRIES") or os.getenv("TA_LLM_MAX_RETRIES")
            if config.get("timeout") is None and config.get("llm_timeout_seconds") is None:
                inferred_timeout = _infer_local_model_timeout_seconds(
                    config.get("quick_think_llm"),
                    config.get("deep_think_llm"),
                )
                try:
                    config["llm_timeout_seconds"] = float(timeout_env) if timeout_env else inferred_timeout
                except (TypeError, ValueError):
                    config["llm_timeout_seconds"] = inferred_timeout
            if config.get("max_retries") is None and config.get("llm_max_retries") is None:
                try:
                    config["llm_max_retries"] = int(retries_env) if retries_env else 1
                except (TypeError, ValueError):
                    config["llm_max_retries"] = 1
        
        # Initialize TradingAgents (unchanged from original)
        await self._emit_event(
            event_type="phase_start",
            phase="init",
            message="Initializing TradingAgents framework",
        )
        TradingAgentsGraph = _load_tradingagents_graph()
        ta = TradingAgentsGraph(debug=True, config=config)
        
        # Run propagate (this is the core TradingAgents logic - UNCHANGED)
        # In debug mode, TradingAgents prints progress naturally
        # We capture that via the debug stream
        
        await self._emit_event(
            event_type="phase_start",
            phase="analysts",
            message="Starting analyst team",
        )
        
        self._current_phase = "analysts"
        
        # 3. RUN WITH NON-BLOCKING STREAMING (Keeps UI responsive)
        init_agent_state = ta.propagator.create_initial_state(ticker, trade_date)
        args = ta.propagator.get_graph_args()
        # USE updates mode to ensure we only get events for nodes that actually execute/complete
        args["stream_mode"] = "updates"
        
        # We'll use a local full_state that we update as we go
        full_state = init_agent_state.copy()
        
        # Helper to process chunk on main loop - ensures thread-safe state merging & event emission
        async def _handle_graph_chunk_async(chunk: Any):
            # Normalize chunk: some versions stream a list, others a dict
            sub_chunks = chunk if isinstance(chunk, list) else [chunk]
            for sc in sub_chunks:
                if isinstance(sc, tuple) and len(sc) == 2 and isinstance(sc[0], str):
                    sc = {"node": sc[0], "state": sc[1]}
                if not isinstance(sc, dict):
                    continue

                node_items = None
                if isinstance(sc.get("node"), str) and "state" in sc:
                    node_items = [(sc["node"], sc.get("state"))]
                else:
                    top_level_keys = [key for key in sc.keys() if key != "__end__"]
                    is_node_update = any(
                        normalize_tradingagents_agent_id(key)
                        or (isinstance(key, str) and (key.startswith("tools_") or key.startswith("Msg Clear")))
                        for key in top_level_keys
                    )
                    if is_node_update:
                        node_items = list(sc.items())

                if node_items is None:
                    self._merge_patch_into_state(full_state, sc)
                    await self._process_state_patch(sc, full_state)
                    continue

                for node_name, node_state in node_items:
                    if node_name == "__end__":
                        continue

                    if isinstance(node_state, dict):
                        self._merge_patch_into_state(full_state, node_state)
                        await self._process_state_patch(node_state, full_state)
                    else:
                        full_state[node_name] = node_state

                    if isinstance(node_name, str) and node_name.startswith("tools_"):
                        await self._process_tool_chunk(node_name, node_state)
                        continue

                    # Emit granular UI events IMMEDIATELY
                    await self._process_node_chunk(node_name, node_state, full_state)

        stream_error: Optional[Exception] = None
        self._last_event_time = time.time()

        async def _emit_keepalive(elapsed: float) -> None:
            """Emit a keepalive event to inform the UI the pipeline is still running.
            
            Includes detailed context about:
            - Which agent is currently running
            - Which tool (if any) is being called
            - How long since the last event
            - Current retry attempt (if applicable)
            """
            # Build informative message based on current state
            if self._current_agent and self._current_tool:
                message = f"{self._current_agent} calling {self._current_tool}... ({int(elapsed)}s)"
            elif self._current_agent:
                message = f"{self._current_agent} is analyzing... ({int(elapsed)}s)"
            else:
                message = f"Pipeline is running... waiting for response ({int(elapsed)}s)"
            
            # Add retry context if applicable
            if self._retry_count > 0:
                message += f" [Attempt {self._retry_count}/{self._max_retries}]"
            
            await self._emit_event(
                event_type="keepalive",
                phase=self._current_phase or "unknown",
                message=message,
                agent=self._current_agent,
                elapsed_since_last_event=int(elapsed),
                current_agent=self._current_agent,
                current_phase=self._current_phase,
                current_tool=self._current_tool,
                retry_count=self._retry_count,
                max_retries=self._max_retries,
            )

        def stream_graph_in_thread():
            """Iterate the graph in a worker thread with backpressure into the event loop.
            
            Includes keepalive mechanism: if no events received for 30 seconds,
            emits a keepalive event to prevent UI from appearing frozen.
            """
            nonlocal stream_error
            stream_iter = None
            try:
                stream_iter = ta.graph.stream(init_agent_state, **args)
                for chunk in stream_iter:
                    if self.is_aborted:
                        break
                    
                    # Update last event time before processing
                    self._last_event_time = time.time()
                    
                    future = asyncio.run_coroutine_threadsafe(
                        _handle_graph_chunk_async(chunk),
                        self.loop,
                    )
                    try:
                        future.result(timeout=180)
                    except concurrent.futures.CancelledError:
                        return
                    except concurrent.futures.TimeoutError as exc:
                        logger.warning("[TA] Graph chunk processing timed out: %s", exc)
                        future.cancel()
                        raise
            except Exception as e:
                stream_error = e
                print(f"[TA] Graph streaming error: {e}")
                import traceback
                traceback.print_exc()
            finally:
                if self.is_aborted and hasattr(stream_iter, "close"):
                    try:
                        stream_iter.close()
                    except Exception:
                        pass

        print(f"\n{'='*20} PIPELINE ACTIVE (STREAMING) {'='*20}")
        print(f"Ticker: {ticker} | Date: {trade_date}")
        print(f"{'='*57}\n")

        # Start streaming in a managed background thread
        # This will complete when the generator is exhausted, but chunks arrive real-time
        # Also run keepalive monitor to emit events during long-running operations
        stream_task = asyncio.create_task(asyncio.to_thread(stream_graph_in_thread))
        
        async def keepalive_monitor():
            """Monitor the stream and emit keepalive events when no events received."""
            while not stream_task.done():
                await asyncio.sleep(self._keepalive_interval)
                if stream_task.done():
                    break
                elapsed = time.time() - self._last_event_time
                if elapsed >= self._keepalive_interval:
                    await _emit_keepalive(elapsed)
        
        keepalive_task = asyncio.create_task(keepalive_monitor())
        
        try:
            await stream_task
        finally:
            keepalive_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await keepalive_task
            if self.is_aborted and self._graph_chunk_tasks:
                self._cancel_graph_chunk_tasks_sync()
            if self._graph_chunk_tasks:
                with contextlib.suppress(Exception):
                    await asyncio.gather(*self._graph_chunk_tasks, return_exceptions=True)

        if stream_error is not None:
            raise RuntimeError(f"TradingAgents graph stream failed: {stream_error}") from stream_error

        if self.is_aborted:
            raise asyncio.CancelledError("TradingAgents run aborted")

        elapsed = (datetime.utcnow() - start_time).total_seconds()

        # Final decision extracted from state (replicates self.process_signal)
        decision = ta.process_signal(full_state.get("final_trade_decision", "HOLD"))
        state = full_state
        
        # Synthesize prediction and confidence for UI
        portfolio_state = state.get("portfolio_manager", {})
        confidence = float(portfolio_state.get("confidence", 0.0) or 0.0)
        prediction = str(state.get("final_trade_decision", "HOLD Signal"))
        try:
            adapted = adapt_decision({
                "ticker": ticker,
                "trade_date": trade_date,
                "status": "success",
                "decision": decision,
                "state": state,
                "elapsed_seconds": 0,
                "latency_ms": 0,
            })
            if confidence <= 0 or abs(confidence - 0.5) < 1e-6:
                confidence = float(adapted.get("confidence", 0.5) or 0.5)
            prediction = str(adapted.get("thesis") or prediction)
        except Exception:
            confidence = confidence or 0.5
        
        # Emit final decision event
        await self._emit_event(
            event_type="final_decision",
            phase="trader",
            message=f"Final action: {decision}",
            decision=decision,
            prediction=prediction,
            confidence=confidence,
        )
        
        # Emit run_completed event to signal UI to stop "Processing..."
        await self._emit_event(
            event_type="run_completed",
            phase="complete",
            message=f"TradingAgents analysis complete for {ticker}",
            decision=decision,
            prediction=prediction,
            confidence=confidence,
            elapsed_seconds=elapsed,
            run_id=run_id,
        )
        
        # Return FULL result (DO NOT REDUCE to just decision)
        # State contains analyst reports, debate logs, risk review - valuable for UI/replay
        return {
            "ticker": ticker,
            "trade_date": trade_date,
            "decision": decision,  # TradingAgents direction (BUY/SELL/HOLD)
            "prediction": prediction,
            "confidence": confidence,
            "research_depth": self.research_depth,
            "state": state,        # FULL TradingAgents state - DO NOT REDUCE
            "full_agent_reports": {
                agent_id: report.get("text")
                for agent_id, report in self._best_report_by_agent.items()
                if report.get("text")
            },
            "elapsed_seconds": elapsed,
            "cycle": cycle,        # Use formal cycle
            "run_id": run_id,      # For replay/history/showrunner
            
            # REMINDER: Execution semantics (position sizing, risk caps) 
            # are handled by our app, NOT TradingAgents
        }


# Example usage
if __name__ == "__main__":
    def print_event(event):
        print(f"[{event['type']}] {event['phase']}: {event['message']}")
    
    runner = TradingAgentsRunner(
        research_depth="quick",
        event_callback=print_event,
    )
    
    result = asyncio.run(runner.run("NVDA", "2026-03-24", cycle=1))
    
    print("\n" + "="*80)
    print("FINAL RESULT (100% original TradingAgents output)")
    print("="*80)
    print(f"Ticker: {result['ticker']}")
    print(f"Decision: {result['decision']}")
    print(f"Elapsed: {result['elapsed_seconds']:.2f}s")
    print("\nState keys:", list(result['state'].keys()))
