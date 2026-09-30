/** Shared, bounded browsing of rendered offline Wikipedia articles. */
import type { ToolSpec } from "../llm/client.js";
import { argInt, argOptionalString } from "./executor.js";
import { lower1 } from "./vault/corpus.js";

/** Optional selectors for a targeted article read. */
export interface WikiReadOptions {
  mode?: "full" | "abstract" | "outline";
  section?: string;
  query?: string;
  offset?: number;
  maxChars?: number;
}

/** Schema shared by the ZIM and vault read tools. */
export const WIKI_READ_PROPERTIES: NonNullable<ToolSpec["parameters"]["properties"]> = {
  mode: { type: "string", enum: ["full", "abstract", "outline"], description: "full (default), abstract (first 1000 characters), or outline (section IDs and headings). Prefer outline before reading a long article." },
  section: { type: "string", description: "Section ID from outline, or exact heading (case-insensitive); includes subsections. Use lead for text before the first heading." },
  query: { type: "string", description: "Find literal text within this article or selected section, case-insensitive. Returns short matching excerpts with offsets instead of the whole text." },
  offset: { type: "integer", description: "Zero-based character offset within the selected text (default 0); use the next offset returned by a previous read." },
  max_chars: { type: "integer", description: "Output text budget in characters (default 3000, capped by the configured tool limit)." },
};

/** Validate model-supplied browsing arguments. */
export function wikiReadOptions(args: Record<string, unknown>, cap: number): WikiReadOptions {
  const mode = argOptionalString(args, "mode");
  if (mode !== undefined && mode !== "full" && mode !== "abstract" && mode !== "outline") {
    throw new Error('argument "mode" must be "full", "abstract" or "outline"');
  }
  const query = argOptionalString(args, "query");
  if (query && query.length > 256) throw new Error("query too long (max 256 chars)");
  return {
    mode, section: argOptionalString(args, "section"), query,
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
  for (let i = 0; i < out.length; i++) {
    const next = out.slice(i + 1).find((s) => s.level <= out[i].level);
    if (next) out[i].end = next.start;
  }
  return out;
}

/** Render an outline, a section/page slice, or literal matching excerpts. */
export function browseWiki(text: string, options: WikiReadOptions, cap: number): string {
  const budget = Math.max(1, Math.min(options.maxChars ?? 3000, cap));
  const offset = Math.max(0, options.offset ?? 0);
  const headings = sections(text);
  if (options.mode === "outline") {
    const outline = ["lead: text before the first heading", ...headings.map((s) => `${s.id}: ${"#".repeat(s.level)} ${s.title}`)].join("\n");
    return page(outline, offset, budget);
  }
  let selected = text;
  if (options.section) {
    if (options.section.toLowerCase() === "lead") selected = text.slice(0, headings[0]?.start ?? text.length);
    else {
      const matches = headings.filter((s) => s.id === options.section || s.title.toLowerCase() === options.section?.toLowerCase());
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
