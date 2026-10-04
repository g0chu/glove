import { createHash } from "node:crypto";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ArchiveRecord, ArchiveScope } from "../llm/archive.js";
import { ArchiveLines } from "../llm/archive-lines.js";
import { archiveJournalPath, archiveSystemDirectory } from "../llm/archive-paths.js";

interface Interaction {
  id: string;
  time: string;
  scope: ArchiveScope;
  state: "pending" | "finished" | "failed";
  updated: number;
  records: InteractionRecord[];
}

interface InteractionRecord extends ArchiveRecord {
  journalOffset: number;
  journalLength: number;
}

/** Read-only, incremental journal view; never acquires the bot's writer lock. */
export class InteractionReader {
  private offset = 0;
  private consumed = 0;
  private readonly lines = new ArchiveLines();
  private previous = "";
  private sequence = 0;
  private readonly ordered: Interaction[] = [];
  private readonly interactions = new Map<string, Interaction>();
  private refreshing: Promise<void> | undefined;

  constructor(private readonly directory: string) {}

  /** Incorporate complete committed lines, leaving a concurrent partial write for later. */
  refresh(): Promise<void> {
    if (!this.refreshing) this.refreshing = this.scan().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async scan(): Promise<void> {
    const journal = archiveJournalPath(this.directory);
    let size: number;
    try { size = (await stat(journal)).size; } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && this.offset === 0) return;
      throw err;
    }
    if (size < this.offset) throw new Error("archive journal was replaced; restart the web UI");
    const file = await open(journal, "r");
    try {
      while (this.offset < size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, size - this.offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        for (const line of this.lines.push(buffer.subarray(0, bytesRead))) {
          const journalOffset = this.consumed;
          this.consumed += line.length + 1;
          const record = JSON.parse(line.toString("utf8")) as ArchiveRecord;
          const { hash, ...body } = record;
          if (![1, 2].includes(record.version) || record.seq !== this.sequence + 1 || record.previous !== this.previous ||
            createHash("sha256").update(JSON.stringify(body)).digest("hex") !== hash) {
            throw new Error("archive journal verification failed");
          }
          this.sequence = record.seq;
          this.previous = hash;
          const id = record.scope.requestId;
          if (!id || !record.type.startsWith("model.")) continue;
          let item = this.interactions.get(id);
          if (!item) {
            item = { id, time: record.time, scope: record.scope, state: "pending", updated: record.seq, records: [] };
            this.interactions.set(id, item);
            this.ordered.push(item);
          }
          // Keep only references in the live index; large inline requests and
          // image data are loaded from the journal when a user opens a request.
          const { payload: _payload, ...reference } = record;
          item.records.push({ ...reference, journalOffset, journalLength: line.length });
          item.updated = record.seq;
          if (record.type === "model.finished") item.state = "finished";
          if (record.type === "model.failed") item.state = "failed";
        }
      }
    } finally { await file.close(); }
  }

  private async blob(hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid archive blob hash");
    const bytes = await readFile(path.join(archiveSystemDirectory(this.directory), "blobs", hash));
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("archive blob verification failed");
    return bytes;
  }

  /** Page newest requests first, with optional metadata search. */
  list(query: string, before: number, limit = 100): { items: Omit<Interaction, "records">[]; next: number | null } {
    const page: Interaction[] = [];
    const search = query.toLowerCase();
    for (let i = this.ordered.length - 1; i >= 0; i--) {
      const item = this.ordered[i];
      if (item.records[0].seq >= before ||
        !`${item.id} ${item.scope.channelId ?? ""} ${item.scope.purpose ?? "reply"} ${item.state}`.toLowerCase().includes(search)) continue;
      page.push(item);
      if (page.length === limit + 1) break;
    }
    const more = page.length > limit;
    if (more) page.pop();
    return { items: page.map(({ records: _records, ...item }) => item),
      next: more ? page.at(-1)!.records[0].seq : null };
  }

  /** Load a request's exact captured body and response bytes, plus normalized completion. */
  async detail(id: string, readable = false): Promise<unknown | null> {
    const item = this.interactions.get(id);
    if (!item) return null;
    const { records: _records, ...metadata } = item;
    const chunks: Buffer[] = [];
    let requestBytes: Buffer | undefined;
    const events: { type: string; time: string; data: unknown }[] = [];
    // Reuse descriptors within this detail read, without caching verified bytes
    // across reads (later corruption must still be detected).
    const files = new Map<string, FileHandle>();
    const fileFor = async (name: string): Promise<FileHandle> => {
      let file = files.get(name);
      if (!file) { file = await open(name, "r"); files.set(name, file); }
      return file;
    };
    try {
      for (const record of [...item.records]) {
        const payload = record.version === 1 ? await this.blob(record.data) : await this.inlinePayload(record, fileFor);
        if (createHash("sha256").update(payload).digest("hex") !== record.data) throw new Error("archive payload verification failed");
        const data = JSON.parse(payload.toString("utf8"));
        if (record.type === "model.request") requestBytes = payload;
        if (record.type === "model.bytes") chunks.push(data.blob ? await this.blob(data.blob) : await this.response(data, fileFor));
        else if (!readable || record.type !== "model.started") events.push({ type: record.type, time: record.time, data });
      }
      const response = Buffer.concat(chunks);
      return { ...metadata, events, rawRequest: readable ? "" : requestBytes?.toString("utf8") ?? "", requestBytes: requestBytes?.length ?? 0, rawResponse: readable && events.some(event => event.type === "model.finished") ? "" : response.toString("utf8"),
        responseBase64: readable ? "" : response.toString("base64"), responseBytes: response.length };
    } finally { await Promise.all([...files.values()].map(file => file.close())); }
  }

  private async inlinePayload(record: InteractionRecord, fileFor: (name: string) => Promise<FileHandle>): Promise<Buffer> {
    const file = await fileFor(archiveJournalPath(this.directory));
    if (record.journalOffset + record.journalLength > (await file.stat()).size) throw new Error("archive journal was truncated");
    const bytes = Buffer.alloc(record.journalLength);
    for (let n = 0; n < bytes.length;) {
      const { bytesRead } = await file.read(bytes, n, bytes.length - n, record.journalOffset + n);
      if (!bytesRead) throw new Error("archive journal was truncated");
      n += bytesRead;
    }
    const current = JSON.parse(bytes.toString("utf8")) as ArchiveRecord;
    const { hash, ...body } = current;
    if (hash !== record.hash || createHash("sha256").update(JSON.stringify(body)).digest("hex") !== hash) {
      throw new Error("archive journal verification failed");
    }
    return Buffer.from(JSON.stringify(current.payload));
  }

  private async response(data: { file: string; offset: number; size: number; sha256: string }, fileFor: (name: string) => Promise<FileHandle>): Promise<Buffer> {
    if (!/^(?:_system\/)?responses\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.bin$/.test(data.file) || !Number.isSafeInteger(data.offset) || data.offset < 0 ||
      !Number.isSafeInteger(data.size) || data.size < 0) throw new Error("invalid archive response range");
    const file = await fileFor(path.join(this.directory, data.file));
    if (data.offset + data.size > (await file.stat()).size) throw new Error("archive response is truncated");
    const bytes = Buffer.alloc(data.size);
    for (let n = 0; n < bytes.length;) {
      const { bytesRead } = await file.read(bytes, n, bytes.length - n, data.offset + n);
      if (!bytesRead) throw new Error("archive response is truncated");
      n += bytesRead;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== data.sha256) throw new Error("archive response verification failed");
    return bytes;
  }
}
