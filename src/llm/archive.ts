import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { SerializedChannelContext, ContextEntry } from "./context.js";
import { attachmentIdentity } from "./client.js";
import { ArchiveLayout, archiveName } from "./archive-layout.js";
import { ArchiveLines } from "./archive-lines.js";
import { archiveSystemDirectory } from "./archive-paths.js";

/** Identifiers shared by related journal records; never endpoint credentials. */
export interface ArchiveScope {
  channelId?: string;
  messageId?: string;
  turnId?: string;
  attempt?: number;
  requestId?: string;
  executionId?: string;
  round?: number;
  purpose?: "reply" | "reply-candidate" | "chime" | "compaction";
}

/** One committed journal record; v1 references blobs, v2 includes JSON payloads. */
export interface ArchiveRecord {
  version: 1 | 2;
  seq: number;
  time: string;
  type: string;
  scope: ArchiveScope;
  data: string;
  previous: string;
  hash: string;
  /** Version 2 stores JSON directly in the journal. */
  payload?: unknown;
}

// Only the deduplication accelerator is evictable; recovery IDs are durable state.
const INDEXED_ENTRY_CACHE_LIMIT = 16_384;
const RECOVERY_INDEX_MAX_BYTES = 64 * 1024 * 1024;

function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * A single-writer, durable archive independent of the compactable context.
 * Payload and journal fsyncs finish before record() returns. Write failures
 * poison the instance: callers must stop, never execute unjournaled tools.
 * A torn final journal line is quarantined on open; other corruption fails
 * closed when verified. Fast recovery defers old blob checks until access.
 * No recovery operation invokes a model, tool, or Discord send.
 */
export class ConversationArchive {
  private readonly systemDirectory: string;
  private fd = -1;
  private readonly responseFiles = new Map<string, { fd: number; offset: number; file: string }>();
  private seq = 0;
  private previous = "";
  private failure: Error | null = null;
  private readonly owner = `${process.pid}:${randomUUID()}`;
  private readonly checkpoints = new Map<string, string | null>();
  private readonly cursors = new Map<string, string>();
  private readonly unfinished = new Map<string, ArchiveRecord>();
  private readonly requests = new Map<string, ArchiveRecord>();
  private readonly turns = new Map<string, ArchiveRecord>();
  private readonly attachments = new Map<string, string>();
  private readonly attachmentIdentities = new Map<string, string>();
  private readonly tracked = new Map<string, Set<string>>();
  private readonly catchups = new Map<string, string | null>();
  private readonly reconciledCursors = new Map<string, string | null>();
  private readonly recordedTurns = new Set<string>();
  private readonly indexedEntries = new Set<string>();
  private recovered = false;
  private layout: ArchiveLayout | undefined;
  readonly recoveredTail: string | null;

  constructor(readonly directory: string, private readonly onFailure?: (error: Error) => void, private readonly fastRecovery = false) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.systemDirectory = archiveSystemDirectory(directory);
    fs.mkdirSync(this.systemDirectory, { recursive: true, mode: 0o700 });
    this.claim();
    try {
      const journal = path.join(this.systemDirectory, "events.jsonl");
      this.fd = fs.openSync(journal, "a+", 0o600);
      syncDirectory(this.systemDirectory);
      syncDirectory(directory);
      syncDirectory(path.dirname(path.resolve(directory)));
      const offset = this.fastRecovery ? this.loadIndex() : 0;
      this.recoveredTail = this.recover(offset);
      for (const [url, blob] of this.attachments) this.attachmentIdentities.set(attachmentIdentity(url), blob);
      this.recovered = true;
      this.layout = new ArchiveLayout(directory);
      this.layout.restore(this);
      if (this.fastRecovery) this.saveIndex();
    } catch (err) {
      this.layout = undefined;
      this.recovered = false;
      this.close();
      throw err;
    }
  }

  private claim(): void {
    // Serialize stale-owner checks too: two simultaneous restarts must not
    // both unlink a dead owner's lock and accidentally admit two writers.
    const claim = path.join(this.systemDirectory, ".claim");
    const fd = fs.openSync(claim, "wx", 0o600);
    const lock = path.join(this.systemDirectory, ".lock");
    try {
      if (fs.existsSync(lock)) {
        const owner = fs.readFileSync(lock, "utf8");
        const pid = Number(owner.split(":")[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("archive lock is malformed; inspect it before removing it");
        let alive = true;
        try { process.kill(pid, 0); } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive) throw new Error(`archive is already owned by process ${pid}`);
        fs.unlinkSync(lock);
      }
      fs.writeFileSync(lock, this.owner, { flag: "wx", mode: 0o600 });
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(claim);
    }
  }

  private check(): void {
    if (this.failure) throw this.failure;
    if (this.fd < 0) throw new Error("archive is closed");
  }

  private fail(err: unknown): never {
    if (this.failure) throw this.failure;
    this.failure = new Error(`durable archive failed: ${err instanceof Error ? err.message : String(err)}`);
    this.onFailure?.(this.failure);
    throw this.failure;
  }

  /** Save exact bytes once; the returned hash is also the blob's filename. */
  putBlob(bytes: Uint8Array, json = false): string {
    this.check();
    try {
      const hash = digest(bytes);
      const folder = path.join(this.systemDirectory, json ? "checkpoints" : "blobs");
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = path.join(folder, json ? `${hash}.json` : hash);
      if (fs.existsSync(file)) {
        if (digest(fs.readFileSync(file)) !== hash) throw new Error(`archive blob is corrupt: ${hash}`);
        return hash;
      }
      const temp = `${file}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
      syncDirectory(path.dirname(file));
      syncDirectory(this.systemDirectory);
      syncDirectory(this.directory);
      return hash;
    } catch (err) { return this.fail(err); }
  }

  /** Locate content by checksum across legacy blobs, JSON files and named attachments. */
  blobFile(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid archive blob hash");
    const legacy = path.join(this.systemDirectory, "blobs", hash);
    const json = path.join(this.systemDirectory, "checkpoints", `${hash}.json`);
    const attachment = path.join(this.systemDirectory, "attachments", hash);
    const oldJson = path.join(this.systemDirectory, "json", `${hash}.json`);
    return fs.existsSync(legacy) ? legacy : fs.existsSync(json) ? json : fs.existsSync(oldJson) ? oldJson :
      path.join(attachment, fs.readdirSync(attachment).filter(name => !/\.[a-f0-9-]{36}\.tmp$/.test(name)).sort()[0]);
  }

  /** Read and verify stored content, rejecting path traversal and corrupted bytes. */
  readBlob(hash: string): Buffer {
    const bytes = fs.readFileSync(this.blobFile(hash));
    if (digest(bytes) !== hash) throw new Error(`archive blob is corrupt: ${hash}`);
    return bytes;
  }

  /** Save original attachment bytes under a safe original-format filename. */
  putAttachment(bytes: Uint8Array, name: string): string {
    this.check();
    try {
      const hash = digest(bytes);
      const folder = path.join(this.systemDirectory, "attachments", hash);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = path.join(folder, archiveName(name));
      if (fs.existsSync(file)) {
        if (digest(fs.readFileSync(file)) !== hash) throw new Error("archive attachment is corrupt");
      } else {
        const sibling = fs.readdirSync(folder).find(entry => !/\.[a-f0-9-]{36}\.tmp$/.test(entry));
        if (sibling) {
          const existing = path.join(folder, sibling);
          if (digest(fs.readFileSync(existing)) !== hash) throw new Error("archive attachment is corrupt");
          fs.linkSync(existing, file);
          syncDirectory(folder);
          return hash;
        }
        const temporary = `${file}.${randomUUID()}.tmp`;
        const fd = fs.openSync(temporary, "wx", 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
        syncDirectory(folder);
        syncDirectory(path.dirname(folder));
        syncDirectory(this.systemDirectory);
        syncDirectory(this.directory);
      }
      return hash;
    } catch (err) { return this.fail(err); }
  }

  /** Decode and verify a payload, expanding shared checkpoint entries by default. */
  readData<T = unknown>(record: Pick<ArchiveRecord, "data" | "payload">, expandContext = true): T {
    const bytes = record.payload === undefined ? this.readBlob(record.data) : Buffer.from(JSON.stringify(record.payload));
    if (digest(bytes) !== record.data) throw new Error("archive payload is corrupt");
    const data = JSON.parse(bytes.toString("utf8"));
    if (expandContext && data?.archiveFormat === "context-v1") {
      return { ...data.metadata, entries: data.entries.map((hash: string) => this.readData({ data: hash })) } as T;
    }
    return data as T;
  }

  /** Append and fsync one event, after its immutable payload is durable. */
  record(type: string, scope: ArchiveScope, data: unknown, time = new Date().toISOString()): number {
    this.check();
    try {
      // Checkpoints share immutable entry blobs; growing conversations do
      // not copy every old response/tool result into a new blob on each edit.
      let stored = data;
      if (type === "context.checkpoint") {
        const { entries, ...metadata } = data as SerializedChannelContext;
        stored = { archiveFormat: "context-v1", metadata,
          entries: entries.map((entry) => this.putBlob(Buffer.from(JSON.stringify(entry)), true)) };
      }
      const bytes = Buffer.from(JSON.stringify(stored));
      // Only checkpoint manifests need a separate file for indexed random access.
      const payload = type === "context.checkpoint" ? this.putBlob(bytes, true) : digest(bytes);
      const body = { version: 2 as const, seq: this.seq + 1, time, type, scope, data: payload, previous: this.previous, payload: JSON.parse(bytes.toString("utf8")) as unknown };
      const encoded = JSON.stringify(body);
      const record = { ...body, hash: digest(encoded) };
      fs.writeFileSync(this.fd, `${encoded.slice(0, -1)},"hash":"${record.hash}"}\n`);
      fs.fsyncSync(this.fd);
      this.accept(record);
      if ((type === "model.finished" || type === "model.failed") && scope.requestId) this.closeResponse(scope.requestId);
      this.layout?.append(this, record, false, type === "context.checkpoint" ? undefined : body.payload);
      return record.seq;
    } catch (err) { return this.fail(err); }
  }

  private accept(record: ArchiveRecord): void {
    this.seq = record.seq;
    this.previous = record.hash;
    const { channelId, messageId, executionId, requestId, turnId } = record.scope;
    if (channelId && record.type === "context.checkpoint") {
      this.checkpoints.set(channelId, record.data);
      const ids = this.tracked.get(channelId) ?? new Set<string>();
      const stored = record.payload ?? JSON.parse(this.readBlob(record.data).toString("utf8"));
      const track = (entry: ContextEntry): void => {
        for (const id of entry.ids) ids.add(id);
        if (entry.turnId) this.recordedTurns.add(entry.turnId);
      };
      const manifest = stored as { archiveFormat?: string; entries: string[] | ContextEntry[] };
      if (manifest.archiveFormat === "context-v1") {
        for (const hash of manifest.entries as string[]) {
          const key = `${channelId}:${hash}`;
          if (this.indexedEntries.has(key)) continue;
          track(this.readData<ContextEntry>({ data: hash }));
          this.indexedEntries.add(key);
          if (this.indexedEntries.size > INDEXED_ENTRY_CACHE_LIMIT) {
            this.indexedEntries.delete(this.indexedEntries.values().next().value!);
          }
        }
      } else {
        for (const entry of manifest.entries as ContextEntry[]) track(entry);
      }
      this.tracked.set(channelId, ids);
    }
    if (channelId && record.type === "channel.deleted") this.checkpoints.set(channelId, null);
    if (channelId && messageId && record.type === "discord.message" && /^\d+$/.test(messageId)) {
      const prev = this.cursors.get(channelId);
      if (!prev || BigInt(messageId) > BigInt(prev)) this.cursors.set(channelId, messageId);
    }
    if (executionId && record.type === "tool.started") this.unfinished.set(executionId, record);
    if (executionId && record.type === "tool.finished") this.unfinished.delete(executionId);
    if (requestId && record.type === "model.started") this.requests.set(requestId, record);
    if (requestId && (record.type === "model.finished" || record.type === "model.failed")) this.requests.delete(requestId);
    if (turnId && record.type === "turn.started") this.turns.set(turnId, record);
    if (turnId && (record.type === "turn.finished" || record.type === "turn.recovered")) this.turns.delete(turnId);
    if (record.type === "attachment.saved") {
      const { url, blob } = this.readData<{ url: string; blob: string }>(record);
      this.attachments.set(url, blob);
      this.attachmentIdentities.set(attachmentIdentity(url), blob);
    }
    if (channelId && record.type === "catchup.started") this.catchups.set(channelId, this.readData<{ after: string | null }>(record).after);
    if (channelId && record.type === "catchup.finished") {
      const { through } = this.readData<{ through?: string | null }>(record);
      if (through === null || (typeof through === "string" && /^\d+$/.test(through))) {
        this.reconciledCursors.set(channelId, through);
      }
      this.catchups.delete(channelId);
    }
  }

  // The disposable index caches derived state, never replaces journal evidence.
  // Hash the entire indexed journal prefix so edits/truncation invalidate it.
  private journalDigest(length: number): string {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < length;) {
      const n = fs.readSync(this.fd, buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (!n) throw new Error("archive journal truncated while reading recovery index");
      hash.update(buffer.subarray(0, n));
      offset += n;
    }
    return hash.digest("hex");
  }

  private indexState() {
    return {
      seq: this.seq, previous: this.previous,
      checkpoints: [...this.checkpoints], cursors: [...this.cursors],
      unfinished: [...this.unfinished], requests: [...this.requests], turns: [...this.turns],
      attachments: [...this.attachments], catchups: [...this.catchups],
      reconciledCursors: [...this.reconciledCursors],
      tracked: [...this.tracked].map(([id, ids]) => [id, [...ids]] as const),
      recordedTurns: [...this.recordedTurns],
    };
  }

  private loadIndex(): number {
    try {
      const file = path.join(this.systemDirectory, "recovery-index.json");
      if (fs.statSync(file).size > RECOVERY_INDEX_MAX_BYTES) return 0;
      const bytes = fs.readFileSync(file, "utf8");
      // A hash line followed by JSON avoids an escaped second copy of the state.
      const body = bytes.slice(65);
      if (bytes[64] !== "\n" || digest(body) !== bytes.slice(0, 64)) return 0;
      const { version, offset, journalHash, state } = JSON.parse(body) as {
        version: number; offset: number; journalHash: string; state: ReturnType<ConversationArchive["indexState"]>;
      };
      if (version !== 1 || !Number.isSafeInteger(offset) || offset < 0 || offset > fs.fstatSync(this.fd).size ||
        this.journalDigest(offset) !== journalHash) return 0;
      // Construct everything before mutating live state: malformed caches fall back cleanly.
      const maps = [new Map(state.checkpoints), new Map(state.cursors), new Map(state.unfinished),
        new Map(state.requests), new Map(state.turns), new Map(state.attachments), new Map(state.catchups),
        new Map(state.tracked.map(([id, ids]) => [id, new Set(ids)]))] as const;
      const recordedTurns = new Set(state.recordedTurns);
      const reconciledCursors = new Map(state.reconciledCursors ?? []);
      if (!Number.isSafeInteger(state.seq) || state.seq < 0 || typeof state.previous !== "string") return 0;
      const copy = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
        for (const [key, value] of source) target.set(key, value);
      };
      copy(this.checkpoints, maps[0]); copy(this.cursors, maps[1]); copy(this.unfinished, maps[2]);
      copy(this.requests, maps[3]); copy(this.turns, maps[4]); copy(this.attachments, maps[5]);
      copy(this.catchups, maps[6]); copy(this.tracked, maps[7]);
      copy(this.reconciledCursors, reconciledCursors);
      for (const id of recordedTurns) this.recordedTurns.add(id);
      this.seq = state.seq;
      this.previous = state.previous;
      return offset;
    } catch { return 0; }
  }

  private saveIndex(): void {
    const file = path.join(this.systemDirectory, "recovery-index.json");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const offset = fs.fstatSync(this.fd).size;
      const body = JSON.stringify({ version: 1, offset, journalHash: this.journalDigest(offset), state: this.indexState() });
      if (Buffer.byteLength(body) + 65 > RECOVERY_INDEX_MAX_BYTES) return;
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, digest(body) + "\n"); fs.writeFileSync(fd, body); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
      syncDirectory(this.systemDirectory);
    } catch {
      // Cache failure cannot compromise already-fsynced journal records.
      try { fs.unlinkSync(temp); } catch { /* no temporary file */ }
    }
  }

  private recover(offset = 0): string | null {
    const buf = Buffer.alloc(64 * 1024);
    const lines = new ArchiveLines();
    let position = offset;
    let committedBytes = offset;
    for (;;) {
      const n = fs.readSync(this.fd, buf, 0, buf.length, position);
      if (n === 0) break;
      position += n;
      for (const line of lines.push(buf.subarray(0, n))) {
        const record = JSON.parse(line.toString("utf8")) as ArchiveRecord;
        const { hash, ...body } = record;
        if (![1, 2].includes(record.version) || record.seq !== this.seq + 1 || record.previous !== this.previous ||
          typeof record.type !== "string" || !record.scope || hash !== digest(JSON.stringify(body))) {
          throw new Error(`archive journal is corrupt at sequence ${this.seq + 1}`);
        }
        // Ensure committed payloads are readable before accepting recovery.
        const data = this.readData<{ blob?: string }>(record, false);
        if (record.type === "model.bytes") this.responseBytes(data);
        if (record.type === "attachment.saved") this.readBlob(data.blob ?? "");
        if (record.type === "context.checkpoint") this.readBlob(record.data);
        this.accept(record);
        committedBytes += line.length + 1;
      }
    }
    const pending = lines.tail();
    if (pending.length === 0) return null;
    const quarantine = path.join(this.systemDirectory, "quarantine");
    fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    const tail = path.join(quarantine, `torn-tail-${randomUUID()}.bin`);
    const fd = fs.openSync(tail, "wx", 0o600);
    try { fs.writeFileSync(fd, pending); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(quarantine);
    syncDirectory(this.systemDirectory);
    fs.ftruncateSync(this.fd, committedBytes);
    fs.fsyncSync(this.fd);
    return tail;
  }

  /** Latest working checkpoints, including tombstones for deleted channels. */
  restoreContexts(): Map<string, SerializedChannelContext | null> {
    return new Map([...this.checkpoints].map(([id, hash]) => [id, hash === null ? null : this.readData<SerializedChannelContext>({ data: hash })]));
  }

  /** Highest captured Discord snowflake per channel, for offline catch-up. */
  messageCursors(): Map<string, string> { return new Map(this.cursors); }

  /** Current verified journal head, for disposable readable views. */
  head(): { seq: number; hash: string } { return { seq: this.seq, hash: this.previous }; }

  /** Completed REST coverage, never advanced by gateway observations alone. */
  catchupCursors(): Map<string, string | null> {
    // Legacy archives had only an observed cursor, which could hide gaps before
    // a newly received mention. Reconcile once from their oldest tracked ID.
    const boundaries = new Map<string, string | null>();
    for (const channelId of new Set([...this.cursors.keys(), ...this.checkpoints.keys()])) {
      if (this.reconciledCursors.has(channelId)) continue;
      let oldest: string | null = null;
      for (const id of this.tracked.get(channelId) ?? []) {
        if (/^\d+$/.test(id) && (oldest === null || BigInt(id) < BigInt(oldest))) oldest = id;
      }
      if (oldest === null) {
        const checkpoint = this.checkpoints.get(channelId);
        if (checkpoint) {
          const { clearedAt } = this.readData<SerializedChannelContext>({ data: checkpoint });
          // An imported empty clear has no observed message ID. Derive the
          // snowflake floor at its watermark to paginate its offline gap too.
          const discordEpoch = 1_420_070_400_000;
          if (typeof clearedAt === "number" && Number.isSafeInteger(clearedAt) && clearedAt > discordEpoch) {
            oldest = ((BigInt(clearedAt) - BigInt(discordEpoch)) << 22n).toString();
          }
        }
      }
      boundaries.set(channelId, oldest);
    }
    for (const [id, cursor] of this.reconciledCursors) boundaries.set(id, cursor);
    for (const [id, cursor] of this.catchups) boundaries.set(id, cursor);
    return boundaries;
  }

  /** Do not re-seed entries already cleared, deleted, or folded out of context. */
  wasTracked(channelId: string, messageId: string): boolean {
    return this.tracked.get(channelId)?.has(messageId) ?? false;
  }

  /** A turn checkpoint already committed, even if it was subsequently compacted. */
  hasRecordedTurn(turnId: string): boolean { return this.recordedTurns.has(turnId); }

  /** Stream the committed journal without retaining its entire contents in memory. */
  *records(): IterableIterator<ArchiveRecord> {
    this.check();
    const end = fs.fstatSync(this.fd).size;
    const buf = Buffer.alloc(64 * 1024);
    const lines = new ArchiveLines();
    for (let position = 0; position < end;) {
      const n = fs.readSync(this.fd, buf, 0, Math.min(buf.length, end - position), position);
      if (!n) break;
      position += n;
      for (const line of lines.push(buf.subarray(0, n))) {
        yield JSON.parse(line.toString("utf8")) as ArchiveRecord;
      }
    }
  }

  /** Read previously captured attachment bytes without relying on a live CDN URL. */
  attachment(url: string): Buffer | null {
    const hash = this.attachments.get(url) ?? this.attachmentIdentities.get(attachmentIdentity(url));
    return hash ? this.readBlob(hash) : null;
  }

  /** Append exact response bytes to one file per request, before journaling their range. */
  appendResponse(scope: ArchiveScope, bytes: Uint8Array, time?: string): void {
    this.check();
    try {
      if (!scope.requestId) throw new Error("response capture requires a request id");
      let response = this.responseFiles.get(scope.requestId);
      if (!response) {
        // Bound descriptors even when callers capture requests without a terminal event.
        if (this.responseFiles.size >= 32) this.closeResponse(this.responseFiles.keys().next().value!);
        const folder = path.join(this.systemDirectory, "responses");
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        const name = /^[a-zA-Z0-9_-]{1,120}$/.test(scope.requestId) ? scope.requestId : digest(scope.requestId);
        const file = path.relative(this.directory, path.join(folder, `${name}.bin`)).split(path.sep).join("/");
        const fd = fs.openSync(path.join(this.directory, file), "a+", 0o600);
        response = { fd, offset: fs.fstatSync(fd).size, file };
        this.responseFiles.set(scope.requestId, response);
        if (response.offset === 0) { syncDirectory(folder); syncDirectory(this.systemDirectory); syncDirectory(this.directory); }
      }
      const { fd, offset, file } = response;
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      response.offset += bytes.byteLength;
      this.record("model.bytes", scope, { file, offset, size: bytes.byteLength, sha256: digest(bytes) }, time);
    } catch (err) { this.fail(err); }
  }

  private closeResponse(id: string): void {
    const response = this.responseFiles.get(id);
    if (!response) return;
    fs.closeSync(response.fd);
    this.responseFiles.delete(id);
  }

  /** Verify a response range; legacy blob-based captures remain readable. */
  responseBytes(value: unknown): Buffer {
    const data = value as { blob?: string; file?: string; offset?: number; size?: number; sha256?: string };
    if (data.blob) return this.readBlob(data.blob);
    if (!data.file || !/^(?:_system\/)?responses\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.bin$/.test(data.file) ||
      !Number.isSafeInteger(data.offset) || data.offset! < 0 || !Number.isSafeInteger(data.size) || data.size! < 0) {
      throw new Error("invalid archive response range");
    }
    const fd = fs.openSync(path.join(this.directory, data.file), "r");
    try {
      if (data.offset! + data.size! > fs.fstatSync(fd).size) throw new Error("archive response is truncated");
      const bytes = Buffer.alloc(data.size!);
      for (let n = 0; n < bytes.length;) {
        const read = fs.readSync(fd, bytes, n, bytes.length - n, data.offset! + n);
        if (!read) throw new Error("archive response is truncated");
        n += read;
      }
      if (digest(bytes) !== data.sha256) throw new Error("archive response is corrupt");
      return bytes;
    } finally { fs.closeSync(fd); }
  }

  /** Incomplete operations are evidence only; never automatically replay them. */
  incomplete(): { tools: ArchiveRecord[]; requests: ArchiveRecord[]; turns: ArchiveRecord[] } {
    return { tools: [...this.unfinished.values()], requests: [...this.requests.values()], turns: [...this.turns.values()] };
  }

  /** Close the writer and release this process's lock. All writes already fsynced. */
  close(): void {
    let layoutError: unknown;
    const lock = path.join(this.systemDirectory, ".lock");
    const ownsDirectory = fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === this.owner;
    if (this.fd >= 0 && this.recovered && !this.failure && ownsDirectory) {
      try { this.layout?.finish(this); } catch (err) { layoutError = err; }
    }
    if (this.fd >= 0 && this.fastRecovery && this.recovered && !this.failure && ownsDirectory) this.saveIndex();
    for (const id of this.responseFiles.keys()) this.closeResponse(id);
    if (this.fd >= 0) fs.closeSync(this.fd);
    this.fd = -1;
    this.checkpoints.clear();
    this.cursors.clear();
    this.unfinished.clear();
    this.requests.clear();
    this.turns.clear();
    this.attachments.clear();
    this.attachmentIdentities.clear();
    this.tracked.clear();
    this.catchups.clear();
    this.reconciledCursors.clear();
    this.recordedTurns.clear();
    this.indexedEntries.clear();
    if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === this.owner) fs.unlinkSync(lock);
    if (layoutError) throw layoutError;
  }
}
