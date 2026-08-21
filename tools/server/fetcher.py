"""HTTP(S) fetching over pinned sockets (stdlib only).

The fetcher connects to the exact ``(ip, port)`` pair that
:func:`server.ssrf.resolve_url` validated, so a DNS-rebinding race between
validation and connection cannot redirect the request to a private host.
HTTPS uses the default CA bundle with SNI set to the original hostname.

Redirects (301/302/303/307/308) are followed up to ``max_redirects`` hops;
every hop's ``Location`` URL goes through the full SSRF validation again.
The body is capped at ``max_bytes`` (the ``truncated`` flag is set, the
remaining body is discarded).
"""
from __future__ import annotations

import http.client
import socket
import ssl
from dataclasses import dataclass, field
from urllib.parse import urljoin

from .errors import ToolError
from .ssrf import ResolvedUrl, resolve_url

USER_AGENT = "glove-webtools/0.1 (discord bot page fetcher)"
_CHUNK = 65_536


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection that dials the validated IP instead of re-resolving."""

    def __init__(self, host: str, port: int, timeout: float, pinned_ip: str) -> None:
        super().__init__(host, port, timeout=timeout)
        self._pinned_ip = pinned_ip

    def connect(self) -> None:  # type: ignore[override]
        self.sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)


class _PinnedHTTPSConnection(_PinnedHTTPConnection):
    def __init__(self, host: str, port: int, timeout: float, pinned_ip: str, context: ssl.SSLContext) -> None:
        super().__init__(host, port, timeout, pinned_ip)
        self._ssl_context = context

    def connect(self) -> None:  # type: ignore[override]
        raw = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        self.sock = self._ssl_context.wrap_socket(raw, server_hostname=self.host)


@dataclass
class FetchResult:
    url: str  # the URL that was requested
    final_url: str  # the URL that actually served the body
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    truncated: bool = False


def _open(resolved: ResolvedUrl, timeout_s: float) -> http.client.HTTPResponse:
    if resolved.scheme == "https":
        context = ssl.create_default_context()
        conn: _PinnedHTTPConnection = _PinnedHTTPSConnection(
            resolved.host, resolved.port, timeout_s, resolved.ip, context
        )
    else:
        conn = _PinnedHTTPConnection(resolved.host, resolved.port, timeout_s, resolved.ip)
    try:
        conn.request(
            "GET",
            resolved.path,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Accept-Language": "en",
            },
        )
        return conn.getresponse()
    except BaseException:
        conn.close()
        raise


def fetch(
    url: str,
    *,
    timeout_s: float,
    max_bytes: int,
    max_redirects: int = 5,
    allow_private: bool = False,
    resolver: "callable | None" = None,
) -> FetchResult:
    """GET *url* (with pinned-socket SSRF protection) and return the body.

    Raises :class:`ToolError` with a human-readable message on any failure.
    """
    current = url
    for hop in range(max_redirects + 1):
        resolved = resolve_url(current, allow_private=allow_private, resolver=resolver)
        try:
            resp = _open(resolved, timeout_s)
        except (socket.timeout, TimeoutError) as e:
            raise ToolError(f"fetch of {current} timed out after {timeout_s:g}s") from e
        except ssl.SSLError as e:
            raise ToolError(f"TLS error fetching {current}: {e}") from e
        except http.client.HTTPException as e:
            raise ToolError(f"HTTP protocol error fetching {current}: {e}") from e
        except (ConnectionError, OSError) as e:
            raise ToolError(f"fetch of {current} failed: {e}") from e

        try:
            status = resp.status
            headers = {k.lower(): v for k, v in resp.getheaders()}
            if status in (301, 302, 303, 307, 308):
                location = headers.get("location")
                if not location:
                    raise ToolError(f"HTTP {status} with no Location header from {current}")
                if hop >= max_redirects:
                    raise ToolError(f"too many redirects (more than {max_redirects}) starting from {url}")
                current = urljoin(current, location)
                continue

            body = bytearray()
            truncated = False
            while True:
                chunk = resp.read(_CHUNK)
                if not chunk:
                    break
                body += chunk
                if len(body) > max_bytes:
                    body = body[:max_bytes]
                    truncated = True
                    break
            if status >= 400:
                raise ToolError(f"HTTP {status} {resp.reason or ''} from {current}".rstrip())
            return FetchResult(
                url=url,
                final_url=current,
                status=status,
                headers=headers,
                body=bytes(body),
                truncated=truncated,
            )
        except ToolError:
            raise
        except (socket.timeout, TimeoutError) as e:
            raise ToolError(f"fetch of {current} timed out after {timeout_s:g}s while reading the body") from e
        except (ConnectionError, OSError) as e:
            raise ToolError(f"fetch of {current} failed while reading the body: {e}") from e
        finally:
            resp.close()
