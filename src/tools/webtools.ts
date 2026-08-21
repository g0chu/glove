import type { ToolSpec } from "../llm/client.js";
import type { ToolRegistry } from "./executor.js";
import { argInt, argString } from "./executor.js";
import { FetchCache } from "./web/cache.js";
import { extractContent, extractTitle } from "./web/extract.js";
import { pinnedFetch } from "./web/fetcher.js";
import { searchDuckDuckGo, type SearchFetch } from "./web/search.js";
import { ToolError, type ResolveOptions } from "./web/ssrf.js";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export interface WebToolsOptions {
  /** Deadline per search/fetch call (covers the whole fetch, incl. redirects). */
  timeoutMs: number;
  /** Max response body bytes kept from a fetch. */
  fetchMaxBytes: number;
  /** Max redirect hops per fetch. */
  maxRedirects: number;
  /** Fetch-result cache entry lifetime. */
  cacheTtlMs: number;
  /** Fetch-result cache size cap. */
  cacheMaxEntries: number;
  /** Hard cap on search results (the tool arg is clamped to this). */
  searchMaxResults: number;
  /** Hard cap on characters in one tool result. */
  maxResultChars: number;
  /**
   * Escape hatch for tests only: when true, the SSRF guard no longer
   * refuses loopback/private addresses. Never enable in production.
   */
  allowPrivate?: boolean;
  /** Injectable resolver (tests only). */
  resolver?: ResolveOptions["resolver"];
  /** Injectable fetch for the search endpoint (tests only). */
  searchFetch?: SearchFetch;
}

/**
 * In-process web tools: DuckDuckGo search and page fetching (pinned-socket
 * HTTP with SSRF protection, main-content extraction, small result cache).
 * No sidecar, no HTTP hop: the bot process does the work directly.
 */
export class WebTools {
  private readonly cache: FetchCache<Record<string, unknown>>;
  private readonly active = new Set<AbortController>();

  constructor(private readonly opts: WebToolsOptions) {
    this.cache = new FetchCache(opts.cacheTtlMs, opts.cacheMaxEntries);
  }

  /** Hard-cap one tool result before it is handed to the model. */
  private cap(text: string): string {
    return text.length > this.opts.maxResultChars
      ? `${text.slice(0, this.opts.maxResultChars)}\n…[truncated]`
      : text;
  }

  /** Search the web; returns a formatted result list for the model. */
  async search(query: string, maxResults: number): Promise<string> {
    const limit = Math.min(maxResults, this.opts.searchMaxResults);
    const results = await searchDuckDuckGo(query, limit, {
      fetchImpl: this.opts.searchFetch,
      timeoutMs: this.opts.timeoutMs,
    });
    if (results.length === 0) return this.cap(`No web search results for "${query}".`);
    const lines = results.map((r, i) =>
      `${i + 1}. ${asString(r.title).trim()}\n   ${asString(r.url).trim()}\n   ${asString(r.snippet).trim()}`
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .trim(),
    );
    return this.cap(`Web search results for "${query}":\n\n${lines.join("\n\n")}`);
  }

  /** Fetch a page; returns title + main content for the model. */
  async fetchUrl(url: string): Promise<string> {
    const controller = new AbortController();
    this.active.add(controller);
    try {
      const cached = this.cache.get(url);
      if (cached) return this.format(url, cached);
      const fetched = await pinnedFetch(url, {
        timeoutMs: this.opts.timeoutMs,
        maxBytes: this.opts.fetchMaxBytes,
        maxRedirects: this.opts.maxRedirects,
        allowPrivate: this.opts.allowPrivate,
        resolver: this.opts.resolver,
        signal: controller.signal,
      });
      const html = fetched.body.toString("utf8");
      const content = extractContent(html);
      if (!content) {
        throw new ToolError("fetch succeeded but the page has no extractable text content");
      }
      const result: Record<string, unknown> = {
        title: extractTitle(html),
        content,
        final_url: fetched.finalUrl,
        method: "http",
        truncated: fetched.truncated,
      };
      this.cache.put(url, result);
      return this.format(url, result);
    } finally {
      this.active.delete(controller);
    }
  }

  /** Cancel all in-flight fetches (graceful shutdown). */
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

  private format(url: string, r: Record<string, unknown>): string {
    const content = asString(r.content);
    const title = asString(r.title).trim();
    const finalUrl = asString(r.final_url).trim() || url;
    const via = asString(r.method).trim() || "http";
    const truncated = r.truncated === true ? "yes" : "no";
    const header = title
      ? `Fetched ${finalUrl}\nTitle: ${title}\nMethod: ${via} | truncated: ${truncated}`
      : `Fetched ${finalUrl}\nMethod: ${via} | truncated: ${truncated}`;
    return this.cap(`${header}\n\n${content}`);
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
    "Fetch a web page and return its main content as text (plus the title). JavaScript-heavy pages may come back incomplete (plain HTTP fetch, no browser rendering). Only use URLs from web_search results or that the user gave.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the page to fetch." },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

/** Register the web tools on a registry, bound to one WebTools. */
export function registerWebTools(registry: ToolRegistry, tools: WebTools): void {
  registry.register(WEB_SEARCH_SPEC, (args) => tools.search(argString(args, "query"), argInt(args, "max_results", 5, 1, 10)));
  registry.register(WEB_FETCH_SPEC, (args) => tools.fetchUrl(argString(args, "url")));
}
