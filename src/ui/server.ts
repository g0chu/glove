import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { InteractionReader } from "./archive-reader.js";
import { renderPage } from "./page.js";
import { errMsg, log } from "../log.js";

/** Serve the read-only inspector on loopback; port zero supports hermetic tests. */
export async function startInspector(directory: string, port: number): Promise<Server> {
  const reader = new InteractionReader(directory);
  await reader.refresh();
  let failure: string | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const host = req.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site") {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }).end(); return; }
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname === "/") {
        const nonce = randomBytes(16).toString("base64");
        res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderPage(nonce));
        return;
      }
      if (!url.pathname.startsWith("/api/")) { res.writeHead(404).end(); return; }
      if (failure) throw new Error(failure);
      try { await reader.refresh(); } catch (err) { failure = errMsg(err); throw err; }
      let data: unknown;
      if (url.pathname === "/api/requests") {
        const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
        if (!Number.isSafeInteger(before) || before < 1) { res.writeHead(400).end("invalid cursor"); return; }
        data = reader.list((url.searchParams.get("q") ?? "").slice(0, 200), before);
      } else if (/^\/api\/requests\/[^/]+$/.test(url.pathname)) {
        data = await reader.detail(decodeURIComponent(url.pathname.split("/").at(-1)!), url.searchParams.get("view") === "readable");
        if (!data) { res.writeHead(404).end("request not found"); return; }
      } else { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
    } catch (err) {
      log.warn(`web UI: ${errMsg(err)}`);
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "archive could not be read; check the web UI terminal" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  return server;
}
