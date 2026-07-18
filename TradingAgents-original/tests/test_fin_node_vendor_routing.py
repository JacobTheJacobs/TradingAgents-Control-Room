import pytest
import importlib.util
from pathlib import Path

from tradingagents.dataflows import config as dataflow_config
from tradingagents.dataflows import interface
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.llm_clients.openai_client import _tls_verify_value


@pytest.fixture(autouse=True)
def _reset_config(monkeypatch):
    monkeypatch.setattr(dataflow_config, "_config", DEFAULT_CONFIG.copy())


def test_default_config_uses_fin_node_for_data_vendors():
    assert DEFAULT_CONFIG["data_vendors"] == {
        "core_stock_apis": "fin_node",
        "technical_indicators": "fin_node",
        "fundamental_data": "fin_node",
        "news_data": "fin_node",
    }


def test_route_to_vendor_does_not_auto_fallback_when_only_fin_node_configured(monkeypatch):
    dataflow_config.set_config(
        {
            "data_vendors": {
                **DEFAULT_CONFIG["data_vendors"],
                "news_data": "fin_node",
            }
        }
    )
    calls = []

    def _fail(*args, **kwargs):
        calls.append("fin_node")
        raise RuntimeError("fin-node unavailable")

    def _yfinance(*args, **kwargs):
        calls.append("yfinance")
        return "unexpected fallback"

    monkeypatch.setitem(interface.VENDOR_METHODS["get_news"], "fin_node", _fail)
    monkeypatch.setitem(interface.VENDOR_METHODS["get_news"], "yfinance", _yfinance)

    with pytest.raises(RuntimeError, match="fin-node unavailable"):
        interface.route_to_vendor("get_news", "NVDA", "2026-05-01", "2026-05-08")

    assert calls == ["fin_node"]


def test_route_to_vendor_uses_explicit_fallback_chain(monkeypatch):
    dataflow_config.set_config(
        {
            "data_vendors": {
                **DEFAULT_CONFIG["data_vendors"],
                "news_data": "fin_node,yfinance",
            }
        }
    )
    calls = []

    def _fail(*args, **kwargs):
        calls.append("fin_node")
        raise RuntimeError("fin-node unavailable")

    def _yfinance(*args, **kwargs):
        calls.append("yfinance")
        return "fallback result"

    monkeypatch.setitem(interface.VENDOR_METHODS["get_news"], "fin_node", _fail)
    monkeypatch.setitem(interface.VENDOR_METHODS["get_news"], "yfinance", _yfinance)

    result = interface.route_to_vendor("get_news", "NVDA", "2026-05-01", "2026-05-08")

    assert result == "fallback result"
    assert calls == ["fin_node", "yfinance"]


def test_tradingagents_tls_uses_cert_bundle_by_default(monkeypatch):
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)
    monkeypatch.delenv("TA_INSECURE_SSL", raising=False)
    verify = _tls_verify_value()
    assert verify not in (False, None, "")


def test_default_config_honors_explicit_provider_env(monkeypatch):
    monkeypatch.setenv("TRADINGAGENTS_LLM_PROVIDER", "nvidia")
    module_path = Path("src/TradingAgents-original/tradingagents/default_config.py").resolve()
    spec = importlib.util.spec_from_file_location("ta_default_config_env_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    assert module.DEFAULT_CONFIG["llm_provider"] == "nvidia"
