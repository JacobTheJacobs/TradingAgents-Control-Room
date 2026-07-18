# Multi-stage Dockerfile for TradingAgents Control Room
# Builds React client + Python backend
#
# Build from repository root:
#   docker build -f Dockerfile -t tradingagents-control-room .
# Or use: docker compose up --build

# ============================================
# Stage 1: Build React Client
# ============================================
FROM node:22-alpine AS client-builder

WORKDIR /app/client

# Copy client package files
COPY v3/react-app/package*.json ./

# Install dependencies
RUN npm config set strict-ssl false \
    && npm install --no-audit --no-fund

# Copy client source
COPY v3/react-app/ ./

# Build the React app (outputs to /app/static/v3)
RUN npm run build

# ============================================
# Stage 2: Python Backend
# ============================================
FROM python:3.11-slim AS backend

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies directly
RUN pip install --no-cache-dir \
    --trusted-host pypi.org \
    --trusted-host files.pythonhosted.org \
    --trusted-host pypi.python.org \
    "fastapi>=0.109.0" \
    "uvicorn[standard]>=0.27.0" \
    "yfinance>=0.2.36" \
    "pydantic>=2.5.0" \
    "pydantic-settings>=2.1.0" \
    "pyyaml>=6.0" \
    "pandas>=2.1.0" \
    "numpy>=1.26.0" \
    "python-dotenv>=1.0.0" \
    "httpx>=0.26.0" \
    "requests>=2.31.0" \
    "aiohttp>=3.9.0" \
    "websockets>=11.0" \
    "asyncpg>=0.29.0" \
    "sqlalchemy[asyncio]>=2.0.0" \
    "alembic>=1.13.0" \
    "psutil>=5.9.0" \
    "python-jose>=3.3.0" \
    "cryptography>=42.0.0" \
    "redis>=5.0.0"

# Copy built static files from client-builder
COPY --from=client-builder /static ./static

# Copy repository source into the Python package directory expected by runtime imports.
COPY . ./src/

# Embedded TradingAgents runtime now executes inside control-room-api,
# so install upstream package dependencies in this image too.
RUN pip install --no-cache-dir --no-build-isolation \
    --trusted-host pypi.org \
    --trusted-host files.pythonhosted.org \
    --trusted-host pypi.python.org \
    -e /app/src/TradingAgents-original

# Expose ports
# 8001 - Backend API (serves React build at /agents/)
EXPOSE 8001

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# Run the backend server
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001"]
