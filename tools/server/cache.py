"""TTL + size-bounded in-memory cache for successful fetch results."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass


@dataclass
class _Entry:
    value: object
    stored_at: float
    expires_at: float


class FetchCache:
    """Small thread-safe cache: entries expire after a TTL and the cache
    evicts the oldest entry once ``max_entries`` is exceeded."""

    def __init__(self, ttl_s: float = 300.0, max_entries: int = 256) -> None:
        self.ttl_s = ttl_s
        self.max_entries = max(1, max_entries)
        self._lock = threading.Lock()
        self._data: dict[str, _Entry] = {}

    def get(self, key: str) -> object | None:
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            now = time.monotonic()
            if now > entry.expires_at:
                del self._data[key]
                return None
            return entry.value

    def put(self, key: str, value: object, ttl_s: float | None = None) -> None:
        ttl = self.ttl_s if ttl_s is None else ttl_s
        now = time.monotonic()
        with self._lock:
            self._data[key] = _Entry(value, now, now + ttl)
            expired = [k for k, e in self._data.items() if now > e.expires_at]
            for k in expired:
                del self._data[k]
            while len(self._data) > self.max_entries:
                oldest = min(self._data, key=lambda k: self._data[k].stored_at)
                del self._data[oldest]

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)
