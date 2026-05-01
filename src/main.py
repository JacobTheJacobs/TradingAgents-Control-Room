"""
AI Hedge Fund v5 - Main Entry Point
"""
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from contextlib import asynccontextmanager
import logging
import signal
import threading

try:
    from src.api.step_dialogue import router as step_dialogue_router
except Exception as step_dialogue_import_error:
    step_dialogue_router = None
    print(f"Warning: Could not import step_dialogue router: {step_dialogue_import_error}")

try:
    from src.api.trading_floor_simple import router as trading_floor_router
    trading_floor_runtime_available = True
except Exception as trading_floor_import_error:
    trading_floor_router = None
    trading_floor_runtime_available = False
    print(f"Warning: Could not import trading_floor_simple router: {trading_floor_import_error}")
    try:
        from src.api.trading_floor_compat import router as trading_floor_compat_router
        trading_floor_router = trading_floor_compat_router
        print("Warning: Using trading_floor_compat router")
    except Exception as compat_import_error:
        print(f"Error: Could not import trading_floor_compat router: {compat_import_error}")

try:
    from src.api.admin_routes import router as admin_router
    admin_runtime_available = True
except Exception as admin_import_error:
    admin_router = None
    admin_runtime_available = False
    print(f"Warning: Could not import admin_routes router: {admin_import_error}")
    try:
        from src.api.admin_compat import router as admin_compat_router
        admin_router = admin_compat_router
        print("Warning: Using admin_compat router")
    except Exception as admin_compat_import_error:
        print(f"Error: Could not import admin_compat router: {admin_compat_import_error}")

# Add finance_db_api to path for shared modules
import sys
import os
sys.path.append(os.path.join(os.getcwd(), "finance_db_api"))

# Import LLM router from finance_db_api
try:
    from finance_db_api.llm.routes import router as llm_router
except ImportError:
    # Fallback if structure differs or during transition
    llm_router = None
    print("Warning: Could not import llm_router from finance_db_api")


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _supported_shutdown_signals():
    signals = []
    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            signals.append(sig)
    return signals


def _install_shutdown_signal_logging(app: FastAPI):
    if getattr(app.state, "_shutdown_signal_logging_installed", False):
        return
    if threading.current_thread() is not threading.main_thread():
        logger.warning("⚠️ Shutdown signal logging skipped outside the main thread")
        return

    app.state.shutdown_signal = None
    app.state.shutdown_origin = "internal_or_host"
    app.state._previous_shutdown_signal_handlers = {}
    detached_mode = os.getenv("BACKEND_8001_MODE") == "detached"
    sigint = getattr(signal, "SIGINT", None)

    for sig in _supported_shutdown_signals():
        if detached_mode and sigint is not None and sig == sigint:
            # Detached launcher intentionally ignores SIGINT to avoid accidental
            # console interrupts taking down long-running pipelines.
            continue

        previous_handler = signal.getsignal(sig)

        def _handler(signum, frame, *, _previous=previous_handler):
            try:
                signal_name = signal.Signals(signum).name
            except Exception:
                signal_name = str(signum)
            app.state.shutdown_signal = signal_name
            app.state.shutdown_origin = "external_signal"
            logger.warning("🛑 Shutdown signal received: %s", signal_name)

            if callable(_previous):
                return _previous(signum, frame)
            if _previous == signal.default_int_handler:
                return _previous(signum, frame)
            if _previous == signal.SIG_DFL:
                if signum == getattr(signal, "SIGINT", None):
                    raise KeyboardInterrupt()
                raise SystemExit(0)
            return None

        signal.signal(sig, _handler)
        app.state._previous_shutdown_signal_handlers[sig] = previous_handler

    app.state._shutdown_signal_logging_installed = True


def _restore_shutdown_signal_logging(app: FastAPI):
    handlers = getattr(app.state, "_previous_shutdown_signal_handlers", {})
    for sig, previous in handlers.items():
        try:
            signal.signal(sig, previous)
        except Exception:
            pass
    app.state._previous_shutdown_signal_handlers = {}
    app.state._shutdown_signal_logging_installed = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    logger.info("🚀 AI Hedge Fund v5 starting up...")
    logger.info("🎯 Goal: Beat the S&P 500")
    _install_shutdown_signal_logging(app)

    # Initialize Global Proxy for TradingAgents Observability
    # Observability logic was removed as the handlers are missing from src.api.trading_floor_simple
    logger.info("📡 Observability attached (minimal mode)")
    
    from dotenv import load_dotenv
    # Load from root .env first, then finance_db_api/.env
    root_env = Path(".env")
    if root_env.exists():
        load_dotenv(root_env)
    env_path = Path("finance_db_api/.env")
    if env_path.exists():
        load_dotenv(env_path)
    # Also load .env.local for INTERNAL_API_KEY
    env_local = Path("finance_db_api/.env.local")
    if env_local.exists():
        load_dotenv(env_local)
    
    # Start Redis listener for trading floor events (if trading floor backend is present)
    import asyncio
    listener_task = None
    if trading_floor_runtime_available:
        try:
            from src.api.trading_floor_simple import start_redis_listener
            listener_task = asyncio.create_task(start_redis_listener())
        except Exception as exc:
            logger.warning("⚠️ Redis listener startup skipped: %s", exc)
    
    # Start Stage Manager (headline + script streaming)
    if trading_floor_runtime_available:
        try:
            from src.llm.stage_manager import get_stage_manager
            from src.api.trading_floor_simple import manager, portfolio_state, pipeline_state
            stage_manager = get_stage_manager(manager.broadcast)
            stage_manager.set_portfolio_getter(lambda: portfolio_state)
            stage_manager.set_has_clients_fn(lambda: len(manager.active_connections) > 0)
            stage_manager.set_pipeline_getter(lambda: pipeline_state)
            if stage_manager.get_settings().get("autoStart", True):
                await stage_manager.start()
                logger.info("🎬 Stage manager started")
            else:
                logger.info("🎬 Stage manager autoStart disabled")
        except Exception as e:
            logger.warning(f"⚠️ Stage manager failed to start: {e}")

    # Portfolio sync is handled by PortfolioManager._load_positions_from_db() below
    logger.info("💰 Portfolio management active")
    
    # Load saved state on startup for 24/7 operation
    if trading_floor_runtime_available:
        try:
            from src.analytics.data_access import get_data_access
            from src.api.trading_floor_simple import portfolio_manager
            
            # 1. First, load from SQLite (The Source of Truth)
            data_access = get_data_access()
            
            # 2. Synchronize PortfolioManager and UI state
            # (trading_floor_simple calls _load_portfolio_from_sqlite on import)
            logger.info("✅ Portfolio synchronized from SQLite")
            
            # 2. Synchronize PortfolioManager
            portfolio_manager._load_positions_from_db()
            
            # All state now comes from SQLite (no JSON fallback)
            logger.info("✅ All state loaded from SQLite database")
        except Exception as e:
            logger.warning(f"⚠️ Could not load state on startup: {e}")
    
    # Don't auto-start trading - user picks mode from landing page
    # The /trading-floor/mode/automatic endpoint will start it when chosen
    logger.info("Waiting for user to select trading mode from dashboard...")

    yield

    shutdown_signal = getattr(app.state, "shutdown_signal", None)
    if shutdown_signal:
        logger.warning("🧭 Shutdown cause resolved: external signal (%s)", shutdown_signal)
    else:
        logger.warning("🧭 Shutdown cause unresolved by signal handlers; treating as internal or host-driven lifecycle stop.")

    if admin_runtime_available:
        try:
            from src.api.admin_routes import shutdown_active_trading_agents
            await shutdown_active_trading_agents()
        except Exception as exc:
            logger.warning("⚠️ TradingAgents shutdown hook failed: %s", exc)

    # Cancel background tasks
    if listener_task is not None:
        listener_task.cancel()
        try:
            await asyncio.gather(listener_task, return_exceptions=True)
        except Exception:
            pass

    # Stop stage manager
    try:
        from src.llm.stage_manager import get_stage_manager
        stage_manager = get_stage_manager()
        await stage_manager.stop()
    except Exception:
        pass

    # Stop autonomous trading if running
    logger.info("Stopping autonomous trading...")
    if trading_floor_runtime_available:
        try:
            from src.runtime.automation import autonomous_trader
            autonomous_trader.stop()
        except Exception:
            pass

        try:
            from src.runtime.redis_client import close_redis
            await close_redis()
        except Exception:
            pass
    
    # Save state on shutdown
    logger.info("💾 Saving state to database before shutdown...")
    if trading_floor_runtime_available:
        try:
            from src.api.trading_floor_simple import portfolio_state
            from src.analytics.data_access import get_data_access
            data_access = get_data_access()
            await data_access.save_portfolio_state({
                "total_value": float(portfolio_state.get("total_value", 0)),
                "cash": float(portfolio_state.get("cash", 0)),
                "daily_pnl": float(portfolio_state.get("daily_pnl", 0)),
                "spy_benchmark": float(portfolio_state.get("spy_benchmark", 0)),
                "performance_vs_spy": float(portfolio_state.get("performance_vs_spy", 0)),
            })
            logger.info("✅ State saved to database")
        except Exception as e:
            logger.warning(f"⚠️ Could not save state on shutdown: {e}")
    
    logger.info("👋 AI Hedge Fund v5 shutting down...")
    _restore_shutdown_signal_logging(app)


app = FastAPI(
    title="AI Hedge Fund v5",
    description="Beat the S&P 500 with Psychological Voice Agents",
    version="5.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if trading_floor_router is not None:
    app.include_router(trading_floor_router, prefix="/trading-floor")


# Include admin routes (God Mode control panel)
if admin_router is not None:
    app.include_router(admin_router, prefix="/api")

# Include step dialogue under /api/admin to centralize management
if step_dialogue_router is not None:
    app.include_router(step_dialogue_router, prefix="/api/admin")

# Include LLM router if available
if llm_router:
    app.include_router(llm_router)


# Serve static files (gossip_quotes.json for React app)

@app.get("/gossip_quotes.json")
@app.get("/static/gossip_quotes.json")
async def get_gossip_quotes():
    """Serve gossip_quotes from DB for frontend compatibility."""
    try:
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        return da.get_config("gossip_quotes") or {}
    except Exception:
        return {}


@app.get("/providers_config.json")
@app.get("/static/providers_config.json")
async def get_providers_config():
    """Serve providers_config from DB."""
    try:
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        return da.get_config("providers_config") or {}
    except Exception:
        return {}


@app.get("/recipes.json")
@app.get("/static/recipes.json")
async def get_recipes_config():
    """Serve recipes from DB."""
    try:
        from src.analytics.data_access import get_data_access
        da = get_data_access()
        return da.get_config("recipes") or {}
    except Exception:
        return {}

LEGACY_STATIC_DIR = Path("frontend")
STATIC_MOUNT_DIR = LEGACY_STATIC_DIR if LEGACY_STATIC_DIR.exists() else Path("static")
app.mount("/static", StaticFiles(directory=str(STATIC_MOUNT_DIR)), name="static")

# React V3 App (Mission Control dashboard)
V3_BUILD_DIR = Path("static/v3")

@app.get("/agents/")
async def agents_app():
    """Serve the React V3 Agent Dashboard"""
    index_path = V3_BUILD_DIR / "index.html"
    print(f"CWD is {Path.cwd()}")
    print(f"Checking index_path: {index_path.absolute()} (Exists: {index_path.exists()})")
    if index_path.exists():
        return FileResponse(index_path)
    return {"error": f"V3 app not built. Checked path: {index_path.absolute()} (Exists: {index_path.exists()})"}

@app.get("/agents/{path:path}")
async def agents_static(path: str):
    """Serve V3 React static assets"""
    file_path = V3_BUILD_DIR / path
    if file_path.exists():
        return FileResponse(file_path)
    # Fallback to index.html for client-side routing
    index_path = V3_BUILD_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {"error": "File not found"}






@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "version": "5.0.0",
        "goal": "Beat the S&P 500",
    }
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)

# Reload trigger
