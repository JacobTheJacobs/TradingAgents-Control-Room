from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

from dotenv import load_dotenv
from pathlib import Path
import os

# Load environment variables only from this project directory.
# Avoid parent-directory dotenv discovery that can inject placeholder keys.
_ROOT = Path(__file__).resolve().parent
load_dotenv(_ROOT / ".env")
# Fallback to repo-level env files used by the host app integration.
load_dotenv(_ROOT.parent / ".env", override=False)
load_dotenv(_ROOT.parent.parent / ".env", override=False)


def _is_set_and_real(name: str) -> bool:
    val = (os.getenv(name, "") or "").strip()
    if not val:
        return False
    low = val.lower()
    return not any(x in low for x in ("your-", "example", "change-me", "changeme", "here"))

# Create a custom config
config = DEFAULT_CONFIG.copy()
config["max_debate_rounds"] = 1  # Increase debate rounds

# Configure data vendors — fin_node_api ONLY (fin-node.net CDN, no fallback).
config["data_vendors"] = {
    "core_stock_apis": "fin_node_api",
    "technical_indicators": "fin_node_api",
    "fundamental_data": "fin_node_api",
    "news_data": "fin_node_api",
}

# Auto-select provider/model from available real credentials.
preferred_provider = str(os.getenv("TRADINGAGENTS_LLM_PROVIDER") or "").strip().lower()
if preferred_provider == "nvidia" and _is_set_and_real("NVIDIA_API_KEY"):
    config["llm_provider"] = "nvidia"
    config["deep_think_llm"] = "meta/llama-3.1-70b-instruct"
    config["quick_think_llm"] = "meta/llama-3.1-70b-instruct"
elif preferred_provider == "openai" and _is_set_and_real("OPENAI_API_KEY"):
    config["llm_provider"] = "openai"
    config["deep_think_llm"] = "gpt-5.4-mini"
    config["quick_think_llm"] = "gpt-5.4-mini"
elif preferred_provider == "qwen" and _is_set_and_real("DASHSCOPE_API_KEY"):
    config["llm_provider"] = "qwen"
    config["deep_think_llm"] = "qwen3-next-80b-a3b-instruct"
    config["quick_think_llm"] = "qwen3-next-80b-a3b-instruct"
elif preferred_provider == "deepseek" and _is_set_and_real("DEEPSEEK_API_KEY"):
    config["llm_provider"] = "deepseek"
    config["deep_think_llm"] = "deepseek-chat"
    config["quick_think_llm"] = "deepseek-chat"
elif _is_set_and_real("NVIDIA_API_KEY"):
    config["llm_provider"] = "nvidia"
    config["deep_think_llm"] = "meta/llama-3.1-70b-instruct"
    config["quick_think_llm"] = "meta/llama-3.1-70b-instruct"
elif _is_set_and_real("OPENAI_API_KEY"):
    config["llm_provider"] = "openai"
    config["deep_think_llm"] = "gpt-5.4-mini"
    config["quick_think_llm"] = "gpt-5.4-mini"
elif _is_set_and_real("DASHSCOPE_API_KEY"):
    config["llm_provider"] = "qwen"
    config["deep_think_llm"] = "qwen3-next-80b-a3b-instruct"
    config["quick_think_llm"] = "qwen3-next-80b-a3b-instruct"
elif _is_set_and_real("DEEPSEEK_API_KEY"):
    config["llm_provider"] = "deepseek"
    config["deep_think_llm"] = "deepseek-chat"
    config["quick_think_llm"] = "deepseek-chat"
else:
    raise RuntimeError(
        "No valid LLM API key found. Set one of OPENAI_API_KEY, NVIDIA_API_KEY, "
        "DASHSCOPE_API_KEY, or DEEPSEEK_API_KEY in src/TradingAgents-original/.env "
        "or repo .env."
    )

# Initialize with custom config
ta = TradingAgentsGraph(debug=True, config=config)

# forward propagate
_, decision = ta.propagate("NVDA", "2024-05-10")
print(decision)

# Memorize mistakes and reflect
# ta.reflect_and_remember(1000) # parameter is the position returns
