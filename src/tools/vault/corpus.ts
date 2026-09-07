/**
 * In-memory access to a vault's note corpus — the wiki2vault output: one
 * flat markdown note per Wikipedia article, plus an optional title index
 * (`index.tsv`: one `title<TAB>filename` line per note, written by the
 * build).
 *
 * The corpus is held as one big string plus a lowercased copy, so a query
 * is a handful of indexOf passes over cached bytes (no per-line
 * allocation): a ~170 MB index costs ~340 MB of process memory and scans
 * in well under a second. When the index is missing (a vault that is
 * still being built), the directory listing is used instead — the note's
 * file stem stands in for its title.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { errMsg } from "../../log.js";

/** How a query matched a note title. */
export type TitleMatch = "exact" | "prefix" | "substring";

/** One note in the corpus. */
export interface VaultHit {
  /** The note's title (its file stem in listing mode). */
  title: string;
  /** The note's file name without ".md". */
  file: string;
  match: TitleMatch;
}

export interface VaultCorpus {
  /** One line per note: "title<TAB>filename" (index) or "stem" (listing). */
  lines: string;
  /** Lowercased `lines` — the indexOf prefilter scans this. */
  low: string;
  /** Where the corpus came from. */
  source: "index" | "listing";
  /** Number of lines (notes). */
  count: number;
}

/** Search results plus a flag when a budgeted scan was cut short. */
export interface VaultSearchOutcome {
  results: VaultHit[];
  partial: boolean;
}

/** Max query length (chars). */
const MAX_QUERY_CHARS = 256;
/** Max hits a resolution scan will return (ambiguity listing). */
const MAX_RESOLUTION_HITS = 8;
/** How many hits to collect before ranking (the model's limit, times 4). */
const COLLECT_FACTOR = 4;
/** Date.now() is checked at most once per this many inspected lines. */
const BUDGET_CHECK_EVERY = 64;

/**
 * Normalize a title/query for comparison: lowercase (decomposed, combining
 * marks dropped, so "İzmir" and "Izmir" compare equal), no spaces/underscores.
 */
export function normTitle(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\s_\p{M}]+/gu, "");
}

// One-time lowercase table for the divergent-char scan (a per-char
// toLowerCase in a 355M-char loop allocates too much to be repeatable).
let CASE_TABLE: string[] | null = null;

/**
 * Lowercase a string LENGTH-PRESERVING (1:1 code-unit mapping): a char whose
 * lowercase is multi-code-unit maps to its first code unit ("İ" -> "i"), so
 * the result stays index-aligned with the input — indexOf positions in the
 * result are positions in the original string. (Plain toLowerCase drifts:
 * the real index has thousands of "İ", each adding a combining dot.)
 * The common case (no length-changing chars) is one native toLowerCase;
 * the divergent case rebuilds only around the rare offenders.
 */
export function lower1(s: string): string {
  const fast = s.toLowerCase();
  if (fast.length === s.length) return fast;
  if (CASE_TABLE === null) {
    CASE_TABLE = new Array(65536);
    for (let i = 0; i < 65536; i++) CASE_TABLE[i] = String.fromCharCode(i).toLowerCase();
  }
  const parts: string[] = [];
  let startFast = 0; // segment start in fast's coordinates
  let diverged = 0; // length-changing chars seen so far (the drift)
  for (let i = 0; i < s.length; i++) {
    const l = CASE_TABLE[s.charCodeAt(i)];
    if (l.length !== 1) {
      const iFast = i + diverged; // s[i]'s position in fast
      parts.push(fast.slice(startFast, iFast), l[0]);
      startFast = iFast + l.length; // skip fast's expansion of this char
      diverged++;
    }
  }
  parts.push(fast.slice(startFast));
  return parts.join("");
}

/** The raw query forms to prefilter with: spaces and underscores swapped. */
export function queryForms(query: string): string[] {
  const q = query.trim().replace(/[\s_]+/g, " ");
  if (q.length === 0) throw new Error("query must not be empty");
  if (q.length > MAX_QUERY_CHARS) throw new Error(`query too long (max ${MAX_QUERY_CHARS} chars)`);
  return [...new Set([q, q.replace(/ /g, "_"), q.replace(/_/g, " ")])].map((f) => lower1(f));
}

/**
 * Load the corpus of a vault directory: `index.tsv` when present, else the
 * directory listing. Throws a descriptive error for a missing/empty vault —
 * the tool layer surfaces it as an "Error: …" result.
 */
export async function loadCorpus(dir: string): Promise<VaultCorpus> {
  let stat: Stats;
  try {
    stat = await fs.stat(dir);
  } catch (e) {
    throw new Error(`vault directory ${dir} not found: ${errMsg(e)}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`vault path ${dir} is not a directory`);
  }
  try {
    const raw = (await fs.readFile(path.join(dir, "index.tsv"), "utf8")).replace(/\r/g, "");
    if (raw.trim().length === 0) throw new Error("index.tsv is empty");
    return makeCorpus(raw, "index");
  } catch {
    // No index yet (the vault may still be building): fall back to the
    // directory listing (the file stem stands in for the title).
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      throw new Error(`cannot list vault directory ${dir}: ${errMsg(e)}`);
    }
    const stems = names
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3))
      .filter((s) => s.length > 0);
    if (stems.length === 0) {
      throw new Error(`vault directory ${dir} has no notes (no index.tsv, no *.md files)`);
    }
    return makeCorpus(stems.join("\n"), "listing");
  }
}

function makeCorpus(lines: string, source: "index" | "listing"): VaultCorpus {
  let count = 1;
  for (let i = 0; i < lines.length; i++) {
    if (lines.charCodeAt(i) === 10) count++;
  }
  if (lines.endsWith("\n")) count--;
  // length-preserving lowercase: positions in `low` are positions in `lines`
  return { lines, low: lower1(lines), source, count };
}

/** Split one corpus line into its title and file (listing: title = file). */
function splitLine(line: string): { title: string; file: string } {
  const tab = line.indexOf("\t");
  if (tab < 0) return { title: line, file: line };
  return { title: line.slice(0, tab), file: line.slice(tab + 1) };
}

/**
 * Search note titles case-insensitively (spaces and underscores are
 * interchangeable): exact titles first, then prefixes, then substrings.
 * The scan is time-budgeted; `partial` is true when it was cut short.
 */
export async function searchTitles(
  corpus: VaultCorpus,
  query: string,
  limit: number,
  budgetMs: number,
): Promise<VaultSearchOutcome> {
  const nq = normTitle(query);
  const found = new Map<string, VaultHit>();
  const cap = Math.max(1, limit) * COLLECT_FACTOR;
  const t0 = Date.now();
  let partial = false;
  let inspected = 0;
  outer: for (const form of queryForms(query)) {
    let pos = corpus.low.indexOf(form);
    while (pos >= 0) {
      const lineStart = corpus.low.lastIndexOf("\n", pos - 1) + 1;
      let lineEnd = corpus.low.indexOf("\n", pos);
      if (lineEnd < 0) lineEnd = corpus.low.length;
      const { title, file } = splitLine(corpus.lines.slice(lineStart, lineEnd));
      const nt = normTitle(title);
      let rank: number | null = null;
      if (nt === nq) rank = 0;
      else if (nt.startsWith(nq)) rank = 1;
      else if (nt.includes(nq)) rank = 2;
      if (rank !== null) {
        const prev = found.get(file);
        if (prev === undefined || rank < matchRank(prev.match)) {
          found.set(file, { title, file, match: rankToMatch(rank) });
          if (found.size >= cap) break outer;
        }
      }
      inspected++;
      if ((inspected & (BUDGET_CHECK_EVERY - 1)) === 0 && Date.now() - t0 > budgetMs) {
        partial = true;
        break;
      }
      pos = corpus.low.indexOf(form, pos + 1);
    }
    if (partial) break;
  }
  const results = [...found.values()]
    .sort((a, b) => matchRank(a.match) - matchRank(b.match) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, Math.max(1, limit));
  return { results, partial };
}

/**
 * Resolve a note name to its line(s) by exact title match (case- and
 * space/underscore-insensitive). Returns 0, 1, or several hits (titles are
 * not unique — the build deduplicates FILE NAMES, not titles).
 */
export async function resolveTitle(corpus: VaultCorpus, name: string, budgetMs: number): Promise<VaultHit[]> {
  const nq = normTitle(name);
  const found = new Map<string, VaultHit>();
  const t0 = Date.now();
  let inspected = 0;
  outer: for (const form of queryForms(name)) {
    let pos = corpus.low.indexOf(form);
    while (pos >= 0 && found.size < MAX_RESOLUTION_HITS) {
      const lineStart = corpus.low.lastIndexOf("\n", pos - 1) + 1;
      let lineEnd = corpus.low.indexOf("\n", pos);
      if (lineEnd < 0) lineEnd = corpus.low.length;
      const { title, file } = splitLine(corpus.lines.slice(lineStart, lineEnd));
      if (normTitle(title) === nq) {
        found.set(file, { title, file, match: "exact" });
      }
      inspected++;
      if ((inspected & (BUDGET_CHECK_EVERY - 1)) === 0 && Date.now() - t0 > budgetMs) break outer;
      pos = corpus.low.indexOf(form, pos + 1);
    }
  }
  return [...found.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function matchRank(m: TitleMatch): number {
  return m === "exact" ? 0 : m === "prefix" ? 1 : 2;
}

function rankToMatch(rank: number): TitleMatch {
  return rank === 0 ? "exact" : rank === 1 ? "prefix" : "substring";
}

/** A parsed note: the frontmatter fields (if any) and the body markdown. */
export interface NoteParts {
  /** The frontmatter's `title` field, when present. */
  title: string;
  fields: Record<string, string>;
  /** The note's body (frontmatter stripped, leading newlines dropped). */
  body: string;
}

/**
 * Split a note's leading YAML-ish frontmatter (the block written by the
 * build: `---\nkey: value\n---\n\nbody`). A note without a well-formed
 * block comes back whole as body with no fields.
 */
export function splitFrontmatter(md: string): NoteParts {
  const fields: Record<string, string> = {};
  let body = md;
  if (md.startsWith("---\n")) {
    const end = md.indexOf("\n---\n", 4);
    if (end > 0) {
      for (const line of md.slice(4, end).split("\n")) {
        const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (m) fields[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      }
      body = md.slice(end + 5);
    }
  }
  return { title: fields.title ?? "", fields, body: body.replace(/^\n+/, "") };
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;

/**
 * Extract the note's outgoing [[wikilinks]] (the link targets, deduplicated
 * in order of appearance; `[[target|alias]]` yields `target`). Capped.
 */
export function extractWikilinks(md: string, cap: number = 200): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(md)) !== null) {
    const t = m[1].trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}
