import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { SerializedChannelContext, ContextEntry } from "./context.js";

/** Identifiers shared by related journal records; never endpoint credentials. */
export interface ArchiveScope {
  channelId?: string;
  messageId?: string;
  turnId?: string;
  attempt?: number;
  requestId?: string;
  executionId?: string;
  round?: number;
  purpose?: "reply" | "chime" | "compaction";
}

/** One committed journal record. Payloads live in immutable SHA-256 blobs. */
export interface ArchiveRecord {
  version: 1;
  seq: number;
  time: string;
  type: string;
  scope: ArchiveScope;
  data: string;
  previous: string;
  hash: string;
}

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
 * closed. No recovery operation invokes a model, tool, or Discord send.
 */
export class ConversationArchive {
  private fd = -1;
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
  private readonly tracked = new Map<string, Set<string>>();
  private readonly catchups = new Map<string, string | null>();
  private readonly recordedTurns = new Set<string>();
  private readonly indexedEntries = new Set<string>();
  readonly recoveredTail: string | null;

  constructor(readonly directory: string, private readonly onFailure?: (error: Error) => void) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(directory, "blobs"), { recursive: true, mode: 0o700 });
    this.claim();
    try {
      const journal = path.join(directory, "events.jsonl");
      this.fd = fs.openSync(journal, "a+", 0o600);
      syncDirectory(directory);
      syncDirectory(path.dirname(path.resolve(directory)));
      this.recoveredTail = this.recover();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private claim(): void {
    // Serialize stale-owner checks too: two simultaneous restarts must not
    // both unlink a dead owner's lock and accidentally admit two writers.
    const claim = path.join(this.directory, ".claim");
    const fd = fs.openSync(claim, "wx", 0o600);
    const lock = path.join(this.directory, ".lock");
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
  putBlob(bytes: Uint8Array): string {
    this.check();
    try {
      const hash = digest(bytes);
      const file = path.join(this.directory, "blobs", hash);
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
      return hash;
    } catch (err) { return this.fail(err); }
  }

  /** Read and verify a blob, rejecting path traversal and corrupted bytes. */
  readBlob(hash: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid archive blob hash");
    const bytes = fs.readFileSync(path.join(this.directory, "blobs", hash));
    if (digest(bytes) !== hash) throw new Error(`archive blob is corrupt: ${hash}`);
    return bytes;
  }

  /** Decode one record's immutable JSON payload. */
  readData<T = unknown>(record: Pick<ArchiveRecord, "data">): T {
    const data = JSON.parse(this.readBlob(record.data).toString("utf8"));
    if (data?.archiveFormat === "context-v1") {
      return { ...data.metadata, entries: data.entries.map((hash: string) => this.readData({ data: hash })) } as T;
    }
    return data as T;
  }

  /** Append and fsync one event, after its immutable payload is durable. */
  record(type: string, scope: ArchiveScope, data: unknown): number {
    this.check();
    try {
      // Checkpoints share immutable entry blobs; growing conversations do
      // not copy every old response/tool result into a new blob on each edit.
      let stored = data;
      if (type === "context.checkpoint") {
        const { entries, ...metadata } = data as SerializedChannelContext;
        stored = { archiveFormat: "context-v1", metadata,
          entries: entries.map((entry) => this.putBlob(Buffer.from(JSON.stringify(entry)))) };
      }
      const payload = this.putBlob(Buffer.from(JSON.stringify(stored)));
      const body = { version: 1 as const, seq: this.seq + 1, time: new Date().toISOString(), type, scope, data: payload, previous: this.previous };
      const record = { ...body, hash: digest(JSON.stringify(body)) };
      fs.writeFileSync(this.fd, JSON.stringify(record) + "\n");
      fs.fsyncSync(this.fd);
      this.accept(record);
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
      const stored = JSON.parse(this.readBlob(record.data).toString("utf8"));
      const entries: ContextEntry[] = [];
      if (stored.archiveFormat === "context-v1") {
        for (const hash of stored.entries as string[]) {
          const key = `${channelId}:${hash}`;
          if (this.indexedEntries.has(key)) continue;
          entries.push(this.readData<ContextEntry>({ data: hash }));
          this.indexedEntries.add(key);
        }
      } else entries.push(...stored.entries);
      for (const entry of entries) {
        for (const id of entry.ids) ids.add(id);
        if (entry.turnId) this.recordedTurns.add(entry.turnId);
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
    }
    if (channelId && record.type === "catchup.started") this.catchups.set(channelId, this.readData<{ after: string | null }>(record).after);
    if (channelId && record.type === "catchup.finished") this.catchups.delete(channelId);
  }

  private recover(): string | null {
    const buf = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let position = 0;
    let committedBytes = 0;
    for (;;) {
      const n = fs.readSync(this.fd, buf, 0, buf.length, position);
      if (n === 0) break;
      position += n;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      let nl: number;
      while ((nl = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, nl).toString("utf8");
        const record = JSON.parse(line) as ArchiveRecord;
        const { hash, ...body } = record;
        if (record.version !== 1 || record.seq !== this.seq + 1 || record.previous !== this.previous ||
          typeof record.type !== "string" || !record.scope || hash !== digest(JSON.stringify(body))) {
          throw new Error(`archive journal is corrupt at sequence ${this.seq + 1}`);
        }
        // Ensure committed payloads are readable before accepting recovery.
        const data = JSON.parse(this.readBlob(record.data).toString("utf8")) as { blob?: string };
        if (record.type === "model.bytes" || record.type === "attachment.saved") this.readBlob(data.blob ?? "");
        this.accept(record);
        committedBytes += nl + 1;
        pending = pending.subarray(nl + 1);
      }
    }
    if (pending.length === 0) return null;
    const tail = path.join(this.directory, `torn-tail-${randomUUID()}.bin`);
    const fd = fs.openSync(tail, "wx", 0o600);
    try { fs.writeFileSync(fd, pending); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(this.directory);
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

  /** Unfinished catch-up retains its original boundary across another crash. */
  catchupCursors(): Map<string, string | null> {
    return new Map([...this.cursors, ...this.catchups]);
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
    let pending = Buffer.alloc(0);
    for (let position = 0; position < end;) {
      const n = fs.readSync(this.fd, buf, 0, Math.min(buf.length, end - position), position);
      if (!n) break;
      position += n;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      let nl: number;
      while ((nl = pending.indexOf(10)) !== -1) {
        yield JSON.parse(pending.subarray(0, nl).toString("utf8")) as ArchiveRecord;
        pending = pending.subarray(nl + 1);
      }
    }
  }

  /** Read previously captured attachment bytes without relying on a live CDN URL. */
  attachment(url: string): Buffer | null {
    const hash = this.attachments.get(url);
    return hash ? this.readBlob(hash) : null;
  }

  /** Incomplete operations are evidence only; never automatically replay them. */
  incomplete(): { tools: ArchiveRecord[]; requests: ArchiveRecord[]; turns: ArchiveRecord[] } {
    return { tools: [...this.unfinished.values()], requests: [...this.requests.values()], turns: [...this.turns.values()] };
  }

  /** Close the writer and release this process's lock. All writes already fsynced. */
  close(): void {
    if (this.fd >= 0) fs.closeSync(this.fd);
    this.fd = -1;
    const lock = path.join(this.directory, ".lock");
    if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === this.owner) fs.unlinkSync(lock);
  }
}
