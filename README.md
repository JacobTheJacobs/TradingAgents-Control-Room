<h1 align="center">TradingAgents Control Room</h1>

<p align="center"><b>Watch AI agents debate a stock, live on a pixel-art trading floor.</b></p>

<p align="center">
  <img alt="Status Alpha" src="https://img.shields.io/badge/status-alpha-ff4d4f?style=for-the-badge" />
  <img alt="License Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-1f6feb?style=for-the-badge" />
  <img alt="Stack FastAPI + React" src="https://img.shields.io/badge/stack-FastAPI%20%2B%20React-009688?style=for-the-badge" />
</p>

<p align="center">
  <img src="docs/assets/TradingAgentsUI.gif" alt="TradingAgents Control Room demo" width="720" />
</p>

<p align="center">
  <b>Analysts → Bull/Bear Debate → Trader → Risk → Decision</b><br/>
  A community UI for the open-source <a href="https://github.com/TauricResearch/TradingAgents">TradingAgents</a> framework.
</p>

---

## ⚡ Run it

**Needs:** [Docker](https://docs.docker.com/get-docker/) (Desktop on Windows/Mac,
or Engine + Compose v2 on Linux) and one LLM provider key.

**1. Configure.** Copy the env template and add an LLM key:

```bash
cp .env.example .env
# then edit .env and set NVIDIA_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
```

Market data needs **no key**. It comes from the free [Fin-Node](https://www.fin-node.net/api) CDN.

**2. Start.** Build and launch everything (API, UI, Postgres, Redis):

```bash
docker compose up --build
```

**3. Open.** UI on **`:3000`**, API health on **`:8001`**.

**4. Run.** In the **Trade** tab, pick a covered ticker (NVDA, AAPL, TSLA, MSFT,
AMZN, GOOGL, META, AMD), choose provider / model / depth, and hit run. Watch
the analysts, the bull/bear debate, the trader, and the risk desk move across the
floor as the decision forms.

Stop with `docker compose down`.

---

## Data

btw the market data all comes from [Fin-Node](https://www.fin-node.net/api), a
cool little free API I use for pulling prices and news into agents. No key, just:

```bash
curl https://www.fin-node.net/api/AAPL.json
```

---

## 🖥️ The UI

| Tab | What you get |
|---|---|
| **Trade** | pick ticker / models / depth → run |
| **Final Reports** | analyst + trader + risk output + the decision |
| **History Runs** | browse and reopen past runs |

---

<p align="center"><sub>
Alpha software · not for live trading · not financial advice<br/>
Built on <a href="https://github.com/TauricResearch/TradingAgents">TradingAgents</a> (<a href="https://arxiv.org/abs/2412.20138">arXiv:2412.20138</a>) by Tauric Research
</sub></p>
