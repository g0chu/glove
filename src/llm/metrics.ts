import type { ChatMessage, ChatResult, StreamCallbacks, ToolSpec } from "./client.js";

/** One model request (the same shape `LlmClient.chat` and the tool loop's `chat` dep take). */
export type ChatFn = (
  messages: ChatMessage[],
  callbacks?: StreamCallbacks,
  tools?: ToolSpec[],
) => Promise<ChatResult>;

/**
 * The token usage of one turn, accumulated from the model calls that report
 * it. The counts are the endpoint's own (its tokenizer), not an estimate:
 * `input`/`output` sum every call of the turn (the reply's tool rounds, the
 * compaction summarizer, the chime decision alike), and `peakInput` is the
 * largest prompt one call carried — the channel's context size on the wire.
 * Calls that report no usage (endpoints without usage reporting) are
 * ignored, so a silent endpoint leaves all counters at zero.
 */
export class TurnTokens {
  /** Total prompt (input) tokens across the turn's model calls. */
  input = 0;
  /** Total completion (output) tokens across the turn's model calls. */
  output = 0;
  /** The largest prompt (input tokens) one call carried — 0 when unmeasured. */
  peakInput = 0;
  /** How many model calls reported usage. */
  calls = 0;

  /** Wrap a chat function so every call it makes reports its usage here. */
  track(chat: ChatFn): ChatFn {
    return async (messages, callbacks, tools) => {
      const res = await chat(messages, callbacks, tools);
      if (res.usage) {
        this.input += res.usage.input;
        this.output += res.usage.output;
        this.peakInput = Math.max(this.peakInput, res.usage.input);
        this.calls += 1;
      }
      return res;
    };
  }
}

/** One llama-server slot as `GET /slots` reports it (the fields the bot uses). */
export interface ServerSlot {
  /** The slot id (llama-server's parallel slot index). */
  id: number;
  /** The slot's context window in tokens. */
  ctxSize: number;
  /**
   * The total tokens (prompt + completion) of the slot's most recent
   * request — how full the context is right now (0 when the slot has not
   * processed a request yet), or null when this build does not report it.
   */
  lastRequestTokens: number | null;
  /** True while the slot is generating. */
  processing: boolean;
}

/** The llama-server's context state, aggregated over all its slots. */
export interface ServerMetrics {
  slots: ServerSlot[];
  /** Sum of the slots' context windows (tokens). */
  ctxSize: number;
  /**
   * Sum of the slots' most-recent-request token counts (the server's
   * current context use), or null when any slot does not report its count.
   */
  lastRequestTokens: number | null;
  /** True while any slot is generating. */
  processing: boolean;
}

export interface LlamaMetricsOptions {
  /** The llama-server base URL (e.g. http://localhost:8080); /slots is fetched from it. */
  baseUrl: string;
  /** Per-probe timeout (ms). */
  timeoutMs: number;
  /** Test-only: inject the fetch (production uses the native one). */
  fetchImpl?: typeof fetch;
}

/**
 * The completion headroom kept out of the context window when the compaction
 * budget is derived from it automatically: a request needs the prompt *and*
 * the generated answer inside the window, so the budget must stay that far
 * below it. (An answer longer than the headroom overflows the request — the
 * bot then catches the overflow and recovers, so a slightly small headroom
 * is recoverable, not fatal.)
 */
export const COMPACT_OUTPUT_RESERVE_TOKENS = 4096;

/**
 * The compaction budget for a server context window of `ctxSize` tokens:
 * the window minus the completion headroom (COMPACT_OUTPUT_RESERVE_TOKENS).
 * Null when the window is too small to derive a usable budget from.
 */
export function deriveCompactionBudget(ctxSize: number): number | null {
  const budget = ctxSize - COMPACT_OUTPUT_RESERVE_TOKENS;
  return budget >= 128 ? budget : null;
}

const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;

/**
 * The llama-server's own metric endpoint (GET /slots): the model side's
 * ground truth for its context window and how full it is right now.
 * Best-effort by design — every failure (unreachable, timeout, non-2xx,
 * unexpected shape) resolves to null instead of throwing, so a broken
 * metrics endpoint can never kill a turn.
 */
export class LlamaMetrics {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: LlamaMetricsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Probe the server's context state; null when it could not be read. */
  async snapshot(): Promise<ServerMetrics | null> {
    const url = this.opts.baseUrl.replace(/\/+$/, "") + "/slots";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET", signal: controller.signal });
    } catch {
      return null; // unreachable, DNS, or the timeout: metrics stay off
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null; // not JSON
    }
    if (!Array.isArray(body)) return null;
    const slots: ServerSlot[] = [];
    for (const raw of body) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      const ctxSize = asInt(s.n_ctx);
      if (ctxSize === null) continue; // a slot without a usable context size
      slots.push({
        id: asInt(s.id) ?? slots.length,
        ctxSize,
        lastRequestTokens: asInt(s.n_prompt_tokens),
        // Builds differ: newer ones report is_processing, older ones a state string.
        processing: s.is_processing === true || s.state === "busy" || s.state === "processing",
      });
    }
    if (slots.length === 0) return null;
    const allReported = slots.every((s) => s.lastRequestTokens !== null);
    return {
      slots,
      ctxSize: slots.reduce((a, s) => a + s.ctxSize, 0),
      lastRequestTokens: allReported ? slots.reduce((a, s) => a + (s.lastRequestTokens ?? 0), 0) : null,
      processing: slots.some((s) => s.processing),
    };
  }
}
