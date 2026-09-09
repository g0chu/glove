import type { ChatMessage, MessageAttachmentLike, ToolCall } from "./client.js";
import { isImageAttachment } from "./client.js";

/** The role of one context entry (the request `messages` array uses it). */
export type Role = "user" | "assistant" | "tool";

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
 * bot first talks in the channel after a start (only for channels without
 * a persisted context — see ChatPersistence, which makes the full history
 * the source of truth across restarts), every new trackable message is
 * appended, and a completed turn appends its whole conversation (every
 * round's text, reasoning, tool calls and results, plus the final reply).
 * Nothing is dropped until the context fills up. When the estimated request
 * size passes the configured token budget, the older part is folded into a
 * model-written summary (compaction); the newest messages stay verbatim.
 */

/**
 * One entry in the persistent channel context: exactly one Discord message, one
 * bot reply, or one tool result (the whole turn conversation is preserved —
 * the model's text, its reasoning, its tool calls, and the results — so the
 * request always carries the full, unbroken history the model saw).
 */
export interface ContextEntry {
  /** Durable turn identity, used to make crash recovery idempotent. */
  turnId?: string;
  role: Role;
  /** The text as the model sees it (mentions of the bot already replaced by its Discord name). */
  content: string;
  /** The Discord message id(s) backing the entry (one per chunk for a chunked reply; [] when there is no Discord message). */
  ids: string[];
  /** Per-chunk text as posted (chunked bot replies only). */
  chunks?: string[];
  /** The author's display name (user entries) or the tool name (tool entries). */
  name?: string;
  /** True when the author is another bot (labeled "(bot)" in the context). */
  bot?: boolean;
  /** Attachment metadata; images are downloaded at turn time, within the image window. */
  attachments: MessageAttachmentLike[];
  /** The Discord createdTimestamp (keeps the startup seed chronological). */
  ts: number;
  /** The model's reasoning/thinking for an assistant entry, when the endpoint sent it. */
  reasoning?: string;
  /** The tool calls an assistant entry requested (the following tool entries answer them). */
  toolCalls?: ToolCall[];
  /** tool entries: the id of the call this result answers. */
  toolCallId?: string;
}

/**
 * The JSON form of a channel context (what the persistence file stores):
 * the entries (the full turn conversation — text, reasoning, tool calls,
 * results), the summary, the seeded flag, the measured size. A restart
 * resumes the conversation from it exactly where it left off.
 */
export interface SerializedChannelContext {
  seeded: boolean;
  summary: string | null;
  measuredTokens: number | null;
  /** The time of the latest !clear (or null): the restart catch-up fetch never re-imports messages older than it (a clear is a fresh chat, and a restart must not resurrect what was cleared). */
  clearedAt: number | null;
  entries: ContextEntry[];
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
    if (e.role === "tool") {
      // The summarizer sees the tool activity (the result text is what the
      // model learned from the call), so the summary can carry it forward.
      lines.push(`Tool ${e.name ?? "?"} (${e.toolCallId ?? "?"}): ${e.content}`.trimEnd());
      continue;
    }
    const atts = e.attachments.map((a) => a.name);
    const attNote = atts.length > 0 ? ` [attachment: ${atts.join(", ")}]` : "";
    const callsNote = e.toolCalls && e.toolCalls.length > 0 ? ` [tool calls: ${e.toolCalls.map((c) => c.name).join(", ")}]` : "";
    if (e.content.length === 0 && atts.length === 0 && e.toolCalls === undefined) continue; // carries nothing
    const who = e.role === "assistant" ? "Bot" : e.name ? speakerLabel(e.name, e.bot ?? false) : "Someone";
    const content = e.content.length > 0 ? `${e.content}${attNote}${callsNote}` : `${attNote}${callsNote}`.trimStart();
    lines.push(`${who}: ${content}`.trimEnd());
  }
  return lines.join("\n");
}

/** The outcome of a compaction attempt (an empty fold and a failed summarizer are distinct). */
export type CompactionResult = { ok: true } | { ok: false; reason: "nothing-to-fold" | "summarizer" | "changed" };

/**
 * One channel's persistent context: an optional summary of the compacted
 * older messages, followed by the raw recent entries (never sliding).
 */
export class ChannelContext {
  private summary: string | null = null;
  private revision = 0;
  private batching = false;
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
  /**
   * The time of the latest !clear, or null (never cleared): the restart
   * catch-up seed never re-imports messages older than it (a clear is a
   * fresh chat — a restart must not resurrect what was cleared).
   */
  private clearedAt: number | null = null;
  /**
   * Fired after every mutation (the persistence layer uses it to save the
   * context; the store wires it up).
   */
  onChange?: () => void;

  private changed(): void {
    this.revision++;
    if (!this.batching) this.onChange?.();
  }

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
    this.changed();
    return entry;
  }

  /**
   * Append a bot reply (a chunked reply is one entry with one id per chunk).
   * `extra.reasoning`/`extra.toolCalls` preserve the model's thinking and the
   * calls it requested (tool entries answering the calls follow — see
   * appendTurn).
   */
  pushAssistant(
    content: string,
    ids: string[],
    chunks?: string[],
    extra?: { reasoning?: string; toolCalls?: ToolCall[] },
  ): ContextEntry {
    const entry: ContextEntry = { role: "assistant", content, ids: [...ids], ts: Date.now(), attachments: [] };
    if (chunks) entry.chunks = [...chunks];
    if (extra?.reasoning) entry.reasoning = extra.reasoning;
    if (extra?.toolCalls) entry.toolCalls = [...extra.toolCalls];
    this.entries.push(entry);
    this.changed();
    return entry;
  }

  /** Append one tool result (it answers a call of the preceding assistant entry). */
  pushTool(name: string, toolCallId: string, content: string): ContextEntry {
    const entry: ContextEntry = { role: "tool", content, ids: [], ts: Date.now(), attachments: [], name, toolCallId };
    this.entries.push(entry);
    this.changed();
    return entry;
  }

  /**
   * Record a completed turn's whole conversation: each executed round (the
   * model's text + reasoning + the tool calls it requested, then the results
   * in order) followed by the final reply (the canonical posted text, with
   * the chunk ids so edits and deletes of the posted messages stay in sync).
   * A round's `ids` are the Discord message ids its text settled to (the
   * channel's visible narration); an empty list means the text has no
   * backing message (nothing was posted for it).
   */
  appendTurn(
    rounds: Array<{
      content: string;
      reasoning?: string;
      calls: ToolCall[];
      results: Array<{ toolCallId: string; name: string; content: string }>;
      ids: string[];
      chunks?: string[];
    }>,
    final: { content: string; reasoning?: string; ids: string[]; chunks?: string[] },
    turnId?: string,
  ): void {
    const start = this.entries.length;
    this.batching = true;
    try {
      for (const r of rounds) {
        this.pushAssistant(r.content, r.ids, r.chunks, { reasoning: r.reasoning, toolCalls: r.calls });
        for (const t of r.results) this.pushTool(t.name, t.toolCallId, t.content);
      }
      this.pushAssistant(final.content, final.ids, final.chunks, { reasoning: final.reasoning });
      if (turnId) for (let i = start; i < this.entries.length; i++) this.entries[i].turnId = turnId;
    } finally {
      this.batching = false;
      this.onChange?.();
    }
  }

  /** The entry backed by the given Discord message id, if any. */
  find(messageId: string): ContextEntry | undefined {
    return this.entries.find((e) => e.ids.includes(messageId));
  }

  has(messageId: string): boolean {
    return this.find(messageId) !== undefined;
  }

  /**
   * The id of the newest user entry (a trackable message) that sits in the
   * context after the entry carrying `messageId` — i.e., a message that
   * committed after it (entries sit in commit order, which is the arrival
   * order of live messages). The chime uses it to cancel a decision a newer
   * message has superseded: the newer message's own turn (queued behind
   * this one) decides over the still conversation, so a burst of messages
   * settles into one decision. Assistant and tool entries do not count —
   * they are the bot's own words, not new activity. Null when the trigger
   * is no longer in the context or nothing newer follows it.
   */
  newestUserEntryAfter(messageId: string): string | null {
    const idx = this.entries.findIndex((e) => e.ids.includes(messageId));
    if (idx === -1) return null;
    let id: string | null = null;
    for (let i = idx + 1; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.role === "user" && e.ids.length > 0) id = e.ids[0];
    }
    return id;
  }

  /** Replace an entry's stored content (position in the context is kept). */
  updateContent(messageId: string, content: string): void {
    const entry = this.find(messageId);
    if (entry) {
      entry.content = content;
      this.changed();
    }
  }

  /**
   * Replace an entry's stored attachment metadata (an edit swapped the
   * message's attachments; the image/file pipelines download from the stored
   * metadata at turn time, so it must follow the edit).
   */
  updateAttachments(messageId: string, attachments: MessageAttachmentLike[]): void {
    const entry = this.find(messageId);
    if (entry) {
      entry.attachments = [...attachments];
      this.changed();
    }
  }

  /** Replace one chunk of a chunked entry and re-derive its stored content. */
  updateChunk(messageId: string, chunkContent: string): void {
    const entry = this.find(messageId);
    if (!entry?.chunks) return;
    const i = entry.ids.indexOf(messageId);
    if (i === -1) return;
    entry.chunks[i] = chunkContent;
    entry.content = entry.chunks.join("\n");
    this.changed();
  }

  /**
   * Drop the whole entry that contains the given Discord message id. When
   * the entry carries tool calls, its tool results are dropped with it — a
   * history with unanswered calls (or orphaned results) would be an invalid
   * conversation for the endpoint.
   */
  removeById(messageId: string): boolean {
    const i = this.entries.findIndex((e) => e.ids.includes(messageId));
    if (i === -1) return false;
    this.entries.splice(i, this.entryGroupSize(i));
    this.changed();
    return true;
  }

  /**
   * The number of consecutive entries starting at `i` that form one
   * tool-call group (an assistant entry with calls plus the tool results
   * answering them) — drops and compactions must never split it, or the
   * history would carry unanswered calls or orphaned results.
   */
  private entryGroupSize(i: number): number {
    let size = 1;
    while (i + size < this.entries.length && this.entries[i + size].role === "tool") size++;
    return size;
  }

  snapshot(): ContextEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.summary = null;
    this.entries.length = 0;
    this.seeded = false;
    this.measuredTokens = null;
    this.changed();
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
    this.clearedAt = Date.now();
    this.changed();
  }

  /** The time of the latest !clear, or null (never cleared). */
  getClearedAt(): number | null {
    return this.clearedAt;
  }

  /** The endpoint-reported token size of the last turn's largest request, or null (unmeasured). */
  getMeasuredTokens(): number | null {
    return this.measuredTokens;
  }

  /** Record (or, with null, forget) the endpoint-reported token size of a turn's largest request. */
  setMeasuredTokens(tokens: number | null): void {
    if (this.measuredTokens === tokens) return;
    this.measuredTokens = tokens;
    this.changed();
  }

  get length(): number {
    return this.entries.length;
  }

  getSummary(): string | null {
    return this.summary;
  }

  /**
   * The whole context as plain JSON (entries included — the model's text,
   * reasoning, tool calls and results, the summary, the seeded flag, the
   * measured size): what the persistence file stores, so a restart resumes
   * the conversation exactly where it left off.
   */
  serialize(): SerializedChannelContext {
    return {
      seeded: this.seeded,
      summary: this.summary,
      measuredTokens: this.measuredTokens,
      clearedAt: this.clearedAt,
      entries: this.entries.map((e) => ({ ...e, ids: [...e.ids], chunks: e.chunks ? [...e.chunks] : undefined, attachments: [...e.attachments], toolCalls: e.toolCalls ? [...e.toolCalls] : undefined })),
    };
  }

  /**
   * Build a context from serialized data (the persistence file). Malformed
   * entries are skipped rather than failing the whole channel's restore.
   */
  static restore(data: SerializedChannelContext): ChannelContext {
    const ctx = new ChannelContext();
    ctx.seeded = data.seeded === true;
    ctx.summary = typeof data.summary === "string" && data.summary.length > 0 ? data.summary : null;
    ctx.measuredTokens = typeof data.measuredTokens === "number" && data.measuredTokens > 0 ? data.measuredTokens : null;
    ctx.clearedAt = typeof data.clearedAt === "number" && data.clearedAt > 0 ? data.clearedAt : null;
    if (Array.isArray(data.entries)) {
      for (const e of data.entries) {
        const entry = sanitizeEntry(e);
        if (entry !== null) ctx.entries.push(entry);
      }
    }
    return ctx;
  }

  /**
   * Take in the channel's fetched last-N messages (the startup seed):
   * already-tracked ids win (they track live edits and deletes), new
   * messages are merged in chronological order (timestamp, then message id
   * — see compareDiscordIds: same-millisecond messages must not keep the
   * API's newest-first order).
   */
  seedFrom(seed: SeedEntry[], afterTs?: number): void {
    const known = new Set<string>();
    for (const e of this.entries) for (const id of e.ids) known.add(id);
    const merged: ContextEntry[] = [...this.entries];
    for (const s of seed) {
      if (known.has(s.id)) continue;
      if (afterTs !== undefined && s.ts <= afterTs) continue; // the clear's watermark: a fresh chat starts after it
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
    // Sort complete call/result groups, never individual tool results: a
    // fetched Discord message may have a timestamp between a call and result.
    const groups: ContextEntry[][] = [];
    for (const entry of merged) {
      if (entry.role === "tool" && groups.length > 0) groups[groups.length - 1].push(entry);
      else groups.push([entry]);
    }
    groups.sort(([a], [b]) => a.ts - b.ts || compareDiscordIds(a.ids[0], b.ids[0]));
    this.entries.length = 0;
    this.entries.push(...groupConsecutiveReplies(groups.flat()));
    this.seeded = true;
    this.changed();
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
      // The reasoning and the tool calls travel with the request, so they
      // count toward its size.
      const calls = e.toolCalls !== undefined ? JSON.stringify(e.toolCalls).length : 0;
      t += Math.ceil((e.content.length + (e.reasoning?.length ?? 0) + calls) / 4);
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
    systemPrompt?: string,
  ): Promise<CompactionResult> {
    const n = this.entries.length;
    const protectedIdx = protectedId ? this.entries.findIndex((e) => e.ids.includes(protectedId)) : -1;
    // The keep region covers the newest `keep` entries and, if the mention
    // is older than that, everything from the mention on.
    const keepStart0 = protectedIdx === -1 ? n - keep : Math.min(n - keep, protectedIdx);
    if (keepStart0 <= 0) return { ok: false, reason: "nothing-to-fold" };
    // Never split a tool-call group at the fold boundary: when the first
    // kept entry is a tool result, its assistant (with the calls) sits in
    // the folded part — fold the whole group into the summary instead of
    // leaving orphaned results behind.
    let keepStart = keepStart0;
    while (keepStart < n && this.entries[keepStart].role === "tool") keepStart++;
    if (keepStart >= n) {
      // Everything would fold into the summary — only do that when the
      // protected mention is not among the kept entries we just gave up on
      // (it can only sit inside a tool group if it is one, and mentions are
      // user messages, so this is defensive).
      return { ok: false, reason: "nothing-to-fold" };
    }
    const older = this.entries.slice(0, keepStart);
    const transcript = compactionTranscript(this.summary, older);
    if (transcript.trim().length === 0) return { ok: false, reason: "nothing-to-fold" };
    const revision = this.revision;
    let text: string;
    try {
      text = (
        await summarize([
          { role: "system", content: systemPrompt?.trim() || COMPACTION_SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ])
      ).trim();
    } catch {
      return { ok: false, reason: this.revision === revision ? "summarizer" : "changed" };
    }
    // Never apply a snapshot over a clear, edit, deletion, or newer arrival.
    if (this.revision !== revision) return { ok: false, reason: "changed" };
    if (text.length === 0) return { ok: false, reason: "summarizer" };
    this.summary = text.slice(0, COMPACTION_SUMMARY_MAX_CHARS);
    this.entries.splice(0, keepStart);
    this.changed();
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
      // Drop a tool-call group whole (never the calls without their results
      // — that would leave the history invalid for the endpoint).
      this.entries.splice(i, this.entryGroupSize(i));
    }
    this.changed();
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
      this.changed();
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
      e.turnId === undefined && prev.turnId === undefined &&
      e.reasoning === undefined && prev.reasoning === undefined &&
      e.toolCalls === undefined && prev.toolCalls === undefined &&
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

/**
 * Validate one persisted entry (the file is our own, but a truncated or
 * hand-edited file must not take the channel's restore down — a malformed
 * entry is skipped).
 */
function sanitizeEntry(raw: unknown): ContextEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.role !== "user" && e.role !== "assistant" && e.role !== "tool") return null;
  if (typeof e.content !== "string") return null;
  if (!Array.isArray(e.ids) || e.ids.some((id) => typeof id !== "string")) return null;
  const entry: ContextEntry = {
    role: e.role,
    content: e.content,
    ids: e.ids as string[],
    ts: typeof e.ts === "number" ? e.ts : Date.now(),
    attachments: Array.isArray(e.attachments)
      ? (e.attachments as MessageAttachmentLike[]).filter((a) => a !== null && typeof a === "object" && typeof a.url === "string")
      : [],
  };
  if (Array.isArray(e.chunks) && e.chunks.every((c) => typeof c === "string")) entry.chunks = e.chunks as string[];
  if (typeof e.name === "string") entry.name = e.name;
  if (typeof e.turnId === "string") entry.turnId = e.turnId;
  if (e.bot === true) entry.bot = true;
  if (typeof e.reasoning === "string" && e.reasoning.length > 0) entry.reasoning = e.reasoning;
  if (Array.isArray(e.toolCalls)) {
    const calls = (e.toolCalls as Array<Record<string, unknown>>)
      .map((c) => ({ id: String(c?.id ?? ""), name: String(c?.name ?? ""), arguments: String(c?.arguments ?? "") }))
      .filter((c) => c.id.length > 0 && c.name.length > 0);
    if (calls.length > 0) entry.toolCalls = calls;
  }
  if (typeof e.toolCallId === "string") entry.toolCallId = e.toolCallId;
  return entry;
}

/** Lazily creates a ChannelContext per channel id. */
export class ChannelContextStore {
  private readonly byChannel = new Map<string, ChannelContext>();

  constructor(private readonly onChange?: (channelId: string, context: ChannelContext) => void) {}

  get(channelId: string): ChannelContext {
    const existing = this.byChannel.get(channelId);
    if (existing) return existing;
    const c = new ChannelContext();
    c.onChange = () => this.onChange?.(channelId, c);
    this.byChannel.set(channelId, c);
    return c;
  }

  has(channelId: string): boolean {
    return this.byChannel.has(channelId);
  }

  /**
   * Restore a channel's context from its persisted data (startup). A
   * context with a conversation gets one catch-up seed at its first turn
   * after the start (the channel may have been talked in while the bot was
   * offline — the fetch merges in what arrived, the already-tracked ids
   * win, and the clear's watermark keeps a restart from resurrecting what
   * was cleared). An empty context (a !clear) stays empty: re-fetching the
   * channel's last-N would undo the clear.
   */
  restore(channelId: string, data: SerializedChannelContext): void {
    const ctx = ChannelContext.restore(data);
    ctx.seeded = ctx.length === 0;
    ctx.onChange = () => this.onChange?.(channelId, ctx);
    this.byChannel.set(channelId, ctx);
  }

  /** Forget a channel's whole context (e.g. the channel was deleted). */
  clear(channelId: string): void {
    const context = this.byChannel.get(channelId);
    if (!context) return;
    // In-flight turns may still hold this object. Detach its persistence
    // hook so their late metrics/results cannot recreate a deleted channel.
    context.onChange = undefined;
    context.clear();
    this.byChannel.delete(channelId);
  }
}
