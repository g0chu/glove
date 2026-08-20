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
  return message.content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .trim();
}
