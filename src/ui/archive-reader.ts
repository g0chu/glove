import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ArchiveRecord, ArchiveScope } from "../llm/archive.js";

interface Interaction {
  id: string;
  time: string;
  scope: ArchiveScope;
  state: "pending" | "finished" | "failed";
  updated: number;
  records: ArchiveRecord[];
}

/** Read-only, incremental journal view; never acquires the bot's writer lock. */
export class InteractionReader {
  private offset = 0;
  private tail = Buffer.alloc(0);
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
    const journal = path.join(this.directory, "events.jsonl");
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
        this.tail = Buffer.concat([this.tail, buffer.subarray(0, bytesRead)]);
        let end: number;
        while ((end = this.tail.indexOf(10)) !== -1) {
          const record = JSON.parse(this.tail.subarray(0, end).toString("utf8")) as ArchiveRecord;
          const { hash, ...body } = record;
          if (record.version !== 1 || record.seq !== this.sequence + 1 || record.previous !== this.previous ||
            createHash("sha256").update(JSON.stringify(body)).digest("hex") !== hash) {
            throw new Error("archive journal verification failed");
          }
          this.sequence = record.seq;
          this.previous = hash;
          this.tail = this.tail.subarray(end + 1);
          const id = record.scope.requestId;
          if (!id || !record.type.startsWith("model.")) continue;
          let item = this.interactions.get(id);
          if (!item) {
            item = { id, time: record.time, scope: record.scope, state: "pending", updated: record.seq, records: [] };
            this.interactions.set(id, item);
          }
          item.records.push(record);
          item.updated = record.seq;
          if (record.type === "model.finished") item.state = "finished";
          if (record.type === "model.failed") item.state = "failed";
        }
      }
    } finally { await file.close(); }
  }

  private async blob(hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid archive blob hash");
    const bytes = await readFile(path.join(this.directory, "blobs", hash));
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
      const payload = await this.blob(record.data);
      const data = JSON.parse(payload.toString("utf8"));
      if (record.type === "model.request") requestBytes = payload;
      if (record.type === "model.bytes") chunks.push(await this.blob(data.blob));
      else events.push({ type: record.type, time: record.time, data });
    }
    return { ...metadata, events, rawRequest: requestBytes?.toString("utf8") ?? "", requestBytes: requestBytes?.length ?? 0, rawResponse: Buffer.concat(chunks).toString("utf8"),
      responseBase64: Buffer.concat(chunks).toString("base64"), responseBytes: chunks.reduce((n, chunk) => n + chunk.length, 0) };
  }
}
