import type { GuildTextBasedChannel, Message } from "discord.js";
import { DISCORD_MAX_MESSAGE_CHARS, SAFE_MENTIONS } from "../bot/writer.js";
import { sanitizeForDiscord, truncateActivityContent } from "../bot/format.js";
import { errMsg, log } from "../log.js";
import type { ToolCall } from "../llm/client.js";
import { parseToolArgs } from "./executor.js";

/** One line's icon, by tool family. */
function iconFor(name: string): string {
  if (name.startsWith("web_")) return "🔎";
  if (name.startsWith("file_")) return "📁";
  if (name.startsWith("wikipedia_")) return "📚";
  if (name.startsWith("shell_")) return "🐚";
  return "🔧";
}

/**
 * Render one argument value for display: strings are quoted, everything
 * else JSON-ified; whitespace is collapsed (one line per call) and long
 * values are truncated. Asterisks are dropped — the whole line is wrapped
 * in italics and a `*` from the model would break the markdown.
 */
function argValue(v: unknown): string {
  let s: string;
  if (typeof v === "string") {
    s = v.replace(/\s+/g, " ").trim();
  } else {
    s = JSON.stringify(v) ?? String(v);
  }
  s = s.replace(/\*/g, "");
  s = truncateActivityContent(s);
  return typeof v === "string" ? `"${s}"` : s;
}

/**
 * Format one tool call as a short activity line for Discord — what the bot
 * is doing, not what it found (the results are deliberately never shown).
 * Up to two arguments are shown; the line is sanitized (model-supplied args
 * may contain math markup) and wrapped in italics.
 */
export function formatToolCall(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = parseToolArgs(call.arguments);
  } catch {
    // Unparseable args: show the name only (the call will fail and the
    // model sees the error as a tool result).
  }
  const names = Object.keys(args);
  let detail = "";
  if (names.length > 0) {
    const shown = names.slice(0, 2).map((k) => `${k}=${argValue(args[k])}`);
    detail = `(${shown.join(", ")}${names.length > 2 ? ", …" : ""})`;
  }
  return sanitizeForDiscord(`${iconFor(call.name)} *${call.name}${detail}*`);
}

/**
 * The turn's whole tool activity in a single Discord message: the first
 * round posts it, every later round edits it in place — one new message
 * per turn (one edit per round), no matter how many calls run (the channel
 * stays quiet). The message stays in the channel when the turn ends as the
 * record of which tools ran. Lines are appended in call order; when the
 * message would outgrow Discord's 2000-char limit the oldest lines are
 * dropped behind a "… N earlier calls …" header (which keeps a leading
 * icon, so the message stays a UI line that never enters the model
 * context).
 */
export class ToolActivityPoster {
  private readonly channel: GuildTextBasedChannel;
  private lines: string[] = [];
  private dropped = 0;
  private message: Message | null = null;

  constructor(channel: GuildTextBasedChannel) {
    this.channel = channel;
  }

  /**
   * Record one round's tool calls (they all arrive at once, so they cost
   * one Discord operation): post the shared activity message when there is
   * none yet, edit it in place otherwise — the lines accumulate across the
   * turn. The args may carry a stray mention, so pings are suppressed (see
   * SAFE_MENTIONS). A failed post is retried by the next round (the retry
   * carries every line so far); a failed edit keeps the last good content.
   */
  async addCalls(calls: ToolCall[]): Promise<void> {
    if (calls.length === 0) return;
    for (const call of calls) this.lines.push(formatToolCall(call));
    while (this.lines.length > 1 && this.render().length > DISCORD_MAX_MESSAGE_CHARS) {
      this.dropped += 1;
      this.lines.shift();
    }
    const content = this.render();
    try {
      if (this.message) {
        await this.message.edit({ content, allowedMentions: SAFE_MENTIONS });
      } else {
        this.message = await this.channel.send({ content, allowedMentions: SAFE_MENTIONS });
      }
    } catch (err) {
      log.warn(`failed to post tool activity: ${errMsg(err)}`);
    }
  }

  /** The kept lines, the dropped ones summarized in the header. */
  private render(): string {
    if (this.dropped > 0) {
      const header = `🔧 *… ${this.dropped} earlier call${this.dropped === 1 ? "" : "s"} …*`;
      return [header, ...this.lines].join("\n");
    }
    return this.lines.join("\n");
  }
}
