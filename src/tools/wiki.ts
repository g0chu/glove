/** Shared, bounded browsing of rendered offline Wikipedia articles. */
import type { ToolSpec } from "../llm/client.js";
import { argInt, argOptionalString } from "./executor.js";
import { lower1 } from "./vault/corpus.js";

/** Optional selectors for a targeted article read. */
export interface WikiReadOptions {
  mode?: "full" | "abstract" | "outline" | "intro" | "sections" | "section";
  section?: string;
  query?: string;
  offset?: number;
  maxChars?: number;
}

/** Schema shared by the ZIM and vault read tools. */
export const WIKI_READ_PROPERTIES: Record<string, unknown> = {
  mode: { type: "string", enum: ["full", "intro", "sections", "section", "abstract", "outline"], default: "full", description: "Choose what to see: intro returns the introduction before article sections; sections lists heading IDs and titles only; section returns the named section and its subsections (requires section); full returns paginated article text. Legacy outline equals sections; abstract returns the first 1000 characters. sections/outline ignore section/query; query filters selected text in other modes." },
  section: { type: "string", description: "Outline ID or exact case-insensitive heading, including subsections. lead selects the page introduction, including an initial title heading. Duplicate headings require an ID." },
  query: { type: "string", maxLength: 256, description: "Literal case-insensitive text to find in the selected article/section (max 256 characters). Returns up to 10 excerpts per call." },
  offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0, description: "Zero-based character offset in selected text, or rendered outline in outline mode. Continue with the returned next offset." },
  max_chars: { type: "integer", minimum: 1, description: "Text/excerpt character budget (default 3000, clamped to 1 and the configured cap). Headers and pagination notes are extra." },
};

/** Validate model-supplied browsing arguments. */
export function wikiReadOptions(args: Record<string, unknown>, cap: number): WikiReadOptions {
  const mode = argOptionalString(args, "mode");
  if (mode !== undefined && !["full", "abstract", "outline", "intro", "sections", "section"].includes(mode)) {
    throw new Error('argument "mode" must be "full", "abstract" or "outline", or "intro", "sections", "section"');
  }
  const section = argOptionalString(args, "section");
  if (mode === "section" && !section) throw new Error("section mode requires a section ID or heading; use mode sections first");
  if (mode === "intro" && section) throw new Error("intro mode cannot select a section");
  const query = argOptionalString(args, "query");
  if (query && query.length > 256) throw new Error("query too long (max 256 chars)");
  return {
    mode: mode as WikiReadOptions["mode"], section, query,
    offset: argInt(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    maxChars: argInt(args, "max_chars", Math.min(3000, cap), 1, cap),
  };
}

interface Section { id: string; title: string; level: number; start: number; end: number }

function sections(text: string): Section[] {
  const out: Section[] = [];
  let fence = "";
  let offset = 0;
  for (const line of text.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = "";
    } else if (!fence) {
      const h = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line);
      if (h) out.push({ id: String(out.length + 1), title: h[2], level: h[1].length, start: offset, end: text.length });
    }
    offset += line.length + 1;
  }
  const following: Section[] = [];
  for (let i = out.length - 1; i >= 0; i--) {
    while (following.length && following[following.length - 1].level > out[i].level) following.pop();
    out[i].end = following[following.length - 1]?.start ?? text.length;
    following.push(out[i]);
  }
  return out;
}

/** Render an outline, a section/page slice, or literal matching excerpts. */
export function browseWiki(text: string, options: WikiReadOptions, cap: number): string {
  const budget = Math.max(1, Math.min(options.maxChars ?? 3000, cap));
  const offset = Math.max(0, options.offset ?? 0);
  const headings = sections(text);
  if (options.mode === "outline" || options.mode === "sections") {
    const outline = ["lead: page introduction (including an initial title heading)", ...headings.map((s) => `${s.id}: ${"#".repeat(s.level)} ${s.title}`)].join("\n");
    return page(outline, offset, budget);
  }
  if (options.mode === "section" && !options.section) throw new Error("section mode requires a section ID or heading; use mode sections first");
  if (options.mode === "intro" && options.section) throw new Error("intro mode cannot select a section");
  let selected = text;
  // An initial H1 is commonly the page title, not the first article section.
  const introEnd = (headings[0]?.level === 1
    ? headings[1]
    : headings[0])?.start ?? text.length;
  if (options.mode === "intro") selected = text.slice(0, introEnd);
  if (options.section) {
    if (options.section.toLowerCase() === "lead") selected = text.slice(0, introEnd);
    else {
      const byId = headings.find((s) => s.id === options.section);
      const matches = byId ? [byId] : headings.filter((s) => s.title.toLowerCase() === options.section?.toLowerCase());
      if (matches.length !== 1) throw new Error(matches.length ? "ambiguous section heading; use an outline section ID" : "section not found; use mode outline to list sections");
      selected = text.slice(matches[0].start, matches[0].end);
    }
  }
  if (options.query) {
    const query = lower1(options.query);
    const low = lower1(selected);
    let pos = low.indexOf(query, offset);
    if (pos < 0) return `No matches at or after offset ${offset}.`;
    const excerpts: string[] = [];
    let used = 0;
    while (pos >= 0 && used < budget && excerpts.length < 10) {
      const start = Math.max(offset, pos - Math.min(120, Math.floor((budget - used) / 3)));
      const end = Math.min(selected.length, pos + query.length + 180, start + budget - used);
      excerpts.push(`[offset ${start}; match ${pos}]\n${selected.slice(start, end)}`);
      used += end - start;
      // Advance past the match even when a very small budget cuts its excerpt.
      pos = low.indexOf(query, Math.max(end, pos + query.length));
    }
    return excerpts.join("\n\n") + (pos >= 0 ? `\n[more matches; next offset ${pos}]` : "\n[no more matches]");
  }
  if (options.mode === "abstract") selected = selected.slice(0, 1000);
  return page(selected, offset, budget);
}

function page(text: string, offset: number, budget: number): string {
  const end = Math.min(text.length, offset + budget);
  if (offset >= text.length) return `[end of text; ${text.length} characters]`;
  return `[characters ${offset}-${end} of ${text.length}]\n${text.slice(offset, end)}` +
    (end < text.length ? `\n[truncated; next offset ${end}]` : "\n[end of text]");
}

/** Dedicated browsing operations; modes stay internal to the renderer. */
export const WIKI_OPERATIONS = ["read", "intro", "sections", "section"] as const;

/** Build a mode-free schema for one Wikipedia browsing operation. */
export function wikiToolSpec(prefix: string, key: string, operation: typeof WIKI_OPERATIONS[number], source: string): ToolSpec {
  const properties: Record<string, unknown> = {
    [key]: { type: "string", minLength: 1, description: "Exact article title or backend article identifier." },
    offset: WIKI_READ_PROPERTIES.offset,
    max_chars: WIKI_READ_PROPERTIES.max_chars,
  };
  if (operation !== "sections") properties.query = WIKI_READ_PROPERTIES.query;
  if (operation === "section") properties.section = WIKI_READ_PROPERTIES.section;
  const descriptions = {
    read: "Read paginated article text; query returns matching excerpts.",
    intro: "Get only the page introduction before article sections; query returns matching excerpts.",
    sections: "List section IDs and headings without article body text. Use the section tool to read one.",
    section: "Read one section and its subsections by ID or exact heading; query returns matching excerpts.",
  };
  return {
    name: `${prefix}_${operation}`,
    description: `${source} ${descriptions[operation]} offset/max_chars paginate. Cite the article title.`,
    parameters: { type: "object", properties, required: operation === "section" ? [key, "section"] : [key], additionalProperties: false },
  };
}

/** Validate arguments and apply the operation selected by the tool name. */
export function wikiToolOptions(args: Record<string, unknown>, cap: number, key: string, operation: typeof WIKI_OPERATIONS[number]): WikiReadOptions {
  const allowed = [key, "offset", "max_chars", ...(operation !== "sections" ? ["query"] : []), ...(operation === "section" ? ["section"] : [])];
  for (const name of Object.keys(args)) {
    if (!allowed.includes(name)) throw new Error(`unsupported argument "${name}"; choose the dedicated Wikipedia tool`);
  }
  return wikiReadOptions({ ...args, mode: operation === "read" ? "full" : operation }, cap);
}
