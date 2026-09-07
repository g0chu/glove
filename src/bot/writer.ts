import type { GuildTextBasedChannel, Message } from "discord.js";
import { errMsg, log, truncate } from "../log.js";
import { ACTIVITY_CONTENT_MAX, sanitizeForDiscord } from "./format.js";

/** Discord hard message limit. */
export const DISCORD_MAX_MESSAGE_CHARS = 2000;

/** How many trailing thinking lines the long-form reasoning preview keeps. */
const REASONING_TAIL_LINES = 5;

/**
 * The reasoning buffer keeps only a generous tail of the thinking (the
 * preview needs at most ~2000 chars); the "N lines hidden" count comes
 * from the tracked total line count, so capping loses nothing visible.
 */
const REASONING_BUFFER_MAX = 8000;


/**
 * Mentions allowed in the bot's own posts: user pings stay active (the
 * model can address a specific person), while @everyone/@here and role
 * pings are suppressed — a stray mention in model or reasoning output must
 * not ping the whole server.
 */
export const SAFE_MENTIONS = { parse: ["users"] as const };

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const TABLE_ROW_RE = /^\s*\|/;
/** GFM separator row: | --- | :---: | ... (Discord tables need one). */
const TABLE_SEP_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
const HEADING_RE = /^#{1,6}\s/;
const LIST_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;

/**
 * Split text into Discord-safe chunks (<= maxChars each).
 *
 *  - the FIRST chunk may additionally be capped by `firstMaxChars` (the
 *    round text that streams inside the turn's activity message is
 *    budgeted to the room the settled lines leave); every chunk after the
 *    first uses maxChars. Omitted, every chunk is capped at maxChars;
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
export function splitForDiscord(
  text: string,
  maxChars: number = DISCORD_MAX_MESSAGE_CHARS,
  firstMaxChars?: number,
): string[] {
  // The first chunk may be capped tighter than the rest (the live text
  // slice inside the activity message is budgeted to the room the settled
  // lines leave); every chunk after the first uses maxChars.
  const firstCap = Math.min(maxChars, firstMaxChars ?? maxChars);
  if (text.length <= firstCap) {
    return text.length > 0 ? [text] : [];
  }

  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur: string[] = []; // lines of the chunk being built
  let curLen = 0; // length of cur.join("\n")
  let fenceReopen: string | null = null; // opening token of the open fence, e.g. "```ts"
  let fenceClose: string | null = null; // bare closing token, e.g. "```"

  /** The cap of the chunk currently being built (chunk 0 may be smaller). */
  const cap = (): number => (chunks.length === 0 ? firstCap : maxChars);

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
    let i = 0;
    while (i < line.length) {
      // The first raw piece is chunk 0: cap it at the first chunk's cap.
      const b = Math.min(budget, chunks.length === 0 ? firstCap : budget);
      chunks.push(line.slice(i, i + b));
      i += b;
    }
    fenceReopen = null; // fence state cannot be preserved across raw splits
    fenceClose = null;
  };

  /**
   * `line` does not fit the current chunk (and no fence is open). Try to
   * break the current chunk at its last block boundary (a blank line, or a
   * heading / list item / table row start) so the carried-over tail keeps
   * sections, lists, and paragraphs intact; fall back to a plain flush.
   * `closeOverhead` is the closing-fence-token overhead of the fence state
   * AFTER `line` is appended (non-zero only when `line` opens a fence): the
   * carried chunk ends with `line`, so its eventual emit must still fit
   * once the token is appended.
   */
  const breakCarryOver = (line: string, closeOverhead: number): void => {
    if (cur.length === 0 && line.length + closeOverhead > cap()) {
      // The line is alone in chunk 0 and overflows the first chunk's cap:
      // raw-split it (the first raw piece is capped too).
      hardSplit(line, Math.max(1, maxChars - closeOverhead));
      return;
    }
    if (line.length + closeOverhead > maxChars) {
      hardSplit(line, Math.max(1, maxChars - closeOverhead));
      return;
    }
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
      if (suffix.join("\n").length + 1 + line.length + closeOverhead <= maxChars) {
        cur = cur.slice(0, s);
        emit();
        for (const tail of suffix) appendLine(tail);
        appendLine(line);
        return;
      }
    }
    // No boundary worked: emit everything and start fresh with just the
    // line. Safe: line.length + closeOverhead <= maxChars (checked above),
    // so the chunk ends at maxChars even when the line opens a fence.
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

    if (total <= cap()) {
      if (cur.length === 0 || curLen + 1 + total <= cap()) {
        for (const r of rows) appendLine(r);
        return;
      }
      const intro = tableIntro();
      // The intro + table lands in the next chunk: chunk 1 (maxChars) when
      // the current lines flush before it, chunk 0 (the first cap) when cur
      // holds only the intro.
      const introCap = cur.length - intro.length === 0 ? firstCap : maxChars;
      if (intro.length > 0 && joinedLen(intro) + 1 + total <= introCap) {
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
    // The table's first part may be chunk 0 (cur was empty): it must fit
    // the first chunk's cap — repack it under firstCap when needed.
    let out = parts;
    if (chunks.length === 0 && out.length > 0 && joinedLen(out[0]) > firstCap) {
      const repacked: string[][] = [];
      let rp: string[] = [];
      let rpLen = 0;
      const flushRp = (): void => {
        if (rp.length > 0) {
          repacked.push(rp);
          rp = [];
          rpLen = 0;
        }
      };
      for (const r of out[0]) {
        if (r.length > firstCap) {
          flushRp();
          for (let i = 0; i < r.length; i += firstCap) repacked.push([r.slice(i, i + firstCap)]);
          continue;
        }
        if (rp.length > 0 && rpLen + 1 + r.length > firstCap) flushRp();
        rp.push(r);
        rpLen += r.length + 1;
      }
      flushRp();
      out = [...repacked, ...out.slice(1)];
    }
    for (const p of out) chunks.push(p.join("\n"));
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
      // A chunk emitted while the fence is open gains a closing token, so
      // reserve its room: without it the emitted part could exceed maxChars.
      // The token is the one of the fence state AFTER this line (a fence
      // line toggles it), since this line is what the chunk would end with.
      const postClose = fenceMatch ? (fenceReopen === null ? fenceMatch[1] : null) : fenceClose;
      const closeOverhead = postClose !== null ? 1 + postClose.length : 0;
      const fits =
        cur.length === 0 ? line.length + closeOverhead <= cap() : curLen + 1 + line.length + closeOverhead <= cap();
      if (fits) {
        appendLine(line);
      } else if (fenceReopen !== null && fenceClose !== null) {
        // Must break inside a code fence: close this chunk, reopen in the next.
        // The reopened chunk keeps the fence open, so it too must leave room
        // for the closing token.
        const reopened = `${fenceReopen}\n${line}`;
        if (reopened.length + closeOverhead <= maxChars) {
          emit();
          cur = [reopened];
          curLen = reopened.length;
        } else {
          // Pathological: the line alone is too long to share a chunk with
          // the fence token. Emit raw pieces and abandon fence tracking.
          hardSplit(line, maxChars);
        }
      } else {
        breakCarryOver(line, closeOverhead);
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
  /**
   * Discord message ids in send order (one per chunk). Empty when the text
   * settled inside the turn's activity message (a UI line, never context):
   * the text is then recorded without a backing message (no edit/delete
   * sync), while a text in its own message(s) carries their ids.
   */
  messageIds: string[];
  /** Text to record in the history: the canonical reply when every chunk posted. */
  text: string;
  /** Per-message text as posted, when the reply spanned multiple messages. */
  chunks?: string[];
}

/**
 * Posts a model reply to a channel with Discord-specific concerns:
 *  - typing indicator refreshed every `typingIntervalMs`;
 *  - ONE activity message per turn, holding everything in the order it
 *    happened: each round's thinking terminal line (while a round is
 *    thinking, the live preview shows at the bottom, "🤔 *thinking: …*";
 *    when the round ends — the reply starts, or discard() settles the
 *    round, or finish() runs with no reply content — it completes in place
 *    to "🤔 *first line of the thinking… (12s)*"), the round's text (the
 *    round's narration, settled in place when the round ends), and the
 *    tool-call lines (appendActivityLines, after each round's lines). The
 *    message is posted on the first line, edited in place for every later
 *    one — the channel stays quiet no matter how many rounds run. When a
 *    round's text outgrows the room the message leaves (a slice boundary is
 *    crossed), the text demotes to its own live message(s) below it (the
 *    record then keeps their ids, so the seed and the edit/delete sync stay
 *    correct), and later lines open a FRESH activity message below the
 *    overflow, so the channel order always matches the order they
 *    happened. Past 2000 chars the oldest lines collapse into a "… N
 *    earlier activity lines …" header that keeps a leading icon (the
 *    message always starts with a 🤔/🔎/📁/🐚/📚/🔧 line, so it stays a
 *    UI line, never context). A `*` from the model's text is dropped from
 *    the displayed thinking (a markdown bullet or bold would break the
 *    italic wrapping);
 *  - a turn whose first content is plain text (no thinking, no call line
 *    yet) posts that text in its own message(s) — the activity message is
 *    created only when a thinking or call line lands — so the bot's
 *    context-seeding skips (a UI line, never tracked) stay correct;
 *  - on completion the final text is chunked (code-fence aware, the first
 *    slice budgeted to the activity message's room when it lives there);
 *    each live message settles in place and any remaining slices are
 *    posted fresh. Reasoning never lands in the final messages or in the
 *    writer's report (the caller records the rounds' reasoning from the
 *    model results, not from the writer);
 *  - `finish()`/`reportError()` return the ids and text of whatever was
 *    actually posted, so the caller can record the reply in the channel
 *    history (making it editable/deletable like any other message).
 */
export class ResponseWriter {
  private buffer = "";
  private reasoningBuffer = "";
  private reasoningCapped = false;
  private reasoningNewlines = 0;
  private reasoningEndedNewline = false;
  /**
   * The first line of the reasoning, kept for the terminal line (capped at
   * ACTIVITY_CONTENT_MAX — the same length the tool activity lines use).
   * Tracked separately from reasoningBuffer
   * because that buffer keeps only a tail (the head is dropped when the
   * thinking runs long).
   */
  private reasoningFirstLine = "";
  /** Full length of the first reasoning line (up to its newline). */
  private reasoningFirstLineLength = 0;
  /** True once a newline ended the first reasoning line. */
  private reasoningFirstLineDone = false;
  /**
   * True once this round's thinking has been completed into its terminal
   * line (by the text taking over, by discard(), or by finish()). Guards
   * against settling a second terminal line for the same round.
   */
  private thinkingSettled = false;
  /**
   * The settled blocks of the current activity message, in the order they
   * happened: each round's thinking terminal line, the round text blocks
   * (a round's narration that settled inside the message), and the
   * tool-call lines. A text that outgrew the message lives in its own
   * message(s) instead (see textMode) — the blocks hold what the message
   * shows.
   */
  private blocks: string[] = [];
  /** Lines collapsed behind the "… N earlier activity lines …" header. */
  private droppedLines = 0;
  /**
   * Lines that could not be posted to the current (stale) activity message
   * yet: they wait for the fresh message that opens below the overflow
   * (a failed post keeps them, so the retry carries every line so far).
   */
  private pendingLines: string[] = [];
  /** Pending lines collapsed behind the header (same as droppedLines). */
  private pendingDropped = 0;
  /** The current activity message (null until its first line/preview lands). */
  private activityMessage: Message | null = null;
  /**
   * True once a message was posted below the activity message (a round
   * text that outgrew it, demoted to its own message): later lines open a
   * FRESH activity message below the overflow, so the channel order
   * matches the order they happened.
   */
  private activityStale = false;
  /**
   * Where this round's text block lives: not started; inside the fresh
   * activity message (its first slice, budgeted to the room the settled
   * blocks leave); or in its own live message(s) (no message to join, or
   * it outgrew the message and was demoted).
   */
  private textMode: "none" | "activity" | "own" = "none";
  /**
   * The cap of the text block's first slice: the room the settled blocks
   * left at stream start (the same cap is used at settle, so the slice
   * boundaries stay stable across the demotion), or 2000 when the block is
   * its own message from the start.
   */
  private textFirstCap = DISCORD_MAX_MESSAGE_CHARS;
  /**
   * The live messages of the text block's slices OUTSIDE the activity
   * message: "activity" mode — slice 1+ (index = slice index − 1, normally
   * none — the first overflow demotes the block); "own" mode — every slice
   * (index = slice index).
   */
  private textSlices: Message[] = [];
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
   * endpoint sends it). Shown live at the bottom of the turn's activity
   * message, completing into a terminal line (the first line of the
   * thinking, truncated, plus how long it took) when the reply starts
   * or the round ends; reasoning is never posted or recorded in full.
   */
  reason(delta: string): void {
    if (this.finished) return;
    if (this.reasoningStartedAt === null && this.buffer.length === 0) {
      this.reasoningStartedAt = Date.now();
    }
    // Track the first line (for the terminal line) until its newline arrives.
    // Only the first ACTIVITY_CONTENT_MAX are kept — the terminal line
    // truncates there (the same length the tool activity lines use) — but the
    // full length is counted to know whether the line was cut.
    if (!this.reasoningFirstLineDone) {
      const nl = delta.indexOf("\n");
      const take = nl === -1 ? delta : delta.slice(0, nl);
      this.reasoningFirstLineLength += take.length;
      if (this.reasoningFirstLine.length < ACTIVITY_CONTENT_MAX) {
        this.reasoningFirstLine += take.slice(0, ACTIVITY_CONTENT_MAX - this.reasoningFirstLine.length);
      }
      if (nl !== -1) this.reasoningFirstLineDone = true;
    }
    let newlines = 0;
    for (let i = 0; i < delta.length; i++) {
      if (delta[i] === "\n") newlines++;
    }
    this.reasoningNewlines += newlines;
    if (delta.length > 0) this.reasoningEndedNewline = delta[delta.length - 1] === "\n";
    this.reasoningBuffer += delta;
    if (this.reasoningBuffer.length > REASONING_BUFFER_MAX) {
      // Keep only the tail: the preview shows the last few lines anyway.
      this.reasoningBuffer = this.reasoningBuffer.slice(-REASONING_BUFFER_MAX);
      this.reasoningCapped = true;
    }
    this.chain = this.chain.then(() => this.updateLive()).catch(() => {});
  }

  /**
   * End a tool-call round without finishing the turn. The round's streamed
   * text is settled in place (inside the activity message it becomes a
   * settled block — recorded without a message id, the message being a UI
   * line — or in its own message(s), completed to the round's full text),
   * and its thinking is completed into its terminal line (in the order
   * they happened: the thinking line, then the text, then — on the next
   * step — the call lines). The next round's preview and lines continue in
   * the same message (or a fresh one below the overflow). Resolves with
   * what the round's text settled to (the message ids + text, like finish)
   * so the caller can record the round in the channel history (its message
   * ids keep edits and deletes in sync), or null when there was no text or
   * the turn already finished.
   */
  async discard(): Promise<PostedReply | null> {
    if (this.finished) return null;
    // Captured before the state below is cleared: the terminal line, the
    // round's full text (the live preview may lag behind the buffer — edits
    // are throttled — so the settle completes the live messages to the full
    // text), and whether there was thinking to persist all belong to the
    // round ending now.
    // (thinkingSettled is deliberately NOT reset here — an in-flight
    // updateText may still settle the thinking after this sync part runs;
    // it is reset at the end of the step, below, once the thinking has been
    // handled, so a terminal line already settled is not settled again.)
    const doneLine = this.thinkingDoneLine();
    const hadReasoning = this.reasoningBuffer.length > 0;
    const replyText = sanitizeForDiscord(this.buffer).trim();
    this.buffer = "";
    this.reasoningBuffer = "";
    this.reasoningCapped = false;
    this.reasoningNewlines = 0;
    this.reasoningEndedNewline = false;
    this.reasoningFirstLine = "";
    this.reasoningFirstLineLength = 0;
    this.reasoningFirstLineDone = false;
    this.reasoningStartedAt = null;
    this.lastThinkingEditAt = 0;
    this.lastReplyEditAt = 0;
    let settled: PostedReply | null = null;
    // The messages are handled when the step runs, not now: a pending
    // updateLive from this round (e.g. an initial send still in flight) is
    // queued before the step, so the messages it creates are settled too,
    // while next-round updates queue after the step and start the next
    // round's fresh live messages.
    this.chain = this.chain.then(async () => {
      if (hadReasoning && !this.thinkingSettled) {
        // Reasoning streamed (the live preview may or may not have landed)
        // and the text never took over: complete the round's thinking into
        // its terminal line so the thinking is not lost.
        this.thinkingSettled = true;
        await this.settleThinkingLine(doneLine);
      }
      if (replyText.length > 0) {
        settled = await this.settleText(replyText);
      }
      // A new round starts: reset the settled flag so the next round's
      // thinking is tracked fresh.
      this.thinkingSettled = false;
    });
    await this.chain;
    return settled;
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
    if (this.reasoningBuffer.length > 0 && !this.thinkingSettled) {
      // A reasoning-only response (or non-stream mode): the thinking still
      // completes into its terminal line, above the reply/note — the order
      // they happened.
      this.thinkingSettled = true;
      await this.settleThinkingLine(this.thinkingDoneLine());
    }
    const text = sanitizeForDiscord(fullText.trim() || this.buffer.trim());
    try {
      if (!text) {
        // No reply content: a short note (the caller still records it, so
        // the history shows the turn ended without a reply).
        const note = "*(the model returned no response)*";
        if (this.activityFresh()) {
          this.blocks.push(note);
          this.collapseBlocks();
          await this.syncActivity(this.renderBlocks());
          return { messageIds: [], text: note };
        }
        const m = await this.opts.channel.send({ content: note, allowedMentions: SAFE_MENTIONS });
        return { messageIds: [m.id], text: note };
      }
      if (this.textMode === "none") {
        // The text never streamed (non-stream mode): start the block now so
        // it settles where it belongs (the fresh activity message when
        // there is one, its own message(s) otherwise).
        this.startText();
      }
      // (startText may have moved the thinking line to the blocks): the text
      // posts below the activity message, so complete the line in place.
      if (this.textMode === "own" && this.activityMessage !== null) {
        await this.syncActivity(this.renderBlocks());
      }
      return await this.settleText(text);
    } catch (err) {
      log.error(`failed to finalize reply: ${errMsg(err)}`);
      // Nothing could be posted: the caller records nothing.
      return null;
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
    if (this.reasoningBuffer.length > 0 && !this.thinkingSettled) {
      this.thinkingSettled = true;
      await this.settleThinkingLine(this.thinkingDoneLine());
    }
    const note = `⚠️ *generation failed:* ${truncate(errMsg(err), 400)}`;
    const partial = sanitizeForDiscord(this.buffer.trim());
    try {
      if (partial.length === 0 && this.textMode === "none") {
        // Nothing streamed: the note goes inside the fresh activity message
        // (when there is one — it is the turn's only content), else in its
        // own message.
        if (this.activityFresh()) {
          this.blocks.push(note);
          this.collapseBlocks();
          await this.syncActivity(this.renderBlocks());
          return { messageIds: [], text: note };
        }
        const m = await this.opts.channel.send({ content: note, allowedMentions: SAFE_MENTIONS });
        return { messageIds: [m.id], text: note };
      }
      const text = partial.length > 0 ? `${partial}\n\n${note}` : note;
      if (this.textMode === "none") this.startText();
      return await this.settleText(text);
    } catch (err2) {
      log.error(`failed to post error message: ${errMsg(err2)}`);
      return null;
    }
  }

  /**
   * Interrupt an in-progress attempt (the model request was aborted by
   * channel activity, see index.ts): stop the typing indicator, complete
   * the round's thinking line (kept, like a finished round's), and withdraw
   * the round's partial text (stripped from the activity message, or its
   * live message(s) deleted). With the prefill-only interruption (see
   * LlmClient.chat) an interrupted attempt has streamed no token yet, so
   * this is normally a no-op beyond stopping typing; the paths below cover
   * the defensive cases (a non-stream call aborted mid-flight, a manual
   * interrupt). The caller then waits for the channel to go quiet and
   * either discards the turn (a newer turn supersedes it) or retries it
   * with a fresh writer, so the partial text never lingers as a broken
   * reply. A no-op when the writer never started or already finished.
   */
  async interrupt(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopTyping();
    await this.chain.catch(() => {});
    if (this.reasoningBuffer.length > 0 && !this.thinkingSettled) {
      this.thinkingSettled = true;
      await this.settleThinkingLine(this.thinkingDoneLine());
    }
    if (this.textMode === "activity") {
      // The round's partial text streamed inside the activity message:
      // strip it out (the message goes back to its settled blocks).
      if (this.activityMessage !== null) await this.syncActivity(this.renderBlocks());
    } else if (this.textMode === "own") {
      // The round's partial text streamed in its own live message(s):
      // delete them.
      await this.clearTextSlices();
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
      await this.updateText();
      return;
    }
    await this.updateThinking();
  }

  /**
   * The thinking preview, live, at the bottom of the activity message: the
   * settled blocks above, the streaming reasoning below (budgeted to the
   * room the blocks leave in the 2000-char message). Once the round ends
   * the preview is replaced by the round's terminal line. When there is no
   * fresh activity message (a turn whose first content is the thinking, or
   * a fresh one opening below the overflow), this opens it.
   */
  private async updateThinking(): Promise<void> {
    if (this.reasoningBuffer.length === 0) return;
    if (this.activityMessage !== null && !this.activityStale) {
      const settled = this.renderBlocks();
      // The preview gets exactly the room the settled blocks leave in the
      // 2000-char message (reasoningPreview degrades to the plain
      // "thinking…" indicator — or less — when the room runs out, never
      // overflows).
      const budget = Math.max(DISCORD_MAX_MESSAGE_CHARS - (settled.length > 0 ? settled.length + 1 : 0), 0);
      const preview = this.reasoningPreview(budget);
      const content =
        preview.length === 0 ? settled : settled.length > 0 ? `${settled}\n${preview}` : preview;
      // The preview updates per reasoning delta: edits are throttled (the
      // first post is not — it goes through ensureActivity).
      if (Date.now() - this.lastThinkingEditAt < this.opts.throttleMs) return;
      this.lastThinkingEditAt = Date.now();
      await this.syncActivity(content);
      return;
    }
    await this.ensureActivity();
  }

  /**
   * Post or edit the turn's activity message: a fresh message is edited in
   * place; when none exists yet one is posted (it starts with the waiting
   * blocks, the live preview at the bottom when the round is still
   * thinking); when the current one is stale (a message was posted below
   * it) a fresh one is posted below the overflow, starting with the lines
   * that waited (the live preview at the bottom). A failed post is retried
   * by the next line or preview (the retry carries every line so far).
   */
  private async ensureActivity(): Promise<void> {
    if (this.activityMessage !== null && !this.activityStale) {
      await this.syncActivity(this.renderBlocks());
      return;
    }
    const blocks = this.activityStale ? [...this.pendingLines] : this.blocks;
    const dropped = this.activityStale ? this.pendingDropped : this.droppedLines;
    let content = this.renderBlocksFor(blocks, dropped);
    if (this.reasoningBuffer.length > 0) {
      const budget = Math.max(DISCORD_MAX_MESSAGE_CHARS - (content.length > 0 ? content.length + 1 : 0), 0);
      const preview = this.reasoningPreview(budget);
      if (preview.length > 0) {
        content = content.length > 0 ? `${content}\n${preview}` : preview;
      }
    }
    await this.openActivity(content, blocks, dropped);
  }

  /** Post a fresh activity message; on success the state moves to it. */
  private async openActivity(content: string, blocks: string[], dropped: number): Promise<void> {
    try {
      this.activityMessage = await this.opts.channel.send({ content, allowedMentions: SAFE_MENTIONS });
      this.activityStale = false;
      this.blocks = blocks;
      this.droppedLines = dropped;
      this.pendingLines = [];
      this.pendingDropped = 0;
    } catch (err) {
      log.warn(`failed to post the activity message: ${errMsg(err)}`);
    }
  }

  /**
   * Post or edit the current activity message to `content` (it exists):
   * a failed edit keeps the last good content and is retried by the next
   * line or preview.
   */
  private async syncActivity(content: string): Promise<void> {
    const m = this.activityMessage;
    if (!m) return;
    try {
      if (m.content !== content) {
        await m.edit({ content, allowedMentions: SAFE_MENTIONS });
      }
    } catch (err) {
      log.warn(`failed to update the activity message: ${errMsg(err)}`);
    }
  }

  private activityFresh(): boolean {
    return this.activityMessage !== null && !this.activityStale;
  }

  /** The kept blocks, the dropped ones summarized in the header. */
  private renderBlocks(): string {
    return this.renderBlocksFor(this.blocks, this.droppedLines);
  }

  private renderBlocksFor(blocks: string[], dropped: number): string {
    if (dropped > 0) {
      const header = `🔧 *… ${dropped} earlier activity lines …*`;
      return [header, ...blocks].join("\n");
    }
    return blocks.join("\n");
  }

  /** The settled blocks above, the streaming text at the bottom. */
  private renderWithTail(tail: string): string {
    const settled = this.renderBlocks();
    return settled.length > 0 ? `${settled}\n${tail}` : tail;
  }

  /** Past the 2000-char cap, collapse the oldest blocks behind the header. */
  private collapseBlocks(): void {
    while (this.blocks.length > 1 && this.renderBlocks().length > DISCORD_MAX_MESSAGE_CHARS) {
      this.droppedLines += this.blocks[0].split("\n").length;
      this.blocks.shift();
    }
  }

  /** Same, for the lines waiting for a fresh message. */
  private collapsePending(): void {
    while (this.pendingLines.length > 1 && this.renderBlocksFor(this.pendingLines, this.pendingDropped).length > DISCORD_MAX_MESSAGE_CHARS) {
      this.pendingDropped++;
      this.pendingLines.shift();
    }
  }

  /**
   * Append lines to the turn's activity lines (the tool-call lines, one
   * per call, in call order): a fresh activity message gets them appended
   * to its blocks (edited in place); otherwise they wait for the message
   * that opens below the overflow (or the first one, when none exists
   * yet). Awaited, so the post/edit lands before the caller proceeds.
   */
  async appendActivityLines(lines: string[]): Promise<void> {
    if (lines.length === 0 || this.finished) return;
    if (this.activityFresh()) {
      for (const line of lines) this.blocks.push(line);
      this.collapseBlocks();
      this.chain = this.chain.then(() => this.syncActivity(this.renderBlocks()));
    } else {
      if (this.activityMessage === null) {
        // No message exists yet: the lines open it (the first post carries
        // them — the turn's first content is a call line, and the message
        // starts with its icon, so it stays a UI line).
        for (const line of lines) this.blocks.push(line);
        this.collapseBlocks();
      } else {
        // The current message is stale (a message was posted below it): the
        // lines wait for the fresh one that opens below the overflow.
        for (const line of lines) this.pendingLines.push(line);
        this.collapsePending();
      }
      this.chain = this.chain.then(() => this.ensureActivity());
    }
    await this.chain;
  }

  /**
   * Complete the round's thinking into its terminal line where the activity
   * lines live: the fresh activity message's blocks (synced in place), the
   * waiting blocks when no message exists yet, or the pending lines that
   * open the fresh message below the overflow.
   */
  private async settleThinkingLine(line: string): Promise<void> {
    if (this.activityFresh()) {
      this.blocks.push(line);
      this.collapseBlocks();
      await this.syncActivity(this.renderBlocks());
    } else if (this.activityMessage === null) {
      // No message yet (a failed preview post): the line opens it, so the
      // round's thinking is not lost when the round ends now.
      this.blocks.push(line);
      this.collapseBlocks();
      await this.ensureActivity();
    } else {
      this.pendingLines.push(line);
      this.collapsePending();
      await this.ensureActivity();
    }
  }

  /**
   * Begin this round's text block. First the round's thinking completes
   * into its terminal line (it happened before the text), then the text's
   * landing is decided: inside the fresh activity message (its first
   * slice, budgeted to the room the settled blocks leave) or in its own
   * live message(s) (no message yet, or the message cannot host it).
   */
  private startText(): void {
    if (this.reasoningBuffer.length > 0 && !this.thinkingSettled) {
      this.thinkingSettled = true;
      const line = this.thinkingDoneLine();
      if (this.activityStale) {
        this.pendingLines.push(line);
        this.collapsePending();
      } else {
        this.blocks.push(line);
        this.collapseBlocks();
      }
    }
    const settled = this.renderBlocks();
    const room = DISCORD_MAX_MESSAGE_CHARS - (settled.length > 0 ? settled.length + 1 : 0);
    if (this.activityFresh() && room >= 1) {
      this.textMode = "activity";
      this.textFirstCap = room;
    } else {
      this.textMode = "own";
      this.textFirstCap = DISCORD_MAX_MESSAGE_CHARS;
      if (this.activityMessage !== null) this.activityStale = true; // the text posts below it
    }
  }

  /**
   * The text preview, live: inside the fresh activity message (the settled
   * blocks above, the growing first slice at the bottom), or in its own
   * live message(s) (a fresh message per slice as they appear; only the
   * growing last slice is edited, throttled). When the text outgrows the
   * activity message's room, the block demotes to its own message(s).
   */
  private async updateText(): Promise<void> {
    const text = sanitizeForDiscord(this.buffer);
    if (text.length === 0) return;
    try {
      if (this.textMode === "none") {
        this.startText();
      }
      // The text posts in its own message(s) below the activity message:
      // complete the thinking line in place there (the preview is replaced).
      // (A no-op via the content check when the line already landed.)
      if (this.textMode === "own" && this.activityMessage !== null) {
        await this.syncActivity(this.renderBlocks());
      }
      const chunks = splitForDiscord(text, DISCORD_MAX_MESSAGE_CHARS, this.textFirstCap);
      if (this.textMode === "activity" && chunks.length > 1) {
        // The text outgrew the activity message's room: demote — the first
        // slice is final, so it moves out into its own message (the channel
        // order: the activity message, then the text's slices), and the
        // block continues in its own live message(s) (the record keeps the
        // message ids: the seed and the edit/delete sync stay correct).
        if (this.activityMessage !== null) await this.syncActivity(this.renderBlocks());
        const first = await this.opts.channel.send({ content: chunks[0], allowedMentions: SAFE_MENTIONS });
        this.textSlices = [first, ...this.textSlices];
        this.textMode = "own";
        this.activityStale = true; // a message now sits below the activity message
      }
      if (this.textMode === "activity") {
        // No overflow: the first slice grows inside the activity message.
        const content = this.renderWithTail(chunks[0]);
        if (Date.now() - this.lastReplyEditAt >= this.opts.throttleMs) {
          this.lastReplyEditAt = Date.now();
          await this.syncActivity(content);
        }
        return;
      }
      // "own": a live message per slice (created as the slices appear);
      // only the growing last slice is edited (throttled, serialized).
      while (this.textSlices.length < chunks.length) {
        const i = this.textSlices.length;
        this.textSlices.push(await this.opts.channel.send({ content: chunks[i], allowedMentions: SAFE_MENTIONS }));
      }
      const last = this.textSlices.length - 1;
      if (Date.now() - this.lastReplyEditAt >= this.opts.throttleMs) {
        this.lastReplyEditAt = Date.now();
        const target = this.textSlices[last];
        if (target.content !== chunks[last]) await target.edit({ content: chunks[last], allowedMentions: SAFE_MENTIONS });
      }
    } catch (err) {
      log.warn(`live message update failed: ${errMsg(err)}`);
      // keep going; finish()/reportError() make the final attempt
    }
  }

  /**
   * Settle this round's text block: inside the activity message (when it
   * fit) the final first slice becomes a settled block — recorded without
   * a message id, the message being a UI line (never context, never
   * tracked); when the text lives in its own message(s) (or outgrew the
   * message with the final settle) the slices settle in place, and the
   * record carries their ids (the seed skips it as tracked, and edits and
   * deletes keep syncing). Returns what was posted (null only when the
   * own-message settle posted nothing).
   */
  private async settleText(text: string): Promise<PostedReply | null> {
    const chunks = splitForDiscord(text, DISCORD_MAX_MESSAGE_CHARS, this.textFirstCap);
    if (this.textMode === "activity") {
      if (chunks.length === 1) {
        this.blocks.push(chunks[0]);
        this.collapseBlocks();
        await this.syncActivity(this.renderBlocks());
        this.resetTextState();
        return { messageIds: [], text };
      }
      // The final text outgrew the message (the overflow appeared with the
      // final settle, not during the stream): strip the tail out and settle
      // the text in its own message(s).
      if (this.activityMessage !== null) await this.syncActivity(this.renderBlocks());
    }
    const landed = await this.settleSlices(chunks);
    if (this.activityMessage !== null) this.activityStale = true;
    this.resetTextState();
    return this.reported(landed, landed.length === chunks.length ? text : undefined);
  }

  private resetTextState(): void {
    this.textMode = "none";
    this.textFirstCap = DISCORD_MAX_MESSAGE_CHARS;
    this.textSlices = [];
  }

  /**
   * Settle the in-progress live messages into the final post: live message
   * i is edited to final chunk i (the preview already used the same
   * splitter, so this is normally a no-op or a small trim), and any chunks
   * beyond the live messages are posted fresh. Returns the messages in
   * send order; a live message with no chunk left (defensive) is deleted.
   */
  private async settleSlices(chunks: string[]): Promise<Message[]> {
    const posted: Message[] = [];
    const n = Math.max(this.textSlices.length, chunks.length);
    for (let i = 0; i < n; i++) {
      const live = this.textSlices[i];
      if (i < chunks.length) {
        try {
          posted.push(live ? await this.postInto(live, chunks[i]) : await this.opts.channel.send({ content: chunks[i], allowedMentions: SAFE_MENTIONS }));
        } catch (err) {
          // Best effort: one failed chunk (rate limit, API hiccup) must not
          // strand the rest — the remaining chunks are still posted, and a
          // live message that failed to settle keeps its last preview.
          log.warn(`final post: slice ${i + 1}/${chunks.length} failed: ${errMsg(err)}`);
        }
      } else if (live) {
        await live.delete().catch(() => {});
      }
    }
    this.textSlices = [];
    return posted;
  }

  /** Delete any in-progress live messages (best-effort, normally none exist). */
  private async clearTextSlices(): Promise<void> {
    const targets = this.textSlices;
    this.textSlices = [];
    for (const m of targets) await m.delete().catch(() => {});
  }

  private async postInto(target: Message | null, content: string): Promise<Message> {
    return target
      ? await target.edit({ content, allowedMentions: SAFE_MENTIONS })
      : await this.opts.channel.send({ content, allowedMentions: SAFE_MENTIONS });
  }

  /**
   * The thinking message's terminal line: the first line of the reasoning
   * (truncated after ACTIVITY_CONTENT_MAX, with a "..." when it was
   * cut) plus how long the model thought — e.g.
   * "🤔 *Let me check the units first... (12s)*". Falls back to a plain
   * "thought for Ns" when there is no first line to show.
   */
  private thinkingDoneLine(): string {
    const startedAt = this.reasoningStartedAt;
    if (startedAt === null) return "🤔 *thought…*";
    const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    // The first line is model text (like the live preview, run it through the
    // sanitizer so stray math becomes Unicode rather than raw $…$ source).
    // Asterisks are dropped too: the line is wrapped in italics, and a `*`
    // from the model (a markdown bullet or bold) would break the wrapping
    // and show as literal asterisks (the tool activity lines do the same).
    const line = sanitizeForDiscord(this.reasoningFirstLine).replace(/\*/g, "").trim();
    if (line.length === 0) return `🤔 *thought for ${secs}s*`;
    const truncated = this.reasoningFirstLineLength > ACTIVITY_CONTENT_MAX;
    return `🤔 *${line}${truncated ? "..." : ""} (${secs}s)*`;
  }

  /**
   * Reasoning preview, capped at `max` chars (the room the preview has in
   * the activity message): the whole thinking while it fits inline
   * ("🤔 *thinking: …*", only while the buffer is complete); otherwise a
   * header + a "*N lines hidden*" line + the last REASONING_TAIL_LINES
   * lines of the thinking (cut from the front with a "…" when even those
   * don't fit; a thinking without newlines falls back to the plain
   * character tail). The hidden count spans the whole thinking, not just
   * the kept tail. `*` is dropped from the displayed text — the preview is
   * wrapped in italics and a `*` from the model would break the markdown.
   */
  private reasoningPreview(max: number): string {
    const text = sanitizeForDiscord(this.reasoningBuffer).replace(/\*/g, "").trim();
    if (text.length === 0) {
      return "🤔 *thinking…*";
    }
    const prefix = "🤔 *thinking: ";
    if (!this.reasoningCapped && text.length <= max - prefix.length - 1 /* closing * */) {
      return prefix + text + "*";
    }
    const lines = text.split("\n");
    let preview: string;
    if (lines.length > REASONING_TAIL_LINES) {
      const header = "🤔 *thinking: …*";
      const hidden = Math.max(this.reasoningTotalLines(), lines.length) - REASONING_TAIL_LINES;
      const hiddenLine = `*${hidden} line${hidden === 1 ? "" : "s"} hidden*`;
      const tail = lines.slice(-REASONING_TAIL_LINES).join("\n");
      const bodyBudget = max - header.length - hiddenLine.length - 2 /* newlines */;
      const body = tail.length > bodyBudget && bodyBudget > 1 ? "…" + tail.slice(tail.length - (bodyBudget - 1)) : tail.slice(0, Math.max(bodyBudget, 0));
      preview = header + "\n" + hiddenLine + "\n" + body;
    } else {
      const budget = max - prefix.length - 1 /* closing * */ - 1 /* leading … */;
      preview = prefix + "…" + text.slice(text.length - budget) + "*";
    }
    // A tight budget (the settled lines nearly fill the message) can make
    // the tail logic overflow: fall back to the plain indicator.
    return preview.length <= max ? preview : "🤔 *thinking…*".slice(0, Math.max(max, 0));
  }

  /** The total lines of the reasoning so far (the buffer may hold only the tail). */
  private reasoningTotalLines(): number {
    if (this.reasoningBuffer.length === 0) return 0;
    return this.reasoningNewlines + (this.reasoningEndedNewline ? 0 : 1);
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }
}
