/**
 * HTML -> (title, text) using a small, self-contained HTML parser.
 *
 * No dependencies: a lenient recursive-descent tokenizer builds a plain
 * tree (it tolerates unclosed tags, stray `<`, and malformed markup the way
 * browser parsers do, minus the full content-model rules), and the
 * extractors walk that tree. The goal is "readable main content for an LLM",
 * not pixel-perfect rendering: the best content container is
 * <article>, then <main>, then <body>; noise tags (script, nav, footer,
 * ...) are dropped; block-level tags become newlines; <pre> content is
 * preserved verbatim.
 */

export type DomNode =
  | { type: "element"; name: string; attrs: Record<string, string>; children: DomNode[] }
  | { type: "text"; text: string };

export type ElementNode = Extract<DomNode, { type: "element" }>;

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", copy: "\u00a9",
  reg: "\u00ae", trade: "\u2122", laquo: "\u00ab", raquo: "\u00bb",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019",
  deg: "\u00b0", plusmn: "\u00b1", times: "\u00d7", divide: "\u00f7",
};

/** Decode HTML entities (&amp;, &#39;, &#x27;, ...); unknown ones pass through. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/**
 * Case-insensitive index of the `</name` close tag at/after `from`, measured
 * in the ORIGINAL string. Tag names are ASCII so only A–Z fold; this keeps
 * the returned index valid, unlike `html.toLowerCase().indexOf(...)`, because
 * `toLowerCase()` can change a string's length (e.g. `İ` → `i`+U+0307).
 */
function findCloseTag(html: string, name: string, from: number): number {
  const needle = `</${name}`;
  const nlen = needle.length;
  for (let i = from; i + nlen <= html.length; i++) {
    let ok = true;
    for (let k = 0; k < nlen; k++) {
      const h = html.charCodeAt(i + k);
      const t = needle.charCodeAt(k);
      const hl = h >= 0x41 && h <= 0x5a ? h + 0x20 : h;
      if (hl !== t) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/** Find the end `>` of the tag starting at `lt`, honoring quoted values. */
function findTagEnd(html: string, lt: number): number {
  let quote: string | null = null;
  for (let i = lt + 1; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function parseTag(tagHtml: string): { name: string; attrs: Record<string, string>; selfClosing: boolean } | null {
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagHtml);
  if (!m) return null;
  const name = m[1].toLowerCase();
  let rest = tagHtml.slice(m[0].length);
  const selfClosing = /\/\s*$/.test(rest);
  const attrs: Record<string, string> = {};
  const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(rest)) !== null) {
    const key = am[1].toLowerCase();
    if (key === "/" ) continue;
    attrs[key] = am[2] ?? am[3] ?? am[4] ?? "";
    if (am[0].length === 0) attrRe.lastIndex++; // safety: prevent zero-width spin
  }
  return { name, attrs, selfClosing };
}

/** Parse *html* into a tree rooted at a synthetic `#root` element. */
export function parseHtml(html: string): DomNode {
  const root: ElementNode = { type: "element", name: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const pushText = (text: string): void => {
    const decoded = decodeEntities(text);
    if (decoded.length > 0) stack[stack.length - 1].children.push({ type: "text", text: decoded });
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      // doctype and other declarations: skip to the closing `>`
      const end = html.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(html.slice(lt, Math.min(n, lt + 200)));
      if (m) {
        const name = m[1].toLowerCase();
        for (let s = stack.length - 1; s > 0; s--) {
          if (stack[s].name === name) {
            stack.length = s;
            break;
          }
        }
        i = lt + m[0].length;
        continue;
      }
      i = lt + 1; // stray `</`
      continue;
    }
    if (!/^[a-zA-Z]/.test(html.slice(lt + 1, lt + 2))) {
      i = lt + 1; // stray `<` (e.g. "a < b" in text)
      continue;
    }
    const tagEnd = findTagEnd(html, lt);
    if (tagEnd === -1) {
      pushText(html.slice(lt)); // unterminated tag at EOF: keep as text
      break;
    }
    const tag = parseTag(html.slice(lt + 1, tagEnd));
    if (!tag) {
      i = tagEnd + 1;
      continue;
    }
    const node: ElementNode = { type: "element", name: tag.name, attrs: tag.attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (["script", "style", "noscript"].includes(tag.name)) {
      // Skip raw-text content up to the matching close tag (which will pop
      // the node). Malformed pages may never close it; then the remainder
      // is treated as script text, like a browser would.
      const close = findCloseTag(html, tag.name, tagEnd);
      i = close === -1 ? n : close;
      continue;
    }
    if (!VOID_TAGS.has(tag.name) && !tag.selfClosing) {
      stack.push(node);
    }
    i = tagEnd + 1;
  }
  return root;
}

/** All descendant text of *node*, concatenated (entities decoded). */
export function textOf(node: DomNode): string {
  if (node.type === "text") return node.text;
  let out = "";
  for (const child of node.children) out += textOf(child);
  return out;
}

/** Depth-first first element matching *predicate* (or null). */
export function firstElement(node: DomNode, predicate: (el: ElementNode) => boolean): ElementNode | null {
  if (node.type === "element") {
    if (predicate(node)) return node;
    for (const child of node.children) {
      const hit = firstElement(child, predicate);
      if (hit) return hit;
    }
  }
  return null;
}

const collapseWs = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Best-effort page title (<title>, then og:/twitter: meta tags). */
export function extractTitle(html: string): string {
  if (!html) return "";
  const root = parseHtml(html);
  const titleEl = firstElement(root, (e) => e.name === "title");
  const fromTitle = titleEl ? collapseWs(textOf(titleEl)) : "";
  if (fromTitle) return fromTitle;
  const metaSelectors: Array<(e: ElementNode) => boolean> = [
    (e) => e.name === "meta" && e.attrs["property"] === "og:title",
    (e) => e.name === "meta" && e.attrs["name"] === "twitter:title",
    (e) => e.name === "meta" && e.attrs["name"] === "title",
  ];
  for (const sel of metaSelectors) {
    const meta = firstElement(root, sel);
    const content = meta ? collapseWs(meta.attrs["content"] ?? "") : "";
    if (content) return content;
  }
  return "";
}

/** Tags whose content is never wanted in the extracted text. */
const STRIP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "math", "iframe",
  "object", "embed", "canvas", "video", "audio", "source", "track",
  "nav", "footer", "form", "button", "select", "textarea", "dialog",
  "link", "meta", "title", "base",
]);

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl",
  "dt", "fieldset", "figcaption", "figure", "footer", "header", "h1",
  "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "nav", "ol", "p",
  "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "ul",
]);

function prune(node: DomNode): DomNode {
  if (node.type !== "element") return node;
  if (STRIP_TAGS.has(node.name)) {
    return { type: "element", name: node.name, attrs: node.attrs, children: [] };
  }
  return { type: "element", name: node.name, attrs: node.attrs, children: node.children.map(prune) };
}

function serialize(node: DomNode, out: string[], preSlot: (text: string) => string): void {
  if (node.type === "text") {
    out.push(node.text);
    return;
  }
  if (node.name === "pre") {
    const raw = textOf(node).trim();
    if (raw) out.push("\n", preSlot(raw), "\n");
    return;
  }
  if (BLOCK_TAGS.has(node.name)) out.push("\n");
  for (const child of node.children) serialize(child, out, preSlot);
  if (BLOCK_TAGS.has(node.name)) out.push("\n");
}

/**
 * Extract the main content of a page as plain text (headings, paragraphs,
 * lists). Returns "" when nothing extractable remains.
 */
export function extractContent(html: string): string {
  if (!html) return "";
  const root = parseHtml(html);
  const candidate =
    firstElement(root, (e) => e.name === "article") ??
    firstElement(root, (e) => e.name === "main") ??
    firstElement(root, (e) => e.name === "body") ??
    root;
  const clean = prune(candidate);
  const pres: string[] = [];
  const parts: string[] = [];
  serialize(clean, parts, (raw) => {
    pres.push(raw);
    return `\u0000PRE${String(pres.length - 1)}\u0000`;
  });

  const lines = parts.join("").split("\n").map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim());
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    kept.push(line);
  }
  let text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  text = text.replace(/\u0000PRE(\d+)\u0000/g, (_m, i: string) => pres[Number(i)] ?? "");
  return text.trim();
}
