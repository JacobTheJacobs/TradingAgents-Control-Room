from __future__ import annotations

from types import SimpleNamespace

import pandas as pd

from tradingagents.dataflows import fin_node


def test_fin_node_stock_data_prefers_yfinance_provider(monkeypatch):
    async def _bars(self, ticker, interval="1d", period="1y"):
        return [
            SimpleNamespace(timestamp="2026-05-01T00:00:00Z", open=100.0, high=105.0, low=99.0, close=104.0, volume=1000),
            SimpleNamespace(timestamp="2026-05-02T00:00:00Z", open=104.0, high=106.0, low=103.0, close=105.0, volume=1100),
        ]

    monkeypatch.setattr(fin_node, "_ensure_runtime_ready", lambda: None)
    monkeypatch.setattr(fin_node.YFinanceProvider, "get_bars", _bars)
    monkeypatch.setattr(fin_node, "_openbb_available", lambda: False)

    rendered = fin_node.get_stock_data("NVDA", "2026-05-01", "2026-05-02")
    assert "# Stock data for NVDA from 2026-05-01 to 2026-05-02" in rendered
    assert "2026-05-01,100.0,105.0,99.0,104.0,1000" in rendered


def test_fin_node_balance_sheet_falls_back_to_openbb(monkeypatch):
    monkeypatch.setattr(fin_node, "_yfinance_statement_rows", lambda ticker, statement_kind, period: [])
    monkeypatch.setattr(
        fin_node,
        "_openbb_statement_rows",
        lambda fetcher, ticker, period: [{"date": "2025-12-31", "total_assets": 10, "total_liabilities": 4}],
    )

    rendered = fin_node.get_balance_sheet("NVDA", "annual")
    assert "# Balance Sheet data for NVDA (annual)" in rendered
    assert "2025-12-31" in rendered


def test_fin_node_insider_transactions_prefers_sec(monkeypatch):
    class _Trade:
        def to_dict(self):
            return {"ticker": "NVDA", "filed_date": "2026-05-01", "transaction_type": "Filing"}

    async def _sec(self, ticker):
        return [_Trade()]

    monkeypatch.setattr(fin_node.SECProvider, "get_insider_trades", _sec)

    rendered = fin_node.get_insider_transactions("NVDA")
    assert "# Insider Transactions data for NVDA" in rendered
    assert "2026-05-01" in rendered
