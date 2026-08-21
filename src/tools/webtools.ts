import { errMsg } from "../log.js";
import type { ToolSpec } from "../llm/client.js";
import type { ToolRegistry } from "./executor.js";
import { argInt, argString } from "./executor.js";

/** Hard cap on one tool result before it is handed to the model. */
const MAX_RESULT_CHARS = 200_000;

export interface WebToolsOptions {
  baseUrl: string;
  timeoutMs: number;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function cap(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
}

/**
 * Client for the webtools sidecar (Docker, 127.0.0.1 by default):
 * web search (DuckDuckGo via `ddgs`) and page fetching (plain HTTP with
 * readability extraction, headless-Chromium fallback for JS-heavy pages).
 * The sidecar is the only component that touches untrusted web content.
 */
export class WebToolsClient {
  private readonly active = new Set<AbortController>();

  constructor(private readonly opts: WebToolsOptions) {}

  /** Search the web; returns a formatted result list for the model. */
  async search(query: string, maxResults: number): Promise<string> {
    const data = await this.post("/search", { query, max_results: maxResults });
    const results = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
    if (results.length === 0) return cap(`No web search results for "${query}".`);
    const lines = results.map((r, i) =>
      `${i + 1}. ${asString(r.title).trim()}\n   ${asString(r.url).trim()}\n   ${asString(r.snippet).trim()}`
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .trim(),
    );
    return cap(`Web search results for "${query}":\n\n${lines.join("\n\n")}`);
  }

  /** Fetch a page; returns title + main content (markdown) for the model. */
  async fetchUrl(url: string): Promise<string> {
    const data = await this.post("/fetch", { url });
    const content = asString(data.content);
    const title = asString(data.title).trim();
    const finalUrl = asString(data.final_url).trim() || url;
    const via = asString(data.method).trim() || "http";
    const truncated = data.truncated === true ? "yes" : "no";
    const header = title
      ? `Fetched ${finalUrl}\nTitle: ${title}\nMethod: ${via} | truncated: ${truncated}`
      : `Fetched ${finalUrl}\nMethod: ${via} | truncated: ${truncated}`;
    return cap(`${header}\n\n${content}`);
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
        throw new Error(`webtools request timed out after ${Math.round(this.opts.timeoutMs / 1000)}s`);
      }
      throw new Error(`could not reach webtools at ${this.opts.baseUrl}: ${errMsg(err)}`);
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data) {
      const msg = data && typeof data.error === "string" ? data.error : `webtools returned HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }
}

/** OpenAI-compatible function specs for the web tools. */
export const WEB_SEARCH_SPEC: ToolSpec = {
  name: "web_search",
  description:
    "Search the web (DuckDuckGo). Returns a list of results, each with a title, URL, and snippet. Use it to find current information, sources, or candidate pages to read with web_fetch.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: { type: "integer", description: "How many results to return (1-10, default 5)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const WEB_FETCH_SPEC: ToolSpec = {
  name: "web_fetch",
  description:
    "Fetch a web page and return its main content as markdown (head, plus title). Tries a plain HTTP fetch first and falls back to a headless browser for JavaScript-heavy pages. Only use URLs from web_search results or that the user gave.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the page to fetch." },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

/** Register the web tools on a registry, bound to one client. */
export function registerWebTools(registry: ToolRegistry, client: WebToolsClient): void {
  registry.register(WEB_SEARCH_SPEC, (args) => client.search(argString(args, "query"), argInt(args, "max_results", 5, 1, 10)));
  registry.register(WEB_FETCH_SPEC, (args) => client.fetchUrl(argString(args, "url")));
}
