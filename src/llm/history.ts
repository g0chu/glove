import type { ChatMessage } from "./client.js";

export type Role = "user" | "assistant";

/**
 * One entry in a channel's context window.
 *
 * `ids` are the Discord message ids that back the entry: one id for a human
 * message, one per Discord message for a chunked bot reply. `chunks` (only
 * for chunked bot replies) holds the per-message text as posted, so an edit
 * of any chunk can rebuild the visible text. The ids are what make edits and
 * deletions reflectable: every tracked Discord message is findable by id.
 */
export interface HistoryMessage {
  role: Role;
  /** Text sent to the model (the canonical reply for bot entries). */
  content: string;
  ids: string[];
  chunks?: string[];
  /** The author's display name (user entries only): labels the fallback context. */
  name?: string;
}

/** Per-channel in-memory sliding window of the last N messages. */
export class ChannelHistory {
  private readonly messages: HistoryMessage[] = [];

  constructor(private readonly maxMessages: number) {}

  /** Append an entry backed by Discord message id(s); trims the window. */
  push(
    role: Role,
    content: string,
    ids: string[],
    chunks?: string[],
    name?: string,
  ): HistoryMessage {
    const entry: HistoryMessage = { role, content, ids: [...ids] };
    if (chunks) entry.chunks = [...chunks];
    if (name !== undefined) entry.name = name;
    this.messages.push(entry);
    while (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
    return entry;
  }

  /** The entry backed by the given Discord message id, if any. */
  find(messageId: string): HistoryMessage | undefined {
    return this.messages.find((m) => m.ids.includes(messageId));
  }

  has(messageId: string): boolean {
    return this.find(messageId) !== undefined;
  }

  /** Replace an entry's stored content (position in the window is kept). */
  updateContent(messageId: string, content: string): void {
    const entry = this.find(messageId);
    if (entry) entry.content = content;
  }

  /**
   * Replace one chunk of a chunked entry and re-derive its stored content
   * (the newline-joined chunks: what is visible in the channel).
   */
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
    const i = this.messages.findIndex((m) => m.ids.includes(messageId));
    if (i === -1) return false;
    this.messages.splice(i, 1);
    return true;
  }

  snapshot(): HistoryMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages.length = 0;
  }

  get length(): number {
    return this.messages.length;
  }
}

/** Lazily creates a ChannelHistory per channel id. */
export class ConversationStore {
  private readonly byChannel = new Map<string, ChannelHistory>();

  constructor(private readonly maxMessages: number) {}

  get(channelId: string): ChannelHistory {
    let h = this.byChannel.get(channelId);
    if (!h) {
      h = new ChannelHistory(this.maxMessages);
      this.byChannel.set(channelId, h);
    }
    return h;
  }

  has(channelId: string): boolean {
    return this.byChannel.has(channelId);
  }

  /** Forget a channel's whole history (e.g. the channel was deleted). */
  clear(channelId: string): void {
    this.byChannel.get(channelId)?.clear();
  }
}

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
 * Build the `messages` array for a request: optional system message
 * (when MODEL_SYSTEM_PROMPT is non-empty) followed by the channel history.
 * Each entry is its own message (never merged); user entries are prefixed
 * with their author's display name when one was stored, so the model can
 * tell who said what even on this fallback path. Entries with no text (e.g.
 * a bare mention, a sticker-only message) are tracked for edit/delete
 * purposes but carry nothing for the model.
 */
export function toRequestMessages(history: ChannelHistory, systemPrompt: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (systemPrompt.trim().length > 0) {
    out.push({ role: "system", content: systemPrompt });
  }
  for (const m of history.snapshot()) {
    if (m.content.length === 0) continue;
    // Window user entries are always human (bots are never tracked), so the
    // label needs no "(bot)" marker.
    const content =
      m.role === "user" && m.name ? `${speakerLabel(m.name, false)}: ${m.content}` : m.content;
    out.push({ role: m.role, content });
  }
  return out;
}
