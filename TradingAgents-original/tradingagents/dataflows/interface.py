from typing import Annotated

# Import from vendor-specific modules
from .y_finance import (
    get_YFin_data_online,
    get_stock_stats_indicators_window,
    get_fundamentals as get_yfinance_fundamentals,
    get_balance_sheet as get_yfinance_balance_sheet,
    get_cashflow as get_yfinance_cashflow,
    get_income_statement as get_yfinance_income_statement,
    get_insider_transactions as get_yfinance_insider_transactions,
)
from .yfinance_news import get_news_yfinance, get_global_news_yfinance
# fin_node is the IN-PROCESS vendor (it imports finance_db). That import can die at load time
# — e.g. a removed finance_db symbol — and used to take this whole module, and every real run,
# down with it. Guard it: if it fails, its tools become None and route_to_vendor skips past them
# to the next vendor. Nothing else in the process should ever fail because one vendor's deps moved.
try:
    from .fin_node import (
        get_news as get_fin_node_news,
        get_global_news as get_fin_node_global_news,
        get_stock_data as get_fin_node_stock_data,
        get_indicators as get_fin_node_indicators,
        get_fundamentals as get_fin_node_fundamentals,
        get_balance_sheet as get_fin_node_balance_sheet,
        get_cashflow as get_fin_node_cashflow,
        get_income_statement as get_fin_node_income_statement,
        get_insider_transactions as get_fin_node_insider_transactions,
    )
except Exception as _fin_node_err:  # pragma: no cover - import-time, environment dependent
    import logging as _logging
    _logging.getLogger(__name__).warning("in-process fin_node vendor unavailable: %s", _fin_node_err)
    get_fin_node_news = get_fin_node_global_news = get_fin_node_stock_data = None
    get_fin_node_indicators = get_fin_node_fundamentals = get_fin_node_balance_sheet = None
    get_fin_node_cashflow = get_fin_node_income_statement = get_fin_node_insider_transactions = None

# fin_node_api is the HTTP vendor: the SAME tools sourced from the fin-node.net static JSON API,
# with NO finance_db import — so real runs work even when the in-process vendor's import is broken.
try:
    from .fin_node_api import (
        get_news as get_fin_node_api_news,
        get_global_news as get_fin_node_api_global_news,
        get_stock_data as get_fin_node_api_stock_data,
        get_indicators as get_fin_node_api_indicators,
        get_fundamentals as get_fin_node_api_fundamentals,
        get_balance_sheet as get_fin_node_api_balance_sheet,
        get_cashflow as get_fin_node_api_cashflow,
        get_income_statement as get_fin_node_api_income_statement,
        get_insider_transactions as get_fin_node_api_insider_transactions,
    )
except Exception as _fin_node_api_err:  # pragma: no cover
    import logging as _logging
    _logging.getLogger(__name__).warning("fin_node_api vendor unavailable: %s", _fin_node_api_err)
    get_fin_node_api_news = get_fin_node_api_global_news = get_fin_node_api_stock_data = None
    get_fin_node_api_indicators = get_fin_node_api_fundamentals = get_fin_node_api_balance_sheet = None
    get_fin_node_api_cashflow = get_fin_node_api_income_statement = get_fin_node_api_insider_transactions = None
from .alpha_vantage import (
    get_stock as get_alpha_vantage_stock,
    get_indicator as get_alpha_vantage_indicator,
    get_fundamentals as get_alpha_vantage_fundamentals,
    get_balance_sheet as get_alpha_vantage_balance_sheet,
    get_cashflow as get_alpha_vantage_cashflow,
    get_income_statement as get_alpha_vantage_income_statement,
    get_insider_transactions as get_alpha_vantage_insider_transactions,
    get_news as get_alpha_vantage_news,
    get_global_news as get_alpha_vantage_global_news,
)
from .alpha_vantage_common import AlphaVantageRateLimitError

# Configuration and routing logic
from .config import get_config

# Tools organized by category
TOOLS_CATEGORIES = {
    "core_stock_apis": {
        "description": "OHLCV stock price data",
        "tools": [
            "get_stock_data"
        ]
    },
    "technical_indicators": {
        "description": "Technical analysis indicators",
        "tools": [
            "get_indicators"
        ]
    },
    "fundamental_data": {
        "description": "Company fundamentals",
        "tools": [
            "get_fundamentals",
            "get_balance_sheet",
            "get_cashflow",
            "get_income_statement"
        ]
    },
    "news_data": {
        "description": "News and insider data",
        "tools": [
            "get_news",
            "get_global_news",
            "get_insider_transactions",
        ]
    }
}

VENDOR_LIST = [
    "fin_node_api",
    "fin_node",
    "yfinance",
    "alpha_vantage",
]

# Mapping of methods to their vendor-specific implementations
VENDOR_METHODS = {
    # core_stock_apis
    "get_stock_data": {
        "fin_node_api": get_fin_node_api_stock_data,
        "fin_node": get_fin_node_stock_data,
        "alpha_vantage": get_alpha_vantage_stock,
        "yfinance": get_YFin_data_online,
    },
    # technical_indicators
    "get_indicators": {
        "fin_node_api": get_fin_node_api_indicators,
        "fin_node": get_fin_node_indicators,
        "alpha_vantage": get_alpha_vantage_indicator,
        "yfinance": get_stock_stats_indicators_window,
    },
    # fundamental_data
    "get_fundamentals": {
        "fin_node_api": get_fin_node_api_fundamentals,
        "fin_node": get_fin_node_fundamentals,
        "alpha_vantage": get_alpha_vantage_fundamentals,
        "yfinance": get_yfinance_fundamentals,
    },
    "get_balance_sheet": {
        "fin_node_api": get_fin_node_api_balance_sheet,
        "fin_node": get_fin_node_balance_sheet,
        "alpha_vantage": get_alpha_vantage_balance_sheet,
        "yfinance": get_yfinance_balance_sheet,
    },
    "get_cashflow": {
        "fin_node_api": get_fin_node_api_cashflow,
        "fin_node": get_fin_node_cashflow,
        "alpha_vantage": get_alpha_vantage_cashflow,
        "yfinance": get_yfinance_cashflow,
    },
    "get_income_statement": {
        "fin_node_api": get_fin_node_api_income_statement,
        "fin_node": get_fin_node_income_statement,
        "alpha_vantage": get_alpha_vantage_income_statement,
        "yfinance": get_yfinance_income_statement,
    },
    # news_data
    "get_news": {
        "fin_node_api": get_fin_node_api_news,
        "fin_node": get_fin_node_news,
        "alpha_vantage": get_alpha_vantage_news,
        "yfinance": get_news_yfinance,
    },
    "get_global_news": {
        "fin_node_api": get_fin_node_api_global_news,
        "fin_node": get_fin_node_global_news,
        "yfinance": get_global_news_yfinance,
        "alpha_vantage": get_alpha_vantage_global_news,
    },
    "get_insider_transactions": {
        "fin_node_api": get_fin_node_api_insider_transactions,
        "fin_node": get_fin_node_insider_transactions,
        "alpha_vantage": get_alpha_vantage_insider_transactions,
        "yfinance": get_yfinance_insider_transactions,
    },
}

def get_category_for_method(method: str) -> str:
    """Get the category that contains the specified method."""
    for category, info in TOOLS_CATEGORIES.items():
        if method in info["tools"]:
            return category
    raise ValueError(f"Method '{method}' not found in any category")

def get_vendor(category: str, method: str = None) -> str:
    """Get the configured vendor for a data category or specific tool method.
    Tool-level configuration takes precedence over category-level.
    """
    config = get_config()

    # Check tool-level configuration first (if method provided)
    if method:
        tool_vendors = config.get("tool_vendors", {})
        if method in tool_vendors:
            return tool_vendors[method]

    # Fall back to category-level configuration
    return config.get("data_vendors", {}).get(category, "default")

def route_to_vendor(method: str, *args, **kwargs):
    """Route method calls to appropriate vendor implementation with fallback support."""
    category = get_category_for_method(method)
    vendor_config = get_vendor(category, method)
    primary_vendors = [v.strip() for v in str(vendor_config or "").split(",") if v.strip()]

    if method not in VENDOR_METHODS:
        raise ValueError(f"Method '{method}' not supported")
    if not primary_vendors:
        raise RuntimeError(f"No configured vendor for '{method}'")

    fallback_vendors = [vendor for vendor in primary_vendors if vendor in VENDOR_METHODS[method]]
    if not fallback_vendors:
        raise RuntimeError(f"No configured vendor implementation for '{method}'")

    last_error = None
    for index, vendor in enumerate(fallback_vendors):
        vendor_impl = VENDOR_METHODS[method][vendor]
        impl_func = vendor_impl[0] if isinstance(vendor_impl, list) else vendor_impl

        # A vendor whose module failed to import is registered as None — skip to the next one.
        if impl_func is None:
            last_error = RuntimeError(f"vendor '{vendor}' has no implementation for '{method}' (import failed)")
            if index < len(fallback_vendors) - 1:
                continue
            raise last_error

        try:
            return impl_func(*args, **kwargs)
        except AlphaVantageRateLimitError as exc:
            last_error = exc
            if index < len(fallback_vendors) - 1:
                continue
            raise
        except Exception as exc:
            last_error = exc
            if index < len(fallback_vendors) - 1:
                continue
            raise

    raise RuntimeError(f"No available vendor for '{method}'") from last_error
