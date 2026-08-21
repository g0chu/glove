"""SSRF guard for the webtools fetch path.

:func:`resolve_url` validates the scheme and host, resolves the name,
refuses every address in a blocked range (loopback, RFC1918, link-local /
cloud metadata, CGNAT, …), and returns one *pinned* ``(ip, port)`` pair for
the fetcher to connect to. Pinning the resolved address is the DNS-rebinding
countermeasure: the socket connects to the address that was validated, not
to whatever the name would resolve to at connect time.

If a name resolves to several addresses and any of them is blocked, the URL
is refused outright (strict policy).

Escape hatch: ``SSRF_ALLOW_PRIVATE`` (or ``allow_private=True``) skips the
private-range checks. It exists so the smoke test can fetch a local
``http.server``; never enable it in production.

Note: the browser fallback cannot pin DNS (Chromium resolves on its own),
so URLs are pre-validated here before being handed to the browser. That is
a documented residual risk, acceptable for a single-user bot.
"""
from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

from .errors import ToolError

SCHEME_PORTS = {"http": 80, "https": 443}

_BLOCKED_RANGES = [
    # IPv4
    "0.0.0.0/8",        # "this" network / unspecified
    "10.0.0.0/8",       # RFC1918
    "100.64.0.0/10",    # CGNAT (RFC6598)
    "127.0.0.0/8",      # loopback
    "169.254.0.0/16",   # link-local (incl. cloud metadata 169.254.169.254)
    "172.16.0.0/12",    # RFC1918
    "192.0.0.0/24",     # IETF protocol assignments
    "192.0.2.0/24",     # TEST-NET-1
    "192.88.99.0/24",   # 6to4 relay
    "192.168.0.0/16",   # RFC1918
    "198.18.0.0/15",    # benchmarking
    "198.51.100.0/24",  # TEST-NET-2
    "203.0.113.0/24",   # TEST-NET-3
    "224.0.0.0/3",      # multicast
    "240.0.0.0/4",      # reserved
    # IPv6
    "::/128",           # unspecified
    "::1/128",          # loopback
    "::ffff:0:0/96",    # IPv4-mapped (the mapped v4 address is checked too)
    "64:ff9b::/96",     # NAT64
    "100::/64",         # discard
    "2001:db8::/32",    # documentation
    "fc00::/7",         # unique-local
    "fe80::/10",        # link-local
    "ff00::/8",         # multicast
]
_BLOCKED = [ipaddress.ip_network(n) for n in _BLOCKED_RANGES]


def _is_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    for net in _BLOCKED:
        if ip.version == net.version and ip in net:
            return True
    return False


@dataclass(frozen=True)
class ResolvedUrl:
    url: str
    scheme: str
    host: str  # original hostname (used for the Host header and TLS SNI)
    ip: str  # pinned address the fetcher must connect to
    port: int
    path: str  # path + query, always starting with "/"


def resolve_url(
    url: str,
    *,
    allow_private: bool = False,
    resolver: "callable | None" = None,
) -> ResolvedUrl:
    """Validate *url* and pin one resolved address to it.

    ``resolver`` is ``callable(host, port) -> list[str]`` and may be injected
    for tests; by default it is ``socket.getaddrinfo``.
    """
    if not isinstance(url, str) or not url.strip():
        raise ToolError("url must be a non-empty string")
    url = url.strip()
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in SCHEME_PORTS:
        raise ToolError(
            f"unsupported URL scheme {parsed.scheme!r} (only http/https are allowed)"
        )
    host = parsed.hostname
    if not host:
        raise ToolError(f"URL has no host: {url!r}")
    if parsed.username or parsed.password:
        raise ToolError("URLs with embedded credentials are not allowed")
    try:
        port = int(parsed.port) if parsed.port is not None else SCHEME_PORTS[scheme]
    except ValueError:
        raise ToolError(f"URL has an invalid port: {url!r}") from None
    if not 1 <= port <= 65535:
        raise ToolError(f"URL port out of range: {port}")

    resolve = resolver if resolver is not None else _default_resolver
    try:
        ips = resolve(host, port)
    except socket.gaierror as e:
        raise ToolError(f"could not resolve host {host!r}: {e.strerror or e}") from e
    if not ips:
        raise ToolError(f"host {host!r} resolved to no addresses")

    pinned: str | None = None
    for candidate in ips:
        try:
            addr = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if not allow_private and _is_blocked(addr):
            raise ToolError(
                f"host {host!r} resolves to a blocked private/internal range "
                f"({candidate}); refusing to fetch"
            )
        # Also check the embedded v4 address of an IPv4-mapped IPv6 result.
        if addr.version == 6 and addr.ipv4_mapped is not None:
            if not allow_private and _is_blocked(addr.ipv4_mapped):
                raise ToolError(
                    f"host {host!r} resolves to a blocked private/internal range "
                    f"({candidate}); refusing to fetch"
                )
        if pinned is None:
            pinned = candidate
    if pinned is None:
        raise ToolError(f"host {host!r} resolved only to unparseable addresses")

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    return ResolvedUrl(url=url, scheme=scheme, host=host, ip=pinned, port=port, path=path)


def _default_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen: set[str] = set()
    out: list[str] = []
    for info in infos:
        addr = info[4][0]
        if addr not in seen:
            seen.add(addr)
            out.append(addr)
    return out
