"""HTML -> (title, markdown/text) with a fallback chain.

1. ``trafilatura`` — best effort, returns markdown when available
2. ``readability-lxml`` — main content as an HTML fragment -> text
3. raw ``lxml`` ``text_content()`` of the whole document

Every stage tolerates the others failing (malformed HTML, missing deps);
the function returns the first non-empty result, or "" when nothing works.
"""
from __future__ import annotations

import re

from lxml import etree
from lxml import html as lxml_html

_WS_RUN = re.compile(r"[ \t\r\f\v]+")
_BLANK_RUN = re.compile(r"\n{3,}")


def _clean(text: str) -> str:
    text = _WS_RUN.sub(" ", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    text = _BLANK_RUN.sub("\n\n", text)
    return text.strip()


def extract_title(html_text: str) -> str:
    """Best-effort page title (<title>, then og:/twitter: meta tags)."""
    try:
        root = lxml_html.fromstring(html_text)
    except etree.LxmlError:
        return ""
    for selector in (
        "//title/text()",
        '//meta[@property="og:title"]/@content',
        '//meta[@name="twitter:title"]/@content',
        '//meta[@name="title"]/@content',
    ):
        values = root.xpath(selector)
        for value in values:
            cleaned = " ".join(str(value).split())
            if cleaned:
                return cleaned
    return ""


def _fragment_to_text(fragment: str) -> str:
    """Convert an HTML fragment (possibly multiple top-level nodes) to text."""
    try:
        root = lxml_html.fromstring(f"<div>{fragment}</div>")
        return _clean(root.text_content() or "")
    except etree.LxmlError:
        return ""


def extract_content(html_text: str, url: str = "") -> str:
    """Extract the main content of a page as markdown/plain text."""
    if not html_text:
        return ""
    # 1) trafilatura (markdown)
    try:
        import trafilatura

        md = trafilatura.extract(
            html_text,
            url=url or None,
            include_formatting=True,
            include_comments=False,
            include_tables=True,
        )
        if md and md.strip():
            return md.strip()
    except Exception:
        pass
    # 2) readability-lxml (main content fragment -> text)
    try:
        from readability import Document

        doc = Document(html_text)
        # readability-lxml exposes `content` as a method; older "readability"
        # versions expose it as a property. Handle both.
        content_attr = doc.content
        fragment = content_attr() if callable(content_attr) else content_attr
        fragment = fragment or ""
        text = _fragment_to_text(fragment)
        if text:
            return text
    except Exception:
        pass
    # 3) raw whole-document text
    try:
        root = lxml_html.fromstring(html_text)
        text = _clean(root.text_content() or "")
        if text:
            return text
    except etree.LxmlError:
        pass
    return ""
