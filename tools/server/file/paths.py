"""Workspace path confinement for filetools.

Every path the bot sends is treated as *relative to the workspace root*
(leading ``/`` is stripped, so "absolute" paths cannot escape), resolved
with symlinks followed, and then checked to still live inside the workspace.
A symlink pointing outside therefore resolves outside and is rejected.
"""
from __future__ import annotations

from pathlib import Path

from ..errors import ToolError


def workspace_root(workspace: str | Path) -> Path:
    root = Path(workspace).resolve()
    if not root.is_dir():
        raise ToolError(f"workspace directory {root} does not exist or is not a directory")
    return root


def resolve_in_workspace(workspace: str | Path, rel: str | None) -> Path:
    """Resolve *rel* (workspace-relative) to a fully-resolved safe path.

    ``None``/empty means the workspace root itself.
    """
    root = workspace_root(workspace)
    if rel is None:
        return root
    if not isinstance(rel, str):
        raise ToolError("path must be a string")
    cleaned = rel.strip().lstrip("/")
    if cleaned in ("", "."):
        return root
    candidate = root / cleaned
    try:
        resolved = candidate.resolve()
    except OSError as e:
        raise ToolError(f"cannot resolve path {rel!r}: {e}") from e
    if resolved != root and root not in resolved.parents:
        raise ToolError(f"path {rel!r} escapes the workspace")
    return resolved
