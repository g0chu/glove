import type { GuildTextBasedChannel, Message } from "discord.js";
import { errMsg, log, truncate } from "../log.js";

/** Discord hard message limit. */
export const DISCORD_MAX_MESSAGE_CHARS = 2000;

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Split text into Discord-safe chunks (<= maxChars each).
 *
 *  - prefers to break on newline boundaries;
 *  - never splits *inside* a code fence: when a chunk boundary falls inside
 *    a fenced block, the fence is closed at the end of the current chunk and
 *    reopened at the start of the next (the opening token keeps its info
 *    string for highlighting; the closing token is bare, which both Common-
 *    Mark and Discord accept);
 *  - a single line longer than maxChars is hard-split.
 */
export function splitForDiscord(text: string, maxChars: number = DISCORD_MAX_MESSAGE_CHARS): string[] {
  if (text.length <= maxChars) {
    return text.length > 0 ? [text] : [];
  }

  const chunks: string[] = [];
  let cur = "";
  let fenceReopen: string | null = null; // opening token of the open fence, e.g. "```ts"
  let fenceClose: string | null = null; // bare closing token, e.g. "```"

  const emit = (): void => {
    let part = cur;
    if (fenceReopen && fenceClose) {
      part = cur.length > 0 ? `${cur}\n${fenceClose}` : fenceClose;
    }
    chunks.push(part);
    cur = "";
  };

  const hardSplit = (line: string, budget: number): void => {
    if (cur.length > 0 || fenceReopen !== null) emit();
    for (let i = 0; i < line.length; i += budget) {
      chunks.push(line.slice(i, i + budget));
    }
    cur = "";
    fenceReopen = null; // fence state cannot be preserved across raw splits
    fenceClose = null;
  };

  for (const line of text.split("\n")) {
    const fenceMatch = FENCE_RE.exec(line);

    if (line.length > maxChars) {
      hardSplit(line, maxChars);
    } else {
      const candidate = cur.length > 0 ? cur + "\n" + line : line;
      if (candidate.length <= maxChars) {
        cur = candidate;
      } else if (fenceReopen !== null && fenceClose !== null) {
        // Must break inside a code fence: close this chunk, reopen in the next.
        const reopened = `${fenceReopen}\n${line}`;
        if (reopened.length <= maxChars) {
          emit();
          cur = reopened;
        } else {
          // Pathological: the line alone is too long to share a chunk with
          // the fence token. Emit raw pieces and abandon fence tracking.
          hardSplit(line, maxChars);
        }
      } else {
        emit();
        cur = line;
      }
    }

    if (fenceMatch) {
      if (fenceReopen === null) {
        fenceReopen = fenceMatch[1] + (fenceMatch[2] ?? "").trim();
        fenceClose = fenceMatch[1];
      } else {
        fenceReopen = null;
        fenceClose = null;
      }
    }
  }

  if (cur.length > 0 || fenceReopen !== null) emit();
  return chunks;
}

export interface WriterOptions {
  /** Guild text/announcement channel (the only kinds we ever post to). */
  channel: GuildTextBasedChannel;
  typingIntervalMs: number;
  throttleMs: number;
}

/** What the writer actually posted to the channel (for history tracking). */
export interface PostedReply {
  /** Discord message ids in send order (one per chunk). */
  messageIds: string[];
  /** Text to record in the history: the canonical reply when every chunk posted. */
  text: string;
  /** Per-message text as posted, when the reply spanned multiple messages. */
  chunks?: string[];
}

/**
 * Posts a model reply to a channel with Discord-specific concerns:
 *  - typing indicator refreshed every `typingIntervalMs`;
 *  - on the first streamed chunk, a placeholder message is created;
 *  - while streaming, the live message is edited no more often than
 *    `throttleMs` (edits are serialized; when the text exceeds 2000 chars
 *    the live preview shows the most recent tail);
 *  - on completion the final text is chunked (code-fence aware) and posted
 *    as one message per chunk;
 *  - `finish()`/`reportError()` return the ids and text of whatever was
 *    actually posted, so the caller can record the reply in the channel
 *    history (making it editable/deletable like any other message).
 */
export class ResponseWriter {
  private buffer = "";
  private message: Message | null = null;
  private typingTimer: NodeJS.Timeout | null = null;
  private lastEditAt = 0;
  private finished = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: WriterOptions) {}

  /** Start the typing indicator (call once, before the first chunk). */
  start(): void {
    void this.opts.channel.sendTyping().catch(() => {});
    this.typingTimer = setInterval(() => {
      void this.opts.channel.sendTyping().catch(() => {});
    }, this.opts.typingIntervalMs);
    this.typingTimer.unref?.();
  }

  /** Feed a streamed delta (may be called back-to-back; updates are serialized). */
  chunk(delta: string): void {
    if (this.finished) return;
    this.buffer += delta;
    this.chain = this.chain.then(() => this.updateLive()).catch(() => {});
  }

  /**
   * Finalize: stop typing, post the complete text (or a note when empty).
   * `fullText` is the model's full answer; falls back to whatever was
   * streamed so far. Returns what actually landed in the channel (message
   * ids + text) so the caller can record it in the history, or null when
   * nothing could be posted.
   */
  async finish(fullText: string): Promise<PostedReply | null> {
    if (this.finished) return null;
    this.finished = true;
    this.stopTyping();
    await this.chain.catch(() => {});

    const text = fullText.trim() || this.buffer.trim();
    const posted: Message[] = [];
    try {
      if (!text) {
        const note = "*(the model returned no response)*";
        posted.push(
          this.message ? await this.message.edit({ content: note }) : await this.opts.channel.send(note),
        );
        return { messageIds: [posted[0].id], text: note };
      }
      const chunks = splitForDiscord(text);
      if (this.message) {
        posted.push(await this.message.edit({ content: chunks[0] }));
        for (const c of chunks.slice(1)) {
          posted.push(await this.opts.channel.send(c));
        }
      } else {
        for (const c of chunks) {
          posted.push(await this.opts.channel.send(c));
        }
      }
      return this.reported(posted, text);
    } catch (err) {
      log.error(`failed to finalize reply: ${errMsg(err)}`);
      // Partial post: keep an honest record of whatever did land in the channel.
      return this.reported(posted);
    }
  }

  /**
   * Report a generation failure: keep any partial text, append a short
   * honest error note, stop typing. Returns what was posted (see finish).
   */
  async reportError(err: unknown): Promise<PostedReply | null> {
    if (this.finished) return null;
    this.finished = true;
    this.stopTyping();
    await this.chain.catch(() => {});

    const note = `⚠️ *generation failed:* ${truncate(errMsg(err), 400)}`;
    const partial = this.buffer.trim();
    const text = partial ? `${partial}\n\n${note}` : note;
    const posted: Message[] = [];
    try {
      const chunks = splitForDiscord(text);
      if (this.message) {
        posted.push(await this.message.edit({ content: chunks[0] }));
        for (const c of chunks.slice(1)) {
          posted.push(await this.opts.channel.send(c));
        }
      } else {
        for (const c of chunks) {
          posted.push(await this.opts.channel.send(c));
        }
      }
      return this.reported(posted, text);
    } catch (err2) {
      log.error(`failed to post error message: ${errMsg(err2)}`);
      return this.reported(posted);
    }
  }

  /**
   * Describe what was posted. `canonicalText` (the model's full answer) is
   * kept when every chunk landed; otherwise the visible text of whatever
   * was posted is reported. null when nothing was posted.
   */
  private reported(posted: Message[], canonicalText?: string): PostedReply | null {
    if (posted.length === 0) return null;
    return {
      messageIds: posted.map((m) => m.id),
      text: canonicalText ?? posted.map((m) => m.content).join("\n"),
      chunks: posted.length > 1 ? posted.map((m) => m.content) : undefined,
    };
  }

  private async updateLive(): Promise<void> {
    if (this.finished) return;
    try {
      if (!this.message) {
        this.message = await this.opts.channel.send(this.livePreview());
      } else {
        const now = Date.now();
        if (now - this.lastEditAt >= this.opts.throttleMs) {
          this.lastEditAt = now;
          await this.message.edit({ content: this.livePreview() });
        }
      }
    } catch (err) {
      log.warn(`live message update failed: ${errMsg(err)}`);
      // keep going; finish()/reportError() make the final attempt
    }
  }

  /** Live preview capped at 2000 chars: the head while it fits, the tail once it doesn't. */
  private livePreview(): string {
    const max = DISCORD_MAX_MESSAGE_CHARS;
    if (this.buffer.length <= max) {
      return this.buffer.trim().length > 0 ? this.buffer : "…";
    }
    return "…" + this.buffer.slice(this.buffer.length - (max - 3));
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }
}
