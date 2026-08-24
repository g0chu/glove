import { ChannelType, type Message } from "discord.js";

/**
 * A message is *trackable* when it is worth considering at all: it is in a
 * text channel of the target guild and was written by a human.
 *
 * Trackable messages come in two flavors:
 *  - mentions of the bot  -> start a turn (see queue.ts)
 *  - everything else      -> ambient context, buffered until a mention
 *                            rides along with them (PLAN.md §4)
 */
export function isTrackable(message: Message, botId: string, guildId: string): boolean {
  if (message.author.bot) return false; // bots (incl. ourselves) are never tracked
  const guild = message.guild;
  if (!guild || guild.id !== guildId) return false; // ignore other guilds / DMs
  if (message.channel.type !== ChannelType.GuildText) return false; // text channels only
  return true;
}

/**
 * True when the message mentions the bot. Replies to a bot message count as
 * a mention (discord.js default), which is the natural "talk back" UX.
 */
export function isMentionOf(message: Message, botId: string): boolean {
  return message.mentions.has(botId);
}

/**
 * The text to forward to the model: the message content with every mention
 * of the bot stripped out (`<@id>` / `<@!id>`).
 */
export function stripMention(message: Message, botId: string): string {
  return stripMentionText(message.content, botId);
}

/** The stripMention transform on a bare content string (fetched messages, tests). */
export function stripMentionText(text: string, botId: string): string {
  return text.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/** The clear-history command: resets the channel's model context for a fresh chat. */
export const CLEAR_COMMAND = "!clear";

/** The confirmation line posted when a channel's context is cleared (a UI line, never context). */
export const CLEAR_CONFIRMATION = "🧹 *cleared the channel's conversation history*";

/**
 * True when the message is the clear-history command: the content, with
 * every bot mention stripped, is exactly `!clear` (trimmed, case-
 * insensitive). The command is neither tracked nor answered.
 */
export function isClearCommand(content: string, botId: string): boolean {
  return stripMentionText(content, botId).trim().toLowerCase() === CLEAR_COMMAND;
}
