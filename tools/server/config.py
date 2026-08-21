"""Sidecar configuration: environment -> frozen :class:`Config`.

One process runs one role: ``ROLE=webtools`` (search + fetch, default port
8377) or ``ROLE=filetools`` (workspace files, default port 8378). The full
field set is shared; each role only uses its own subset.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(ValueError):
    """Raised when an environment value is missing or invalid."""


def _int(name: str, dflt: int, minimum: int = 0) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return dflt
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer (got {raw!r})") from None
    if value < minimum:
        raise ConfigError(f"{name} must be >= {minimum} (got {value})")
    return value


def _float(name: str, dflt: float, minimum: float = 0.0) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return dflt
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number (got {raw!r})") from None
    if value < minimum:
        raise ConfigError(f"{name} must be >= {minimum} (got {value})")
    return value


def _bool(name: str, dflt: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return dflt
    raw = raw.strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{name} must be a boolean (got {raw!r})")


@dataclass(frozen=True)
class Config:
    role: str
    host: str
    port: int
    # --- webtools ---------------------------------------------------------
    fetch_timeout_s: float
    fetch_max_bytes: int
    max_redirects: int
    cache_ttl_s: float
    cache_max_entries: int
    search_max_results: int
    browser_enabled: bool
    browser_timeout_ms: int
    browser_concurrency: int
    # --- filetools --------------------------------------------------------
    workspace_dir: str
    read_max_bytes: int
    write_max_bytes: int
    list_max_entries: int
    search_max_results_cap: int
    search_max_files: int
    search_max_file_bytes: int
    line_max_chars: int
    # --- shared -----------------------------------------------------------
    #: Escape hatch for tests only: when true, ssrf.py no longer refuses
    #: loopback/private addresses. Never enable this in production use.
    ssrf_allow_private: bool

    @classmethod
    def from_env(cls) -> "Config":
        role = (os.environ.get("ROLE") or "webtools").strip().lower()
        if role not in ("webtools", "filetools"):
            raise ConfigError(f"ROLE must be 'webtools' or 'filetools' (got {role!r})")
        default_port = 8377 if role == "webtools" else 8378
        return cls(
            role=role,
            host=os.environ.get("HOST", "0.0.0.0"),
            port=_int("PORT", default_port, 1),
            fetch_timeout_s=_float("FETCH_TIMEOUT_S", 30.0, 1.0),
            fetch_max_bytes=_int("FETCH_MAX_BYTES", 5_000_000, 1_024),
            max_redirects=_int("MAX_REDIRECTS", 5, 0),
            cache_ttl_s=_float("CACHE_TTL_S", 300.0, 0.0),
            cache_max_entries=_int("CACHE_MAX_ENTRIES", 256, 1),
            search_max_results=_int("SEARCH_MAX_RESULTS", 10, 1),
            browser_enabled=_bool("BROWSER_ENABLED", True),
            browser_timeout_ms=_int("BROWSER_TIMEOUT_MS", 45_000, 1_000),
            browser_concurrency=_int("BROWSER_CONCURRENCY", 1, 1),
            workspace_dir=os.environ.get("WORKSPACE_DIR", "/workspace"),
            read_max_bytes=_int("READ_MAX_BYTES", 1_000_000, 1_024),
            write_max_bytes=_int("WRITE_MAX_BYTES", 5_000_000, 1_024),
            list_max_entries=_int("LIST_MAX_ENTRIES", 500, 1),
            search_max_results_cap=_int("SEARCH_MAX_RESULTS_CAP", 500, 1),
            search_max_files=_int("SEARCH_MAX_FILES", 10_000, 1),
            search_max_file_bytes=_int("SEARCH_MAX_FILE_BYTES", 5_000_000, 1_024),
            line_max_chars=_int("LINE_MAX_CHARS", 500, 20),
            ssrf_allow_private=_bool("SSRF_ALLOW_PRIVATE", False),
        )
