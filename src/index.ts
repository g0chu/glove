import type { GuildTextBasedChannel } from "discord.js";
import { createDiscordClient } from "./bot/client.js";
import { buildChannelContext, type ContextOptions } from "./bot/context.js";
import { decideChime, formatChimeNo } from "./bot/chime.js";
import { MessageGate, type GateMessage } from "./bot/gate.js";
import { QueueStore, type TurnRequest } from "./bot/queue.js";
import { CLEAR_CONFIRMATION, isClearCommand, isMentionOf, isTrackable, stripMention } from "./bot/router.js";
import { ResponseWriter, SAFE_MENTIONS } from "./bot/writer.js";
import { LlmClient } from "./llm/client.js";
import {
  ChannelContextStore,
  contextWindowFromOverflowError,
  isContextOverflowError,
  type ChannelContext,
} from "./llm/context.js";
import { COMPACT_OUTPUT_RESERVE_TOKENS, LlamaMetrics, TurnTokens, deriveCompactionBudget, type ChatFn } from "./llm/metrics.js";
import { loadConfig } from "./config.js";
import { errMsg, log } from "./log.js";
import { ToolActivityPoster } from "./tools/activity.js";
import { buildTools } from "./tools/index.js";
import { runToolTurn, type ToolTurnOutcome } from "./tools/loop.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info(
    "config loaded:",
    cfg.discord.guildId !== "" ? `guild=${cfg.discord.guildId}` : "guilds=all",
    `model=${cfg.model.name}`,
    `endpoint=${cfg.model.apiUrl}`,
    `stream=${cfg.model.stream}`,
    `images=${cfg.model.enableImages}`,
    `files=${cfg.model.enableFileContents}`,
    `window=${cfg.model.contextMaxMessages}`,
    `compaction=on (budget ${cfg.model.compactionAuto ? `auto, fallback ${cfg.model.compactionMaxTokens}` : cfg.model.compactionMaxTokens} tokens, keep ${cfg.model.compactionKeepMessages})`,
    `metrics=${cfg.model.metricsEnabled ? cfg.model.metricsUrl : "off"}`,
    `stable=${cfg.discord.messageStableMs}ms`,
    `chime=${cfg.discord.chimeEnabled ? "on" : "off"}`,
  );

  const client = createDiscordClient();
  const llm = new LlmClient({
    apiUrl: cfg.model.apiUrl,
    apiKey: cfg.model.apiKey,
    model: cfg.model.name,
    stream: cfg.model.stream,
    timeoutMs: cfg.model.timeoutMs,
  });
  const contexts = new ChannelContextStore();
  // The llama-server's own metric endpoint (GET /slots): the model side's
  // ground truth for its context window and current use. Best-effort —
  // every probe failure resolves to null and never touches a turn.
  const metrics = cfg.model.metricsEnabled
    ? new LlamaMetrics({ baseUrl: cfg.model.metricsUrl, timeoutMs: cfg.model.metricsTimeoutMs })
    : null;
  // The effective compaction budget: the configured value, or — when
  // CONTEXT_COMPACTION_MAX_TOKENS is empty (compactionAuto) — derived from
  // the llama-server's context window once a probe succeeds (window minus
  // the completion headroom). The configured value stays the fallback until
  // the derivation happens; a too-small window gives up after one warning.
  let compactionBudget = cfg.model.compactionMaxTokens;
  let compactionBudgetDerived = false;
  let compactionBudgetExhausted = false;
  const setAutoCompactionBudget = (ctxSize: number): void => {
    if (!cfg.model.compactionAuto || compactionBudgetDerived || compactionBudgetExhausted) return;
    const b = deriveCompactionBudget(ctxSize);
    if (b === null) {
      compactionBudgetExhausted = true;
      log.warn(
        `cannot derive the compaction budget from a context window of ${ctxSize} tokens (window minus ${COMPACT_OUTPUT_RESERVE_TOKENS} completion headroom is too small); keeping the fallback budget ${compactionBudget}`,
      );
      return;
    }
    compactionBudget = b;
    compactionBudgetDerived = true;
    log.info(
      `compaction budget set automatically: ${b} tokens (context window ${ctxSize} minus ${COMPACT_OUTPUT_RESERVE_TOKENS} completion headroom)`,
    );
  };
  const tools = buildTools(cfg);
  if (tools.registry.size > 0) {
    log.info(
      "tools enabled:",
      tools.registry.specs().map((s) => s.name).join(", "),
      `(max ${cfg.tools.maxRounds} round(s)/turn)`,
    );
  }

  /**
   * End-of-turn token bookkeeping: report the turn's usage (the endpoint's
   * own counts, accumulated by `tokens`) and refresh the channel's measured
   * context size for the next compaction check — the endpoint's count of
   * this turn's largest prompt, falling back (metrics enabled) to the
   * llama-server's own report of its last request's size (GET /slots).
   */
  const reportTurnTokens = async (channelId: string, context: ChannelContext, tokens: TurnTokens): Promise<void> => {
    const server = metrics ? await metrics.snapshot() : null;
    if (server !== null) setAutoCompactionBudget(server.ctxSize); // the automatic budget converges here if the startup probe missed the server
    if (tokens.calls === 0 && server === null) return;
    let measured: number | null = tokens.peakInput > 0 ? tokens.peakInput : null;
    if (measured === null && server !== null && server.lastRequestTokens !== null && server.lastRequestTokens > 0) {
      measured = server.lastRequestTokens;
    }
    if (measured !== null) context.setMeasuredTokens(measured);
    const pct =
      server !== null && server.ctxSize > 0 && server.lastRequestTokens !== null
        ? ` (${Math.round((server.lastRequestTokens / server.ctxSize) * 100)}%)`
        : "";
    const serverPart =
      server !== null ? `, server context ${server.lastRequestTokens ?? "?"}/${server.ctxSize} tokens${pct}` : "";
    if (tokens.calls > 0) {
      log.info(
        `turn in ${channelId}: ${tokens.input} input + ${tokens.output} output tokens over ${tokens.calls} model call(s)${serverPart}`,
      );
    } else {
      log.info(`turn in ${channelId}: no model call ran${serverPart}`);
    }
  };

  /**
   * One full turn for a queued turn request (a mention — which always
   * responds — or a chime, where the model first decides whether to respond
   * at all). The model's context is the channel's persistent context
   * (seeded once with the channel's last N messages, grown by every arrival,
   * compacted when it fills the token budget). The triggering message is
   * part of the context, so edits that happened while the turn was queued
   * are picked up automatically.
   */
  const runTurn = async (channelId: string, turn: TurnRequest): Promise<void> => {
    const context = contexts.get(channelId);
    if (!context.has(turn.id)) {
      // Deleted before its turn ran.
      log.info(`trigger ${turn.id} in ${channelId} left the channel context; skipping turn`);
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
    // All of the turn's tool calls share one activity message (the first
    // round posts it, later rounds edit it in place) instead of one new
    // message per call — the channel stays quiet even when the model runs
    // many rounds.
    const activity = new ToolActivityPoster(textChannel);
    // Every model call of the turn goes through a tracked wrapper so the
    // endpoint's reported usage (input/output per call, largest prompt) is
    // accumulated: the turn's cost is reported at the end, and the largest
    // prompt becomes the channel's measured context size for the next
    // compaction check. The reply rounds stream into the writer; the
    // compaction summarizer and the chime decision use a plain wrapper on
    // the same account (their text is never posted).
    const tokens = new TurnTokens();
    const replyChat: ChatFn = tokens.track(
      (msgs, _cbs, t) =>
        llm.chat(
          msgs,
          {
            onDelta: (d) => writer.chunk(d),
            onReasoning: cfg.discord.showReasoning ? (d) => writer.reason(d) : undefined,
          },
          t,
        ),
    );
    const plainChat: ChatFn = tokens.track((msgs, cbs, tools) => llm.chat(msgs, cbs, tools));
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
      // that ends in tool calls streams its narration (settled in place via
      // onToolRound, so it stays above the tool-activity lines), the tools
      // run, and the next round continues with the results in context. Only
      // the final reply is recorded in the channel context.
      // The user's MODEL_SYSTEM_PROMPT (when set) comes first; the tools
      // note (listing only the enabled families) is added when any are
      // registered.
      const systemPrompt = [cfg.model.systemPrompt, tools.systemNote]
        .filter((p): p is string => p !== null && p.trim().length > 0)
        .join("\n\n");
      // Shared by the first build and (after an overflow) the rebuild: same
      // window, budget, and summarizer.
      const ctxOpts: ContextOptions = {
        botId,
        systemPrompt,
        maxMessages: cfg.model.contextMaxMessages,
        enableImages: cfg.model.enableImages,
        imagesMaxBytes: cfg.model.imagesMaxBytes,
        enableFileContents: cfg.model.enableFileContents,
        fileContentsMaxBytes: cfg.model.fileContentsMaxBytes,
        maxTokens: compactionBudget,
        keepMessages: cfg.model.compactionKeepMessages,
        // The summarizer is the same endpoint as the replies: one
        // plain (tool-less) chat call over the old transcript.
        summarize: async (msgs) => (await plainChat(msgs)).content,
      };
      const messages = await buildChannelContext(textChannel, context, turn.id, ctxOpts);
      if (messages === null) {
        // Deleted while queued.
        log.info(`trigger ${turn.id} in ${channelId} left the channel context; skipping turn`);
        return;
      }
      if (turn.chime) {
        // A chime turn: the model decides whether to respond at all, by
        // calling the chime tool (respond + reason) in one small call over
        // the transcript (the reply's system prompt is not part of it; the
        // transcript ends with the triggering message). NO posts the
        // decision + reason as a one-line UI message (never tracked); null
        // (a failed or broken decision) stays silent: no typing indicator,
        // no message, nothing recorded.
        const transcript = systemPrompt.trim().length > 0 ? messages.slice(1) : messages;
        const decision = await decideChime((msgs, tools) => plainChat(msgs, undefined, tools), transcript);
        if (decision === null) {
          log.info(`channel ${channelId}: chime decision failed or was unusable for message ${turn.id}; staying silent`);
          return;
        }
        if (!decision.respond) {
          log.info(
            `channel ${channelId}: chime decision NO for message ${turn.id}: ${decision.reason || "(no reason given)"}`,
          );
          await textChannel.send({ content: formatChimeNo(decision.reason), allowedMentions: SAFE_MENTIONS }).catch((err) => {
            log.warn(`failed to post the chime decision: ${errMsg(err)}`);
          });
          return;
        }
      }
      writer.start();
      const runModel = (msgs: Parameters<typeof runToolTurn>[0]): Promise<ToolTurnOutcome> =>
        runToolTurn(msgs, {
          chat: replyChat,
          registry: tools.registry,
          maxRounds: cfg.tools.maxRounds,
          onToolRound: () => writer.discard(),
          onToolCalls: async (calls) => {
            if (!cfg.discord.showToolActivity) return;
            // Every call of the turn lands in the one shared activity message
            // (the first round posts it, later rounds edit it in place). Bot
            // messages never enter the channel context (isTrackable), so the
            // model's context is untouched — the results, which stay internal,
            // are what matter.
            await activity.addCalls(calls);
          },
        });
      let outcome: ToolTurnOutcome;
      try {
        outcome = await runModel(messages);
      } catch (err) {
        // The request did not fit the model's context: the endpoint rejected
        // it before generating. A summarizer run on the overfilled context
        // would not fit either, so the only way to make room is dropping
        // entries — shrink hard (the mention protected, the running summary
        // as a last resort), rebuild the turn, and retry once. A second
        // overflow (e.g. the mention alone is too big) falls through to the
        // error path below.
        if (!isContextOverflowError(err)) throw err;
        const window = contextWindowFromOverflowError(err);
        // The estimate must fit the smaller of the compaction budget and the
        // window minus the completion headroom — the budget alone may sit
        // at or above the window (a manual value, or the fallback before the
        // automatic budget was derived).
        const target =
          window !== null
            ? Math.min(compactionBudget, Math.max(window - COMPACT_OUTPUT_RESERVE_TOKENS, 128))
            : compactionBudget;
        context.setMeasuredTokens(null); // it described the overfilled context
        context.emergencyShrink(
          turn.id,
          target,
          systemPrompt,
          cfg.model.contextMaxMessages,
          cfg.model.enableFileContents ? cfg.model.fileContentsMaxBytes : undefined,
        );
        log.warn(
          `turn in ${channelId} overfilled the model's context (${errMsg(err)}); dropped the oldest messages to fit ~${target} tokens and retrying the turn once`,
        );
        const rebuilt = await buildChannelContext(textChannel, context, turn.id, ctxOpts);
        if (rebuilt === null) {
          log.info(`trigger ${turn.id} in ${channelId} left the channel context; skipping turn`);
          return;
        }
        outcome = await runModel(rebuilt);
      }
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
    } finally {
      await reportTurnTokens(channelId, context, tokens);
    }
  };

  /** Record the bot's posted reply in the channel's conversation store. */
  const recordReply = (channelId: string, posted: { text: string; messageIds: string[]; chunks?: string[] }): void => {
    contexts.get(channelId).pushAssistant(posted.text, posted.messageIds, posted.chunks);
  };

  /** The channel's context store, if the channel is tracked at all. */
  const conversationFor = (channelId: string): ChannelContext | null => {
    return contexts.has(channelId) ? contexts.get(channelId) : null;
  };

  const queues = new QueueStore({ runTurn });

  /**
   * Commit a stable trackable message (it has been unchanged for
   * DISCORD_MESSAGE_STABLE_MS): `!clear` resets the channel's model context
   * (only humans may issue it — other bots are tracked now, so a bot posting
   * the command is just context; the command itself is neither tracked nor
   * answered, and a bot mention alongside it is swallowed too), otherwise the
   * message enters the context (humans and other bots alike — bot authors
   * are labeled "(bot)") and, when its final content mentions the bot, queues
   * a turn. With chime enabled, any message without a mention (a human's or
   * another bot's) queues a chime turn (the model decides whether to respond;
   * a NO posts the decision + reason). The checks run on
   * the final (stable) content: an edit that adds a mention before
   * stabilization queues the turn; one that removes it does not.
   */
  const commitArrival = (message: GateMessage): void => {
    const botId = client.user?.id;
    if (!botId) return;
    const channelId = message.channel?.id;
    if (!channelId) return; // the channel vanished while the message was pending
    if (!message.author) return;
    if (!message.author.bot && isClearCommand(message.content, botId)) {
      // Drop entries + summary and suppress the startup seed: the next turn
      // starts from messages that arrive after the clear, not from the
      // channel's last-N. Mentions queued before the clear are dropped with
      // the context: their mention is no longer in it, so their turns are
      // skipped.
      contexts.get(channelId).reset();
      log.info(`channel ${channelId}: conversation reset by ${message.author.username}`);
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
    // the image parts are downloaded from at turn time. The bot flag marks
    // other bots' messages ("(bot)" label in the context).
    const name = message.member?.displayName ?? message.author.username;
    const content = stripMention(message, botId);
    const ctx = contexts.get(channelId);
    if (ctx.has(message.id)) {
      // The startup seed raced the stabilization: the message is already in
      // the context (with the content the API saw at seed time), so refresh
      // it in place instead of appending a duplicate entry.
      ctx.updateContent(message.id, content);
    } else {
      ctx.pushUser(
        name,
        content,
        message.id,
        message.createdTimestamp,
        [...message.attachments.values()].map((a) => ({
          url: a.url,
          name: a.name,
          size: a.size,
          contentType: a.contentType ?? null,
        })),
        message.author.bot,
      );
    }
    // A mention from any author (human or another bot) queues a turn that
    // always responds. With chime enabled, any other trackable message
    // (a human's or another bot's, without a mention) queues a chime turn
    // instead: the model decides whether to respond at all (NO posts the
    // decision + reason; a broken decision stays silent).
    if (isMentionOf(message, botId)) {
      queues.get(channelId).push({ id: message.id, chime: false });
    } else if (cfg.discord.chimeEnabled) {
      queues.get(channelId).push({ id: message.id, chime: true });
    }
  };

  /**
   * The stability gate: a trackable message is committed (tracked in the
   * context, able to queue a turn) only once it has been unchanged for
   * DISCORD_MESSAGE_STABLE_MS. Other bots stream their replies by posting a
   * message and editing it as the text arrives; without the window the model
   * would see (and be asked to answer) partial text. Edits while pending
   * restart the window, and the commit always carries the final state. A
   * message deleted while pending never commits (it was never tracked); a
   * channel delete forgets its pending messages.
   */
  const gate = new MessageGate({
    stableMs: cfg.discord.messageStableMs,
    onCommit: commitArrival,
  });

  client.once("clientReady", async () => {
    log.info(`connected as ${client.user?.tag} (id ${client.user?.id})`);
    log.info(
      cfg.discord.guildId !== ""
        ? `responding to @mentions in guild ${cfg.discord.guildId}`
        : "responding to @mentions in any text channel of any guild the bot is in",
    );
    if (cfg.model.enableImages) {
      log.info(
        `image input enabled (png/jpeg/webp/gif, max ${cfg.model.imagesMaxBytes} bytes per image)`,
      );
    }
    if (cfg.model.enableFileContents) {
      log.info(
        `file contents enabled (non-image attachments inlined, max ${cfg.model.fileContentsMaxBytes} bytes per file)`,
      );
    }
    // Metrics on: check the llama-server is reachable, derive the automatic
    // compaction budget from its context window, and check the budget is not
    // at or above the window (requests would overflow the model's context
    // before compaction could trigger — the overflow recovery would still
    // save the turn, but avoiding it is better).
    if (metrics) {
      const s = await metrics.snapshot();
      if (s === null) {
        log.warn(
          `metrics enabled but ${cfg.model.metricsUrl}/slots is not reachable; metrics stay off at runtime` +
            (cfg.model.compactionAuto
              ? ` — the automatic compaction budget keeps the fallback ${compactionBudget} until the server is reachable`
              : ""),
        );
      } else {
        log.info(
          `llama-server: context window ${s.ctxSize} tokens` +
            (s.lastRequestTokens !== null ? `, last request ${s.lastRequestTokens} tokens` : ""),
        );
        setAutoCompactionBudget(s.ctxSize);
        if (s.ctxSize > 0 && compactionBudget >= s.ctxSize) {
          log.warn(
            `compaction budget ${compactionBudget} is not below the server context window ${s.ctxSize}; compaction would trigger too late`,
          );
        }
      }
    } else if (cfg.model.compactionAuto) {
      log.warn(
        `the compaction budget is set automatically but metrics are disabled; keeping the fallback budget ${compactionBudget}`,
      );
    }
  });

  // Every trackable message (a human's or another bot's) starts its
  // stability window here; it is committed by the gate once it has been
  // unchanged for the window — see commitArrival. Without chime, ambient
  // messages never trigger a turn on their own; only ones whose final
  // content mentions the bot do. With chime enabled, every non-mention
  // message queues a turn the model may decline.
  client.on("messageCreate", (message) => {
    const botId = client.user?.id;
    if (!botId) return;
    if (!isTrackable(message, botId, cfg.discord.guildId)) return;
    gate.arrive(message);
  });

  // Edits: a message still in its stability window refreshes the gate (the
  // commit will carry the final state) — this is how other bots' streamed
  // replies complete. An already-committed message syncs the context instead.
  // Single-message entries (a human or other bot's message, or a short bot
  // reply) take the new content as-is; chunked bot replies rebuild their
  // visible text from the stored chunks. The bot's own final post of a chunk
  // matches the stored chunk, so it is a no-op — only real edits (by anyone)
  // change anything. Note: an edit that *adds* a mention does not queue a
  // turn; only fresh (stabilizing) messages do.
  client.on("messageUpdate", (_oldMessage, message) => {
    const botId = client.user?.id;
    if (!botId) return;
    const channelId = message.channel?.id;
    if (!channelId) return;
    if (gate.isPending(message.id)) {
      gate.arrive(message);
      return;
    }
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

  // Deletions: drop the still-pending message (it never committed, so there
  // is nothing to remove from the context) and, wherever an entry is in the
  // context, drop it too. (A delete of any chunk of a chunked reply drops
  // the whole reply.)
  client.on("messageDelete", (message) => {
    const channelId = message.channel?.id;
    if (!channelId) return;
    gate.drop(message.id);
    conversationFor(channelId)?.removeById(message.id);
  });

  client.on("messageDeleteBulk", (messages, channel) => {
    const conv = conversationFor(channel.id);
    for (const m of messages.values()) {
      gate.drop(m.id);
      conv?.removeById(m.id);
    }
  });

  // A deleted channel's context and pending messages are gone; forget them.
  client.on("channelDelete", (channel) => {
    contexts.clear(channel.id);
    gate.clearChannel(channel.id);
  });

  // Lifecycle: cancel in-flight generation, destroy the client, exit cleanly.
  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down`);
    gate.clear();
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
