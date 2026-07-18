"""Fin-Node in-process vendor for TradingAgents data tools."""

from __future__ import annotations

import asyncio
import csv
import io
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd


def _bootstrap_repo_paths() -> None:
    this_file = Path(__file__).resolve()
    repo_root = this_file.parents[4]
    finance_root = repo_root / "finance_db_api"
    for candidate in (repo_root, finance_root):
        text = str(candidate)
        if text not in sys.path:
            sys.path.insert(0, text)


_bootstrap_repo_paths()

from finance_db.database import bootstrap_active_db  # noqa: E402
from finance_db.models.base import SessionLocal  # noqa: E402
from finance_db.services.news_pipeline import (  # noqa: E402
    build_tradingagents_global_feed,
    build_tradingagents_ticker_feed,
    format_tradingagents_global_feed,
    format_tradingagents_ticker_feed,
)
from finance_db.services.providers.sec_provider import SECProvider  # noqa: E402
from finance_db.services.providers.yfinance_provider import YFinanceProvider  # noqa: E402
from finance_db.api.agentic_routes.market_research.fundamental import get_fundamental_data  # noqa: E402
from finance_db.api.routes.v2_openbb_routes import (  # noqa: E402
    get_balance_sheet as openbb_get_balance_sheet,
    get_cash_flow as openbb_get_cash_flow,
    get_income_statement as openbb_get_income_statement,
    get_price_history as openbb_get_price_history,
)

try:  # noqa: E402
    import yfinance as yf
except Exception:  # pragma: no cover - environment dependent
    yf = None


INDICATOR_DESCRIPTIONS = {
    "close_50_sma": "50 SMA: A medium-term trend indicator. Usage: Identify trend direction and serve as dynamic support/resistance. Tips: It lags price; combine with faster indicators for timely signals.",
    "close_200_sma": "200 SMA: A long-term trend benchmark. Usage: Confirm overall market trend and identify golden/death cross setups. Tips: It reacts slowly; best for strategic trend confirmation rather than frequent trading entries.",
    "close_10_ema": "10 EMA: A responsive short-term average. Usage: Capture quick shifts in momentum and potential entry points. Tips: Prone to noise in choppy markets; use alongside longer averages for filtering false signals.",
    "macd": "MACD: Computes momentum via differences of EMAs. Usage: Look for crossovers and divergence as signals of trend changes. Tips: Confirm with other indicators in low-volatility or sideways markets.",
    "macds": "MACD Signal: An EMA smoothing of the MACD line. Usage: Use crossovers with the MACD line to trigger trades. Tips: Should be part of a broader strategy to avoid false positives.",
    "macdh": "MACD Histogram: Shows the gap between the MACD line and its signal. Usage: Visualize momentum strength and spot divergence early. Tips: Can be volatile; complement with additional filters in fast-moving markets.",
    "rsi": "RSI: Measures momentum to flag overbought/oversold conditions. Usage: Apply 70/30 thresholds and watch for divergence to signal reversals. Tips: In strong trends, RSI may remain extreme; always cross-check with trend analysis.",
    "boll": "Bollinger Middle: A 20 SMA serving as the basis for Bollinger Bands. Usage: Acts as a dynamic benchmark for price movement. Tips: Combine with the upper and lower bands to effectively spot breakouts or reversals.",
    "boll_ub": "Bollinger Upper Band: Typically 2 standard deviations above the middle line. Usage: Signals potential overbought conditions and breakout zones. Tips: Confirm signals with other tools; prices may ride the band in strong trends.",
    "boll_lb": "Bollinger Lower Band: Typically 2 standard deviations below the middle line. Usage: Indicates potential oversold conditions. Tips: Use additional analysis to avoid false reversal signals.",
    "atr": "ATR: Averages true range to measure volatility. Usage: Set stop-loss levels and adjust position sizes based on current market volatility. Tips: It's a reactive measure, so use it as part of a broader risk management strategy.",
    "vwma": "VWMA: A moving average weighted by volume. Usage: Confirm trends by integrating price action with volume data. Tips: Watch for skewed results from volume spikes; use in combination with other volume analyses.",
}

_RUNTIME_READY = False


def _run_async(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result: List[Any] = []
    error: List[BaseException] = []

    def _runner() -> None:
        try:
            result.append(asyncio.run(coro))
        except BaseException as exc:  # pragma: no cover - defensive
            error.append(exc)

    thread = threading.Thread(target=_runner, daemon=True)
    thread.start()
    thread.join()
    if error:
        raise error[0]
    return result[0] if result else None


def _ensure_runtime_ready() -> None:
    global _RUNTIME_READY
    if _RUNTIME_READY:
        return
    bootstrap_active_db()
    _RUNTIME_READY = True


def _openbb_available() -> bool:
    try:
        from openbb import obb  # noqa: F401
        return True
    except Exception:
        return False


def _bars_dataframe(symbol: str, period: str = "1y", interval: str = "1d") -> pd.DataFrame:
    provider = YFinanceProvider()
    try:
        bars = _run_async(provider.get_bars(symbol.upper(), interval=interval, period=period))
    except Exception:
        bars = []
    if not bars:
        return pd.DataFrame()
    df = pd.DataFrame(
        [
            {
                "date": item.timestamp,
                "open": item.open,
                "high": item.high,
                "low": item.low,
                "close": item.close,
                "volume": item.volume,
            }
            for item in bars
        ]
    )
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"], errors="coerce", utc=True).dt.tz_localize(None)
    df = df.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)
    return df


def _price_df(symbol: str, start_date: str, end_date: str) -> pd.DataFrame:
    period = _history_period_for_dates(start_date, end_date)
    df = _bars_dataframe(symbol, period=period, interval="1d")
    if df.empty and _openbb_available():
        try:
            payload = _run_async(openbb_get_price_history(symbol.upper(), interval="1d", period=period))
            prices = list((payload or {}).get("prices") or [])
            if prices:
                df = pd.DataFrame(prices)
                df["date"] = pd.to_datetime(df["date"], errors="coerce", utc=True).dt.tz_localize(None)
                df = df.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)
        except Exception:
            pass
    if df.empty:
        return df
    mask = (df["date"] >= pd.Timestamp(start_date)) & (df["date"] <= pd.Timestamp(end_date))
    return df.loc[mask].copy()


def _history_period_for_dates(start_date: str, end_date: str) -> str:
    start = pd.Timestamp(start_date)
    end = pd.Timestamp(end_date)
    days = max(5, int((end - start).days) + 5)
    if days <= 5:
        return "5d"
    if days <= 31:
        return "1mo"
    if days <= 93:
        return "3mo"
    if days <= 186:
        return "6mo"
    if days <= 366:
        return "1y"
    if days <= 730:
        return "2y"
    return "5y"


def get_news(ticker: str, start_date: str, end_date: str) -> str:
    _ensure_runtime_ready()
    with SessionLocal() as db:
        items = build_tradingagents_ticker_feed(db, ticker=ticker, start_date=start_date, end_date=end_date, limit=10)
    return format_tradingagents_ticker_feed(ticker=ticker, start_date=start_date, end_date=end_date, items=items)


def get_global_news(curr_date: str, look_back_days: int = 7, limit: int = 10) -> str:
    _ensure_runtime_ready()
    with SessionLocal() as db:
        items = build_tradingagents_global_feed(db, curr_date=curr_date, look_back_days=look_back_days, limit=limit)
    return format_tradingagents_global_feed(curr_date=curr_date, look_back_days=look_back_days, items=items)


def get_stock_data(symbol: str, start_date: str, end_date: str) -> str:
    df = _price_df(symbol, start_date, end_date)
    if df.empty:
        return f"No data found for symbol '{symbol}' between {start_date} and {end_date}"
    csv_buf = io.StringIO()
    writer = csv.writer(csv_buf)
    writer.writerow(["Date", "Open", "High", "Low", "Close", "Volume"])
    for _, row in df.iterrows():
        writer.writerow([
            row["date"].strftime("%Y-%m-%d"),
            round(float(row.get("open", 0.0)), 2),
            round(float(row.get("high", 0.0)), 2),
            round(float(row.get("low", 0.0)), 2),
            round(float(row.get("close", 0.0)), 2),
            int(row.get("volume", 0) or 0),
        ])
    header = f"# Stock data for {symbol.upper()} from {start_date} to {end_date}\n"
    header += f"# Total records: {len(df)}\n"
    header += f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    return header + csv_buf.getvalue()


def get_indicators(symbol: str, indicator: str, curr_date: str, look_back_days: int) -> str:
    start_date = (datetime.strptime(curr_date, "%Y-%m-%d") - pd.Timedelta(days=max(look_back_days, 250))).strftime("%Y-%m-%d")
    df = _price_df(symbol, start_date, curr_date)
    if df.empty:
        return f"No indicator data found for {symbol}"

    close = pd.Series(df["close"], dtype="float64")
    high = pd.Series(df["high"], dtype="float64")
    low = pd.Series(df["low"], dtype="float64")
    volume = pd.Series(df["volume"], dtype="float64")

    if indicator == "close_50_sma":
        values = close.rolling(50).mean()
    elif indicator == "close_200_sma":
        values = close.rolling(200).mean()
    elif indicator == "close_10_ema":
        values = close.ewm(span=10, adjust=False).mean()
    elif indicator in {"macd", "macds", "macdh"}:
        ema_fast = close.ewm(span=12, adjust=False).mean()
        ema_slow = close.ewm(span=26, adjust=False).mean()
        macd_series = ema_fast - ema_slow
        signal_series = macd_series.ewm(span=9, adjust=False).mean()
        hist_series = macd_series - signal_series
        values = {"macd": macd_series, "macds": signal_series, "macdh": hist_series}[indicator]
    elif indicator == "rsi":
        delta = close.diff()
        gain = delta.where(delta > 0, 0.0).rolling(window=14).mean()
        loss = (-delta.where(delta < 0, 0.0)).rolling(window=14).mean()
        rs = gain / loss
        values = 100 - (100 / (1 + rs))
    elif indicator in {"boll", "boll_ub", "boll_lb"}:
        mid = close.rolling(20).mean()
        std = close.rolling(20).std()
        if indicator == "boll":
            values = mid
        elif indicator == "boll_ub":
            values = mid + (2 * std)
        else:
            values = mid - (2 * std)
    elif indicator == "atr":
        prev_close = close.shift(1)
        tr1 = high - low
        tr2 = (high - prev_close).abs()
        tr3 = (low - prev_close).abs()
        values = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1).rolling(window=14).mean()
    elif indicator == "vwma":
        values = (close * volume).rolling(20).sum() / volume.rolling(20).sum()
    else:
        raise ValueError(f"Indicator {indicator} is not supported.")

    before = datetime.strptime(curr_date, "%Y-%m-%d") - pd.Timedelta(days=look_back_days)
    lines: List[str] = []
    for _, row in df.iterrows():
        if row["date"] < pd.Timestamp(before):
            continue
        value = values.iloc[int(row.name)] if int(row.name) < len(values) else None
        rendered = "N/A" if pd.isna(value) else str(round(float(value), 6))
        lines.append(f"{row['date'].strftime('%Y-%m-%d')}: {rendered}")

    description = INDICATOR_DESCRIPTIONS.get(indicator, "No description available.")
    body = "\n".join(lines) if lines else "No indicator values available"
    return f"## {indicator} values from {before.strftime('%Y-%m-%d')} to {curr_date}:\n\n{body}\n\n{description}"


def get_fundamentals(ticker: str, curr_date: str | None = None) -> str:
    data = _run_async(get_fundamental_data(ticker.upper()))
    payload = data.model_dump() if hasattr(data, "model_dump") else dict(data or {})
    header = f"# Company Fundamentals for {ticker.upper()}\n"
    header += f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    lines = [f"{key.replace('_', ' ').title()}: {value}" for key, value in payload.items() if value not in (None, "", [], {})]
    return header + "\n".join(lines)


def _statement_to_csv(title: str, ticker: str, period: str, rows: List[Dict[str, Any]]) -> str:
    if not rows:
        return f"No {title.lower()} data found for symbol '{ticker}'"
    df = pd.DataFrame(rows)
    header = f"# {title} data for {ticker.upper()} ({period})\n"
    header += f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    return header + df.to_csv(index=False)


def _records_from_dataframe(df: Optional[pd.DataFrame]) -> List[Dict[str, Any]]:
    if df is None or df.empty:
        return []
    normalized = df.transpose().reset_index().rename(columns={"index": "date"})
    normalized["date"] = normalized["date"].astype(str)
    return normalized.to_dict(orient="records")


def _yfinance_statement_rows(ticker: str, statement_kind: str, period: str) -> List[Dict[str, Any]]:
    if yf is None:
        return []
    stock = yf.Ticker(ticker.upper())
    lookup = {
        ("balance", "quarter"): getattr(stock, "quarterly_balance_sheet", None),
        ("balance", "annual"): getattr(stock, "balance_sheet", None),
        ("cash", "quarter"): getattr(stock, "quarterly_cashflow", None),
        ("cash", "annual"): getattr(stock, "cashflow", None),
        ("income", "quarter"): getattr(stock, "quarterly_income_stmt", None),
        ("income", "annual"): getattr(stock, "income_stmt", None),
    }
    return _records_from_dataframe(lookup.get((statement_kind, period)))


def _openbb_statement_rows(fetcher, ticker: str, period: str) -> List[Dict[str, Any]]:
    if not _openbb_available():
        return []
    payload = _run_async(fetcher(ticker.upper(), period=period, limit=5))
    return list((payload or {}).get("statements") or [])


def get_balance_sheet(ticker: str, freq: str = "quarterly", curr_date: str | None = None) -> str:
    period = "quarter" if str(freq).lower().startswith("q") else "annual"
    rows = _yfinance_statement_rows(ticker, "balance", period) or _openbb_statement_rows(openbb_get_balance_sheet, ticker, period)
    return _statement_to_csv("Balance Sheet", ticker, period, rows)


def get_cashflow(ticker: str, freq: str = "quarterly", curr_date: str | None = None) -> str:
    period = "quarter" if str(freq).lower().startswith("q") else "annual"
    rows = _yfinance_statement_rows(ticker, "cash", period) or _openbb_statement_rows(openbb_get_cash_flow, ticker, period)
    return _statement_to_csv("Cash Flow", ticker, period, rows)


def get_income_statement(ticker: str, freq: str = "quarterly", curr_date: str | None = None) -> str:
    period = "quarter" if str(freq).lower().startswith("q") else "annual"
    rows = _yfinance_statement_rows(ticker, "income", period) or _openbb_statement_rows(openbb_get_income_statement, ticker, period)
    return _statement_to_csv("Income Statement", ticker, period, rows)


def get_insider_transactions(ticker: str) -> str:
    provider = SECProvider()
    try:
        trades = _run_async(provider.get_insider_trades(ticker.upper()))
    except Exception:
        trades = []
    rows = [trade.to_dict() if hasattr(trade, "to_dict") else dict(trade) for trade in (trades or [])]
    if not rows and yf is not None:
        try:
            holders = yf.Ticker(ticker.upper()).insider_transactions
            if holders is not None and not holders.empty:
                rows = holders.reset_index().to_dict(orient="records")
        except Exception:
            rows = []
    if not rows:
        return f"No insider transactions data found for symbol '{ticker}'"
    header = f"# Insider Transactions data for {ticker.upper()}\n"
    header += f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    return header + pd.DataFrame(rows).to_csv(index=False)
