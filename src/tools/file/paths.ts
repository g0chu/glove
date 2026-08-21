/**
 * Workspace path confinement for the file tools.
 *
 * Every path the model sends is treated as *relative to the workspace root*
 * (leading `/` is stripped, so "absolute" paths cannot escape), resolved
 * with symlinks followed, and then checked to still live inside the
 * workspace. A symlink pointing outside therefore resolves outside and is
 * rejected.
 */
import fs from "node:fs";
import path from "node:path";
import { ToolError } from "../web/ssrf.js";

/** The real (symlink-resolved) workspace directory, or a ToolError. */
export function workspaceRoot(workspace: string): string {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(workspace));
  } catch {
    throw new ToolError(`workspace directory ${path.resolve(workspace)} does not exist`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new ToolError(`workspace directory ${root} does not exist or is not a directory`);
  }
  return root;
}

/**
 * Resolve *rel* (workspace-relative) to a fully-resolved safe path.
 * `undefined`/empty means the workspace root itself. Raises ToolError when
 * the path escapes the workspace (traversal or a symlink pointing out).
 */
export function resolveInWorkspace(workspace: string, rel: string | undefined): string {
  const root = workspaceRoot(workspace);
  if (rel === undefined || rel === null) return root;
  if (typeof rel !== "string") throw new ToolError("path must be a string");
  const cleaned = rel.trim().replace(/^\/+/, "");
  if (cleaned === "" || cleaned === ".") return root;

  const candidate = path.resolve(root, cleaned);
  // Fast lexical escape check (no fs involved).
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new ToolError(`path ${JSON.stringify(rel)} escapes the workspace`);
  }

  // Walk up to the longest existing prefix, resolving symlinks on the way;
  // any missing tail is appended afterwards (so brand-new file paths work).
  const missing: string[] = [];
  let probe = candidate;
  for (;;) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) throw new ToolError(`cannot resolve path ${JSON.stringify(rel)}`);
      missing.unshift(path.basename(probe));
      probe = parent;
      continue;
    }
    if (st.isSymbolicLink()) {
      // A dangling symlink would let a write land at an out-of-workspace
      // target; refuse it. Live symlinks are resolved below.
      try {
        fs.statSync(probe);
      } catch {
        throw new ToolError(`path ${JSON.stringify(rel)} escapes the workspace`);
      }
    }
    break;
  }
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== root && !realProbe.startsWith(root + path.sep)) {
    throw new ToolError(`path ${JSON.stringify(rel)} escapes the workspace`);
  }
  return missing.length === 0 ? realProbe : path.join(realProbe, ...missing);
}
