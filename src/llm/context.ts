import type { ChatMessage, MessageAttachmentLike } from "./client.js";
import { isImageAttachment } from "./client.js";

/** The role of one context entry (the request `messages` array uses it). */
export type Role = "user" | "assistant";

/**
 * The speaker label the model sees on a non-bot message: the author's
 * display name, with a "(bot)" marker for other bots (mirroring Discord's
 * badge). The bot's own replies carry no label — the assistant role already
 * says who.
 */
export function speakerLabel(name: string, isBot: boolean): string {
  return isBot ? `${name} (bot)` : name;
}

/**
 * The persistent per-channel conversation context.
 *
 * The context grows: the channel's last N messages are seeded in when the
 * bot first talks in the channel after a start (so the context is exactly
 * what is in the channel, every author included), every new trackable
 * message and bot reply is appended, and nothing is dropped until the
 * context fills up. When the estimated request size passes the configured
 * token budget, the older part is folded into a model-written summary
 * (compaction); the newest messages stay verbatim. Everything is in-memory:
 * after a restart the context re-seeds from the channel again.
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
 * Max gap between two consecutive bot messages for them to be the chunks of
 * one chunked reply. Chunks of one reply land within the same posting burst
 * (a few seconds at most, even under rate limits), while separate replies
 * are a full turn (seconds to minutes) apart — so a 5 s gap never merges two
 * distinct replies. Used by the startup seed to group a reply's chunks back
 * into one entry (one entry, one id per chunk).
 */
export const BOT_REPLY_GROUP_GAP_MS = 5000;

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
 * a plain transcript for the summarizer. Attachment names are listed so the
 * summary can note that files were shared, even when their content was not
 * (or could not be) inlined.
 */
export function compactionTranscript(summary: string | null, older: ContextEntry[]): string {
  const lines: string[] = [];
  if (summary && summary.trim().length > 0) {
    lines.push(`Running summary of the older messages:\n${summary.trim()}`);
    lines.push("");
  }
  for (const e of older) {
    const atts = e.attachments.map((a) => a.name);
    const attNote = atts.length > 0 ? ` [attachment: ${atts.join(", ")}]` : "";
    if (e.content.length === 0 && atts.length === 0) continue; // carries nothing
    const who = e.role === "assistant" ? "Bot" : e.name ? speakerLabel(e.name, e.bot ?? false) : "Someone";
    const content = e.content.length > 0 ? `${e.content}${attNote}` : attNote.trimStart();
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
  /**
   * The model endpoint's own count of the last turn's largest request
   * (prompt tokens, from the usage/timings the endpoint reports) — the
   * measured context size the compaction trigger prefers over the char
   * estimate. Null when never measured (or after a reset).
   */
  private measuredTokens: number | null = null;

  /** Append an arrival (a human's or another bot's message; `bot` labels it "(bot)" in the context). */
  pushUser(
    name: string,
    content: string,
    id: string,
    ts: number,
    attachments: MessageAttachmentLike[],
    bot = false,
  ): ContextEntry {
    const entry: ContextEntry = { role: "user", content, ids: [id], name, ts, attachments: [...attachments] };
    if (bot) entry.bot = true;
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
    this.measuredTokens = null;
  }

  /**
   * Reset for a fresh start (the `!clear` command): drop every entry and
   * the running summary, and mark the startup seed as taken so the next
   * turn does not re-seed the channel's last-N messages. Messages that
   * arrive after the clear fill the context from scratch.
   */
  reset(): void {
    this.summary = null;
    this.entries.length = 0;
    this.seeded = true;
    this.measuredTokens = null;
  }

  /** The endpoint-reported token size of the last turn's largest request, or null (unmeasured). */
  getMeasuredTokens(): number | null {
    return this.measuredTokens;
  }

  /** Record (or, with null, forget) the endpoint-reported token size of a turn's largest request. */
  setMeasuredTokens(tokens: number | null): void {
    this.measuredTokens = tokens;
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
   * messages are merged in chronological order (timestamp, then message id
   * — see compareDiscordIds: same-millisecond messages must not keep the
   * API's newest-first order).
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
    merged.sort((a, b) => a.ts - b.ts || compareDiscordIds(a.ids[0], b.ids[0]));
    this.entries.length = 0;
    this.entries.push(...groupConsecutiveReplies(merged));
    this.seeded = true;
  }

  /**
   * Estimated tokens of the next request built from this context: the
   * system prompt + the summary + every entry, plus a fixed cost for the
   * images that would actually be sent (the newest `window` entries) and,
   * when `fileMaxBytes` is given (file contents enabled), a cost for the
   * non-image attachments that would be inlined (their size, capped at
   * `fileMaxBytes`, same ~4-chars-per-token heuristic). When the endpoint
   * reported a measured size (getMeasuredTokens), the compaction trigger
   * prefers that over this estimate.
   */
  estimateTokens(systemPrompt: string, window: number, fileMaxBytes?: number): number {
    let t = estimateTokens(systemPrompt);
    if (this.summary) t += estimateTokens(this.summary);
    const windowStart = this.entries.length - window;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      t += estimateTokens(e.content);
      if (i >= windowStart) {
        t += e.attachments.filter(isImageAttachment).length * IMAGE_TOKEN_ESTIMATE;
        if (fileMaxBytes !== undefined) {
          for (const a of e.attachments) {
            if (!isImageAttachment(a)) t += Math.ceil(Math.min(a.size, fileMaxBytes) / 4);
          }
        }
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
  emergencyTrim(
    protectedId: string,
    maxTokens: number,
    systemPrompt: string,
    window: number,
    fileMaxBytes?: number,
  ): void {
    while (this.estimateTokens(systemPrompt, window, fileMaxBytes) > maxTokens) {
      const i = this.entries.findIndex((e) => !e.ids.includes(protectedId));
      if (i === -1) break; // only the protected entry is left
      this.entries.splice(i, 1);
    }
  }

  /**
   * Last-resort shrink when a request overfilled the model's context and the
   * endpoint rejected it: drop the oldest entries (never the protected one —
   * the turn's mention) until the estimate fits `targetTokens`, and, if the
   * remaining entries still do not fit, drop the running summary too (it is
   * derived data — the only thing left besides the mention). After this, the
   * next request fits the window again (unless the mention alone does not).
   */
  emergencyShrink(
    protectedId: string,
    targetTokens: number,
    systemPrompt: string,
    window: number,
    fileMaxBytes?: number,
  ): void {
    this.emergencyTrim(protectedId, targetTokens, systemPrompt, window, fileMaxBytes);
    if (this.estimateTokens(systemPrompt, window, fileMaxBytes) > targetTokens && this.summary !== null) {
      this.summary = null;
    }
  }
}

/**
 * Whether a model request failed because the prompt did not fit the model's
 * context. llama.cpp (llama-server) rejects it before generating — HTTP 400
 * with the error text "request (N tokens) exceeds the available context
 * size (M tokens)" (JSON body in both stream and non-stream mode), surfaced
 * by the LLM client as the status line + body. The other patterns cover
 * common phrasings of the same condition on other endpoints.
 */
export function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /exceed_context_size/i.test(msg) ||
    /exceeds the available context size/i.test(msg) ||
    /context window overflow/i.test(msg) ||
    /maximum context length|context length exceeded/i.test(msg)
  );
}

/**
 * The model's context window (tokens) when the overflow error reports it —
 * llama.cpp's message carries it ("… available context size (160000
 * tokens) …"); null when the error is not shaped that way.
 */
export function contextWindowFromOverflowError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /context size \((\d+) tokens\)/.exec(msg);
  return m !== null ? Number(m[1]) : null;
}

/**
 * Group consecutive bot entries posted close together (a chunked reply's
 * chunks, seen as separate Discord messages after a restart) back into one
 * entry: the content joined with newlines (the same convention as
 * `updateChunk`), all chunk ids, and the per-chunk text so edit/delete
 * bookkeeping matches a live chunked reply (any chunk id resolves the
 * entry; a chunk edit re-derives the content; a chunk delete drops the
 * whole entry). The chunk list stays aligned with the id list (one chunk
 * text per id — a multi-chunk entry contributes its whole chunk list, not
 * just its joined content), so `updateChunk`'s id-to-index lookup always
 * resolves the right slot. Non-adjacent or far-apart entries are kept
 * as-is.
 */
function groupConsecutiveReplies(entries: ContextEntry[]): ContextEntry[] {
  const out: ContextEntry[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (
      e.role === "assistant" &&
      prev !== undefined &&
      prev.role === "assistant" &&
      e.ts - prev.ts <= BOT_REPLY_GROUP_GAP_MS
    ) {
      const prevContent = prev.content;
      prev.content = `${prevContent}\n${e.content}`;
      prev.ids = [...prev.ids, ...e.ids];
      prev.chunks = [...(prev.chunks ?? [prevContent]), ...(e.chunks ?? [e.content])];
      prev.attachments = [...prev.attachments, ...e.attachments];
    } else {
      out.push(e);
    }
  }
  return out;
}

/**
 * Compare two Discord message ids in creation order. Snowflake ids are
 * timestamp + sequence, so their numeric order is the exact message order —
 * the tie-break every chronological sort needs, because
 * `createdTimestamp` is only millisecond-precise (Discord's API returns
 * newest-first, so a timestamp-only sort leaves same-millisecond bursts in
 * reverse order). Non-numeric ids (tests) compare as equal: the stable
 * sort keeps their input order.
 */
export function compareDiscordIds(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? BigInt(a) : null;
  const nb = /^\d+$/.test(b) ? BigInt(b) : null;
  if (na === null || nb === null) return 0;
  return na < nb ? -1 : na > nb ? 1 : 0;
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
