import { errMsg, truncate } from "../log.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClientOptions {
  apiUrl: string;
  apiKey: string;
  model: string;
  stream: boolean;
  timeoutMs: number;
}

interface SseDeltaChunk {
  error?: { message?: string } | string;
  choices?: Array<{ delta?: { content?: unknown } }>;
}

interface SseMessageChunk {
  error?: { message?: string } | string;
  choices?: Array<{ message?: { content?: unknown } }>;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Minimal OpenAI-compatible Chat Completions client (native fetch).
 * - streaming: SSE `data: {...}` deltas + `data: [DONE]`
 * - non-streaming: `choices[0].message.content`
 * - per-request timeout via AbortController (covers the whole stream)
 * - `abort()` cancels every in-flight request (graceful shutdown)
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
   * Send a chat-completions request. When configured for streaming, deltas
   * are handed to `onDelta` as they arrive and the full text is returned.
   */
  async chat(messages: ChatMessage[], onDelta?: (delta: string) => void): Promise<string> {
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.request(messages, controller);
      if (this.opts.stream) {
        return await this.readSse(res, onDelta ?? (() => {}));
      }
      return await this.readJson(res);
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`model request timed out after ${Math.round(this.opts.timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
    }
  }

  private async request(messages: ChatMessage[], controller: AbortController): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.opts.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Sent even when the key is "none" (PLAN.md §6).
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          stream: this.opts.stream,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err; // mapped to "timed out" by the caller
      throw new Error(`could not reach model endpoint ${this.opts.apiUrl}: ${errMsg(err)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `model endpoint returned HTTP ${res.status} ${res.statusText}${body ? `: ${truncate(body, 300)}` : ""}`,
      );
    }
    return res;
  }

  private async readJson(res: Response): Promise<string> {
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
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("malformed model response: missing choices[0].message.content");
    }
    return content;
  }

  private async readSse(res: Response, onDelta: (delta: string) => void): Promise<string> {
    const body = res.body;
    if (!body) throw new Error("malformed model response: empty body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
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
          return full;
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
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          full += delta;
          onDelta(delta);
        }
      }
    }
    return full;
  }
}
