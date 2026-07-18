from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import signal
import sys
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

# Use the single mounted TradingAgents source path.
_LOCAL_TA_ROOT = Path(__file__).resolve().parents[1] / "TradingAgents-original"  # /workspace/src/TradingAgents-original
if _LOCAL_TA_ROOT.exists():
    sys.path.insert(0, str(_LOCAL_TA_ROOT))

from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.trading_graph import TradingAgentsGraph


def _configure_network_tls_for_container() -> None:
    # Keep strict parity on the execution path, but harden network env so
    # yfinance/provider calls work in Docker hosts with broken CA chains.
    try:
        import certifi  # type: ignore

        ca_bundle = str(certifi.where() or "").strip()
    except Exception:
        ca_bundle = ""
    if ca_bundle:
        os.environ.setdefault("SSL_CERT_FILE", ca_bundle)
        os.environ.setdefault("REQUESTS_CA_BUNDLE", ca_bundle)
        os.environ.setdefault("CURL_CA_BUNDLE", ca_bundle)

    # Prefer non-curl yfinance transport in this environment.
    os.environ.setdefault("YFINANCE_USE_CURL", "False")
    os.environ.setdefault("YF_USE_CURL", "0")

    # Keep insecure TLS opt-in only.
    os.environ.setdefault("TA_INSECURE_SSL", "0")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_default(obj: Any) -> Any:
    """Best-effort serializer for LangChain/graph objects in final_state payloads."""
    if obj is None:
        return None
    if isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (list, tuple, set)):
        return list(obj)
    if isinstance(obj, dict):
        return obj
    for method_name in ("model_dump", "dict"):
        method = getattr(obj, method_name, None)
        if callable(method):
            try:
                return method()
            except Exception:
                pass
    content = getattr(obj, "content", None)
    if content is not None:
        try:
            return str(content)
        except Exception:
            pass
    return repr(obj)


def _parse_research_depth(value: str) -> int:
    raw = str(value or "").strip().lower()
    if raw in {"quick", "shallow"}:
        return 1
    if raw in {"standard", "normal", "medium"}:
        return 3
    if raw in {"deep"}:
        return 5
    try:
        return max(1, int(float(raw)))
    except Exception:
        return 3


def _provider_backend_url(provider: str, default_url: str | None) -> str | None:
    if default_url:
        return default_url
    lookup = {
        "nvidia": "https://integrate.api.nvidia.com/v1",
        "openai": os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1",
        "deepseek": "https://api.deepseek.com",
        "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "openrouter": "https://openrouter.ai/api/v1",
    }
    return lookup.get(str(provider or "").strip().lower())


def _normalize_research_depth(value: str) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"quick", "shallow"}:
        return "quick"
    if raw in {"deep"}:
        return "deep"
    if raw in {"standard", "normal", "medium"}:
        return "standard"
    try:
        numeric = int(float(raw))
    except Exception:
        return "standard"
    if numeric <= 1:
        return "quick"
    if numeric >= 5:
        return "deep"
    return "standard"


def _resolve_max_attempts() -> int:
    try:
        return max(1, int(os.getenv("UPSTREAM_MAX_ATTEMPTS", "3")))
    except Exception:
        return 3


def _resolve_timeout_seconds(depth: str) -> int:
    depth_key = _normalize_research_depth(depth)
    env_key = {
        "quick": "UPSTREAM_TIMEOUT_SECONDS_QUICK",
        "standard": "UPSTREAM_TIMEOUT_SECONDS_STANDARD",
        "deep": "UPSTREAM_TIMEOUT_SECONDS_DEEP",
    }.get(depth_key, "UPSTREAM_TIMEOUT_SECONDS_STANDARD")
    env_value = os.getenv(env_key)
    if env_value:
        try:
            return max(60, int(float(env_value)))
        except Exception:
            pass
    defaults = {
        "quick": 40 * 60,
        "standard": 55 * 60,
        "deep": 80 * 60,
    }
    return defaults.get(depth_key, defaults["standard"])


def _resolve_strict_timeout_seconds(depth: str) -> int:
    depth_key = _normalize_research_depth(depth)
    env_key = {
        "quick": "UPSTREAM_STRICT_TIMEOUT_SECONDS_QUICK",
        "standard": "UPSTREAM_STRICT_TIMEOUT_SECONDS_STANDARD",
        "deep": "UPSTREAM_STRICT_TIMEOUT_SECONDS_DEEP",
    }.get(depth_key, "UPSTREAM_STRICT_TIMEOUT_SECONDS_STANDARD")
    env_value = os.getenv(env_key) or os.getenv("UPSTREAM_STRICT_TIMEOUT_SECONDS")
    if env_value:
        try:
            return max(60, int(float(env_value)))
        except Exception:
            pass
    defaults = {
        "quick": 12 * 60,
        "standard": 20 * 60,
        "deep": 30 * 60,
    }
    return defaults.get(depth_key, defaults["standard"])


def _resolve_stall_timeout_seconds(depth: str) -> int:
    depth_key = _normalize_research_depth(depth)
    env_key = {
        "quick": "UPSTREAM_STALL_TIMEOUT_SECONDS_QUICK",
        "standard": "UPSTREAM_STALL_TIMEOUT_SECONDS_STANDARD",
        "deep": "UPSTREAM_STALL_TIMEOUT_SECONDS_DEEP",
    }.get(depth_key, "UPSTREAM_STALL_TIMEOUT_SECONDS_STANDARD")
    env_value = os.getenv(env_key) or os.getenv("UPSTREAM_STALL_TIMEOUT_SECONDS")
    if env_value:
        try:
            return max(30, int(float(env_value)))
        except Exception:
            pass
    defaults = {
        "quick": 15 * 60,
        "standard": 20 * 60,
        "deep": 30 * 60,
    }
    return defaults.get(depth_key, defaults["standard"])


def _retry_backoff_seconds(attempt: int) -> float:
    try:
        base = max(0.25, float(os.getenv("UPSTREAM_RETRY_BACKOFF_BASE_SECONDS", "2.5")))
    except Exception:
        base = 2.5
    try:
        cap = max(base, float(os.getenv("UPSTREAM_RETRY_BACKOFF_MAX_SECONDS", "20.0")))
    except Exception:
        cap = 20.0
    delay = base * (2 ** max(0, attempt - 1))
    return min(delay, cap)


@contextmanager
def _stream_watchdog(wall_timeout_seconds: int, stall_timeout_seconds: int):
    if wall_timeout_seconds <= 0 and stall_timeout_seconds <= 0:
        class _NoopWatchdog:
            @staticmethod
            def touch() -> None:
                return

        yield _NoopWatchdog()
        return
    if not hasattr(signal, "SIGALRM"):
        class _NoopWatchdog:
            @staticmethod
            def touch() -> None:
                return

        yield _NoopWatchdog()
        return

    wall_timeout_seconds = max(0, int(wall_timeout_seconds))
    stall_timeout_seconds = max(0, int(stall_timeout_seconds))
    start_monotonic = time.monotonic()
    wall_deadline_monotonic = (
        start_monotonic + float(wall_timeout_seconds) if wall_timeout_seconds > 0 else None
    )
    last_progress_monotonic = {"value": start_monotonic}
    previous_handler = signal.getsignal(signal.SIGALRM)

    def _seconds_until_next_alarm(now_monotonic: float) -> float | None:
        candidates = []
        if wall_deadline_monotonic is not None:
            candidates.append(wall_deadline_monotonic - now_monotonic)
        if stall_timeout_seconds > 0:
            candidates.append((last_progress_monotonic["value"] + float(stall_timeout_seconds)) - now_monotonic)
        if not candidates:
            return None
        return min(candidates)

    def _arm_next_alarm() -> None:
        next_seconds = _seconds_until_next_alarm(time.monotonic())
        if next_seconds is None:
            return
        signal.setitimer(signal.ITIMER_REAL, max(0.001, float(next_seconds)))

    def _handler(_signum, _frame):
        now_monotonic = time.monotonic()
        if wall_deadline_monotonic is not None and now_monotonic >= wall_deadline_monotonic:
            raise TimeoutError(f"UPSTREAM_TIMEOUT: run exceeded {wall_timeout_seconds}s wall-clock limit.")
        if stall_timeout_seconds > 0 and (
            now_monotonic - last_progress_monotonic["value"] >= float(stall_timeout_seconds)
        ):
            raise TimeoutError(
                f"UPSTREAM_STALLED: no upstream progress for {stall_timeout_seconds}s."
            )
        _arm_next_alarm()

    class _Watchdog:
        @staticmethod
        def touch() -> None:
            if stall_timeout_seconds <= 0:
                return
            last_progress_monotonic["value"] = time.monotonic()
            _arm_next_alarm()

    try:
        signal.signal(signal.SIGALRM, _handler)
        _arm_next_alarm()
        yield _Watchdog()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0.0)
        signal.signal(signal.SIGALRM, previous_handler)


def _normalize_error_code(message: str, tb: str, timeout_hit: bool) -> str:
    combined = f"{message}\n{tb}"
    merged = combined.lower()
    if "upstream_stalled" in merged or "no upstream progress" in merged:
        return "UPSTREAM_STALLED"
    if timeout_hit:
        return "UPSTREAM_TIMEOUT"
    code_match = re.search(
        r"(?:error\s*code|status(?:\s*code)?|http(?:\s*status)?)\s*[:=]?\s*([45]\d{2})\b",
        combined,
        flags=re.IGNORECASE,
    )
    if not code_match:
        code_match = re.search(
            r"\b([45]\d{2})\b\s*(?:server error|bad gateway|gateway timeout|service unavailable|forbidden|unauthorized)",
            combined,
            flags=re.IGNORECASE,
        )
    if code_match:
        return f"HTTP_{code_match.group(1)}"
    if any(token in merged for token in ("authorization failed", "forbidden", "unauthorized", "invalid api key", "authentication")):
        if "forbidden" in merged or "authorization failed" in merged:
            return "HTTP_403"
        return "HTTP_401"
    if "gateway" in merged and "timeout" in merged:
        return "HTTP_504"
    if any(token in merged for token in ("stalled", "no upstream progress", "hang", "hung")):
        return "UPSTREAM_STALLED"
    if any(token in merged for token in ("timeout", "timed out", "time-out", "deadline exceeded")):
        return "UPSTREAM_TIMEOUT"
    if any(
        token in merged
        for token in (
            "connection reset",
            "connection aborted",
            "connection refused",
            "broken pipe",
            "transport",
            "remoteprotocolerror",
            "readerror",
            "api connection",
        )
    ):
        return "TRANSPORT_ERROR"
    return "UPSTREAM_ERROR"


def _with_auth_hint(message: str, provider: str, model: str) -> str:
    provider_key = str(provider or "").strip().lower()
    if provider_key != "nvidia":
        return message
    lower = str(message or "").lower()
    if not any(token in lower for token in ("http_401", "http_403", "authorization failed", "forbidden", "unauthorized", "invalid api key", "authentication")):
        return message
    hint = (
        " NVIDIA auth failed for provider=nvidia."
        " Verify NVIDIA_API_KEY is valid, active, and entitled for the selected model,"
        " and verify NVIDIA_BASE_URL points to https://integrate.api.nvidia.com/v1."
        f" Model attempted: {model}."
    )
    if hint.strip() in str(message):
        return message
    return f"{message}{hint}"


def _is_transient_error(error_code: str, message: str, tb: str) -> bool:
    merged = f"{message}\n{tb}".lower()
    non_transient_markers = (
        "api_key client option must be set",
        "invalid api key",
        "authentication",
        "unauthorized",
        "permission denied",
        "forbidden",
        "invalid request",
        "model not found",
        "does not exist",
        "insufficient quota",
    )
    if any(marker in merged for marker in non_transient_markers):
        return False
    if error_code.startswith("HTTP_5"):
        return True
    if error_code in {"UPSTREAM_TIMEOUT", "UPSTREAM_STALLED", "TRANSPORT_ERROR", "HTTP_504"}:
        return True
    return any(
        token in merged
        for token in (
            "temporary",
            "temporarily unavailable",
            "service unavailable",
            "bad gateway",
            "gateway timeout",
            "internalservererror",
            "server error",
        )
    )


def _agent_stage_for(agent_id: str | None) -> str | None:
    key = str(agent_id or "").strip().lower()
    if key in {"market_analyst", "social_analyst", "news_analyst", "fundamentals_analyst"}:
        return "ANALYSTS"
    if key in {"bull_researcher", "bear_researcher", "research_manager"}:
        return "RESEARCH"
    if key == "trader":
        return "TRADER"
    if key in {"aggressive_analyst", "conservative_analyst", "neutral_analyst"}:
        return "RISK"
    if key == "risk_judge":
        return "PORTFOLIO"
    return None


def _display_name(agent_id: str | None) -> str | None:
    key = str(agent_id or "").strip().lower()
    if not key:
        return None
    return " ".join(part.capitalize() for part in key.split("_"))


def _extract_failed_agent_and_stage(message: str, tb: str) -> tuple[str | None, str | None]:
    text = f"{message}\n{tb}"
    lowered = text.lower()
    match = re.search(
        r"agents[/\\](?:analysts|researchers|managers|trader|traders|risk)[/\\]([a-z_]+)\.py",
        lowered,
    )
    if match:
        file_key = str(match.group(1) or "").strip("_")
        canonical = {
            "market_analyst": "market_analyst",
            "social_analyst": "social_analyst",
            "news_analyst": "news_analyst",
            "fundamentals_analyst": "fundamentals_analyst",
            "bull_researcher": "bull_researcher",
            "bear_researcher": "bear_researcher",
            "research_manager": "research_manager",
            "trader": "trader",
            "aggressive_debator": "aggressive_analyst",
            "conservative_debator": "conservative_analyst",
            "neutral_debator": "neutral_analyst",
            "risk_management": "risk_judge",
            "risk_judge": "risk_judge",
        }.get(file_key, file_key)
        return _display_name(canonical), _agent_stage_for(canonical)

    display_candidates = [
        "Market Analyst",
        "Social Analyst",
        "News Analyst",
        "Fundamentals Analyst",
        "Bull Researcher",
        "Bear Researcher",
        "Research Manager",
        "Trader",
        "Aggressive Analyst",
        "Conservative Analyst",
        "Neutral Analyst",
        "Risk Judge",
    ]
    for candidate in display_candidates:
        if candidate.lower() in lowered:
            candidate_id = candidate.lower().replace(" ", "_")
            return candidate, _agent_stage_for(candidate_id)
    return None, None


def _extract_reports(final_state: Dict[str, Any]) -> Dict[str, str]:
    debate = final_state.get("investment_debate_state") or {}
    risk = final_state.get("risk_debate_state") or {}
    reports = {
        "market_analyst": str(final_state.get("market_report") or "").strip(),
        "social_analyst": str(final_state.get("sentiment_report") or "").strip(),
        "news_analyst": str(final_state.get("news_report") or "").strip(),
        "fundamentals_analyst": str(final_state.get("fundamentals_report") or "").strip(),
        "bull_researcher": str(debate.get("bull_history") or "").strip(),
        "bear_researcher": str(debate.get("bear_history") or "").strip(),
        "research_manager": str(debate.get("judge_decision") or "").strip(),
        "trader": str(final_state.get("trader_investment_plan") or "").strip(),
        "aggressive_analyst": str(risk.get("aggressive_history") or "").strip(),
        "conservative_analyst": str(risk.get("conservative_history") or "").strip(),
        "neutral_analyst": str(risk.get("neutral_history") or "").strip(),
        "risk_judge": str(risk.get("judge_decision") or "").strip(),
    }
    fallback = str(final_state.get("final_trade_decision") or "").strip() or "No report generated."
    for key, value in list(reports.items()):
        if not value:
            reports[key] = fallback
    return reports


def _extract_available_reports(state: Dict[str, Any]) -> Dict[str, str]:
    debate = state.get("investment_debate_state") or {}
    risk = state.get("risk_debate_state") or {}
    return {
        "market_analyst": str(state.get("market_report") or "").strip(),
        "social_analyst": str(state.get("sentiment_report") or "").strip(),
        "news_analyst": str(state.get("news_report") or "").strip(),
        "fundamentals_analyst": str(state.get("fundamentals_report") or "").strip(),
        "bull_researcher": str(debate.get("bull_history") or "").strip(),
        "bear_researcher": str(debate.get("bear_history") or "").strip(),
        "research_manager": str(debate.get("judge_decision") or "").strip(),
        "trader": str(state.get("trader_investment_plan") or "").strip(),
        "aggressive_analyst": str(risk.get("aggressive_history") or "").strip(),
        "conservative_analyst": str(risk.get("conservative_history") or "").strip(),
        "neutral_analyst": str(risk.get("neutral_history") or "").strip(),
        "risk_judge": str(risk.get("judge_decision") or "").strip(),
    }


def _report_excerpt(text: str, limit: int = 280) -> str:
    raw = str(text or "").strip()
    if len(raw) <= limit:
        return raw
    return raw[: max(1, limit - 3)].rstrip() + "..."


def _phase_num(stage: str | None) -> int | None:
    mapping = {
        "ANALYSTS": 1,
        "RESEARCH": 2,
        "TRADER": 3,
        "RISK": 4,
        "PORTFOLIO": 5,
    }
    return mapping.get(str(stage or "").strip().upper())


_AGENT_ORDER = [
    "market_analyst",
    "social_analyst",
    "news_analyst",
    "fundamentals_analyst",
    "bull_researcher",
    "bear_researcher",
    "research_manager",
    "trader",
    "aggressive_analyst",
    "conservative_analyst",
    "neutral_analyst",
    "risk_judge",
]


_CHUNK_NODE_TO_AGENT = {
    "market_analyst": "market_analyst",
    "social_analyst": "social_analyst",
    "social_media_analyst": "social_analyst",
    "news_analyst": "news_analyst",
    "fundamentals_analyst": "fundamentals_analyst",
    "bull_researcher": "bull_researcher",
    "bear_researcher": "bear_researcher",
    "research_manager": "research_manager",
    "trader": "trader",
    "aggressive_analyst": "aggressive_analyst",
    "aggressive_debator": "aggressive_analyst",
    "conservative_analyst": "conservative_analyst",
    "conservative_debator": "conservative_analyst",
    "neutral_analyst": "neutral_analyst",
    "neutral_debator": "neutral_analyst",
    "risk_judge": "risk_judge",
    "risk_management": "risk_judge",
    "portfolio_manager": "risk_judge",
}


def _deep_merge_dict(dst: Dict[str, Any], src: Dict[str, Any]) -> Dict[str, Any]:
    for key, value in (src or {}).items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            _deep_merge_dict(dst[key], value)
        else:
            dst[key] = value
    return dst


def _chunk_payload_to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in (
            "report",
            "analysis",
            "decision",
            "final_trade_decision",
            "judge_decision",
            "output",
            "content",
            "message",
            "text",
        ):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        try:
            serialized = json.dumps(value, ensure_ascii=False, default=_json_default)
            return serialized.strip()
        except Exception:
            return str(value).strip()
    if isinstance(value, (list, tuple)):
        for item in reversed(value):
            candidate = _chunk_payload_to_text(item)
            if candidate:
                return candidate
        return ""
    return str(value).strip()


def _extract_chunk_agent_updates(chunk: Dict[str, Any]) -> Dict[str, str]:
    updates: Dict[str, str] = {}
    if not isinstance(chunk, dict):
        return updates
    for raw_key, raw_value in chunk.items():
        key = str(raw_key or "").strip().lower()
        if not key:
            continue
        agent_id = _CHUNK_NODE_TO_AGENT.get(key)
        if not agent_id:
            continue
        updates[agent_id] = _chunk_payload_to_text(raw_value)
    return updates


def _emit_report_progress_events(
    *,
    run_id: str,
    state: Dict[str, Any],
    chunk: Dict[str, Any],
    attempt: int,
    max_attempts: int,
    emitted_started: set[str],
    emitted_completed: set[str],
    emitted_phases: set[str],
) -> None:
    available = _extract_available_reports(state)
    chunk_updates = _extract_chunk_agent_updates(chunk)
    for agent_id in _AGENT_ORDER:
        report_text = str(available.get(agent_id) or chunk_updates.get(agent_id) or "").strip()
        saw_agent_update = agent_id in chunk_updates
        if not report_text and not saw_agent_update:
            continue
        stage = _agent_stage_for(agent_id)
        phase_num = _phase_num(stage)
        if stage and stage not in emitted_phases:
            emitted_phases.add(stage)
            _emit(
                {
                    "type": "phase_start",
                    "run_id": run_id,
                    "timestamp": _now_iso(),
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "sub_phase": str(stage).lower(),
                    "phase_num": phase_num,
                    "message": f"{stage} started",
                }
            )
        display = _display_name(agent_id) or agent_id
        if agent_id not in emitted_started:
            emitted_started.add(agent_id)
            _emit(
                {
                    "type": "agent_action",
                    "run_id": run_id,
                    "timestamp": _now_iso(),
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "current_step": agent_id,
                    "agent": agent_id,
                    "agent_display_name": display,
                    "sub_phase": str(stage or "analysis").lower(),
                    "phase_num": phase_num,
                    "scene_stage": "start",
                    "status": "working",
                    "message": f"{display} analyzing...",
                    "raw_excerpt": _report_excerpt(report_text),
                }
            )
        if agent_id not in emitted_completed:
            emitted_completed.add(agent_id)
            safe_report = report_text[:12000] if report_text else ""
            _emit(
                {
                    "type": "agent_completed",
                    "run_id": run_id,
                    "timestamp": _now_iso(),
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "current_step": agent_id,
                    "agent": agent_id,
                    "agent_display_name": display,
                    "sub_phase": str(stage or "analysis").lower(),
                    "phase_num": phase_num,
                    "status": "completed",
                    "message": f"{display} completed",
                    "raw_excerpt": _report_excerpt(safe_report),
                    "report": safe_report,
                }
            )


def _compose_markdown_report(ticker: str, trade_date: str, reports: Dict[str, str], decision: str) -> str:
    sections = [
        "# TradingAgents Report",
        "",
        f"- Ticker: {ticker}",
        f"- Date: {trade_date}",
        f"- Generated: {_now_iso()}",
        f"- Final Decision: {decision or 'N/A'}",
        "",
    ]
    order = [
        ("Market Report", "market_analyst"),
        ("Sentiment Report", "social_analyst"),
        ("News Report", "news_analyst"),
        ("Fundamentals Report", "fundamentals_analyst"),
        ("Bull Researcher Report", "bull_researcher"),
        ("Bear Researcher Report", "bear_researcher"),
        ("Research Manager Report", "research_manager"),
        ("Trader Plan Report", "trader"),
        ("Aggressive Analyst Report", "aggressive_analyst"),
        ("Conservative Analyst Report", "conservative_analyst"),
        ("Neutral Analyst Report", "neutral_analyst"),
        ("Portfolio Decision Report", "risk_judge"),
    ]
    for title, key in order:
        sections.extend(["## " + title, reports.get(key, ""), ""])
    return "\n".join(sections).strip() + "\n"


def _emit(payload: Dict[str, Any]) -> None:
    # Keep event output ASCII-only so Windows code pages (e.g. cp1255) never
    # fail on characters like "≈" during console writes.
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def _load_stats_handler_class() -> Any:
    # `cli.stats_handler` ships with TradingAgents-original and tracks
    # llm/tool calls plus prompt/completion token usage.
    workdir = os.getenv("UPSTREAM_CLI_WORKDIR")
    if workdir and workdir not in os.sys.path:
        os.sys.path.insert(0, workdir)
    try:
        module = importlib.import_module("cli.stats_handler")
        return getattr(module, "StatsCallbackHandler", None)
    except Exception:
        return None


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except Exception:
        return default


def _read_stats(handler: Any) -> Dict[str, int]:
    if not handler:
        return {
            "llm_calls": 0,
            "tool_calls": 0,
            "tokens_in": 0,
            "tokens_out": 0,
        }
    try:
        raw = handler.get_stats() or {}
    except Exception:
        raw = {}
    return {
        "llm_calls": max(0, _safe_int(raw.get("llm_calls"), 0)),
        "tool_calls": max(0, _safe_int(raw.get("tool_calls"), 0)),
        "tokens_in": max(0, _safe_int(raw.get("tokens_in"), 0)),
        "tokens_out": max(0, _safe_int(raw.get("tokens_out"), 0)),
    }


def _merged_stats(total: Dict[str, int], current: Dict[str, int]) -> Dict[str, int]:
    return {
        "llm_calls": max(0, _safe_int(total.get("llm_calls"), 0) + _safe_int(current.get("llm_calls"), 0)),
        "tool_calls": max(0, _safe_int(total.get("tool_calls"), 0) + _safe_int(current.get("tool_calls"), 0)),
        "tokens_in": max(0, _safe_int(total.get("tokens_in"), 0) + _safe_int(current.get("tokens_in"), 0)),
        "tokens_out": max(0, _safe_int(total.get("tokens_out"), 0) + _safe_int(current.get("tokens_out"), 0)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--quick-model", required=True)
    parser.add_argument("--deep-model", required=True)
    parser.add_argument("--research-depth", default="standard")
    parser.add_argument("--output-language", default="English")
    parser.add_argument("--save-path", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()

    run_id = args.run_id
    save_path = Path(args.save_path).resolve()
    save_path.mkdir(parents=True, exist_ok=True)

    try:
        _configure_network_tls_for_container()
        provider_key = str(args.provider or "").strip().lower()
        # TradingAgents uses langchain_openai clients for multiple providers.
        # In NVIDIA mode, map NVIDIA_* env vars to OpenAI-compatible names so
        # client initialization is deterministic when only NVIDIA_* is set.
        if provider_key == "nvidia":
            nvidia_key = str(os.getenv("NVIDIA_API_KEY") or "").strip()
            nvidia_base_url = str(
                os.getenv("NVIDIA_BASE_URL") or "https://integrate.api.nvidia.com/v1"
            ).strip()
            if nvidia_key and not str(os.getenv("OPENAI_API_KEY") or "").strip():
                os.environ["OPENAI_API_KEY"] = nvidia_key
            if nvidia_base_url and not str(os.getenv("OPENAI_BASE_URL") or "").strip():
                os.environ["OPENAI_BASE_URL"] = nvidia_base_url

        # Legacy/non-strict runner mode removed: embedded runner defaults to strict parity.
        strict_parity_requested = str(os.getenv("TRADINGAGENTS_STRICT_PARITY", "1")).strip().lower() in {"1", "true", "yes", "on"}

        depth_rounds = _parse_research_depth(args.research_depth)
        depth_name = _normalize_research_depth(args.research_depth)
        timeout_seconds = _resolve_timeout_seconds(depth_name)
        stall_timeout_seconds = _resolve_stall_timeout_seconds(depth_name)
        if strict_parity_requested:
            # Keep strict parity aligned with original runtime behavior:
            # avoid stricter sidecar-only timeout caps and stall aborts.
            stall_timeout_seconds = 0
        # Strict parity must be single-attempt, propagate-only.
        max_attempts = 1 if strict_parity_requested else _resolve_max_attempts()
        _emit(
            {
                "type": "pipeline_start",
                "run_id": run_id,
                "timestamp": _now_iso(),
                "attempt": 1,
                "max_attempts": max_attempts,
            }
        )

        config = DEFAULT_CONFIG.copy()
        config["llm_provider"] = str(args.provider).strip().lower()
        config["quick_think_llm"] = args.quick_model
        config["deep_think_llm"] = args.deep_model
        config["max_debate_rounds"] = depth_rounds
        config["max_risk_discuss_rounds"] = depth_rounds
        config["output_language"] = args.output_language
        config["backend_url"] = _provider_backend_url(config["llm_provider"], config.get("backend_url"))
        try:
            config["llm_timeout_seconds"] = float(os.getenv("TA_LLM_TIMEOUT_SECONDS", "120"))
        except Exception:
            config["llm_timeout_seconds"] = 120.0
        try:
            config["llm_max_retries"] = int(float(os.getenv("TA_LLM_MAX_RETRIES", "6")))
        except Exception:
            config["llm_max_retries"] = 6
        if strict_parity_requested:
            config["memory_enabled"] = False
            config["checkpoint_enabled"] = False

        final_state: Dict[str, Any] = {}
        decision: Any = None
        attempts = []
        aggregate_stats: Dict[str, int] = {
            "llm_calls": 0,
            "tool_calls": 0,
            "tokens_in": 0,
            "tokens_out": 0,
        }
        last_telemetry_snapshot: Dict[str, int] | None = None

        for attempt in range(1, max_attempts + 1):
            attempt_started_at = _now_iso()
            timeout_hit = False
            stats_handler: Any = None
            attempt_final_state: Dict[str, Any] = {}
            emitted_started: set[str] = set()
            emitted_completed: set[str] = set()
            emitted_phases: set[str] = set()
            stream_state: Dict[str, Any] = {}
            try:
                stats_cls = _load_stats_handler_class()
                if stats_cls:
                    try:
                        stats_handler = stats_cls()
                    except Exception:
                        stats_handler = None

                ta = TradingAgentsGraph(
                    debug=False,
                    config=config,
                    callbacks=[stats_handler] if stats_handler else None,
                )

                def _emit_attempt_telemetry(force: bool = False) -> None:
                    nonlocal last_telemetry_snapshot
                    current = _read_stats(stats_handler)
                    merged = _merged_stats(aggregate_stats, current)
                    if not force and last_telemetry_snapshot == merged:
                        return
                    last_telemetry_snapshot = dict(merged)
                    _emit(
                        {
                            "type": "run_telemetry",
                            "run_id": run_id,
                            "timestamp": _now_iso(),
                            "attempt": attempt,
                            "max_attempts": max_attempts,
                            **merged,
                        }
                    )

                with _stream_watchdog(timeout_seconds, stall_timeout_seconds) as watchdog:
                    # Run through graph streaming in both modes so the sidecar can
                    # emit report completion events as soon as each agent finishes.
                    # Strict mode remains single-attempt with strict timeout policy.
                    init_agent_state = ta.propagator.create_initial_state(args.ticker, args.date)
                    watchdog.touch()
                    graph_args = ta.propagator.get_graph_args(callbacks=[stats_handler] if stats_handler else None)
                    watchdog.touch()
                    for chunk in ta.graph.stream(init_agent_state, **graph_args):
                        watchdog.touch()
                        if isinstance(chunk, dict):
                            _deep_merge_dict(stream_state, chunk)
                            attempt_final_state = dict(stream_state)
                            _emit_report_progress_events(
                                run_id=run_id,
                                state=stream_state,
                                chunk=chunk,
                                attempt=attempt,
                                max_attempts=max_attempts,
                                emitted_started=emitted_started,
                                emitted_completed=emitted_completed,
                                emitted_phases=emitted_phases,
                            )
                        _emit_attempt_telemetry(force=False)
                if not attempt_final_state:
                    raise RuntimeError("Upstream graph returned empty final state.")
                final_state = attempt_final_state
                ta.curr_state = final_state
                if not decision:
                    decision = ta.process_signal(final_state.get("final_trade_decision"))
                current_stats = _read_stats(stats_handler)
                aggregate_stats = _merged_stats(aggregate_stats, current_stats)
                _emit_attempt_telemetry(force=True)
                attempts.append(
                    {
                        "attempt": attempt,
                        "status": "completed",
                        "started_at": attempt_started_at,
                        "completed_at": _now_iso(),
                        **current_stats,
                    }
                )
                break
            except Exception as exc:
                attempt_stats = _read_stats(stats_handler)
                aggregate_stats = _merged_stats(aggregate_stats, attempt_stats)
                timeout_hit = isinstance(exc, TimeoutError)
                tb = traceback.format_exc(limit=12)
                error_message = str(exc) or "Upstream TradingAgents execution failed."
                error_code = _normalize_error_code(error_message, tb, timeout_hit)
                if error_code in {"HTTP_401", "HTTP_403"}:
                    error_message = _with_auth_hint(
                        error_message,
                        config.get("llm_provider", ""),
                        str(config.get("quick_think_llm") or ""),
                    )
                failed_agent, failed_stage = _extract_failed_agent_and_stage(error_message, tb)
                is_transient = _is_transient_error(error_code, error_message, tb)
                attempts.append(
                    {
                        "attempt": attempt,
                        "status": "failed",
                        "started_at": attempt_started_at,
                        "completed_at": _now_iso(),
                        "error_code": error_code,
                        "error_message": error_message,
                        "failed_agent": failed_agent,
                        "failed_stage": failed_stage,
                        "transient": is_transient,
                        **attempt_stats,
                    }
                )

                if is_transient and attempt < max_attempts:
                    next_attempt = attempt + 1
                    delay_seconds = _retry_backoff_seconds(attempt)
                    _emit(
                        {
                            "type": "run_retrying",
                            "run_id": run_id,
                            "timestamp": _now_iso(),
                            "attempt": next_attempt,
                            "max_attempts": max_attempts,
                            "error_code": error_code,
                            "error_message": error_message,
                            "failed_stage": failed_stage,
                            "failed_agent": failed_agent,
                            "retry_delay_seconds": delay_seconds,
                            **aggregate_stats,
                        }
                    )
                    if delay_seconds > 0:
                        time.sleep(delay_seconds)
                    continue

                _emit(
                    {
                        "type": "run_failed",
                        "run_id": run_id,
                        "timestamp": _now_iso(),
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "error_code": error_code,
                        "error_message": error_message,
                        "failed_stage": failed_stage,
                        "failed_agent": failed_agent,
                        "error": error_message,
                        "traceback": tb,
                        "attempts": attempts,
                        **aggregate_stats,
                    }
                )
                return 1

        if not final_state:
            _emit(
                {
                    "type": "run_failed",
                    "run_id": run_id,
                    "timestamp": _now_iso(),
                    "attempt": max_attempts,
                    "max_attempts": max_attempts,
                    "error_code": "UPSTREAM_NO_FINAL_STATE",
                    "error_message": "Upstream execution ended without final state.",
                    "error": "Upstream execution ended without final state.",
                    "attempts": attempts,
                    **aggregate_stats,
                }
            )
            return 1

        reports = _extract_reports(final_state or {})
        final_state_payload = dict(final_state or {})
        final_state_payload.update(
            {
                "run_id": run_id,
                "ticker": args.ticker,
                "trade_date": args.date,
                "provider": config["llm_provider"],
                "quick_model": args.quick_model,
                "deep_model": args.deep_model,
                "research_depth": depth_rounds,
                "output_language": args.output_language,
                "recommended_action": str(decision or "").strip(),
                "full_agent_reports": reports,
                "generated_at": _now_iso(),
                **aggregate_stats,
            }
        )

        final_state_path = save_path / "final_state.json"
        complete_report_path = save_path / "complete_report.md"
        full_agent_reports_path = save_path / "full_agent_reports.json"

        final_state_path.write_text(
            json.dumps(final_state_payload, ensure_ascii=False, indent=2, default=_json_default),
            encoding="utf-8",
        )
        full_agent_reports_path.write_text(
            json.dumps(reports, ensure_ascii=False, indent=2, default=_json_default),
            encoding="utf-8",
        )
        complete_report_path.write_text(
            _compose_markdown_report(args.ticker, args.date, reports, str(decision or "")),
            encoding="utf-8",
        )

        _emit(
            {
                "type": "run_completed",
                "run_id": run_id,
                "timestamp": _now_iso(),
                "complete_report": complete_report_path.read_text(encoding="utf-8"),
                "full_agent_reports": reports,
                "attempt": len(attempts) if attempts else 1,
                "max_attempts": max_attempts,
                "attempts": attempts or [{"attempt": 1, "status": "completed"}],
                **aggregate_stats,
                "artifacts": {
                    "save_path": str(save_path),
                    "final_state_path": str(final_state_path),
                    "complete_report_path": str(complete_report_path),
                    "full_agent_reports_path": str(full_agent_reports_path),
                },
            }
        )
        return 0
    except Exception as exc:
        _emit(
            {
                "type": "run_failed",
                "run_id": run_id,
                "timestamp": _now_iso(),
                "error": str(exc) or "Upstream runner failed unexpectedly.",
                "error_message": str(exc) or "Upstream runner failed unexpectedly.",
                "error_code": _normalize_error_code(str(exc), traceback.format_exc(limit=8), isinstance(exc, TimeoutError)),
                "traceback": traceback.format_exc(limit=8),
                **aggregate_stats,
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
