"""Sidecar app factory and entry point.

One process serves one role (``ROLE`` env var):

- ``webtools``  -> ``POST /search``, ``POST /fetch``, ``GET /health`` (:8377)
- ``filetools`` -> ``POST /file/*``, ``GET /health`` (:8378)

Run with ``python -m server.app`` (reads the environment, starts uvicorn).
Tests build the app directly via :func:`create_app` (with an injected
config and/or search backend) and drive it with FastAPI's TestClient.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import Config, ConfigError
from .errors import register_error_handlers


def create_app(
    role: str | None = None,
    cfg: Config | None = None,
    *,
    search_fn=None,
    browser=None,
) -> FastAPI:
    if cfg is None:
        cfg = Config.from_env()
    if role is None:
        role = cfg.role
    if role not in ("webtools", "filetools"):
        raise ConfigError(f"invalid role {role!r} (expected 'webtools' or 'filetools')")

    if role == "webtools":
        from .web.browser import Browser
        from .web.router import build_router as build_web_router

        if browser is None:
            browser = Browser(
                enabled=cfg.browser_enabled,
                timeout_ms=cfg.browser_timeout_ms,
                concurrency=cfg.browser_concurrency,
            )

        @asynccontextmanager
        async def lifespan(app: FastAPI):
            yield
            await browser.close()

        app = FastAPI(title="glove-webtools", version="0.1.0", lifespan=lifespan)
        register_error_handlers(app)

        @app.get("/health")
        async def health():
            return {"ok": True, "role": "webtools"}

        app.include_router(build_web_router(cfg, search_fn=search_fn, browser=browser))
        app.state.browser = browser
    else:
        from .file.router import build_router as build_file_router

        app = FastAPI(title="glove-filetools", version="0.1.0")
        register_error_handlers(app)

        @app.get("/health")
        async def health():
            return {"ok": True, "role": "filetools"}

        app.include_router(build_file_router(cfg))

    return app


def main() -> None:
    import uvicorn

    try:
        cfg = Config.from_env()
    except ConfigError as e:
        raise SystemExit(f"config error: {e}") from e
    uvicorn.run(create_app(cfg=cfg), host=cfg.host, port=cfg.port, log_level="info")


if __name__ == "__main__":
    main()
