import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ArchiveRecord, ConversationArchive } from "./archive.js";

/** A portable filename component; opaque IDs cannot escape the archive. */
export function archiveName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+/, "_");
  const extension = /\.[a-zA-Z0-9]{1,16}$/.exec(normalized)?.[0] ?? "";
  const safe = normalized.length > 120 ? normalized.slice(0, 120 - extension.length) + extension : normalized;
  if (safe === value && safe) return safe;
  return `${(extension ? safe.slice(0, -extension.length) : safe) || "unnamed"}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}${extension}`;
}

/** Atomically replace a derived JSON document. */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Relative location of an original-format attachment in a readable folder. */
export function attachmentViewPath(record: ArchiveRecord, data: { url: string; blob: string; name?: string; id?: string }): string {
  if (!record.scope.channelId) return `attachments/${data.blob}/${archiveName(data.name ?? "attachment")}`;
  const identity = data.id ?? new URL(data.url, "https://invalid.local").pathname.split("/").at(-2) ?? data.blob;
  return ["channels", archiveName(record.scope.channelId), "attachments", archiveName(record.scope.messageId ?? "unassigned"),
    `${archiveName(String(identity))}--${data.blob.slice(0, 16)}--${archiveName(data.name ?? "attachment")}`].join("/");
}

/** Rebuildable, readable channel views. The verified journal remains authoritative. */
export class ArchiveLayout {
  private readonly pendingTurns = new Map<string, { id: string; channelId: string }>();
  constructor(private readonly directory: string, private readonly copyAttachments = false) {}

  /** Repair views after a crash or upgrade, then mark the live session dirty. */
  restore(archive: ConversationArchive): void {
    let clean = false;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(this.directory, "layout.json"), "utf8"));
      const head = archive.head();
      clean = state.version === 1 && state.clean === true && state.seq === head.seq && state.hash === head.hash &&
        fs.existsSync(path.join(this.directory, "channels"));
    } catch { /* old archive or interrupted view write */ }
    if (!clean) {
      const stage = path.join(this.directory, `layout-rebuild-${randomUUID()}`);
      fs.mkdirSync(stage, { mode: 0o700 });
      const layout = new ArchiveLayout(stage);
      fs.mkdirSync(path.join(stage, "channels"), { mode: 0o700 });
      for (const record of archive.records()) layout.append(archive, record, true);
      // Restore only the latest context per channel instead of expanding every
      // growing historical checkpoint during a rebuild.
      for (const [id, context] of archive.restoreContexts()) {
        writeJson(path.join(stage, "channels", archiveName(id), "context.json"), context);
      }
      layout.finish(archive);
      const channels = path.join(this.directory, "channels");
      const old = `${channels}.old-${randomUUID()}`;
      if (fs.existsSync(channels)) fs.renameSync(channels, old);
      fs.renameSync(path.join(stage, "channels"), channels);
      fs.rmSync(stage, { recursive: true });
      if (fs.existsSync(old)) fs.rmSync(old, { recursive: true });
    }
    for (const record of archive.incomplete().turns) {
      if (!record.scope.channelId || !record.scope.turnId) continue;
      this.pendingTurns.set(path.join(this.directory, "channels", archiveName(record.scope.channelId), "turns", archiveName(record.scope.turnId)),
        { id: record.scope.turnId, channelId: record.scope.channelId });
    }
    writeJson(path.join(this.directory, "layout.json"), { version: 1, clean: false, ...archive.head() });
  }

  /** Materialize events, current context, completed turns and original-format attachments. */
  append(archive: ConversationArchive, record: ArchiveRecord, rebuilding = false): void {
    const channelId = record.scope.channelId;
    if (!channelId) return;
    const channel = path.join(this.directory, "channels", archiveName(channelId));
    fs.mkdirSync(channel, { recursive: true, mode: 0o700 });
    const data = archive.readData<any>(record, !rebuilding);
    const event = { seq: record.seq, time: record.time, type: record.type, scope: record.scope,
      payload: record.type === "context.checkpoint" ? (record.payload ?? data) :
        record.type === "attachment.saved" ? { ...data, file: attachmentViewPath(record, data) } : data };
    const events = path.join(channel, "events");
    fs.mkdirSync(events, { recursive: true, mode: 0o700 });
    const day = /^\d{4}-\d{2}-\d{2}/.exec(record.time)?.[0] ?? "undated";
    fs.appendFileSync(path.join(events, `${day}.jsonl`), JSON.stringify(event) + "\n", { mode: 0o600 });
    const metadata = path.join(channel, "channel.json");
    if (!fs.existsSync(metadata)) writeJson(metadata, { id: channelId });
    if (record.type === "discord.message" && data.channel) {
      writeJson(metadata, { id: channelId, guildId: data.channel.guildId ?? null, name: data.channel.name ?? null });
    }
    if (record.type === "context.checkpoint" && !rebuilding) writeJson(path.join(channel, "context.json"), data);
    if (record.type === "channel.deleted") writeJson(path.join(channel, "context.json"), null);
    if (record.type === "attachment.saved") {
      const bytes = archive.readBlob(data.blob);
      // Include the checksum to preserve replacement revisions and filename collisions.
      const target = path.join(this.directory, attachmentViewPath(record, data));
      const relative = path.relative(channel, target);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(target)) {
        if (this.copyAttachments) fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
        else {
          try { fs.linkSync(archive.blobFile(data.blob), target); } catch (error) {
            if (!["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
          }
        }
      }
      else if (createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== data.blob) throw new Error("archive attachment view is corrupt");
      writeJson(path.join(path.dirname(target), "metadata", `${path.basename(target)}.json`), { ...data, originalFilename: data.name ?? null, sha256: data.blob,
        bytes: bytes.length, path: relative.split(path.sep).join("/"), messageId: record.scope.messageId ?? null });
    }
    const turnId = record.scope.turnId;
    if (turnId) {
      const turns = path.join(channel, "turns");
      fs.mkdirSync(turns, { recursive: true, mode: 0o700 });
      const base = path.join(turns, archiveName(turnId));
      this.pendingTurns.set(base, { id: turnId, channelId });
      fs.appendFileSync(`${base}.jsonl`, JSON.stringify(event) + "\n", { mode: 0o600 });
      if (record.type === "turn.finished" || record.type === "turn.recovered") {
        this.snapshotTurn(base, turnId, channelId, record.type === "turn.recovered" ? "recovered" : "finished");
        this.pendingTurns.delete(base);
      }
    }
  }

  /** Record that all readable views reached the journal head on clean close. */
  finish(archive: ConversationArchive): void {
    for (const [base, turn] of this.pendingTurns) this.snapshotTurn(base, turn.id, turn.channelId, "incomplete");
    writeJson(path.join(this.directory, "layout.json"), { version: 1, clean: true, ...archive.head() });
  }

  private snapshotTurn(base: string, id: string, channelId: string, status: string): void {
    const rows = fs.readFileSync(`${base}.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    writeJson(`${base}.json`, { id, channelId, status: status === "finished" && rows.some(row => row.type === "turn.failed") ? "failed" : status, events: rows });
  }
}

/** Export a self-contained readable folder, refusing to overwrite any existing path. */
export function exportArchive(archive: ConversationArchive, directory: string, channelId?: string): void {
  fs.mkdirSync(directory, { mode: 0o700 });
  const layout = new ArchiveLayout(directory, true);
  fs.mkdirSync(path.join(directory, "channels"), { mode: 0o700 });
  for (const record of archive.records()) {
    if (channelId !== undefined && record.scope.channelId !== channelId) continue;
    let payload = archive.readData<any>(record);
    if (record.type === "attachment.saved") {
      const relative = attachmentViewPath(record, payload);
      if (!record.scope.channelId) {
        const target = path.join(directory, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, archive.readBlob(payload.blob), { mode: 0o600 });
      }
      payload = { ...payload, file: relative };
    }
    if (record.type === "model.bytes") {
      const bytes = archive.responseBytes(payload);
      const relative = `responses/${archiveName(record.scope.requestId ?? "unknown")}.bin`;
      fs.mkdirSync(path.join(directory, "responses"), { recursive: true, mode: 0o700 });
      const file = path.join(directory, relative);
      const offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
      fs.appendFileSync(file, bytes, { mode: 0o600 });
      payload = { file: relative, offset, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    fs.appendFileSync(path.join(directory, "events.jsonl"), JSON.stringify({ seq: record.seq, time: record.time,
      type: record.type, scope: record.scope, payload }) + "\n", { mode: 0o600 });
    // Render views through the original verified record; replace response references below.
    const exported = { ...record, payload, data: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
    layout.append(archive, exported);
  }
  layout.finish(archive);
  writeJson(path.join(directory, "README.json"), { format: "glove-conversation-export", version: 1,
    channelId: channelId ?? null, note: "readable export; use migrate to create a bot recovery archive" });
}
