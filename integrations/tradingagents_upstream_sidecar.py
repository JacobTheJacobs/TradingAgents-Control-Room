from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import sys
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Deque, Dict, Optional, Set


class SidecarError(RuntimeError):
    """Raised when embedded TradingAgents runtime calls fail."""

    def __init__(self, message: str, *, status_code: Optional[int] = None, payload: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _event_backlog_limit() -> int:
    try:
        return max(1000, int(os.getenv("UPSTREAM_EVENT_BACKLOG", "8000")))
    except (TypeError, ValueError):
        return 8000


def _to_nonneg_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(float(value)))
    except Exception:
        return max(0, int(default))


def _parse_dotenv_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception:
        return values
    for line in raw.splitlines():
        text = str(line or "").strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip().strip('"').strip("'")
        values[key] = value
    return values


def _resolve_default_ca_bundle() -> Optional[str]:
    try:
        import certifi  # type: ignore

        path = str(certifi.where() or "").strip()
        return path or None
    except Exception:
        return None


@dataclass
class RunSession:
    run_id: str
    request: Dict[str, Any]
    save_path: Path
    started_at: str
    status: str = "RUNNING"
    exit_code: Optional[int] = None
    completed_at: Optional[str] = None
    error: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    failed_stage: Optional[str] = None
    failed_agent: Optional[str] = None
    attempt: Optional[int] = None
    max_attempts: int = 1
    llm_calls: int = 0
    tool_calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    reports_completed: int = 0
    agents_completed: int = 0
    artifacts: Dict[str, Any] = field(default_factory=dict)
    events: Deque[Dict[str, Any]] = field(default_factory=lambda: deque(maxlen=_event_backlog_limit()))
    subscribers: Set[asyncio.Queue] = field(default_factory=set)
    process: Optional[asyncio.subprocess.Process] = None
    stream_task: Optional[asyncio.Task] = None
    next_sequence: int = 1
    abort_requested: bool = False
    log_lines: Deque[str] = field(default_factory=lambda: deque(maxlen=8000))
    command: Optional[list[str]] = None
    strict_mode: bool = True
    last_metric_change_at_monotonic: float = 0.0
    last_activity_at_monotonic: float = 0.0
    market_retry_attempt: int = 0
    market_retry_max: int = 0
    completed_agents: Set[str] = field(default_factory=set)


class EmbeddedUpstreamRuntime:
    def __init__(self) -> None:
        self._sessions: Dict[str, RunSession] = {}
        self._active_run_id: Optional[str] = None
        self._lock = asyncio.Lock()
        self._startup_timeout_seconds = max(
            10,
            int(float(os.getenv("UPSTREAM_STARTUP_TIMEOUT_SECONDS", "30"))),
        )
        self._no_progress_timeout_seconds = max(
            30,
            int(float(os.getenv("UPSTREAM_NO_PROGRESS_TIMEOUT_SECONDS", "420"))),
        )
        self._strict_no_progress_timeout_seconds = max(
            60,
            int(float(os.getenv("UPSTREAM_STRICT_NO_PROGRESS_TIMEOUT_SECONDS", "180"))),
        )
        self._first_report_timeout_seconds = max(
            300,
            int(float(os.getenv("UPSTREAM_FIRST_REPORT_TIMEOUT_SECONDS", "1800"))),
        )
        # src/ directory containing TradingAgents-original and package modules.
        self.workdir = Path(__file__).resolve().parents[1]
        runs_dir_env = os.getenv("UPSTREAM_RUNS_DIR")
        self.runs_dir = Path(runs_dir_env).resolve() if runs_dir_env else (self.workdir / "tmp" / "tradingagents-runs")
        try:
            self.runs_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            self.runs_dir = (self.workdir / "tmp" / "tradingagents-runs").resolve()
            self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.runner_script = (Path(__file__).resolve().parent / "tradingagents_embedded_runner.py").resolve()

    def _build_child_env(self, *, strict_parity: bool) -> Dict[str, str]:
        env = dict(os.environ)
        root_dir = self.workdir.parent
        for env_file in (root_dir / ".env", self.workdir / ".env"):
            if not env_file.exists():
                continue
            for key, value in _parse_dotenv_file(env_file).items():
                if key not in env and str(value).strip():
                    env[key] = str(value).strip()

        if not str(env.get("NVIDIA_BASE_URL") or "").strip():
            env["NVIDIA_BASE_URL"] = "https://integrate.api.nvidia.com/v1"

        cert_file = str(env.get("SSL_CERT_FILE") or "").strip()
        req_bundle = str(env.get("REQUESTS_CA_BUNDLE") or "").strip()
        fallback_bundle = _resolve_default_ca_bundle()
        if not cert_file and req_bundle:
            env["SSL_CERT_FILE"] = req_bundle
            env["CURL_CA_BUNDLE"] = req_bundle
        elif cert_file and not req_bundle:
            env["REQUESTS_CA_BUNDLE"] = cert_file
            env["CURL_CA_BUNDLE"] = cert_file
        elif not cert_file and not req_bundle and fallback_bundle:
            env["SSL_CERT_FILE"] = fallback_bundle
            env["REQUESTS_CA_BUNDLE"] = fallback_bundle
            env["CURL_CA_BUNDLE"] = fallback_bundle

        if not cert_file and not req_bundle:
            env.setdefault("TA_INSECURE_SSL", "1")
            env.setdefault("YFINANCE_USE_CURL", "False")

        env["PYTHONUNBUFFERED"] = "1"
        env["TRADINGAGENTS_STRICT_PARITY"] = "1" if strict_parity else "0"
        env["UPSTREAM_MAX_ATTEMPTS"] = "1" if strict_parity else "3"
        # Force strict timeout policy for UI runs; do not inherit stale lower values.
        env["UPSTREAM_STRICT_TIMEOUT_SECONDS_QUICK"] = "1200"
        env["UPSTREAM_STRICT_TIMEOUT_SECONDS_STANDARD"] = "2400"
        env["UPSTREAM_STRICT_TIMEOUT_SECONDS_DEEP"] = "3600"
        env["UPSTREAM_STRICT_HANG_CUTOFF_SECONDS_QUICK"] = "1800"
        env["UPSTREAM_STRICT_HANG_CUTOFF_SECONDS_STANDARD"] = "1200"
        env["UPSTREAM_STRICT_HANG_CUTOFF_SECONDS_DEEP"] = "1800"
        # Avoid premature failure on transient Yahoo throttling.
        env["UPSTREAM_STRICT_MARKET_RETRY_CAP"] = "6"
        # Reduce long Yahoo backoff stalls in strict mode while preserving
        # canonical execution path. Failing calls already degrade to N/A in
        # TradingAgents dataflows; lower retry counts keep UI responsive.
        env["TA_YF_MAX_RETRIES"] = str(os.getenv("TA_YF_MAX_RETRIES", "1"))
        env["TA_YF_BASE_DELAY_SECONDS"] = str(os.getenv("TA_YF_BASE_DELAY_SECONDS", "1.0"))
        env["TA_YF_CALL_TIMEOUT_SECONDS"] = str(os.getenv("TA_YF_CALL_TIMEOUT_SECONDS", "12"))
        # Preserve canonical engine behavior in strict parity mode.
        # Do not inject sidecar-specific retry/SSL overrides that alter
        # runtime characteristics versus original TradingAgents.
        return env

    def get_session(self, run_id: str) -> Optional[RunSession]:
        return self._sessions.get(str(run_id or "").strip())

    def _append_event(self, session: RunSession, envelope: Dict[str, Any]) -> None:
        payload = dict(envelope or {})
        payload.setdefault("timestamp", _now_iso())
        payload.setdefault("run_id", session.run_id)
        payload["sequence"] = session.next_sequence
        session.next_sequence += 1
        session.events.append(payload)
        for queue in list(session.subscribers):
            try:
                queue.put_nowait(payload)
            except Exception:
                session.subscribers.discard(queue)

    @staticmethod
    def _append_log_line(session: RunSession, line: str) -> None:
        text = str(line or "").rstrip("\r\n")
        if not text:
            return
        session.log_lines.append(text)
        with contextlib.suppress(Exception):
            session.last_activity_at_monotonic = asyncio.get_running_loop().time()

    @staticmethod
    def _log_tail_text(session: RunSession, max_lines: int = 25) -> str:
        if not session.log_lines:
            return ""
        tail = list(session.log_lines)[-max_lines:]
        return "\n".join(tail).strip()

    @staticmethod
    def _event_agent_id(evt: Dict[str, Any]) -> str:
        raw = str(
            evt.get("current_step")
            or evt.get("agent")
            or evt.get("agent_display_name")
            or ""
        ).strip().lower()
        if not raw:
            return ""
        return raw.replace(" ", "_")

    async def start_run(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.runner_script.exists():
            raise SidecarError(
                f"Embedded runner not found: {self.runner_script}",
                status_code=500,
                payload={"detail": f"Embedded runner not found: {self.runner_script}"},
            )

        run_id = str(payload.get("run_id") or f"upstream-{uuid.uuid4().hex[:12]}").strip()
        ticker = str(payload.get("ticker") or "").strip().upper()
        trade_date = str(payload.get("date") or "").strip()
        provider = str(payload.get("provider") or "nvidia").strip().lower()
        quick_model = str(payload.get("quick_model") or payload.get("quickModel") or "").strip()
        deep_model = str(payload.get("deep_model") or payload.get("deepModel") or "").strip()
        research_depth = str(payload.get("research_depth") or payload.get("researchDepth") or "standard").strip()
        output_language = str(payload.get("output_language") or payload.get("outputLanguage") or "English").strip() or "English"
        save_path = Path(str(payload.get("save_path") or payload.get("savePath") or (self.runs_dir / run_id))).resolve()

        if not ticker or not trade_date or not quick_model or not deep_model:
            raise SidecarError(
                "Invalid embedded run request payload.",
                status_code=400,
                payload={"detail": "ticker, date, quick_model, and deep_model are required."},
            )

        async with self._lock:
            if self._active_run_id:
                active = self._sessions.get(self._active_run_id)
                if active and active.status == "RUNNING":
                    detail = f"Run already active: {self._active_run_id}"
                    raise SidecarError(detail, status_code=409, payload={"detail": detail})

            save_path.mkdir(parents=True, exist_ok=True)

            command = [
                sys.executable,
                str(self.runner_script),
                "--ticker",
                ticker,
                "--date",
                trade_date,
                "--provider",
                provider,
                "--quick-model",
                quick_model,
                "--deep-model",
                deep_model,
                "--research-depth",
                research_depth,
                "--output-language",
                output_language,
                "--save-path",
                str(save_path),
                "--run-id",
                run_id,
            ]

            # Legacy/non-strict branch removed: sidecar always launches strict parity.
            strict_requested = True

            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(self.workdir),
                env=self._build_child_env(strict_parity=strict_requested),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )

            session = RunSession(
                run_id=run_id,
                request=dict(payload),
                save_path=save_path,
                started_at=_now_iso(),
                process=process,
                command=list(command),
                strict_mode=strict_requested,
            )
            now = asyncio.get_running_loop().time()
            session.last_metric_change_at_monotonic = now
            session.last_activity_at_monotonic = now
            self._sessions[run_id] = session
            self._active_run_id = run_id

            self._append_event(
                session,
                {
                    "kind": "session",
                    "status": session.status,
                    "pid": process.pid,
                    "message": "Embedded TradingAgents run process started.",
                },
            )

            session.stream_task = asyncio.create_task(self._stream_process(session))
            asyncio.create_task(self._startup_watchdog(session))
            asyncio.create_task(self._no_progress_watchdog(session))
            asyncio.create_task(self._first_report_watchdog(session))
            return {
                "run_id": run_id,
                "status": session.status,
                "started_at": session.started_at,
                "pid": process.pid,
                "save_path": str(save_path),
            }

    async def _startup_watchdog(self, session: RunSession) -> None:
        await asyncio.sleep(self._startup_timeout_seconds)
        if session.status != "RUNNING":
            return
        # If nothing was emitted for too long, fail-fast instead of hanging forever.
        has_progress = bool(session.log_lines) or any(
            str((evt.get("event") or {}).get("type") or "").strip()
            for evt in list(session.events)
            if str(evt.get("kind") or "").lower() == "event"
        )
        if has_progress:
            return
        proc = session.process
        if proc and proc.returncode is None:
            with contextlib.suppress(Exception):
                proc.terminate()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), timeout=5)
            if proc.returncode is None:
                with contextlib.suppress(Exception):
                    proc.kill()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), timeout=5)
        session.status = "FAILED"
        session.error_code = "UPSTREAM_STARTUP_STALL"
        session.error_message = (
            f"Runner emitted no output for {self._startup_timeout_seconds}s after start."
        )
        session.error = session.error_message
        self._append_event(
            session,
            {
                "kind": "event",
                "event": {
                    "type": "run_failed",
                    "run_id": session.run_id,
                    "error_code": session.error_code,
                    "error_message": session.error_message,
                    "error": session.error_message,
                },
            },
        )
        await self._finalize_session(session)

    async def _no_progress_watchdog(self, session: RunSession) -> None:
        check_interval = 5.0
        while session.status == "RUNNING":
            await asyncio.sleep(check_interval)
            if session.status != "RUNNING":
                return
            # Allow long runs once reports are flowing.
            if _to_nonneg_int(session.reports_completed, 0) > 0:
                continue
            now = asyncio.get_running_loop().time()
            last = max(
                float(session.last_metric_change_at_monotonic or 0.0),
                float(session.last_activity_at_monotonic or 0.0),
            )
            stalled_for = max(0.0, now - last)
            timeout_limit = (
                float(self._strict_no_progress_timeout_seconds)
                if bool(session.strict_mode)
                else float(self._no_progress_timeout_seconds)
            )
            if stalled_for < timeout_limit:
                continue
            proc = session.process
            if proc and proc.returncode is None:
                with contextlib.suppress(Exception):
                    proc.terminate()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), timeout=5)
                if proc.returncode is None:
                    with contextlib.suppress(Exception):
                        proc.kill()
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(proc.wait(), timeout=5)
            session.status = "FAILED"
            session.error_code = "UPSTREAM_NO_METRIC_PROGRESS"
            session.error_message = (
                f"No telemetry metric change for {int(stalled_for)}s "
                f"(llm={session.llm_calls}, tools={session.tool_calls}, "
                f"tokens_in={session.tokens_in}, tokens_out={session.tokens_out}, reports={session.reports_completed})."
            )
            session.error = session.error_message
            self._append_event(
                session,
                {
                    "kind": "event",
                    "event": {
                        "type": "run_failed",
                        "run_id": session.run_id,
                        "error_code": session.error_code,
                        "error_message": session.error_message,
                        "error": session.error_message,
                    },
                },
            )
            await self._finalize_session(session)
            return

    async def _first_report_watchdog(self, session: RunSession) -> None:
        await asyncio.sleep(self._first_report_timeout_seconds)
        if session.status != "RUNNING":
            return
        if _to_nonneg_int(session.reports_completed, 0) > 0:
            return
        # If telemetry shows the run is making progress, don't hard-fail.
        llm_calls = _to_nonneg_int(session.llm_calls, 0)
        tokens_in = _to_nonneg_int(session.tokens_in, 0)
        tokens_out = _to_nonneg_int(session.tokens_out, 0)
        # A single early llm call with zero tokens often means the strict run
        # is wedged; only treat as progress when token traffic exists or when
        # multiple llm calls are observed.
        if tokens_in > 0 or tokens_out > 0 or llm_calls >= 3:
            return
        proc = session.process
        if proc and proc.returncode is None:
            with contextlib.suppress(Exception):
                proc.terminate()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), timeout=5)
            if proc.returncode is None:
                with contextlib.suppress(Exception):
                    proc.kill()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), timeout=5)
        session.status = "FAILED"
        session.error_code = "UPSTREAM_FIRST_REPORT_TIMEOUT"
        session.error_message = (
            f"No first report emitted within {self._first_report_timeout_seconds}s."
        )
        session.error = session.error_message
        self._append_event(
            session,
            {
                "kind": "event",
                "event": {
                    "type": "run_failed",
                    "run_id": session.run_id,
                    "error_code": session.error_code,
                    "error_message": session.error_message,
                    "error": session.error_message,
                },
            },
        )
        await self._finalize_session(session)

    async def abort_run(self, run_id: str) -> Dict[str, Any]:
        session = self.get_session(run_id)
        if not session:
            raise SidecarError(f"Run not found: {run_id}", status_code=404, payload={"detail": f"Run not found: {run_id}"})
        if session.status != "RUNNING" or not session.process:
            return {"run_id": session.run_id, "status": session.status, "abort_requested": session.abort_requested}

        session.abort_requested = True
        proc = session.process
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), timeout=5)
        return {"run_id": session.run_id, "status": session.status, "abort_requested": True}

    async def get_run(self, run_id: str) -> Dict[str, Any]:
        session = self.get_session(run_id)
        if not session:
            raise SidecarError(f"Run not found: {run_id}", status_code=404, payload={"detail": f"Run not found: {run_id}"})
        # Hard stale guard: never allow infinite RUNNING with zero progress.
        if session.status == "RUNNING":
            try:
                started = str(session.started_at or "").replace("Z", "+00:00")
                started_dt = datetime.fromisoformat(started)
                age_s = (datetime.utcnow() - started_dt.replace(tzinfo=None)).total_seconds()
            except Exception:
                age_s = 0
            if (
                age_s >= float(self._no_progress_timeout_seconds)
                and _to_nonneg_int(session.llm_calls, 0) == 0
                and _to_nonneg_int(session.tool_calls, 0) == 0
                and not session.log_lines
            ):
                session.status = "FAILED"
                session.error_code = "UPSTREAM_STALE_RUNNING_GUARD"
                session.error_message = "Run exceeded no-progress timeout with zero output."
                session.error = session.error_message
                await self._finalize_session(session)
        return {
            "run_id": session.run_id,
            "status": session.status,
            "started_at": session.started_at,
            "completed_at": session.completed_at,
            "exit_code": session.exit_code,
            "error": session.error,
            "error_code": session.error_code,
            "error_message": session.error_message,
            "failed_stage": session.failed_stage,
            "failed_agent": session.failed_agent,
            "attempt": session.attempt,
            "max_attempts": session.max_attempts,
            "llm_calls": session.llm_calls,
            "tool_calls": session.tool_calls,
            "tokens_in": session.tokens_in,
            "tokens_out": session.tokens_out,
            "artifacts": session.artifacts,
            "request": session.request,
        }

    async def get_artifacts(self, run_id: str) -> Dict[str, Any]:
        session = self.get_session(run_id)
        if not session:
            raise SidecarError(f"Run not found: {run_id}", status_code=404, payload={"detail": f"Run not found: {run_id}"})
        artifacts = dict(session.artifacts or {})
        if not artifacts:
            artifacts = self._discover_artifacts(session.save_path)
        return {
            "run_id": session.run_id,
            "status": session.status,
            "started_at": session.started_at,
            "completed_at": session.completed_at,
            "exit_code": session.exit_code,
            "error": session.error,
            "error_code": session.error_code,
            "error_message": session.error_message,
            "failed_stage": session.failed_stage,
            "failed_agent": session.failed_agent,
            "attempt": session.attempt,
            "max_attempts": session.max_attempts,
            "llm_calls": session.llm_calls,
            "tool_calls": session.tool_calls,
            "tokens_in": session.tokens_in,
            "tokens_out": session.tokens_out,
            "artifacts": artifacts,
        }

    async def get_health(self) -> Dict[str, Any]:
        active = self.get_session(self._active_run_id) if self._active_run_id else None
        return {
            "ok": True,
            "active_run_id": self._active_run_id,
            "active_status": active.status if active else None,
            "workdir": str(self.workdir),
            "runs_dir": str(self.runs_dir),
            "mode": "embedded",
        }

    async def stream_events(self, run_id: str, *, from_seq: int = 0) -> AsyncIterator[Dict[str, Any]]:
        session = self.get_session(run_id)
        if not session:
            raise SidecarError(f"Run not found: {run_id}", status_code=404, payload={"detail": f"Run not found: {run_id}"})

        queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        session.subscribers.add(queue)
        try:
            for event in list(session.events):
                if int(event.get("sequence") or 0) > from_seq:
                    yield event
            while True:
                event = await queue.get()
                yield event
                if str(event.get("kind") or "").lower() == "terminal":
                    break
        finally:
            session.subscribers.discard(queue)

    async def _stream_process(self, session: RunSession) -> None:
        process = session.process
        if not process or not process.stdout:
            session.status = "FAILED"
            session.error = "Missing subprocess stdout pipe."
            self._append_event(
                session,
                {"kind": "event", "event": {"type": "run_failed", "run_id": session.run_id, "error": session.error}},
            )
            await self._finalize_session(session)
            return

        rate_limit_pattern = re.compile(r"rate limited,\s*retrying.*\(attempt\s*(\d+)\s*/\s*(\d+)\)", re.IGNORECASE)

        def handle_line(line: str) -> None:
            parsed: Optional[Dict[str, Any]] = None
            try:
                candidate = json.loads(line)
                if isinstance(candidate, dict) and candidate.get("type"):
                    parsed = candidate
            except Exception:
                parsed = None

            if parsed is not None:
                self._append_log_line(session, line)
                parsed.setdefault("run_id", session.run_id)
                event_type = str(parsed.get("type") or "").lower()
                if event_type == "run_completed":
                    session.status = "COMPLETED"
                    session.artifacts.update(parsed.get("artifacts") or {})
                    session.attempt = parsed.get("attempt")
                    session.max_attempts = _to_nonneg_int(parsed.get("max_attempts"), session.max_attempts or 1)
                elif event_type == "run_failed":
                    session.status = "ABORTED" if session.abort_requested else "FAILED"
                    session.error_code = str(parsed.get("error_code") or "").strip() or None
                    session.error_message = str(parsed.get("error_message") or parsed.get("error") or parsed.get("message") or "Run failed.").strip()
                    session.failed_stage = str(parsed.get("failed_stage") or "").strip() or None
                    session.failed_agent = str(parsed.get("failed_agent") or "").strip() or None
                    session.attempt = parsed.get("attempt")
                    session.max_attempts = _to_nonneg_int(parsed.get("max_attempts"), session.max_attempts or 1)
                    session.error = session.error_message
                elif event_type == "run_retrying":
                    session.attempt = parsed.get("attempt")
                    session.max_attempts = _to_nonneg_int(parsed.get("max_attempts"), session.max_attempts or 1)
                elif event_type == "run_telemetry":
                    prev = (
                        _to_nonneg_int(session.llm_calls, 0),
                        _to_nonneg_int(session.tool_calls, 0),
                        _to_nonneg_int(session.tokens_in, 0),
                        _to_nonneg_int(session.tokens_out, 0),
                        _to_nonneg_int(session.reports_completed, 0),
                        _to_nonneg_int(session.agents_completed, 0),
                    )
                    session.llm_calls = _to_nonneg_int(parsed.get("llm_calls"), session.llm_calls)
                    session.tool_calls = _to_nonneg_int(parsed.get("tool_calls"), session.tool_calls)
                    session.tokens_in = _to_nonneg_int(parsed.get("tokens_in"), session.tokens_in)
                    session.tokens_out = _to_nonneg_int(parsed.get("tokens_out"), session.tokens_out)
                    session.reports_completed = _to_nonneg_int(parsed.get("reports_completed"), session.reports_completed)
                    session.agents_completed = _to_nonneg_int(parsed.get("agents_completed"), session.agents_completed)
                    curr = (
                        _to_nonneg_int(session.llm_calls, 0),
                        _to_nonneg_int(session.tool_calls, 0),
                        _to_nonneg_int(session.tokens_in, 0),
                        _to_nonneg_int(session.tokens_out, 0),
                        _to_nonneg_int(session.reports_completed, 0),
                        _to_nonneg_int(session.agents_completed, 0),
                    )
                    if curr != prev:
                        now = asyncio.get_running_loop().time()
                        session.last_metric_change_at_monotonic = now
                        session.last_activity_at_monotonic = now
                    # Receiving telemetry itself is forward progress, even when
                    # token counters are still zero early in a step.
                    else:
                        now = asyncio.get_running_loop().time()
                        session.last_metric_change_at_monotonic = now
                        session.last_activity_at_monotonic = now
                elif event_type == "agent_completed":
                    agent_id = self._event_agent_id(parsed)
                    if agent_id:
                        session.completed_agents.add(agent_id)
                    completed = len(session.completed_agents) if session.completed_agents else max(
                        _to_nonneg_int(session.reports_completed, 0),
                        1,
                    )
                    session.reports_completed = completed
                    session.agents_completed = completed
                    now = asyncio.get_running_loop().time()
                    session.last_metric_change_at_monotonic = now
                    session.last_activity_at_monotonic = now

                if event_type in {"run_completed", "run_failed", "run_telemetry"}:
                    session.llm_calls = _to_nonneg_int(parsed.get("llm_calls"), session.llm_calls)
                    session.tool_calls = _to_nonneg_int(parsed.get("tool_calls"), session.tool_calls)
                    session.tokens_in = _to_nonneg_int(parsed.get("tokens_in"), session.tokens_in)
                    session.tokens_out = _to_nonneg_int(parsed.get("tokens_out"), session.tokens_out)
                    session.reports_completed = _to_nonneg_int(parsed.get("reports_completed"), session.reports_completed)
                    session.agents_completed = _to_nonneg_int(parsed.get("agents_completed"), session.agents_completed)
                elif event_type == "log":
                    self._append_event(
                        session,
                        {"kind": "raw_log", "line": str(parsed.get("message") or ""), "level": parsed.get("level")},
                    )
                self._append_event(session, {"kind": "event", "event": parsed})
            else:
                self._append_log_line(session, line)
                self._append_event(session, {"kind": "raw_log", "line": line})
                match = rate_limit_pattern.search(line)
                if match:
                    attempt = _to_nonneg_int(match.group(1), 0)
                    max_attempts = _to_nonneg_int(match.group(2), 0)
                    session.market_retry_attempt = max(session.market_retry_attempt, attempt)
                    session.market_retry_max = max(session.market_retry_max, max_attempts)
                    self._append_event(
                        session,
                        {
                            "kind": "event",
                            "event": {
                                "type": "run_retrying",
                                "run_id": session.run_id,
                                "attempt": attempt,
                                "max_attempts": max_attempts or session.max_attempts or 1,
                                "message": f"Rate-limited, retrying {attempt}/{max_attempts or '?'}...",
                                "error_code": "YF_RATE_LIMIT",
                            },
                        },
                    )

        try:
            buffer = bytearray()
            while True:
                raw_chunk = await process.stdout.read(65536)
                if not raw_chunk:
                    break
                buffer.extend(raw_chunk)
                while True:
                    idx = buffer.find(b"\n")
                    if idx < 0:
                        break
                    raw_line = bytes(buffer[:idx])
                    del buffer[: idx + 1]
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\r")
                    if line:
                        handle_line(line)
            if buffer:
                trailing = buffer.decode("utf-8", errors="replace").rstrip("\r\n")
                if trailing:
                    handle_line(trailing)
        except Exception as exc:
            session.status = "ABORTED" if session.abort_requested else "FAILED"
            session.error = str(exc)
            self._append_event(
                session,
                {"kind": "event", "event": {"type": "run_failed", "run_id": session.run_id, "error": session.error}},
            )
        finally:
            return_code = None
            with contextlib.suppress(Exception):
                return_code = await process.wait()
            session.exit_code = return_code
            if session.status == "RUNNING":
                if return_code == 0:
                    session.status = "COMPLETED"
                    self._append_event(
                        session,
                        {"kind": "event", "event": {"type": "run_completed", "run_id": session.run_id, "message": "Run completed."}},
                    )
                else:
                    session.status = "ABORTED" if session.abort_requested else "FAILED"
                    session.error = session.error or f"Runner exited with code {return_code}"
                    if not session.error_message:
                        tail = self._log_tail_text(session)
                        if tail:
                            session.error_message = tail
                            session.error = f"{session.error}\n--- runner tail ---\n{tail}"
                    self._append_event(
                        session,
                        {
                            "kind": "event",
                            "event": {
                                "type": "run_failed",
                                "run_id": session.run_id,
                                "error": session.error,
                                "error_message": session.error_message or session.error,
                            },
                        },
                    )
            await self._finalize_session(session)

    async def _finalize_session(self, session: RunSession) -> None:
        session.completed_at = _now_iso()
        try:
            session.save_path.mkdir(parents=True, exist_ok=True)
            stdout_log = session.save_path / "stdout.log"
            stdout_log.write_text("\n".join(session.log_lines) + ("\n" if session.log_lines else ""), encoding="utf-8")
        except Exception:
            pass
        session.artifacts.update(self._discover_artifacts(session.save_path))
        self._append_event(
            session,
            {
                "kind": "terminal",
                "status": session.status,
                "exit_code": session.exit_code,
                "error": session.error,
                "error_code": session.error_code,
                "error_message": session.error_message,
                "failed_stage": session.failed_stage,
                "failed_agent": session.failed_agent,
                "attempt": session.attempt,
                "max_attempts": session.max_attempts,
                "artifacts": session.artifacts,
            },
        )
        async with self._lock:
            if self._active_run_id == session.run_id:
                self._active_run_id = None

    @staticmethod
    def _discover_artifacts(save_path: Path) -> Dict[str, Any]:
        artifacts = {"save_path": str(save_path)}
        known = {
            "complete_report_path": save_path / "complete_report.md",
            "final_state_path": save_path / "final_state.json",
            "stdout_log_path": save_path / "stdout.log",
            "full_agent_reports_path": save_path / "full_agent_reports.json",
        }
        for key, path in known.items():
            if path.exists():
                artifacts[key] = str(path)
        return artifacts


_runtime = EmbeddedUpstreamRuntime()


async def start_run(payload: Dict[str, Any]) -> Dict[str, Any]:
    return await _runtime.start_run(payload)


async def abort_run(run_id: str) -> Dict[str, Any]:
    return await _runtime.abort_run(run_id)


async def get_artifacts(run_id: str) -> Dict[str, Any]:
    return await _runtime.get_artifacts(run_id)


async def get_run(run_id: str) -> Dict[str, Any]:
    return await _runtime.get_run(run_id)


async def get_health() -> Dict[str, Any]:
    return await _runtime.get_health()


async def stream_events(run_id: str, *, from_seq: int = 0) -> AsyncIterator[Dict[str, Any]]:
    async for item in _runtime.stream_events(run_id, from_seq=from_seq):
        yield item
