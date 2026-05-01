"""
Analytics DB path resolution helpers.

On Docker Desktop bind mounts, SQLite locking can fail intermittently on host
paths. This helper supports redirecting analytics DB storage to an internal
container volume via ANALYTICS_DB_PATH.
"""

from __future__ import annotations

import logging
import os
import shutil
from typing import List

logger = logging.getLogger(__name__)


def _candidate_seed_paths(default_path: str) -> List[str]:
    explicit_seed = os.getenv("ANALYTICS_DB_BOOTSTRAP_FROM")
    candidates: List[str] = []
    if explicit_seed:
        candidates.append(os.path.abspath(explicit_seed))
    candidates.append(default_path)
    return candidates


def resolve_analytics_db_path() -> str:
    default_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "data", "analytics.db")
    )
    configured_path = os.getenv("ANALYTICS_DB_PATH")
    resolved_path = os.path.abspath(configured_path) if configured_path else default_path

    target_dir = os.path.dirname(resolved_path)
    os.makedirs(target_dir, exist_ok=True)

    if resolved_path != default_path and not os.path.exists(resolved_path):
        for seed_path in _candidate_seed_paths(default_path):
            if not seed_path or seed_path == resolved_path:
                continue
            if not os.path.exists(seed_path):
                continue
            try:
                shutil.copy2(seed_path, resolved_path)
                logger.info(
                    "Bootstrapped analytics DB from %s to %s",
                    seed_path,
                    resolved_path,
                )
                break
            except Exception as exc:
                logger.warning(
                    "Failed to bootstrap analytics DB from %s to %s: %s",
                    seed_path,
                    resolved_path,
                    exc,
                )

    return resolved_path

