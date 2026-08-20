import { Client, GatewayIntentBits } from "discord.js";

/**
 * discord.js v14 client with the intents we need.
 *
 * ⚠ GuildMessages + MessageContent are fine, but **MessageContent is a
 * privileged intent**: it must be enabled in the Developer Portal
 * (your app -> Bot -> Privileged Gateway Intents -> MESSAGE CONTENT INTENT),
 * otherwise every message arrives with empty content and the bot can do
 * nothing. Guilds intent keeps us able to see the guild the bot belongs to.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}
