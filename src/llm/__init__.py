# LLM module - Thin client wrapper for finance_db_api
# All LLM calls are made via the API server endpoints:
# POST /api/v2/llm/generate
# POST /api/v2/llm/generate/json
# GET  /api/v2/llm/status
# GET  /api/v2/llm/providers

from .client import LLMClient, get_llm_client

__all__ = ["LLMClient", "get_llm_client"]
