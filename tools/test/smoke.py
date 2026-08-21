"""Smoke tests for the Python sidecars (webtools + filetools).

Run with:  python tools/test/smoke.py   (plain asserts, no framework)

Covers: ssrf guard (fake resolver), workspace path confinement (symlink
escape), HTML extraction (fixture), search normalization, fetch cache,
all /file/* endpoints via TestClient (temp workspace), web /search with an
injected backend, web /fetch against a local http.server (SSRF_ALLOW_PRIVATE),
the browser fallback (injected fake browser), /health, and the 400
{"ok": false, "error"} failure shape.
"""
from __future__ import annotations

import http.server
import sys
import tempfile
import threading
import time
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_DIR))

from fastapi.testclient import TestClient  # noqa: E402

from server.cache import FetchCache  # noqa: E402
from server.config import Config  # noqa: E402
from server.errors import ToolError  # noqa: E402
from server.file.paths import resolve_in_workspace  # noqa: E402
from server import ssrf  # noqa: E402
from server.app import create_app  # noqa: E402
from server.web.extract import extract_content, extract_title  # noqa: E402
from server.web.search import normalize_result, search as search_backend  # noqa: E402

PASS = 0


def ok(name: str) -> None:
    global PASS
    PASS += 1
    print(f"  ok  {name}")


def make_cfg(**overrides) -> Config:
    base = dict(
        role="webtools",
        host="127.0.0.1",
        port=0,
        fetch_timeout_s=5.0,
        fetch_max_bytes=1_000_000,
        max_redirects=5,
        cache_ttl_s=300.0,
        cache_max_entries=16,
        search_max_results=10,
        browser_enabled=False,
        browser_timeout_ms=5_000,
        browser_concurrency=1,
        workspace_dir="/tmp/never-created",
        read_max_bytes=1_000_000,
        write_max_bytes=1_000_000,
        list_max_entries=500,
        search_max_results_cap=500,
        search_max_files=1_000,
        search_max_file_bytes=5_000_000,
        line_max_chars=500,
        ssrf_allow_private=False,
    )
    base.update(overrides)
    return Config(**base)


# ---------------------------------------------------------------- ssrf --
def test_ssrf():
    # Blocked ranges, via an injected fake resolver.
    for url, ip in [
        ("http://127.0.0.1:9999/x", "127.0.0.1"),            # loopback
        ("http://10.1.2.3/", "10.1.2.3"),                     # RFC1918
        ("http://172.16.0.1/", "172.16.0.1"),                 # RFC1918
        ("http://192.168.1.10/", "192.168.1.10"),             # RFC1918
        ("http://100.64.0.1/", "100.64.0.1"),                 # CGNAT
        ("http://169.254.169.254/latest/meta-data/", "169.254.169.254"),  # cloud metadata
        ("http://[::1]/", "::1"),                             # v6 loopback
        ("http://[fd00::1]/", "fd00::1"),                     # unique-local
        ("http://[fe80::1]/", "fe80::1"),                     # link-local
    ]:
        try:
            ssrf.resolve_url(url, resolver=lambda h, p, ip=ip: [ip])
            raise AssertionError(f"{url} should have been blocked")
        except ToolError:
            pass
    ok("ssrf: loopback/RFC1918/CGNAT/metadata/link-local/unique-local blocked")

    for url in ["ftp://example.com/", "file:///etc/passwd", "gopher://x/"]:
        try:
            ssrf.resolve_url(url, resolver=lambda h, p: ["93.184.216.34"])
            raise AssertionError(f"{url} should have been blocked")
        except ToolError as e:
            assert "scheme" in str(e), str(e)
    ok("ssrf: non-http(s) schemes rejected")

    # Public address: pinned, port/path/query preserved.
    r = ssrf.resolve_url("https://example.com/a/b?q=1&x=2", resolver=lambda h, p: ["93.184.216.34"])
    assert (r.ip, r.port, r.host) == ("93.184.216.34", 443, "example.com"), r
    assert r.path == "/a/b?q=1&x=2", r.path
    r2 = ssrf.resolve_url("http://example.com:8080/p", resolver=lambda h, p: ["93.184.216.34"])
    assert r2.port == 8080 and r2.scheme == "http", r2
    ok("ssrf: public addresses pinned, custom port and query preserved")

    # Mixed records: any blocked address refuses the whole URL.
    try:
        ssrf.resolve_url("http://example.com/", resolver=lambda h, p: ["93.184.216.34", "127.0.0.1"])
        raise AssertionError("mixed public+private record should be refused")
    except ToolError:
        pass
    ok("ssrf: mixed public/private records refused (strict)")

    # Escape hatch (tests only).
    r3 = ssrf.resolve_url("http://127.0.0.1:8377/", allow_private=True, resolver=lambda h, p: ["127.0.0.1"])
    assert r3.ip == "127.0.0.1"
    ok("ssrf: SSRF_ALLOW_PRIVATE escape hatch works")

    try:
        ssrf.resolve_url("http://no-such-host.invalid/", resolver=lambda h, p: [])
        raise AssertionError("empty resolution should fail")
    except ToolError:
        pass
    ok("ssrf: unresolvable host reported")


# ---------------------------------------------------------------- paths --
def test_paths(tmp: Path):
    ws = tmp / "ws"
    outside = tmp / "outside"
    outside.mkdir(parents=True)
    outside_file = outside / "secret.txt"
    outside_file.write_text("top secret", encoding="utf-8")
    (ws / "sub").mkdir(parents=True)
    (ws / "sub" / "notes.txt").write_text("hello", encoding="utf-8")

    assert resolve_in_workspace(ws, None) == ws
    assert resolve_in_workspace(ws, "sub/notes.txt").is_file()
    assert resolve_in_workspace(ws, "/sub/notes.txt").is_file(), "leading / must be treated as workspace-relative"
    assert resolve_in_workspace(ws, ".").is_dir()
    ok("paths: relative, absolute-looking, and root paths resolve inside")

    for bad in ["../outside/secret.txt", "..", "../../etc", "sub/../../outside/secret.txt"]:
        try:
            resolve_in_workspace(ws, bad)
            raise AssertionError(f"{bad!r} should escape and be rejected")
        except ToolError:
            pass
    ok("paths: .. traversal rejected")

    (ws / "link-file").symlink_to(outside_file)
    (ws / "link-dir").symlink_to(outside)
    for bad in ["link-file", "link-dir", "link-dir/secret.txt"]:
        try:
            resolve_in_workspace(ws, bad)
            raise AssertionError(f"symlink escape {bad!r} should be rejected")
        except ToolError:
            pass
    ok("paths: symlinks escaping the workspace rejected")


# -------------------------------------------------------------- extract --
FIXTURE = """
<!doctype html>
<html>
<head><title>  Example Page Title  </title></head>
<body>
  <header><nav>menu menu menu</nav></header>
  <article>
    <h1>The Heading</h1>
    <p>First paragraph with <a href="/x">a link</a> and some facts.</p>
    <p>Second paragraph.</p>
  </article>
  <footer>footer junk footer junk</footer>
</body>
</html>
"""


def test_extract():
    title = extract_title(FIXTURE)
    assert title == "Example Page Title", title
    content = extract_content(FIXTURE, "https://example.com/")
    assert "First paragraph" in content, content[:200]
    assert "Second paragraph" in content, content[:200]
    assert "footer junk" not in content, "main content should exclude footer"
    ok("extract: title + main content from fixture HTML")

    no_article = "<html><head><title>T</title></head><body><div>plain body text</div></body></html>"
    assert "plain body text" in extract_content(no_article, "https://x/")
    assert extract_title("<html><head><title>Meta Only</title></head></html>") == "Meta Only"
    assert extract_title("<html><body></body></html>") == ""
    assert extract_content("<html><body></body></html>", "") == ""
    ok("extract: fallbacks and empty input")


# ---------------------------------------------------------------- search --
FAKE_RESULTS = [
    {"title": "First", "href": "https://first.example/", "body": "snip one"},
    {"title": "Second", "href": "https://second.example/", "body": "snip two"},
    {"no": "url"},
]


def fake_search(query: str, max_results: int):
    return FAKE_RESULTS[:max_results]


def test_search():
    row = normalize_result({"title": "T", "href": "https://a.example/", "body": "snip"})
    assert row == {"title": "T", "url": "https://a.example/", "snippet": "snip"}, row
    assert normalize_result({"title": "x"}) is None, "row without URL is dropped"
    assert normalize_result("not a dict") is None

    results = search_backend("q", 5, fake_search)
    assert results == [
        {"title": "First", "url": "https://first.example/", "snippet": "snip one"},
        {"title": "Second", "url": "https://second.example/", "snippet": "snip two"},
    ], results
    assert len(search_backend("q", 1, fake_search)) == 1, "max_results caps the list"

    def boom(q, n):
        raise RuntimeError("ddgs exploded")

    try:
        search_backend("q", 3, boom)
        raise AssertionError("backend failure should become ToolError")
    except ToolError as e:
        assert "exploded" in str(e), e
    ok("search: normalization, capping, backend errors")


# ---------------------------------------------------------------- cache --
def test_cache():
    c = FetchCache(ttl_s=0.2, max_entries=3)
    c.put("a", 1)
    assert c.get("a") == 1
    c.put("b", 2)
    c.put("c", 3)
    c.put("d", 4)  # evicts "a" (oldest)
    assert c.get("a") is None and c.get("b") == 2 and c.get("d") == 4
    time.sleep(0.25)
    assert c.get("b") is None, "entries expire after TTL"
    ok("cache: TTL expiry and max-entries eviction")


# --------------------------------------------------------- file endpoints --
def test_file_endpoints(tmp: Path):
    ws = tmp / "workspace"
    ws.mkdir()
    client = TestClient(create_app(cfg=make_cfg(role="filetools", workspace_dir=str(ws))))

    h = client.get("/health")
    assert h.status_code == 200 and h.json() == {"ok": True, "role": "filetools"}, h.json()
    ok("filetools: /health")

    # write (flat + with create_dirs)
    r = client.post("/file/write", json={"path": "a/b/notes.md", "content": "line1\nline2\nline3\n", "create_dirs": True})
    assert r.status_code == 200 and r.json()["bytes_written"] == 18, r.json()
    r = client.post("/file/write", json={"path": "missing-dir/x.txt", "content": "x"})
    assert r.status_code == 400 and r.json()["ok"] is False and "create_dirs" in r.json()["error"], r.json()
    r = client.post("/file/write", json={"path": "a/b/notes.md", "content": "line1\nline2\nline3\n"})
    assert r.status_code == 200 and r.json()["bytes_written"] == 18
    ok("filetools: write (create_dirs, parent-missing error, overwrite)")

    # list
    r = client.post("/file/list", json={})
    data = r.json()
    assert r.status_code == 200 and data["ok"] is True, data
    names = {(e["name"], e["type"]) for e in data["entries"]}
    assert ("a", "dir") in names and data["path"] == ".", data
    r = client.post("/file/list", json={"path": "a"})
    entry = [e for e in r.json()["entries"] if e["name"] == "b"][0]
    assert entry["type"] == "dir"
    r = client.post("/file/list", json={"path": "a/b"})
    file_entry = r.json()["entries"][0]
    assert file_entry["name"] == "notes.md" and file_entry["type"] == "file"
    assert file_entry["size"] == 18 and "mtime" in file_entry, file_entry
    r = client.post("/file/list", json={"path": "nope"})
    assert r.status_code == 400 and "not a directory" in r.json()["error"], r.json()
    ok("filetools: list (dirs first, size+mtime, error shape)")

    # read (full, window, offset past end, binary refusal)
    r = client.post("/file/read", json={"path": "a/b/notes.md"})
    data = r.json()
    assert data["content"] == "line1\nline2\nline3\n" and data["size"] == 18 and data["offset"] == 0
    assert data["bytes_read"] == 18 and data["truncated"] is False, data
    r = client.post("/file/read", json={"path": "a/b/notes.md", "offset": 6, "limit": 5})
    data = r.json()
    assert data["content"] == "line2" and data["offset"] == 6 and data["bytes_read"] == 5 and data["truncated"] is True, data
    r = client.post("/file/read", json={"path": "a/b/notes.md", "offset": 999})
    assert r.status_code == 400 and "past the end" in r.json()["error"], r.json()
    (ws / "bin.dat").write_bytes(b"\x00\x01\x02")
    r = client.post("/file/read", json={"path": "bin.dat"})
    assert r.status_code == 400 and "binary" in r.json()["error"], r.json()
    r = client.post("/file/read", json={"path": "ghost.txt"})
    assert r.status_code == 400 and "not a file" in r.json()["error"], r.json()
    ok("filetools: read (windows, truncation, binary, errors)")

    # edit (single, replace_all, missing old_text, empty new_text)
    r = client.post("/file/edit", json={"path": "a/b/notes.md", "old_text": "line1", "new_text": "LINE1"})
    assert r.status_code == 200 and r.json()["replacements"] == 1, r.json()
    r = client.post("/file/edit", json={"path": "a/b/notes.md", "old_text": "line2\nline3\n", "new_text": ""})
    assert r.status_code == 200 and r.json()["replacements"] == 1
    assert (ws / "a/b/notes.md").read_text() == "LINE1\n"
    (ws / "many.txt").write_text("x x x", encoding="utf-8")
    r = client.post("/file/edit", json={"path": "many.txt", "old_text": "x", "new_text": "y", "replace_all": True})
    assert r.json()["replacements"] == 3 and (ws / "many.txt").read_text() == "y y y"
    r = client.post("/file/edit", json={"path": "many.txt", "old_text": "zzz", "new_text": "q"})
    assert r.status_code == 400 and "not found" in r.json()["error"], r.json()
    ok("filetools: edit (exact span, replace_all, empty new_text, not-found)")

    # search (regex, literal, truncated flag, bad regex)
    for i in range(5):
        (ws / f"file{i}.txt").write_text(f"alpha {i}\nbeta\n", encoding="utf-8")
    r = client.post("/file/search", json={"pattern": "alpha"})
    data = r.json()
    assert len(data["matches"]) == 5 and data["truncated"] is False, data
    assert all(m["line"] == 1 for m in data["matches"])
    m0 = [m for m in data["matches"] if m["file"] == "file0.txt"][0]
    assert m0["text"] == "alpha 0", m0
    r = client.post("/file/search", json={"pattern": "alpha", "max_results": 2})
    data = r.json()
    assert len(data["matches"]) == 2 and data["truncated"] is True, data
    r = client.post("/file/search", json={"pattern": "alpha 1", "literal": True})
    assert len(r.json()["matches"]) == 1, r.json()
    r = client.post("/file/search", json={"pattern": "[", "path": "a"})
    assert r.status_code == 400 and "regular expression" in r.json()["error"], r.json()
    ok("filetools: search (regex, literal, capping, bad regex)")

    # delete (file, dir tree, missing, root guard)
    r = client.post("/file/delete", json={"path": "many.txt"})
    assert r.json()["deleted"] == "file" and not (ws / "many.txt").exists()
    r = client.post("/file/delete", json={"path": "bin.dat"})
    assert r.json()["deleted"] == "file"
    r = client.post("/file/delete", json={"path": "a"})
    assert r.json()["deleted"] == "dir" and not (ws / "a").exists()
    r = client.post("/file/delete", json={"path": "ghost"})
    assert r.status_code == 400 and "not found" in r.json()["error"], r.json()
    r = client.post("/file/delete", json={"path": "."})
    assert r.status_code == 400 and "root" in r.json()["error"], r.json()
    ok("filetools: delete (file, dir tree, errors, root guard)")

    # malformed body -> same 400 shape
    r = client.post("/file/read", content=b"{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 400 and r.json()["ok"] is False and "error" in r.json(), r.json()
    r = client.post("/file/write", json={"path": "x.txt"})
    assert r.status_code == 400 and r.json()["ok"] is False, r.json()
    ok("filetools: malformed/invalid bodies get the 400 error shape")


# ---------------------------------------------------------- web endpoints --
PAGE = (
    "<!doctype html><html><head><title>Local Page</title></head>"
    "<body><article><h1>Heading</h1>"
    "<p>fetchable sentence one with facts.</p><p>fetchable sentence two.</p>"
    "</article></body></html>"
)


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self.server.hits += 1  # type: ignore[attr-defined]
        if self.path == "/redir":
            self.send_response(302)
            self.send_header("Location", "/page")
            self.end_headers()
            return
        if self.path == "/empty":
            # No text anywhere (not even a <title>): every extraction stage
            # yields "", which is what triggers the browser fallback.
            body = b"<!doctype html><html><head></head><body></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/gone":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/big":
            para = b"<p>" + b"lorem ipsum dolor sit " * 6 + b"</p>"
            body = (
                b"<!doctype html><html><head><title>Big Page</title></head><body><article>"
                + para * 60
                + b"</article></body></html>"
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def test_web_search():
    client = TestClient(create_app(cfg=make_cfg(role="webtools"), search_fn=fake_search))
    h = client.get("/health")
    assert h.status_code == 200 and h.json() == {"ok": True, "role": "webtools"}, h.json()
    ok("webtools: /health")

    r = client.post("/search", json={"query": "cats"})
    data = r.json()
    assert r.status_code == 200 and data["ok"] is True, data
    assert data["results"] == [
        {"title": "First", "url": "https://first.example/", "snippet": "snip one"},
        {"title": "Second", "url": "https://second.example/", "snippet": "snip two"},
    ], data
    r = client.post("/search", json={"query": "cats", "max_results": 1})
    assert len(r.json()["results"]) == 1, r.json()
    r = client.post("/search", json={"query": "   "})
    assert r.status_code == 400 and r.json()["ok"] is False, r.json()
    ok("webtools: /search with injected backend (normalized rows, capping, errors)")


def test_web_fetch():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.hits = 0  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    base_url = f"http://127.0.0.1:{port}"

    try:
        client = TestClient(create_app(cfg=make_cfg(role="webtools", ssrf_allow_private=True, fetch_max_bytes=4096)))

        # Plain fetch: title + extracted content, method=http.
        r = client.post("/fetch", json={"url": f"{base_url}/page"})
        data = r.json()
        assert r.status_code == 200 and data["ok"] is True, data
        assert data["title"] == "Local Page", data
        assert "fetchable sentence one" in data["content"] and "fetchable sentence two" in data["content"], data["content"][:200]
        assert data["final_url"] == f"{base_url}/page" and data["method"] == "http" and data["truncated"] is False, data
        assert server.hits == 1  # type: ignore[attr-defined]

        # Second fetch is served from cache (no extra server hit).
        r = client.post("/fetch", json={"url": f"{base_url}/page"})
        assert r.status_code == 200 and r.json()["ok"] is True
        assert server.hits == 1, f"cache should have prevented a second hit (got {server.hits})"  # type: ignore[attr-defined]
        ok("webtools: /fetch http path (title, content, final_url, cache)")

        # Redirect hop: re-validated, final_url updated.
        r = client.post("/fetch", json={"url": f"{base_url}/redir"})
        data = r.json()
        assert r.status_code == 200 and data["final_url"] == f"{base_url}/page", data
        assert "fetchable sentence one" in data["content"], data
        ok("webtools: /fetch follows redirects")

        # Size cap: body larger than fetch_max_bytes -> truncated flag.
        r = client.post("/fetch", json={"url": f"{base_url}/big"})
        data = r.json()
        assert r.status_code == 200 and data["truncated"] is True, data
        ok("webtools: /fetch enforces the size cap (truncated)")

        # SSRF still enforced without the escape hatch: 127.0.0.1 refused.
        strict = TestClient(create_app(cfg=make_cfg(role="webtools")))
        r = strict.post("/fetch", json={"url": f"{base_url}/page"})
        assert r.status_code == 400 and r.json()["ok"] is False, r.json()
        assert "blocked" in r.json()["error"], r.json()
        r = strict.post("/fetch", json={"url": "ftp://example.com/x"})
        assert r.status_code == 400 and "scheme" in r.json()["error"], r.json()
        r = strict.post("/fetch", json={"url": "not a url"})
        assert r.status_code == 400 and r.json()["ok"] is False, r.json()
        ok("webtools: /fetch SSRF guard (private refused, bad scheme, bad url)")
    finally:
        server.shutdown()
        server.server_close()


class _FakeBrowser:
    """Stands in for Browser: records calls, returns fixed rendered HTML."""

    def __init__(self, *, fail=False):
        self.fail = fail
        self.calls: list[str] = []

    async def fetch(self, url: str) -> tuple[str, str]:
        self.calls.append(url)
        if self.fail:
            raise ToolError("browser down")
        return (
            "Rendered Title",
            "<html><head><title>Rendered Title</title></head>"
            "<body><p>only the browser can see this text</p></body></html>",
        )


def test_browser_fallback():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.hits = 0  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"

    try:
        browser = _FakeBrowser()
        client = TestClient(
            create_app(cfg=make_cfg(role="webtools", ssrf_allow_private=True), browser=browser)
        )

        # Plain HTTP succeeds but yields no extractable content -> the
        # injected browser renders the page instead.
        r = client.post("/fetch", json={"url": f"{base_url}/empty"})
        data = r.json()
        assert r.status_code == 200 and data["ok"] is True, data
        assert data["method"] == "browser", data
        assert data["title"] == "Rendered Title", data
        assert "only the browser can see this text" in data["content"], data
        assert browser.calls == [f"{base_url}/empty"], browser.calls
        assert server.hits >= 1, "the plain HTTP fetch must have reached the server"  # type: ignore[attr-defined]
        ok("webtools: empty plain-HTML page falls back to the browser")

        # Plain HTTP errors AND the browser fails -> the root-cause HTTP
        # error is reported (it is always set whenever the fallback triggers).
        failing = _FakeBrowser(fail=True)
        client2 = TestClient(
            create_app(cfg=make_cfg(role="webtools", ssrf_allow_private=True), browser=failing)
        )
        r = client2.post("/fetch", json={"url": f"{base_url}/gone"})
        assert r.status_code == 400 and r.json()["ok"] is False, r.json()
        assert "404" in r.json()["error"], r.json()
        assert failing.calls == [f"{base_url}/gone"], failing.calls
        ok("webtools: plain-HTTP error takes precedence over browser error")

        # Browser disabled (the default): the empty page is an honest 400
        # carrying the root-cause plain-HTTP error (http_error is always set
        # when the fallback triggers, so it takes precedence over the
        # browser's own error).
        client3 = TestClient(create_app(cfg=make_cfg(role="webtools", ssrf_allow_private=True)))
        r = client3.post("/fetch", json={"url": f"{base_url}/empty"})
        assert r.status_code == 400 and r.json()["ok"] is False, r.json()
        assert "no extractable content" in r.json()["error"], r.json()
        ok("webtools: disabled browser -> honest 400, not a silent empty page")
    finally:
        server.shutdown()
        server.server_close()


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        test_ssrf()
        test_paths(tmp)
        test_extract()
        test_search()
        test_cache()
        test_file_endpoints(tmp)
        test_web_search()
        test_web_fetch()
        test_browser_fallback()
    print(f"\n{PASS} check groups passed")


if __name__ == "__main__":
    main()
