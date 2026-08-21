import type { GuildTextBasedChannel, Message } from "discord.js";
import { errMsg, log, truncate } from "../log.js";
import { sanitizeForDiscord } from "./format.js";

/** Discord hard message limit. */
export const DISCORD_MAX_MESSAGE_CHARS = 2000;

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
 *  - one live message per round, created on the first update, showing in
 *    priority order: the streamed reply, or the model's streamed reasoning
 *    ("🤔 *thinking: …*");
 *  - while streaming, the live message is edited no more often than
 *    `throttleMs` (edits are serialized; a change of what is shown —
 *    thinking → reply — lands immediately; when the text exceeds 2000 chars
 *    the live preview shows the most recent tail);
 *  - on completion the final text is chunked (code-fence aware) and posted
 *    as one message per chunk; reasoning never lands in the final message
 *    or the history;
 *  - `finish()`/`reportError()` return the ids and text of whatever was
 *    actually posted, so the caller can record the reply in the channel
 *    history (making it editable/deletable like any other message).
 */
export class ResponseWriter {
  private buffer = "";
  private reasoningBuffer = "";
  /** What the live message currently shows (null when it shows nothing). */
  private shownKind: "reasoning" | "content" | null = null;
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
   * Feed a streamed reasoning delta (the model's "thinking", when the
   * endpoint sends it). Shown live in the same message that will carry the
   * reply; reasoning is never posted or recorded.
   */
  reason(delta: string): void {
    if (this.finished) return;
    this.reasoningBuffer += delta;
    this.chain = this.chain.then(() => this.updateLive()).catch(() => {});
  }

  /**
   * Discard the in-progress live message without finishing the turn.
   * Used when a streamed response turns out to contain tool calls: the
   * text streamed so far is transient, and the next round streams its own
   * live message. No-op when nothing has been posted or the turn finished.
   */
  discard(): void {
    if (this.finished) return;
    const target = this.message;
    this.message = null;
    this.buffer = "";
    this.reasoningBuffer = "";
    this.shownKind = null;
    this.lastEditAt = 0;
    if (target) {
      // Delete the captured message object (not this.message): a pending
      // updateLive may recreate a fresh live message, which must survive.
      this.chain = this.chain.then(async () => {
        await target.delete().catch(() => {});
      });
    }
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

    const text = sanitizeForDiscord(fullText.trim() || this.buffer.trim());
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
    const partial = sanitizeForDiscord(this.buffer.trim());
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
    const preview = this.preview();
    if (preview === null) return;
    // A change of what is shown (activity → thinking → reply) lands
    // immediately; updates of the same kind respect the throttle.
    const force = this.shownKind !== preview.kind;
    try {
      if (!this.message) {
        this.message = await this.opts.channel.send(preview.text);
        this.shownKind = preview.kind;
      } else {
        const now = Date.now();
        if (force || now - this.lastEditAt >= this.opts.throttleMs) {
          this.lastEditAt = now;
          this.shownKind = preview.kind;
          await this.message.edit({ content: preview.text });
        }
      }
    } catch (err) {
      log.warn(`live message update failed: ${errMsg(err)}`);
      // keep going; finish()/reportError() make the final attempt
    }
  }

  /**
   * What the live message shows right now, highest priority first: the
   * streamed reply, then the streamed reasoning.
   */
  private preview(): { kind: "reasoning" | "content"; text: string } | null {
    if (this.buffer.length > 0) {
      return { kind: "content", text: this.contentPreview() };
    }
    if (this.reasoningBuffer.length > 0) {
      return { kind: "reasoning", text: this.reasoningPreview() };
    }
    return null;
  }

  /** Reply preview capped at 2000 chars: the head while it fits, the tail once it doesn't. */
  private contentPreview(): string {
    const max = DISCORD_MAX_MESSAGE_CHARS;
    const text = sanitizeForDiscord(this.buffer);
    if (text.length <= max) {
      return text.trim().length > 0 ? text : "…";
    }
    return "…" + text.slice(text.length - (max - 3));
  }

  /**
   * Reasoning preview: the most recent tail of the thinking, wrapped in an
   * italic "🤔 *thinking: …*" header, capped at 2000 chars.
   */
  private reasoningPreview(): string {
    const prefix = "🤔 *thinking: ";
    const max = DISCORD_MAX_MESSAGE_CHARS;
    const text = sanitizeForDiscord(this.reasoningBuffer).trim();
    if (text.length === 0) {
      return "🤔 *thinking…*";
    }
    const budget = max - prefix.length - 1 /* closing * */ - 1 /* leading … */;
    const tail = text.length > budget ? "…" + text.slice(text.length - budget) : text;
    return prefix + tail + "*";
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }
}
