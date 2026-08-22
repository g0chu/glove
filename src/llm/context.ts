import type { ChatMessage, MessageAttachmentLike } from "./client.js";
import { isImageAttachment } from "./client.js";
import type { Role } from "./history.js";
import { speakerLabel } from "./history.js";

/**
 * The persistent per-channel conversation context (compaction mode).
 *
 * Where ChannelHistory is a sliding window that drops old messages, this
 * context grows: the channel's last N messages are seeded in when the bot
 * first talks in the channel after a start (so the context is exactly what
 * is in the channel, every author included), every new trackable message
 * and bot reply is appended, and nothing is dropped until the context fills
 * up. When the estimated request size passes the configured token budget,
 * the older part is folded into a model-written summary (compaction); the
 * newest messages stay verbatim. Everything is in-memory: after a restart
 * the context re-seeds from the channel again.
 */

/** One entry in the persistent channel context: exactly one Discord message, or one bot reply. */
export interface ContextEntry {
  role: Role;
  /** The text as the model sees it (mentions of the bot already stripped). */
  content: string;
  /** The Discord message id(s) backing the entry (one per chunk for a chunked reply). */
  ids: string[];
  /** Per-chunk text as posted (chunked bot replies only). */
  chunks?: string[];
  /** The author's display name (user entries). */
  name?: string;
  /** True when the author is another bot (labeled "(bot)" in the context). */
  bot?: boolean;
  /** Attachment metadata; images are downloaded at turn time, within the image window. */
  attachments: MessageAttachmentLike[];
  /** The Discord createdTimestamp (keeps the startup seed chronological). */
  ts: number;
}

/** A fetched channel message adapted for the startup seed (see bot/context.ts). */
export interface SeedEntry {
  id: string;
  ts: number;
  role: Role;
  content: string;
  name?: string;
  bot?: boolean;
  attachments: MessageAttachmentLike[];
}

/**
 * Rough token estimate (~4 chars per token). It only needs to be good
 * enough to trigger compaction before the model's context fills up.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Fixed cost assumed per image part in the estimate (vision tokens vary a lot by endpoint). */
const IMAGE_TOKEN_ESTIMATE = 1000;

/** A compaction summary is capped so a rambling model cannot bloat the context. */
export const COMPACTION_SUMMARY_MAX_CHARS = 4000;

/** The system prompt of the compaction (summarization) request. */
export const COMPACTION_SYSTEM_PROMPT =
  "You are the memory compressor of a Discord chat assistant. You receive a running " +
  "summary of a Discord channel's older messages and the messages that followed. " +
  "Write one updated summary of the whole conversation so the assistant can keep " +
  "talking without seeing the raw messages. Keep: concrete facts and decisions, open " +
  "threads and unanswered questions, names of people and things, code and identifiers, " +
  "anything asked to be remembered. Drop: greetings, small talk, filler. Use short " +
  "bullet points in the conversation's language, and never answer questions found in " +
  "the transcript.";

/**
 * Render the compactable part (the existing summary + the older entries) as
 * a plain transcript for the summarizer.
 */
export function compactionTranscript(summary: string | null, older: ContextEntry[]): string {
  const lines: string[] = [];
  if (summary && summary.trim().length > 0) {
    lines.push(`Running summary of the older messages:\n${summary.trim()}`);
    lines.push("");
  }
  for (const e of older) {
    const imgs = e.attachments.filter(isImageAttachment).map((a) => a.name);
    const imgNote = imgs.length > 0 ? ` [attachment: ${imgs.join(", ")}]` : "";
    if (e.content.length === 0 && imgs.length === 0) continue; // carries nothing
    const who = e.role === "assistant" ? "Bot" : e.name ? speakerLabel(e.name, e.bot ?? false) : "Someone";
    const content = e.content.length > 0 ? `${e.content}${imgNote}` : imgNote.trimStart();
    lines.push(`${who}: ${content}`.trimEnd());
  }
  return lines.join("\n");
}

/** The outcome of a compaction attempt (an empty fold and a failed summarizer are distinct). */
export type CompactionResult = { ok: true } | { ok: false; reason: "nothing-to-fold" | "summarizer" };

/**
 * One channel's persistent context: an optional summary of the compacted
 * older messages, followed by the raw recent entries (never sliding).
 */
export class ChannelContext {
  private summary: string | null = null;
  private readonly entries: ContextEntry[] = [];
  /** Whether the startup seed (the channel's last N messages) has been taken in. */
  seeded = false;

  /** Append a human message (trackable arrivals are human only). */
  pushUser(
    name: string,
    content: string,
    id: string,
    ts: number,
    attachments: MessageAttachmentLike[],
  ): ContextEntry {
    const entry: ContextEntry = { role: "user", content, ids: [id], name, ts, attachments: [...attachments] };
    this.entries.push(entry);
    return entry;
  }

  /** Append a bot reply (a chunked reply is one entry with one id per chunk). */
  pushAssistant(content: string, ids: string[], chunks?: string[]): ContextEntry {
    const entry: ContextEntry = { role: "assistant", content, ids: [...ids], ts: Date.now(), attachments: [] };
    if (chunks) entry.chunks = [...chunks];
    this.entries.push(entry);
    return entry;
  }

  /** The entry backed by the given Discord message id, if any. */
  find(messageId: string): ContextEntry | undefined {
    return this.entries.find((e) => e.ids.includes(messageId));
  }

  has(messageId: string): boolean {
    return this.find(messageId) !== undefined;
  }

  /** Replace an entry's stored content (position in the context is kept). */
  updateContent(messageId: string, content: string): void {
    const entry = this.find(messageId);
    if (entry) entry.content = content;
  }

  /** Replace one chunk of a chunked entry and re-derive its stored content. */
  updateChunk(messageId: string, chunkContent: string): void {
    const entry = this.find(messageId);
    if (!entry?.chunks) return;
    const i = entry.ids.indexOf(messageId);
    if (i === -1) return;
    entry.chunks[i] = chunkContent;
    entry.content = entry.chunks.join("\n");
  }

  /** Drop the whole entry that contains the given Discord message id. */
  removeById(messageId: string): boolean {
    const i = this.entries.findIndex((e) => e.ids.includes(messageId));
    if (i === -1) return false;
    this.entries.splice(i, 1);
    return true;
  }

  snapshot(): ContextEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.summary = null;
    this.entries.length = 0;
    this.seeded = false;
  }

  get length(): number {
    return this.entries.length;
  }

  getSummary(): string | null {
    return this.summary;
  }

  /**
   * Take in the channel's fetched last-N messages (the startup seed):
   * already-tracked ids win (they track live edits and deletes), new
   * messages are merged in chronological order.
   */
  seedFrom(seed: SeedEntry[]): void {
    const known = new Set<string>();
    for (const e of this.entries) for (const id of e.ids) known.add(id);
    const merged: ContextEntry[] = [...this.entries];
    for (const s of seed) {
      if (known.has(s.id)) continue;
      known.add(s.id);
      const entry: ContextEntry = {
        role: s.role,
        content: s.content,
        ids: [s.id],
        ts: s.ts,
        attachments: [...s.attachments],
      };
      if (s.name !== undefined) entry.name = s.name;
      if (s.bot !== undefined) entry.bot = s.bot;
      merged.push(entry);
    }
    merged.sort((a, b) => a.ts - b.ts);
    this.entries.length = 0;
    this.entries.push(...merged);
    this.seeded = true;
  }

  /**
   * Estimated tokens of the next request built from this context: the
   * system prompt + the summary + every entry, plus a fixed cost for the
   * images that would actually be sent (the newest `imageWindow` entries).
   */
  estimateTokens(systemPrompt: string, imageWindow: number): number {
    let t = estimateTokens(systemPrompt);
    if (this.summary) t += estimateTokens(this.summary);
    const windowStart = this.entries.length - imageWindow;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      t += estimateTokens(e.content);
      if (i >= windowStart) {
        t += e.attachments.filter(isImageAttachment).length * IMAGE_TOKEN_ESTIMATE;
      }
    }
    return t;
  }

  /**
   * Compact: fold everything older than the newest `keep` entries (plus any
   * existing summary) into one new summary via `summarize`. The newest
   * entries stay verbatim; `protectedId` (the turn's mention) is never
   * folded away, no matter how old it is.
   */
  async compact(
    keep: number,
    summarize: (messages: ChatMessage[]) => Promise<string>,
    protectedId?: string,
  ): Promise<CompactionResult> {
    const n = this.entries.length;
    const protectedIdx = protectedId ? this.entries.findIndex((e) => e.ids.includes(protectedId)) : -1;
    // The keep region covers the newest `keep` entries and, if the mention
    // is older than that, everything from the mention on.
    const keepStart = protectedIdx === -1 ? n - keep : Math.min(n - keep, protectedIdx);
    if (keepStart <= 0) return { ok: false, reason: "nothing-to-fold" };
    const older = this.entries.slice(0, keepStart);
    const transcript = compactionTranscript(this.summary, older);
    if (transcript.trim().length === 0) return { ok: false, reason: "nothing-to-fold" };
    let text: string;
    try {
      text = (
        await summarize([
          { role: "system", content: COMPACTION_SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ])
      ).trim();
    } catch {
      return { ok: false, reason: "summarizer" };
    }
    if (text.length === 0) return { ok: false, reason: "summarizer" };
    this.summary = text.slice(0, COMPACTION_SUMMARY_MAX_CHARS);
    this.entries.splice(0, keepStart);
    return { ok: true };
  }

  /**
   * Last-resort shrink when a compaction could not apply: drop the oldest
   * entries (never the protected one — the turn's mention) until the
   * estimate fits the budget.
   */
  emergencyTrim(protectedId: string, maxTokens: number, systemPrompt: string, imageWindow: number): void {
    while (this.estimateTokens(systemPrompt, imageWindow) > maxTokens) {
      const i = this.entries.findIndex((e) => !e.ids.includes(protectedId));
      if (i === -1) break; // only the protected entry is left
      this.entries.splice(i, 1);
    }
  }
}

/** Lazily creates a ChannelContext per channel id. */
export class ChannelContextStore {
  private readonly byChannel = new Map<string, ChannelContext>();

  get(channelId: string): ChannelContext {
    let c = this.byChannel.get(channelId);
    if (!c) {
      c = new ChannelContext();
      this.byChannel.set(channelId, c);
    }
    return c;
  }

  has(channelId: string): boolean {
    return this.byChannel.has(channelId);
  }

  /** Forget a channel's whole context (e.g. the channel was deleted). */
  clear(channelId: string): void {
    this.byChannel.get(channelId)?.clear();
  }
}
