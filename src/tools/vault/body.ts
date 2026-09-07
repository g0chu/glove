/**
 * The vault's body-text scan: which notes CONTAIN a query (the title index
 * only covers note names). Two engines:
 *
 * - "rg": spawn ripgrep (`-l -i --fixed-strings -g *.md`) — fast over the
 *   full ~8.4M-note vault; a deadline kills the child and the partial hits
 *   are returned flagged; reaching the hit cap stops the scan early.
 * - "js": a pure-JS file-by-file substring scan (used when ripgrep is not
 *   on PATH) — budgeted, so it covers only part of a full vault but works
 *   on any host.
 *
 * Both are bounded: a body scan must never hang a turn.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { errMsg } from "../../log.js";

/** One body scan's outcome. */
export interface BodyScanOutcome {
  /** Matching note file names (without ".md"), capped. */
  files: string[];
  /** True when the scan was cut short by its deadline (or the hit cap). */
  partial: boolean;
  /** Which engine produced the result ("none" = ripgrep missing, not run). */
  engine: "rg" | "js" | "none";
}

export interface BodyScanOptions {
  /** The ripgrep binary to use (default "rg"; a missing binary falls back to the JS scan). */
  rgPath?: string;
  /** Test-only: replace the whole scan. Never set in production. */
  fake?: (query: string, dir: string, budgetMs: number, maxFiles: number) => Promise<BodyScanOutcome>;
  /** Test-only: observe/abort the in-flight ripgrep child (shutdown wiring). */
  onChild?: (child: ChildProcess) => void;
}

/**
 * Scan a vault's note bodies for a query. `budgetMs` is the per-engine
 * deadline; `maxFiles` caps the returned list (reaching it ends the scan —
 * not flagged partial).
 */
export async function scanBody(
  dir: string,
  query: string,
  budgetMs: number,
  maxFiles: number,
  opts: BodyScanOptions = {},
): Promise<BodyScanOutcome> {
  if (opts.fake) {
    return opts.fake(query, dir, budgetMs, maxFiles);
  }
  const out = await rgScan(opts.rgPath ?? "rg", dir, query, budgetMs, maxFiles, opts.onChild);
  if (out.engine === "none") {
    // ripgrep is not installed: fall back to the bounded pure-JS scan.
    return jsScan(dir, query, budgetMs, maxFiles);
  }
  return out;
}

function rgScan(
  rg: string,
  dir: string,
  query: string,
  budgetMs: number,
  maxFiles: number,
  onChild?: (child: ChildProcess) => void,
): Promise<BodyScanOutcome> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(rg, ["-l", "-i", "--fixed-strings", "-g", "*.md", query, dir], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(new Error(`cannot start ripgrep: ${errMsg(e)}`));
      return;
    }
    onChild?.(child);
    const out = child.stdout;
    const err = child.stderr;
    if (out === null || err === null) {
      // stdio was set up above, so this is unreachable; stay defensive.
      reject(new Error("ripgrep has no stdout/stderr pipes"));
      return;
    }
    const files: string[] = [];
    let partial = false;
    let capped = false;
    const stderr: string[] = [];
    const timer = setTimeout(() => {
      partial = true;
      child.kill();
    }, budgetMs);
    out.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const t = line.trim();
        if (t.length === 0) continue;
        const base = t.slice(t.lastIndexOf("/") + 1);
        if (base.endsWith(".md")) files.push(base.slice(0, -3));
        if (files.length >= maxFiles) {
          capped = true;
          child.kill();
          break;
        }
      }
    });
    err.on("data", (c: Buffer) => stderr.push(c.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ENOENT") {
        resolve({ files: [], partial: false, engine: "none" });
      } else {
        reject(new Error(`ripgrep failed: ${errMsg(e)}`));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 1 || partial || capped) {
        // 0 = matches, 1 = no matches, partial/capped = killed on deadline or hit cap.
        resolve({ files, partial, engine: "rg" });
      } else {
        reject(new Error(`ripgrep failed (${code}): ${stderr.join(" ").slice(0, 200)}`));
      }
    });
  });
}

/**
 * The bounded pure-JS scan: every *.md note is read and substring-matched
 * (case-insensitive). The deadline is checked every 64 notes; an unreadable
 * note is skipped, never fatal.
 */
export async function jsScan(dir: string, query: string, budgetMs: number, maxFiles: number): Promise<BodyScanOutcome> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    throw new Error(`cannot list vault directory ${dir}: ${errMsg(e)}`);
  }
  const ql = query.toLowerCase();
  const files: string[] = [];
  const t0 = Date.now();
  let i = 0;
  for (const n of names) {
    if (!n.endsWith(".md")) continue;
    i++;
    if ((i & 63) === 0 && Date.now() - t0 > budgetMs) {
      return { files, partial: true, engine: "js" };
    }
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, n), "utf8");
    } catch {
      continue; // unreadable note: skip
    }
    if (text.toLowerCase().includes(ql)) {
      files.push(n.slice(0, -3));
      if (files.length >= maxFiles) {
        return { files, partial: false, engine: "js" };
      }
    }
  }
  return { files, partial: false, engine: "js" };
}
