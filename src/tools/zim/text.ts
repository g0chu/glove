/**
 * Article HTML → clean plain text for the model.
 *
 * Handles the Wikipedia vector-skin pages stored in the ZIM archive:
 * picks the main content container, strips references, the table of
 * contents, edit spans and navigation boxes, keeps infobox table rows
 * as "cell | cell" lines, marks headings with "#", and renders math
 * elements as their alttext (the ZIM files store math as images).
 */
import {
  decodeEntities,
  firstElement,
  parseHtml,
  type DomNode,
  type ElementNode,
} from "../web/extract.js";

/** Tags whose content is never useful as text. */
const DROP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "iframe", "object",
  "embed", "canvas", "video", "audio", "form", "nav", "footer", "button",
  "select", "input",
]);

/** Class tokens that mark noise (references, TOC, edit spans, nav boxes…). */
const DROP_CLASS_TOKENS = new Set([
  "mw-editsection", "reflist", "references", "mw-references-wrap",
  "mw-cite-backlink", "mw-references-columns", "navbox", "metadata",
  "mw-empty-elt", "noprint", "printfooter", "toc", "vector-toc",
  "catlinks", "sidebar", "hatnote", "dablink",
  "navigation-not-searchable", "zim-footer",
]);

/** Tags that force a line break before/after their content. */
const BLOCK_TAGS = new Set([
  "p", "div", "section", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul",
  "ol", "table", "thead", "tbody", "tr", "pre", "blockquote", "figure",
  "hr", "header", "main", "article", "aside", "dl", "dt", "dd", "center",
]);

/** The class tokens of an element (lowercased, whitespace-split). */
function classTokens(el: ElementNode): Set<string> {
  const out = new Set<string>();
  for (const t of (el.attrs.class ?? "").split(/\s+/)) {
    if (t.length > 0) out.add(t.toLowerCase());
  }
  return out;
}

function dropped(el: ElementNode): boolean {
  if (DROP_TAGS.has(el.name)) return true;
  const tokens = classTokens(el);
  for (const t of tokens) {
    if (DROP_CLASS_TOKENS.has(t)) return true;
  }
  if (el.name === "sup" && tokens.has("reference")) return true;
  return false;
}

/**
 * Concatenated visible text of a node tree. Whitespace is collapsed but NOT
 * trimmed per fragment, so the natural spacing between inline pieces is kept
 * (`<a>hyrax</a> and the <i>porcupine</i>.` → "hyrax and the porcupine.",
 * not "hyrax and the porcupine ."). Callers trim at the edge.
 */
function inlineText(node: DomNode): string {
  if (node.type === "text") {
    return node.text.replace(/\s+/g, " ");
  }
  if (dropped(node)) return "";
  if (node.name === "math") {
    const alt = node.attrs.alttext?.trim();
    return alt ? `[${alt}]` : "";
  }
  let out = "";
  for (const child of node.children) out += inlineText(child);
  return out;
}

/** Serialize one node (and its subtree) into text lines. */
function serialize(node: DomNode, out: string[]): void {
  if (node.type === "text") {
    const t = decodeEntities(node.text).replace(/\s+/g, " ").trim();
    if (t.length > 0) out.push(t);
    return;
  }
  if (dropped(node)) return;
  if (node.name === "math") {
    const alt = node.attrs.alttext?.trim();
    if (alt) out.push(`[${alt}]`);
    return;
  }
  if (node.name === "tr") {
    const cells: string[] = [];
    for (const child of node.children) {
      if (child.type === "element" && (child.name === "td" || child.name === "th")) {
        const t = inlineText(child).trim();
        if (t.length > 0) cells.push(t);
      }
    }
    if (cells.length > 0) out.push(cells.join(" | "));
    return;
  }
  const isBlock = BLOCK_TAGS.has(node.name);
  if (isBlock) out.push("");
  if (/^h[1-6]$/.test(node.name)) {
    const t = inlineText(node).trim();
    if (t.length > 0) out.push(`${"#".repeat(Number(node.name[1]))} ${t}`);
  } else {
    // Consecutive inline content (text, links, emphasis, …) belongs on one
    // line; block children recurse and break the run. Concatenate (not
    // space-join) so punctuation hugs the preceding word.
    let run = "";
    const flush = (): void => {
      const t = run.replace(/\s+/g, " ").trim();
      if (t.length > 0) out.push(t);
      run = "";
    };
    for (const child of node.children) {
      if (child.type === "text") {
        run += decodeEntities(child.text).replace(/\s+/g, " ");
      } else if (child.type === "element" && !dropped(child) && !BLOCK_TAGS.has(child.name)) {
        run += inlineText(child);
      } else {
        flush();
        serialize(child, out);
      }
    }
    flush();
  }
  if (isBlock) out.push("");
}

/**
 * Extract readable text from an article page. Returns "" when nothing
 * readable is found. Tolerant of malformed HTML (the parser is lenient).
 */
export function articleText(html: string): string {
  if (html.trim().length === 0) return "";
  const root = parseHtml(html);
  const container =
    firstElement(root, (e) => e.attrs.id === "mw-content-text") ??
    firstElement(root, (e) => classTokens(e).has("mw-parser-output")) ??
    firstElement(root, (e) => e.name === "article") ??
    firstElement(root, (e) => e.name === "main") ??
    firstElement(root, (e) => e.name === "body") ??
    root;
  const out: string[] = [];
  serialize(container, out);
  // Drop headings whose section is empty (e.g. "References" after the
  // reference list was stripped): no non-empty line until the next heading.
  const kept: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const line = out[i];
    if (/^#{1,6} /.test(line)) {
      let j = i + 1;
      while (j < out.length && !/^#{1,6} /.test(out[j])) j++;
      const hasContent = out.slice(i + 1, j).some((l) => l.trim().length > 0);
      if (hasContent) kept.push(line);
    } else {
      kept.push(line);
    }
  }
  return kept
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
