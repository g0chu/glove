/**
 * The vault tool family: search and read notes of an offline Wikipedia
 * vault of markdown notes (the wiki2vault build: one flat note per article,
 * frontmatter with title/path, internal links as [[wikilinks]]). Runs
 * in-process against the directory (no server, no sidecar); the note corpus
 * (the title index, or the directory listing when the index is not there
 * yet) is loaded lazily on first use and dropped on shutdown.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ToolSpec } from "../llm/client.js";
import { errMsg } from "../log.js";
import { ToolRegistry, argString, argInt } from "./executor.js";
import {
  loadCorpus,
  searchTitles,
  resolveTitle,
  splitFrontmatter,
  extractWikilinks,
  type VaultCorpus,
} from "./vault/corpus.js";
import { browseWiki, wikiReadOptions, WIKI_READ_PROPERTIES, type WikiReadOptions } from "./wiki.js";
import { scanBody, type BodyScanOptions } from "./vault/body.js";

/** How much of a note's body "abstract" mode returns (chars). */
const ABSTRACT_CHARS = 1000;
/** Max wikilinks vault_links reports. */
const MAX_LINKS_SHOWN = 50;

export interface VaultToolsOptions {
  /** Path to the vault directory (flat *.md notes, optional index.tsv). */
  dir: string;
  /** Hard cap on search results (the arg is clamped to it). */
  maxResults: number;
  /** Time budget (ms) for the title scan and the body scan. */
  scanBudgetMs: number;
  /** Max characters of note text returned by vault_read (mode "full"). */
  maxTextChars: number;
  /**
   * Whether the web family is registered too: the no-match hint may then
   * point at web_search. Never suggest a tool that is not available.
   */
  webSearchAvailable?: boolean;
  /** The ripgrep binary for the body scan (default "rg"). */
  rgPath?: string;
  /** Test-only: replace the body scan (never used in production). */
  bodyScan?: BodyScanOptions["fake"];
}

export class VaultTools {
  private corpusPromise: Promise<VaultCorpus> | null = null;
  private readonly activeChildren = new Set<ChildProcess>();
  private stopped = false;

  constructor(private readonly opts: VaultToolsOptions) {}

  /** The corpus, loaded lazily; a failed load is retried on the next call. */
  private corpus(): Promise<VaultCorpus> {
    if (this.stopped) {
      return Promise.reject(new Error("the vault tools are shutting down"));
    }
    if (this.corpusPromise === null) {
      this.corpusPromise = loadCorpus(this.opts.dir).catch((e: unknown) => {
        this.corpusPromise = null;
        throw e;
      });
    }
    return this.corpusPromise;
  }

  /** Search note titles (exact/prefix/substring) and bodies (time-budgeted). */
  async search(query: string, maxResults: number): Promise<string> {
    const corpus = await this.corpus();
    const limit = Math.max(1, Math.min(maxResults, this.opts.maxResults));
    const titles = await searchTitles(corpus, query, limit, this.opts.scanBudgetMs);
    const bodies = await scanBody(this.opts.dir, query, this.opts.scanBudgetMs, limit, {
      rgPath: this.opts.rgPath,
      fake: this.opts.bodyScan,
      onChild: (c) => {
        if (this.stopped) c.kill();
        else {
          this.activeChildren.add(c);
          c.once("close", () => this.activeChildren.delete(c));
        }
      },
    });
    if (titles.results.length === 0 && bodies.files.length === 0) {
      const hint = this.opts.webSearchAvailable ? ", or use web_search" : "";
      return `No note in the offline Wikipedia vault matches "${query}" (titles and bodies). Try a shorter or differently spelled query${hint}.`;
    }
    const lines: string[] = [];
    if (titles.results.length > 0) {
      lines.push("Titles:");
      titles.results.forEach((r, i) => {
        const fileNote = r.file !== r.title ? ` [file: ${r.file}]` : "";
        lines.push(`${i + 1}. ${r.title}${fileNote}`);
      });
    }
    if (bodies.files.length > 0) {
      lines.push("Bodies (notes containing the query):");
      for (const f of bodies.files) lines.push(`- ${f}`);
    }
    const head =
      `Offline Wikipedia vault (${corpus.count.toLocaleString("en-US")} notes` +
      `${corpus.source === "listing" ? ", no title index yet" : ""}) — matches for "${query}":`;
    const partial =
      titles.partial || bodies.partial ? " (scan was time-limited; refine the query for more)" : "";
    return `${head}${partial}\n${lines.join("\n")}\nUse vault_read with the exact title (or file) to read one.`;
  }

  /**
   * Read one note by name: a direct file match first (the name may be the
   * file stem, e.g. a deduplicated "Title (2)"), else an exact-title
   * resolution (0 = no match, 1 = read, several = an ambiguity error).
   */
  async read(note: string, mode: "full" | "abstract" = "full", options?: WikiReadOptions): Promise<string> {
    const n = note.trim();
    if (n.length === 0) throw new Error("note must not be empty");
    if (n.includes("/") || n.includes("\\") || n.includes("..")) {
      throw new Error("note names are flat: no path separators or '..'");
    }
    const corpus = await this.corpus();
    const file = await this.resolveNote(corpus, n);
    const raw = await this.readNoteFile(file);
    const { title, fields, body } = splitFrontmatter(raw);
    const name = title || file;
    const kb = Math.max(1, Math.ceil(raw.length / 1024));
    if (options) {
      return `Wikipedia vault: ${name} (${file}.md, ${kb} KB)\n\n${options.mode === "abstract" ? renderFields(fields) + "\n\n" : ""}${browseWiki(body, options, this.opts.maxTextChars)}`;
    }
    if (mode === "abstract") {
      const abs = body.slice(0, ABSTRACT_CHARS);
      const more = body.length > ABSTRACT_CHARS ? " [abstract cut — use mode \"full\" for the whole note]" : "";
      return `Wikipedia vault: ${name} (${file}.md, ${kb} KB) — abstract\n\n${renderFields(fields)}\n\n${abs}${more}`;
    }
    const truncated = body.length > this.opts.maxTextChars;
    const text = truncated ? body.slice(0, this.opts.maxTextChars) : body;
    return `Wikipedia vault: ${name} (${file}.md, ${kb} KB)${truncated ? " [truncated]" : ""}\n\n${text}`;
  }

  /** Configured output ceiling for browsing reads. */
  get maxReadChars(): number { return this.opts.maxTextChars; }

  /** List one note's outgoing [[wikilinks]] (deduplicated, capped). */
  async links(note: string): Promise<string> {
    const n = note.trim();
    if (n.length === 0) throw new Error("note must not be empty");
    if (n.includes("/") || n.includes("\\") || n.includes("..")) {
      throw new Error("note names are flat: no path separators or '..'");
    }
    const corpus = await this.corpus();
    const file = await this.resolveNote(corpus, n);
    const raw = await this.readNoteFile(file);
    const { title } = splitFrontmatter(raw);
    const name = title || file;
    const ws = extractWikilinks(raw);
    if (ws.length === 0) {
      return `Wikipedia vault: ${name} — no [[wikilinks]] in this note.`;
    }
    const shown = ws.slice(0, MAX_LINKS_SHOWN);
    return (
      `Wikipedia vault: ${name} — ${ws.length} wikilink(s)${ws.length > MAX_LINKS_SHOWN ? " (showing the first 50)" : ""}:\n` +
      shown.map((w, i) => `${i + 1}. ${w}`).join("\n") +
      `\nFollow one with vault_read.`
    );
  }

  /** Drop the loaded corpus and kill an in-flight body scan (shutdown). */
  abort(): void {
    this.stopped = true;
    this.corpusPromise = null;
    for (const child of this.activeChildren) child.kill();
    this.activeChildren.clear();
  }

  /** Resolve a note name to its file stem (direct file, else exact title). */
  private async resolveNote(corpus: VaultCorpus, n: string): Promise<string> {
    try {
      await fs.access(path.join(this.opts.dir, `${n}.md`));
      return n;
    } catch {
      // Not a direct file: resolve by exact title through the corpus.
    }
    const hits = await resolveTitle(corpus, n, this.opts.scanBudgetMs);
    if (hits.length === 0) {
      throw new Error(`no note matching "${n}" in the vault (use vault_search to find it)`);
    }
    if (hits.length > 1) {
      const list = hits
        .slice(0, 5)
        .map((h) => `"${h.title}"${h.file !== h.title ? ` (file "${h.file}")` : ""}`)
        .join(", ");
      throw new Error(`ambiguous note "${n}": ${list}${hits.length > 5 ? ", …" : ""} — use one of them exactly`);
    }
    return hits[0].file;
  }

  private async readNoteFile(file: string): Promise<string> {
    try {
      return await fs.readFile(path.join(this.opts.dir, `${file}.md`), "utf8");
    } catch (e) {
      throw new Error(`cannot read note "${file}": ${errMsg(e)}`);
    }
  }
}

function renderFields(fields: Record<string, string>): string {
  const keys = Object.keys(fields);
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}: ${fields[k]}`).join("\n");
}

export const VAULT_SEARCH_SPEC: ToolSpec = {
  name: "vault_search",
  description: "Search offline Wikipedia note titles and literal text in markdown files, case-insensitive. Returns ranked title matches and matching file stems in separate lists; scans may be time-limited. Use vault_read for established facts.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 256, description: "A note title or part of one, or text to find inside notes (e.g. \"Albert Einstein\", \"photosynthesis\")." },
      max_results: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Requested results per list (default 5); clamped to 1-10 and the configured cap." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const VAULT_READ_SPEC: ToolSpec = {
  name: "vault_read",
  description: "Read an offline Wikipedia note as paginated markdown. Resolves file stems first, then exact titles (case/space/underscore-insensitive); ambiguous titles require a listed file stem. Flat note names only; path separators and '..' are rejected. Frontmatter is omitted except in abstract mode. Choose mode intro for introductory text, sections for heading IDs, section with an ID/heading for its text, or full for the article. offset/max_chars paginate; query finds excerpts. Cite the note title.",
  parameters: {
    type: "object",
    properties: {
      note: { type: "string", minLength: 1, description: "The exact note title (e.g. \"Albert Einstein\") or file stem." },
      ...WIKI_READ_PROPERTIES,
    },
    required: ["note"],
    additionalProperties: false,
  },
};

export const VAULT_LINKS_SPEC: ToolSpec = {
  name: "vault_links",
  description: "List up to 50 deduplicated unanchored [[wikilink]] targets from an offline note, in appearance order. Same flat-name resolution as vault_read; follow a target with vault_read.",
  parameters: {
    type: "object",
    properties: {
      note: { type: "string", minLength: 1, description: "The exact note title (e.g. \"Albert Einstein\") or file stem." },
    },
    required: ["note"],
    additionalProperties: false,
  },
};

/** Register the vault tools on a registry, bound to one VaultTools. */
export function registerVaultTools(registry: ToolRegistry, tools: VaultTools): void {
  registry.register(VAULT_SEARCH_SPEC, (args) => tools.search(argString(args, "query"), argInt(args, "max_results", 5, 1, 10)));
  registry.register(VAULT_READ_SPEC, (args) => {
    const options = wikiReadOptions(args, tools.maxReadChars);
    return tools.read(argString(args, "note"), options.mode === "abstract" ? "abstract" : "full", options);
  });
  registry.register(VAULT_LINKS_SPEC, (args) => tools.links(argString(args, "note")));
}
