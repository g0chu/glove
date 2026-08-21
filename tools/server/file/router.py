"""filetools HTTP API: ``POST /file/{list,read,write,edit,delete,search}``.

Response shapes (consumed by ``src/tools/filetools.ts`` in the bot):

- ``list``   -> ``{"ok", "path", "entries": [{name, type, size?, mtime?}], "truncated"}``
- ``read``   -> ``{"ok", "path", "content", "size", "offset", "bytes_read", "truncated"}``
- ``write``  -> ``{"ok", "path", "bytes_written"}``
- ``edit``   -> ``{"ok", "path", "replacements"}``
- ``delete`` -> ``{"ok", "path", "deleted": "file" | "dir"}``
- ``search`` -> ``{"ok", "matches": [{file, line, text}], "truncated"}``

All paths are confined to the workspace (see ``paths.py``); failures raise
:class:`ToolError` (``400 {"ok": false, "error": ...}``).
"""
from __future__ import annotations

import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import Config
from ..errors import ToolError
from .paths import resolve_in_workspace


class ListPayload(BaseModel):
    path: str | None = None


class ReadPayload(BaseModel):
    path: str
    offset: int = Field(default=0, ge=0)
    limit: int | None = Field(default=None, ge=1)


class WritePayload(BaseModel):
    path: str
    content: str
    create_dirs: bool = False


class EditPayload(BaseModel):
    path: str
    old_text: str
    new_text: str  # may legitimately be "" (deleting a span)
    replace_all: bool = False


class DeletePayload(BaseModel):
    path: str


class SearchPayload(BaseModel):
    pattern: str = Field(min_length=1, max_length=500)
    path: str | None = None
    literal: bool = False
    max_results: int = Field(default=100, ge=1, le=500)


def _iso_mtime(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def build_router(cfg: Config) -> APIRouter:
    router = APIRouter(prefix="/file")
    ws = cfg.workspace_dir

    def _root() -> Path:
        return resolve_in_workspace(ws, None)

    def _rel_display(path: Path, target: Path) -> str:
        try:
            rel = target.relative_to(path)
        except ValueError:
            return ""
        return str(rel) if str(rel) != "." else ""

    @router.post("/list")
    def list_endpoint(payload: ListPayload):
        root = _root()
        target = resolve_in_workspace(ws, payload.path)
        if not target.is_dir():
            raise ToolError(f"not a directory: {payload.path or '.'}")
        children = sorted(
            target.iterdir(),
            key=lambda c: (0 if c.is_dir() else 1, c.name.lower()),
        )
        truncated = len(children) > cfg.list_max_entries
        entries = []
        for child in children[: cfg.list_max_entries]:
            try:
                st = child.stat()
            except OSError:
                continue
            if child.is_dir():
                entries.append({"name": child.name, "type": "dir"})
            else:
                entries.append(
                    {
                        "name": child.name,
                        "type": "file",
                        "size": st.st_size,
                        "mtime": _iso_mtime(st.st_mtime),
                    }
                )
        return {
            "ok": True,
            "path": _rel_display(root, target) or ".",
            "entries": entries,
            "truncated": truncated,
        }

    @router.post("/read")
    def read_endpoint(payload: ReadPayload):
        target = resolve_in_workspace(ws, payload.path)
        if not target.is_file():
            raise ToolError(f"not a file: {payload.path}")
        size = target.stat().st_size
        if payload.offset > size:
            raise ToolError(f"offset {payload.offset} is past the end of the file ({size} bytes)")
        limit = cfg.read_max_bytes if payload.limit is None else min(payload.limit, cfg.read_max_bytes)
        with target.open("rb") as f:
            if b"\x00" in f.read(8192):
                raise ToolError(f"file {payload.path} looks binary; refusing to return it as text")
            f.seek(payload.offset)
            data = f.read(limit)
        truncated = payload.offset + len(data) < size
        return {
            "ok": True,
            "path": payload.path,
            "content": data.decode("utf-8", errors="replace"),
            "size": size,
            "offset": payload.offset,
            "bytes_read": len(data),
            "truncated": truncated,
        }

    @router.post("/write")
    def write_endpoint(payload: WritePayload):
        encoded = payload.content.encode("utf-8")
        if len(encoded) > cfg.write_max_bytes:
            raise ToolError(f"content is larger than the write cap ({cfg.write_max_bytes} bytes)")
        target = resolve_in_workspace(ws, payload.path)
        if target.is_dir():
            raise ToolError(f"cannot overwrite a directory: {payload.path}")
        parent = target.parent
        if not parent.exists():
            if not payload.create_dirs:
                raise ToolError(
                    f"parent directory of {payload.path} does not exist (use create_dirs=true to create it)"
                )
            parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(encoded)
        return {"ok": True, "path": payload.path, "bytes_written": len(encoded)}

    @router.post("/edit")
    def edit_endpoint(payload: EditPayload):
        target = resolve_in_workspace(ws, payload.path)
        if not target.is_file():
            raise ToolError(f"not a file: {payload.path}")
        try:
            text = target.read_text(encoding="utf-8")
        except UnicodeDecodeError as e:
            raise ToolError(f"file {payload.path} is not valid UTF-8 text; refusing to edit it") from e
        if payload.old_text == "":
            raise ToolError("old_text must not be empty")
        occurrences = text.count(payload.old_text)
        if occurrences == 0:
            raise ToolError("old_text not found in the file (it must match exactly, whitespace included)")
        if payload.replace_all:
            updated = text.replace(payload.old_text, payload.new_text)
            replacements = occurrences
        else:
            updated = text.replace(payload.old_text, payload.new_text, 1)
            replacements = 1
        target.write_text(updated, encoding="utf-8")
        return {"ok": True, "path": payload.path, "replacements": replacements}

    @router.post("/delete")
    def delete_endpoint(payload: DeletePayload):
        root = _root()
        target = resolve_in_workspace(ws, payload.path)
        if target == root:
            raise ToolError("refusing to delete the workspace root")
        if not target.exists():
            raise ToolError(f"not found: {payload.path}")
        if target.is_dir():
            shutil.rmtree(target)
            deleted = "dir"
        else:
            target.unlink()
            deleted = "file"
        return {"ok": True, "path": payload.path, "deleted": deleted}

    @router.post("/search")
    def search_endpoint(payload: SearchPayload):
        root = _root()
        base = resolve_in_workspace(ws, payload.path)
        if not base.is_dir():
            raise ToolError(f"not a directory: {payload.path or '.'}")
        if payload.literal:
            def match(line: str) -> bool:
                return payload.pattern in line
        else:
            try:
                regex = re.compile(payload.pattern)
            except re.error as e:
                raise ToolError(f"invalid regular expression {payload.pattern!r}: {e}") from e

            def match(line: str) -> bool:
                return regex.search(line) is not None

        limit = min(payload.max_results, cfg.search_max_results_cap)
        matches: list[dict] = []
        truncated = False
        files_scanned = 0
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames.sort()
            for name in sorted(filenames):
                if files_scanned >= cfg.search_max_files:
                    truncated = True
                    break
                fp = Path(dirpath) / name
                files_scanned += 1
                try:
                    if fp.is_symlink() or fp.stat().st_size > cfg.search_max_file_bytes:
                        continue
                    with fp.open("r", encoding="utf-8") as f:
                        if "\x00" in f.read(8192):
                            continue  # binary
                        f.seek(0)
                        for lineno, line in enumerate(f, 1):
                            if match(line):
                                matches.append(
                                    {
                                        "file": fp.relative_to(root).as_posix(),
                                        "line": lineno,
                                        "text": line.strip()[: cfg.line_max_chars],
                                    }
                                )
                                if len(matches) >= limit:
                                    truncated = True
                                    break
                except (OSError, UnicodeDecodeError):
                    continue  # unreadable / binary / vanished file
                if truncated:
                    break
            if truncated:
                break
        return {"ok": True, "matches": matches, "truncated": truncated}

    return router
