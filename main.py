"""
TradingAgents Control Room - Main Entry Point
"""
from pathlib import Path
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from contextlib import asynccontextmanager
import logging
import signal
import threading


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def _repo_path(*parts: str) -> Path:
    return Path(__file__).resolve().parents[1].joinpath(*parts)


finance_db_api_package_available = _repo_path("..", "finance_db_api", "llm", "routes.py").resolve().exists()

# The TA-only strict runtime is the only supported path in this build; the legacy
# autonomous runtime was removed. TA_ONLY_STRICT_RUNTIME is honoured no longer.
if os.getenv("TA_ONLY_STRICT_RUNTIME", "1").strip().lower() not in {"1", "true", "yes", "on"}:
    logger.warning("TA-only strict runtime is permanently enabled in this build; ignoring TA_ONLY_STRICT_RUNTIME.")

try:
    from src.api.step_dialogue import router as step_dialogue_router
except Exception as step_dialogue_import_error:
    step_dialogue_router = None
    print(f"Warning: Could not import step_dialogue router: {step_dialogue_import_error}")

trading_floor_router = None
logger.info("TA-only strict runtime enabled; forcing trading_floor_compat router.")
try:
    from src.api.trading_floor_compat import router as trading_floor_compat_router
    trading_floor_router = trading_floor_compat_router
    logger.info("Using trading_floor_compat router.")
except Exception as compat_import_error:
    logger.error("Could not import trading_floor_compat router: %s", compat_import_error)

admin_router = None
logger.info("TA-only strict runtime enabled; forcing admin_compat router.")
try:
    from src.api.admin_compat import router as admin_compat_router
    admin_router = admin_compat_router
    logger.info("Using admin_compat router.")
except Exception as admin_compat_import_error:
    logger.error("Could not import admin_compat router: %s", admin_compat_import_error)

# Add finance_db_api to path for shared modules
import sys
import os
sys.path.append(os.path.join(os.getcwd(), "finance_db_api"))

# Import LLM router from finance_db_api
try:
    if not finance_db_api_package_available:
        raise ModuleNotFoundError("finance_db_api.llm.routes")
    from finance_db_api.llm.routes import router as llm_router
except ImportError:
    llm_router = None
    logger.info("finance_db_api LLM router unavailable; skipping optional LLM endpoints.")


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
    logger.info("🚀 TradingAgents Control Room starting up...")
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

    # Don't auto-start trading - user picks mode from landing page
    # The /trading-floor/mode/automatic endpoint will start it when chosen
    logger.info("Waiting for user to select trading mode from dashboard...")

    yield

    shutdown_signal = getattr(app.state, "shutdown_signal", None)
    if shutdown_signal:
        logger.warning("🧭 Shutdown cause resolved: external signal (%s)", shutdown_signal)
    else:
        logger.warning("🧭 Shutdown cause unresolved by signal handlers; treating as internal or host-driven lifecycle stop.")

    # Stop stage manager
    try:
        from src.llm.stage_manager import get_stage_manager
        stage_manager = get_stage_manager()
        await stage_manager.stop()
    except Exception:
        pass
    
    logger.info("👋 TradingAgents Control Room shutting down...")
    _restore_shutdown_signal_logging(app)


app = FastAPI(
    title="TradingAgents Control Room",
    description="Visual observability UI for TradingAgents workflows.",
    version="5.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)

# Local-only dev server: no authentication is enforced on any route. Do not
# expose this process to an untrusted network. Origins are restricted to the
# local control room; `allow_credentials` with a wildcard origin is rejected by
# browsers anyway, so the wildcard is not a usable default.
_default_cors_origins = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8001,http://127.0.0.1:8001"
CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", _default_cors_origins).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
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
    """TA-only runtime: legacy gossip quotes config removed."""
    return {}


@app.get("/providers_config.json")
@app.get("/static/providers_config.json")
async def get_providers_config():
    """TA-only runtime: legacy providers config removed."""
    return {}


@app.get("/recipes.json")
@app.get("/static/recipes.json")
async def get_recipes_config():
    """TA-only runtime: legacy recipes config removed."""
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
    if index_path.exists():
        return FileResponse(index_path)
    logger.error("V3 app not built; expected index at %s", index_path.absolute())
    return {"error": "V3 app not built. Run the frontend build, or use the Vite dev server on :3000."}

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
        "service": "TradingAgents Control Room",
    }
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
