import { errMsg, truncate } from "../log.js";

/** One tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as delivered by the endpoint. */
  arguments: string;
}

/**
 * One part of a multi-part message (the OpenAI multimodal wire shape).
 * Image parts carry a `data:` URI (base64) — or, for endpoints that allow
 * it, an https URL the model side can fetch.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A Discord attachment as the context builder sees it (the real Attachment fits this shape). */
export interface MessageAttachmentLike {
  url: string;
  name: string;
  size: number;
  contentType: string | null;
}

/** MIME types a Chat Completions endpoint can take as image_url. */
export const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

/** True when the attachment is an image type the model can take (png/jpeg/webp/gif). */
export function isImageAttachment(att: MessageAttachmentLike): boolean {
  return att.contentType != null && att.contentType in SUPPORTED_IMAGE_TYPES;
}

/** A message in the conversation sent to the model (wire shape on request). */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * Plain text, or an array of text/image parts for multimodal messages
   * (user messages carrying attachments; tool content is always a string).
   */
  content: string | ContentPart[];
  /** assistant only: tool calls the model requested. */
  toolCalls?: ToolCall[];
  /**
   * assistant only: the model's reasoning/thinking for this message, sent
   * back to the endpoint as `reasoning_content` so a reasoning model
   * continues from its own thinking (endpoints without reasoning support
   * ignore the field).
   */
  reasoningContent?: string;
  /** tool only: id of the call this message answers. */
  toolCallId?: string;
  /** tool only: name of the tool this message answers. */
  name?: string;
}

/** The endpoint's own count of the tokens one request used, when it reports them. */
export interface TokenUsage {
  /** Prompt tokens (the request's context, counted by the model's tokenizer). */
  input: number;
  /** Generated (completion) tokens. */
  output: number;
}

/** What the model answered: text, tool calls, or both. */
export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** The endpoint's token count for this request, when it reports one. */
  usage?: TokenUsage;
  /** The model's reasoning/thinking for this response, when the endpoint sent it. */
  reasoning?: string;
}

/** OpenAI-compatible function spec (the `function` object of a `tools` entry). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmClientOptions {
  apiUrl: string;
  apiKey: string;
  model: string;
  stream: boolean;
  timeoutMs: number;
}

/** Stream callbacks for one request (both optional). */
export interface StreamCallbacks {
  /** Called with each streamed content delta, as it arrives. */
  onDelta?: (delta: string) => void;
  /**
   * Called with each streamed reasoning/thinking delta, if the endpoint
   * sends any (some providers stream the model's private thinking alongside
   * the answer, under `reasoning` or `reasoning_content`).
   */
  onReasoning?: (delta: string) => void;
}

interface SseToolCallDelta {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface SseDeltaChunk {
  error?: { message?: string } | string;
  choices?: Array<{
    delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; tool_calls?: SseToolCallDelta[] };
  }>;
  /** OpenAI-style usage block (some endpoints send it in the final chunk). */
  usage?: unknown;
  /** llama-server's timing block (final chunk): prompt_n + cache_n prompt tokens, predicted_n completion tokens. */
  timings?: unknown;
}

interface SseMessageChunk {
  error?: { message?: string } | string;
  choices?: Array<{
    message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; tool_calls?: SseToolCallDelta[] };
  }>;
  /** OpenAI-style usage block. */
  usage?: unknown;
  /** llama.cpp's legacy top-level token counters (older builds). */
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  /** llama-server's timing block: prompt_n + cache_n prompt tokens, predicted_n completion tokens. */
  timings?: unknown;
}

/** The token-count fields a response may carry (see parseUsage). */
interface UsageCarrier {
  usage?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  timings?: unknown;
}

const asNonNegInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;

/**
 * The endpoint's token count for one response, when it reports one.
 * Precedence: an OpenAI-style `usage` block, then llama.cpp's legacy
 * top-level `prompt_tokens`/`completion_tokens`, then llama.cpp's `timings`
 * block (prompt_n + cache_n prompt tokens — the prompt-cache split — and
 * predicted_n completion tokens; what the final streaming chunk carries
 * when there is no usage block).
 */
function parseUsage(body: UsageCarrier): TokenUsage | undefined {
  const usage = body.usage;
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    const input = asNonNegInt(u.prompt_tokens);
    const output = asNonNegInt(u.completion_tokens);
    if (input !== null || output !== null) return { input: input ?? 0, output: output ?? 0 };
  }
  const input = asNonNegInt(body.prompt_tokens);
  const output = asNonNegInt(body.completion_tokens);
  if (input !== null || output !== null) return { input: input ?? 0, output: output ?? 0 };
  const timings = body.timings;
  if (timings && typeof timings === "object") {
    const t = timings as Record<string, unknown>;
    const predicted = asNonNegInt(t.predicted_n);
    if (predicted !== null) {
      return { input: (asNonNegInt(t.prompt_n) ?? 0) + (asNonNegInt(t.cache_n) ?? 0), output: predicted };
    }
  }
  return undefined;
}

/** The reasoning/thinking text of a message object, if the endpoint sent it. */
function reasoningOf(msg: { reasoning?: unknown; reasoning_content?: unknown }): string {
  if (typeof msg.reasoning === "string") return msg.reasoning;
  if (typeof msg.reasoning_content === "string") return msg.reasoning_content;
  return "";
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * A model request aborted by the caller's signal — the channel-activity
 * interruption (index.ts): the channel changed (a new message, an edit, a
 * typing indicator) while the prompt was being processed, so the in-flight
 * request is cancelled on purpose. Distinct from the request's own timeout
 * (which reports "timed out"): the turn catches it and waits for the
 * channel to go quiet, then discards the turn when a newer turn supersedes
 * it (the newer turn responds to the newest information) or retries it with
 * the updated context (an edit or a typing indicator interrupted the
 * attempt, so nothing else will answer).
 */
export class InterruptedError extends Error {
  constructor() {
    super("model request interrupted (the channel changed while the prompt was being processed)");
    this.name = "InterruptedError";
  }
}

/** True when the error is a caller-initiated interruption (see InterruptedError). */
export function isInterruptedError(err: unknown): boolean {
  return err instanceof InterruptedError;
}

/** Normalize one complete tool_call object (non-stream mode) into a ToolCall. */
function normalizeToolCall(tc: SseToolCallDelta | undefined): ToolCall | null {
  if (!tc || typeof tc !== "object") return null;
  const name = typeof tc.function?.name === "string" ? tc.function.name : "";
  const rawArgs = tc.function?.arguments;
  let args: string;
  if (typeof rawArgs === "string") {
    args = rawArgs;
  } else {
    // Some endpoints deliver arguments as a JSON object instead of a string.
    args = rawArgs == null ? "{}" : JSON.stringify(rawArgs);
  }
  if (!name) return null;
  return { id: typeof tc.id === "string" ? tc.id : "", name, arguments: args };
}

/** Convert an internal message to the OpenAI wire shape. */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content };
  }
  const reasoning = m.reasoningContent !== undefined && m.reasoningContent.length > 0 ? m.reasoningContent : undefined;
  const withReasoning = reasoning !== undefined ? { reasoning_content: reasoning } : {};
  if (m.role === "assistant" && m.toolCalls) {
    return {
      role: "assistant",
      content: m.content,
      ...withReasoning,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content, ...withReasoning };
}

/**
 * Minimal OpenAI-compatible Chat Completions client (native fetch).
 * - streaming: SSE `data: {...}` deltas + `data: [DONE]`
 * - non-streaming: `choices[0].message.content`
 * - per-request timeout via AbortController (covers the whole stream)
 * - `abort()` cancels every in-flight request (graceful shutdown)
 * - tool calls: `tools` is sent only when provided; streamed
 *   `delta.tool_calls` chunks are reassembled by index
 * - usage: captured as `ChatResult.usage` when the endpoint reports it
 *   (see parseUsage)
 */
export class LlmClient {
  /**
   * Every in-flight request. Multiple channels can generate concurrently
   * (the queue serializes per channel, not globally), so shutdown must
   * cancel all of them, not just the most recently started one.
   */
  private readonly active = new Set<AbortController>();

  constructor(private readonly opts: LlmClientOptions) {}

  /** Cancel all in-flight requests (graceful shutdown). */
  abort(): void {
    for (const c of this.active) c.abort();
    this.active.clear();
  }

  /**
   * Send a chat-completions request. When configured for streaming, content
   * (and, when the endpoint sends it, reasoning) deltas are handed to the
   * callbacks as they arrive. When `tools` is provided (and non-empty), it
   * is sent with `tool_choice: "auto"` and the result may carry `toolCalls`
   * instead of (or alongside) content. When `signal` is provided, aborting
   * it cancels the request (the channel-activity interruption, see
   * InterruptedError) — reported as an InterruptedError, not a timeout.
   */
  async chat(
    messages: ChatMessage[],
    callbacks?: StreamCallbacks,
    tools?: ToolSpec[],
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    if (signal?.aborted) {
      // The caller already aborted (the channel changed before this call
      // started): fail at once — no request goes out.
      throw new InterruptedError();
    }
    const cbs = callbacks ?? {};
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    // The caller's signal aborts the request in flight (the
    // channel-activity interruption): the fetch/stream cancels at once
    // instead of running to the timeout.
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const res = await this.request(messages, tools, controller);
      if (this.opts.stream) {
        return await this.readSse(res, cbs);
      }
      return await this.readJson(res, cbs);
    } catch (err) {
      if (signal?.aborted) {
        // The caller's signal fired (the channel-activity interruption):
        // the request was cancelled on purpose, whatever the underlying
        // abort error is.
        throw new InterruptedError();
      }
      if (isAbortError(err)) {
        throw new Error(`model request timed out after ${Math.round(this.opts.timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
      this.active.delete(controller);
    }
  }

  private async request(
    messages: ChatMessage[],
    tools: ToolSpec[] | undefined,
    controller: AbortController,
  ): Promise<Response> {
    let res: Response;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: messages.map(toWireMessage),
      stream: this.opts.stream,
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    try {
      res = await fetch(this.opts.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Sent even when the key is "none" (PLAN.md §6).
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err; // mapped to "timed out" by the caller
      throw new Error(`could not reach model endpoint ${this.opts.apiUrl}: ${errMsg(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `model endpoint returned HTTP ${res.status} ${res.statusText}${text ? `: ${truncate(text, 300)}` : ""}`,
      );
    }
    return res;
  }

  private async readJson(res: Response, callbacks: StreamCallbacks): Promise<ChatResult> {
    let data: SseMessageChunk;
    try {
      data = (await res.json()) as SseMessageChunk;
    } catch {
      throw new Error("model endpoint returned a non-JSON response");
    }
    if (data && typeof data === "object" && data.error) {
      const msg = typeof data.error === "string" ? data.error : data.error?.message ?? JSON.stringify(data.error);
      throw new Error(`model endpoint error: ${msg}`);
    }
    const message = data?.choices?.[0]?.message;
    if (!message) {
      throw new Error("malformed model response: missing choices[0].message");
    }
    // Non-stream reasoning arrives as one blob; hand it over whole so a
    // live preview can still show it (there is no "in real time" in this mode).
    const reasoning = reasoningOf(message);
    if (reasoning.length > 0) callbacks.onReasoning?.(reasoning);
    const result: ChatResult = {
      content: typeof message.content === "string" ? message.content : "",
      toolCalls: (message.tool_calls ?? []).map(normalizeToolCall).filter((c): c is ToolCall => c !== null),
    };
    if (reasoning.length > 0) result.reasoning = reasoning;
    const usage = parseUsage(data);
    if (usage) result.usage = usage;
    return result;
  }

  private async readSse(res: Response, callbacks: StreamCallbacks): Promise<ChatResult> {
    const body = res.body;
    if (!body) throw new Error("malformed model response: empty body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    // The model's thinking, accumulated from the streamed reasoning deltas
    // (the callback shows it live; the result keeps the whole thing for the
    // history).
    let fullReasoning = "";
    // Streamed tool calls arrive as fragments keyed by index; reassemble them.
    const calls = new Map<number, ToolCall>();
    // The endpoint's token count, when a chunk reports it (the final chunk
    // carries it; the last report wins).
    let usage: TokenUsage | undefined;
    const finish = (): ChatResult => {
      const result: ChatResult = { content: full, toolCalls: [...calls.values()] };
      if (usage) result.usage = usage;
      if (fullReasoning.length > 0) result.reasoning = fullReasoning;
      return result;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // skip comments / other fields
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          reader.cancel().catch(() => {});
          return finish();
        }
        if (!payload) continue;
        let json: SseDeltaChunk;
        try {
          json = JSON.parse(payload) as SseDeltaChunk;
        } catch {
          continue; // malformed SSE line: skip it
        }
        if (json && typeof json === "object" && json.error) {
          const msg =
            typeof json.error === "string" ? json.error : json.error?.message ?? JSON.stringify(json.error);
          throw new Error(`model endpoint error: ${msg}`);
        }
        const u = parseUsage(json);
        if (u) usage = u;
        const delta = json?.choices?.[0]?.delta;
        if (delta && typeof delta === "object") {
          const content = delta.content;
          if (typeof content === "string" && content.length > 0) {
            full += content;
            callbacks.onDelta?.(content);
          }
          const reasoning = reasoningOf(delta);
          if (reasoning.length > 0) {
            callbacks.onReasoning?.(reasoning);
            fullReasoning += reasoning;
          }
          for (const tc of delta.tool_calls ?? []) {
            // Fragments arrive incrementally: the first usually carries
            // id+name, later ones only arguments — accumulate field by
            // field instead of normalizing the whole object.
            if (!tc || typeof tc !== "object") continue;
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const acc = calls.get(idx) ?? { id: "", name: "", arguments: "" };
            if (typeof tc.id === "string" && tc.id.length > 0) acc.id = tc.id;
            const fn = tc.function;
            if (fn && typeof fn === "object") {
              if (typeof fn.name === "string") acc.name += fn.name;
              if (typeof fn.arguments === "string") {
                acc.arguments += fn.arguments;
              } else if (fn.arguments != null) {
                acc.arguments += JSON.stringify(fn.arguments);
              }
            }
            calls.set(idx, acc);
          }
        }
      }
    }
    return finish();
  }
}
