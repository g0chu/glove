import { errMsg } from "../log.js";
import type { ToolSpec } from "../llm/client.js";
import type { ToolRegistry } from "./executor.js";
import { argInt, argOptionalString, argString } from "./executor.js";

/** Hard cap on one tool result before it is handed to the model. */
const MAX_RESULT_CHARS = 200_000;

/** String argument that must be present (may be empty, e.g. deleting text). */
function argPresentString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (v === undefined || v === null) throw new Error(`missing required argument "${key}"`);
  if (typeof v !== "string") throw new Error(`argument "${key}" must be a string`);
  return v;
}

export interface FileToolsOptions {
  baseUrl: string;
  timeoutMs: number;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asBool(v: unknown): boolean {
  return v === true;
}

function cap(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
}

/**
 * Client for the filetools sidecar (Docker, 127.0.0.1 by default): file
 * management inside a persistent workspace volume. Every path is resolved
 * and confined to the workspace by the sidecar; this client only sends
 * requests and formats the answers for the model.
 */
export class FileToolsClient {
  private readonly active = new Set<AbortController>();

  constructor(private readonly opts: FileToolsOptions) {}

  /** List a directory (default: workspace root). */
  async list(path: string | undefined): Promise<string> {
    const data = await this.post("/file/list", path ? { path } : {});
    const entries = Array.isArray(data.entries) ? (data.entries as Array<Record<string, unknown>>) : [];
    if (entries.length === 0) return cap(`Directory "${asString(data.path) || "."}" is empty.`);
    const lines = entries.map((e) => {
      const name = asString(e.name);
      if (e.type === "dir") return `- [dir] ${name}/`;
      const size = e.size == null ? "" : ` ${e.size} B`;
      const mtime = e.mtime ? `  modified ${asString(e.mtime)}` : "";
      return `- ${name}${size}${mtime}`;
    });
    const more = data.truncated === true ? `\n(listing truncated at ${entries.length} entries)` : "";
    return cap(`Directory listing of "${asString(data.path) || "."}" (${entries.length} entries):\n${lines.join("\n")}${more}`);
  }

  /** Read a text file (with offset/limit for large files). */
  async read(path: string, offset?: number, limit?: number): Promise<string> {
    const payload: Record<string, unknown> = { path };
    if (offset !== undefined) payload.offset = offset;
    if (limit !== undefined) payload.limit = limit;
    const data = await this.post("/file/read", payload);
    const size = data.size == null ? "?" : data.size;
    const off = Number(data.offset ?? 0);
    const n = Number(data.bytes_read ?? 0);
    const more = data.truncated === true ? ` (more content follows — read on with offset ${off + n})` : "";
    return cap(`File "${path}" (bytes ${off}-${off + n} of ${size}${more}):\n${asString(data.content)}`);
  }

  /** Create or overwrite a file. */
  async write(path: string, content: string, createDirs: boolean): Promise<string> {
    const data = await this.post("/file/write", { path, content, create_dirs: createDirs });
    return `Wrote ${data.bytes_written ?? content.length} bytes to "${asString(data.path) || path}".`;
  }

  /** Replace an exact text span in a file. */
  async edit(path: string, oldText: string, newText: string, replaceAll: boolean): Promise<string> {
    const data = await this.post("/file/edit", { path, old_text: oldText, new_text: newText, replace_all: replaceAll });
    return `Replaced ${data.replacements ?? 1} occurrence(s) in "${asString(data.path) || path}".`;
  }

  /** Delete a file or directory tree. */
  async remove(path: string): Promise<string> {
    const data = await this.post("/file/delete", { path });
    return `Deleted ${data.deleted === "dir" ? "directory" : "file"} "${asString(data.path) || path}".`;
  }

  /** Search file contents for a pattern (regex or literal). */
  async search(pattern: string, path: string | undefined, literal: boolean, maxResults: number): Promise<string> {
    const payload: Record<string, unknown> = { pattern, literal };
    if (path) payload.path = path;
    if (maxResults !== 100) payload.max_results = maxResults;
    const data = await this.post("/file/search", payload);
    const matches = Array.isArray(data.matches) ? (data.matches as Array<Record<string, unknown>>) : [];
    if (matches.length === 0) return cap(`No matches for ${literal ? "text" : "pattern"} "${pattern}".`);
    const lines = matches.map((m) => `${asString(m.file)}:${m.line ?? "?"}: ${asString(m.text).trim()}`);
    const more = data.truncated === true ? `\n(more matches exist — narrow the pattern or path)` : "";
    return cap(`${matches.length} match(es) for "${pattern}":\n${lines.join("\n")}${more}`);
  }

  /** Cancel all in-flight requests (graceful shutdown). */
  abort(): void {
    for (const c of this.active) {
      try {
        c.abort();
      } catch {
        /* already settled */
      }
    }
    this.active.clear();
  }

  /** POST JSON to the sidecar; resolves the `ok` payload, rejects with a message. */
  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`filetools request timed out after ${Math.round(this.opts.timeoutMs / 1000)}s`);
      }
      throw new Error(`could not reach filetools at ${this.opts.baseUrl}: ${errMsg(err)}`);
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data) {
      const msg = data && typeof data.error === "string" ? data.error : `filetools returned HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }
}

/** OpenAI-compatible function specs for the file tools. */
export const FILE_LIST_SPEC: ToolSpec = {
  name: "file_list",
  description: "List the bot's persistent file workspace (a directory that survives restarts). Returns entries with type, size, and modification time.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to the workspace root (default: root)." },
    },
    additionalProperties: false,
  },
};

export const FILE_READ_SPEC: ToolSpec = {
  name: "file_read",
  description: "Read a text file from the workspace. Large files can be read in windows with offset/limit (byte offsets).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      offset: { type: "integer", description: "Byte offset to start reading at (default 0)." },
      limit: { type: "integer", description: "Maximum bytes to read (default: the service limit)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const FILE_WRITE_SPEC: ToolSpec = {
  name: "file_write",
  description: "Create or overwrite a file in the workspace with the given full content. Use for new files or complete rewrites; for changing part of a file use file_edit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      content: { type: "string", description: "The complete file content to write." },
      create_dirs: { type: "boolean", description: "Create missing parent directories (default false)." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

export const FILE_EDIT_SPEC: ToolSpec = {
  name: "file_edit",
  description: "Edit a file in the workspace by replacing an exact text span. old_text must match the file content exactly (whitespace included); if it is missing, the edit fails and nothing is changed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      old_text: { type: "string", description: "The exact existing text to replace." },
      new_text: { type: "string", description: "The replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of just the first (default false)." },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },
};

export const FILE_DELETE_SPEC: ToolSpec = {
  name: "file_delete",
  description: "Delete a file or directory tree from the workspace. This cannot be undone.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const FILE_SEARCH_SPEC: ToolSpec = {
  name: "file_search",
  description: "Search the contents of files in the workspace for a pattern. Returns matching lines with file and line number.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "Subdirectory to search in, relative to the workspace root (default: root)." },
      literal: { type: "boolean", description: "Treat the pattern as a literal string, not a regex (default false)." },
      max_results: { type: "integer", description: "Maximum matches to return (1-500, default 100)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

/** Register the file tools on a registry, bound to one client. */
export function registerFileTools(registry: ToolRegistry, client: FileToolsClient): void {
  registry.register(FILE_LIST_SPEC, (args) => client.list(argOptionalString(args, "path")));
  registry.register(FILE_READ_SPEC, (args) =>
    client.read(
      argString(args, "path"),
      argInt(args, "offset", 0, 0, 100_000_000),
      argInt(args, "limit", 0, 0, 1_000_000) || undefined,
    ),
  );
  registry.register(FILE_WRITE_SPEC, (args) =>
    client.write(argString(args, "path"), argString(args, "content"), asBool(args.create_dirs)),
  );
  registry.register(FILE_EDIT_SPEC, (args) =>
    client.edit(argString(args, "path"), argString(args, "old_text"), argPresentString(args, "new_text"), asBool(args.replace_all)),
  );
  registry.register(FILE_DELETE_SPEC, (args) => client.remove(argString(args, "path")));
  registry.register(FILE_SEARCH_SPEC, (args) =>
    client.search(
      argString(args, "pattern"),
      argOptionalString(args, "path"),
      asBool(args.literal),
      argInt(args, "max_results", 100, 1, 500),
    ),
  );
}
