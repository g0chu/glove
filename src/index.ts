import type { GuildTextBasedChannel } from "discord.js";
import { createDiscordClient } from "./bot/client.js";
import { buildChannelContext } from "./bot/context.js";
import { CLEAR_CONFIRMATION, isClearCommand, isMentionOf, isTrackable, stripMention } from "./bot/router.js";
import { QueueStore } from "./bot/queue.js";
import { ResponseWriter, SAFE_MENTIONS } from "./bot/writer.js";
import { LlmClient } from "./llm/client.js";
import { ChannelContextStore, type ChannelContext } from "./llm/context.js";
import { ConversationStore, type ChannelHistory } from "./llm/history.js";
import { loadConfig } from "./config.js";
import { errMsg, log } from "./log.js";
import { formatToolCall } from "./tools/activity.js";
import { TOOLS_SYSTEM_NOTE, buildTools } from "./tools/index.js";
import { runToolTurn } from "./tools/loop.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  // Classic mode: the per-channel sliding window. Compaction mode: the
  // persistent per-channel context (seeded once, growing, compacted).
  const compaction = cfg.model.compactionEnabled;
  log.info(
    "config loaded:",
    `guild=${cfg.discord.guildId}`,
    `model=${cfg.model.name}`,
    `endpoint=${cfg.model.apiUrl}`,
    `stream=${cfg.model.stream}`,
    `images=${cfg.model.enableImages}`,
    `window=${cfg.model.contextMaxMessages}`,
    compaction
      ? `compaction=on (budget ~${cfg.model.compactionMaxTokens} est. tokens, keep ${cfg.model.compactionKeepMessages})`
      : "compaction=off (classic sliding window)",
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
  const contexts = new ChannelContextStore();
  const tools = buildTools(cfg);
  if (tools.registry.size > 0) {
    log.info(
      "tools enabled:",
      tools.registry.specs().map((s) => s.name).join(", "),
      `(max ${cfg.tools.maxRounds} round(s)/turn)`,
    );
  }

  /**
   * One full turn for a queued mention. In compaction mode the model's
   * context is the channel's persistent context (seeded once with the
   * channel's last N messages, grown by every arrival, compacted when it
   * fills the token budget); in classic mode it is built from the channel's
   * last N Discord messages, fetched live each turn. The mention itself is
   * part of the context, so edits that happened while the turn was queued
   * are picked up automatically.
   */
  const runTurn = async (channelId: string, mentionId: string): Promise<void> => {
    const context = contexts.get(channelId);
    const history = histories.get(channelId);
    if (compaction ? !context.has(mentionId) : !history.has(mentionId)) {
      // Deleted before its turn ran.
      log.info(`mention ${mentionId} in ${channelId} left the channel context; skipping turn`);
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
    const textChannel = channel;

    const writer = new ResponseWriter({
      channel,
      typingIntervalMs: cfg.discord.typingIntervalMs,
      throttleMs: cfg.discord.streamUpdateThrottleMs,
    });
    try {
      // Build the context before the typing indicator starts: it is a
      // channel fetch (+ image downloads, + one summarization call when the
      // context compacts), not the reply generation itself.
      const botId = client.user?.id;
      if (!botId) {
        log.error(`turn in ${channelId}: bot user not available; skipping turn`);
        return;
      }
      // With tools enabled, the model may answer in several rounds: a round
      // that ends in tool calls streams transient text (discarded via
      // onToolRound), the tools run, and the next round continues with the
      // results in context. Only the final reply is posted and recorded.
      // The user's MODEL_SYSTEM_PROMPT (when set) comes first; the tools
      // note is added when tools are registered.
      const hasTools = tools.registry.size > 0;
      const systemPrompt = [cfg.model.systemPrompt, hasTools ? TOOLS_SYSTEM_NOTE : null]
        .filter((p): p is string => p !== null && p.trim().length > 0)
        .join("\n\n");
      const messages = await buildChannelContext(textChannel, context, history, mentionId, {
        botId,
        systemPrompt,
        maxMessages: cfg.model.contextMaxMessages,
        enableImages: cfg.model.enableImages,
        imagesMaxBytes: cfg.model.imagesMaxBytes,
        compaction: compaction
          ? {
              maxTokens: cfg.model.compactionMaxTokens,
              keepMessages: cfg.model.compactionKeepMessages,
              // The summarizer is the same endpoint as the replies: one
              // plain (tool-less) chat call over the old transcript.
              summarize: async (msgs) => (await llm.chat(msgs)).content,
            }
          : undefined,
        // Classic mode only: the live fetch must not resurrect the messages
        // the user cleared (!clear boundary).
        resetAfter: compaction ? undefined : histories.getResetAfter(channelId),
      });
      if (messages === null) {
        // Deleted while queued.
        log.info(`mention ${mentionId} in ${channelId} left the channel context; skipping turn`);
        return;
      }
      writer.start();
      const outcome = await runToolTurn(messages, {
        chat: (msgs, _cbs, t) =>
          llm.chat(
            msgs,
            {
              onDelta: (d) => writer.chunk(d),
              onReasoning: cfg.discord.showReasoning ? (d) => writer.reason(d) : undefined,
            },
            t,
          ),
        registry: tools.registry,
        maxRounds: cfg.tools.maxRounds,
        onToolRound: () => writer.discard(),
        onToolCalls: async (calls) => {
          if (!cfg.discord.showToolActivity) return;
          // One persistent message per call. Bot messages never enter the
          // channel history (isTrackable), so the model's context is
          // untouched — the results, which stay internal, are what matter.
          for (const call of calls) {
            try {
              // The activity line shows tool args, which may carry a stray
              // mention: suppress everyone/role pings (see SAFE_MENTIONS).
              await textChannel.send({ content: formatToolCall(call), allowedMentions: SAFE_MENTIONS });
            } catch (err) {
              log.warn(`failed to post tool activity: ${errMsg(err)}`);
            }
          }
        },
      });
      if (outcome.toolRounds > 0) {
        log.info(`turn in ${channelId} used ${outcome.toolRounds} tool round(s)`);
      }
      const finalText =
        outcome.exhausted && outcome.content.trim() === ""
          ? "*(stopped: the model kept requesting tools past the round limit)*"
          : outcome.content;
      const posted = await writer.finish(finalText);
      if (posted) recordReply(channelId, posted);
    } catch (err) {
      log.error(`turn failed in channel ${channelId}: ${errMsg(err)}`);
      const posted = await writer.reportError(err);
      if (posted) recordReply(channelId, posted);
    }
  };

  /** Record the bot's posted reply in the channel's conversation store. */
  const recordReply = (channelId: string, posted: { text: string; messageIds: string[]; chunks?: string[] }): void => {
    if (compaction) contexts.get(channelId).pushAssistant(posted.text, posted.messageIds, posted.chunks);
    else histories.get(channelId).push("assistant", posted.text, posted.messageIds, posted.chunks);
  };

  /** The conversation store that tracks a channel (one is active per mode). */
  const conversationFor = (channelId: string): ChannelHistory | ChannelContext | null => {
    if (compaction) return contexts.has(channelId) ? contexts.get(channelId) : null;
    return histories.has(channelId) ? histories.get(channelId) : null;
  };

  const queues = new QueueStore({ runTurn });

  client.once("clientReady", () => {
    log.info(`connected as ${client.user?.tag} (id ${client.user?.id})`);
    log.info(`responding to @mentions in guild ${cfg.discord.guildId}`);
    if (cfg.model.enableImages) {
      log.info(
        `image input enabled (png/jpeg/webp/gif, max ${cfg.model.imagesMaxBytes} bytes per image)`,
      );
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
    // `!clear` resets the channel's model context for a fresh chat: the
    // command is neither tracked nor answered (a bot mention alongside it is
    // swallowed too). Mentions queued before the clear are dropped with the
    // context: their mention is no longer in it (compaction) or sits before
    // the boundary (classic), so their turns are skipped.
    if (isClearCommand(message.content, botId)) {
      if (compaction) {
        // Drop entries + summary and suppress the startup seed: the next
        // turn starts from messages that arrive after the clear, not from
        // the channel's last-N.
        contexts.get(message.channelId).reset();
      } else {
        // The live fetch is the source of truth in classic mode, so the
        // clear is a boundary: only messages after the command's own id
        // enter the context. The in-memory window is cleared too (fallback
        // and recorded replies stay fresh).
        histories.markCleared(message.channelId, message.id);
      }
      log.info(`channel ${message.channelId}: conversation reset by ${message.author.username}`);
      const channel = message.channel;
      if (channel && channel.isTextBased()) {
        channel.send({ content: CLEAR_CONFIRMATION, allowedMentions: SAFE_MENTIONS }).catch((err) => {
          log.warn(`failed to post the clear confirmation: ${errMsg(err)}`);
        });
      }
      return;
    }
    // The display name (guild nickname when set, else the global username)
    // labels this message in the context; the attachment metadata is what
    // the image parts are downloaded from at turn time.
    const name = message.member?.displayName ?? message.author.username;
    if (compaction) {
      contexts.get(message.channelId).pushUser(
        name,
        stripMention(message, botId),
        message.id,
        message.createdTimestamp,
        [...message.attachments.values()].map((a) => ({
          url: a.url,
          name: a.name,
          size: a.size,
          contentType: a.contentType ?? null,
        })),
      );
    } else {
      histories.get(message.channelId).push("user", stripMention(message, botId), [message.id], undefined, name);
    }
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
    if (!channelId) return;
    const conv = conversationFor(channelId);
    if (!conv) return; // the channel has no context yet
    const entry = conv.find(message.id);
    if (!entry) return; // not in this channel's context
    const newContent = stripMention(message, botId);
    if (entry.ids.length === 1) {
      if (newContent !== entry.content) conv.updateContent(message.id, newContent);
    } else if (entry.chunks) {
      const i = entry.ids.indexOf(message.id);
      if (i !== -1 && entry.chunks[i] !== newContent) {
        conv.updateChunk(message.id, newContent);
      }
    }
  });

  // Deletions: drop the entry, wherever it is in the context. (A delete of
  // any chunk of a chunked reply drops the whole reply.)
  client.on("messageDelete", (message) => {
    const channelId = message.channel?.id;
    if (!channelId) return;
    conversationFor(channelId)?.removeById(message.id);
  });

  client.on("messageDeleteBulk", (messages, channel) => {
    const conv = conversationFor(channel.id);
    if (!conv) return;
    for (const m of messages.values()) {
      conv.removeById(m.id);
    }
  });

  // A deleted channel's context is gone; forget it.
  client.on("channelDelete", (channel) => {
    histories.clear(channel.id);
    contexts.clear(channel.id);
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
