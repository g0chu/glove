import type { GuildTextBasedChannel, Message } from "discord.js";
import { errMsg, log, truncate } from "../log.js";
import { sanitizeForDiscord } from "./format.js";

/** Discord hard message limit. */
export const DISCORD_MAX_MESSAGE_CHARS = 2000;

/** How many trailing thinking lines the long-form reasoning preview keeps. */
const REASONING_TAIL_LINES = 5;

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const TABLE_ROW_RE = /^\s*\|/;
/** GFM separator row: | --- | :---: | ... (Discord tables need one). */
const TABLE_SEP_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
const HEADING_RE = /^#{1,6}\s/;
const LIST_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;

/**
 * Split text into Discord-safe chunks (<= maxChars each).
 *
 *  - prefers to break on newline boundaries;
 *  - never splits *inside* a code fence: when a chunk boundary falls inside
 *    a fenced block, the fence is closed at the end of the current chunk and
 *    reopened at the start of the next (the opening token keeps its info
 *    string for highlighting; the closing token is bare, which both Common-
 *    Mark and Discord accept);
 *  - keeps markdown tables together: a table that fits in one chunk is
 *    never split across messages, and a table too long for one chunk is
 *    split row by row with the header + separator row repeated in every
 *    part (so each part still renders as a table);
 *  - when a break is needed in prose, it prefers the last "block boundary"
 *    in the current chunk (a blank line, or a heading / list item / table
 *    row start) so sections, lists, and paragraphs stay intact;
 *  - a single line longer than maxChars is hard-split.
 */
export function splitForDiscord(text: string, maxChars: number = DISCORD_MAX_MESSAGE_CHARS): string[] {
  if (text.length <= maxChars) {
    return text.length > 0 ? [text] : [];
  }

  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur: string[] = []; // lines of the chunk being built
  let curLen = 0; // length of cur.join("\n")
  let fenceReopen: string | null = null; // opening token of the open fence, e.g. "```ts"
  let fenceClose: string | null = null; // bare closing token, e.g. "```"

  /** Exclusive end of the table-row run starting at i, or -1 when not a row. */
  const tableEnd = new Array<number>(lines.length).fill(-1);
  for (let i = 0; i < lines.length; ) {
    if (!TABLE_ROW_RE.test(lines[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && TABLE_ROW_RE.test(lines[j])) j++;
    for (let t = i; t < j; t++) tableEnd[t] = j;
    i = j;
  }
  const isTableStart = (i: number): boolean =>
    tableEnd[i] !== -1 && (i === 0 || !TABLE_ROW_RE.test(lines[i - 1]));

  const appendLine = (line: string): void => {
    cur.push(line);
    curLen += line.length + (cur.length > 1 ? 1 : 0);
  };

  const emit = (): void => {
    let part = cur.join("\n");
    if (fenceReopen !== null && fenceClose !== null) {
      part = part.length > 0 ? `${part}\n${fenceClose}` : fenceClose;
    }
    // Blank lines at a message boundary are invisible; drop leading ones.
    part = part.replace(/^\n+/, "");
    if (part.length > 0) chunks.push(part);
    cur = [];
    curLen = 0;
  };

  const hardSplit = (line: string, budget: number): void => {
    if (cur.length > 0 || fenceReopen !== null) emit();
    for (let i = 0; i < line.length; i += budget) {
      chunks.push(line.slice(i, i + budget));
    }
    fenceReopen = null; // fence state cannot be preserved across raw splits
    fenceClose = null;
  };

  /**
   * `line` does not fit the current chunk (and no fence is open). Try to
   * break the current chunk at its last block boundary (a blank line, or a
   * heading / list item / table row start) so the carried-over tail keeps
   * sections, lists, and paragraphs intact; fall back to a plain flush.
   */
  const breakCarryOver = (line: string): void => {
    const n = cur.length;
    for (let s = n - 1; s >= 1; s--) {
      const isBoundary =
        cur[s] === "" ||
        cur[s - 1] === "" ||
        HEADING_RE.test(cur[s]) ||
        LIST_RE.test(cur[s]) ||
        TABLE_ROW_RE.test(cur[s]);
      if (!isBoundary) continue;
      const suffix = cur.slice(s);
      if (suffix.join("\n").length + 1 + line.length <= maxChars) {
        cur = cur.slice(0, s);
        emit();
        for (const tail of suffix) appendLine(tail);
        appendLine(line);
        return;
      }
    }
    emit();
    appendLine(line);
  };

  /** Sum of line lengths plus the newlines between them (0 for empty). */
  const joinedLen = (arr: string[]): number => arr.reduce((a, l) => a + l.length + 1, -1);

  /**
   * Trailing lines at the end of cur that read as the table's intro: blank
   * lines, headings, and a standalone short line (a title like
   * "Summary Table" that models write without # markup). Returns the
   * lines without leading blanks, or [] when there is none.
   */
  const tableIntro = (): string[] => {
    const run: string[] = [];
    for (let k = cur.length - 1; k >= 0; k--) {
      const l = cur[k];
      if (HEADING_RE.test(l) || l === "") {
        run.unshift(l);
        continue;
      }
      // A short line that stands alone (blank line or chunk start before
      // it) right before the table: almost certainly the table's title.
      if (run.length === 0 && l.length <= 80 && (k === 0 || cur[k - 1] === "")) {
        run.unshift(l);
      }
      break;
    }
    while (run.length > 0 && run[0] === "") run.shift();
    return run;
  };

  /**
   * Emit a whole table run (rows). When the table fits in one chunk it is
   * appended whole (flushing the current chunk first if needed). Otherwise
   * it is split row by row, repeating the header + separator row in every
   * part so each part still renders as a table; the parts are posted as
   * their own chunks and cur is left empty. A heading line right before
   * the table is carried into the table's chunk so it stays with it.
   */
  const emitTable = (rows: string[]): void => {
    const hasHeader = rows.length > 1 && TABLE_SEP_RE.test(rows[1]);
    const repeat = hasHeader ? [rows[0], rows[1]] : [];
    const body = hasHeader ? rows.slice(2) : rows;
    const total = joinedLen(rows);

    if (total <= maxChars) {
      if (cur.length === 0 || curLen + 1 + total <= maxChars) {
        for (const r of rows) appendLine(r);
        return;
      }
      const intro = tableIntro();
      if (intro.length > 0 && joinedLen(intro) + 1 + total <= maxChars) {
        // The trailing heading belongs to the table: keep it with the table.
        cur = cur.slice(0, cur.length - intro.length);
        curLen = cur.length > 0 ? joinedLen(cur) : 0;
        emit();
        for (const l of intro) appendLine(l);
        for (const r of rows) appendLine(r);
        return;
      }
      emit();
      for (const r of rows) appendLine(r);
      return;
    }

    // Table is too long for one chunk: pack rows into chunks.
    const repeatLen = repeat.reduce((a, r) => a + r.length + 1, -1);
    const parts: string[][] = [];
    let part: string[] = repeat.length > 0 ? [...repeat] : [];
    let partLen = repeat.length > 0 ? repeatLen : 0;
    for (const r of body) {
      if (r.length > maxChars) {
        // Pathological: a single row longer than a whole chunk.
        if (part.length > 0) parts.push(part);
        for (let i = 0; i < r.length; i += maxChars) parts.push([r.slice(i, i + maxChars)]);
        part = repeat.length > 0 ? [...repeat] : [];
        partLen = repeat.length > 0 ? repeatLen : 0;
        continue;
      }
      if (part.length > 0 && partLen + 1 + r.length > maxChars) {
        parts.push(part);
        part = repeat.length > 0 ? [...repeat] : [];
        partLen = repeat.length > 0 ? repeatLen : 0;
        if (partLen + 1 + r.length > maxChars) {
          part = []; // row doesn't fit even under the repeated header
          partLen = 0;
        }
      }
      part = [...part, r];
      partLen += r.length + 1;
    }
    if (part.length > 0) parts.push(part);

    if (cur.length > 0) emit();
    for (const p of parts) chunks.push(p.join("\n"));
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);

    if (line.length > maxChars) {
      hardSplit(line, maxChars);
    } else if (fenceReopen === null && !fenceMatch && isTableStart(i)) {
      const end = tableEnd[i];
      emitTable(lines.slice(i, end));
      i = end - 1; // continue with the line after the table
    } else {
      const fits = cur.length === 0 || curLen + 1 + line.length <= maxChars;
      if (fits) {
        appendLine(line);
      } else if (fenceReopen !== null && fenceClose !== null) {
        // Must break inside a code fence: close this chunk, reopen in the next.
        const reopened = `${fenceReopen}\n${line}`;
        if (reopened.length <= maxChars) {
          emit();
          cur = [reopened];
          curLen = reopened.length;
        } else {
          // Pathological: the line alone is too long to share a chunk with
          // the fence token. Emit raw pieces and abandon fence tracking.
          hardSplit(line, maxChars);
        }
      } else {
        breakCarryOver(line);
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
 *  - while the model is thinking (reasoning deltas, no reply content yet),
 *    a thinking live message shows the streamed reasoning
 *    ("🤔 *thinking: …*"); when the reply starts — or, when no reply
 *    content ever streams (non-stream mode, reasoning-only response), at
 *    finish — that message is edited to a terminal line ("🤔 *thought
 *    for Ns*") that stays in the channel above the reply, which streams in
 *    its own fresh message(s);
 *  - the reply streams in its own live message(s), created on the first
 *    content delta: when the text grows past a 2000-char slice boundary a
 *    fresh live message is created for the next slice — the same
 *    code-fence-aware chunks the final post will use — and only the
 *    growing last slice is edited (throttled to `throttleMs`, serialized);
 *  - on completion the final text is chunked (code-fence aware); each live
 *    message settles in place to its final chunk and any remaining chunks
 *    are posted fresh. Reasoning never lands in the final messages or the
 *    history (only the reply's message ids are reported);
 *  - `finish()`/`reportError()` return the ids and text of whatever was
 *    actually posted, so the caller can record the reply in the channel
 *    history (making it editable/deletable like any other message).
 */
export class ResponseWriter {
  private buffer = "";
  private reasoningBuffer = "";
  /**
   * The reply's live messages, in send order. Each holds its own slice
   * (<= 2000 chars, the same chunks the final post will use); a fresh
   * message is created when the text grows past the next slice boundary,
   * so a long reply streams as several messages instead of one "…" tail.
   */
  private liveMessages: Message[] = [];
  /** The thinking live message (null once the reply has taken over). */
  private thinkingMessage: Message | null = null;
  /** When the current round's thinking started (for the "thought for Ns" line). */
  private reasoningStartedAt: number | null = null;
  private typingTimer: NodeJS.Timeout | null = null;
  private lastThinkingEditAt = 0;
  private lastReplyEditAt = 0;
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
   * Feed a streamed reasoning delta (the model's "thinking", when the
   * endpoint sends it). Shown live in a thinking message that completes
   * into a "🤔 *thought for Ns*" line when the reply starts; reasoning is
   * never posted or recorded.
   */
  reason(delta: string): void {
    if (this.finished) return;
    if (this.reasoningStartedAt === null && this.buffer.length === 0) {
      this.reasoningStartedAt = Date.now();
    }
    this.reasoningBuffer += delta;
    this.chain = this.chain.then(() => this.updateLive()).catch(() => {});
  }

  /**
   * Discard the in-progress live messages (thinking + all reply live
   * messages) without finishing the turn. Used when a streamed response
   * turns out to contain tool calls: the text streamed so far is transient,
   * and the next round streams its own live messages. No-op when nothing
   * has been posted or the turn finished.
   */
  discard(): void {
    if (this.finished) return;
    this.buffer = "";
    this.reasoningBuffer = "";
    this.reasoningStartedAt = null;
    this.lastThinkingEditAt = 0;
    this.lastReplyEditAt = 0;
    // The messages are captured when the delete step runs, not now: a
    // pending updateLive from this round (e.g. an initial send still in
    // flight) is queued before the step, so the messages it creates are
    // deleted too, while next-round updates queue after the step and their
    // fresh messages survive.
    this.chain = this.chain.then(async () => {
      const targets = [this.thinkingMessage, ...this.liveMessages].filter((m): m is Message => m !== null);
      this.thinkingMessage = null;
      this.liveMessages = [];
      for (const m of targets) {
        await m.delete().catch(() => {});
      }
    });
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
    await this.completeThinking();

    const text = sanitizeForDiscord(fullText.trim() || this.buffer.trim());
    const posted: Message[] = [];
    try {
      if (!text) {
        const note = "*(the model returned no response)*";
        await this.clearLive(); // defensive: nothing streamed, so none exist
        posted.push(await this.opts.channel.send(note));
        return { messageIds: [posted[0].id], text: note };
      }
      for (const m of await this.settle(splitForDiscord(text))) posted.push(m);
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
    await this.completeThinking();

    const note = `⚠️ *generation failed:* ${truncate(errMsg(err), 400)}`;
    const partial = sanitizeForDiscord(this.buffer.trim());
    const text = partial ? `${partial}\n\n${note}` : note;
    const posted: Message[] = [];
    try {
      for (const m of await this.settle(splitForDiscord(text))) posted.push(m);
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
    if (this.buffer.length > 0) {
      await this.updateReply();
      return;
    }
    await this.updateThinking();
  }

  /**
   * The thinking preview: the live message while the model is still
   * thinking. Once the reply starts it is edited to its terminal line and
   * left in the channel (never deleted, never updated again).
   */
  private async updateThinking(): Promise<void> {
    if (this.reasoningBuffer.length === 0) return;
    try {
      if (!this.thinkingMessage) {
        this.thinkingMessage = await this.opts.channel.send(this.reasoningPreview());
      } else if (Date.now() - this.lastThinkingEditAt >= this.opts.throttleMs) {
        this.lastThinkingEditAt = Date.now();
        await this.thinkingMessage.edit({ content: this.reasoningPreview() });
      }
    } catch (err) {
      log.warn(`thinking preview update failed: ${errMsg(err)}`);
      // keep going; finish()/reportError() make the final attempt
    }
  }

  /**
   * The reply preview: its own live message(s) once content has started.
   * On the first content delta the thinking message (when there was one)
   * completes in place, then the reply's first slice is created as a fresh
   * message. When the text grows past a slice boundary a fresh live message
   * is created for the next slice; only the growing last slice is edited.
   */
  private async updateReply(): Promise<void> {
    const text = sanitizeForDiscord(this.buffer);
    if (text.length === 0) return;
    try {
      const chunks = splitForDiscord(text);
      if (this.liveMessages.length === 0 && this.thinkingMessage) {
        const done = this.thinkingMessage;
        this.thinkingMessage = null;
        await done.edit({ content: this.thinkingDoneLine() }).catch(() => {});
      }
      // A new slice appeared: start its live message with the slice as it
      // stands now; it keeps growing in the edits that follow.
      while (this.liveMessages.length < chunks.length) {
        const i = this.liveMessages.length;
        this.liveMessages.push(await this.opts.channel.send(chunks[i]));
      }
      const last = this.liveMessages.length - 1;
      if (Date.now() - this.lastReplyEditAt >= this.opts.throttleMs) {
        this.lastReplyEditAt = Date.now();
        const target = this.liveMessages[last];
        if (target.content !== chunks[last]) await target.edit({ content: chunks[last] });
      }
    } catch (err) {
      log.warn(`live message update failed: ${errMsg(err)}`);
      // keep going; finish()/reportError() make the final attempt
    }
  }

  /**
   * If no reply ever took over (non-stream mode, or a reasoning-only
   * response), the thinking line still completes in place at
   * finish()/reportError() time, so the final post lands in a fresh message
   * below it instead of overwriting it.
   */
  private async completeThinking(): Promise<void> {
    if (!this.thinkingMessage) return;
    const done = this.thinkingMessage;
    this.thinkingMessage = null;
    await done.edit({ content: this.thinkingDoneLine() }).catch(() => {});
  }

  private async postInto(target: Message | null, content: string): Promise<Message> {
    return target ? await target.edit({ content }) : await this.opts.channel.send(content);
  }

  /**
   * Settle the in-progress live messages into the final post: live message
   * i is edited to final chunk i (the preview already used the same
   * splitter, so this is normally a no-op or a small trim), and any chunks
   * beyond the live messages are posted fresh. Returns the messages in
   * send order; a live message with no chunk left (defensive) is deleted.
   */
  private async settle(chunks: string[]): Promise<Message[]> {
    const posted: Message[] = [];
    const n = Math.max(this.liveMessages.length, chunks.length);
    for (let i = 0; i < n; i++) {
      const live = this.liveMessages[i];
      if (i < chunks.length) {
        posted.push(live ? await this.postInto(live, chunks[i]) : await this.opts.channel.send(chunks[i]));
      } else if (live) {
        await live.delete().catch(() => {});
      }
    }
    this.liveMessages = [];
    return posted;
  }

  /** Delete any in-progress live messages (best-effort, normally none exist). */
  private async clearLive(): Promise<void> {
    const targets = this.liveMessages;
    this.liveMessages = [];
    for (const m of targets) await m.delete().catch(() => {});
  }

  /** The thinking message's terminal line: how long the model thought. */
  private thinkingDoneLine(): string {
    const startedAt = this.reasoningStartedAt;
    if (startedAt === null) return "🤔 *thought…*";
    const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    return `🤔 *thought for ${secs}s*`;
  }

  /**
   * Reasoning preview, capped at 2000 chars: the whole thinking while it
   * fits inline ("🤔 *thinking: …*"); once it doesn't, a header + a
   * "*N lines hidden*" line + the last REASONING_TAIL_LINES lines of the
   * thinking (cut from the front with a "…" when even those don't fit; a
   * thinking without newlines falls back to the plain character tail).
   */
  private reasoningPreview(): string {
    const max = DISCORD_MAX_MESSAGE_CHARS;
    const text = sanitizeForDiscord(this.reasoningBuffer).trim();
    if (text.length === 0) {
      return "🤔 *thinking…*";
    }
    const prefix = "🤔 *thinking: ";
    if (text.length <= max - prefix.length - 1 /* closing * */) {
      return prefix + text + "*";
    }
    const lines = text.split("\n");
    if (lines.length > REASONING_TAIL_LINES) {
      const header = "🤔 *thinking: …*";
      const hidden = lines.length - REASONING_TAIL_LINES;
      const hiddenLine = `*${hidden} line${hidden === 1 ? "" : "s"} hidden*`;
      const tail = lines.slice(-REASONING_TAIL_LINES).join("\n");
      const bodyBudget = max - header.length - hiddenLine.length - 2 /* newlines */;
      const body = tail.length > bodyBudget ? "…" + tail.slice(tail.length - (bodyBudget - 1)) : tail;
      return header + "\n" + hiddenLine + "\n" + body;
    }
    const budget = max - prefix.length - 1 /* closing * */ - 1 /* leading … */;
    return prefix + "…" + text.slice(text.length - budget) + "*";
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }
}
