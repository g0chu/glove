import { randomUUID } from "node:crypto";
import { ChannelType, type GuildTextBasedChannel, type Message, type PartialMessage } from "discord.js";
import { createDiscordClient } from "./bot/client.js";
import { buildChannelContext, chimeTranscript, endWithTrigger, prefixEndIndex, syncMessageUpdate, type ContextOptions } from "./bot/context.js";
import { decideChime, formatChimeNo, type ChimeDecision } from "./bot/chime.js";
import { MessageGate, type GateMessage } from "./bot/gate.js";
import { QueueStore, type TurnRequest } from "./bot/queue.js";
import { ChannelActivity } from "./bot/quiet.js";
import { CLEAR_CONFIRMATION, isClearCommand, isMentionOf, isTrackable, replaceMention } from "./bot/router.js";
import { ResponseWriter, SAFE_MENTIONS, type PostedReply } from "./bot/writer.js";
import { LlmClient, isInterruptedError, type ChatMessage } from "./llm/client.js";
import { ChatPersistence } from "./llm/persist.js";
import { ConversationArchive } from "./llm/archive.js";
import { archiveChat } from "./llm/archived-chat.js";
import { archiveAttachments } from "./bot/attachment-store.js";
import { captureCatchup } from "./bot/catchup.js";
import { archiveTools } from "./tools/archive.js";
import { recoverTurns } from "./llm/recovery.js";
import {
  ChannelContextStore,
  contextWindowFromOverflowError,
  isContextOverflowError,
  ChannelContext,
} from "./llm/context.js";
import { COMPACT_OUTPUT_RESERVE_TOKENS, LlamaMetrics, TurnTokens, deriveCompactionBudget, type ChatFn } from "./llm/metrics.js";
import { loadConfig } from "./config.js";
import { errMsg, log } from "./log.js";
import { formatToolCall } from "./tools/activity.js";
import { buildTools } from "./tools/index.js";
import { runToolTurn, type ToolRound, type ToolTurnOutcome } from "./tools/loop.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  let stopping = false;
  const activeTurns = new Set<Promise<void>>();
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
    `store=${cfg.model.chatsFile}`,
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
  // The per-channel contexts are persisted to disk after every change (see
  // ChatPersistence): the full history — every message, the model's replies,
  // its reasoning, its tool calls and the tool results — so a restart
  // resumes each conversation exactly where it left off instead of
  // re-seeding the channel's last-N text (which would lose the reasoning
  // and tool activity). A channel with a persisted context never re-seeds.
  const persistence = new ChatPersistence(cfg.model.chatsFile);
  const archive = new ConversationArchive(cfg.model.archiveDir, (error) => {
    // Continuing would allow unrecorded side effects. Already committed
    // events are durable; unfinished operations are identified on restart.
    log.error(error.message);
    process.exit(1);
  });
  log.info(`durable archive: ${cfg.model.archiveDir}`);
  if (archive.recoveredTail) log.warn(`quarantined incomplete archive tail: ${archive.recoveredTail}`);
  const incomplete = archive.incomplete();
  if (incomplete.tools.length || incomplete.requests.length || incomplete.turns.length) {
    log.warn(`archive recovery: ${incomplete.tools.length} indeterminate tool execution(s), ${incomplete.requests.length} unfinished request(s), ${incomplete.turns.length} unfinished turn(s); no automatic replay`);
    archive.record("recovery.observed", {}, incomplete);
  }
  const contexts = new ChannelContextStore((channelId, context) => {
    archive.record("context.checkpoint", { channelId }, context.serialize());
    persistence.save(channelId, context);
  });
  const savedContexts = persistence.load();
  const archivedContexts = archive.restoreContexts();
  for (const [channelId, data] of savedContexts) {
    if (!archivedContexts.has(channelId)) {
      archive.record("migration.context", { channelId }, data);
      const sanitized = ChannelContext.restore(data).serialize();
      archive.record("context.checkpoint", { channelId }, sanitized);
      archivedContexts.set(channelId, sanitized);
    }
  }
  for (const [channelId, data] of archivedContexts) {
    if (data !== null) contexts.restore(channelId, data);
    else persistence.remove(channelId);
  }
  const recoveredTurns = recoverTurns(archive, contexts);
  if (recoveredTurns) log.info(`restored ${recoveredTurns} interrupted turn(s) from the archive without replay`);
  const catchupBoundaries = archive.catchupCursors();
  for (const channelId of archivedContexts.keys()) {
    if (!catchupBoundaries.has(channelId)) catchupBoundaries.set(channelId, null);
  }
  // Persist the old boundary before any new gateway messages can advance
  // the observed cursor; a crash during catch-up must not skip the gap.
  for (const [channelId, after] of catchupBoundaries) archive.record("catchup.started", { channelId }, { after });
  const liveMessageIds = new Set<string>();
  const catchups = new Map<string, Promise<void>>();
  const ensureCatchupBoundary = (channelId: string): void => {
    if (!catchupBoundaries.has(channelId)) {
      catchupBoundaries.set(channelId, null);
      archive.record("catchup.started", { channelId }, { after: null });
    }
  };
  const archiveMessage = (message: Message | PartialMessage, source: string): void => {
    const channelId = message.channelId;
    ensureCatchupBoundary(channelId);
    archive.record("discord.message", { channelId, messageId: message.id }, {
      source,
      displayName: message.member?.displayName ?? message.author?.username,
      message: message.toJSON(),
    });
  };
  const captureChannel = (channel: GuildTextBasedChannel): Promise<void> => {
    const existing = catchups.get(channel.id);
    if (existing) return existing;
    ensureCatchupBoundary(channel.id);
    const task = (async (): Promise<void> => {
      await captureCatchup(catchupBoundaries.get(channel.id) ?? null,
        async (before) => [...(await channel.messages.fetch({ limit: 100, before })).values()],
        (message) => archiveMessage(message, "catchup"));
      // Reconcile the recent stored user messages where Discord still
      // permits a direct fetch. A live event always wins over a fetch.
      const context = contexts.has(channel.id) ? contexts.get(channel.id) : null;
      const recent = context?.snapshot().filter((e) => e.role === "user").slice(-100) ?? [];
      for (const entry of recent) {
        const id = entry.ids[0];
        if (!id || liveMessageIds.has(id)) continue;
        try {
          const message = await channel.messages.fetch({ message: id, force: true });
          if (liveMessageIds.has(id)) continue;
          archiveMessage(message, "reconcile");
          if (context && client.user) syncMessageUpdate(context, message, client.user.id, client.user.username);
        } catch (err) {
          if ((err as { code?: unknown }).code === 10008 && !liveMessageIds.has(id)) {
            archive.record("discord.deleted", { channelId: channel.id, messageId: id }, { source: "reconcile" });
            context?.removeById(id);
          } else throw err;
        }
      }
      archive.record("catchup.finished", { channelId: channel.id }, {});
    })();
    catchups.set(channel.id, task);
    void task.catch(() => { catchups.delete(channel.id); });
    return task;
  };
  // The llama-server's own metric endpoint (GET /slots): the model side's
  // ground truth for its context window and current use. Best-effort —
  // every probe failure resolves to null and never touches a turn.
  const metrics = cfg.model.metricsEnabled
    ? new LlamaMetrics({ baseUrl: cfg.model.metricsUrl, timeoutMs: cfg.model.metricsTimeoutMs })
    : null;
  // The effective compaction budget: the configured value, or — when
  // CONTEXT_COMPACTION_MAX_TOKENS is empty (compactionAuto) — derived from
  // the llama-server's per-slot context window once a probe succeeds
  // (per-slot window minus the completion headroom; llama-server splits -c
  // across its -np slots, so a request gets one slot's window). The
  // configured value stays the fallback until the derivation happens; a
  // too-small window gives up after one warning.
  let compactionBudget = cfg.model.compactionMaxTokens;
  let compactionBudgetDerived = false;
  let compactionBudgetExhausted = false;
  const setAutoCompactionBudget = (ctxSize: number): void => {
    if (!cfg.model.compactionAuto || compactionBudgetDerived || compactionBudgetExhausted) return;
    const b = deriveCompactionBudget(ctxSize);
    if (b === null) {
      compactionBudgetExhausted = true;
      log.warn(
        `cannot derive the compaction budget from a per-slot context window of ${ctxSize} tokens (window minus ${COMPACT_OUTPUT_RESERVE_TOKENS} completion headroom is too small); keeping the fallback budget ${compactionBudget}`,
      );
      return;
    }
    compactionBudget = b;
    compactionBudgetDerived = true;
    log.info(
      `compaction budget set automatically: ${b} tokens (per-slot context window ${ctxSize} minus ${COMPACT_OUTPUT_RESERVE_TOKENS} completion headroom)`,
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

  // The per-channel chat-activity tracker: a running turn's in-flight model
  // request is aborted on any change in the channel (a new message, an edit,
  // a typing indicator) while its PROMPT is still being processed — once the
  // model's first token has arrived (reasoning, a tool call, or the
  // response), the generation runs to completion and the interruption only
  // dooms the next model call, before its prompt is sent — and after the
  // interruption the turn waits for the channel to go quiet (no activity
  // for DISCORD_MESSAGE_STABLE_MS) before retrying with the updated context
  // (see runTurn). A chime turn also waits for that stillness before
  // deciding at all (see runTurn).
  const channelActivity = new ChannelActivity();

  /**
   * One full turn for a queued turn request (a mention — which always
   * responds — or a chime, where the model first decides whether to respond
   * at all). The model's context is the channel's persistent context
   * (seeded once with the channel's last N messages, grown by every arrival,
   * compacted when it fills the token budget). The triggering message is
   * part of the context, so edits that happened while the turn was queued
   * are picked up automatically.
   *
   * The turn runs in attempts. While an attempt is running, any change in
   * the channel (a new message, an edit, a typing indicator — the bot's own
   * posts and typing never count) interrupts it: the attempt's in-flight
   * model request is aborted while its prompt is still being processed
   * (before the model's first token — reasoning, tool calls and response
   * generation are never cut off mid-flight, so an activity during a tool
   * execution or a running generation interrupts the NEXT model call,
   * before its prompt is sent; the partial reply of a pre-first-token
   * interruption is withdrawn, its thinking line kept), the turn then waits
   * for the channel to go quiet (no activity for DISCORD_MESSAGE_STABLE_MS),
   * and the interrupted turn is judged: superseded (a newer turn will answer
   * the channel — any newer committed message for a chime decision, a newer
   * pending mention turn for a mention) it is DISCARDED — never completed
   * later, nothing recorded — so the model responds to the newest
   * information through the newer turn's own reply; not superseded (an edit
   * or a typing indicator interrupted the attempt, so nothing else will
   * answer) it retries with a freshly built context, which carries
   * everything that arrived or changed while it waited, so the new prompt is
   * sent with the new information. An interrupted attempt records nothing
   * either way before tools execute. Once tools have executed, a failed
   * continuation stops and records their results instead of retrying.
   *
   * A chime turn decides over a still conversation: before the decision it
   * waits for complete stillness (no activity for DISCORD_MESSAGE_STABLE_MS,
   * the window restarting on every new change — any activity cancels the
   * pending decision and the wait starts over), and a message that commits
   * while it waited supersedes it: its own turn (queued behind this one)
   * decides over the still conversation, so a burst of messages settles
   * into one decision (the newest turn's) over what was actually said.
   */
  const runTurn = async (channelId: string, turn: TurnRequest): Promise<void> => {
    if (stopping) return;
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
    await captureChannel(textChannel).catch((err) => {
      log.warn(`archive catch-up for ${channelId}: ${errMsg(err)}; continuing with available context, gap retained for retry`);
    });
    const turnId = randomUUID();
    archive.record("turn.started", { channelId, turnId, messageId: turn.id }, turn);

    // One token account for the whole turn: interrupted attempts consumed
    // real tokens too, so their model calls count in the turn's report.
    const tokens = new TurnTokens();

    try {
      for (let attempt = 0; ; attempt++) {
        if (stopping) return;
        const scope = { channelId, turnId, messageId: turn.id, attempt };
        const callModel: ChatFn = (msgs, cbs, t, signal, options) => {
          if (stopping) throw new Error("bot is shutting down");
          return llm.chat(msgs, cbs, t, signal, { ...options, interruptSignal: signal ? mentionController.signal : undefined });
        };
        // Per-attempt state: a fresh writer (a previous attempt's partial
        // reply has been withdrawn), a fresh activity poster, a fresh round
        // record, and a fresh abort controller — any channel activity while
        // the attempt is running aborts its in-flight model request.
        const writer = new ResponseWriter({
          channel,
          typingIntervalMs: cfg.discord.typingIntervalMs,
          throttleMs: cfg.discord.streamUpdateThrottleMs,
        });
        const attemptController = new AbortController();
        // Human mentions override the ordinary prefill-only activity signal.
        const mentionController = new AbortController();
        const unwatch = channelActivity.watch(channelId, (mention) => {
          if (mention) mentionController.abort();
          attemptController.abort();
        });
        // Every model call of the attempt goes through a tracked wrapper so
        // the endpoint's reported usage (input/output per call, largest
        // prompt) is accumulated: the turn's cost is reported at the end,
        // and the largest prompt becomes the channel's measured context
        // size for the next compaction check. The reply rounds stream into
        // the writer; the compaction summarizer and the chime decision use
        // a plain wrapper on the same account (their text is never posted).
        // The attempt's abort signal rides along: channel activity aborts
        // the in-flight call while its prompt is still being processed
        // (after the first token the call runs to completion) and dooms the
        // next one (it fails at once at the entry check). The compaction
        // summarizer is the exception — it takes no signal (it is context
        // maintenance, not the prompt being answered, and an aborted
        // summarization must not fall into the emergency-trim path).
        const replyChat: ChatFn = tokens.track(
          (msgs, _cbs, t, signal) =>
            archiveChat(archive, { ...scope, purpose: "reply", round: rounds.length }, callModel)(
              msgs,
              {
                onDelta: (d) => writer.chunk(d),
                onReasoning: cfg.discord.showReasoning ? (d) => writer.reason(d) : undefined,
              },
              t,
              signal,
            ),
        );
        const plainChat: ChatFn = tokens.track((msgs, cbs, t, signal, options) =>
          archiveChat(archive, { ...scope, purpose: t?.some((tool) => tool.name === "chime") ? "chime" : "compaction" }, callModel)(msgs, cbs, t, signal, options));
        // The attempt's conversation, recorded when the attempt completes:
        // each executed round (the model's text, its reasoning, its calls,
        // the results, and the ids its narration settled to) plus the final
        // reply (its chunk ids). Recorded once — success or failure — so
        // the model's history carries the full turn, not just the final
        // reply; a pre-tool interrupted attempt records nothing.
        const rounds: ToolRound[] = [];
        const roundSettled: Array<PostedReply | null> = [];
        try {
          if (turn.chime) {
            // A chime turn decides over a still conversation: before
            // deciding, it waits for complete stillness — no activity in
            // the channel for the stability window, the window restarting
            // on every new change (a new message, an edit, a typing
            // indicator). Any activity cancels the pending decision and the
            // wait starts over, so a burst of messages settles into one
            // decision over what was actually said, not one decision per
            // partial message. The attempt's watch is already armed:
            // activity during the wait aborts the not-yet-started attempt,
            // and the interrupt path below retries the decision from the
            // still state (a fresh attempt, a fresh context).
            await channelActivity.waitForQuiet(channelId, cfg.discord.messageStableMs);
          }
          // Build the context before the typing indicator starts: it is a
          // channel fetch (+ image downloads, + one summarization call when the
          // context compacts), not the reply generation itself.
          const botUser = client.user;
          if (!botUser) {
            log.error(`turn in ${channelId}: bot user not available; skipping turn`);
            return;
          }
          const botId = botUser.id;
          // With tools enabled, the model may answer in several rounds: a round
          // that ends in tool calls streams its narration (settled in place via
          // onToolRound, so it stays above the tool-activity lines), the tools
          // run, and the next round continues with the results in context. The
          // whole turn (every round's text, reasoning, calls and results, plus
          // the final reply) is recorded in the channel context when the turn
          // ends, so the model's history is the full conversation at all times.
          // The user's MODEL_SYSTEM_PROMPT (when set) comes first; the tools
          // note (listing only the enabled families) is added when any are
          // registered.
          const systemPrompt = [cfg.model.systemPrompt, tools.systemNote]
            .filter((p): p is string => p !== null && p.trim().length > 0)
            .join("\n\n");
          // Shared by the first build and (after an overflow) the rebuild: same
          // window, budget, and summarizer.
          const ctxOpts: ContextOptions = {
            attachmentStore: archiveAttachments(archive, scope),
            acceptSeed: (id) => !archive.wasTracked(channelId, id),
            botId,
            botName: botUser.username,
            systemPrompt,
            maxMessages: cfg.model.contextMaxMessages,
            enableImages: cfg.model.enableImages,
            imagesMaxBytes: cfg.model.imagesMaxBytes,
            enableFileContents: cfg.model.enableFileContents,
            fileContentsMaxBytes: cfg.model.fileContentsMaxBytes,
            maxTokens: compactionBudget,
            keepMessages: cfg.model.compactionKeepMessages,
            compactionPrompt: cfg.model.compactionPrompt,
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
            // A message that committed while the turn waited for stillness
            // (or while the context was being built) supersedes this chime:
            // its own turn is queued behind this one and decides over the
            // still conversation, so this decision is cancelled — no call,
            // no typing indicator, nothing recorded.
            const newer = context.newestUserEntryAfter(turn.id);
            if (newer !== null) {
              log.info(
                `channel ${channelId}: chime decision for message ${turn.id} cancelled — a newer message (${newer}) committed while the channel went still; its turn decides`,
              );
              return;
            }
            // A chime turn: the model decides whether to respond at all, by
            // calling the chime tool (respond + reason) in one small call over
            // the transcript (the reply's system prompt is not part of it).
            // The trigger is the newest user message (the supersede check
            // above), but a previous turn's reply can sit after it in the
            // context — the cut keeps the transcript ending at the trigger,
            // so "the newest message below" in the decision prompt is the
            // trigger itself. NO posts the decision + reason as a one-line
            // UI message (never tracked); null (a failed or broken decision)
            // posts no message and records nothing. Typing is refreshed
            // only while the decision call is running.
            // The decision sees the conversation only: no tool results, no tool
            // calls, no reasoning (a past turn's tooling is not what the
            // decision is about, and it keeps the call small). The cut keeps
            // the transcript ending at the trigger, so "the newest message
            // below" in the decision prompt is the trigger itself.
            const decisionOver = async (msgs: ChatMessage[]): Promise<ChimeDecision | null> => {
              const cut = prefixEndIndex(context, ctxOpts, turn.id);
              const prefix = cut !== null ? msgs.slice(0, cut) : msgs;
              return decideChime(
                (m, tools, signal, options) => plainChat(m, undefined, tools, signal, options),
                chimeTranscript(systemPrompt.trim().length > 0 ? prefix.slice(1) : prefix),
                attemptController.signal,
                { sendTyping: () => textChannel.sendTyping(), intervalMs: cfg.discord.typingIntervalMs },
                { channelId, messageId: turn.id },
                cfg.discord.chimePrompt,
              );
            };
            let decision: ChimeDecision | null;
            try {
              decision = await decisionOver(messages);
            } catch (err) {
              if (isInterruptedError(err)) throw err; // the turn handles the quiet-wait + retry
              if (!isContextOverflowError(err)) throw err; // defensive: decideChime re-throws overflows only
              // The transcript did not fit the model's context (the channel
              // outgrew the window since the last measurement): the endpoint
              // rejected it before generating. A decision over a shrunk
              // context still decides over the newest message, so shrink
              // hard (the trigger protected — it sits at the end, never
              // among the oldest), rebuild the transcript, and retry the
              // decision once; a second overflow falls through to the
              // silent path below.
              const window = contextWindowFromOverflowError(err);
              // The estimate must fit the smaller of the compaction budget
              // and the window minus the completion headroom (the budget
              // alone may sit at or above the window).
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
                `chime decision in ${channelId} overfilled the model's context (${errMsg(err)}); dropped the oldest messages to fit ~${target} tokens and retrying the decision once`,
              );
              const rebuilt = await buildChannelContext(textChannel, context, turn.id, ctxOpts);
              if (rebuilt === null) {
                log.info(`trigger ${turn.id} in ${channelId} left the channel context; skipping turn`);
                return;
              }
              // A message that committed while the decision was in flight
              // supersedes this one (its own turn decides over the still
              // conversation) — re-check after the rebuild, like after the
              // first build.
              const newerAfter = context.newestUserEntryAfter(turn.id);
              if (newerAfter !== null) {
                log.info(
                  `channel ${channelId}: chime decision for message ${turn.id} cancelled — a newer message (${newerAfter}) committed while the decision was in flight; its turn decides`,
                );
                return;
              }
              try {
                decision = await decisionOver(rebuilt);
              } catch (err2) {
                if (isInterruptedError(err2)) throw err2;
                log.warn(`chime decision in ${channelId} still overfilled after the shrink (${errMsg(err2)}); staying silent`);
                decision = null;
              }
            }
            if (decision === null) {
              log.info(`channel ${channelId}: chime decision failed or was unusable for message ${turn.id}; staying silent`);
              return;
            }
            if (!decision.respond) {
              log.info(
                `channel ${channelId}: chime decision NO for message ${turn.id}: ${decision.reason || "(no reason given)"}`,
              );
              if (cfg.discord.showChimeNo) await textChannel.send({ content: formatChimeNo(decision.reason), allowedMentions: SAFE_MENTIONS }).catch((err) => {
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
              signal: attemptController.signal,
              interruptSignal: mentionController.signal,
              observeTools: (round) => {
                if (stopping) throw new Error("bot is shutting down");
                return archiveTools(archive, { ...scope, round });
              },
              onToolRound: async () => {
                roundSettled.push(await writer.discard());
              },
              onToolCalls: async (calls) => {
                if (!cfg.discord.showToolActivity) return;
                // Every call of the turn lands in the writer's one shared
                // activity message (the first line posts it, later rounds
                // edit it in place — interleaved with the thinking lines in
                // the order they happened). The calls and results are
                // recorded in the channel context when the turn ends
                // (onRoundComplete), so the model's history keeps them.
                await writer.appendActivityLines(calls.map(formatToolCall));
              },
              onRoundComplete: (round) => {
                archive.record("round.finished", { ...scope, round: rounds.length }, { round, delivery: roundSettled[rounds.length] ?? null });
                rounds.push(round);
              },
            });
          let outcome: ToolTurnOutcome;
          try {
            // The reply request ends with the trigger's user message (moved to
            // the end when the context outgrew it — a request ending with the
            // bot's own reply would be prefilled/echoed or rejected by
            // prefill-assistant endpoints; see endWithTrigger).
            outcome = await runModel(endWithTrigger(context, ctxOpts, messages, turn.id));
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
            // No tools executed: runToolTurn converts continuation failures
            // after execution into ordinary errors to prevent replay.
            const rebuilt = await buildChannelContext(textChannel, context, turn.id, ctxOpts);
            if (rebuilt === null) {
              log.info(`trigger ${turn.id} in ${channelId} left the channel context; skipping turn`);
              return;
            }
            outcome = await runModel(endWithTrigger(context, ctxOpts, rebuilt, turn.id));
          }
          if (outcome.toolRounds > 0) {
            log.info(`turn in ${channelId} used ${outcome.toolRounds} tool round(s)`);
          }
          const finalText =
            outcome.exhausted && outcome.content.trim() === ""
              ? "*(stopped: the model kept requesting tools past the round limit)*"
              : outcome.content;
          const posted = await writer.finish(finalText);
          archive.record("discord.delivery", scope, { posted, raw: finalText, reasoning: outcome.reasoning });
          if (context.has(turn.id)) recordTurn(turnId, context, rounds, roundSettled, posted, outcome.reasoning, finalText);
          break; // the attempt completed: the turn is done
        } catch (err) {
          if (isInterruptedError(err)) {
            // The channel changed (a new message, an edit, a typing
            // indicator) while the attempt's prompt was still being
            // processed — the interruption lands before the model's first
            // token for ordinary activity, or during generation for a
            // human mention: the abort
            // already happened (this error is its trace). Withdraw the
            // partial reply (the thinking line is kept in the channel, like
            // a finished round's) and wait for the channel to go quiet — no
            // activity for the stability window, the window restarting on
            // every new change — so that every message that arrived or
            // changed while the attempt was interrupted has committed (and
            // queued its own turn, when it queues one) before the
            // interrupted turn is judged.
            log.info(
              `turn in ${channelId}: interrupted by channel activity (attempt ${attempt + 1}); waiting for the channel to go quiet (${cfg.discord.messageStableMs}ms)`,
            );
            await writer.interrupt();
            await channelActivity.waitForQuiet(channelId, cfg.discord.messageStableMs);
            if (!context.has(turn.id)) {
              log.info(
                `trigger ${turn.id} in ${channelId} left the channel context while the turn waited for the channel to go quiet; skipping turn`,
              );
              break;
            }
            // The interrupted turn's fate — it is never completed later as a
            // stale turn; the model responds to the newest information
            // through the turn that answers the channel's newest state:
            //   superseded -> discarded (nothing recorded). A chime turn is
            //   superseded by any newer committed user entry (the newer
            //   message's own turn decides over the still conversation); a
            //   mention turn by a newer pending mention turn (it always
            //   responds, over a context that carries everything). A newer
            //   ambient message does NOT supersede a mention turn: with
            //   chime off it queued no turn, and with chime on its decision
            //   may stay silent — the mention must still be answered.
            //   not superseded -> retried. The interruption carried no new
            //   message (an edit, a typing indicator), so nothing else will
            //   answer: the next attempt's freshly built context carries
            //   everything that arrived or changed while we waited.
            const supersededBy = turn.chime
              ? context.newestUserEntryAfter(turn.id)
              : queues.get(channelId).newestPendingMentionAfter(turn.id);
            if (supersededBy !== null && context.has(supersededBy)) {
              log.info(
                `turn in ${channelId}: superseded by a newer ${turn.chime ? "message" : "mention"} (${supersededBy}) while the attempt was interrupted; discarding the turn — the newer turn responds to the newest information`,
              );
              return;
            }
            log.info(
              `turn in ${channelId}: no newer turn supersedes it; retrying with a freshly built context (attempt ${attempt + 2})`,
            );
            continue; // next attempt: a fresh context, a fresh prompt
          }
          if (mentionController.signal.aborted && rounds.length > 0) {
            await writer.interrupt();
            if (context.has(turn.id)) recordTurn(turnId, context, rounds, roundSettled, null);
            await channelActivity.waitForQuiet(channelId, cfg.discord.messageStableMs);
            break;
          }
          log.error(`turn failed in channel ${channelId}: ${errMsg(err)}`);
          const posted = await writer.reportError(err);
          archive.record("turn.failed", scope, { error: errMsg(err), posted });
          if (context.has(turn.id)) recordTurn(turnId, context, rounds, roundSettled, posted, undefined);
          break;
        } finally {
          unwatch();
        }
      }
    } finally {
      archive.record("turn.finished", { channelId, turnId, messageId: turn.id }, {});
      await reportTurnTokens(channelId, context, tokens);
    }
  };

  /**
   * Record a completed turn in the channel's conversation store: each
   * executed round (the model's text — or what of it settled in the channel
   * — its reasoning, the calls it requested, the results) and the final
   * reply (the canonical posted text, with the chunk ids so edits and
   * deletes of the posted messages keep syncing the context). When nothing
   * was posted (every send failed), the final reply is still recorded with
   * no backing message ids: the model's history keeps what the model said.
   */
  const recordTurn = (
    turnId: string,
    context: ChannelContext,
    rounds: ToolRound[],
    roundSettled: Array<PostedReply | null>,
    posted: PostedReply | null,
    finalReasoning?: string,
    finalContent = "",
  ): void => {
    context.appendTurn(
      rounds.map((r, i) => {
        const settled = roundSettled[i];
        return {
          content: settled?.text ?? r.content,
          reasoning: r.reasoning,
          calls: r.calls,
          results: r.results,
          ids: settled?.messageIds ?? [],
          chunks: settled?.chunks,
        };
      }),
      {
        content: posted?.text ?? finalContent,
        reasoning: finalReasoning,
        ids: posted?.messageIds ?? [],
        chunks: posted?.chunks,
      },
      turnId,
    );
  };

  /** The channel's context store, if the channel is tracked at all. */
  const conversationFor = (channelId: string): ChannelContext | null => {
    return contexts.has(channelId) ? contexts.get(channelId) : null;
  };

  const queues = new QueueStore({ runTurn: async (channelId, turn) => {
    const task = runTurn(channelId, turn);
    activeTurns.add(task);
    try { await task; } finally { activeTurns.delete(task); }
  } });

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
    if (stopping) return;
    const botUser = client.user;
    if (!botUser) return;
    const botId = botUser.id;
    const channelId = message.channel?.id;
    if (!channelId) return; // the channel vanished while the message was pending
    if (!message.author) return;
    archiveMessage(message, "stable");
    if (!message.author.bot && isClearCommand(message.content, botId)) {
      archive.record("context.cleared", { channelId, messageId: message.id }, { authorId: message.author.id });
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
    // The model's view of the message: a mention of the bot is its Discord
    // name (a mention stripped to nothing would be invisible to the model).
    const content = replaceMention(message, botId, botUser.username);
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
    // instead: the model waits for the channel to go still, then decides
    // whether to respond at all — a newer message supersedes and cancels
    // an older decision (the burst's newest turn decides), NO posts the
    // decision + reason, and a broken decision stays silent.
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
    // Capture offline gaps even in quiet channels that have no new mention.
    // One channel at a time avoids an unbounded burst of Discord requests.
    void (async () => {
      for (const channelId of catchupBoundaries.keys()) {
        if (stopping) return;
        try {
          const channel = await client.channels.fetch(channelId);
          if (channel?.type === ChannelType.GuildText && (cfg.discord.guildId === "" || channel.guildId === cfg.discord.guildId)) {
            await captureChannel(channel);
          }
        } catch (err) { log.warn(`archive catch-up for ${channelId}: ${errMsg(err)}; will retry at its next turn`); }
      }
    })();
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
    // compaction budget from its per-slot context window (llama-server
    // splits -c across its -np slots — a request gets one slot's window),
    // and check the budget is not at or above that window (requests would
    // overflow the model's context before compaction could trigger — the
    // overflow recovery would still save the turn, but avoiding it is
    // better).
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
          `llama-server: ${s.slots.length} slot(s), context window ${s.ctxSize} tokens per slot` +
            (s.lastRequestTokens !== null ? `, largest recent request ${s.lastRequestTokens} tokens` : ""),
        );
        setAutoCompactionBudget(s.ctxSize);
        if (s.ctxSize > 0 && compactionBudget >= s.ctxSize) {
          log.warn(
            `compaction budget ${compactionBudget} is not below the per-slot context window ${s.ctxSize} (llama-server splits -c across its -np slots; a request gets one slot's window); compaction would trigger too late`,
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
    if (stopping) return;
    const botId = client.user?.id;
    if (!botId) return;
    if (message.channel.type === ChannelType.GuildText && (cfg.discord.guildId === "" || message.guildId === cfg.discord.guildId)) {
      liveMessageIds.add(message.id);
      archiveMessage(message, "create");
    }
    if (!isTrackable(message, botId, cfg.discord.guildId)) return;
    gate.arrive(message);
    // A new message is a change in the channel: it interrupts a running
    // turn's prompt processing and restarts its quiet wait (see
    // ChannelActivity).
    const channelId = message.channel?.id;
    if (channelId) channelActivity.note(channelId, !message.author.bot && isMentionOf(message, botId));
  });

  // Edits: a message still in its stability window refreshes the gate (the
  // commit will carry the final state) — this is how other bots' streamed
  // replies complete. An already-committed message syncs the context instead
  // (see syncMessageUpdate: single-message entries take the content with the
  // bot's mention rendered as its Discord name; chunked bot replies take the
  // RAW chunk content, so the bot's
  // own final settle edit — which Discord echoes back as a messageUpdate —
  // is a no-op and only real edits change anything). Note: an edit that
  // *adds* a mention does not queue a turn; only fresh (stabilizing)
  // messages do.
  client.on("messageUpdate", (_oldMessage, message) => {
    if (stopping) return;
    const botUser = client.user;
    const botId = botUser?.id;
    if (!botId || !botUser) return;
    const channelId = message.channel?.id;
    if (!channelId) return;
    if (message.channel.type === ChannelType.GuildText && (cfg.discord.guildId === "" || message.guildId === cfg.discord.guildId)) {
      liveMessageIds.add(message.id);
      archiveMessage(message, "update");
    }
    if (gate.isPending(message.id)) {
      gate.arrive(message);
    } else {
      const conv = conversationFor(channelId);
      if (conv) syncMessageUpdate(conv, message, botId, botUser.username);
    }
    // An edit is a change in the channel: it interrupts a running turn's
    // prompt processing and restarts its quiet wait (see ChannelActivity).
    // The note comes after the gate refresh, so a still-pending message
    // commits a hair before the quiet wait can resolve — the retry's
    // context carries it.
    if (isTrackable(message, botId, cfg.discord.guildId)) {
      channelActivity.note(channelId, gate.isPending(message.id) && !message.author.bot && isMentionOf(message, botId));
    }
  });

  // A typing indicator is a change in the channel too: someone is about to
  // say something, so a running turn's prompt is stale before it is sent —
  // interrupt it. The turn then waits for the channel to go quiet, which
  // keeps resetting while the typing goes on (the bot's own typing never
  // counts: the gateway does not report it, and it is filtered anyway).
  client.on("typingStart", (typing) => {
    const botId = client.user?.id;
    if (!botId) return;
    const user = typing.user;
    if (!user || user.id === botId) return;
    const channel = typing.channel;
    if (channel.type !== ChannelType.GuildText) return; // text channels only, DMs never
    if (cfg.discord.guildId !== "" && channel.guild?.id !== cfg.discord.guildId) return;
    channelActivity.note(channel.id);
  });

  // Deletions: drop the still-pending message (it never committed, so there
  // is nothing to remove from the context) and, wherever an entry is in the
  // context, drop it too. (A delete of any chunk of a chunked reply drops
  // the whole reply.)
  client.on("messageDelete", (message) => {
    if (stopping) return;
    const channelId = message.channel?.id;
    if (!channelId) return;
    if (message.channel.type === ChannelType.GuildText && (cfg.discord.guildId === "" || message.guildId === cfg.discord.guildId)) {
      liveMessageIds.add(message.id);
      archive.record("discord.deleted", { channelId, messageId: message.id }, {});
    }
    gate.drop(message.id);
    conversationFor(channelId)?.removeById(message.id);
  });

  client.on("messageDeleteBulk", (messages, channel) => {
    if (stopping) return;
    const conv = conversationFor(channel.id);
    for (const m of messages.values()) {
      if (channel.type === ChannelType.GuildText && (cfg.discord.guildId === "" || channel.guildId === cfg.discord.guildId)) {
        liveMessageIds.add(m.id);
        archive.record("discord.deleted", { channelId: channel.id, messageId: m.id }, { bulk: true });
      }
      gate.drop(m.id);
      conv?.removeById(m.id);
    }
  });

  // A deleted channel's context and pending messages are gone; forget them
  // (in memory and in the persistence file).
  client.on("channelDelete", (channel) => {
    if (stopping) return;
    if (archive.messageCursors().has(channel.id) || contexts.has(channel.id)) archive.record("channel.deleted", { channelId: channel.id }, {});
    contexts.clear(channel.id);
    persistence.remove(channel.id);
    gate.clearChannel(channel.id);
    channelActivity.clearChannel(channel.id);
  });

  // Lifecycle: cancel in-flight generation, destroy the client, exit cleanly.
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    gate.clear();
    channelActivity.clear();
    llm.abort();
    for (const c of tools.clients) c.abort();
    // Await active turns so completed tools get their result records. A
    // bounded deadline leaves durable starts as indeterminate, never replayed.
    const settle = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...activeTurns, ...catchups.values()]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 30_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      await persistence.flush();
      archive.record("shutdown", {}, { signal, activeTurns: activeTurns.size });
      archive.close();
      client.destroy();
    };
    void settle().finally(() => process.exit(0));
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
