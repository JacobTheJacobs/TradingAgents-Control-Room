"""
LLM Client - HTTP integration with finance_db_api LLM router.

Calls the Docker API on port 8000 for multi-provider LLM support.
"""

import logging
import os
import json
import re
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

# API base URL - default to finance_db_api if not overridden
FINANCE_DB_URL = os.getenv("FINANCE_DB_URL", "http://localhost:8000")
LLM_API_URL = os.getenv("LLM_API_URL", FINANCE_DB_URL)
def _resolve_ollama_api_url() -> str:
    raw = (
        os.getenv("OLLAMA_API_URL")
        or os.getenv("OLLAMA_HOST")
        or os.getenv("OLLAMA_BASE_URL")
        or "http://localhost:11434"
    )
    return str(raw).strip().rstrip("/")


OLLAMA_API_URL = _resolve_ollama_api_url()
NVIDIA_BASE_URL = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1").rstrip("/")
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "").strip()

# Default LLM provider and model from environment
LLM_DEFAULT_PROVIDER = os.getenv("LLM_DEFAULT_PROVIDER", "ollama")
LLM_DEFAULT_MODEL = os.getenv("LLM_DEFAULT_MODEL", "qwen3:8b")


class LLMClient:
    """LLM client that calls the finance_db_api via HTTP."""
    
    def __init__(self, provider: Optional[str] = None, model: Optional[str] = None):
        self.provider = provider or LLM_DEFAULT_PROVIDER
        self.model = model or LLM_DEFAULT_MODEL
        self._client = httpx.AsyncClient(timeout=120.0)  # 2 minute timeout for LLM calls

    def _headers(self) -> Dict[str, str]:
        return {}

    @staticmethod
    def _should_use_ollama_fallback(provider: Optional[str]) -> bool:
        return str(provider or "").strip().lower() == "ollama"

    @staticmethod
    def _should_use_nvidia_direct(provider: Optional[str]) -> bool:
        return str(provider or "").strip().lower() == "nvidia"

    async def _nvidia_chat_completion(
        self,
        *,
        prompt: str,
        system_prompt: Optional[str],
        model: str,
        expect_json: bool,
        use_response_format: bool = True,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> Any:
        if not NVIDIA_API_KEY:
            raise RuntimeError("NVIDIA_API_KEY is not configured.")

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": float(temperature) if temperature is not None else (0.2 if expect_json else 0.4),
            "top_p": 0.95,
            "stream": False,
            "max_tokens": max_tokens or (2048 if expect_json else 3072),
        }
        if expect_json and use_response_format:
            payload["response_format"] = {"type": "json_object"}

        headers = {
            "Authorization": f"Bearer {NVIDIA_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        response = await self._client.post(
            f"{NVIDIA_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
        )
        if response.status_code in {400, 500, 502, 503, 504} and expect_json and "response_format" in payload:
            # Some NVIDIA-hosted models reject response_format=json_object.
            # Some return 5xx instead of 400. Retry once without that flag,
            # keep prompt strict, then parse JSON ourselves.
            fallback_payload = dict(payload)
            fallback_payload.pop("response_format", None)
            fallback_payload["temperature"] = min(float(fallback_payload.get("temperature", 0.2)), 0.2)
            logger.warning(
                "NVIDIA model rejected response_format with HTTP %s; retrying without response_format for model=%s",
                response.status_code,
                model,
            )
            response = await self._client.post(
                f"{NVIDIA_BASE_URL}/chat/completions",
                headers=headers,
                json=fallback_payload,
            )
        response.raise_for_status()
        data = response.json()
        content = (
            (((data or {}).get("choices") or [{}])[0].get("message") or {}).get("content")
            or ""
        )
        if isinstance(content, list):
            text = "".join(str(item.get("text") or item.get("content") or "") for item in content if isinstance(item, dict)).strip()
        elif isinstance(content, dict):
            text = str(content.get("text") or content.get("content") or "").strip()
        else:
            text = str(content).strip()
        if not expect_json:
            return text
        if not text:
            raise RuntimeError("NVIDIA returned empty JSON response")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            parsed = self._extract_json_object_from_text(text)
            if parsed is not None:
                return parsed
            logger.error("NVIDIA JSON decode failed: %s | raw=%s", exc, text[:400])
            raise RuntimeError("NVIDIA returned invalid JSON") from exc

    @staticmethod
    def _extract_json_object_from_text(text: str) -> Optional[Dict[str, Any]]:
        raw = str(text or "").strip()
        if not raw:
            return None

        cleaned = raw
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE).strip()
            cleaned = re.sub(r"\s*```$", "", cleaned).strip()
            try:
                parsed = json.loads(cleaned)
                return parsed if isinstance(parsed, dict) else None
            except Exception:
                pass

        # Common fenced-code wrapper path
        fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, flags=re.IGNORECASE)
        if fence_match:
            candidate = fence_match.group(1).strip()
            try:
                parsed = json.loads(candidate)
                return parsed if isinstance(parsed, dict) else None
            except Exception:
                pass

        # Best-effort balanced object extraction for wrapped prose/fences.
        balanced = LLMClient._extract_balanced_json_object(raw)
        if balanced:
            try:
                parsed = json.loads(balanced)
                return parsed if isinstance(parsed, dict) else None
            except Exception:
                pass

        # Last-ditch extraction for models that produce JSON-like arrays but
        # wrap them in malformed fences/prose. This keeps the content LLM-sourced
        # while letting downstream schema validation reject incomplete output.
        extracted_lines = LLMClient._extract_json_like_lines(raw)
        if extracted_lines:
            return {"lines": extracted_lines}

        # Best-effort object extraction for wrapped prose
        first = raw.find("{")
        last = raw.rfind("}")
        if first >= 0 and last > first:
            candidate = raw[first:last + 1]
            try:
                parsed = json.loads(candidate)
                return parsed if isinstance(parsed, dict) else None
            except Exception:
                return None
        return None

    @staticmethod
    def _extract_balanced_json_object(text: str) -> Optional[str]:
        start = text.find("{")
        if start < 0:
            return None
        depth = 0
        in_string = False
        escaped = False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return text[start:index + 1]
        return None

    @staticmethod
    def _unescape_json_string_fragment(value: str) -> str:
        try:
            return json.loads(f'"{value}"')
        except Exception:
            return value.replace('\\"', '"').replace("\\n", " ").replace("\\t", " ").strip()

    @staticmethod
    def _extract_json_like_lines(text: str) -> Optional[list[Dict[str, str]]]:
        pairs = re.findall(
            r'"speaker"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"',
            text,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not pairs:
            pairs = re.findall(
                r'"text"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"speaker"\s*:\s*"((?:\\.|[^"\\])*)"',
                text,
                flags=re.IGNORECASE | re.DOTALL,
            )
            pairs = [(speaker, line) for line, speaker in pairs]
        if not pairs:
            return None
        lines: list[Dict[str, str]] = []
        for speaker, line in pairs:
            lines.append(
                {
                    "speaker": LLMClient._unescape_json_string_fragment(speaker),
                    "text": LLMClient._unescape_json_string_fragment(line),
                }
            )
        return lines

    async def _ollama_generate(
        self,
        prompt: str,
        system_prompt: Optional[str],
        model: str,
        *,
        expect_json: bool,
    ) -> Any:
        payload: Dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "stream": False,
        }
        if system_prompt:
            payload["system"] = system_prompt
        if expect_json:
            payload["format"] = "json"

        response = await self._client.post(f"{OLLAMA_API_URL}/api/generate", json=payload)
        response.raise_for_status()
        data = response.json()
        text = (data.get("response") or "").strip()

        if not expect_json:
            return text

        if not text:
            raise RuntimeError("Ollama returned empty JSON response")

        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            logger.error("Ollama JSON decode failed: %s | raw=%s", exc, text[:400])
            raise RuntimeError("Ollama returned invalid JSON") from exc
    
    async def generate(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ) -> str:
        """Generate text from the LLM via HTTP API."""
        use_provider = provider or self.provider
        use_model = model or self.model
        
        payload = {
            "prompt": prompt,
            "system_prompt": system_prompt,
            "provider": use_provider,
            "model": use_model,
        }
        
        try:
            response = await self._client.post(
                f"{LLM_API_URL}/api/v2/llm/generate",
                json=payload,
                headers=self._headers()
            )
            response.raise_for_status()
            data = response.json()
            
            logger.info(f"LLM generate: provider={data.get('provider')}, model={data.get('model')}, time={data.get('response_time_ms', 0):.0f}ms")
            
            return data["text"]
            
        except httpx.HTTPStatusError as e:
            logger.error(f"LLM API error: {e.response.status_code} - {e.response.text}")
            raise RuntimeError(f"LLM API error: {e.response.status_code}")
        except httpx.ConnectError as e:
            if self._should_use_ollama_fallback(use_provider):
                logger.warning("LLM router unavailable at %s, falling back to Ollama at %s", LLM_API_URL, OLLAMA_API_URL)
                try:
                    return await self._ollama_generate(
                        prompt=prompt,
                        system_prompt=system_prompt,
                        model=use_model,
                        expect_json=False,
                    )
                except httpx.ConnectError as ollama_exc:
                    logger.error("Cannot connect to Ollama API at %s: %s", OLLAMA_API_URL, ollama_exc)
                    raise RuntimeError(f"Cannot connect to Ollama API at {OLLAMA_API_URL}. Is Ollama running?") from ollama_exc
            if self._should_use_nvidia_direct(use_provider):
                logger.warning("LLM router unavailable at %s, falling back to direct NVIDIA API at %s", LLM_API_URL, NVIDIA_BASE_URL)
                try:
                    return await self._nvidia_chat_completion(
                        prompt=prompt,
                        system_prompt=system_prompt,
                        model=use_model,
                        expect_json=False,
                    )
                except Exception as nvidia_exc:
                    logger.error("Direct NVIDIA fallback failed: %s", nvidia_exc)
                    raise RuntimeError(f"NVIDIA direct fallback failed: {nvidia_exc}") from nvidia_exc
            logger.error(f"Cannot connect to LLM API at {LLM_API_URL}: {e}")
            raise RuntimeError(f"Cannot connect to LLM API at {LLM_API_URL}. Is Docker container running?")
        except Exception as e:
            logger.error(f"LLM generate failed: {e}")
            raise
    
    async def generate_json(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Generate JSON from the LLM via HTTP API."""
        use_provider = provider or self.provider
        use_model = model or self.model
        
        payload = {
            "prompt": prompt,
            "system_prompt": system_prompt,
            "provider": use_provider,
            "model": use_model,
        }
        
        logger.info(f"LLM generate_json: provider={use_provider}, model={use_model}")
        
        url = f"{LLM_API_URL}/api/v2/llm/generate/json"
        logger.info(f"LLM generate_json calling URL: {url}")
        
        try:
            response = await self._client.post(
                url,
                json=payload,
                headers=self._headers()
            )
            response.raise_for_status()
            data = response.json()
            
            logger.info(f"LLM generate_json response type: {type(data).__name__}")
            
            # Handle different response formats:
            # 1. Wrapped format: {"json": {...}, "provider": "...", "model": "..."}
            # 2. Direct format: {...} - the JSON is returned directly
            if isinstance(data, dict):
                if "json" in data:
                    return data["json"]
                elif "result" in data:
                    return data["result"]
                elif "response" in data:
                    return data["response"]
                elif "provider" in data or "model" in data:
                    # Wrapped but no 'json' key - check for other known keys
                    pass
                else:
                    # Direct JSON response - return as-is
                    return data
            
            # Fallback - return the data
            return data
            
        except httpx.HTTPStatusError as e:
            logger.error(f"LLM API error: {e.response.status_code} - {e.response.text}")
            raise RuntimeError(f"LLM API error: {e.response.status_code}")
        except httpx.ConnectError as e:
            if self._should_use_ollama_fallback(use_provider):
                logger.warning("LLM router unavailable at %s, falling back to Ollama at %s for JSON generation", LLM_API_URL, OLLAMA_API_URL)
                try:
                    return await self._ollama_generate(
                        prompt=prompt,
                        system_prompt=system_prompt,
                        model=use_model,
                        expect_json=True,
                    )
                except httpx.ConnectError as ollama_exc:
                    logger.error("Cannot connect to Ollama API at %s: %s", OLLAMA_API_URL, ollama_exc)
                    raise RuntimeError(f"Cannot connect to Ollama API at {OLLAMA_API_URL}. Is Ollama running?") from ollama_exc
            if self._should_use_nvidia_direct(use_provider):
                logger.warning("LLM router unavailable at %s, falling back to direct NVIDIA API at %s for JSON generation", LLM_API_URL, NVIDIA_BASE_URL)
                try:
                    return await self._nvidia_chat_completion(
                        prompt=prompt,
                        system_prompt=system_prompt,
                        model=use_model,
                        expect_json=True,
                    )
                except Exception as nvidia_exc:
                    logger.error("Direct NVIDIA JSON fallback failed: %s", nvidia_exc)
                    raise RuntimeError(f"NVIDIA direct fallback failed: {nvidia_exc}") from nvidia_exc
            logger.error(f"Cannot connect to LLM API at {LLM_API_URL}: {e}")
            raise RuntimeError(f"Cannot connect to LLM API at {LLM_API_URL}. Is Docker container running?")
        except Exception as e:
            logger.error(f"LLM generate_json failed: {e}")
            raise

    async def generate_scene_json(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Dedicated scene-writer JSON generation path.
        For NVIDIA provider, bypasses the local router and hits NVIDIA directly first.
        """
        use_provider = provider or self.provider
        use_model = model or self.model

        if self._should_use_ollama_fallback(use_provider):
            return await self._ollama_generate(
                prompt=prompt,
                system_prompt=system_prompt,
                model=use_model,
                expect_json=True,
            )

        if self._should_use_nvidia_direct(use_provider):
            return await self._nvidia_chat_completion(
                prompt=prompt,
                system_prompt=system_prompt,
                model=use_model,
                expect_json=True,
                use_response_format=True,
                max_tokens=3072,
                temperature=temperature,
            )

        # Non-NVIDIA providers still use the standard JSON route.
        return await self.generate_json(
            prompt=prompt,
            system_prompt=system_prompt,
            provider=use_provider,
            model=use_model,
        )
    
    async def get_status(self) -> Dict[str, Any]:
        """Get router status via HTTP API."""
        try:
            response = await self._client.get(f"{LLM_API_URL}/api/v2/llm/status")
            response.raise_for_status()
            return response.json()
        except httpx.ConnectError:
            if self._should_use_ollama_fallback(self.provider):
                try:
                    response = await self._client.get(f"{OLLAMA_API_URL}/api/tags")
                    response.raise_for_status()
                    data = response.json()
                    return {
                        "provider": "ollama",
                        "base_url": OLLAMA_API_URL,
                        "models": [m.get("name") for m in data.get("models", []) if m.get("name")],
                        "fallback": True,
                    }
                except Exception as fallback_exc:
                    return {"error": str(fallback_exc)}
        except Exception as e:
            return {"error": str(e)}
    
    async def close(self):
        """Close the HTTP client."""
        await self._client.aclose()


# Singleton instance
_llm_client: Optional[LLMClient] = None


def get_llm_client() -> LLMClient:
    """Get the singleton LLM client instance."""
    global _llm_client
    if _llm_client is None:
        _llm_client = LLMClient()
    return _llm_client


async def close():
    """Close the LLM client."""
    global _llm_client
    if _llm_client:
        await _llm_client.close()
        _llm_client = None
