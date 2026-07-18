"""
Data Access Layer for Unified SQLite Database

Provides CRUD operations for positions, blocklist, execution history,
trade memory, and app config.
"""

import sqlite3
import json
import os
import logging
import asyncio
import contextlib
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Any, Union, Tuple

from src.analytics.db_path import resolve_analytics_db_path

logger = logging.getLogger(__name__)
_WAL_FALLBACK_WARNED = False

DB_PATH = resolve_analytics_db_path()

# JSON file paths removed - all state now comes exclusively from SQLite DB


class DataAccess:
    """Unified data access layer with WAL mode. SQLite is the sole source of truth."""

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._init_tables()
        self._lock = asyncio.Lock()
        logger.info(f"DataAccess initialized: {db_path}")

    def _conn(self) -> sqlite3.Connection:
        """Open connection with WAL mode."""
        global _WAL_FALLBACK_WARNED
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.OperationalError as exc:
            if not _WAL_FALLBACK_WARNED:
                logger.warning(
                    "SQLite WAL unavailable for %s; falling back to default journal mode: %s",
                    self.db_path,
                    exc,
                )
                _WAL_FALLBACK_WARNED = True
            with contextlib.suppress(Exception):
                conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _init_tables(self):
        """Create tables if they don't exist."""
        CREATE_TABLES = """
        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL UNIQUE,
            shares INTEGER,
            entry_price REAL,
            entry_time TEXT,
            entry_benchmark_price REAL,
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

        CREATE TABLE IF NOT EXISTS blocklist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            reason TEXT,
            expires_at TEXT,
            created_at TEXT
        );

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

        CREATE TABLE IF NOT EXISTS trade_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT,
            action TEXT,
            oracle_reasoning TEXT,
            agent_consensus TEXT,
            conviction INTEGER,
            regime TEXT,
            tags TEXT,
            success INTEGER,
            message TEXT,
            trigger TEXT,
            prediction TEXT,
            confidence REAL
        );

        CREATE TABLE IF NOT EXISTS execution_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            cycle INTEGER,
            ticker TEXT,
            action TEXT,        total_value REAL,
            cash REAL,
            daily_pnl REAL,
            spy_benchmark REAL,
            performance_vs_spy REAL
        );

        CREATE TABLE IF NOT EXISTS closed_trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            entry_time TEXT,
            exit_time TEXT,
            entry_price REAL,
            exit_price REAL,
            entry_spy_price REAL,
            exit_spy_price REAL,
            pnl_pct REAL,
            spy_return_pct REAL,
            alpha_pct REAL,
            exit_reason TEXT,
            source_trade_id TEXT,
            created_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_positions_ticker ON positions (ticker);
        CREATE INDEX IF NOT EXISTS idx_blocklist_expires ON blocklist (expires_at);
        CREATE INDEX IF NOT EXISTS idx_accuracy_agent ON agent_accuracy (agent_name);
        CREATE INDEX IF NOT EXISTS idx_closed_trades_created ON closed_trades (created_at);
        CREATE TABLE IF NOT EXISTS app_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS tradingagents_runs (
            run_id TEXT PRIMARY KEY,
            created_at TEXT,
            updated_at TEXT NOT NULL,
            payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ta_runs_created_at ON tradingagents_runs (created_at DESC);
        """
        with self._conn() as conn:
            conn.executescript(CREATE_TABLES)
        self._ensure_column("positions", "entry_benchmark_price", "REAL")
        self._ensure_column("positions", "max_price", "REAL")
        self._ensure_column("positions", "initial_atr", "REAL")
        self._ensure_column("positions", "initial_stop", "REAL")
        self._ensure_column("positions", "is_trimmed", "INTEGER DEFAULT 0")
        self._ensure_column("closed_trades", "exit_reason", "TEXT")
        self._ensure_column("execution_history", "prediction", "TEXT")
        self._ensure_column("execution_history", "confidence", "REAL")

    def _ensure_column(self, table: str, column: str, col_type: str):
        """Add column to a table if missing."""
        try:
            with self._conn() as conn:
                rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
                existing = {row["name"] for row in rows}
                if column not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
        except Exception as e:
            logger.warning(f"Could not ensure column {table}.{column}: {e}")

    # =========================================================================
    # ADMIN / PURGE
    async def save_portfolio_state(self, state: Dict):
        """Portfolio persistence removed from analytics store."""
        return None

    def get_earliest_portfolio_state(self) -> Optional[Dict]:
        """Portfolio persistence removed from analytics store."""
        return None

    def get_portfolio_value_at_or_before(self, ts: str) -> Optional[Dict]:
        """Portfolio persistence removed from analytics store."""
        return None

    def get_latest_portfolio_state(self) -> Optional[Dict]:
        """Portfolio persistence removed from analytics store."""
        return None

    # =========================================================================
    # META STORE
    # =========================================================================

    def get_meta(self, key: str, default: Any = None) -> Any:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT value FROM app_config WHERE key = ?",
                (key,),
            ).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return row["value"]

    def set_meta(self, key: str, value: Any) -> None:
        payload = json.dumps(value, default=str)
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (key, payload, datetime.now().isoformat()),
            )


    # =========================================================================
    # POSITIONS
    # =========================================================================

    def get_positions(self) -> Dict[str, int]:
        """Get all open positions as {ticker: shares}. Only return positions with >= 1 share."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT ticker, shares FROM positions WHERE status = 'open' AND shares >= 1"
            ).fetchall()
            return {row["ticker"]: row["shares"] for row in rows}
    
    def cleanup_zero_share_positions(self) -> int:
        """Remove positions with 0 or negative shares. Returns count of cleaned positions."""
        with self._conn() as conn:
            # Find positions to clean up
            rows = conn.execute(
                "SELECT ticker, shares FROM positions WHERE status = 'open' AND (shares IS NULL OR shares < 1)"
            ).fetchall()
            
            if rows:
                tickers_to_clean = [row["ticker"] for row in rows]
                # Delete them
                conn.execute(
                    "DELETE FROM positions WHERE status = 'open' AND (shares IS NULL OR shares < 1)"
                )
                logger.info(f"Cleaned up {len(tickers_to_clean)} zero-share positions: {tickers_to_clean}")
                return len(tickers_to_clean)
            return 0

    def get_position_details(self) -> Dict[str, Dict]:
        """Get all position details including entry price, tier, etc."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM positions WHERE status = 'open'"
            ).fetchall()
            return {row["ticker"]: dict(row) for row in rows}

    def update_position(self, ticker: str, shares: int, entry_price: float,
                        tier: Optional[str] = None, snapshot_img: Optional[str] = None,
                        entry_benchmark_price: Optional[float] = None,
                        initial_atr: Optional[float] = None, initial_stop: Optional[float] = None):
        """Add or update a position."""
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            # Check if position exists
            existing = conn.execute(
                "SELECT shares FROM positions WHERE ticker = ?", (ticker,)
            ).fetchone()

            if existing:
                # Update existing position
                new_shares = existing["shares"] + shares
                conn.execute(
                    """UPDATE positions SET shares = ?, current_price = ?, 
                       tier = COALESCE(?, tier),
                       entry_benchmark_price = COALESCE(?, entry_benchmark_price),
                       initial_atr = COALESCE(?, initial_atr),
                       initial_stop = COALESCE(?, initial_stop),
                       updated_at = ? WHERE ticker = ?""",
                    (new_shares, entry_price, tier, entry_benchmark_price, initial_atr, initial_stop, ts, ticker)
                )
            else:
                # Insert new position
                conn.execute(
                    """INSERT INTO positions 
                    (ticker, shares, entry_price, entry_time, entry_benchmark_price,
                     current_price, max_price, initial_atr, initial_stop, status, tier, snapshot_img, updated_at)
                    VALUES (?,?,?,?,?, ?, ?, ?, ?, 'open', ?, ?, ?)""",
                    (ticker, shares, entry_price, ts, entry_benchmark_price,
                     entry_price, entry_price, initial_atr, initial_stop, tier, snapshot_img, ts)
                )
        logger.info(f"Position updated: {ticker} +{shares} @ ${entry_price:.2f}")

    def update_position_price(self, ticker: str, price: float):
        """Update current price and timestamp for an open position."""
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            conn.execute(
                "UPDATE positions SET current_price = ?, updated_at = ? WHERE ticker = ? AND status = 'open'",
                (price, ts, ticker)
            )

    def update_position_tracker(self, ticker: str, tracker_data: Dict) -> None:
        """Update position tracker data (entry_price, entry_time, entry_benchmark_price) for an open position."""
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            conn.execute(
                """UPDATE positions SET 
                   entry_price = COALESCE(?, entry_price),
                   entry_time = COALESCE(?, entry_time),
                   entry_benchmark_price = COALESCE(?, entry_benchmark_price),
                   updated_at = ? 
                   WHERE ticker = ? AND status = 'open'""",
                (tracker_data.get("entry_price"), tracker_data.get("entry_time"),
                 tracker_data.get("entry_benchmark_price"), ts, ticker)
            )
        logger.info(f"Position tracker updated: {ticker}")

    def close_position(self, ticker: str, close_price: Optional[float] = None,
                        add_to_blocklist: bool = True, blocklist_hours: int = 250) -> Dict:
        ts = datetime.now().isoformat()
        position = None
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM positions WHERE ticker = ? AND status = 'open'", (ticker,)
            ).fetchone()
            if row:
                position = dict(row)
                conn.execute(
                    "UPDATE positions SET status = 'closed', current_price = ?, updated_at = ? WHERE ticker = ?",
                    (close_price or position["entry_price"], ts, ticker)
                )

        # Add to blocklist for cool-down period
        if add_to_blocklist and position:
            self.add_to_blocklist(ticker, f"Position closed - cool-down period", hours=blocklist_hours)
            logger.info(f"Added {ticker} to blocklist for {blocklist_hours}h cool-down")

        return position or {}

    # =========================================================================
    # BLOCKLIST
    # =========================================================================

    def add_to_blocklist(self, ticker: str, reason: str, hours: int = 24):
        """Add ticker to blocklist with expiry. Uses DELETE + INSERT to prevent duplicates."""
        ts = datetime.now().isoformat()
        expires = (datetime.now() + timedelta(hours=hours)).isoformat()
        with self._conn() as conn:
            # Delete existing entry first to prevent duplicates
            conn.execute("DELETE FROM blocklist WHERE ticker = ?", (ticker,))
            conn.execute(
                """INSERT INTO blocklist (ticker, reason, expires_at, created_at)
                   VALUES (?, ?, ?, ?)""",
                (ticker, reason, expires, ts)
            )
        logger.info(f"Blocklist: {ticker} added for {hours}h - {reason}")

    def get_active_blocklist(self) -> List[str]:
        """Get tickers currently on blocklist (not expired)."""
        now = datetime.now().isoformat()
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT ticker FROM blocklist WHERE expires_at > ? OR expires_at IS NULL",
                (now,)
            ).fetchall()
            return [row["ticker"] for row in rows]

    def get_blocklist_details(self) -> List[Dict]:
        """Get full blocklist details."""
        now = datetime.now().isoformat()
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM blocklist WHERE expires_at > ? OR expires_at IS NULL ORDER BY created_at DESC",
                (now,)
            ).fetchall()
            return [dict(row) for row in rows]

    def remove_from_blocklist(self, ticker: str):
        """Remove ticker from blocklist."""
        with self._conn() as conn:
            conn.execute("DELETE FROM blocklist WHERE ticker = ?", (ticker,))
        logger.info(f"Blocklist: {ticker} removed")

    # =========================================================================
    # EXECUTION HISTORY
    # =========================================================================

    def record_execution(self, cycle: int, ticker: Optional[str], action: str,
                         success: bool, message: str, trigger: str = "manual",
                         prediction: Optional[str] = None, confidence: Optional[float] = None):
        """Record a pipeline execution to history."""
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            # Deduplicate: Don't insert if same execution exists within 2 seconds
            recent = conn.execute(
                '''SELECT id FROM execution_history 
                   WHERE cycle = ? AND ticker = ? AND action = ? AND trigger = ?
                   AND timestamp > datetime('now', '-2 seconds')''',
                (cycle, ticker or '', action, trigger)
            ).fetchone()
            
            if recent:
                logger.debug(f"Skipping duplicate execution record: cycle={cycle}, ticker={ticker}")
                return  # Skip duplicate
            
            conn.execute(
                """INSERT INTO execution_history 
                   (timestamp, cycle, ticker, action, success, message, trigger, prediction, confidence)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (ts, cycle, ticker, action, 1 if success else 0, message, trigger, prediction, confidence)
            )


    def get_execution_history(self, limit: int = 20) -> List[Dict]:
        """Get recent execution history."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM execution_history ORDER BY id DESC LIMIT ?",
                (limit,)
            ).fetchall()
            return [dict(row) for row in rows]

    def import_execution_history(self, entries: List[Dict[str, Any]]) -> int:
        """Bulk import execution history rows, preserving timestamps."""
        if not entries:
            return 0
        inserted = 0
        with self._conn() as conn:
            existing = conn.execute("SELECT COUNT(*) AS count FROM execution_history").fetchone()
            if (existing["count"] if existing else 0) > 0:
                return 0
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                ts = entry.get("timestamp") or datetime.now().isoformat()
                cycle = entry.get("cycle")
                ticker = entry.get("ticker")
                action = entry.get("action") or "HOLD"
                success = 1 if bool(entry.get("success")) else 0
                message = entry.get("message") or ""
                trigger = entry.get("trigger") or "manual"
                prediction = entry.get("prediction")
                confidence = entry.get("confidence")
                conn.execute(
                    """INSERT INTO execution_history
                       (timestamp, cycle, ticker, action, success, message, trigger, prediction, confidence)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (ts, cycle, ticker, action, success, message, trigger, prediction, confidence),
                )
                inserted += 1
        return inserted

    def get_execution_details(self, history_id: int) -> Optional[Dict]:
        """Get full details for an execution run, including joined trade memory."""
        with self._conn() as conn:
            # 1. Get history record
            hist = conn.execute(
                "SELECT * FROM execution_history WHERE id = ?", (history_id,)
            ).fetchone()
            if not hist:
                return None
            
            result = dict(hist)
            
            # 2. Try to find matching trade memory
            # We match by ticker and approximate timestamp (within 2 minutes)
            ticker = hist["ticker"]
            timestamp = hist["timestamp"]
            
            if ticker and timestamp:
                try:
                    dt = datetime.fromisoformat(timestamp)
                    start_dt = (dt - timedelta(minutes=2)).isoformat()
                    end_dt = (dt + timedelta(minutes=2)).isoformat()
                    
                    tm = conn.execute(
                        """SELECT * FROM trade_memory 
                           WHERE ticker = ? AND created_at BETWEEN ? AND ?
                           ORDER BY id DESC LIMIT 1""",
                        (ticker, start_dt, end_dt)
                    ).fetchone()
                    
                    if tm:
                        tm_dict = dict(tm)
                        tm_dict["agent_consensus"] = json.loads(tm_dict["agent_consensus"] or "{}")
                        tm_dict["tags"] = json.loads(tm_dict["tags"] or "[]")
                        result["trade_memory"] = tm_dict
                except Exception as e:
                    logger.warning(f"Error joining trade memory for history {history_id}: {e}")
                
            return result

    # =========================================================================
    # CLOSED TRADES
    # =========================================================================

    def insert_closed_trade(self, trade: Dict[str, Any]) -> None:
        """Insert a closed trade record."""
        ts = datetime.now().isoformat()
        with self._conn() as conn:
            conn.execute(
                """INSERT INTO closed_trades
                   (ticker, entry_time, exit_time, entry_price, exit_price,
                    entry_spy_price, exit_spy_price, pnl_pct, spy_return_pct, alpha_pct,
                    exit_reason, source_trade_id, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    trade.get("ticker"),
                    trade.get("entry_time"),
                    trade.get("exit_time"),
                    trade.get("entry_price"),
                    trade.get("exit_price"),
                    trade.get("entry_spy_price"),
                    trade.get("exit_spy_price"),
                    trade.get("pnl_pct"),
                    trade.get("spy_return_pct"),
                    trade.get("alpha_pct"),
                    trade.get("exit_reason"),
                    trade.get("source_trade_id"),
                    trade.get("created_at", ts),
                ),
            )

    def list_closed_trades(self, limit: int = 10) -> List[Dict]:
        """Get recent closed trades."""
        with self._conn() as conn:
            if limit is None or limit <= 0:
                rows = conn.execute(
                    "SELECT * FROM closed_trades ORDER BY id DESC"
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM closed_trades ORDER BY id DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(row) for row in rows]

    # =========================================================================
    # APP CONFIGURATION (Key-Value Store)
    # =========================================================================

    def get_config(self, key: str) -> Optional[Dict[str, Any]]:
        """Retrieve a JSON configuration object by its key."""
        with self._conn() as conn:
            row = conn.execute("SELECT value FROM app_config WHERE key = ?", (key,)).fetchone()
            if row:
                try:
                    return json.loads(row["value"])
                except Exception as e:
                    logger.error(f"Failed to parse JSON for config {key}: {e}")
            return None

    def set_config(self, key: str, value: Any) -> bool:
        """Store a JSON configuration object by its key."""
        ts = datetime.now().isoformat()
        try:
            val_str = json.dumps(value)
            with self._conn() as conn:
                conn.execute(
                    """
                    INSERT INTO app_config (key, value, updated_at) 
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET 
                        value=excluded.value, 
                        updated_at=excluded.updated_at
                    """,
                    (key, val_str, ts)
                )
            return True
        except Exception as e:
            logger.error(f"Failed to set config {key}: {e}")
            return False

    def delete_config(self, key: str) -> bool:
        """Delete a configuration entry by key."""
        try:
            with self._conn() as conn:
                conn.execute("DELETE FROM app_config WHERE key = ?", (key,))
            return True
        except Exception as e:
            logger.error(f"Failed to delete config {key}: {e}")
            return False

    # =========================================================================
    # TRADINGAGENTS RUN HISTORY
    # =========================================================================

    def upsert_tradingagents_run(self, run_id: str, payload: Dict[str, Any]) -> bool:
        run_id = str(run_id or "").strip()
        if not run_id:
            return False
        now = datetime.now().isoformat()
        created_at = str((payload or {}).get("created_at") or now)
        try:
            payload_str = json.dumps(payload or {}, default=str)
            with self._conn() as conn:
                conn.execute(
                    """
                    INSERT INTO tradingagents_runs (run_id, created_at, updated_at, payload)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(run_id) DO UPDATE SET
                        updated_at=excluded.updated_at,
                        payload=excluded.payload
                    """,
                    (run_id, created_at, now, payload_str),
                )
            return True
        except Exception as e:
            logger.error(f"Failed to upsert TradingAgents run {run_id}: {e}")
            return False

    def get_tradingagents_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        run_id = str(run_id or "").strip()
        if not run_id:
            return None
        try:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT payload FROM tradingagents_runs WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
            if not row:
                return None
            payload = json.loads(row["payload"])
            if isinstance(payload, dict):
                payload.setdefault("run_id", run_id)
                return payload
            return None
        except Exception as e:
            logger.error(f"Failed to get TradingAgents run {run_id}: {e}")
            return None

    def get_tradingagents_runs(self, limit: int = 20) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit or 20), 1000))
        try:
            with self._conn() as conn:
                rows = conn.execute(
                    """
                    SELECT run_id, payload
                    FROM tradingagents_runs
                    ORDER BY COALESCE(created_at, updated_at) DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
            out: List[Dict[str, Any]] = []
            for row in rows:
                try:
                    payload = json.loads(row["payload"])
                except Exception:
                    continue
                if isinstance(payload, dict):
                    payload.setdefault("run_id", row["run_id"])
                    out.append(payload)
            return out
        except Exception as e:
            logger.error(f"Failed to list TradingAgents runs: {e}")
            return []

    def get_pipeline_execution_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Get recent pipeline execution history.
        Returns list of pipeline runs with timestamps, tickers, and results.
        """
        try:
            with self._conn() as conn:
                cursor = conn.execute("""
                    SELECT 
                        timestamp,
                        ticker,
                        pipeline_mode,
                        research_depth,
                        decision,
                        conviction,
                        portfolio_exposure,
                        notes
                    FROM pipeline_executions
                    ORDER BY timestamp DESC
                    LIMIT ?
                """, (limit,))
                
                rows = cursor.fetchall()
                history = []
                for row in rows:
                    history.append({
                        "timestamp": row["timestamp"],
                        "ticker": row["ticker"],
                        "pipeline_mode": row["pipeline_mode"],
                        "research_depth": row["research_depth"],
                        "decision": row["decision"],
                        "conviction": row["conviction"],
                        "portfolio_exposure": row["portfolio_exposure"],
                        "notes": row["notes"],
                    })
                return history
        except Exception as e:
            logger.error(f"Failed to get pipeline execution history: {e}")
            return []

    # =========================================================================
    # TRADINGAGENTS LLM CONFIG
    # =========================================================================

    def get_tradingagents_llm_config(self) -> Dict[str, Any]:
        """Get the persisted TradingAgents LLM configuration with defaults."""
        nvidia_default_quick = "stockmark/stockmark-2-100b-instruct"
        nvidia_default_deep = "mistralai/mistral-large-3-675b-instruct-2512"
        ollama_default_quick = "locooperator-4b-tools:latest"
        ollama_default_deep = "mn-12b-magmell-tools:latest"
        nvidia_allowed_models = {
            nvidia_default_quick,
            "minimaxai/minimax-m2.7",
            "qwen/qwen3-next-80b-a3b-instruct",
            "openai/gpt-oss-120b",
            "nvidia/nemotron-3-super-120b-a12b",
            nvidia_default_deep,
        }
        preset_to_drama = {
            "institutional": "low",
            "buy_side_pod": "medium",
            "war_room": "high",
        }
        drama_to_preset = {value: key for key, value in preset_to_drama.items()}
        supported_languages = {
            "English",
            "Chinese",
            "Japanese",
            "Korean",
            "Hindi",
            "Spanish",
            "Portuguese",
            "French",
            "German",
            "Arabic",
            "Russian",
        }

        def normalize_language(value: Any) -> str:
            raw = str(value or "").strip()
            for language in supported_languages:
                if raw.lower() == language.lower():
                    return language
            return "English"

        config = self.get_config("tradingagents_llm_config")
        if not config:
            # Default fallback
            return {
                "llm_provider": "nvidia",
                "deep_model": nvidia_default_deep,
                "quick_model": nvidia_default_quick,
                "output_language": "English",
                "scene_dialogue_preset": "buy_side_pod",
                "drama_level": "medium",
                "schema_version": 1,
                "updated_at": datetime.now().isoformat()
            }
        provider = str(config.get("llm_provider") or "").strip().lower()
        if provider not in {"nvidia", "openai", "anthropic", "google", "xai", "openrouter", "ollama"}:
            config["llm_provider"] = "nvidia"
            provider = "nvidia"
        if provider == "nvidia":
            if str(config.get("quick_model") or "").strip() not in nvidia_allowed_models:
                config["quick_model"] = nvidia_default_quick
            if str(config.get("deep_model") or "").strip() not in nvidia_allowed_models:
                config["deep_model"] = nvidia_default_deep
        elif provider == "ollama":
            if not str(config.get("quick_model") or "").strip():
                config["quick_model"] = ollama_default_quick
            if not str(config.get("deep_model") or "").strip():
                config["deep_model"] = ollama_default_deep
        preset = str(config.get("scene_dialogue_preset") or "").strip().lower()
        if preset not in {"buy_side_pod", "war_room", "institutional"}:
            config["scene_dialogue_preset"] = "buy_side_pod"
            preset = "buy_side_pod"
        drama_level = str(config.get("drama_level") or "").strip().lower()
        if drama_level not in {"low", "medium", "high"}:
            drama_level = preset_to_drama.get(preset, "medium")
        config["drama_level"] = drama_level
        # Keep both fields in-sync for compatibility with existing callers.
        config["scene_dialogue_preset"] = drama_to_preset.get(drama_level, preset)
        config["output_language"] = normalize_language(config.get("output_language"))
        return config

    def set_tradingagents_llm_config(self, config: Dict[str, Any]) -> bool:
        """Persist the TradingAgents LLM configuration."""
        nvidia_default_quick = "stockmark/stockmark-2-100b-instruct"
        nvidia_default_deep = "mistralai/mistral-large-3-675b-instruct-2512"
        ollama_default_quick = "locooperator-4b-tools:latest"
        ollama_default_deep = "mn-12b-magmell-tools:latest"
        nvidia_allowed_models = {
            nvidia_default_quick,
            "minimaxai/minimax-m2.7",
            "qwen/qwen3-next-80b-a3b-instruct",
            "openai/gpt-oss-120b",
            "nvidia/nemotron-3-super-120b-a12b",
            nvidia_default_deep,
        }
        preset_to_drama = {
            "institutional": "low",
            "buy_side_pod": "medium",
            "war_room": "high",
        }
        drama_to_preset = {value: key for key, value in preset_to_drama.items()}
        supported_languages = {
            "English",
            "Chinese",
            "Japanese",
            "Korean",
            "Hindi",
            "Spanish",
            "Portuguese",
            "French",
            "German",
            "Arabic",
            "Russian",
        }

        def normalize_language(value: Any) -> str:
            raw = str(value or "").strip()
            for language in supported_languages:
                if raw.lower() == language.lower():
                    return language
            return "English"

        preset = str(config.get("scene_dialogue_preset") or "").strip().lower()
        drama_level = str(config.get("drama_level") or "").strip().lower()
        if drama_level in {"low", "medium", "high"}:
            preset = drama_to_preset.get(drama_level, "buy_side_pod")
        elif preset in {"buy_side_pod", "war_room", "institutional"}:
            drama_level = preset_to_drama.get(preset, "medium")
        else:
            drama_level = "medium"
            preset = drama_to_preset[drama_level]
        config["drama_level"] = drama_level
        config["scene_dialogue_preset"] = preset
        provider = str(config.get("llm_provider") or "").strip().lower()
        if provider not in {"nvidia", "openai", "anthropic", "google", "xai", "openrouter", "ollama"}:
            config["llm_provider"] = "nvidia"
            provider = "nvidia"
        if provider == "nvidia":
            if str(config.get("quick_model") or "").strip() not in nvidia_allowed_models:
                config["quick_model"] = nvidia_default_quick
            if str(config.get("deep_model") or "").strip() not in nvidia_allowed_models:
                config["deep_model"] = nvidia_default_deep
        elif provider == "ollama":
            if not str(config.get("quick_model") or "").strip():
                config["quick_model"] = ollama_default_quick
            if not str(config.get("deep_model") or "").strip():
                config["deep_model"] = ollama_default_deep
        config["output_language"] = normalize_language(config.get("output_language"))
        config["updated_at"] = datetime.now().isoformat()
        if "schema_version" not in config:
            config["schema_version"] = 1
        return self.set_config("tradingagents_llm_config", config)

    # =========================================================================
    # TRADE MEMORY
    def get_trade_memories(self, limit: int = 50) -> List[Dict]:
        """Get recent trade memories."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM trade_memory ORDER BY id DESC LIMIT ?",
                (limit,)
            ).fetchall()
            results = []
            for row in rows:
                d = dict(row)
                d["agent_consensus"] = json.loads(d["agent_consensus"] or "{}")
                d["tags"] = json.loads(d["tags"] or "[]")
                results.append(d)
            return results

    def get_agent_accuracy_stats(self) -> Dict[str, Dict]:
        """Get accuracy stats for all agents."""
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT agent_name,
                          COUNT(*) as total_calls,
                          SUM(was_correct) as wins,
                          ROUND(AVG(was_correct) * 100, 1) as win_rate,
                          ROUND(AVG(pnl_pct), 2) as avg_pnl
                   FROM agent_accuracy
                   GROUP BY agent_name
                   ORDER BY win_rate DESC"""
            ).fetchall()
            return {row["agent_name"]: dict(row) for row in rows}

    def get_top_agents(self, limit: int = 5) -> List[Dict]:
        """Get top performing agents by win rate."""
        stats = self.get_agent_accuracy_stats()
        sorted_agents = sorted(stats.items(), key=lambda x: x[1].get("win_rate", 0), reverse=True)
        return [{"agent": name, **data} for name, data in sorted_agents[:limit]]

    def cleanup_expired_blocklist(self):
        """Remove expired blocklist entries."""
        now = datetime.now().isoformat()
        with self._conn() as conn:
            result = conn.execute(
                "DELETE FROM blocklist WHERE expires_at < ? AND expires_at IS NOT NULL",
                (now,)
            )
            if result.rowcount > 0:
                logger.info(f"Cleaned up {result.rowcount} expired blocklist entries")


# =============================================================================
# Global singleton
# =============================================================================

_data_access: Optional[DataAccess] = None


def get_data_access() -> DataAccess:
    global _data_access
    if _data_access is None:
        _data_access = DataAccess()
    return _data_access
