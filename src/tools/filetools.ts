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
    const data = await readFile(this.opts.workspace, path, offset ?? 0, limit, this.opts.readMaxBytes);
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
  description: "Read a text file from the workspace. Large files can be read in windows with offset/limit (byte offsets).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      offset: { type: "integer", description: "Byte offset to start reading at (default 0)." },
      limit: { type: "integer", description: "Maximum bytes to read (default: the bot's configured limit)." },
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
    tools.write(argString(args, "path"), argString(args, "content"), asBool(args.create_dirs)),
  );
  registry.register(FILE_EDIT_SPEC, (args) =>
    tools.edit(argString(args, "path"), argString(args, "old_text"), argPresentString(args, "new_text"), asBool(args.replace_all)),
  );
}
