# Multi-stage Dockerfile for AI Hedge Fund v5
# Builds React client + Python backend
#
# Build from project root:
#   docker build -f src/Dockerfile -t ai-hedge-fund ..
# Or use: docker-compose up --build

# ============================================
# Stage 1: Build React Client
# ============================================
FROM node:20-alpine AS client-builder

WORKDIR /app/client

# Copy client package files
COPY src/v3/react-app/package*.json ./

# Install dependencies
RUN npm install

# Copy client source
COPY src/v3/react-app/ ./

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
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies directly
RUN pip install --no-cache-dir \
    fastapi>=0.109.0 \
    uvicorn[standard]>=0.27.0 \
    yfinance>=0.2.36 \
    pydantic>=2.5.0 \
    pydantic-settings>=2.1.0 \
    pyyaml>=6.0 \
    pandas>=2.1.0 \
    numpy>=1.26.0 \
    python-dotenv>=1.0.0 \
    httpx>=0.26.0 \
    requests>=2.31.0 \
    aiohttp>=3.9.0 \
    websockets>=11.0 \
    asyncpg>=0.29.0 \
    sqlalchemy[asyncio]>=2.0.0 \
    alembic>=1.13.0 \
    psutil>=5.9.0 \
    python-jose>=3.3.0 \
    redis>=5.0.0

# Copy built static files from client-builder
COPY --from=client-builder /static ./static

# Copy src directory
COPY src/ ./src/

# Expose ports
# 8001 - Backend API (serves React build at /agents/)
EXPOSE 8001

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# Run the backend server
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001"]
