import type { GuildTextBasedChannel } from "discord.js";
import { createDiscordClient } from "./bot/client.js";
import { isMentionOf, isTrackable, stripMention } from "./bot/router.js";
import { QueueStore } from "./bot/queue.js";
import { DISCORD_FORMAT_NOTE } from "./bot/format.js";
import { ResponseWriter } from "./bot/writer.js";
import { LlmClient } from "./llm/client.js";
import { ConversationStore, toRequestMessages } from "./llm/history.js";
import { loadConfig } from "./config.js";
import { errMsg, log } from "./log.js";
import { TOOLS_SYSTEM_NOTE, buildTools } from "./tools/index.js";
import { runToolTurn } from "./tools/loop.js";

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
  const tools = buildTools(cfg);
  if (tools.registry.size > 0) {
    log.info(
      "tools enabled:",
      tools.registry.specs().map((s) => s.name).join(", "),
      `(max ${cfg.tools.maxRounds} round(s)/turn)`,
    );
  }

  /**
   * One full turn for a queued mention. The mention is already in the
   * channel history (every trackable message is appended on arrival); the
   * request is built from the *current* snapshot, so edits that happened
   * while the turn was queued are picked up.
   */
  const runTurn = async (channelId: string, mentionId: string): Promise<void> => {
    const history = histories.get(channelId);
    if (!history.has(mentionId)) {
      // Deleted (or evicted out of the context window) before its turn ran.
      log.info(`mention ${mentionId} in ${channelId} left the context window; skipping turn`);
      return;
    }

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
      // With tools enabled, the model may answer in several rounds: a round
      // that ends in tool calls streams transient text (discarded via
      // onToolRound), the tools run, and the next round continues with the
      // results in context. Only the final reply is posted and recorded.
      // The user's MODEL_SYSTEM_PROMPT (when set) comes first; the tools
      // note is added when tools are registered; the Discord formatting
      // note is always added (the output destination dictates it).
      const hasTools = tools.registry.size > 0;
      const systemPrompt = [cfg.model.systemPrompt, hasTools ? TOOLS_SYSTEM_NOTE : null, DISCORD_FORMAT_NOTE]
        .filter((p): p is string => p !== null && p.trim().length > 0)
        .join("\n\n");
      const messages = toRequestMessages(history, systemPrompt);
      const outcome = await runToolTurn(messages, {
        chat: (msgs, _onDelta, t) => llm.chat(msgs, (d) => writer.chunk(d), t),
        registry: tools.registry,
        maxRounds: cfg.tools.maxRounds,
        onToolRound: () => writer.discard(),
      });
      if (outcome.toolRounds > 0) {
        log.info(`turn in ${channelId} used ${outcome.toolRounds} tool round(s)`);
      }
      const finalText =
        outcome.exhausted && outcome.content.trim() === ""
          ? "*(stopped: the model kept requesting tools past the round limit)*"
          : outcome.content;
      const posted = await writer.finish(finalText);
      if (posted) history.push("assistant", posted.text, posted.messageIds, posted.chunks);
    } catch (err) {
      log.error(`turn failed in channel ${channelId}: ${errMsg(err)}`);
      const posted = await writer.reportError(err);
      if (posted) history.push("assistant", posted.text, posted.messageIds, posted.chunks);
    }
  };

  const queues = new QueueStore({ runTurn });

  client.once("clientReady", () => {
    log.info(`connected as ${client.user?.tag} (id ${client.user?.id})`);
    log.info(`responding to @mentions in guild ${cfg.discord.guildId}`);
    if (cfg.model.enableImages) {
      log.warn("MODEL_ENABLE_IMAGES=true but image input is not implemented in v1; ignoring attachments");
    }
  });

  // Every trackable message enters the channel's context immediately, keyed
  // by its Discord id so edits/deletes can be reflected (handlers below).
  // Only mentions additionally queue a turn; ambient messages never trigger
  // one on their own.
  client.on("messageCreate", (message) => {
    const botId = client.user?.id;
    if (!botId) return;
    if (!isTrackable(message, botId, cfg.discord.guildId)) return;
    histories.get(message.channelId).push("user", stripMention(message, botId), [message.id]);
    if (isMentionOf(message, botId)) {
      queues.get(message.channelId).push(message.id);
    }
  });

  // Edits: keep the context in sync. Single-message entries (a human
  // message, or a short bot reply) take the new content as-is; chunked bot
  // replies rebuild their visible text from the stored chunks. The bot's own
  // final post of a chunk matches the stored chunk, so it is a no-op — only
  // real edits (by anyone) change anything. Note: an edit that *adds* a
  // mention does not queue a turn; only fresh messages do.
  client.on("messageUpdate", (_oldMessage, message) => {
    const botId = client.user?.id;
    if (!botId) return;
    const channelId = message.channel?.id;
    if (!channelId || !histories.has(channelId)) return;
    const history = histories.get(channelId);
    const entry = history.find(message.id);
    if (!entry) return; // not in this channel's context window
    const newContent = stripMention(message, botId);
    if (entry.ids.length === 1) {
      if (newContent !== entry.content) history.updateContent(message.id, newContent);
    } else if (entry.chunks) {
      const i = entry.ids.indexOf(message.id);
      if (i !== -1 && entry.chunks[i] !== newContent) {
        history.updateChunk(message.id, newContent);
      }
    }
  });

  // Deletions: drop the entry, wherever it is in the window. (A delete of
  // any chunk of a chunked reply drops the whole reply.)
  client.on("messageDelete", (message) => {
    const channelId = message.channel?.id;
    if (!channelId || !histories.has(channelId)) return;
    histories.get(channelId).removeById(message.id);
  });

  client.on("messageDeleteBulk", (messages, channel) => {
    if (!histories.has(channel.id)) return;
    for (const m of messages.values()) {
      histories.get(channel.id).removeById(m.id);
    }
  });

  // A deleted channel's history is gone; forget it.
  client.on("channelDelete", (channel) => {
    histories.clear(channel.id);
  });

  // Lifecycle: cancel in-flight generation, destroy the client, exit cleanly.
  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down`);
    llm.abort();
    for (const c of tools.clients) c.abort();
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
