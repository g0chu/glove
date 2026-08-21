"""webtools HTTP API: ``POST /search`` and ``POST /fetch``.

Response shapes (consumed by ``src/tools/webtools.ts`` in the bot):

- ``/search`` -> ``{"ok": true, "results": [{title, url, snippet}, ...]}``
- ``/fetch``  -> ``{"ok": true, "title", "content", "final_url", "method", "truncated"}``

Failures raise :class:`ToolError`, which ``server.errors`` renders as
``400 {"ok": false, "error": ...}``.
"""
from __future__ import annotations

import anyio
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..cache import FetchCache
from ..config import Config
from ..errors import ToolError
from ..fetcher import fetch
from ..ssrf import resolve_url
from .browser import Browser
from .extract import extract_content, extract_title
from .search import SearchFn, search as search_backend


class SearchPayload(BaseModel):
    query: str = Field(min_length=1, max_length=400)
    max_results: int = Field(default=5, ge=1, le=10)


class FetchPayload(BaseModel):
    url: str = Field(min_length=3, max_length=2048)


def build_router(cfg: Config, *, search_fn: SearchFn | None = None, browser: Browser | None = None) -> APIRouter:
    router = APIRouter()
    cache = FetchCache(ttl_s=cfg.cache_ttl_s, max_entries=cfg.cache_max_entries)
    if browser is None:
        browser = Browser(
            enabled=cfg.browser_enabled,
            timeout_ms=cfg.browser_timeout_ms,
            concurrency=cfg.browser_concurrency,
        )

    @router.post("/search")
    async def search_endpoint(payload: SearchPayload):
        limit = min(payload.max_results, cfg.search_max_results)
        results = await anyio.to_thread.run_sync(search_backend, payload.query, limit, search_fn)
        return {"ok": True, "results": results}

    @router.post("/fetch")
    async def fetch_endpoint(payload: FetchPayload):
        url = payload.url.strip()
        # Validate before anything else. This also pre-validates the URL for
        # the browser path (the browser cannot pin DNS — see browser.py).
        resolve_url(url, allow_private=cfg.ssrf_allow_private)

        cached = cache.get(url)
        if cached is not None:
            return cached

        http_error: ToolError | None = None
        result: dict | None = None
        try:
            fetched = await anyio.to_thread.run_sync(
                lambda: fetch(
                    url,
                    timeout_s=cfg.fetch_timeout_s,
                    max_bytes=cfg.fetch_max_bytes,
                    max_redirects=cfg.max_redirects,
                    allow_private=cfg.ssrf_allow_private,
                )
            )
            html_text = fetched.body.decode("utf-8", errors="replace")
            content = extract_content(html_text, fetched.final_url)
            if not content:
                raise ToolError("plain HTTP fetch succeeded but the page has no extractable content")
            result = {
                "ok": True,
                "title": extract_title(html_text),
                "content": content,
                "final_url": fetched.final_url,
                "method": "http",
                "truncated": fetched.truncated,
            }
        except ToolError as e:
            http_error = e

        if result is None:
            # Fallback: render in headless Chromium (JS-heavy pages, pages
            # that block plain HTTP clients, or empty plain-HTML pages).
            try:
                title, html_text = await browser.fetch(url)
            except ToolError as browser_error:
                raise http_error if http_error is not None else browser_error
            content = extract_content(html_text, url)
            if not content:
                raise http_error if http_error is not None else ToolError("page has no extractable content")
            result = {
                "ok": True,
                "title": title,
                "content": content,
                "final_url": url,
                "method": "browser",
                "truncated": False,
            }

        cache.put(url, result)
        return result

    return router
