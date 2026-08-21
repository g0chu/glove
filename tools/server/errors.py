"""Shared error type and the FastAPI handlers that shape its responses.

The bot's TS clients treat every non-2xx with a JSON ``error`` field as a
tool error and hand the message to the model, so all failures in both
sidecars raise :class:`ToolError` and are rendered as::

    400  {"ok": false, "error": "<message>"}
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ToolError(Exception):
    """A user-facing tool failure; the message goes back to the model."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def __str__(self) -> str:
        return self.message


def _error_json(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"ok": False, "error": message})


def register_error_handlers(app: FastAPI) -> None:
    """Map ToolError (and malformed request bodies) to the 400 shape above."""

    @app.exception_handler(ToolError)
    async def _tool_error(request: Request, exc: ToolError) -> JSONResponse:  # noqa: ARG001
        return _error_json(exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:  # noqa: ARG001
        parts = []
        for e in exc.errors()[:5]:
            loc = ".".join(str(x) for x in e.get("loc", []) if str(x) != "body")
            parts.append(f"{loc}: {e.get('msg', 'invalid')}" if loc else str(e.get("msg", "invalid")))
        return _error_json("invalid request: " + "; ".join(parts))
