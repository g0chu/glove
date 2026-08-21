/**
 * HTTP(S) fetching over pinned sockets.
 *
 * The fetcher connects to the exact (ip, port) pair that
 * `ssrf.resolveUrl` validated, so a DNS-rebinding race between validation
 * and connection cannot redirect the request to a private host. HTTPS uses
 * the default CA bundle with SNI (and certificate validation) set to the
 * original hostname.
 *
 * Redirects (301/302/303/307/308) are followed up to `maxRedirects` hops;
 * every hop's Location URL goes through the full SSRF validation again.
 * The body is capped at `maxBytes` (the `truncated` flag is set, the
 * remaining body is discarded).
 */
import http from "node:http";
import https from "node:https";
import { ToolError, resolveUrl, type ResolveOptions, type ResolvedUrl } from "./ssrf.js";

const USER_AGENT = "glove-webtools/0.1 (discord bot page fetcher)";

export interface PinnedFetchResult {
  /** The URL that was requested. */
  url: string;
  /** The URL that actually served the body. */
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

export interface PinnedFetchOptions {
  /** Deadline covering the whole fetch, including redirect hops. */
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  /** Passed through to resolveUrl (tests only). */
  allowPrivate?: boolean;
  /** Passed through to resolveUrl (tests only). */
  resolver?: ResolveOptions["resolver"];
  /** External cancellation (e.g. graceful shutdown). */
  signal?: AbortSignal;
}

interface HopResult {
  status: number;
  reason: string;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

/** GET one resolved URL (no redirect handling) with a capped body. */
function oneHop(resolved: ResolvedUrl, maxBytes: number, signal: AbortSignal): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    const base: Record<string, unknown> = {
      port: resolved.port,
      path: resolved.path,
      method: "GET",
      headers: {
        Host: resolved.host,
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en",
      },
    };
    // Connect to the pinned, validated IP; keep the original hostname for
    // the Host header, SNI, and TLS certificate validation.
    const request =
      resolved.scheme === "https"
        ? https.request({ ...base, hostname: resolved.ip, servername: resolved.host })
        : http.request({ ...base, hostname: resolved.ip });

    let settled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const done = (res: http.IncomingMessage): void => {
      if (settled) return;
      settled = true;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v[0] ?? "";
      }
      resolve({
        status: res.statusCode ?? 0,
        reason: res.statusMessage ?? "",
        headers,
        body: Buffer.concat(chunks).subarray(0, maxBytes),
        truncated: capped,
      });
    };

    request.on("response", (res) => {
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total > maxBytes && !capped) {
          capped = true;
          request.destroy(); // stop downloading; 'close' finalizes
        }
      });
      res.on("end", () => done(res));
      res.on("close", () => done(res));
      res.on("error", fail);
    });
    request.on("error", fail);
    signal.addEventListener("abort", () => request.destroy(new Error("aborted")), { once: true });
    request.end();
  });
}

/**
 * GET *url* (with pinned-socket SSRF protection) and return the body.
 * Raises ToolError with a human-readable message on any failure.
 */
export async function pinnedFetch(url: string, opts: PinnedFetchOptions): Promise<PinnedFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  const onOuter = (): void => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener("abort", onOuter, { once: true });

  let current = url;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const resolved = await resolveUrl(current, {
        allowPrivate: opts.allowPrivate,
        resolver: opts.resolver,
      });
      let result: HopResult;
      try {
        result = await oneHop(resolved, opts.maxBytes, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) break;
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code && code.startsWith("ERR_TLS")) {
          throw new ToolError(`TLS error fetching ${current}: ${msg}`);
        }
        throw new ToolError(`fetch of ${current} failed: ${msg}`);
      }

      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const location = result.headers["location"];
        if (!location) {
          throw new ToolError(`HTTP ${result.status} with no Location header from ${current}`);
        }
        if (hop >= maxRedirects) {
          throw new ToolError(`too many redirects (more than ${maxRedirects}) starting from ${url}`);
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (result.status >= 400) {
        throw new ToolError(`HTTP ${result.status} ${result.reason} from ${current}`.trimEnd());
      }
      return {
        url,
        finalUrl: current,
        status: result.status,
        headers: result.headers,
        body: result.body,
        truncated: result.truncated,
      };
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuter);
  }
  // The deadline (or an external abort) fired before any hop completed.
  if (timedOut) {
    throw new ToolError(`fetch of ${url} timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
  }
  throw new Error("web fetch aborted");
}
