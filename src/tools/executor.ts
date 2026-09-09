import { errMsg, truncate } from "../log.js";
import type { ChatMessage, ToolCall, ToolSpec } from "../llm/client.js";

/**
 * Executes the tool calls a model response asked for.
 *
 * Handlers are plain async functions: they take a validated args object and
 * return the text that goes into the `tool`-role message. Any failure is
 * turned into an "Error: …" result for the model (which can then retry a
 * different way or answer without the tool) — a broken tool must never kill
 * the turn.
 */
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(spec: ToolSpec, handler: ToolHandler): this {
    if (this.tools.has(spec.name)) {
      throw new Error(`tool already registered: ${spec.name}`);
    }
    this.tools.set(spec.name, { spec, handler });
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** The specs to send as `tools` (empty array when no tool is registered). */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  get size(): number {
    return this.tools.size;
  }
}

/** A `tool`-role message answering one call, ready to append to the turn. */
export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

/** Durable lifecycle hooks. Failure prevents further execution, never a tool result. */
export interface ToolExecutionObserver {
  started: (call: ToolCall, index: number) => void;
  finished: (result: ToolResultMessage, index: number) => void;
}

/**
 * Parse the raw `arguments` string of a tool call. Endpoints may deliver an
 * empty string (no args) or, in non-stream mode, an object instead of a
 * string (the client already stringifies those, but stay defensive).
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  let value: unknown;
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    value = {};
  } else {
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new Error(`arguments are not valid JSON: ${truncate(raw, 200)}`);
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/** Required string argument (non-empty after trim). */
export function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`missing required string argument "${key}"`);
  }
  return v.trim();
}

/** Optional string argument. */
export function argOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`argument "${key}" must be a string`);
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Integer argument with default and clamped range. */
export function argInt(
  args: Record<string, unknown>,
  key: string,
  dflt: number,
  min: number,
  max: number,
): number {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`argument "${key}" must be an integer (got ${String(v)})`);
  }
  return Math.min(max, Math.max(min, n));
}

/**
 * Run every requested tool call (concurrently) and return one `tool`-role
 * message per call, in the same order as `calls`.
 */
export async function executeToolCalls(registry: ToolRegistry, calls: ToolCall[], observer?: ToolExecutionObserver): Promise<ToolResultMessage[]> {
  // Persist every intent before starting any handler. An archive failure
  // must not start a subset of a batch and leave the others unrecorded.
  calls.forEach((call, index) => observer?.started(call, index));
  const settled = await Promise.allSettled(
    calls.map(async (call, index): Promise<ToolResultMessage> => {
      const content = await runOne(registry, call);
      const result: ToolResultMessage = { role: "tool", toolCallId: call.id, name: call.name, content };
      observer?.finished(result, index);
      return result;
    }),
  );
  return settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

async function runOne(registry: ToolRegistry, call: ToolCall): Promise<string> {
  const tool = registry.get(call.name);
  if (!tool) {
    return `Error: unknown tool "${call.name}"`;
  }
  let args: Record<string, unknown>;
  try {
    args = parseToolArgs(call.arguments);
  } catch (err) {
    return `Error: ${errMsg(err)}`;
  }
  try {
    return await tool.handler(args);
  } catch (err) {
    return `Error: ${errMsg(err)}`;
  }
}
