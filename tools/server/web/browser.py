"""Headless-Chromium fallback for JavaScript-heavy or empty pages.

Playwright (async API) is used from the FastAPI event loop. Chromium runs
with ``--no-sandbox`` (containerized, non-root) and is bounded by a
concurrency semaphore.

Important: Chromium resolves DNS itself, so the fetcher's pinned-socket
SSRF protection does not apply to the browser path. URLs are therefore
pre-validated with :func:`server.ssrf.resolve_url` before being handed
here — a documented residual risk, fine for a single-user bot.
"""
from __future__ import annotations

import asyncio

from ..errors import ToolError

_CHROMIUM_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]


class Browser:
    def __init__(self, enabled: bool = True, timeout_ms: int = 45_000, concurrency: int = 1) -> None:
        self.enabled = enabled
        self.timeout_ms = timeout_ms
        self._sem = asyncio.Semaphore(max(1, concurrency))
        self._pw = None
        self._browser = None
        self._lock = asyncio.Lock()

    async def _ensure(self) -> None:
        async with self._lock:
            if self._browser is not None:
                return
            try:
                from playwright.async_api import async_playwright
            except ImportError as e:
                raise ToolError(f"playwright is not available in the sidecar: {e}") from e
            pw = await async_playwright().start()
            try:
                self._browser = await pw.chromium.launch(headless=True, args=_CHROMIUM_ARGS)
            except Exception as e:
                await pw.stop()
                raise ToolError(f"could not launch headless chromium: {e}") from e
            self._pw = pw

    async def fetch(self, url: str) -> tuple[str, str]:
        """Load *url* and return ``(title, rendered_html)``.

        Raises :class:`ToolError` when the browser is disabled, unavailable,
        or the page fails to load within the timeout.
        """
        if not self.enabled:
            raise ToolError("browser fallback is disabled")
        async with self._sem:
            await self._ensure()
            assert self._browser is not None
            page = await self._browser.new_page()
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=self.timeout_ms)
                try:
                    await page.wait_for_load_state("networkidle", timeout=min(5_000, self.timeout_ms))
                except Exception:
                    pass  # slow/idle pages: proceed with what rendered
                title = await page.title()
                html_text = await page.content()
                return title or "", html_text
            except ToolError:
                raise
            except Exception as e:
                raise ToolError(f"browser fetch of {url} failed: {e}") from e
            finally:
                await page.close()

    async def close(self) -> None:
        async with self._lock:
            if self._browser is not None:
                try:
                    await self._browser.close()
                except Exception:
                    pass
                self._browser = None
            if self._pw is not None:
                try:
                    await self._pw.stop()
                except Exception:
                    pass
                self._pw = None
