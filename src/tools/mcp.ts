import { spawn, type ChildProcess } from "node:child_process";
import { errMsg, log, truncate } from "../log.js";
import type { McpServerConfig } from "../config.js";
import type { ToolSpec } from "../llm/client.js";
import type { ToolRegistry } from "./executor.js";

/**
 * MCP (Model Context Protocol) client: connects to external MCP servers —
 * a stdio process the bot spawns, or a streamable-HTTP endpoint — lists
 * their tools, and registers them in the same registry as the in-process
 * tool families.
 *
 * The wire protocol is JSON-RPC 2.0. The stdio transport carries one
 * message per line on stdin/stdout; the streamable-HTTP transport POSTs to
 * the endpoint and accepts either a plain JSON response or a
 * text/event-stream body carrying the response in a `message` event. Both
 * transports share one connection implementation (requests are
 * multiplexed by id, so concurrent tool calls fly in parallel). A broken
 * server degrades to "Error: …" tool results and startup warnings — it
 * never crashes the bot.
 */

/** The newest protocol version the client announces (servers may answer with theirs). */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The startup handshake (initialize + tools/list) never stalls the bot for more than this. */
const HANDSHAKE_TIMEOUT_MS = 60_000;

/** How long the bot waits between SIGTERM and SIGKILL when closing a stdio server. */
const KILL_GRACE_MS = 3_000;

/**
 * Options shared by every configured server.
 */
export interface McpToolsOptions {
  /** Deadline per tools/call request (ms). */
  timeoutMs: number;
  /** Hard cap on characters in one tool result (like the other families). */
  maxResultChars: number;
  /** Prefix tool names with the server's slug (set when more than one server is configured). */
  prefixNames: boolean;
}

/** One tool as the server's tools/list reports it. */
export interface McpTool {
  name: string;
  description?: string;
  /** A JSON Schema object (type: "object") for the tool's arguments. */
  inputSchema?: unknown;
}

/** One connected MCP server; its tools are already registered in the given registry. */
export class McpClient {
  constructor(
    readonly name: string,
    readonly toolNames: string[],
    private readonly conn: McpConnection,
  ) {}

  /** Close the transport and fail every in-flight call (wired into shutdown). */
  abort(): void {
    this.conn.close();
  }
}

/**
 * Connect to every configured MCP server and register their tools.
 * Never throws: each server that cannot connect (or lists no tools) is
 * logged and skipped, and the bot runs with whatever connected.
 */
export async function connectMcpServers(servers: McpServerConfig[], registry: ToolRegistry, opts: McpToolsOptions): Promise<McpClient[]> {
  const clients: McpClient[] = [];
  for (const server of servers) {
    try {
      const client = await connectMcpServer(server, registry, opts);
      if (client) clients.push(client);
    } catch (err) {
      log.error(`mcp[${server.name}]: failed to connect: ${errMsg(err)}`);
    }
  }
  return clients;
}

/**
 * Connect to one MCP server, run the handshake, and register its tools in
 * the registry. Resolves to null (with a logged reason) when the server
 * cannot be reached, the handshake fails, or it lists no tools.
 */
export async function connectMcpServer(server: McpServerConfig, registry: ToolRegistry, opts: McpToolsOptions): Promise<McpClient | null> {
  const label = `mcp[${server.name}]`;
  let transport: StdioTransport | HttpTransport;
  if (server.command) {
    transport = new StdioTransport(server);
  } else if (server.url) {
    transport = new HttpTransport(server);
  } else {
    log.warn(`${label}: no "command" or "url" configured; skipping`);
    return null;
  }
  const conn = new McpConnection(transport, label, Math.min(opts.timeoutMs, HANDSHAKE_TIMEOUT_MS));
  try {
    await conn.initialize();
  } catch (err) {
    conn.close();
    log.warn(`${label}: handshake failed: ${errMsg(err)}`);
    return null;
  }
  let tools: McpTool[];
  try {
    tools = await conn.listTools(opts.timeoutMs);
  } catch (err) {
    conn.close();
    log.warn(`${label}: tools/list failed: ${errMsg(err)}`);
    return null;
  }
  if (tools.length === 0) {
    conn.close();
    log.warn(`${label}: the server lists no tools; skipping`);
    return null;
  }
  const names: string[] = [];
  for (const tool of tools) {
    const spec = toToolSpec(server.name, tool, opts.prefixNames);
    if (!spec) continue;
    if (registry.has(spec.name)) {
      log.warn(`${label}: tool "${spec.name}" is already registered; skipping it`);
      continue;
    }
    registry.register(spec, (args) => conn.callTool(tool.name, args, opts.timeoutMs, opts.maxResultChars));
    names.push(spec.name);
  }
  if (names.length === 0) {
    conn.close();
    log.warn(`${label}: none of the server's tools could be registered; skipping`);
    return null;
  }
  log.info(`${label}: connected (${names.length} tool(s): ${names.join(", ")})`);
  return new McpClient(server.name, names, conn);
}

/**
 * One JSON-RPC conversation over either transport: request/response
 * pairing by id, per-request deadlines, server-to-client requests
 * (ping is answered, anything else is rejected), and fail-closed teardown.
 */
class McpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly transport: StdioTransport | HttpTransport,
    private readonly label: string,
    private readonly handshakeTimeoutMs: number,
  ) {
    transport.onLine = (raw) => this.dispatch(raw);
    transport.onClose = (err) => this.failAll(err ?? new Error("connection closed"));
  }

  /** The initialize handshake: the protocol exchange, then the initialized notification. */
  async initialize(): Promise<void> {
    const res = (await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "glove", version: "0.1.0" },
      },
      this.handshakeTimeoutMs,
    )) as { protocolVersion?: unknown; serverInfo?: { name?: unknown } } | undefined;
    const version = typeof res?.protocolVersion === "string" ? res.protocolVersion : MCP_PROTOCOL_VERSION;
    const info = res?.serverInfo?.name;
    log.info(`${this.label}: initialized (protocol ${version}${typeof info === "string" && info ? `, server ${info}` : ""})`);
    // The notification must be sent, but a server that rejects it is
    // non-conformant, not unreachable: warn and let tools/list decide.
    await this.notify("notifications/initialized");
  }

  /** tools/list with pagination (servers that page get at most 10 pages). */
  async listTools(timeoutMs: number): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: unknown;
    for (let page = 0; page < 10; page++) {
      const res = (await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        timeoutMs,
      )) as { tools?: unknown; nextCursor?: unknown } | undefined;
      if (res && Array.isArray(res.tools)) tools.push(...(res.tools as McpTool[]));
      if (res?.nextCursor === undefined) break;
      cursor = res.nextCursor;
    }
    return tools;
  }

  /** One tools/call, formatted into the text the model sees. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number, maxResultChars: number): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    return formatCallResult(result, maxResultChars);
  }

  /** Send a notification (no response expected); failures are logged, never thrown. */
  private notify(method: string): Promise<void> {
    const raw = JSON.stringify({ jsonrpc: "2.0", method });
    return Promise.resolve(this.transport.sendLine(raw)).catch((err: unknown) => {
      log.warn(`${this.label}: ${method} failed: ${errMsg(err)}`);
    });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    const raw = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const secs = timeoutMs / 1000;
        reject(new Error(`${method} timed out after ${Number.isInteger(secs) ? secs : secs.toFixed(1)}s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      Promise.resolve(this.transport.sendLine(raw)).catch((err: unknown) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private dispatch(raw: string): void {
    if (this.closed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return; // tolerate non-JSON noise on the channel
    }
    if (msg.method === undefined && typeof msg.id === "number") {
      // A response to one of our requests (we number them; a string id can never be ours).
      const p = this.pending.get(msg.id);
      if (!p) return; // late or unknown: ignore
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === undefined || msg.id === undefined) return; // server notification: nothing to do
    // A server-to-client request: answer ping, reject the rest.
    const out =
      msg.method === "ping"
        ? JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })
        : JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not supported: ${msg.method}` } });
    Promise.resolve(this.transport.sendLine(out)).catch(() => {
      /* the connection is dying; the close handler reports it */
    });
  }

  /** Close the connection and fail every in-flight request (idempotent). */
  close(): void {
    if (this.closed) return;
    this.failAll(new Error("connection closed"));
    this.transport.close();
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.label}: ${err.message}`));
    }
    this.pending.clear();
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * stdio transport: spawn the server process and carry one JSON-RPC message
 * per line on stdin/stdout (the MCP stdio rule). The server's stderr is
 * relayed to the bot log; an unexpected exit fails every open request.
 */
class StdioTransport {
  private child: ChildProcess;
  private buf = "";
  private closing = false;
  onLine: (raw: string) => void = () => {};
  onClose: (err: Error) => void = () => {};

  constructor(server: McpServerConfig) {
    this.child = spawn(server.command as string, server.args ?? [], {
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin?.on("error", (err: Error) => this.onClose(new Error(`stdin: ${err.message}`)));
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) log.info(`mcp[${server.name}]: ${truncate(line.trim(), 500)}`);
      }
    });
    this.child.on("error", (err: Error) => this.onClose(new Error(`server process: ${err.message}`)));
    this.child.on("exit", (code, signal) => {
      if (!this.closing) this.onClose(new Error(`server process exited (${code ?? signal ?? "unknown"})`));
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  sendLine(raw: string): void {
    try {
      this.child.stdin?.write(raw + "\n");
    } catch {
      // the process is already gone; the exit handler fails open requests
    }
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    try {
      this.child.stdin?.end();
    } catch {
      /* already destroyed */
    }
    this.child.kill("SIGTERM");
    const killer = setTimeout(() => this.child.kill("SIGKILL"), KILL_GRACE_MS);
    killer.unref();
  }
}

/**
 * streamable-HTTP transport: one POST per JSON-RPC message; the response is
 * either plain JSON or an event stream whose `message` event carries the
 * JSON-RPC reply. The session id from the initialize response is sent back
 * on every later request.
 */
class HttpTransport {
  private sessionId: string | null = null;
  private inFlight: AbortController | null = null;
  private closed = false;
  onLine: (raw: string) => void = () => {};
  onClose: (err: Error) => void = () => {};

  constructor(private readonly server: McpServerConfig) {}

  async sendLine(raw: string): Promise<void> {
    if (this.closed) throw new Error("connection closed");
    const controller = new AbortController();
    this.inFlight = controller;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.server.headers,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    let res: Response;
    try {
      res = await fetch(this.server.url as string, {
        method: "POST",
        headers,
        body: raw,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error("connection closed");
      throw new Error(`request failed: ${errMsg(err)}`);
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) {
      void res.body?.cancel().catch(() => {});
      return; // a notification acknowledgement
    }
    if (res.status === 404 || res.status === 410) {
      const err = new Error(`the server rejected the session (HTTP ${res.status})`);
      this.close();
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${truncate(body, 200)}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const payload = await readSseMessage(res);
      if (!payload) {
        const err = new Error("the event stream carried no message");
        this.close();
        throw err;
      }
      this.onLine(payload);
    } else {
      const body = await res.text();
      if (body.trim()) this.onLine(body);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inFlight?.abort();
  }
}

/**
 * Read the first `message` event of an SSE stream (the streamable-HTTP way
 * of carrying a JSON-RPC response). Returns null when the stream closes
 * without one.
 */
async function readSseMessage(res: Response): Promise<string | null> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, sep).replace(/\r$/, "");
        buffer = buffer.slice(sep + 1);
        if (line === "") {
          // An event boundary: a `message` event carries the payload.
          if (data.length > 0) {
            const type = event || "message";
            const payload = data.join("\n");
            if (type === "message") {
              // The reply arrived; release the stream so the socket can drain.
              await reader.cancel().catch(() => {});
              return payload;
            }
            if (type === "end") {
              await reader.cancel().catch(() => {});
              return null;
            }
          }
          event = "";
          data = [];
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        // comments and other fields are not protocol data
      }
    }
  } finally {
    reader.releaseLock();
  }
  return null;
}

/**
 * Convert one tools/list entry into the OpenAI function spec the registry
 * takes. The name is sanitized to what function-calling endpoints accept
 * (letters, digits, underscore, hyphen, <=64 chars), and prefixed with the
 * server's slug when several servers are configured.
 */
function toToolSpec(serverName: string, tool: McpTool, prefixNames: boolean): ToolSpec | null {
  if (!tool || typeof tool.name !== "string" || tool.name.trim().length === 0) return null;
  const wire = sanitizeName(tool.name);
  const name = prefixNames ? `${sanitizeName(serverName)}__${wire}`.slice(0, 64) : wire;
  let parameters: Record<string, unknown>;
  if (tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)) {
    parameters = { ...(tool.inputSchema as Record<string, unknown>) };
  } else {
    parameters = { type: "object", properties: {} };
  }
  if (parameters.type !== "object") parameters.type = "object";
  const description =
    typeof tool.description === "string" && tool.description.trim()
      ? tool.description.trim()
      : `Tool provided by the ${serverName} MCP server.`;
  return { name, description, parameters };
}

/** Make a string a legal tool name (endpoints accept [A-Za-z0-9_-]{1,64}). */
function sanitizeName(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
  if (out.length === 0) out = "tool";
  return out.slice(0, 64);
}

/**
 * Format a tools/call result into the text that goes into the tool-role
 * message: text parts joined, non-text parts reduced to one-line notes,
 * structured content as a JSON fallback, isError flagged, length capped
 * like every other family.
 */
function formatCallResult(result: unknown, maxResultChars: number): string {
  if (result === null || result === undefined) return "no result";
  if (typeof result !== "object") return String(result);
  const r = result as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const part of r.content) {
      if (part && typeof part === "object") {
        const p = part as { type?: unknown; text?: unknown; mimeType?: unknown; uri?: unknown };
        if (p.type === "text" && typeof p.text === "string") {
          parts.push(p.text);
        } else if (p.type === "image") {
          parts.push(`[image part (${String(p.mimeType ?? "unknown")}) omitted]`);
        } else if (p.type === "resource") {
          parts.push(`[embedded resource ${typeof p.uri === "string" ? p.uri : ""} omitted]`.replace("  ", " "));
        } else {
          parts.push(`[content part of type ${String(p.type ?? "unknown")} omitted]`);
        }
      }
    }
  }
  let text = parts.join("\n");
  if (text.length === 0 && r.structuredContent !== undefined) {
    try {
      text = JSON.stringify(r.structuredContent, null, 2);
    } catch {
      text = String(r.structuredContent);
    }
  }
  if (text.length === 0) text = "no content";
  if (r.isError === true) text = `Error: ${text}`;
  return text.length > maxResultChars ? `${text.slice(0, maxResultChars)}\n…[truncated]` : text;
}
