"""Tiny in-process cache for computed payloads.

Every write path (plan edits, mapping changes, demo reset) calls invalidate(), so cached
results never go stale. Horizon runs as a single process, so a dict is enough.
"""
from __future__ import annotations

import threading
from typing import Any, Callable

_lock = threading.Lock()
_store: dict[str, Any] = {}


def cached(key: str, compute: Callable[[], Any]) -> Any:
    with _lock:
        if key in _store:
            return _store[key]
    value = compute()
    with _lock:
        _store[key] = value
    return value


def invalidate() -> None:
    with _lock:
        _store.clear()
