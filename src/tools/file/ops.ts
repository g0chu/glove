/**
 * File operations for the in-process file tools.
 *
 * Port of the filetools sidecar router (removed): same semantics —
 * workspace confinement (see paths.ts), read windows, binary refusal,
 * exact-span edits, and the per-operation caps. Failures are thrown as
 * ToolError with the same lowercase, human-readable messages the model
 * used to see through the sidecar's 400 responses.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../web/ssrf.js";
import { resolveInWorkspace } from "./paths.js";

/** Per-operation caps (from config; keep them close to the sidecar defaults). */
export interface FileOpsOptions {
  readMaxBytes: number;
  writeMaxBytes: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Non-overlapping occurrence count (str.count semantics). */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Replace the first occurrence only (str.replace(old, new, 1) semantics). */
function replaceFirst(haystack: string, oldText: string, newText: string): string {
  const i = haystack.indexOf(oldText);
  return haystack.slice(0, i) + newText + haystack.slice(i + oldText.length);
}

/** Decode a buffer as strict UTF-8; raises on invalid sequences. */
function utf8Fatal(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}

/** Read a text file window (bytes) with a hard cap and binary refusal. */
export async function readFile(
  workspace: string,
  rel: string,
  offset: number,
  limit: number | undefined,
  readMaxBytes: number,
): Promise<{ path: string; content: string; size: number; offset: number; bytesRead: number; truncated: boolean }> {
  const target = resolveInWorkspace(workspace, rel);
  let st;
  try {
    st = await fs.stat(target);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) throw new ToolError(`not a file: ${rel}`);
  const size = st.size;
  if (offset > size) {
    throw new ToolError(`offset ${offset} is past the end of the file (${size} bytes)`);
  }
  const want = limit === undefined ? readMaxBytes : Math.min(limit, readMaxBytes);
  const fh = await fs.open(target, "r");
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead: headBytes } = await fh.read(head, 0, 8192, 0);
    if (head.subarray(0, headBytes).includes(0)) {
      throw new ToolError(`file ${rel} looks binary; refusing to return it as text`);
    }
    const data = Buffer.alloc(want);
    const { bytesRead: n } = await fh.read(data, 0, want, offset);
    return {
      path: rel,
      content: data.subarray(0, n).toString("utf8"),
      size,
      offset,
      bytesRead: n,
      truncated: offset + n < size,
    };
  } finally {
    await fh.close();
  }
}

/** Create or overwrite a file (with an optional parent-dir creation). */
export async function writeFile(
  workspace: string,
  rel: string,
  content: string,
  createDirs: boolean,
  writeMaxBytes: number,
): Promise<{ path: string; bytesWritten: number }> {
  const encoded = Buffer.from(content, "utf8");
  if (encoded.length > writeMaxBytes) {
    throw new ToolError(`content is larger than the write cap (${writeMaxBytes} bytes)`);
  }
  const target = resolveInWorkspace(workspace, rel);
  let st;
  try {
    st = await fs.stat(target);
  } catch {
    st = null; // missing target: fine, we are creating it
  }
  if (st && st.isDirectory()) throw new ToolError(`cannot overwrite a directory: ${rel}`);
  const parent = path.dirname(target);
  try {
    await fs.access(parent);
  } catch {
    if (!createDirs) {
      throw new ToolError(`parent directory of ${rel} does not exist (use create_dirs=true to create it)`);
    }
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch (err) {
      throw new ToolError(`cannot create parent directory of ${rel}: ${errMsg(err)}`);
    }
  }
  await fs.writeFile(target, encoded);
  return { path: rel, bytesWritten: encoded.length };
}

/**
 * Replace an exact text span in a file (first occurrence, or all of them).
 * The read is size-capped (an uncapped read of a large workspace file would
 * be an uncatchable OOM) and the result by the write cap, like the other
 * operations.
 */
export async function editFile(
  workspace: string,
  rel: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  readMaxBytes: number,
  writeMaxBytes: number,
): Promise<{ path: string; replacements: number }> {
  const target = resolveInWorkspace(workspace, rel);
  let st;
  try {
    st = await fs.stat(target);
  } catch {
    throw new ToolError(`not a file: ${rel}`);
  }
  if (st.size > readMaxBytes) {
    throw new ToolError(`file ${rel} is too large to edit (${st.size} bytes, cap ${readMaxBytes})`);
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(target);
  } catch {
    throw new ToolError(`not a file: ${rel}`);
  }
  let text: string;
  try {
    text = utf8Fatal(buf);
  } catch {
    throw new ToolError(`file ${rel} is not valid UTF-8 text; refusing to edit it`);
  }
  if (oldText === "") throw new ToolError("old_text must not be empty");
  const occurrences = countOccurrences(text, oldText);
  if (occurrences === 0) {
    throw new ToolError("old_text not found in the file (it must match exactly, whitespace included)");
  }
  const updated = replaceAll ? text.split(oldText).join(newText) : replaceFirst(text, oldText, newText);
  const encoded = Buffer.from(updated, "utf8");
  if (encoded.length > writeMaxBytes) {
    throw new ToolError(`the edited content is larger than the write cap (${writeMaxBytes} bytes)`);
  }
  await fs.writeFile(target, encoded);
  return { path: rel, replacements: replaceAll ? occurrences : 1 };
}
