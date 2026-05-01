from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import sys
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Deque, Dict, Optional, Set, Union

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import uvicorn


logger = logging.getLogger("tradingagents_upstream_sidecar")
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [sidecar] %(message)s",
)


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _default_workdir() -> Path:
    env_path = os.getenv("UPSTREAM_CLI_WORKDIR")
    if env_path:
        return Path(env_path).resolve()
    return (Path(__file__).resolve().parents[2] / "external" / "TradingAgents-upstream").resolve()


def _default_runs_dir() -> Path:
    env_path = os.getenv("UPSTREAM_RUNS_DIR")
    if env_path:
        return Path(env_path).resolve()
    return (Path(__file__).resolve().parents[2] / "tmp" / "tradingagents-runs").resolve()


def _event_backlog_limit() -> int:
    try:
        return max(1000, int(os.getenv("UPSTREAM_EVENT_BACKLOG", "8000")))
    except (TypeError, ValueError):
        return 8000


def _normalize_research_depth(value: Union[str, int, float, None]) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"quick", "shallow", "1"}:
        return "quick"
    if raw in {"deep", "5"}:
        return "deep"
    if raw in {"standard", "normal", "medium", "3"}:
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


def _resolve_run_timeout_seconds(depth: Union[str, int, float, None]) -> int:
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
        "quick": 30 * 60,
        "standard": 45 * 60,
        "deep": 70 * 60,
    }
    return defaults.get(depth_key, defaults["standard"])


def _resolve_max_attempts() -> int:
    try:
        return max(1, int(os.getenv("UPSTREAM_MAX_ATTEMPTS", "3")))
    except Exception:
        return 3


def _to_nonneg_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(float(value)))
    except Exception:
        return max(0, int(default))


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
    max_attempts: Optional[int] = None
    llm_calls: int = 0
    tool_calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    artifacts: Dict[str, Any] = field(default_factory=dict)
    events: Deque[Dict[str, Any]] = field(default_factory=lambda: deque(maxlen=_event_backlog_limit()))
    subscribers: Set[asyncio.Queue] = field(default_factory=set)
    process: Optional[asyncio.subprocess.Process] = None
    stream_task: Optional[asyncio.Task] = None
    next_sequence: int = 1
    abort_requested: bool = False
    timeout_seconds: int = 0
    deadline_monotonic: float = 0.0
    max_attempts: int = 1


class RunRequest(BaseModel):
    run_id: Optional[str] = Field(default=None)
    ticker: str
    date: str
    provider: str
    quick_model: str = Field(alias="quickModel")
    deep_model: str = Field(alias="deepModel")
    research_depth: Union[str, int] = Field(default="standard", alias="researchDepth")
    output_language: str = Field(default="English", alias="outputLanguage")
    save_path: Optional[str] = Field(default=None, alias="savePath")

    model_config = {"populate_by_name": True, "extra": "allow"}


class SidecarState:
    def __init__(self) -> None:
        self._sessions: Dict[str, RunSession] = {}
        self._active_run_id: Optional[str] = None
        self._lock = asyncio.Lock()
        self.workdir = _default_workdir()
        self.runs_dir = _default_runs_dir()
        self.runs_dir.mkdir(parents=True, exist_ok=True)

    @property
    def active_run_id(self) -> Optional[str]:
        return self._active_run_id

    def get_session(self, run_id: str) -> Optional[RunSession]:
        return self._sessions.get(run_id)

    async def start_run(self, request: RunRequest) -> RunSession:
        async with self._lock:
            if self._active_run_id:
                active = self._sessions.get(self._active_run_id)
                if active and active.status == "RUNNING":
                    raise HTTPException(status_code=409, detail=f"Run already active: {active.run_id}")

            run_id = request.run_id or f"upstream-{uuid.uuid4().hex[:12]}"
            save_path = Path(request.save_path).resolve() if request.save_path else (self.runs_dir / run_id)
            save_path.mkdir(parents=True, exist_ok=True)

            command = [
                sys.executable,
                "-m",
                "src.upstream_cli_sidecar.runner",
                "--ticker",
                request.ticker,
                "--date",
                request.date,
                "--provider",
                request.provider,
                "--quick-model",
                request.quick_model,
                "--deep-model",
                request.deep_model,
                "--research-depth",
                str(request.research_depth),
                "--output-language",
                request.output_language,
                "--save-path",
                str(save_path),
                "--run-id",
                run_id,
            ]

            env = os.environ.copy()
            env["PYTHONUNBUFFERED"] = "1"

            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(self.workdir),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )

            session = RunSession(
                run_id=run_id,
                request=request.model_dump(by_alias=False),
                save_path=save_path,
                started_at=_now_iso(),
                process=process,
                timeout_seconds=_resolve_run_timeout_seconds(request.research_depth),
                deadline_monotonic=time.monotonic() + _resolve_run_timeout_seconds(request.research_depth),
                max_attempts=_resolve_max_attempts(),
            )
            self._sessions[run_id] = session
            self._active_run_id = run_id

            self._append_event(
                session,
                {
                    "kind": "session",
                    "run_id": run_id,
                    "status": session.status,
                    "message": "Run process started.",
                    "pid": process.pid,
                    "timeout_seconds": session.timeout_seconds,
                },
            )

            session.stream_task = asyncio.create_task(self._stream_process(session))
            return session

    async def abort_run(self, run_id: str) -> RunSession:
        session = self._sessions.get(run_id)
        if not session:
            raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
        if session.status != "RUNNING":
            return session
        if not session.process:
            return session

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
        return session

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

    async def _stream_process(self, session: RunSession) -> None:
        process = session.process
        if not process or not process.stdout:
            session.status = "FAILED"
            session.error = "Missing subprocess stdout pipe."
            self._append_event(
                session,
                {
                    "kind": "event",
                    "event": {
                        "type": "run_failed",
                        "run_id": session.run_id,
                        "error": session.error,
                    },
                },
            )
            await self._finalize_session(session)
            return

        def handle_line(line: str) -> None:
            parsed: Optional[Dict[str, Any]] = None
            try:
                candidate = json.loads(line)
                if isinstance(candidate, dict) and candidate.get("type"):
                    parsed = candidate
            except Exception:
                parsed = None

            if parsed is not None:
                parsed.setdefault("run_id", session.run_id)
                event_type = str(parsed.get("type") or "").lower()
                if event_type == "run_completed":
                    session.status = "COMPLETED"
                    session.artifacts.update(parsed.get("artifacts") or {})
                    session.attempt = parsed.get("attempt")
                    session.max_attempts = parsed.get("max_attempts")
                elif event_type == "run_failed":
                    session.status = "ABORTED" if session.abort_requested else "FAILED"
                    session.error_code = str(parsed.get("error_code") or "").strip() or None
                    session.error_message = str(parsed.get("error_message") or parsed.get("error") or parsed.get("message") or "Run failed.").strip()
                    session.failed_stage = str(parsed.get("failed_stage") or "").strip() or None
                    session.failed_agent = str(parsed.get("failed_agent") or "").strip() or None
                    session.attempt = parsed.get("attempt")
                    session.max_attempts = parsed.get("max_attempts")
                    session.error = session.error_message
                elif event_type == "run_retrying":
                    session.attempt = parsed.get("attempt")
                    session.max_attempts = parsed.get("max_attempts")
                elif event_type == "run_telemetry":
                    session.llm_calls = _to_nonneg_int(parsed.get("llm_calls"), session.llm_calls)
                    session.tool_calls = _to_nonneg_int(parsed.get("tool_calls"), session.tool_calls)
                    session.tokens_in = _to_nonneg_int(parsed.get("tokens_in"), session.tokens_in)
                    session.tokens_out = _to_nonneg_int(parsed.get("tokens_out"), session.tokens_out)
                if event_type in {"run_completed", "run_failed", "run_telemetry"}:
                    session.llm_calls = _to_nonneg_int(parsed.get("llm_calls"), session.llm_calls)
                    session.tool_calls = _to_nonneg_int(parsed.get("tool_calls"), session.tool_calls)
                    session.tokens_in = _to_nonneg_int(parsed.get("tokens_in"), session.tokens_in)
                    session.tokens_out = _to_nonneg_int(parsed.get("tokens_out"), session.tokens_out)
                elif event_type == "log":
                    self._append_event(
                        session,
                        {
                            "kind": "raw_log",
                            "line": str(parsed.get("message") or ""),
                            "level": parsed.get("level"),
                        },
                    )
                self._append_event(session, {"kind": "event", "event": parsed})
            else:
                self._append_event(session, {"kind": "raw_log", "line": line})

        try:
            buffer = bytearray()
            while True:
                if (
                    session.status == "RUNNING"
                    and session.timeout_seconds > 0
                    and time.monotonic() >= session.deadline_monotonic
                ):
                    session.status = "ABORTED" if session.abort_requested else "FAILED"
                    session.error_code = "UPSTREAM_TIMEOUT"
                    session.error_message = f"UPSTREAM_TIMEOUT: run exceeded {session.timeout_seconds}s wall-clock limit."
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
                                "attempt": 1,
                                "max_attempts": session.max_attempts,
                            },
                        },
                    )
                    if process.returncode is None:
                        process.terminate()
                        try:
                            await asyncio.wait_for(process.wait(), timeout=5)
                        except asyncio.TimeoutError:
                            process.kill()
                            with contextlib.suppress(Exception):
                                await asyncio.wait_for(process.wait(), timeout=5)
                    break
                try:
                    raw_chunk = await asyncio.wait_for(process.stdout.read(65536), timeout=2.0)
                except asyncio.TimeoutError:
                    continue
                if not raw_chunk:
                    break
                buffer.extend(raw_chunk)
                while True:
                    newline_index = buffer.find(b"\n")
                    if newline_index < 0:
                        break
                    raw_line = bytes(buffer[:newline_index])
                    del buffer[: newline_index + 1]
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\r")
                    if not line:
                        continue
                    handle_line(line)

            if buffer:
                trailing = buffer.decode("utf-8", errors="replace").rstrip("\r\n")
                if trailing:
                    handle_line(trailing)
        except Exception as exc:
            logger.exception("Run stream error for %s: %s", session.run_id, exc)
            session.status = "ABORTED" if session.abort_requested else "FAILED"
            session.error = str(exc)
            self._append_event(
                session,
                {
                    "kind": "event",
                    "event": {
                        "type": "run_failed",
                        "run_id": session.run_id,
                        "error": session.error,
                    },
                },
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
                        {
                            "kind": "event",
                            "event": {
                                "type": "run_completed",
                                "run_id": session.run_id,
                                "message": "Run completed.",
                            },
                        },
                    )
                else:
                    session.status = "ABORTED" if session.abort_requested else "FAILED"
                    session.error = session.error or f"CLI exited with code {return_code}"
                    self._append_event(
                        session,
                        {
                            "kind": "event",
                            "event": {
                                "type": "run_failed",
                                "run_id": session.run_id,
                                "error": session.error,
                            },
                        },
                    )
            await self._finalize_session(session)

    async def _finalize_session(self, session: RunSession) -> None:
        session.completed_at = _now_iso()
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

    def _discover_artifacts(self, save_path: Path) -> Dict[str, Any]:
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


state = SidecarState()
app = FastAPI(title="TradingAgents Upstream Sidecar", version="1.0.0")


@app.get("/health")
async def health() -> Dict[str, Any]:
    active = state.get_session(state.active_run_id) if state.active_run_id else None
    return {
        "ok": True,
        "active_run_id": state.active_run_id,
        "active_status": active.status if active else None,
        "workdir": str(state.workdir),
        "runs_dir": str(state.runs_dir),
    }


@app.post("/runs")
async def start_run(request: RunRequest) -> Dict[str, Any]:
    if not state.workdir.exists():
        raise HTTPException(status_code=500, detail=f"Upstream workdir not found: {state.workdir}")
    session = await state.start_run(request)
    return {
        "run_id": session.run_id,
        "status": session.status,
        "started_at": session.started_at,
        "pid": session.process.pid if session.process else None,
        "save_path": str(session.save_path),
        "events_url": f"/runs/{session.run_id}/events",
        "artifacts_url": f"/runs/{session.run_id}/artifacts",
    }


@app.post("/runs/{run_id}/abort")
async def abort_run(run_id: str) -> Dict[str, Any]:
    session = await state.abort_run(run_id)
    return {
        "run_id": session.run_id,
        "status": session.status,
        "abort_requested": session.abort_requested,
    }


@app.get("/runs/{run_id}")
async def get_run(run_id: str) -> Dict[str, Any]:
    session = state.get_session(run_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
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


@app.get("/runs/{run_id}/artifacts")
async def get_artifacts(run_id: str) -> Dict[str, Any]:
    session = state.get_session(run_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    artifacts = dict(session.artifacts or {})
    if not artifacts:
        artifacts = state._discover_artifacts(session.save_path)
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


@app.get("/runs/{run_id}/events")
async def stream_events(run_id: str, from_seq: int = 0) -> StreamingResponse:
    session = state.get_session(run_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")

    async def event_generator() -> Iterable[str]:
        queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        session.subscribers.add(queue)
        try:
            for event in list(session.events):
                if int(event.get("sequence") or 0) > from_seq:
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    if session.status != "RUNNING":
                        break
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event.get("kind") == "terminal":
                    break
        finally:
            session.subscribers.discard(queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


if __name__ == "__main__":
    host = os.getenv("UPSTREAM_SIDECAR_HOST", "0.0.0.0")
    port = int(os.getenv("UPSTREAM_SIDECAR_PORT", "8011"))
    uvicorn.run("src.upstream_cli_sidecar.main:app", host=host, port=port, log_level="info")
