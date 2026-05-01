from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator, Dict, Optional

import httpx


class SidecarError(RuntimeError):
    """Raised when the TradingAgents upstream sidecar fails."""

    def __init__(self, message: str, *, status_code: Optional[int] = None, payload: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


def _base_url() -> str:
    return str(os.getenv("TRADINGAGENTS_UPSTREAM_URL") or "http://127.0.0.1:8011").rstrip("/")


def _request_timeout() -> httpx.Timeout:
    return httpx.Timeout(connect=6.0, read=30.0, write=30.0, pool=6.0)


def _stream_timeout() -> httpx.Timeout:
    return httpx.Timeout(connect=6.0, read=None, write=30.0, pool=6.0)


async def _json_or_text(response: httpx.Response) -> Any:
    text = response.text
    if not text:
        return None
    try:
        return response.json()
    except Exception:
        return text


async def start_run(payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(base_url=_base_url(), timeout=_request_timeout()) as client:
            response = await client.post("/runs", json=payload)
    except httpx.HTTPError as exc:
        raise SidecarError(f"Sidecar start request failed: {exc}") from exc
    if response.status_code >= 400:
        detail = await _json_or_text(response)
        raise SidecarError(
            f"Sidecar start failed with status {response.status_code}",
            status_code=response.status_code,
            payload=detail,
        )
    try:
        return response.json()
    except Exception as exc:
        raise SidecarError("Invalid JSON response from sidecar /runs") from exc


async def abort_run(run_id: str) -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(base_url=_base_url(), timeout=_request_timeout()) as client:
            response = await client.post(f"/runs/{run_id}/abort")
    except httpx.HTTPError as exc:
        raise SidecarError(f"Sidecar abort request failed: {exc}") from exc
    if response.status_code >= 400:
        detail = await _json_or_text(response)
        raise SidecarError(
            f"Sidecar abort failed with status {response.status_code}",
            status_code=response.status_code,
            payload=detail,
        )
    return response.json()


async def get_artifacts(run_id: str) -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(base_url=_base_url(), timeout=_request_timeout()) as client:
            response = await client.get(f"/runs/{run_id}/artifacts")
    except httpx.HTTPError as exc:
        raise SidecarError(f"Sidecar artifacts request failed: {exc}") from exc
    if response.status_code >= 400:
        detail = await _json_or_text(response)
        raise SidecarError(
            f"Sidecar artifacts request failed with status {response.status_code}",
            status_code=response.status_code,
            payload=detail,
        )
    return response.json()


async def get_run(run_id: str) -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(base_url=_base_url(), timeout=_request_timeout()) as client:
            response = await client.get(f"/runs/{run_id}")
    except httpx.HTTPError as exc:
        raise SidecarError(f"Sidecar run request failed: {exc}") from exc
    if response.status_code >= 400:
        detail = await _json_or_text(response)
        raise SidecarError(
            f"Sidecar run request failed with status {response.status_code}",
            status_code=response.status_code,
            payload=detail,
        )
    return response.json()


async def get_health() -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(base_url=_base_url(), timeout=_request_timeout()) as client:
            response = await client.get("/health")
    except httpx.HTTPError as exc:
        raise SidecarError(f"Sidecar health request failed: {exc}") from exc
    if response.status_code >= 400:
        detail = await _json_or_text(response)
        raise SidecarError(
            f"Sidecar health request failed with status {response.status_code}",
            status_code=response.status_code,
            payload=detail,
        )
    return response.json()


async def stream_events(run_id: str, *, from_seq: int = 0) -> AsyncIterator[Dict[str, Any]]:
    try:
        async with httpx.AsyncClient(base_url=_base_url(), timeout=_stream_timeout()) as client:
            async with client.stream(
                "GET",
                f"/runs/{run_id}/events",
                params={"from_seq": from_seq},
            ) as response:
                if response.status_code >= 400:
                    detail = await _json_or_text(response)
                    raise SidecarError(
                        f"Sidecar stream failed with status {response.status_code}",
                        status_code=response.status_code,
                        payload=detail,
                    )

                async for line in response.aiter_lines():
                    if not line:
                        continue
                    if line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data:
                        continue
                    try:
                        payload = json.loads(data)
                    except Exception:
                        payload = {
                            "kind": "raw_log",
                            "line": data,
                        }
                    if isinstance(payload, dict):
                        yield payload
    except SidecarError:
        raise
    except httpx.HTTPError as exc:
        raise SidecarError(f"Sidecar stream request failed: {exc}") from exc
