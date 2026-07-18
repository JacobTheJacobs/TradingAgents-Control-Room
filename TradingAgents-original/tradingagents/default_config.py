import os

_TRADINGAGENTS_HOME = os.path.join(os.path.expanduser("~"), ".tradingagents")


def _is_set_and_real(name: str) -> bool:
    val = (os.getenv(name, "") or "").strip()
    if not val:
        return False
    low = val.lower()
    return not any(x in low for x in ("your-", "example", "change-me", "changeme", "here", "placeholder"))


def _default_llm_provider() -> str:
    explicit = str(os.getenv("TRADINGAGENTS_LLM_PROVIDER") or "").strip().lower()
    if explicit:
        return explicit
    if _is_set_and_real("NVIDIA_API_KEY"):
        return "nvidia"
    return "openai"

DEFAULT_CONFIG = {
    "project_dir": os.path.abspath(os.path.join(os.path.dirname(__file__), ".")),
    "results_dir": os.getenv("TRADINGAGENTS_RESULTS_DIR", os.path.join(_TRADINGAGENTS_HOME, "logs")),
    "data_cache_dir": os.getenv("TRADINGAGENTS_CACHE_DIR", os.path.join(_TRADINGAGENTS_HOME, "cache")),
    "memory_log_path": os.getenv("TRADINGAGENTS_MEMORY_LOG_PATH", os.path.join(_TRADINGAGENTS_HOME, "memory", "trading_memory.md")),
    # Optional cap on the number of resolved memory log entries. When set,
    # the oldest resolved entries are pruned once this limit is exceeded.
    # Pending entries are never pruned. None disables rotation entirely.
    "memory_log_max_entries": None,
    # Disable memory/reflection side effects when strict parity requires
    # a sterile, single-run execution baseline.
    "memory_enabled": str(os.getenv("TRADINGAGENTS_MEMORY_ENABLED", "1")).strip().lower() in {"1", "true", "yes", "on"},
    # LLM settings
    "llm_provider": _default_llm_provider(),
    "deep_think_llm": "gpt-5.4",
    "quick_think_llm": "gpt-5.4-mini",
    # When None, each provider's client falls back to its own default endpoint
    # (api.openai.com for OpenAI, generativelanguage.googleapis.com for Gemini, ...).
    # The CLI overrides this per provider when the user picks one. Keeping a
    # provider-specific URL here would leak (e.g. OpenAI's /v1 was previously
    # being forwarded to Gemini, producing malformed request URLs).
    "backend_url": None,
    # Provider-specific thinking configuration
    "google_thinking_level": None,      # "high", "minimal", etc.
    "openai_reasoning_effort": None,    # "medium", "high", "low"
    "anthropic_effort": None,           # "high", "medium", "low"
    # Checkpoint/resume: when True, LangGraph saves state after each node
    # so a crashed run can resume from the last successful step.
    "checkpoint_enabled": False,
    # Output language for analyst reports and final decision
    # Internal agent debate stays in English for reasoning quality
    "output_language": "English",
    # Debate and discussion settings
    "max_debate_rounds": 1,
    "max_risk_discuss_rounds": 1,
    "max_recur_limit": 100,
    # Data vendor configuration
    # Category-level configuration (default for all tools in category).
    # fin_node_api ONLY — every data tool is served by the fin-node.net static CDN
    # JSON API and nothing else (no in-process fin_node, no yfinance, no alpha_vantage).
    # With no fallback, calls outside the CDN's coverage (uncovered ticker or a date
    # outside the daily snapshot window) raise rather than falling back.
    "data_vendors": {
        "core_stock_apis": "fin_node_api",
        "technical_indicators": "fin_node_api",
        "fundamental_data": "fin_node_api",
        "news_data": "fin_node_api",
    },
    # Tool-level configuration (takes precedence over category-level)
    "tool_vendors": {
        # Example: "get_stock_data": "alpha_vantage",  # Override category default
    },
}
