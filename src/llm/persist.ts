import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChannelContext, SerializedChannelContext } from "./context.js";
import { errMsg, log } from "../log.js";

/**
 * File persistence for the per-channel conversation contexts: one JSON file
 * holding every channel's full context (the entries — the model's text,
 * reasoning, tool calls and tool results — the summary, the seeded flag,
 * the measured size), so a restart resumes each conversation exactly where
 * it left off instead of re-seeding the channel's last-N text.
 *
 * Best-effort by design: a write or read failure logs and keeps going (the
 * context lives on in memory; a lost file degrades to the old re-seed
 * behavior). Writes are atomic (temp file + rename) and coalesced (at most
 * one disk write per tick, no matter how many entries changed).
 */
export class ChatPersistence {
  /** The in-memory image of the file (loaded at startup, updated on save). */
  private readonly data = new Map<string, SerializedChannelContext>();
  /** The pending coalesced write (null when the disk is up to date). */
  private pending: Promise<void> | null = null;

  constructor(private readonly file: string) {}

  /**
   * Load the persisted contexts. A missing file (first run) yields an empty
   * map; a corrupt file logs and yields whatever could not be trusted — an
   * empty map (partial trust would risk half-restored channels).
   */
  load(): Map<string, SerializedChannelContext> {
    if (!existsSync(this.file)) return new Map();
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (err) {
      log.warn(`could not read the context store ${this.file}: ${errMsg(err)}; starting fresh`);
      return new Map();
    }
    let parsed: { version?: unknown; channels?: unknown };
    try {
      parsed = JSON.parse(raw) as { version?: unknown; channels?: unknown };
    } catch (err) {
      log.warn(`the context store ${this.file} is not valid JSON (${errMsg(err)}); starting fresh`);
      return new Map();
    }
    if (parsed.version !== 1 || typeof parsed.channels !== "object" || parsed.channels === null) {
      log.warn(`the context store ${this.file} has an unrecognized shape; starting fresh`);
      return new Map();
    }
    for (const [id, value] of Object.entries(parsed.channels as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const s = value as SerializedChannelContext;
      if (!Array.isArray(s.entries)) continue;
      this.data.set(id, s);
    }
    log.info(`context store ${this.file}: ${this.data.size} channel(s) restored`);
    return new Map(this.data);
  }

  /** Persist one channel's current context (coalesced: at most one write per tick). */
  save(channelId: string, context: ChannelContext): void {
    this.data.set(channelId, context.serialize());
    this.scheduleWrite();
  }

  /** Forget a channel (it was deleted). */
  remove(channelId: string): void {
    if (this.data.delete(channelId)) this.scheduleWrite();
  }

  /**
   * Await the pending write until the disk is up to date (shutdown): also
   * picks up saves scheduled while the current write is in flight (an
   * aborting turn records itself right after the abort).
   */
  async flush(): Promise<void> {
    let p = this.pending;
    while (p !== null) {
      await p;
      p = this.pending;
    }
  }

  private scheduleWrite(): void {
    if (this.pending !== null) return;
    this.pending = Promise.resolve()
      .then(() => this.write())
      .finally(() => {
        this.pending = null;
      });
  }

  private write(): void {
    try {
      const dir = path.dirname(this.file);
      if (dir !== "" && dir !== ".") mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({ version: 1, channels: Object.fromEntries(this.data) });
      writeFileSync(`${this.file}.tmp`, body);
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      log.warn(`could not write the context store ${this.file}: ${errMsg(err)}`);
    }
  }
}
