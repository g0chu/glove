import type { ToolSpec } from "../llm/client.js";
import type { ToolRegistry } from "./executor.js";
import { argInt, argString } from "./executor.js";
import { editFile, readFile, writeFile, type FileOpsOptions } from "./file/ops.js";

/** String argument that must be present (may be empty, e.g. deleting text). */
function argPresentString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (v === undefined || v === null) throw new Error(`missing required argument "${key}"`);
  if (typeof v !== "string") throw new Error(`argument "${key}" must be a string`);
  return v;
}

function asBool(v: unknown): boolean {
  if (v !== undefined && typeof v !== "boolean") throw new Error("boolean argument must be true or false");
  return v === true;
}

export interface FileToolsOptions extends FileOpsOptions {
  /** Workspace directory the file tools operate in (on the bot's host). */
  workspace: string;
  /** Hard cap on characters in one tool result. */
  maxResultChars: number;
}

/**
 * In-process file tools: read, write and edit files in a persistent
 * workspace directory on the bot's host. Every path is resolved and
 * confined to the workspace (see file/paths.ts); the operations and their
 * caps live in file/ops.ts. No sidecar, no HTTP hop.
 */
export class FileTools {
  constructor(private readonly opts: FileToolsOptions) {}

  /** Hard-cap one tool result before it is handed to the model. */
  private cap(text: string): string {
    return text.length > this.opts.maxResultChars
      ? `${text.slice(0, this.opts.maxResultChars)}\n…[truncated]`
      : text;
  }

  /** Read a text file (with offset/limit for large files). */
  async read(path: string, offset?: number, limit?: number): Promise<string> {
    // Bound the byte window before reading so the displayed continuation
    // never skips content removed by the smaller character-result cap.
    const resultBudget = this.opts.maxResultChars - path.length - 300;
    if (resultBudget < 1) throw new Error("path is too long for the tool result cap");
    const readBudget = Math.min(this.opts.readMaxBytes, resultBudget);
    const data = await readFile(this.opts.workspace, path, offset ?? 0, limit, readBudget);
    const more = data.truncated ? ` (more content follows — read on with offset ${data.offset + data.bytesRead})` : "";
    return this.cap(`File "${path}" (bytes ${data.offset}-${data.offset + data.bytesRead} of ${data.size}${more}):\n${data.content}`);
  }

  /** Create or overwrite a file. */
  async write(path: string, content: string, createDirs: boolean): Promise<string> {
    const data = await writeFile(this.opts.workspace, path, content, createDirs, this.opts.writeMaxBytes);
    return `Wrote ${data.bytesWritten} bytes to "${data.path || path}".`;
  }

  /** Replace an exact text span in a file. */
  async edit(path: string, oldText: string, newText: string, replaceAll: boolean): Promise<string> {
    const data = await editFile(
      this.opts.workspace,
      path,
      oldText,
      newText,
      replaceAll,
      this.opts.readMaxBytes,
      this.opts.writeMaxBytes,
    );
    return `Replaced ${data.replacements} occurrence(s) in "${data.path || path}".`;
  }

  /** No-op: local filesystem operations run to completion, nothing to cancel. */
  abort(): void {}
}

/** OpenAI-compatible function specs for the file tools. */
export const FILE_READ_SPEC: ToolSpec = {
  name: "file_read",
  description: "Read a workspace text file using byte offset/limit. Returns the byte range and file size; the byte window is reduced to fit the configured result cap, so continuation offsets follow visible content. Use smaller windows if needed. Binary-looking files are rejected.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "File path relative to the workspace root." },
      offset: { type: "integer", minimum: 0, maximum: 100_000_000, default: 0, description: "Zero-based byte offset (default 0; clamped to 0-100000000)." },
      limit: { type: "integer", minimum: 0, maximum: 1_000_000, description: "Bytes to read; omitted or 0 uses the configured cap. Clamped to 0-1000000 and the configured cap." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const FILE_WRITE_SPEC: ToolSpec = {
  name: "file_write",
  description: "Create or overwrite a workspace file with exact UTF-8 content, subject to the configured byte cap. Use file_edit for partial changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "File path relative to the workspace root." },
      content: { type: "string", description: "Complete content, preserving whitespace; empty string creates or clears a file." },
      create_dirs: { type: "boolean", default: false, description: "Create missing parent directories (default false)." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

export const FILE_EDIT_SPEC: ToolSpec = {
  name: "file_edit",
  description: "Replace exact, nonempty text in a workspace UTF-8 file. Replaces the first occurrence by default; fails without changes if no match or read/write caps are exceeded. Read the file first to preserve exact whitespace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "File path relative to the workspace root." },
      old_text: { type: "string", minLength: 1, description: "Nonempty existing text, including leading/trailing whitespace." },
      new_text: { type: "string", description: "Exact replacement text; empty string deletes the match." },
      replace_all: { type: "boolean", default: false, description: "Replace every occurrence instead of just the first (default false)." },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },
};

/** Register the file tools on a registry, bound to one FileTools. */
export function registerFileTools(registry: ToolRegistry, tools: FileTools): void {
  registry.register(FILE_READ_SPEC, (args) =>
    tools.read(
      argString(args, "path"),
      argInt(args, "offset", 0, 0, 100_000_000),
      argInt(args, "limit", 0, 0, 1_000_000) || undefined,
    ),
  );
  registry.register(FILE_WRITE_SPEC, (args) =>
    tools.write(argString(args, "path"), argPresentString(args, "content"), asBool(args.create_dirs)),
  );
  registry.register(FILE_EDIT_SPEC, (args) =>
    tools.edit(argString(args, "path"), argPresentString(args, "old_text"), argPresentString(args, "new_text"), asBool(args.replace_all)),
  );
}
