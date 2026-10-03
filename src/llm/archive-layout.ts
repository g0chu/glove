import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ArchiveRecord, ConversationArchive } from "./archive.js";
import { archiveChannelName, archiveSystemDirectory } from "./archive-paths.js";

/** A portable filename component; opaque IDs cannot escape the archive. */
export function archiveName(value: string): string {
  let normalized = value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "_").replace(/[ .]+$/, "");
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized)) normalized = `_${normalized}`;
  const extension = /\.[a-zA-Z0-9]{1,16}$/.exec(normalized)?.[0] ?? "";
  const characters = [...(extension ? normalized.slice(0, -extension.length) : normalized)];
  while (Buffer.byteLength(characters.join("") + extension) > 120) characters.pop();
  const safe = characters.join("") + extension;
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
export function attachmentViewPath(record: ArchiveRecord, data: { url: string; blob: string; name?: string; id?: string }, channelFolder = archiveChannelName(record.scope.channelId ?? "unassigned")): string {
  if (!record.scope.channelId) return `_system/attachments/${data.blob}/${archiveName(data.name ?? "attachment")}`;
  const identity = data.id ?? new URL(data.url, "https://invalid.local").pathname.split("/").at(-2) ?? data.blob;
  const name = archiveName(data.name ?? "attachment");
  const extension = path.extname(name);
  const token = /^[a-zA-Z0-9_-]{1,32}$/.test(String(identity)) ? String(identity) :
    createHash("sha256").update(String(identity)).digest("hex").slice(0, 16);
  return ["channels", channelFolder, "attachments", archiveName(record.scope.messageId ?? "unassigned"),
    `${name.slice(0, name.length - extension.length)}--${token}--${data.blob.slice(0, 16)}${extension}`].join("/");
}

/** Date/time labels put turns in chronological order while IDs keep their names unique. */
export function archiveTurnFolder(record: ArchiveRecord, chime?: boolean): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(record.time)?.[0] ?? "undated";
  const time = /T(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/.exec(record.time)?.[1].replace(/:/g, "-") ?? "unknown-time";
  return `${day}/${time}--${chime === true ? "chime" : "reply"}--${archiveName(record.scope.turnId ?? "unknown")}`;
}

/** Rebuildable, readable channel views. The verified journal remains authoritative. */
export class ArchiveLayout {
  private readonly pendingTurns = new Map<string, { id: string; channelId: string; folder: string }>();
  private readonly channelFolders = new Map<string, string>();
  constructor(private readonly directory: string, private readonly copyAttachments = false, channelFolders?: Map<string, string>) {
    if (channelFolders) for (const [id, folder] of channelFolders) this.channelFolders.set(id, folder);
  }

  private channelDirectory(id: string, name?: string | null): string {
    if (!this.channelFolders.has(id)) this.channelFolders.set(id, archiveChannelName(id, name));
    return path.join(this.directory, "channels", this.channelFolders.get(id)!);
  }

  private stateFile(): string {
    return path.join(archiveSystemDirectory(this.directory), "layout.json");
  }

  private writeReadme(): void {
    fs.writeFileSync(path.join(this.directory, "README.md"),
      "# Conversation archive\n\nBrowse `channels/` for conversations. Channel folders use their Discord name and ID.\n\n" +
      "- `channel.json`: channel name, guild and ID.\n" +
      "- `context.json`: current model context.\n" +
      "- `events/YYYY-MM-DD.jsonl`: channel history by day.\n" +
      "- `turns/YYYY-MM-DD/HH-mm-ss.sss--reply-or-chime--ID/`: one turn, containing `turn.json` and `events.jsonl`. Times are UTC.\n" +
      "- `attachments/MESSAGE-ID/`: original files, with matching JSON descriptions in `metadata/`.\n\n" +
      (this.copyAttachments ? "This is a folder export for browsing and sharing, not a bot recovery archive. `_system/` holds exported events, response bytes and format metadata.\n" :
        "`_system/` holds the verified journal, shared checkpoint data, original bytes and recovery bookkeeping. " +
        "Channel views are rebuilt from this data. Treat the archive as read-only; attachment views may be hard links.\n"),
      { mode: 0o600 });
  }

  /** Repair views after a crash or upgrade, then mark the live session dirty. */
  restore(archive: ConversationArchive): void {
    let clean = false;
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile(), "utf8"));
      const head = archive.head();
      if (state.version === 2 && Array.isArray(state.channels)) {
        for (const [id, folder] of state.channels) {
          if (typeof id !== "string" || typeof folder !== "string" || !/^[\p{L}\p{N}_-]+$/u.test(folder)) throw new Error("invalid channel folder");
          this.channelFolders.set(id, folder);
        }
      }
      clean = state.version === 2 && Array.isArray(state.channels) && state.clean === true && state.seq === head.seq && state.hash === head.hash &&
        fs.existsSync(path.join(this.directory, "channels"));
    } catch { this.channelFolders.clear(); /* old archive or interrupted view write */ }
    if (!clean) {
      const stage = path.join(this.directory, `layout-rebuild-${randomUUID()}`);
      fs.mkdirSync(stage, { mode: 0o700 });
      const layout = new ArchiveLayout(stage, false, this.channelFolders);
      fs.mkdirSync(path.join(stage, "channels"), { mode: 0o700 });
      for (const record of archive.records()) layout.append(archive, record, true);
      // Restore only the latest context per channel instead of expanding every
      // growing historical checkpoint during a rebuild.
      for (const [id, context] of archive.restoreContexts()) {
        writeJson(path.join(layout.channelDirectory(id), "context.json"), context);
      }
      layout.finish(archive);
      const channels = path.join(this.directory, "channels");
      const old = `${channels}.old-${randomUUID()}`;
      if (fs.existsSync(channels)) fs.renameSync(channels, old);
      fs.renameSync(path.join(stage, "channels"), channels);
      this.channelFolders.clear();
      for (const [id, folder] of layout.channelFolders) this.channelFolders.set(id, folder);
      fs.rmSync(stage, { recursive: true });
      if (fs.existsSync(old)) fs.rmSync(old, { recursive: true });
    }
    for (const record of archive.incomplete().turns) {
      if (!record.scope.channelId || !record.scope.turnId) continue;
      const data = archive.readData<{ chime?: boolean }>(record);
      this.pendingTurns.set(JSON.stringify([record.scope.channelId, record.scope.turnId]),
        { id: record.scope.turnId, channelId: record.scope.channelId, folder: archiveTurnFolder(record, data.chime) });
    }
    this.writeReadme();
    writeJson(this.stateFile(), { version: 2, clean: false, channels: [...this.channelFolders], ...archive.head() });
  }

  /** Materialize events, current context, completed turns and original-format attachments. */
  append(archive: ConversationArchive, record: ArchiveRecord, rebuilding = false): void {
    const channelId = record.scope.channelId;
    if (!channelId) return;
    const data = archive.readData<any>(record, !rebuilding);
    const channel = this.channelDirectory(channelId, record.type === "discord.message" ? data.channel?.name : undefined);
    fs.mkdirSync(channel, { recursive: true, mode: 0o700 });
    const attachmentPath = record.type === "attachment.saved" ? attachmentViewPath(record, data, this.channelFolders.get(channelId)) : undefined;
    const event = { seq: record.seq, time: record.time, type: record.type, scope: record.scope,
      payload: record.type === "context.checkpoint" ? (record.payload ?? data) :
        record.type === "attachment.saved" ? { ...data, file: attachmentPath } : data };
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
      const target = path.join(this.directory, attachmentPath!);
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
      const key = JSON.stringify([channelId, turnId]);
      const turn = this.pendingTurns.get(key) ?? { id: turnId, channelId, folder: archiveTurnFolder(record, data.chime) };
      this.pendingTurns.set(key, turn);
      const base = path.join(channel, "turns", turn.folder);
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(base, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
      if (record.type === "turn.finished" || record.type === "turn.recovered") {
        this.snapshotTurn(base, turnId, channelId, record.type === "turn.recovered" ? "recovered" : "finished");
        this.pendingTurns.delete(key);
      }
    }
  }

  /** Record that all readable views reached the journal head on clean close. */
  finish(archive: ConversationArchive): void {
    for (const turn of this.pendingTurns.values()) {
      this.snapshotTurn(path.join(this.channelDirectory(turn.channelId), "turns", turn.folder), turn.id, turn.channelId, "incomplete");
    }
    this.writeReadme();
    writeJson(this.stateFile(), { version: 2, clean: true, channels: [...this.channelFolders], ...archive.head() });
  }

  private snapshotTurn(base: string, id: string, channelId: string, status: string): void {
    const rows = fs.readFileSync(path.join(base, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    writeJson(path.join(base, "turn.json"), { id, channelId, status: status === "finished" && rows.some(row => row.type === "turn.failed") ? "failed" : status, events: rows });
  }
}

/** Export a self-contained readable folder, refusing to overwrite any existing path. */
export function exportArchive(archive: ConversationArchive, directory: string, channelId?: string): void {
  fs.mkdirSync(directory, { mode: 0o700 });
  const channelFolders = new Map<string, string>();
  for (const record of archive.records()) {
    if (record.type !== "discord.message" || !record.scope.channelId) continue;
    const data = archive.readData<{ channel?: { name?: string } }>(record);
    if (data.channel?.name) channelFolders.set(record.scope.channelId, archiveChannelName(record.scope.channelId, data.channel.name));
  }
  const layout = new ArchiveLayout(directory, true, channelFolders);
  const system = archiveSystemDirectory(directory);
  fs.mkdirSync(system, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(directory, "channels"), { mode: 0o700 });
  for (const record of archive.records()) {
    if (channelId !== undefined && record.scope.channelId !== channelId) continue;
    let payload = archive.readData<any>(record);
    if (record.type === "attachment.saved") {
      const relative = attachmentViewPath(record, payload, channelFolders.get(record.scope.channelId ?? ""));
      if (!record.scope.channelId) {
        const target = path.join(directory, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, archive.readBlob(payload.blob), { mode: 0o600 });
      }
      payload = { ...payload, file: relative };
    }
    if (record.type === "model.bytes") {
      const bytes = archive.responseBytes(payload);
      const relative = `_system/responses/${archiveName(record.scope.requestId ?? "unknown")}.bin`;
      fs.mkdirSync(path.join(system, "responses"), { recursive: true, mode: 0o700 });
      const file = path.join(directory, relative);
      const offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
      fs.appendFileSync(file, bytes, { mode: 0o600 });
      payload = { file: relative, offset, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    fs.appendFileSync(path.join(system, "events.jsonl"), JSON.stringify({ seq: record.seq, time: record.time,
      type: record.type, scope: record.scope, payload }) + "\n", { mode: 0o600 });
    // Render views through the original verified record; replace response references below.
    const exported = { ...record, payload, data: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
    layout.append(archive, exported);
  }
  layout.finish(archive);
  writeJson(path.join(system, "export.json"), { format: "glove-conversation-export", version: 1,
    channelId: channelId ?? null, note: "readable export; use migrate to create a bot recovery archive" });
}
