import { ChannelType, type Message } from "discord.js";

/**
 * A message is *trackable* when it is worth considering at all: it is in a
 * text channel of the target guild(s) and was written by a human or another
 * bot (our own messages are never tracked — they are posted by the writer
 * and recorded explicitly). An empty `guildId` means every guild the bot is
 * a member of. Other bots are labeled "(bot)" in the context (see
 * speakerLabel) so the model can tell them apart from humans.
 *
 * Trackable messages come in two flavors:
 *  - mentions of the bot  -> start a turn (see queue.ts) — from humans and
 *                            other bots alike
 *  - everything else      -> ambient context, buffered until a mention
 *                            rides along with them (PLAN.md §4); with chime
 *                            enabled it also queues a chime turn the model
 *                            may decline (see queue.ts)
 */
export function isTrackable(message: Message, botId: string, guildId: string): boolean {
  if (message.author.id === botId) return false; // our own messages are never tracked
  const guild = message.guild;
  if (!guild) return false; // ignore DMs
  if (guildId !== "" && guild.id !== guildId) return false; // ignore other guilds
  if (message.channel.type !== ChannelType.GuildText) return false; // text channels only
  return true;
}

/**
 * True when the message mentions the bot. Replies to a bot message count as
 * a mention (discord.js default), which is the natural "talk back" UX. Works
 * for any author — a mention from another bot queues a turn like one from a
 * human.
 */
export function isMentionOf(message: Message, botId: string): boolean {
  return message.mentions.has(botId);
}

/**
 * The text to forward to the model: the message content with every mention
 * of the bot (`<@id>` / `<@!id>`) replaced by the bot's Discord name
 * (`@Name` — the form Discord renders a mention in). A mention stripped to
 * nothing would be invisible to the model: it could not tell it was
 * mentioned, only see the rest of the message.
 */
export function replaceMention(message: Message, botId: string, botName: string): string {
  return replaceMentionText(message.content, botId, botName);
}

/** The replaceMention transform on a bare content string (fetched messages, tests). */
export function replaceMentionText(text: string, botId: string, botName: string): string {
  return text.replace(new RegExp(`<@!?${botId}>`, "g"), `@${botName}`).trim();
}

/**
 * Strip every bot mention from a bare content string (replacing it with
 * nothing): used only by the clear-command detection, where `<@bot> !clear`
 * must still read as the bare command.
 */
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
