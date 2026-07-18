"""Fin-Node HTTP vendor for TradingAgents data tools.

Reads the static JSON API published at https://www.fin-node.net/api/<TICKER>.json (rebuilt
once a day from yfinance / SEC / Stooq / FRED) and reconstructs the EXACT same nine tool
string outputs as the in-process ``fin_node`` vendor — but with ZERO ``finance_db`` imports,
no sibling repo, no DB, and no API keys.

Why this exists: the in-process ``fin_node`` vendor imports ``finance_db`` at module load,
which now dies (``build_tradingagents_ticker_feed`` was removed) and takes ``interface.py``
down with it. This vendor has no such coupling — it only needs the CDN to be reachable, so it
works identically in Docker, in the public repo, and on any machine. On any fetch error it
raises, so ``route_to_vendor`` falls through to yfinance / alpha_vantage.

Data is a DAILY SNAPSHOT (end-of-day), not real-time. The bundle carries a ~96-day price
window and per-indicator series, so the price/indicator date-slicing the agents do still works
for recent ``curr_date`` values.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import urllib.request
from datetime import datetime, timedelta
from typing import Any, Dict, List

import pandas as pd

API_BASE = os.environ.get("FIN_NODE_API_BASE", "https://www.fin-node.net/api").rstrip("/")
_TIMEOUT = float(os.environ.get("FIN_NODE_API_TIMEOUT", "12"))
_CACHE: Dict[str, Any] = {}   # per-process cache: fetch each bundle at most once

# Same descriptions the in-process vendor appends, so downstream text is identical.
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


def _fetch(path: str) -> Any:
    if path in _CACHE:
        return _CACHE[path]
    url = f"{API_BASE}/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "tradingagents-fin_node_api/1.0"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:   # raises on network/HTTP error
        data = json.loads(resp.read().decode("utf-8"))
    _CACHE[path] = data
    return data


_TICKER_RE = re.compile(r"[A-Za-z][A-Za-z0-9.\-]{0,7}$")


def _bundle(symbol: str) -> Dict[str, Any]:
    sym = (symbol or "").strip()
    if not _TICKER_RE.match(sym):   # only ticker-shaped input reaches the URL; else fail -> fallback
        raise ValueError(f"invalid ticker symbol: {symbol!r}")
    return _fetch(f"{sym.upper()}.json")


def _retrieved() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _news_line(item: Dict[str, Any]) -> str:
    tks = ", ".join(item.get("tickers") or [])
    tag = f" [{tks}]" if tks else ""
    return f"### {item.get('date') or '?'}{tag} — {item.get('headline') or 'Untitled'} (Fin-node)\n{item.get('url') or ''}"


# --------------------------------------------------------------------------- #
# Prices
# --------------------------------------------------------------------------- #
def get_stock_data(symbol: str, start_date: str, end_date: str) -> str:
    rows = _bundle(symbol).get("prices") or []
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Date", "Open", "High", "Low", "Close", "Volume"])
    n = 0
    for r in rows:
        d = str(r.get("Date"))
        if start_date <= d <= end_date:
            writer.writerow([d, r.get("Open"), r.get("High"), r.get("Low"),
                             r.get("Close"), int(r.get("Volume") or 0)])
            n += 1
    if n == 0:
        # Raise (don't return a no-data string) so route_to_vendor falls through
        # to yfinance — e.g. a historical window outside the daily snapshot.
        raise LookupError(
            f"fin_node_api: no prices for '{symbol}' in {start_date}..{end_date} "
            "(outside the daily snapshot window)"
        )
    header = (f"# Stock data for {symbol.upper()} from {start_date} to {end_date}\n"
              f"# Total records: {n}\n"
              f"# Data retrieved on: {_retrieved()}\n\n")
    return header + buf.getvalue()


# --------------------------------------------------------------------------- #
# Technical indicators
# --------------------------------------------------------------------------- #
def get_indicators(symbol: str, indicator: str, curr_date: str, look_back_days: int) -> str:
    if indicator not in INDICATOR_DESCRIPTIONS:
        raise ValueError(f"Indicator {indicator} is not supported.")
    pairs = (_bundle(symbol).get("indicators") or {}).get(indicator) or []
    before = (datetime.strptime(curr_date, "%Y-%m-%d") - timedelta(days=look_back_days)).strftime("%Y-%m-%d")
    lines: List[str] = []
    for p in pairs:
        d = p.get("date")
        if d and before <= d <= curr_date:
            v = p.get("value")
            lines.append(f"{d}: {'N/A' if v is None else round(float(v), 6)}")
    if not lines:
        # Raise so route_to_vendor falls through to yfinance for windows outside
        # the daily snapshot, rather than serving an empty indicator series.
        raise LookupError(
            f"fin_node_api: no '{indicator}' values for '{symbol}' in "
            f"{before}..{curr_date} (outside the daily snapshot window)"
        )
    body = "\n".join(lines)
    desc = INDICATOR_DESCRIPTIONS.get(indicator, "No description available.")
    return f"## {indicator} values from {before} to {curr_date}:\n\n{body}\n\n{desc}"


# --------------------------------------------------------------------------- #
# Fundamentals + financial statements
# --------------------------------------------------------------------------- #
def get_fundamentals(ticker: str, curr_date: str | None = None) -> str:
    fund = _bundle(ticker).get("fundamentals") or {}
    header = (f"# Company Fundamentals for {ticker.upper()}\n"
              f"# Data retrieved on: {_retrieved()}\n\n")
    lines = [f"{k}: {v}" for k, v in fund.items() if v not in (None, "", [], {})]
    return header + "\n".join(lines)


def _statement(ticker: str, key: str, title: str) -> str:
    rows = (_bundle(ticker).get("statements") or {}).get(key) or []
    if not rows:
        return f"No {title.lower()} data found for symbol '{ticker}'"
    header = (f"# {title} data for {ticker.upper()} (quarter)\n"
              f"# Data retrieved on: {_retrieved()}\n\n")
    return header + pd.DataFrame(rows).to_csv(index=False)


def get_balance_sheet(ticker: str, freq: str = "quarterly", curr_date: str | None = None) -> str:
    return _statement(ticker, "balance_sheet", "Balance Sheet")


def get_cashflow(ticker: str, freq: str = "quarterly", curr_date: str | None = None) -> str:
    return _statement(ticker, "cash_flow", "Cash Flow")


def get_income_statement(ticker: str, freq: str = "quarterly", curr_date: str | None = None) -> str:
    return _statement(ticker, "income_statement", "Income Statement")


# --------------------------------------------------------------------------- #
# Insider transactions
# --------------------------------------------------------------------------- #
def get_insider_transactions(ticker: str) -> str:
    rows = _bundle(ticker).get("insider") or []
    if not rows:
        return f"No insider transactions data found for symbol '{ticker}'"
    header = (f"# Insider Transactions data for {ticker.upper()}\n"
              f"# Data retrieved on: {_retrieved()}\n\n")
    return header + pd.DataFrame(rows).to_csv(index=False)


# --------------------------------------------------------------------------- #
# News (ticker + global) — Fin-node's own published coverage
# --------------------------------------------------------------------------- #
def get_news(ticker: str, start_date: str, end_date: str) -> str:
    items = _bundle(ticker).get("news") or []
    sel = [it for it in items if it.get("date") and start_date <= it["date"] <= end_date]
    header = f"## {ticker.upper()} news from {start_date} to {end_date} ({len(sel)} items):\n\n"
    body = "\n\n".join(_news_line(it) for it in sel)
    return header + (body or "No Fin-node articles for this ticker in the given window.")


def get_global_news(curr_date: str, look_back_days: int = 7, limit: int = 10) -> str:
    items = (_fetch("news.json").get("news") or [])
    start = (datetime.strptime(curr_date, "%Y-%m-%d") - timedelta(days=look_back_days)).strftime("%Y-%m-%d")
    sel = [it for it in items if not it.get("date") or start <= it["date"] <= curr_date][:limit]
    header = f"## Global market news from {start} to {curr_date} ({len(sel)} items):\n\n"
    body = "\n\n".join(_news_line(it) for it in sel)
    return header + (body or "No Fin-node articles in the given window.")
