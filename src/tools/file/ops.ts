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
import type { Dirent } from "node:fs";
import path from "node:path";
import { ToolError } from "../web/ssrf.js";
import { resolveInWorkspace, workspaceRoot } from "./paths.js";

/** Per-operation caps (from config; keep them close to the sidecar defaults). */
export interface FileOpsOptions {
  readMaxBytes: number;
  writeMaxBytes: number;
  listMaxEntries: number;
  searchMaxResults: number;
  searchMaxFiles: number;
  searchMaxFileBytes: number;
  lineMaxChars: number;
}

export interface ListEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
  mtime?: string;
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

/** "YYYY-MM-DD HH:MM:SS UTC" for a unix-ms timestamp (matches the old sidecar). */
function isoMtime(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
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

/** Case-insensitive-lexicographic compare without locale dependence. */
function byLower(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}

/** List a directory; entries sorted dirs-first, then by name (case-folded). */
export async function listFiles(
  workspace: string,
  rel: string | undefined,
  maxEntries: number,
): Promise<{ path: string; entries: ListEntry[]; truncated: boolean }> {
  const root = workspaceRoot(workspace);
  const target = resolveInWorkspace(workspace, rel);
  let st;
  try {
    st = await fs.stat(target);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw new ToolError(`not a directory: ${rel ?? "."}`);

  let names: string[];
  try {
    names = await fs.readdir(target);
  } catch (err) {
    throw new ToolError(`cannot list ${rel ?? "."}: ${errMsg(err)}`);
  }
  const dirNames: string[] = [];
  const entries: ListEntry[] = [];
  for (const name of names) {
    let cst;
    try {
      cst = await fs.stat(path.join(target, name));
    } catch {
      continue; // vanished or unreadable entry
    }
    if (cst.isDirectory()) dirNames.push(name);
    else entries.push({ name, type: "file", size: cst.size, mtime: isoMtime(cst.mtimeMs) });
  }
  dirNames.sort(byLower);
  entries.sort((a, b) => byLower(a.name, b.name));
  const combined: ListEntry[] = [
    ...dirNames.map((name) => ({ name, type: "dir" as const })),
    ...entries,
  ];
  const truncated = combined.length > maxEntries;
  const display = path.relative(root, target).split(path.sep).join("/");
  return { path: display === "" ? "." : display, entries: combined.slice(0, maxEntries), truncated };
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

/** Replace an exact text span in a file (first occurrence, or all of them). */
export async function editFile(
  workspace: string,
  rel: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): Promise<{ path: string; replacements: number }> {
  const target = resolveInWorkspace(workspace, rel);
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
  await fs.writeFile(target, updated, "utf8");
  return { path: rel, replacements: replaceAll ? occurrences : 1 };
}

/** Delete a file or directory tree (never the workspace root). */
export async function deletePath(workspace: string, rel: string): Promise<{ path: string; deleted: "file" | "dir" }> {
  const root = workspaceRoot(workspace);
  const target = resolveInWorkspace(workspace, rel);
  if (target === root) throw new ToolError("refusing to delete the workspace root");
  let st;
  try {
    st = await fs.lstat(target);
  } catch {
    st = null;
  }
  if (!st) throw new ToolError(`not found: ${rel}`);
  if (st.isDirectory()) {
    await fs.rm(target, { recursive: true });
    return { path: rel, deleted: "dir" };
  }
  await fs.unlink(target);
  return { path: rel, deleted: "file" };
}

/**
 * Search file contents under a directory. Walk order matches the old
 * sidecar (os.walk): per directory, files (sorted) then subdirectories
 * (sorted, symlinks to dirs are not descended into); symlinks to files
 * count against the scan budget but are skipped.
 */
export async function searchFiles(
  workspace: string,
  rel: string | undefined,
  pattern: string,
  literal: boolean,
  maxResults: number,
  opts: FileOpsOptions,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const root = workspaceRoot(workspace);
  const base = resolveInWorkspace(workspace, rel);
  let st;
  try {
    st = await fs.stat(base);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw new ToolError(`not a directory: ${rel ?? "."}`);

  let regex: RegExp | null = null;
  if (!literal) {
    try {
      const r = new RegExp(pattern);
      // Drop g/y: JS keeps match state per regex, Python's re.search does not.
      regex = new RegExp(r.source, r.flags.replace(/[gy]/g, ""));
    } catch (err) {
      throw new ToolError(`invalid regular expression ${JSON.stringify(pattern)}: ${errMsg(err)}`);
    }
  }
  const limit = Math.min(maxResults, opts.searchMaxResults);
  const matches: SearchMatch[] = [];
  let truncated = false;
  let filesScanned = 0;

  const matchLine = (line: string): boolean => (literal ? line.includes(pattern) : regex !== null && regex.test(line));

  const walk = async (dir: string): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const subdirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).sort(byName).map((e) => e.name);
    const files = entries.filter((e) => !(e.isDirectory() && !e.isSymbolicLink())).sort(byName).map((e) => e.name);
    for (const name of files) {
      if (filesScanned >= opts.searchMaxFiles) {
        truncated = true;
        return true;
      }
      filesScanned += 1;
      const fp = path.join(dir, name);
      let lst;
      try {
        lst = await fs.lstat(fp);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;
      if (lst.size > opts.searchMaxFileBytes) continue;
      let text: string;
      try {
        const buf = await fs.readFile(fp);
        if (buf.subarray(0, 8192).includes(0)) continue; // binary
        text = utf8Fatal(buf);
      } catch {
        continue; // unreadable / invalid UTF-8 / vanished file
      }
      const lines = text.split(/\r\n|\r|\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing newline
      for (let i = 0; i < lines.length; i++) {
        if (!matchLine(lines[i])) continue;
        matches.push({
          file: path.relative(root, fp).split(path.sep).join("/"),
          line: i + 1,
          text: lines[i].trim().slice(0, opts.lineMaxChars),
        });
        if (matches.length >= limit) {
          truncated = true;
          return true;
        }
      }
    }
    for (const name of subdirs) {
      if (await walk(path.join(dir, name))) return true;
    }
    return false;
  };

  await walk(base);
  return { matches, truncated };
}
