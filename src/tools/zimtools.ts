/**
 * The ZIM tool family: search and read articles from a local offline
 * Wikipedia archive (a ZIM file, e.g. the en.wikipedia "all nopic" dump).
 * Runs in-process against the file directly (no server, no sidecar); the
 * reader is opened lazily on first use and aborted with the rest of the
 * tool stack on shutdown.
 */
import type { ToolSpec } from "../llm/client.js";
import { ToolRegistry, argString, argInt } from "./executor.js";
import { browseWiki, wikiReadOptions, WIKI_READ_PROPERTIES, type WikiReadOptions } from "./wiki.js";
import { ZimReader } from "./zim/reader.js";

export interface ZimToolsOptions {
  /** Path to the ZIM archive file. */
  file: string;
  /** Hard cap on wikipedia_search results (the arg is clamped to it). */
  maxResults: number;
  /** Time budget (ms) for a full-archive title scan. */
  scanBudgetMs: number;
  /** Max characters of article text returned by wikipedia_read. */
  maxTextChars: number;
  /**
   * Whether the web family is registered too: the no-match hint may then
   * point at web_search. Never suggest a tool that is not available.
   */
  webSearchAvailable?: boolean;
}

export class ZimTools {
  private readerPromise: Promise<ZimReader> | null = null;

  constructor(private readonly opts: ZimToolsOptions) {}

  /** The reader, opened lazily; a failed open is retried on the next call. */
  private reader(): Promise<ZimReader> {
    if (this.readerPromise === null) {
      this.readerPromise = ZimReader.open(this.opts.file, {
        scanBudgetMs: this.opts.scanBudgetMs,
      }).catch((e: unknown) => {
        this.readerPromise = null;
        throw e;
      });
    }
    return this.readerPromise;
  }

  /** Search article titles/paths; returns a short formatted result list. */
  async search(query: string, maxResults: number): Promise<string> {
    const reader = await this.reader();
    const limit = Math.max(1, Math.min(maxResults, this.opts.maxResults));
    const { results, partial } = await reader.search(query, limit);
    if (results.length === 0) {
      const hint = this.opts.webSearchAvailable ? ", or use web_search" : "";
      return `No article in the local Wikipedia archive matches "${query}". Try a shorter or differently spelled query${hint}.`;
    }
    const lines = results.map((r, i) => {
      const nsNote = r.ns === "C" ? "" : ` (namespace "${r.ns}")`;
      const redir = r.redirect ? " [redirect]" : "";
      return `${i + 1}. ${r.title}${nsNote}${redir}`;
    });
    const head = `Local Wikipedia (offline archive) — ${results.length} match(es) for "${query}"${partial ? " (scan was time-limited; refine the query for more)" : ""}:`;
    return `${head}\n${lines.join("\n")}\nUse wikipedia_read with the exact title to read one.`;
  }

  /** Read one article's text by exact title (or wiki-style path). */
  async read(title: string, options?: WikiReadOptions): Promise<string> {
    const reader = await this.reader();
    const art = await reader.read(title, options ? Number.MAX_SAFE_INTEGER : this.opts.maxTextChars);
    const note = art.truncated ? " [truncated]" : "";
    return `Wikipedia: ${art.title} (local archive, ${Math.ceil(art.bytes / 1024)} KB HTML)${note}\n\n${options ? browseWiki(art.text, options, this.opts.maxTextChars) : art.text}`;
  }

  /** Configured output ceiling for browsing reads. */
  get maxReadChars(): number { return this.opts.maxTextChars; }

  /** Close the archive (wired into shutdown); later calls reopen it. */
  abort(): void {
    const p = this.readerPromise;
    this.readerPromise = null;
    void p?.then((r) => r.close()).catch(() => {});
  }
}

export const ZIM_SEARCH_SPEC: ToolSpec = {
  name: "wikipedia_search",
  description: "Search offline Wikipedia article titles and paths, case-insensitive: exact, prefix, then substring. Returns titles and redirect markers; scans may be time-limited. Does not search article bodies. Use wikipedia_read for established facts.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 256, description: "An article title or part of one (e.g. \"Albert Einstein\", \"relativity\")." },
      max_results: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Requested results (default 5); clamped to 1-10 and the configured cap." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const ZIM_READ_SPEC: ToolSpec = {
  name: "wikipedia_read",
  description: "Read offline Wikipedia as paginated plain text, with references/navigation removed. Resolves redirects; accepts exact titles or wiki paths with spaces/underscores. Use outline, section or query for targeted reads. Cite the article title.",
  parameters: {
    type: "object",
    properties: {
      ...WIKI_READ_PROPERTIES,
      title: { type: "string", description: "The exact article title (e.g. \"Albert Einstein\") or wiki path (e.g. \"Albert_Einstein\")." },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

/** Register the ZIM tools on a registry, bound to one ZimTools. */
export function registerZimTools(registry: ToolRegistry, tools: ZimTools): void {
  registry.register(ZIM_SEARCH_SPEC, (args) => tools.search(argString(args, "query"), argInt(args, "max_results", 5, 1, 10)));
  registry.register(ZIM_READ_SPEC, (args) => tools.read(argString(args, "title"), wikiReadOptions(args, tools.maxReadChars)));
}
