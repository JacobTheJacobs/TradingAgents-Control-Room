"""
LLM Analytics Database

SQLite-backed store for per-call LLM telemetry, agent decisions, and
pipeline phase events. Every LLM call in the 8-phase trading pipeline
is tagged with (cycle, phase, agent, ticker) and persisted for querying.

DB path: data/analytics.db
"""

import sqlite3
import json
import os
import logging
from datetime import datetime
from typing import Optional, Dict, List, Any

from src.analytics.db_path import resolve_analytics_db_path

logger = logging.getLogger(__name__)

DB_PATH = resolve_analytics_db_path()

CREATE_TABLES = """
CREATE TABLE IF NOT EXISTS llm_calls (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        TEXT    NOT NULL,
    cycle_num        INTEGER,
    phase            TEXT,
    agent_name       TEXT,
    ticker           TEXT,
    provider         TEXT,
    model            TEXT,
    input_tokens     INTEGER DEFAULT 0,
    output_tokens    INTEGER DEFAULT 0,
    total_tokens     INTEGER DEFAULT 0,
    response_time_ms REAL    DEFAULT 0.0,
    success          INTEGER DEFAULT 1,
    error_msg        TEXT,
    cost_usd         REAL    DEFAULT 0.0
);

CREATE TABLE IF NOT EXISTS agent_decisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT    NOT NULL,
    cycle_num   INTEGER,
    phase       TEXT,
    agent_name  TEXT,
    ticker      TEXT,
    decision    TEXT,
    confidence  REAL,
    reasoning   TEXT,
    llm_call_id INTEGER
);

CREATE TABLE IF NOT EXISTS pipeline_phase_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp  TEXT NOT NULL,
    cycle_num  INTEGER,
    phase      TEXT,
    ticker     TEXT,
    event_type TEXT,
    data_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_llm_cycle   ON llm_calls (cycle_num);
CREATE INDEX IF NOT EXISTS idx_llm_phase   ON llm_calls (phase);
CREATE INDEX IF NOT EXISTS idx_llm_agent   ON llm_calls (agent_name);
CREATE INDEX IF NOT EXISTS idx_llm_provider ON llm_calls (provider);
CREATE INDEX IF NOT EXISTS idx_dec_cycle   ON agent_decisions (cycle_num);
CREATE INDEX IF NOT EXISTS idx_dec_agent   ON agent_decisions (agent_name);
CREATE INDEX IF NOT EXISTS idx_evt_cycle   ON pipeline_phase_events (cycle_num);

-- ============================================================================
-- UNIFIED DATA TABLES (replaces JSON files)
-- ============================================================================

-- Positions (replaces positions dict in trading_floor_state.json)
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE,
    shares INTEGER,
    entry_price REAL,
    entry_time TEXT,
    current_price REAL,
    max_price REAL,
    initial_atr REAL,
    initial_stop REAL,
    is_trimmed INTEGER DEFAULT 0,
    status TEXT DEFAULT 'open',
    tier TEXT,
    snapshot_img TEXT,
    updated_at TEXT
);

-- Blocklist (with auto-expiry for cool-down)
CREATE TABLE IF NOT EXISTS blocklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    reason TEXT,
    expires_at TEXT,
    created_at TEXT
);

-- Agent Accuracy (for adaptive voting weights)
CREATE TABLE IF NOT EXISTS agent_accuracy (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    cycle INTEGER,
    ticker TEXT,
    was_correct INTEGER,
    action TEXT,
    pnl_pct REAL,
    created_at TEXT,
    UNIQUE(agent_name, cycle, ticker)
);

-- Trade Memory (replaces trade_memory.json)
CREATE TABLE IF NOT EXISTS trade_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT,
    action TEXT,
    oracle_reasoning TEXT,
    agent_consensus TEXT,
    conviction INTEGER,
    regime TEXT,
    tags TEXT,
    pnl_pct REAL,
    snapshot_img TEXT,
    created_at TEXT
);

-- Execution History (replaces execution_history.json)
CREATE TABLE IF NOT EXISTS execution_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    cycle INTEGER,
    ticker TEXT,
    action TEXT,
    success INTEGER,
    message TEXT,
    trigger TEXT
);

-- Indexes for new tables
CREATE INDEX IF NOT EXISTS idx_positions_ticker ON positions (ticker);
CREATE INDEX IF NOT EXISTS idx_blocklist_ticker ON blocklist (ticker);
CREATE INDEX IF NOT EXISTS idx_blocklist_expires ON blocklist (expires_at);
CREATE INDEX IF NOT EXISTS idx_accuracy_agent ON agent_accuracy (agent_name);
CREATE INDEX IF NOT EXISTS idx_trade_memory_ticker ON trade_memory (ticker);
CREATE INDEX IF NOT EXISTS idx_execution_cycle ON execution_history (cycle);

-- ============================================================================
-- CONFIGURATION TABLES (replaces YAML and JSON config files)
-- ============================================================================

-- Agent Voices (replaces personalities.yaml)
CREATE TABLE IF NOT EXISTS agent_voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    archetype TEXT,
    emoji TEXT,
    bias TEXT,
    description TEXT,
    focus TEXT,           -- JSON array of focus areas
    catchphrases TEXT,    -- JSON array of catchphrases
    weight REAL DEFAULT 0.1,
    is_oracle INTEGER DEFAULT 0,
    is_intern INTEGER DEFAULT 0,
    free_analysis INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    canvas_x INTEGER,     -- Canvas position X coordinate
    canvas_y INTEGER,     -- Canvas position Y coordinate
    created_at TEXT,
    updated_at TEXT
);

-- Live Config (replaces live_config.json)
CREATE TABLE IF NOT EXISTS live_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key TEXT NOT NULL UNIQUE,
    config_value TEXT,    -- JSON value (supports nested objects)
    description TEXT,
    updated_at TEXT
);

-- Proposed Trades (for Boardroom H.I.T.L. sync)
CREATE TABLE IF NOT EXISTS proposed_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    ticker TEXT NOT NULL,
    action TEXT NOT NULL,
    amount REAL,
    price REAL,
    reasoning TEXT,
    confidence REAL,
    smart_size_suggested REAL,
    status TEXT DEFAULT 'pending',
    cycle_num INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_voices_name ON agent_voices (name);
CREATE INDEX IF NOT EXISTS idx_agent_voices_active ON agent_voices (is_active);
CREATE INDEX IF NOT EXISTS idx_live_config_key ON live_config (config_key);
CREATE INDEX IF NOT EXISTS idx_proposed_trades_ticker ON proposed_trades (ticker);
CREATE INDEX IF NOT EXISTS idx_proposed_trades_status ON proposed_trades (status);
"""


class LLMAnalyticsDB:
    """Thread-safe SQLite analytics store for LLM pipeline telemetry."""

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._init_db()
        logger.info(f"LLM Analytics DB ready: {db_path}")

    def _conn(self) -> sqlite3.Connection:
        """Open a short-lived connection with WAL mode (safe for async context)."""
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Enable WAL mode for better concurrency
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")  # Wait 5s for locks
        return conn

    def _init_db(self):
        with self._conn() as conn:
            conn.executescript(CREATE_TABLES)
        logger.info("Database initialized with WAL mode")

    # ─────────────────────────────────────────────────────────────
    # Write methods
    # ─────────────────────────────────────────────────────────────

    def record_llm_call(
        self,
        provider: str,
        model: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        response_time_ms: float = 0.0,
        success: bool = True,
        error_msg: Optional[str] = None,
        cycle: Optional[int] = None,
        phase: Optional[str] = None,
        agent: Optional[str] = None,
        ticker: Optional[str] = None,
    ) -> int:
        """Insert one LLM call record. Returns the new row id."""
        total = input_tokens + output_tokens
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            cur = conn.execute(
                """INSERT INTO llm_calls
                   (timestamp, cycle_num, phase, agent_name, ticker,
                    provider, model, input_tokens, output_tokens, total_tokens,
                    response_time_ms, success, error_msg, cost_usd)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0.0)""",
                (ts, cycle, phase, agent, ticker,
                 provider, model, input_tokens, output_tokens, total,
                 response_time_ms, 1 if success else 0, error_msg),
            )
            return cur.lastrowid

    def record_agent_decision(
        self,
        agent: str,
        ticker: str,
        decision: str,
        confidence: float,
        reasoning: str = "",
        cycle: Optional[int] = None,
        phase: Optional[str] = None,
        llm_call_id: Optional[int] = None,
    ):
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            conn.execute(
                """INSERT INTO agent_decisions
                   (timestamp, cycle_num, phase, agent_name, ticker,
                    decision, confidence, reasoning, llm_call_id)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (ts, cycle, phase, agent, ticker,
                 decision, confidence, reasoning[:500] if reasoning else "",
                 llm_call_id),
            )

    def record_phase_event(
        self,
        event_type: str,
        cycle: Optional[int] = None,
        phase: Optional[str] = None,
        ticker: Optional[str] = None,
        data: Optional[Dict] = None,
    ):
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            conn.execute(
                """INSERT INTO pipeline_phase_events
                   (timestamp, cycle_num, phase, ticker, event_type, data_json)
                   VALUES (?,?,?,?,?,?)""",
                (ts, cycle, phase, ticker, event_type,
                 json.dumps(data or {}, default=str)),
            )

    # ─────────────────────────────────────────────────────────────
    # Query methods
    # ─────────────────────────────────────────────────────────────

    def get_recent_llm_calls(
        self,
        limit: int = 100,
        phase: Optional[str] = None,
        agent: Optional[str] = None,
        cycle: Optional[int] = None,
    ) -> List[Dict]:
        wheres, params = [], []
        if phase:
            wheres.append("phase = ?"); params.append(phase)
        if agent:
            wheres.append("agent_name = ?"); params.append(agent)
        if cycle is not None:
            wheres.append("cycle_num = ?"); params.append(cycle)
        where_sql = ("WHERE " + " AND ".join(wheres)) if wheres else ""
        params.append(limit)
        with self._conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM llm_calls {where_sql} ORDER BY id DESC LIMIT ?",
                params,
            ).fetchall()
        return [dict(r) for r in rows]

    def count_llm_calls(
        self,
        phase: Optional[str] = None,
        agent: Optional[str] = None,
        cycle: Optional[int] = None,
    ) -> int:
        wheres, params = [], []
        if phase:
            wheres.append("phase = ?"); params.append(phase)
        if agent:
            wheres.append("agent_name = ?"); params.append(agent)
        if cycle is not None:
            wheres.append("cycle_num = ?"); params.append(cycle)
        where_sql = ("WHERE " + " AND ".join(wheres)) if wheres else ""
        with self._conn() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) AS c FROM llm_calls {where_sql}",
                params,
            ).fetchone()
        return int(row["c"]) if row else 0

    def get_provider_breakdown(self, cycle: Optional[int] = None) -> Dict:
        where_sql = "WHERE cycle_num = ?" if cycle is not None else ""
        params = [cycle] if cycle is not None else []
        with self._conn() as conn:
            rows = conn.execute(
                f"""SELECT provider,
                           COUNT(*)                      AS calls,
                           SUM(total_tokens)             AS tokens,
                           AVG(response_time_ms)         AS avg_ms,
                           SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS errors,
                           SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes
                    FROM llm_calls {where_sql}
                    GROUP BY provider
                    ORDER BY calls DESC""",
                params,
            ).fetchall()
        return {r["provider"]: dict(r) for r in rows}

    def get_cycle_summary(self, cycle: int) -> Dict:
        with self._conn() as conn:
            llm_row = conn.execute(
                """SELECT COUNT(*)             AS calls,
                          SUM(total_tokens)    AS tokens,
                          AVG(response_time_ms) AS avg_ms,
                          SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS errors,
                          GROUP_CONCAT(DISTINCT phase) AS phases
                   FROM llm_calls WHERE cycle_num=?""",
                (cycle,),
            ).fetchone()

            phase_rows = conn.execute(
                """SELECT phase,
                          COUNT(*)             AS calls,
                          SUM(total_tokens)    AS tokens,
                          AVG(response_time_ms) AS avg_ms
                   FROM llm_calls WHERE cycle_num=?
                   GROUP BY phase""",
                (cycle,),
            ).fetchall()

            events = conn.execute(
                """SELECT event_type, phase, ticker, data_json, timestamp
                   FROM pipeline_phase_events WHERE cycle_num=?
                   ORDER BY id""",
                (cycle,),
            ).fetchall()

            decisions = conn.execute(
                """SELECT agent_name, ticker, decision, confidence
                   FROM agent_decisions WHERE cycle_num=?
                   ORDER BY id""",
                (cycle,),
            ).fetchall()

        # Parse regime and trade count from events
        regime = None
        trades = 0
        tickers = set()
        for e in events:
            d = json.loads(e["data_json"] or "{}")
            if e["event_type"] == "cycle_start" and d.get("regime"):
                regime = d["regime"]
            if e["event_type"] == "trade_executed":
                trades += 1
            if e["ticker"]:
                tickers.add(e["ticker"])

        return {
            "cycle": cycle,
            "regime": regime,
            "tickers": list(tickers),
            "total_llm_calls": llm_row["calls"] or 0,
            "total_tokens": llm_row["tokens"] or 0,
            "avg_response_ms": round(llm_row["avg_ms"] or 0, 1),
            "total_errors": llm_row["errors"] or 0,
            "trades_executed": trades,
            "phase_breakdown": {
                r["phase"]: {
                    "calls": r["calls"],
                    "tokens": r["tokens"] or 0,
                    "avg_ms": round(r["avg_ms"] or 0, 1),
                }
                for r in phase_rows
            },
            "events": [dict(e) for e in events],
            "decisions": [dict(d) for d in decisions],
        }

    def get_all_cycle_summaries(self, limit: int = 50) -> List[Dict]:
        with self._conn() as conn:
            cycle_nums = conn.execute(
                "SELECT DISTINCT cycle_num FROM llm_calls "
                "WHERE cycle_num IS NOT NULL ORDER BY cycle_num DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [self.get_cycle_summary(r["cycle_num"]) for r in cycle_nums]

    def get_agent_stats(self, agent_name: Optional[str] = None) -> Dict:
        where_sql = "WHERE agent_name = ?" if agent_name else ""
        params = [agent_name] if agent_name else []
        with self._conn() as conn:
            rows = conn.execute(
                f"""SELECT agent_name,
                           COUNT(*)                      AS total_decisions,
                           AVG(confidence)               AS avg_confidence,
                           SUM(CASE WHEN decision IN ('BUY','STRONG_BUY') THEN 1 ELSE 0 END)   AS buys,
                           SUM(CASE WHEN decision IN ('SELL','STRONG_SELL','AVOID') THEN 1 ELSE 0 END) AS sells,
                           SUM(CASE WHEN decision='HOLD' THEN 1 ELSE 0 END)                    AS holds
                    FROM agent_decisions {where_sql}
                    GROUP BY agent_name
                    ORDER BY total_decisions DESC""",
                params,
            ).fetchall()

            # Per-agent LLM call counts
            llm_rows = conn.execute(
                f"""SELECT agent_name, COUNT(*) AS llm_calls, SUM(total_tokens) AS tokens
                    FROM llm_calls {'WHERE agent_name=?' if agent_name else ''}
                    GROUP BY agent_name""",
                [agent_name] if agent_name else [],
            ).fetchall()

        llm_map = {r["agent_name"]: dict(r) for r in llm_rows}

        result = {}
        for r in rows:
            name = r["agent_name"]
            total = r["total_decisions"] or 1
            result[name] = {
                "agent": name,
                "total_decisions": r["total_decisions"],
                "avg_confidence": round(r["avg_confidence"] or 0, 3),
                "buys": r["buys"],
                "sells": r["sells"],
                "holds": r["holds"],
                "buy_pct": round(r["buys"] / total * 100, 1),
                "sell_pct": round(r["sells"] / total * 100, 1),
                "hold_pct": round(r["holds"] / total * 100, 1),
                "llm_calls": llm_map.get(name, {}).get("llm_calls", 0),
                "llm_tokens": llm_map.get(name, {}).get("tokens", 0) or 0,
            }
        return result

    def get_agent_decision_history(
        self, agent_name: str, limit: int = 100
    ) -> List[Dict]:
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT * FROM agent_decisions
                   WHERE agent_name=?
                   ORDER BY id DESC LIMIT ?""",
                (agent_name, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    # ─────────────────────────────────────────────────────────────
    # Agent Voices methods (replaces personalities.yaml)
    # ─────────────────────────────────────────────────────────────

    def get_all_voices(self, active_only: bool = True) -> List["Voice"]:
        """Load all agent voices from database."""
        from src.runtime.agents_loader import Voice
        where = "WHERE is_active = 1" if active_only else ""
        with self._conn() as conn:
            rows = conn.execute(
                f"""SELECT * FROM agent_voices {where} ORDER BY weight DESC"""
            ).fetchall()
        
        voices = []
        for r in rows:
            voice = Voice(
                id=r["voice_id"],
                name=r["name"],
                archetype=r["archetype"] or "",
                emoji=r["emoji"] or "",
                bias=r["bias"] or "",
                description=r["description"] or "",
                focus=json.loads(r["focus"]) if r["focus"] else [],
                catchphrases=json.loads(r["catchphrases"]) if r["catchphrases"] else [],
                weight=r["weight"] or 0.1,
                is_oracle=bool(r["is_oracle"]),
                is_intern=bool(r["is_intern"]),
                free_analysis=bool(r["free_analysis"]),
                is_active=bool(r["is_active"]),
                canvas_x=r["canvas_x"],
                canvas_y=r["canvas_y"],
            )
            voices.append(voice)
        
        return voices

    def get_oracle(self) -> Optional["Voice"]:
        """Get the Oracle voice configuration."""
        from src.runtime.agents_loader import Voice
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM agent_voices WHERE is_oracle = 1"
            ).fetchone()
        
        if not row:
            return None
        
        voice = Voice(
            id=row["voice_id"],
            name=row["name"],
            archetype=row["archetype"] or "",
            emoji=row["emoji"] or "",
            bias=row["bias"] or "",
            description=row["description"] or "",
            focus=json.loads(row["focus"]) if row["focus"] else [],
            catchphrases=json.loads(row["catchphrases"]) if row["catchphrases"] else [],
            weight=row["weight"] or 1.0,
            is_oracle=True,
            is_intern=bool(row["is_intern"]),
            free_analysis=bool(row["free_analysis"]),
            is_active=bool(row["is_active"]),
            canvas_x=row["canvas_x"],
            canvas_y=row["canvas_y"],
        )
        return voice

    # ─────────────────────────────────────────────────────────────
    # Live Config methods (replaces live_config.json)
    # ─────────────────────────────────────────────────────────────

    def get_live_config(self, key: str, default: Any = None) -> Any:
        """Get a config value by key."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT config_value FROM live_config WHERE config_key = ?", (key,)
            ).fetchone()
        
        if not row:
            return default
        
        try:
            return json.loads(row["config_value"])
        except (json.JSONDecodeError, TypeError):
            return row["config_value"]

    def set_live_config(self, key: str, value: Any, description: str = ""):
        """Set a config value."""
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO live_config
                   (config_key, config_value, description, updated_at)
                   VALUES (?,?,?,?)""",
                (key, json.dumps(value), description, ts),
            )

    def get_all_live_config(self) -> Dict[str, Any]:
        """Get all config values as a dict."""
        with self._conn() as conn:
            rows = conn.execute("SELECT config_key, config_value FROM live_config").fetchall()
        
        result = {}
        for r in rows:
            try:
                result[r["config_key"]] = json.loads(r["config_value"])
            except (json.JSONDecodeError, TypeError):
                result[r["config_key"]] = r["config_value"]
        return result

    def get_agent_toggles(self) -> Dict[str, bool]:
        """Get agent toggle settings."""
        toggles = self.get_live_config("agent_toggles", {1: 1}) # Just to avoid empty list issues
        if not toggles or toggles == {1: 1}:
            # Default: all agents enabled
            from src.runtime.automation import ALL_AGENTS
            toggles = {agent: True for agent in ALL_AGENTS}
        return toggles

    # ─────────────────────────────────────────────────────────────
    # Proposed Trades methods (for Boardroom)
    # ─────────────────────────────────────────────────────────────

    def record_proposed_trade(self, trade_data: Dict[str, Any]):
        """Insert a proposed trade for Boardroom review."""
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            conn.execute(
                """INSERT INTO proposed_trades
                   (timestamp, ticker, action, amount, price, reasoning, confidence, smart_size_suggested, cycle_num)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (ts, trade_data.get("ticker"), trade_data.get("action"),
                 trade_data.get("amount"), trade_data.get("price"),
                 trade_data.get("reasoning"), trade_data.get("confidence"),
                 trade_data.get("smart_size_suggested"), trade_data.get("cycle_num")),
            )

    def get_proposed_trades(self, status: str = "pending") -> List[Dict]:
        """Get all proposed trades by status."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM proposed_trades WHERE status = ? ORDER BY id DESC",
                (status,),
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_proposed_trade(self, trade_id: int):
        """Delete a proposed trade."""
        with self._conn() as conn:
            conn.execute("DELETE FROM proposed_trades WHERE id = ?", (trade_id,))

    def clear_proposed_trades(self):
        """Clear all pending proposed trades."""
        with self._conn() as conn:
            conn.execute("DELETE FROM proposed_trades WHERE status = 'pending'")


# ─── Global singleton ────────────────────────────────────────────────────────

_analytics_db: Optional[LLMAnalyticsDB] = None


def get_analytics_db() -> LLMAnalyticsDB:
    global _analytics_db
    if _analytics_db is None:
        _analytics_db = LLMAnalyticsDB()
    return _analytics_db
