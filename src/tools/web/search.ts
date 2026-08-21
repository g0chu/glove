/**
 * DuckDuckGo search via the public HTML endpoint (no API key).
 *
 * The endpoint (`https://html.duckduckgo.com/html/`) returns a plain-HTML
 * results page: each result has an `a.result__a` (title + link) and an
 * `a.result__snippet`. Links often come back as DuckDuckGo redirect URLs
 * (`/l/?uddg=<real-url>`) which are unwrapped here. The fetch is injectable
 * so tests run hermetically.
 */
import { ToolError } from "./ssrf.js";
import { parseHtml, textOf, type DomNode, type ElementNode } from "./extract.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Injectable fetch (tests pass a fake; production uses global fetch). */
export type SearchFetch = (url: string, init?: RequestInit) => Promise<Response>;

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const DDG_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

/**
 * Normalize a raw search row to `{title, url, snippet}`. Accepts rows with
 * `href`/`url`/`link` and `body`/`snippet`/`description`; rows without a
 * usable URL are dropped (null).
 */
export function normalizeResult(row: unknown): SearchResult | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const url = r["href"] ?? r["url"] ?? r["link"];
  if (typeof url !== "string" || url.trim().length === 0) return null;
  const title = (typeof r["title"] === "string" && r["title"].trim() ? r["title"] : url).trim();
  const snippet = String(r["body"] ?? r["snippet"] ?? r["description"] ?? "").trim();
  return { title, url: url.trim(), snippet };
}

/** Unwrap DuckDuckGo redirect links (`//duckduckgo.com/l/?uddg=<url>`). */
export function unwrapDdgHref(href: string): string {
  let h = href.trim();
  if (h.startsWith("//")) h = `https:${h}`;
  try {
    const u = new URL(h, "https://duckduckgo.com/");
    if (u.hostname.endsWith("duckduckgo.com") && (u.pathname === "/l/" || u.pathname === "/l")) {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return uddg;
    }
    return u.toString();
  } catch {
    return href.trim();
  }
}

function hasClass(el: { attrs: Record<string, string> }, name: string): boolean {
  return (el.attrs["class"] ?? "").split(/\s+/).includes(name);
}

/**
 * Run a web search and return normalized rows (possibly empty).
 * Raises ToolError on transport failure.
 */
export async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  opts: { fetchImpl?: SearchFetch; timeoutMs?: number } = {},
): Promise<SearchResult[]> {
  if (!query.trim()) throw new ToolError("query must not be empty");
  const limit = Math.max(1, Math.floor(maxResults));
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const res = await fetchImpl(`${DDG_HTML_ENDPOINT}?q=${encodeURIComponent(query.trim())}`, {
    method: "GET",
    headers: {
      "User-Agent": DDG_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en",
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) {
    throw new ToolError(`web search failed: HTTP ${res.status} from DuckDuckGo`);
  }
  const html = await res.text();
  const root = parseHtml(html);

  const titles: Array<{ title: string; url: string }> = [];
  const snippets: string[] = [];
  // Walk the tree in document order and collect result__a / result__snippet
  // elements; they appear one per result, in the same order.
  const walk = (node: DomNode): void => {
    if (node.type !== "element") return;
    const el: ElementNode = node;
    if (hasClass(el, "result__a")) {
      const href = el.attrs["href"] ?? "";
      titles.push({ title: textOf(el).trim() || href, url: unwrapDdgHref(href) });
    } else if (hasClass(el, "result__snippet")) {
      snippets.push(textOf(el).trim());
    }
    for (const child of el.children) walk(child);
  };
  walk(root);

  const results: SearchResult[] = [];
  for (let i = 0; i < Math.min(limit, titles.length); i++) {
    results.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippets[i] ?? "",
    });
  }
  return results;
}
