/**
 * Minimal read-only ZIM archive reader (ZIM v6, as written by modern
 * openZIM writers — the format of the bundled Wikipedia ZIMs).
 *
 * Supports exactly what the wikipedia tools need on a very large archive
 * (tens of GB, ~20M entries):
 * - binary search over the path pointer list (directory entries are stored
 *   sorted by namespace+path, one byte per namespace char);
 * - uncompressed and zstd-compressed clusters (whole-cluster frame — the
 *   layout modern writers use — plus the legacy offset-table+frame layout);
 * - redirect resolution;
 * - a time-budgeted sequential scan of the directory region for
 *   case-insensitive title matching (the directory is one ~1 GB
 *   contiguous region, so a full pass is a single sequential read).
 *
 * The file is accessed through one fd with targeted reads; nothing is
 * loaded whole. zstd support needs Node >= 22.15 (zlib.zstdDecompressSync).
 */
import fs from "node:fs/promises";
import zlib from "node:zlib";
import { errMsg } from "../../log.js";
import { articleText } from "./text.js";

const ZIM_MAGIC = 0x044d495a;
const ZSTD_MAGIC = 0xfd2fb528;
/** Sequential scan chunk size. */
const CHUNK_SIZE = 4 * 1024 * 1024;
/** Bounded cache of parsed directory entries (LRU by insertion order). */
const ENTRY_CACHE_MAX = 65536;
/** Bounded cache of decoded cluster tables/frames. */
const CLUSTER_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** Max redirect hops before giving up. */
const MAX_REDIRECT_HOPS = 10;
/** Max entries a random-access scan pass may walk (defensive cap). */
const MAX_RANDOM_WALK = 200_000;
/** Max query length (chars). */
const MAX_QUERY_CHARS = 256;

/** A directory entry (namespace + path + data location or redirect target). */
export interface ZimEntry {
  /** Index into the archive's path pointer list (null when unknown). */
  index: number | null;
  /** One-char namespace ("C" = user content in a Wikipedia ZIM). */
  ns: string;
  /** Path without the namespace prefix (wiki-style, e.g. "Albert_Einstein"). */
  path: string;
  /** Display title (the path when the entry stores none). */
  title: string;
  /** True when the entry points at another entry instead of data. */
  redirect: boolean;
  /** Target's path index (redirects only). */
  redirectIndex: number;
  /** Cluster holding the blob (content entries only). */
  cluster: number;
  /** Blob number inside the cluster (content entries only). */
  blob: number;
  /** Index into the archive's MIME list (content entries only). */
  mimeIndex: number;
}

/** One search hit. */
export interface ZimSearchResult {
  title: string;
  path: string;
  ns: string;
  redirect: boolean;
  /** How the query matched: exact title/path, prefix, or substring. */
  match: "exact" | "prefix" | "substring";
}

/** Search results plus a flag when a budgeted scan was cut short. */
export interface ZimSearchOutcome {
  results: ZimSearchResult[];
  partial: boolean;
}

/** One readable article. */
export interface ZimArticle {
  title: string;
  path: string;
  mime: string;
  /** Size of the raw blob in bytes. */
  bytes: number;
  /** Extracted plain text (already truncated to the caller's cap). */
  text: string;
  /** True when the text was truncated to the cap. */
  truncated: boolean;
}

export interface ZimReaderOptions {
  /** Time budget (ms) for a full-directory title scan. */
  scanBudgetMs: number;
}

/** Byte matcher: case- and space/underscore-insensitive substring test. */
interface ByteMatcher {
  /** Pairs of accepted bytes per query position (second is -1 if one). */
  pairs: Int32Array;
  len: number;
}

/** Decoded cluster: an offset table plus either file data or a frame. */
interface ClusterInfo {
  /** "raw": blobs are read from the file; "zstd": `data` is decompressed. */
  kind: "raw" | "zstd";
  /** The offset table, or the whole decompressed cluster (zstd). */
  data: Buffer;
  /** Offset size in the table (4 or 8). */
  osz: number;
  /** Number of offsets (one more than the number of blobs). */
  n: number;
  /**
   * Blob offsets are absolute within the decompressed data (the table is
   * part of it), so a blob lives at `dataBase + offset`: for raw clusters
   * that is the file offset of the decompressed region start; for zstd it
   * is 0 (into `data`).
   */
  dataBase: number;
}

/** Parse one directory entry at `off`; null when the buffer is too short. */
function parseDirentAt(buf: Buffer, off: number): { entry: ZimEntry; size: number } | null {
  if (off + 16 > buf.length) return null;
  const mimeIndex = buf.readUInt16LE(off);
  const paramLen = buf[off + 2];
  const ns = String.fromCharCode(buf[off + 3]);
  const redirect = mimeIndex === 0xffff || mimeIndex === 0xfffd;
  let redirectIndex = 0;
  let cluster = 0;
  let blob = 0;
  let p: number;
  if (redirect) {
    redirectIndex = buf.readUInt32LE(off + 8);
    p = off + 12;
  } else {
    cluster = buf.readUInt32LE(off + 8);
    blob = buf.readUInt32LE(off + 12);
    p = off + 16;
  }
  const pathEnd = buf.indexOf(0, p);
  if (pathEnd < 0) return null;
  const titleEnd = buf.indexOf(0, pathEnd + 1);
  if (titleEnd < 0) return null;
  const end = titleEnd + 1 + paramLen;
  if (end > buf.length) return null;
  const entry: ZimEntry = {
    index: null,
    ns,
    path: buf.toString("utf8", p, pathEnd),
    title: buf.toString("utf8", pathEnd + 1, titleEnd),
    redirect,
    redirectIndex,
    cluster,
    blob,
    mimeIndex,
  };
  return { entry, size: end - off };
}

/**
 * Build the byte matcher for a query: ASCII letters match either case and
 * spaces/underscores match each other (wiki paths use underscores, titles
 * use spaces); everything else matches exactly.
 */
function makeByteMatcher(query: string): ByteMatcher | null {
  const bytes = new TextEncoder().encode(query);
  if (bytes.length === 0 || bytes.length > MAX_QUERY_CHARS * 4) return null;
  const pairs = new Int32Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let alt = -1;
    if (b >= 0x41 && b <= 0x5a) alt = b + 0x20;
    else if (b >= 0x61 && b <= 0x7a) alt = b - 0x20;
    else if (b === 0x20) alt = 0x5f;
    else if (b === 0x5f) alt = 0x20;
    pairs[i * 2] = b;
    pairs[i * 2 + 1] = alt;
  }
  return { pairs, len: bytes.length };
}

/** All byte offsets where `m` occurs in `buf`. */
function matcherHits(buf: Buffer, m: ByteMatcher): number[] {
  const hits: number[] = [];
  const { pairs, len } = m;
  const a0 = pairs[0];
  const b0 = pairs[1];
  for (let i = 0; i + len <= buf.length; i++) {
    const c = buf[i];
    if (c !== a0 && c !== b0) continue;
    let ok = true;
    for (let k = 1; k < len; k++) {
      const cc = buf[i + k];
      if (cc !== pairs[k * 2] && cc !== pairs[k * 2 + 1]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** Normalize a title/path for comparison: lowercase, no spaces/underscores. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, "");
}

/** The path spellings worth trying for a title (spaces ↔ underscores). */
function pathForms(q: string): string[] {
  return [...new Set([q, q.replace(/ /g, "_"), q.replace(/_/g, " ")])];
}

export class ZimReader {
  private readonly fd: Awaited<ReturnType<typeof fs.open>>;
  private readonly fileSize: number;
  private readonly entryCount: number;
  private readonly clusterCount: number;
  private readonly pathPtrPos: number;
  private readonly clusterPtrPos: number;
  private readonly pathPtrLen: number;
  private readonly direntStart: number;
  private readonly direntEnd: number;
  private readonly scanBudgetMs: number;
  private readonly mimeList: string[];
  private contiguous = false;
  private pathOrdered = false;
  private nsCandidates: string[] = ["C"];
  private readonly entryCache = new Map<number, ZimEntry>();
  private readonly clusterCache = new Map<number, ClusterInfo>();
  private clusterCacheBytes = 0;
  private closed = false;

  private constructor(opts: {
    fd: Awaited<ReturnType<typeof fs.open>>;
    fileSize: number;
    entryCount: number;
    clusterCount: number;
    pathPtrPos: number;
    clusterPtrPos: number;
    pathPtrLen: number;
    direntStart: number;
    direntEnd: number;
    scanBudgetMs: number;
    mimeList: string[];
  }) {
    this.fd = opts.fd;
    this.fileSize = opts.fileSize;
    this.entryCount = opts.entryCount;
    this.clusterCount = opts.clusterCount;
    this.pathPtrPos = opts.pathPtrPos;
    this.clusterPtrPos = opts.clusterPtrPos;
    this.pathPtrLen = opts.pathPtrLen;
    this.direntStart = opts.direntStart;
    this.direntEnd = opts.direntEnd;
    this.scanBudgetMs = opts.scanBudgetMs;
    this.mimeList = opts.mimeList;
  }

  /**
   * Open an archive, validating the header. Rejects with a short error on
   * missing files, bad magic, or an out-of-bounds header (the error text
   * is what a tool result would show the model).
   */
  static async open(file: string, opts: ZimReaderOptions): Promise<ZimReader> {
    let fd: Awaited<ReturnType<typeof fs.open>>;
    try {
      fd = await fs.open(file, "r");
    } catch (e) {
      throw new Error(`cannot open ZIM file ${file}: ${errMsg(e)}`);
    }
    try {
      const stat = await fd.stat();
      const size = stat.size;
      if (size < 96) throw new Error(`not a ZIM file: ${file} is too small`);
      const head = Buffer.alloc(80);
      await fd.read(head, 0, 80, 0);
      if (head.readUInt32LE(0) !== ZIM_MAGIC) {
        throw new Error(`not a ZIM file: ${file} has a bad magic`);
      }
      const major = head.readUInt16LE(4);
      const minor = head.readUInt16LE(6);
      if (major !== 6) {
        throw new Error(`unsupported ZIM version ${major}.${minor} (only v6)`);
      }
      const entryCount = head.readUInt32LE(24);
      const clusterCount = head.readUInt32LE(28);
      const pathPtrPos = Number(head.readBigUInt64LE(32));
      const clusterPtrPos = Number(head.readBigUInt64LE(48));
      const mimeListPos = Number(head.readBigUInt64LE(56));
      if (entryCount < 1 || clusterCount < 1) {
        throw new Error(`corrupt ZIM file: ${file} has an empty header`);
      }
      if (mimeListPos < 80 || mimeListPos > size) {
        throw new Error(`corrupt ZIM file: ${file} has a bad mime list position`);
      }
      if (pathPtrPos <= mimeListPos || pathPtrPos + 8 > size) {
        throw new Error(`corrupt ZIM file: ${file} has a bad path table position`);
      }
      // The header entry count can overstate the real count (some writers);
      // the pointer list length is authoritative when it fits the layout.
      let pathPtrLen = entryCount;
      if (clusterPtrPos >= pathPtrPos && (clusterPtrPos - pathPtrPos) % 8 === 0) {
        pathPtrLen = Math.min(entryCount, (clusterPtrPos - pathPtrPos) / 8);
      }
      if (pathPtrLen < 1 || pathPtrPos + pathPtrLen * 8 > size) {
        throw new Error(`corrupt ZIM file: ${file} path table out of bounds`);
      }
      const direntStart = Number(await readU64(fd, pathPtrPos));
      if (direntStart <= 0 || direntStart >= pathPtrPos) {
        throw new Error(`corrupt ZIM file: ${file} has a bad first directory offset`);
      }
      const mimeList = await readMimeList(fd, mimeListPos);
      const reader = new ZimReader({
        fd,
        fileSize: size,
        entryCount,
        clusterCount,
        pathPtrPos,
        clusterPtrPos,
        pathPtrLen,
        direntStart,
        direntEnd: pathPtrPos,
        scanBudgetMs: opts.scanBudgetMs,
        mimeList,
      });
      await reader.probe();
      return reader;
    } catch (e) {
      await fd.close().catch(() => {});
      throw e;
    }
  }

  /** Number of directory entries the archive's pointer list holds. */
  get entries(): number {
    return this.pathPtrLen;
  }

  /** Close the underlying file handle; further calls reject. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.entryCache.clear();
    this.clusterCache.clear();
    await this.fd.close().catch(() => {});
  }

  /**
   * Find entries by title or path: exact path first (binary search, all
   * known namespaces), then case-insensitive prefix (bounded path window),
   * then a budgeted full-directory substring scan.
   */
  async search(query: string, limitArg: number): Promise<ZimSearchOutcome> {
    const q = query.trim().replace(/[\s_]+/g, " ");
    if (q.length === 0) throw new Error("query must not be empty");
    if (q.length > MAX_QUERY_CHARS) throw new Error(`query too long (max ${MAX_QUERY_CHARS} chars)`);
    const nq = norm(q);
    const limit = Math.max(1, Math.floor(limitArg));
    const found = new Map<string, { entry: ZimEntry; rank: number }>();
    const add = (e: ZimEntry, rank: number): void => {
      const key = e.ns + "\x00" + e.path;
      const prev = found.get(key);
      if (!prev || rank < prev.rank) found.set(key, { entry: e, rank });
    };
    // Pass 1: byte-exact path matches in the known namespaces.
    for (const p of pathForms(q)) {
      for (const e of await this.entriesWithPath(p)) {
        if (norm(e.title) === nq || norm(e.path) === nq) add(e, 0);
      }
      if (found.size >= limit) break;
    }
    let partial = false;
    const matcher = makeByteMatcher(q);
    if (matcher !== null) {
      // Rank a scan hit: exact title/path (case-insensitive), prefix, or
      // substring — a full-title match found through the scans is still
      // "exact".
      const rankOf = (e: ZimEntry): number => {
        const nt = norm(e.title);
        const np = norm(e.path);
        if (nt === nq || np === nq) return 0;
        if (nt.startsWith(nq) || np.startsWith(nq)) return 1;
        return 2;
      };
      // Pass 2: case-insensitive exact/prefix over the path window.
      if (found.size < limit) {
        const [lo, hi] = await this.prefixWindow(q);
        const r = await this.scan(
          lo,
          hi,
          matcher,
          (e) => rankOf(e) <= 1,
          Math.min(this.scanBudgetMs, 5000),
          limit * 4,
        );
        for (const e of r.found) add(e, rankOf(e));
        partial = partial || r.partial;
      }
      // Pass 3: full-directory substring scan (time-budgeted). The verify
      // predicate is the real filter on the random-access fallback (the
      // byte matcher only pre-filters the sequential walk), so it must be
      // an actual substring test, not a rank test.
      if (found.size < limit) {
        const r = await this.scan(
          0,
          this.pathPtrLen,
          matcher,
          (e) => norm(e.title).includes(nq) || norm(e.path).includes(nq),
          this.scanBudgetMs,
          limit * 4,
        );
        for (const e of r.found) add(e, rankOf(e));
        partial = partial || r.partial;
      }
    }
    const results: ZimSearchResult[] = [...found.values()]
      .sort((a, b) => a.rank - b.rank || (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0))
      .slice(0, limit)
      .map(({ entry, rank }) => ({
        title: entry.title || entry.path,
        path: entry.path,
        ns: entry.ns,
        redirect: entry.redirect,
        match: rank === 0 ? "exact" : rank === 1 ? "prefix" : "substring",
      }));
    return { results, partial };
  }

  /**
   * Resolve a title (or path) to one entry — following redirects — and
   * return its text. Rejects when nothing or several entries match.
   */
  async read(title: string, maxTextChars: number): Promise<ZimArticle> {
    const t = title.trim().replace(/[\s_]+/g, " ");
    if (t.length === 0) throw new Error("title must not be empty");
    const nq = norm(t);
    const candidates: ZimEntry[] = [];
    for (const p of pathForms(t)) {
      for (const e of await this.entriesWithPath(p)) {
        if ((norm(e.title) === nq || norm(e.path) === nq) && !candidates.some((c) => c.path === e.path && c.ns === e.ns)) {
          candidates.push(e);
        }
      }
    }
    if (candidates.length === 0) {
      const matcher = makeByteMatcher(t);
      if (matcher === null) throw new Error(`title too long (max ${MAX_QUERY_CHARS} chars)`);
      const r = await this.scan(
        0,
        this.pathPtrLen,
        matcher,
        (e) => norm(e.title) === nq || norm(e.path) === nq,
        this.scanBudgetMs,
        8,
      );
      candidates.push(...r.found);
    }
    if (candidates.length === 0) {
      throw new Error(`no article matching "${t}" in the local archive (try wikipedia_search)`);
    }
    candidates.sort(
      (a, b) =>
        Number(b.redirect) - Number(a.redirect) ||
        (b.ns === "C" ? 1 : 0) - (a.ns === "C" ? 1 : 0) ||
        (a.path < b.path ? -1 : 1),
    );
    if (candidates.length > 1) {
      const list = candidates.slice(0, 5).map((e) => `"${e.title || e.path}"`).join(", ");
      throw new Error(`ambiguous title "${t}": ${list}${candidates.length > 5 ? ", …" : ""} (use one exactly)`);
    }
    return this.resolve(candidates[0], maxTextChars);
  }

  // ------------------------------------------------------------ internals --

  /** Cheap layout probes: directory contiguity, path ordering, namespaces. */
  private async probe(): Promise<void> {
    // Contiguity: the second pointer must point right after entry 0.
    const first = await this.parseEntryAtOffset(this.direntStart);
    if (this.pathPtrLen > 1) {
      const p1 = Number(await this.readU64(this.pathPtrPos + 8));
      this.contiguous = p1 === this.direntStart + first.size;
    } else {
      this.contiguous = true;
    }
    // Path ordering: sample the pointer list.
    let ordered = true;
    let prev = -1n;
    for (let s = 0; s < 8 && ordered; s++) {
      const i = (s * this.pathPtrLen) >> 3;
      const p = await this.readU64(this.pathPtrPos + i * 8);
      if (p < prev) ordered = false;
      prev = p;
    }
    this.pathOrdered = ordered;
    // Namespaces: walk the first 64 KB of the directory, then probe the
    // common namespace letters at their key-space positions.
    const ns = new Set<string>();
    const head = await this.readAt(this.direntStart, Math.min(65536, this.direntEnd - this.direntStart));
    let p = 0;
    while (p < head.length) {
      const d = parseDirentAt(head, p);
      if (d === null) break;
      ns.add(d.entry.ns);
      p += d.size;
    }
    for (const c of ["C", "W", "X", "M", "A", "-", "_", "~", "0"]) {
      const i = await this.lowerBound(c + "\x00");
      if (i < this.pathPtrLen && (await this.entryAt(i)).ns === c) ns.add(c);
    }
    if (!ns.has("C")) ns.add("C");
    this.nsCandidates = [...ns].sort();
  }

  /** Read [off, off+len) (short reads tolerated; returns what came back). */
  private async readAt(off: number, len: number): Promise<Buffer> {
    if (this.closed) throw new Error("zim reader closed");
    if (off < 0 || len <= 0 || off + len > this.fileSize) {
      throw new Error("zim read out of bounds");
    }
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await this.fd.read(buf, got, len - got, off + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  }

  private async readU64(off: number): Promise<bigint> {
    const b = await this.readAt(off, 8);
    if (b.length < 8) throw new Error("zim read out of bounds");
    return b.readBigUInt64LE(0);
  }

  /** Parse one entry at a file offset, growing the buffer as needed. */
  private async parseEntryAtOffset(off: number): Promise<{ entry: ZimEntry; size: number }> {
    if (off < this.direntStart || off >= this.direntEnd) {
      throw new Error("corrupt ZIM file: entry offset out of range");
    }
    const maxLen = this.direntEnd - off;
    let buf = await this.readAt(off, Math.min(256, maxLen));
    let d = parseDirentAt(buf, 0);
    while (d === null) {
      if (buf.length >= Math.min(maxLen, 65536)) throw new Error("corrupt ZIM file: unreadable directory entry");
      const more = await this.readAt(off + buf.length, Math.min(4096, maxLen - buf.length));
      if (more.length === 0) throw new Error("corrupt ZIM file: directory entry past the region");
      buf = Buffer.concat([buf, more]);
      d = parseDirentAt(buf, 0);
    }
    return d;
  }

  /** Entry by path-pointer index (cached). */
  private async entryAt(i: number): Promise<ZimEntry> {
    if (i < 0 || i >= this.pathPtrLen) throw new Error(`entry index ${i} out of range`);
    const cached = this.entryCache.get(i);
    if (cached !== undefined) {
      this.entryCache.delete(i);
      this.entryCache.set(i, cached);
      return cached;
    }
    const ptr = Number(await this.readU64(this.pathPtrPos + i * 8));
    if (ptr <= 0 || ptr >= this.direntEnd) {
      throw new Error(`corrupt ZIM file: entry ${i} points out of bounds`);
    }
    const { entry } = await this.parseEntryAtOffset(ptr);
    entry.index = i;
    this.entryCache.set(i, entry);
    if (this.entryCache.size > ENTRY_CACHE_MAX) {
      const oldest = this.entryCache.keys().next().value;
      if (oldest !== undefined) this.entryCache.delete(oldest);
    }
    return entry;
  }

  /** First index whose (ns+path) key is >= target. */
  private async lowerBound(target: string): Promise<number> {
    let lo = 0;
    let hi = this.pathPtrLen;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = await this.entryAt(mid);
      const key = e.ns + e.path;
      if (key < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** All entries with exactly this path (one per namespace that has it). */
  private async entriesWithPath(p: string): Promise<ZimEntry[]> {
    const out: ZimEntry[] = [];
    for (const c of this.nsCandidates) {
      const i = await this.lowerBound(c + p);
      if (i >= this.pathPtrLen) continue;
      const e = await this.entryAt(i);
      if (e.path !== p) continue;
      if (!out.some((o) => o.index !== null && o.index === e.index)) out.push(e);
    }
    return out;
  }

  /**
   * The path-key window [lo, hi) that may contain case-insensitive prefix
   * matches of the query (paths with every letter variant of the query as
   * prefix lie inside; the walk verifies each candidate).
   */
  private async prefixWindow(q: string): Promise<[number, number]> {
    const p = q.replace(/ /g, "_");
    let lo = "";
    let hi = "";
    for (const ch of p) {
      const code = ch.codePointAt(0) as number;
      if (code >= 0x61 && code <= 0x7a) {
        lo += String.fromCharCode(code - 0x20);
        hi += ch;
      } else if (code >= 0x41 && code <= 0x5a) {
        lo += ch;
        hi += String.fromCharCode(code + 0x20);
      } else if (ch === "_") {
        lo += " ";
        hi += "_";
      } else {
        lo += ch;
        hi += ch;
      }
    }
    // Exclusive upper bound: increment the last char of the hi variant.
    hi = hi.slice(0, -1) + String.fromCharCode(hi.charCodeAt(hi.length - 1) + 1);
    const a = await this.lowerBound("\x00" + lo);
    const b = await this.lowerBound("\xff" + hi);
    return [a, b];
  }

  /**
   * Scan directory entries [lo, hi) with the byte matcher, verifying hits
   * on the decoded title/path. Sequential byte walk when the directory is
   * contiguous and path-ordered (one streaming read), random access
   * otherwise (capped). Stops early on the time budget or the cap.
   */
  private async scan(
    lo: number,
    hi: number,
    m: ByteMatcher,
    verify: (e: ZimEntry) => boolean,
    budgetMs: number,
    cap: number,
  ): Promise<{ found: ZimEntry[]; partial: boolean }> {
    hi = Math.min(hi, this.pathPtrLen);
    const found: ZimEntry[] = [];
    const t0 = Date.now();
    const collect = (e: ZimEntry): boolean => {
      if (verify(e)) found.push(e);
      return found.length < cap;
    };
    if (this.contiguous && this.pathOrdered && hi - lo > 64) {
      const start = Number(await this.readU64(this.pathPtrPos + lo * 8));
      // Pointer hi is out of the list when hi === pathPtrLen; in a
      // contiguous directory the region ends at direntEnd instead.
      const end =
        hi < this.pathPtrLen
          ? Number(await this.readU64(this.pathPtrPos + hi * 8))
          : this.direntEnd;
      let off = start;
      let tail: Buffer = Buffer.alloc(0);
      let idx = lo;
      let partial = false;
      while (off < end && found.length < cap) {
        const chunk = await this.readAt(off, Math.min(CHUNK_SIZE, end - off));
        if (chunk.length === 0) break;
        const buf = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
        const items: Array<{ end: number; e: ZimEntry }> = [];
        let p = 0;
        while (p < buf.length) {
          const d = parseDirentAt(buf, p);
          if (d === null) break;
          d.entry.index = idx;
          idx++;
          items.push({ end: p + d.size, e: d.entry });
          p += d.size;
        }
        tail = p < buf.length ? buf.subarray(p) : Buffer.alloc(0);
        if (tail.length > 65536) {
          // A directory entry that never completes: stop at the boundary.
          partial = true;
          break;
        }
        if (items.length > 0) {
          const hits = matcherHits(buf, m);
          let it = 0;
          let last: ZimEntry | null = null;
          for (const h of hits) {
            while (it < items.length && items[it].end <= h) it++;
            const item = items[it];
            if (item === undefined || h >= item.end) continue; // hit in the tail
            if (item.e === last) continue; // same dirent matched twice
            last = item.e;
            if (!collect(item.e)) break;
          }
        }
        off += chunk.length;
        if (Date.now() - t0 > budgetMs) {
          partial = true;
          break;
        }
      }
      return { found, partial };
    }
    // Random-access fallback (files with a non-contiguous directory).
    let partial = false;
    for (let i = lo; i < hi; i++) {
      if (!collect(await this.entryAt(i))) break;
      if ((i & 1023) === 0) {
        if (i - lo >= MAX_RANDOM_WALK || Date.now() - t0 > budgetMs) {
          partial = true;
          break;
        }
      }
    }
    return { found, partial };
  }

  /** Resolve one content entry (following redirects) to its text. */
  private async resolve(entry: ZimEntry, maxTextChars: number): Promise<ZimArticle> {
    let e = entry;
    const seen = new Set<string>([e.ns + "\x00" + e.path]);
    let hops = 0;
    while (e.redirect) {
      if (e.index === null || e.redirectIndex < 0 || e.redirectIndex >= this.pathPtrLen) {
        throw new Error("corrupt redirect in ZIM archive");
      }
      e = await this.entryAt(e.redirectIndex);
      if (++hops > MAX_REDIRECT_HOPS) throw new Error("redirect loop in ZIM archive");
      const key = e.ns + "\x00" + e.path;
      if (seen.has(key)) throw new Error("redirect loop in ZIM archive");
      seen.add(key);
    }
    const mime = this.mimeList[e.mimeIndex] ?? "";
    if (!mime.startsWith("text/") && mime !== "application/xhtml+xml") {
      throw new Error(`"${e.title || e.path}" is not a text article (${mime || "unknown type"})`);
    }
    const data = await this.getBlob(e.cluster, e.blob);
    const isHtml = mime.includes("html") || mime === "application/xhtml+xml";
    const full = isHtml ? articleText(data.toString("utf8")) : data.toString("utf8").trim();
    const truncated = full.length > maxTextChars;
    return {
      title: e.title || e.path,
      path: e.path,
      mime,
      bytes: data.length,
      text: truncated ? full.slice(0, maxTextChars) : full,
      truncated,
    };
  }

  /** One blob's bytes from its cluster. */
  private async getBlob(cluster: number, blob: number): Promise<Buffer> {
    const info = await this.clusterInfo(cluster);
    if (blob < 0 || blob + 1 > info.n) {
      throw new Error(`corrupt ZIM file: blob ${blob} out of range for cluster ${cluster}`);
    }
    const a = info.data.readUIntLE(blob * info.osz, info.osz);
    const b = info.data.readUIntLE((blob + 1) * info.osz, info.osz);
    if (b <= a) throw new Error(`corrupt ZIM file: bad blob offsets in cluster ${cluster}`);
    if (info.kind === "raw") {
      return this.readAt(info.dataBase + a, b - a);
    }
    return info.data.subarray(info.dataBase + a, info.dataBase + b);
  }

  /** Decode a cluster's header (and frame, for zstd), cached. */
  private async clusterInfo(cluster: number): Promise<ClusterInfo> {
    const cached = this.clusterCache.get(cluster);
    if (cached !== undefined) {
      this.clusterCache.delete(cluster);
      this.clusterCache.set(cluster, cached);
      return cached;
    }
    if (cluster < 0 || cluster >= this.clusterCount) {
      throw new Error(`cluster ${cluster} out of range`);
    }
    const start = Number(await this.readU64(this.clusterPtrPos + cluster * 8));
    const end =
      cluster + 1 < this.clusterCount
        ? Number(await this.readU64(this.clusterPtrPos + (cluster + 1) * 8))
        : this.direntEnd;
    if (start <= 0 || start >= end) throw new Error(`corrupt ZIM file: bad cluster ${cluster} span`);
    const flagBuf = await this.readAt(start, 1);
    if (flagBuf.length < 1) throw new Error(`corrupt ZIM file: cluster ${cluster} unreadable`);
    const flag = flagBuf[0];
    const osz = (flag & 0x10) !== 0 ? 8 : 4;
    const comp = flag & 0x0f;
    let info: ClusterInfo;
    // In both layouts the blob offsets are absolute within the decompressed
    // data (the table is part of it: offset[0] === table size), so for zstd
    // the decompressed buffer is used as-is and for raw the table is read
    // separately but offsets are counted from the region start (start + 1).
    if (comp === 0 || comp === 1) {
      // Uncompressed: an offset table, then the raw blob data.
      const off0 = (await this.readAt(start + 1, osz)).readUIntLE(0, osz);
      const n = off0 / osz;
      if (!Number.isInteger(n) || n < 1) throw new Error(`corrupt ZIM file: bad cluster ${cluster} table`);
      const table = await this.readAt(start + 1, n * osz);
      info = { kind: "raw", data: table, osz, n, dataBase: start + 1 };
    } else if (comp === 5) {
      // zstd: whole-cluster frame (modern writers) or table+frame (legacy).
      const head = await this.readAt(start + 1, 4);
      if (head.length === 4 && head.readUInt32LE(0) === ZSTD_MAGIC) {
        const dec = await this.decompressZstd(start + 1, end);
        const n = dec.readUIntLE(0, osz) / osz;
        if (!Number.isInteger(n) || n < 1) throw new Error(`corrupt ZIM file: bad cluster ${cluster} table`);
        info = { kind: "zstd", data: dec, osz, n, dataBase: 0 };
      } else {
        const off0 = (await this.readAt(start + 1, osz)).readUIntLE(0, osz);
        const n = off0 / osz;
        if (!Number.isInteger(n) || n < 1) throw new Error(`corrupt ZIM file: bad cluster ${cluster} table`);
        await this.readAt(start + 1, n * osz); // skip the table (offsets live in the frame)
        const dec = await this.decompressZstd(start + 1 + n * osz, end);
        info = { kind: "zstd", data: dec, osz, n, dataBase: 0 };
      }
    } else if (comp === 4) {
      throw new Error(`cluster ${cluster} uses LZMA2 compression, which is not supported`);
    } else {
      throw new Error(`cluster ${cluster} uses unknown compression ${comp}`);
    }
    this.clusterCache.set(cluster, info);
    this.clusterCacheBytes += info.data.length;
    while (this.clusterCacheBytes > CLUSTER_CACHE_MAX_BYTES && this.clusterCache.size > 1) {
      const oldest = this.clusterCache.keys().next().value;
      if (oldest === undefined) break;
      const ev = this.clusterCache.get(oldest);
      if (ev === undefined) break;
      this.clusterCacheBytes -= ev.data.length;
      this.clusterCache.delete(oldest);
    }
    return info;
  }

  /**
   * Decompress the zstd frame at [frameStart, frameEnd). Tries the sync
   * API on the exact range first; when the range has trailing bytes after
   * the frame (possible for the last cluster), falls back to the streaming
   * decoder, which stops at the frame end. Needs Node >= 22.15 either way.
   */
  private async decompressZstd(frameStart: number, frameEnd: number): Promise<Buffer> {
    const z = zlib as unknown as {
      zstdDecompressSync?: (buf: Buffer) => Buffer;
      createZstdDecompress?: () => ZstdStreamLike;
    };
    if (typeof z.zstdDecompressSync === "function") {
      try {
        return z.zstdDecompressSync(await this.readAt(frameStart, frameEnd - frameStart));
      } catch {
        // Trailing bytes after the frame: retry with the stream decoder.
      }
    }
    if (typeof z.createZstdDecompress !== "function") {
      throw new Error("zstd support requires Node >= 22.15");
    }
    const dec = z.createZstdDecompress();
    const chunks: Buffer[] = [];
    let finished = false;
    const done = new Promise<void>((resolve, reject) => {
      dec.on("data", (c) => chunks.push(c as Buffer));
      dec.on("end", () => {
        finished = true;
        resolve();
      });
      dec.on("error", reject);
    });
    try {
      let off = frameStart;
      while (off < frameEnd && !finished) {
        const chunk = await this.readAt(off, Math.min(1024 * 1024, frameEnd - off));
        if (chunk.length === 0) break;
        off += chunk.length;
        if (!dec.write(chunk)) {
          await new Promise<void>((r) => dec.once("drain", r));
        }
      }
      dec.end();
      await done;
      return Buffer.concat(chunks);
    } finally {
      dec.close();
    }
  }
}

/** The slice of node:zlib's zstd stream the reader drives (Node >= 22.15). */
interface ZstdStreamLike {
  write(chunk: Buffer): boolean;
  end(): void;
  close(): void;
  on(event: "data" | "end" | "error", listener: (...args: unknown[]) => void): unknown;
  once(event: "drain", listener: () => void): unknown;
}

/** Read one u64LE from a fresh fd (open-time helpers). */
async function readU64(fd: Awaited<ReturnType<typeof fs.open>>, off: number): Promise<bigint> {
  const b = Buffer.alloc(8);
  await fd.read(b, 0, 8, off);
  return b.readBigUInt64LE(0);
}

/** The NUL-terminated MIME strings starting at `pos` (up to a double NUL). */
async function readMimeList(fd: Awaited<ReturnType<typeof fs.open>>, pos: number): Promise<string[]> {
  const out: string[] = [];
  let off = pos;
  let acc = Buffer.alloc(0);
  while (out.length < 4096) {
    const chunk = Buffer.alloc(65536);
    const { bytesRead } = await fd.read(chunk, 0, 65536, off);
    if (bytesRead === 0) break;
    const buf = acc.length > 0 ? Buffer.concat([acc, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let p = 0;
    let lastComplete = 0;
    while (p < buf.length) {
      const e = buf.indexOf(0, p);
      if (e < 0) break;
      if (e === p) return out; // empty string: end of list
      out.push(buf.toString("utf8", p, e));
      p = e + 1;
      lastComplete = p;
    }
    off += buf.length;
    acc = lastComplete < buf.length ? buf.subarray(lastComplete) : Buffer.alloc(0);
  }
  return out;
}
