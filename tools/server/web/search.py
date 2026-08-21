"""DuckDuckGo search via ``ddgs``, with an injectable backend for tests.

The default backend lazily imports ``ddgs`` so the rest of the sidecar (and
the smoke test) works without a network or a live search index.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..errors import ToolError

#: (query, max_results) -> list of raw rows (dicts with title/url/snippet-ish keys)
SearchFn = Callable[[str, int], list[dict[str, Any]]]


def _ddgs_search(query: str, max_results: int) -> list[dict[str, Any]]:
    try:
        from ddgs import DDGS
    except ImportError as e:
        raise ToolError(f"the ddgs package is not installed in the sidecar: {e}") from e
    try:
        rows = DDGS().text(query, max_results=max_results)
    except ToolError:
        raise
    except Exception as e:  # ddgs raises assorted errors (rate limit, network, …)
        raise ToolError(f"web search failed: {e}") from e
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise ToolError(f"web search returned an unexpected result: {rows!r}")
    return rows


def normalize_result(row: Any) -> dict[str, str] | None:
    """Normalize a raw search row to ``{title, url, snippet}``.

    Accepts ddgs rows (``title``/``href``/``body``) as well as already-
    normalized rows (``url``/``snippet``). Rows without a usable URL are
    dropped (returns ``None``).
    """
    if not isinstance(row, dict):
        return None
    url = row.get("href") or row.get("url") or row.get("link")
    if not isinstance(url, str) or not url.strip():
        return None
    title = str(row.get("title") or url).strip() or url.strip()
    snippet = str(row.get("body") or row.get("snippet") or row.get("description") or "").strip()
    return {"title": title, "url": url.strip(), "snippet": snippet}


def search(query: str, max_results: int, search_fn: SearchFn | None = None) -> list[dict[str, str]]:
    """Run a web search and return normalized rows (possibly empty)."""
    if not query.strip():
        raise ToolError("query must not be empty")
    max_results = max(1, int(max_results))
    fn = search_fn if search_fn is not None else _ddgs_search
    try:
        rows = fn(query.strip(), max_results)
    except ToolError:
        raise
    except Exception as e:
        raise ToolError(f"web search failed: {e}") from e
    if rows is None:
        rows = []
    if not isinstance(rows, list):
        raise ToolError("search backend returned a non-list")
    results: list[dict[str, str]] = []
    for row in rows[:max_results]:
        normalized = normalize_result(row)
        if normalized is not None:
            results.append(normalized)
    return results
