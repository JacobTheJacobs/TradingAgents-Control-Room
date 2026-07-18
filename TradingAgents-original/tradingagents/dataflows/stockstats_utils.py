import time
import logging
import random
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

import pandas as pd
import yfinance as yf
from yfinance.exceptions import YFRateLimitError
from stockstats import wrap
from typing import Annotated
import os
from .config import get_config
from .utils import safe_ticker_component

logger = logging.getLogger(__name__)


def build_yf_session():
    """Build a yfinance-compatible session with optional insecure SSL."""
    insecure = str(os.getenv("TA_INSECURE_SSL", "")).strip().lower() in {"1", "true", "yes", "on"}
    if not insecure:
        return None
    try:
        from curl_cffi import requests as curl_requests  # type: ignore

        return curl_requests.Session(verify=False)
    except Exception:
        return None


def _is_transient_yf_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    markers = [
        "too many requests",
        "rate limit",
        "timed out",
        "timeout",
        "temporarily unavailable",
        "connection reset",
        "ssl",
    ]
    return any(m in msg for m in markers)


def _per_call_timeout_seconds() -> float:
    raw = str(os.getenv("TA_YF_CALL_TIMEOUT_SECONDS", "35")).strip()
    try:
        return max(5.0, float(raw))
    except Exception:
        return 35.0


def _yf_max_retries(default_value: int = 6) -> int:
    raw = str(os.getenv("TA_YF_MAX_RETRIES", str(default_value))).strip()
    try:
        return max(0, int(float(raw)))
    except Exception:
        return default_value


def _yf_base_delay_seconds(default_value: float = 2.0) -> float:
    raw = str(os.getenv("TA_YF_BASE_DELAY_SECONDS", str(default_value))).strip()
    try:
        return max(0.25, float(raw))
    except Exception:
        return default_value


def _run_with_timeout(func, timeout_seconds: float):
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(func)
        try:
            return future.result(timeout=timeout_seconds)
        except FuturesTimeoutError as exc:
            future.cancel()
            raise TimeoutError(f"yfinance call timed out after {timeout_seconds:.0f}s") from exc


def yf_retry(func, max_retries=6, base_delay=2.0):
    """Execute a yfinance call with exponential backoff on rate limits.

    yfinance raises YFRateLimitError on HTTP 429 responses but does not
    retry them internally. This wrapper adds retry logic specifically
    for rate limits. Other exceptions propagate immediately.
    """
    max_retries = _yf_max_retries(max_retries)
    base_delay = _yf_base_delay_seconds(base_delay)
    for attempt in range(max_retries + 1):
        try:
            return _run_with_timeout(func, _per_call_timeout_seconds())
        except YFRateLimitError:
            if attempt < max_retries:
                delay = base_delay * (2 ** attempt) + random.uniform(0, 1.0)
                logger.warning(f"Yahoo Finance rate limited, retrying in {delay:.0f}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(delay)
            else:
                raise
        except Exception as e:
            if attempt < max_retries and _is_transient_yf_error(e):
                delay = base_delay * (2 ** attempt) + random.uniform(0, 1.0)
                logger.warning(
                    "Transient yfinance error, retrying in %.0fs (attempt %d/%d): %s",
                    delay, attempt + 1, max_retries, e,
                )
                time.sleep(delay)
            else:
                raise


def _clean_dataframe(data: pd.DataFrame) -> pd.DataFrame:
    """Normalize a stock DataFrame for stockstats: parse dates, drop invalid rows, fill price gaps."""
    data["Date"] = pd.to_datetime(data["Date"], errors="coerce")
    data = data.dropna(subset=["Date"])

    price_cols = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in data.columns]
    data[price_cols] = data[price_cols].apply(pd.to_numeric, errors="coerce")
    data = data.dropna(subset=["Close"])
    data[price_cols] = data[price_cols].ffill().bfill()

    return data


def load_ohlcv(symbol: str, curr_date: str) -> pd.DataFrame:
    """Fetch OHLCV data with caching, filtered to prevent look-ahead bias.

    Downloads 15 years of data up to today and caches per symbol. On
    subsequent calls the cache is reused. Rows after curr_date are
    filtered out so backtests never see future prices.
    """
    # Reject ticker values that would escape the cache directory when
    # interpolated into the cache filename (e.g. ``../../tmp/x``).
    safe_symbol = safe_ticker_component(symbol)

    config = get_config()
    curr_date_dt = pd.to_datetime(curr_date)

    # Cache uses a fixed window (15y to today) so one file per symbol
    today_date = pd.Timestamp.today()
    start_date = today_date - pd.DateOffset(years=5)
    start_str = start_date.strftime("%Y-%m-%d")
    end_str = today_date.strftime("%Y-%m-%d")

    os.makedirs(config["data_cache_dir"], exist_ok=True)
    data_file = os.path.join(
        config["data_cache_dir"],
        f"{safe_symbol}-YFin-data-{start_str}-{end_str}.csv",
    )

    if os.path.exists(data_file):
        data = pd.read_csv(data_file, on_bad_lines="skip", encoding="utf-8")
    else:
        session = build_yf_session()
        try:
            data = yf_retry(lambda: yf.download(
                symbol,
                start=start_str,
                end=end_str,
                multi_level_index=False,
                progress=False,
                auto_adjust=True,
                session=session,
            ))
            data = data.reset_index()
            data.to_csv(data_file, index=False, encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to download OHLCV for %s: %s", symbol, e)
            return pd.DataFrame(columns=["Date", "Open", "High", "Low", "Close", "Volume"])

    data = _clean_dataframe(data)

    # Filter to curr_date to prevent look-ahead bias in backtesting
    data = data[data["Date"] <= curr_date_dt]

    return data


def filter_financials_by_date(data: pd.DataFrame, curr_date: str) -> pd.DataFrame:
    """Drop financial statement columns (fiscal period timestamps) after curr_date.

    yfinance financial statements use fiscal period end dates as columns.
    Columns after curr_date represent future data and are removed to
    prevent look-ahead bias.
    """
    if not curr_date or data.empty:
        return data
    cutoff = pd.Timestamp(curr_date)
    mask = pd.to_datetime(data.columns, errors="coerce") <= cutoff
    return data.loc[:, mask]


class StockstatsUtils:
    @staticmethod
    def get_stock_stats(
        symbol: Annotated[str, "ticker symbol for the company"],
        indicator: Annotated[
            str, "quantitative indicators based off of the stock data for the company"
        ],
        curr_date: Annotated[
            str, "curr date for retrieving stock price data, YYYY-mm-dd"
        ],
    ):
        data = load_ohlcv(symbol, curr_date)
        if data.empty or "Date" not in data.columns:
            return "N/A: data unavailable"
        df = wrap(data)
        df["Date"] = df["Date"].dt.strftime("%Y-%m-%d")
        curr_date_str = pd.to_datetime(curr_date).strftime("%Y-%m-%d")

        df[indicator]  # trigger stockstats to calculate the indicator
        matching_rows = df[df["Date"].str.startswith(curr_date_str)]

        if not matching_rows.empty:
            indicator_value = matching_rows[indicator].values[0]
            return indicator_value
        else:
            return "N/A: Not a trading day (weekend or holiday)"
