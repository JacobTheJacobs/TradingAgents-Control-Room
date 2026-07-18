"""Shared runtime state for TradingAgents manual runs.

This avoids relying solely on in-memory globals, which break if requests are
served by different worker processes.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

try:
    import psutil
except Exception:  # pragma: no cover - optional runtime dependency
    psutil = None


DEFAULT_LEGACY_STATE_DIR = Path(tempfile.gettempdir()) / "ai-hedge-fund-v5" / "state"
LEGACY_STATE_DIR = Path(os.getenv("AI_HEDGE_FUND_STATE_DIR") or DEFAULT_LEGACY_STATE_DIR)
ACTIVE_RUN_FILE = LEGACY_STATE_DIR / "tradingagents_active_run.json"
ABORT_REQUEST_FILE = LEGACY_STATE_DIR / "tradingagents_abort_request.json"
ACTIVE_RUN_CONFIG_KEY = "tradingagents_active_run"
ABORT_REQUEST_CONFIG_KEY = "tradingagents_abort_request"
logger = logging.getLogger(__name__)


def build_tradingagents_run_id(
    ticker: Optional[str],
    trade_date: Optional[str] = None,
    *,
    cycle: Optional[int] = None,
    prefix: str = "ta",
) -> str:
    ticker_token = "".join(ch for ch in str(ticker or "UNKNOWN").upper() if ch.isalnum()) or "UNKNOWN"
    date_token = "".join(ch for ch in str(trade_date or "").strip() if ch.isdigit())[:8]
    if not date_token:
        date_token = datetime.utcnow().strftime("%Y%m%d")
    cycle_token = f"-c{int(cycle)}" if cycle is not None else ""
    timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S%f")
    suffix = uuid4().hex[:10]
    return f"{prefix}-{ticker_token}-{date_token}{cycle_token}-{timestamp}-{suffix}"


def _data_access():
    from src.analytics.data_access import get_data_access
    return get_data_access()


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _import_legacy_config_if_needed(config_key: str, legacy_path: Path) -> Optional[Dict[str, Any]]:
    data_access = _data_access()
    current = data_access.get_config(config_key)
    if isinstance(current, dict):
        return current

    legacy_payload = _read_json(legacy_path)
    if not isinstance(legacy_payload, dict):
        return None

    if not data_access.set_config(config_key, legacy_payload):
        raise RuntimeError(f"Failed to import legacy runtime config for {config_key}")

    try:
        legacy_path.unlink(missing_ok=True)
    except Exception:
        logger.warning("[TA-RUNTIME] Failed to remove legacy file after DB import: %s", legacy_path)
    return legacy_payload


def _read_runtime_state(config_key: str, legacy_path: Path) -> Optional[Dict[str, Any]]:
    imported = _import_legacy_config_if_needed(config_key, legacy_path)
    if isinstance(imported, dict):
        return imported
    current = _data_access().get_config(config_key)
    return current if isinstance(current, dict) else None


def _write_runtime_state(config_key: str, payload: Dict[str, Any]) -> None:
    if not _data_access().set_config(config_key, payload):
        raise RuntimeError(f"Failed to persist runtime state for {config_key}")


def set_active_run(run_id: str, ticker: str, trade_date: str, depth: str, status: str = "running") -> None:
    _write_runtime_state(
        ACTIVE_RUN_CONFIG_KEY,
        {
            "run_id": run_id,
            "ticker": ticker,
            "trade_date": trade_date,
            "depth": depth,
            "status": status,
            "pid": os.getpid(),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        },
    )


def load_active_run() -> Optional[Dict[str, Any]]:
    active = _read_runtime_state(ACTIVE_RUN_CONFIG_KEY, ACTIVE_RUN_FILE)
    if _is_stale_active_run(active):
        stale_run_id = active.get("run_id") if active else None
        logger.warning(
            "[TA-RUNTIME] Clearing stale active run state for %s (pid=%s)",
            stale_run_id,
            active.get("pid") if active else None,
        )
        clear_active_run(stale_run_id)
        clear_abort_request(stale_run_id)
        return None
    return active


def update_active_run(run_id: str, **updates: Any) -> None:
    active = load_active_run()
    if not active or active.get("run_id") != run_id:
        return
    active.update(updates)
    active["updated_at"] = datetime.utcnow().isoformat() + "Z"
    _write_runtime_state(ACTIVE_RUN_CONFIG_KEY, active)


def clear_active_run(run_id: Optional[str] = None) -> None:
    active = _read_runtime_state(ACTIVE_RUN_CONFIG_KEY, ACTIVE_RUN_FILE)
    if run_id and active and active.get("run_id") != run_id:
        return
    if not _data_access().delete_config(ACTIVE_RUN_CONFIG_KEY):
        raise RuntimeError("Failed to clear TradingAgents active run state")


def request_abort(
    run_id: Optional[str],
    *,
    reason: str = "user",
    source: Optional[str] = None,
) -> None:
    if not run_id:
        logger.warning("[TA-RUNTIME] Ignoring abort request with empty run_id (reason=%s source=%s)", reason, source)
        return
    _write_runtime_state(
        ABORT_REQUEST_CONFIG_KEY,
        {
            "run_id": run_id,
            "requested_at": datetime.utcnow().isoformat() + "Z",
            "pid": os.getpid(),
            "reason": str(reason or "user").strip().lower(),
            "source": str(source or "").strip() or None,
        },
    )


def get_abort_request(run_id: Optional[str]) -> Optional[Dict[str, Any]]:
    request = _read_runtime_state(ABORT_REQUEST_CONFIG_KEY, ABORT_REQUEST_FILE)
    if not request:
        return None
    requested_run_id = request.get("run_id")
    if requested_run_id in (None, run_id):
        return request
    return None


def is_abort_requested(run_id: Optional[str]) -> bool:
    return bool(get_abort_request(run_id))


def clear_abort_request(run_id: Optional[str] = None) -> None:
    request = _read_runtime_state(ABORT_REQUEST_CONFIG_KEY, ABORT_REQUEST_FILE)
    if run_id and request and request.get("run_id") not in (None, run_id):
        return
    if not _data_access().delete_config(ABORT_REQUEST_CONFIG_KEY):
        raise RuntimeError("Failed to clear TradingAgents abort request state")


def _is_stale_active_run(active: Optional[Dict[str, Any]]) -> bool:
    if not active or str(active.get("status") or "").lower() != "running":
        return False
    pid = active.get("pid")
    if pid in (None, ""):
        return False
    return not _is_pid_alive(pid)


def _is_pid_alive(pid: Any) -> bool:
    try:
        pid_int = int(pid)
    except (TypeError, ValueError):
        return False
    if pid_int <= 0:
        return False
    if psutil is None:
        try:
            os.kill(pid_int, 0)
            return True
        except OSError:
            return False
    try:
        proc = psutil.Process(pid_int)
        return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return False
