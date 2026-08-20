import type { GuildTextBasedChannel } from "discord.js";
import { createDiscordClient } from "./bot/client.js";
import { isMentionOf, isTrackable, stripMention } from "./bot/router.js";
import { QueueStore } from "./bot/queue.js";
import { ResponseWriter } from "./bot/writer.js";
import { LlmClient } from "./llm/client.js";
import { ConversationStore, toRequestMessages } from "./llm/history.js";
import { loadConfig } from "./config.js";
import { errMsg, log } from "./log.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info(
    "config loaded:",
    `guild=${cfg.discord.guildId}`,
    `model=${cfg.model.name}`,
    `endpoint=${cfg.model.apiUrl}`,
    `stream=${cfg.model.stream}`,
    `window=${cfg.model.contextMaxMessages}`,
  );

  const client = createDiscordClient();
  const llm = new LlmClient({
    apiUrl: cfg.model.apiUrl,
    apiKey: cfg.model.apiKey,
    model: cfg.model.name,
    stream: cfg.model.stream,
    timeoutMs: cfg.model.timeoutMs,
  });
  const histories = new ConversationStore(cfg.model.contextMaxMessages);

  /** One full turn: user message -> model -> streamed/chunked reply. */
  const runTurn = async (channelId: string, content: string): Promise<void> => {
    const history = histories.get(channelId);
    history.push("user", content);

    // Resolve the channel (it is cached because a message just came from it).
    let channel: GuildTextBasedChannel | null = null;
    const cached = client.channels.cache.get(channelId) as GuildTextBasedChannel | null | undefined;
    if (cached && cached.isTextBased()) {
      channel = cached;
    } else {
      try {
        const fetched = (await client.channels.fetch(channelId)) as GuildTextBasedChannel;
        if (fetched.isTextBased()) channel = fetched;
      } catch {
        /* channel vanished */
      }
    }
    if (!channel) {
      log.error(`channel ${channelId} not found or not text-based; skipping turn`);
      return;
    }

    const writer = new ResponseWriter({
      channel,
      typingIntervalMs: cfg.discord.typingIntervalMs,
      throttleMs: cfg.discord.streamUpdateThrottleMs,
    });
    try {
      writer.start();
      const messages = toRequestMessages(history, cfg.model.systemPrompt);
      const reply = await llm.chat(messages, (delta) => {
        writer.chunk(delta);
      });
      await writer.finish(reply);
      if (reply.trim().length > 0) {
        history.push("assistant", reply.trim());
      }
    } catch (err) {
      log.error(`turn failed in channel ${channelId}: ${errMsg(err)}`);
      await writer.reportError(err);
    }
  };

  const queues = new QueueStore({
    onAmbient: (channelId, content) => {
      // Ambient messages ride along as user turns, in order (PLAN.md §4).
      histories.get(channelId).push("user", content);
    },
    runTurn,
  });

  client.once("clientReady", () => {
    log.info(`connected as ${client.user?.tag} (id ${client.user?.id})`);
    log.info(`responding to @mentions in guild ${cfg.discord.guildId}`);
    if (cfg.model.enableImages) {
      log.warn("MODEL_ENABLE_IMAGES=true but image input is not implemented in v1; ignoring attachments");
    }
  });

  client.on("messageCreate", (message) => {
    const botId = client.user?.id;
    if (!botId) return;
    if (!isTrackable(message, botId, cfg.discord.guildId)) return;
    const isMention = isMentionOf(message, botId);
    const content = stripMention(message, botId);
    queues.get(message.channelId).push({ content, isMention });
  });

  // Lifecycle: cancel in-flight generation, destroy the client, exit cleanly.
  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down`);
    llm.abort();
    client.destroy();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await client.login(cfg.discord.token);
}

process.on("unhandledRejection", (reason) => {
  log.error("unhandled promise rejection:", reason);
});

main().catch((err) => {
  log.error("fatal:", errMsg(err));
  process.exit(1);
});
