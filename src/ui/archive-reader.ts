import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
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
  list(query: string, before: number): { items: Omit<Interaction, "records">[]; next: number | null } {
    const matches = [...this.interactions.values()].reverse().filter((item) =>
      item.records[0].seq < before && `${item.id} ${item.scope.channelId ?? ""} ${item.scope.purpose ?? "reply"} ${item.state}`.toLowerCase().includes(query.toLowerCase()));
    const page = matches.slice(0, 100);
    return { items: page.map(({ records: _records, ...item }) => item),
      next: matches.length > 100 ? page.at(-1)!.records[0].seq : null };
  }

  /** Load a request's exact captured body and response bytes, plus normalized completion. */
  async detail(id: string): Promise<unknown | null> {
    const item = this.interactions.get(id);
    if (!item) return null;
    const { records: _records, ...metadata } = item;
    const chunks: Buffer[] = [];
    let requestBytes: Buffer | undefined;
    const events: { type: string; time: string; data: unknown }[] = [];
    for (const record of [...item.records]) {
      const payload = record.version === 1 ? await this.blob(record.data) : await this.inlinePayload(record);
      if (createHash("sha256").update(payload).digest("hex") !== record.data) throw new Error("archive payload verification failed");
      const data = JSON.parse(payload.toString("utf8"));
      if (record.type === "model.request") requestBytes = payload;
      if (record.type === "model.bytes") chunks.push(data.blob ? await this.blob(data.blob) : await this.response(data));
      else events.push({ type: record.type, time: record.time, data });
    }
    return { ...metadata, events, rawRequest: requestBytes?.toString("utf8") ?? "", requestBytes: requestBytes?.length ?? 0, rawResponse: Buffer.concat(chunks).toString("utf8"),
      responseBase64: Buffer.concat(chunks).toString("base64"), responseBytes: chunks.reduce((n, chunk) => n + chunk.length, 0) };
  }

  private async inlinePayload(record: InteractionRecord): Promise<Buffer> {
    const file = await open(archiveJournalPath(this.directory), "r");
    try {
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
    } finally { await file.close(); }
  }

  private async response(data: { file: string; offset: number; size: number; sha256: string }): Promise<Buffer> {
    if (!/^(?:_system\/)?responses\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.bin$/.test(data.file) || !Number.isSafeInteger(data.offset) || data.offset < 0 ||
      !Number.isSafeInteger(data.size) || data.size < 0) throw new Error("invalid archive response range");
    const file = await open(path.join(this.directory, data.file), "r");
    try {
      if (data.offset + data.size > (await file.stat()).size) throw new Error("archive response is truncated");
      const bytes = Buffer.alloc(data.size);
      for (let n = 0; n < bytes.length;) {
        const { bytesRead } = await file.read(bytes, n, bytes.length - n, data.offset + n);
        if (!bytesRead) throw new Error("archive response is truncated");
        n += bytesRead;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== data.sha256) throw new Error("archive response verification failed");
      return bytes;
    } finally { await file.close(); }
  }
}
