/**
 * SSRF guard for the web_fetch path.
 *
 * :func resolveUrl validates the scheme/host, resolves the name, refuses
 * every address in a blocked range (loopback, RFC1918, link-local / cloud
 * metadata, CGNAT, ...), and returns one *pinned* (ip, port) pair for the
 * fetcher to connect to. Pinning the resolved address is the DNS-rebinding
 * countermeasure: the socket connects to the address that was validated,
 * not to whatever the name would resolve to at connect time.
 *
 * If a name resolves to several addresses and any of them is blocked, the
 * URL is refused outright (strict policy).
 *
 * Escape hatch: `allowPrivate` (never set from config in production) skips
 * the private-range checks. It exists so the smoke test can fetch a local
 * server.
 */
import dns from "node:dns";

/** User-facing tool failure; the message goes back to the model. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const SCHEME_PORTS: Record<string, number> = { http: 80, https: 443 };

/** [address as uint32, prefix bits] for IPv4. */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this" network / unspecified
  [0x0a000000, 8], // 10.0.0.0/8 RFC1918
  [0x64400000, 10], // 100.64.0.0/10 CGNAT (RFC6598)
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (incl. cloud metadata)
  [0xac100000, 12], // 172.16.0.0/12 RFC1918
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay
  [0xc0a80000, 16], // 192.168.0.0/16 RFC1918
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb000700, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 3], // 224.0.0.0/3 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved
];

/** [16-byte address, prefix bits] for IPv6. */
const BLOCKED_V6: Array<[Buffer, number]> = [
  [buf16("::"), 128], // unspecified
  [buf16("::1"), 128], // loopback
  [buf16("::ffff:0:0"), 96], // IPv4-mapped (the mapped v4 address is checked too)
  [buf16("64:ff9b::"), 96], // NAT64
  [buf16("100::"), 64], // discard
  [buf16("2001:db8::"), 32], // documentation
  [buf16("fc00::"), 7], // unique-local
  [buf16("fe80::"), 10], // link-local
  [buf16("ff00::"), 8], // multicast
];

function buf16(ipv6: string): Buffer {
  const b = parseV6(ipv6);
  if (!b) throw new Error(`internal: bad blocked range ${ipv6}`);
  return b;
}

/** Parse an IPv4 address to uint32, or null. */
function parseV4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/** Parse an IPv6 address (with optional embedded IPv4 tail) to 16 bytes, or null. */
function parseV6(ip: string): Buffer | null {
  let s = ip.replace(/%.*$/, ""); // strip zone id, if any
  // Expand an embedded IPv4 tail (::ffff:1.2.3.4) into hex groups.
  const v4Tail = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4Tail) {
    const nums = v4Tail.slice(1).map((x) => Number(x));
    if (nums.some((x) => x > 255)) return null;
    const h = [nums[0] * 256 + nums[1], nums[2] * 256 + nums[3]]
      .map((x) => x.toString(16).padStart(4, "0"))
      .join(":");
    s = s.slice(0, v4Tail.index) + h;
  }
  if (!s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  let head: number[] | null;
  let tail: number[] | null;
  if (halves.length === 2) {
    head = parseGroups(halves[0]);
    tail = parseGroups(halves[1]);
    if (!head || !tail || head.length + tail.length > 7) return null;
  } else {
    head = parseGroups(s);
    tail = [];
    if (!head || head.length !== 8) return null;
  }
  const groups = [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  if (groups.length !== 8) return null;
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(g, i * 2));
  return b;
}

/** True when *ip* (v4 or v6) falls in a blocked private/internal range. */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4 !== null) {
    return BLOCKED_V4.some(([p, bits]) => inPrefixV4(v4, p, bits));
  }
  const v6 = parseV6(ip);
  if (!v6) return false;
  const mapped = v6.subarray(0, 10).equals(Buffer.alloc(10)) && v6[10] === 0xff && v6[11] === 0xff;
  const mappedV4 = mapped ? v4FromBytes([v6[12], v6[13], v6[14], v6[15]]) : null;
  return (
    BLOCKED_V6.some(([p, bits]) => inPrefixV6(v6, p, bits)) ||
    (mappedV4 !== null && BLOCKED_V4.some(([p, bits]) => inPrefixV4(mappedV4, p, bits)))
  );
}

function v4FromBytes(parts: number[]): number {
  return (parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3]) >>> 0;
}

function inPrefixV4(addr: number, prefix: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (prefix & mask);
}

function inPrefixV6(addr: Buffer, prefix: Buffer, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  if (!addr.subarray(0, fullBytes).equals(prefix.subarray(0, fullBytes))) return false;
  const rem = bits % 8;
  if (rem === 0) return true;
  const mask = 0xff << (8 - rem);
  return (addr[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

export interface ResolvedUrl {
  url: string;
  scheme: "http" | "https";
  /** Original hostname (used for the Host header and TLS SNI). */
  host: string;
  /** Pinned address the fetcher must connect to. */
  ip: string;
  port: number;
  /** Path + query, always starting with "/". */
  path: string;
}

export interface ResolveOptions {
  /** Skip private-range checks (tests only; never enable in production). */
  allowPrivate?: boolean;
  /** Injectable for tests: (host, port) -> resolved addresses. */
  resolver?: (host: string, port: number) => Promise<string[]>;
}

/**
 * Validate *url* and pin one resolved address to it.
 * Raises :ToolError with a human-readable message on any failure.
 */
export async function resolveUrl(url: string, opts: ResolveOptions = {}): Promise<ResolvedUrl> {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new ToolError("url must be a non-empty string");
  }
  url = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError(`invalid URL: ${url}`);
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    throw new ToolError(`unsupported URL scheme ${parsed.protocol} (only http/https are allowed)`);
  }
  if (parsed.username || parsed.password) {
    throw new ToolError("URLs with embedded credentials are not allowed");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!host) {
    throw new ToolError(`URL has no host: ${url}`);
  }
  let port: number;
  if (parsed.port) {
    if (!/^\d+$/.test(parsed.port) || Number(parsed.port) > 65535) {
      throw new ToolError(`URL port out of range: ${url}`);
    }
    port = Number(parsed.port);
  } else {
    port = SCHEME_PORTS[scheme];
  }
  if (port < 1 || port > 65535) {
    throw new ToolError(`URL port out of range: ${url}`);
  }

  const resolve =
    opts.resolver ??
    (async (h: string, _p: number): Promise<string[]> => {
      const infos = await dns.promises.lookup(h, { all: true });
      return infos.map((i) => i.address);
    });
  let ips: string[];
  try {
    ips = await resolve(host, port);
  } catch (err) {
    throw new ToolError(`could not resolve host ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!ips || ips.length === 0) {
    throw new ToolError(`host ${host} resolved to no addresses`);
  }

  let pinned: string | null = null;
  for (const candidate of ips) {
    if (!opts.allowPrivate && isBlockedIp(candidate)) {
      throw new ToolError(
        `host ${host} resolves to a blocked private/internal range (${candidate}); refusing to fetch`,
      );
    }
    if (pinned === null) pinned = candidate;
  }
  if (pinned === null) {
    throw new ToolError(`host ${host} resolved only to unparseable addresses`);
  }

  const path = parsed.pathname || "/";
  return {
    url,
    scheme: scheme as "http" | "https",
    host,
    ip: pinned,
    port,
    path: parsed.search ? `${path}${parsed.search}` : path,
  };
}
