/**
 * Smoke tests: config parsing, the stability gate (a message commits once
 * it has been unchanged for the window), code-fence-aware chunk splitting,
 * image attachment downloads, turn-context building (the persistent
 * per-channel context: seed, growth, compaction, emergency trim) and the
 * !clear command (fresh-chat reset), queue semantics, response writer
 * behavior (incl. multi-message streaming of long replies), the tool
 * executor and tool loop, the in-process web/file/shell/zim/vault tools
 * (against a synthetic ZIM file and a synthetic notes vault built in temp
 * dirs), the LLM client (stream +
 * non-stream + tool calls + token usage + errors + multimodal wire shape)
 * against a local mock OpenAI-compatible server, and the llama-server
 * metrics (the /slots probe and per-turn token accounting). Run with:
 * npm test
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { pinnedFetch } from "../src/tools/web/fetcher.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { ChannelType, type GuildTextBasedChannel, type Message } from "discord.js";
import { parseConfig } from "../src/config.js";
import { CLEAR_CONFIRMATION, isClearCommand, isMentionOf, isTrackable, replaceMentionText } from "../src/bot/router.js";
import { ChannelContext, ChannelContextStore, COMPACTION_SYSTEM_PROMPT, contextWindowFromOverflowError, estimateTokens, isContextOverflowError, type ContextEntry } from "../src/llm/context.js";
import { ChatPersistence } from "../src/llm/persist.js";
import { ConversationArchive, type ArchiveRecord } from "../src/llm/archive.js";
import { archiveChat } from "../src/llm/archived-chat.js";
import { recoverTurns } from "../src/llm/recovery.js";
import { archiveTools } from "../src/tools/archive.js";
import { archiveAttachments } from "../src/bot/attachment-store.js";
import { captureCatchup } from "../src/bot/catchup.js";
import { MessageGate, type GateMessage } from "../src/bot/gate.js";
import { ChannelActivity } from "../src/bot/quiet.js";
import { chimeReplyChat } from "../src/bot/chime-reply.js";
import { chimeTools, CHIME_MAX_TOKENS, CHIME_SYSTEM_PROMPT, CHIME_TOOL_SPEC, decideChime, formatChimeNo, type ChimeChat } from "../src/bot/chime.js";
import { InterruptedError, isInterruptedError, LlmClient, type ChatMessage, type ChatResult, type ToolSpec } from "../src/llm/client.js";
import { LlamaMetrics, TurnTokens, deriveCompactionBudget } from "../src/llm/metrics.js";
import { ChannelQueue, type TurnRequest } from "../src/bot/queue.js";
import { ResponseWriter, splitForDiscord } from "../src/bot/writer.js";
import { sanitizeForDiscord } from "../src/bot/format.js";
import { fetchMessageImages, isDiscordCdnUrl, type ImageFetch, type MessageAttachmentLike } from "../src/bot/images.js";
import { fetchMessageFiles, fenceFor, isProbablyText, type FileFetch } from "../src/bot/files.js";
import { buildChannelContext, contextToMessages, endWithTrigger, prefixEndIndex, syncMessageUpdate, type MessageLike } from "../src/bot/context.js";
import { ToolRegistry, executeToolCalls, parseToolArgs, argString, argOptionalString, argInt } from "../src/tools/executor.js";
import { runToolTurn } from "../src/tools/loop.js";
import { formatToolCall } from "../src/tools/activity.js";
import { buildTools } from "../src/tools/index.js";
import { resolveUrl } from "../src/tools/web/ssrf.js";
import { FetchCache } from "../src/tools/web/cache.js";
import { extractTitle, extractContent } from "../src/tools/web/extract.js";
import { searchDuckDuckGo } from "../src/tools/web/search.js";
import { resolveInWorkspace } from "../src/tools/file/paths.js";
import * as fileOps from "../src/tools/file/ops.js";
import { ShellTools } from "../src/tools/shelltools.js";
import { ZimReader } from "../src/tools/zim/reader.js";
import { ZimTools, registerZimTools } from "../src/tools/zimtools.js";
import { VaultTools, registerVaultTools, VAULT_SEARCH_SPEC } from "../src/tools/vaulttools.js";
import { jsScan, scanBody, type BodyScanOutcome } from "../src/tools/vault/body.js";
import { zstdCompressSync } from "node:zlib";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

let checks = 0;
const ok = (name: string): void => {
  checks++;
  console.log(`  ok  ${name}`);
};

// ---------------------------------------------------------------- config --
{
  const { config, errors } = parseConfig({
    DISCORD_TOKEN: "tok",
    DISCORD_GUILD_ID: "123",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    MODEL_STREAM: "false",
    MODEL_TIMEOUT_S: "5",
    MODEL_CONTEXT_MAX_MESSAGES: "7",
    MODEL_API_KEY: "k1",
    MODEL_IMAGES_MAX_BYTES: "2048",
    MODEL_ENABLE_FILE_CONTENTS: "true",
    MODEL_FILE_CONTENT_MAX_BYTES: "500000",
    CONTEXT_COMPACTION_MAX_TOKENS: "1234",
    CONTEXT_COMPACTION_KEEP_MESSAGES: "5",
  });
  assert.deepEqual(errors, []);
  assert.equal(config.discord.token, "tok");
  assert.equal(config.discord.guildId, "123");
  assert.equal(config.model.stream, false);
  assert.equal(config.model.timeoutMs, 5000);
  assert.equal(config.model.contextMaxMessages, 7);
  assert.equal(config.model.apiKey, "k1");
  assert.equal(config.model.archiveDir, "./data/archive");
  assert.equal(parseConfig({ DISCORD_TOKEN: "tok", MODEL_API_URL: "http://localhost:8080/v1/chat/completions", CHATS_ARCHIVE_DIR: "/tmp/custom-archive" }).config.model.archiveDir, "/tmp/custom-archive");
  assert.equal(config.model.enableImages, false); // default
  assert.equal(config.model.imagesMaxBytes, 2048);
  assert.equal(config.model.enableFileContents, true);
  assert.equal(config.model.fileContentsMaxBytes, 500000);
  assert.equal(config.model.compactionMaxTokens, 1234);
  assert.equal(config.model.compactionKeepMessages, 5);
  assert.equal(config.discord.typingIntervalMs, 5000); // default
  assert.equal(config.discord.streamUpdateThrottleMs, 2000); // default
  assert.equal(config.discord.showReasoning, true); // default
  assert.equal(config.discord.showToolActivity, true); // default
  assert.equal(config.discord.messageStableMs, 2000); // default
  assert.equal(config.discord.chimeEnabled, false); // default
  assert.equal(config.discord.showChimeNo, true);
  assert.equal(config.discord.chimePrompt, "");
  assert.equal(config.model.compactionPrompt, "");
  const customPrompts = parseConfig({
    DISCORD_TOKEN: "tok", MODEL_API_URL: "http://localhost/v1/chat/completions",
    BOT_CHIME_SHOW_NO: "false", BOT_CHIME_PROMPT: "Custom chime\nSecond line",
    CONTEXT_COMPACTION_PROMPT: "Custom summary",
  });
  assert.deepEqual(customPrompts.errors, []);
  assert.equal(customPrompts.config.discord.showChimeNo, false);
  assert.equal(customPrompts.config.discord.chimePrompt, "Custom chime\nSecond line");
  assert.equal(customPrompts.config.model.compactionPrompt, "Custom summary");
  assert.ok(parseConfig({ BOT_CHIME_SHOW_NO: "invalid" }).errors.some((e) => e.includes("BOT_CHIME_SHOW_NO")));
  ok("config: parses valid env and applies defaults");

  const { errors: badErrors } = parseConfig({
    DISCORD_TOKEN: "",
    DISCORD_GUILD_ID: "",
    MODEL_API_URL: "not a url",
    MODEL_TIMEOUT_S: "abc",
    MODEL_STREAM: "banana",
    DISCORD_SHOW_REASONING: "maybe",
    MODEL_IMAGES_MAX_BYTES: "0",
    MODEL_FILE_CONTENT_MAX_BYTES: "0",
    CONTEXT_COMPACTION_MAX_TOKENS: "abc",
  });
  assert.ok(badErrors.length >= 8, `expected >= 8 errors, got ${badErrors.length}`);
  assert.ok(badErrors.some((e) => e.includes("DISCORD_SHOW_REASONING")), `got: ${badErrors.join("; ")}`);
  assert.ok(badErrors.some((e) => e.includes("MODEL_IMAGES_MAX_BYTES")), `got: ${badErrors.join("; ")}`);
  assert.ok(badErrors.some((e) => e.includes("MODEL_FILE_CONTENT_MAX_BYTES")), `got: ${badErrors.join("; ")}`);
  assert.ok(badErrors.some((e) => e.includes("CONTEXT_COMPACTION_MAX_TOKENS")), `got: ${badErrors.join("; ")}`);
  ok("config: reports missing/invalid values");

  const { config: tc, errors: te } = parseConfig({
    DISCORD_TOKEN: "t",
    DISCORD_GUILD_ID: "g",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    WEBTOOLS_ENABLED: "true",
    WEBTOOLS_TIMEOUT_S: "12",
    WEBTOOLS_FETCH_MAX_BYTES: "2048",
    WEBTOOLS_MAX_REDIRECTS: "2",
    WEBTOOLS_CACHE_TTL_S: "60",
    WEBTOOLS_CACHE_MAX_ENTRIES: "4",
    WEBTOOLS_SEARCH_MAX_RESULTS: "3",
    FILETOOLS_ENABLED: "true",
    FILETOOLS_WORKSPACE: "/tmp/ws",
    FILETOOLS_READ_MAX_BYTES: "4096",
    SHELLTOOLS_ENABLED: "true",
    SHELLTOOLS_TIMEOUT_S: "45",
    SHELLTOOLS_MAX_OUTPUT_BYTES: "2048",
    TOOLS_MAX_RESULT_CHARS: "12345",
    TOOLS_MAX_ROUNDS: "7",
    DISCORD_SHOW_REASONING: "false",
    DISCORD_SHOW_TOOL_ACTIVITY: "false",
    DISCORD_MESSAGE_STABLE_MS: "350",
    BOT_CHIME_ENABLED: "true",
  });
  assert.deepEqual(te, []);
  assert.equal(tc.discord.showReasoning, false);
  assert.equal(tc.discord.showToolActivity, false);
  assert.equal(tc.tools.web.enabled, true);
  assert.equal(tc.tools.web.timeoutMs, 12000);
  assert.equal(tc.tools.web.fetchMaxBytes, 2048);
  assert.equal(tc.tools.web.maxRedirects, 2);
  assert.equal(tc.tools.web.cacheTtlMs, 60000);
  assert.equal(tc.tools.web.cacheMaxEntries, 4);
  assert.equal(tc.tools.web.searchMaxResults, 3);
  assert.equal(tc.tools.file.enabled, true);
  assert.equal(tc.tools.file.workspace, "/tmp/ws");
  assert.equal(tc.tools.file.readMaxBytes, 4096);
  assert.equal(tc.tools.file.writeMaxBytes, 5_000_000); // default
  assert.equal(tc.tools.shell.enabled, true);
  assert.equal(tc.tools.shell.timeoutMs, 45000);
  assert.equal(tc.tools.shell.maxOutputBytes, 2048);
  assert.equal(tc.tools.maxResultChars, 12345);
  assert.equal(tc.tools.maxRounds, 7);
  assert.equal(tc.discord.messageStableMs, 350);
  assert.equal(tc.discord.chimeEnabled, true);
  ok("config: tools section parses env and applies defaults");

  const { config: td } = parseConfig({
    DISCORD_TOKEN: "t",
    DISCORD_GUILD_ID: "g",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
  });
  assert.equal(td.tools.web.enabled, false, "web tools off by default");
  assert.equal(td.tools.file.enabled, false, "file tools off by default");
  assert.equal(td.tools.file.workspace, "./workspace");
  assert.equal(td.tools.shell.enabled, false, "shell tool off by default");
  assert.equal(td.tools.shell.timeoutMs, 30000); // default
  assert.equal(td.tools.shell.maxOutputBytes, 100_000); // default
  assert.equal(td.tools.web.searchMaxResults, 10); // default
  assert.equal(td.tools.maxResultChars, 200_000); // default
  assert.equal(td.tools.maxRounds, 5);
  assert.equal(td.model.enableImages, false, "image input off by default");
  assert.equal(td.model.imagesMaxBytes, 10_485_760); // default
  assert.equal(td.model.enableFileContents, false, "file contents off by default");
  assert.equal(td.model.fileContentsMaxBytes, 1_000_000); // default
  assert.equal(td.model.compactionMaxTokens, 4000); // default
  assert.equal(td.model.compactionKeepMessages, 20); // default
  ok("config: tools disabled by default");

  const { errors: toolErrs } = parseConfig({
    DISCORD_TOKEN: "t",
    DISCORD_GUILD_ID: "g",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    WEBTOOLS_FETCH_MAX_BYTES: "abc",
    TOOLS_MAX_ROUNDS: "0",
    TOOLS_MAX_RESULT_CHARS: "10",
  });
  assert.ok(toolErrs.some((e) => e.includes("WEBTOOLS_FETCH_MAX_BYTES")), `got: ${toolErrs.join("; ")}`);
  assert.ok(toolErrs.some((e) => e.includes("TOOLS_MAX_ROUNDS")), `got: ${toolErrs.join("; ")}`);
  assert.ok(toolErrs.some((e) => e.includes("TOOLS_MAX_RESULT_CHARS")), `got: ${toolErrs.join("; ")}`);
  ok("config: invalid tool env values rejected");

  const { config: ga, errors: gaErrors } = parseConfig({
    DISCORD_TOKEN: "t",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
  });
  assert.deepEqual(gaErrors, []);
  assert.equal(ga.discord.guildId, "", "no DISCORD_GUILD_ID -> respond in every guild");
  ok("config: DISCORD_GUILD_ID is optional (empty = any guild the bot is in)");
}

// --------------------------------------------------------- config: metrics --
{
  const { config, errors } = parseConfig({
    DISCORD_TOKEN: "tok",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    MODEL_METRICS_ENABLED: "true",
  });
  assert.deepEqual(errors, []);
  assert.equal(config.model.metricsEnabled, true);
  assert.equal(config.model.metricsUrl, "http://localhost:8080", "defaults to the chat endpoint's origin");
  assert.equal(config.model.metricsTimeoutMs, 5000); // default

  const { config: c2 } = parseConfig({
    DISCORD_TOKEN: "tok",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    MODEL_METRICS_ENABLED: "true",
    MODEL_METRICS_URL: "http://model.example:9090/",
    MODEL_METRICS_TIMEOUT_MS: "1200",
  });
  assert.equal(c2.model.metricsUrl, "http://model.example:9090/");
  assert.equal(c2.model.metricsTimeoutMs, 1200);

  const { config: c3, errors: e3 } = parseConfig({
    DISCORD_TOKEN: "tok",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
  });
  assert.equal(c3.model.metricsEnabled, false, "off by default");
  assert.equal(c3.model.metricsUrl, "http://localhost:8080", "derived even when off (the flag gates the probes)");
  assert.ok(e3.length === 0, `got: ${e3.join("; ")}`);

  const { errors: e4 } = parseConfig({
    DISCORD_TOKEN: "tok",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    MODEL_METRICS_URL: "ftp://nope",
    MODEL_METRICS_TIMEOUT_MS: "0",
  });
  assert.ok(e4.some((e) => e.includes("MODEL_METRICS_URL")), `got: ${e4.join("; ")}`);
  assert.ok(e4.some((e) => e.includes("MODEL_METRICS_TIMEOUT_MS")), `got: ${e4.join("; ")}`);
  ok("config: llama-server metrics env (defaults from the chat URL, override, validation)");

  // The compaction budget: an explicit value is used as-is; an empty
  // CONTEXT_COMPACTION_MAX_TOKENS switches to the automatic budget (derived
  // from the server's context window at startup — the fallback budget
  // applies until that happens).
  const { config: cb1 } = parseConfig({
    DISCORD_TOKEN: "tok",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
  });
  assert.equal(cb1.model.compactionAuto, false, "unset = the default explicit budget");
  assert.equal(cb1.model.compactionMaxTokens, 4000);
  const { config: cb2, errors: cb2e } = parseConfig({
    DISCORD_TOKEN: "tok",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    CONTEXT_COMPACTION_MAX_TOKENS: "",
  });
  assert.deepEqual(cb2e, []);
  assert.equal(cb2.model.compactionAuto, true, "empty = automatic");
  assert.equal(cb2.model.compactionMaxTokens, 4000, "the fallback until the window is known");
  const { config: cb3 } = parseConfig({
    DISCORD_TOKEN: "tok",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    CONTEXT_COMPACTION_MAX_TOKENS: "12345",
  });
  assert.equal(cb3.model.compactionAuto, false);
  assert.equal(cb3.model.compactionMaxTokens, 12345);
  const { errors: cb4e } = parseConfig({
    DISCORD_TOKEN: "tok",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    CONTEXT_COMPACTION_MAX_TOKENS: "10",
  });
  assert.ok(cb4e.some((e) => e.includes("CONTEXT_COMPACTION_MAX_TOKENS")), `got: ${cb4e.join("; ")}`);
  ok("config: CONTEXT_COMPACTION_MAX_TOKENS (explicit, and empty = automatic budget)");
}

// ---------------------------------------------------------------- clear --
{
  const botId = "bot1";
  assert.equal(isClearCommand("!clear", botId), true);
  assert.equal(isClearCommand("  !clear  ", botId), true, "trimmed");
  assert.equal(isClearCommand("!CLEAR", botId), true, "case-insensitive");
  assert.equal(isClearCommand("<@bot1> !clear", botId), true, "a bot mention alongside still counts");
  assert.equal(isClearCommand("!cleared", botId), false);
  assert.equal(isClearCommand("please !clear the cache", botId), false, "only the bare command");
  assert.equal(isClearCommand("!reset", botId), false);
  assert.equal(isClearCommand("", botId), false);
  ok("clear: !clear detection (trimmed, case-insensitive, bot mentions stripped)");
}

// ------------------------------------------------------------- router --
{
  const botId = "bot1";
  const fakeMsg = (guildId: string | null, channelType: number, author: { id: string; bot: boolean }): Message =>
    ({
      author,
      guild: guildId === null ? null : { id: guildId },
      channel: { type: channelType },
    }) as unknown as Message;
  const human = { id: "user1", bot: false };
  const otherBot = { id: "bot2", bot: true };
  // empty guild id: any guild's text channel is trackable, DMs are not
  assert.equal(isTrackable(fakeMsg("123", ChannelType.GuildText, human), botId, ""), true);
  assert.equal(isTrackable(fakeMsg("999", ChannelType.GuildText, human), botId, ""), true, "another guild too");
  assert.equal(isTrackable(fakeMsg(null, ChannelType.GuildText, human), botId, ""), false, "DMs are never tracked");
  // a set guild id: only that guild is trackable
  assert.equal(isTrackable(fakeMsg("123", ChannelType.GuildText, human), botId, "123"), true);
  assert.equal(isTrackable(fakeMsg("999", ChannelType.GuildText, human), botId, "123"), false, "other guilds are ignored");
  assert.equal(isTrackable(fakeMsg(null, ChannelType.GuildText, human), botId, "123"), false, "DMs are never tracked");
  // other bots' messages are trackable too (labeled "(bot)" in the context);
  // our own messages are never tracked; voice channels are ignored
  assert.equal(isTrackable(fakeMsg("123", ChannelType.GuildText, otherBot), botId, ""), true, "other bots are tracked");
  assert.equal(isTrackable(fakeMsg("123", ChannelType.GuildText, { id: botId, bot: true }), botId, ""), false, "our own messages are never tracked");
  assert.equal(isTrackable(fakeMsg("123", ChannelType.GuildVoice, human), botId, ""), false, "voice channels are ignored");
  ok("router: isTrackable (empty guild id = any guild; DMs/voice never tracked, other bots tracked)");

  // A mention queues a turn from any author — a human's or another bot's
  // (the latter is what lets a bot's streamed reply ask the LLM for more).
  const withMentions = (bot: boolean, mentioned: boolean): Message =>
    ({
      author: { id: bot ? "bot2" : "user1", bot },
      mentions: { has: (id: string) => mentioned && id === botId },
    }) as unknown as Message;
  assert.equal(isMentionOf(withMentions(false, true), botId), true, "a human mention");
  assert.equal(isMentionOf(withMentions(true, true), botId), true, "another bot's mention queues a turn too");
  assert.equal(isMentionOf(withMentions(true, false), botId), false, "no mention, no turn");
  ok("router: isMentionOf works for any author (humans and other bots alike)");

  // The model's view of a mention of the bot: the mention is replaced by
  // the bot's Discord name (an empty replacement would make the mention
  // invisible to the model — it could not tell it was mentioned).
  assert.equal(replaceMentionText("<@bot1> hello", "bot1", "Glove"), "@Glove hello");
  assert.equal(replaceMentionText("hi <@!bot1>", "bot1", "Glove"), "hi @Glove");
  assert.equal(replaceMentionText("  <@bot1>  ", "bot1", "Glove"), "@Glove", "a bare mention leaves just the name (trimmed)");
  assert.equal(replaceMentionText("<@bot1> and <@bot1> again", "bot1", "Glove"), "@Glove and @Glove again", "every mention is replaced");
  assert.equal(replaceMentionText("<@user1> hello", "bot1", "Glove"), "<@user1> hello", "other users' mentions are untouched");
  assert.equal(replaceMentionText("hello", "bot1", "Glove"), "hello", "no mention: unchanged (still trimmed)");
  ok("router: replaceMentionText replaces the bot's mention with its Discord name (@Name)");
}

// ----------------------------------------------------------------- gate --
{
  // The stability gate, driven with an injected timer (no real sleeps): a
  // message commits exactly once, when it has been unchanged for the
  // window, carrying the latest (final) state it has seen. That is what
  // makes other bots' streamed replies (posted, then edited as the text
  // arrives) reach the LLM complete — and a mention only in the final
  // content queue exactly one turn.
  const fakeMsg = (id: string, channelId: string, content: string): GateMessage =>
    ({ id, channel: { id: channelId }, content }) as unknown as GateMessage;
  const makeTimers = () => {
    const live = new Map<number, () => void>();
    const cbs = new Map<number, () => void>();
    let seq = 0;
    const schedule = (fn: () => void, _ms: number): number => {
      const t = ++seq;
      cbs.set(t, fn);
      live.set(t, fn);
      return t;
    };
    const cancel = (t: number): void => {
      live.delete(t);
    };
    return { live, cbs, schedule, cancel };
  };

  // A fresh, unedited message commits once the window fires — and only
  // once (a stale re-firing of the timer is a no-op).
  {
    const fired: GateMessage[] = [];
    const timers = makeTimers();
    const gate = new MessageGate({
      stableMs: 2000,
      onCommit: (m) => fired.push(m),
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    const m = fakeMsg("1", "c1", "hello");
    gate.arrive(m);
    assert.equal(gate.isPending("1"), true);
    assert.equal(gate.size, 1);
    const [t0] = [...timers.live.keys()];
    timers.live.get(t0)!(); // the window elapsed with no edits
    assert.deepEqual(fired, [m], "committed exactly once, with the final state");
    assert.equal(gate.isPending("1"), false);
    assert.equal(gate.size, 0);
    timers.live.get(t0)!(); // re-firing the stale timer must not commit again
    assert.equal(fired.length, 1, "the commit is a no-op after the entry is gone");
  }
  ok("gate: a stable message commits exactly once with its final state");

  {
    const fired: GateMessage[] = [];
    const timers = makeTimers();
    const gate = new MessageGate({ stableMs: 2000, onCommit: (m) => fired.push(m), schedule: timers.schedule, cancel: timers.cancel });
    gate.arrive(fakeMsg("9", "c1", "earlier"));
    gate.arrive(fakeMsg("10", "c1", "@glove latest"));
    gate.arrive(fakeMsg("9", "c1", "earlier edited"));
    timers.cbs.get(2)!();
    assert.equal(fired.length, 0, "mention waits for earlier message to stabilize");
    timers.cbs.get(3)!();
    assert.deepEqual(fired.map((m) => m.content), ["earlier edited", "@glove latest"]);
    timers.cbs.get(1)!();
    assert.equal(fired.length, 2);
  }
  ok("gate: an earlier edited message commits before a newer stable mention");


  // Other bots stream their replies: posted as a placeholder, edited as the
  // text arrives. Every edit restarts the window (cancelling the old timer),
  // and the commit carries the final content — the mention only exists in
  // the final form, so it queues exactly one turn, not one per partial.
  {
    const fired: GateMessage[] = [];
    const timers = makeTimers();
    const gate = new MessageGate({
      stableMs: 2000,
      onCommit: (m) => fired.push(m),
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    const streamed = fakeMsg("9", "c1", ""); // the bot's placeholder
    gate.arrive(streamed);
    const t1 = [...timers.live.keys()][0];
    streamed.content = "Hel"; // streamed partial: the update handler refreshes
    gate.arrive(streamed);
    const t2 = [...timers.live.keys()].filter((t) => t !== t1)[0];
    streamed.content = "Hello, @glove, do the thing"; // the final edit
    gate.arrive(streamed);
    const t3 = [...timers.live.keys()].filter((t) => t !== t1 && t !== t2)[0];
    assert.equal(gate.isPending("9"), true, "still pending while it keeps being edited");
    assert.equal(timers.live.has(t1), false, "the first window was cancelled by the first edit");
    assert.equal(timers.live.has(t2), false, "the second window was cancelled by the final edit");
    assert.equal(fired.length, 0, "no partial content ever commits");
    timers.live.get(t3)!(); // the final edit's window fires: stable now
    assert.equal(fired.length, 1, "exactly one commit");
    assert.equal(fired[0], streamed);
    assert.equal(fired[0].content, "Hello, @glove, do the thing", "the commit carries the final content");
    assert.equal(gate.isPending("9"), false);
  }
  ok("gate: a streamed (edited-as-arriving) message commits once, with its final content");

  // A message deleted while pending never commits — even if its (cancelled)
  // timer fires anyway. A second drop is a no-op.
  {
    let committed = false;
    const cbs: Array<() => void> = [];
    const gate = new MessageGate({
      stableMs: 2000,
      onCommit: () => {
        committed = true;
      },
      // a no-op cancel: keep the callbacks reachable so the stale firing
      // below can prove the guard, not just the cancellation, works
      schedule: (fn) => {
        cbs.push(fn);
        return cbs.length;
      },
      cancel: () => {},
    });
    gate.arrive(fakeMsg("x", "c1", "gone soon"));
    assert.equal(gate.isPending("x"), true);
    assert.equal(gate.drop("x"), true, "a pending message is dropped");
    assert.equal(gate.drop("x"), false, "a second drop is a no-op");
    assert.equal(gate.drop("never-there"), false);
    cbs[0](); // the cancelled timer fires anyway: the guard keeps it out
    assert.equal(committed, false, "a dropped message never commits");
  }
  ok("gate: a message deleted while pending never commits");

  // Independence: messages commit individually; clearChannel forgets only
  // that channel's pending messages; clear() forgets everything.
  {
    const fired: string[] = [];
    const timers = makeTimers();
    const gate = new MessageGate({
      stableMs: 2000,
      onCommit: (m) => fired.push(m.id),
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    const a = fakeMsg("a", "c1", "A");
    const b = fakeMsg("b", "c1", "B");
    const d = fakeMsg("d", "c2", "D");
    gate.arrive(a);
    gate.arrive(b);
    gate.arrive(d);
    assert.equal(gate.size, 3);
    const [ta, _tb, td] = [...timers.live.keys()];
    timers.live.get(ta)!(); // only a's window fires
    assert.deepEqual(fired, ["a"], "each message commits on its own window");
    gate.clearChannel("c1");
    assert.equal(gate.isPending("b"), false, "b's channel was cleared");
    assert.equal(gate.isPending("d"), true, "another channel is untouched");
    gate.clear();
    assert.equal(gate.size, 0, "clear() forgets everything");
    timers.cbs.get(td)!(); // d's cancelled timer fires anyway: no commit
    assert.deepEqual(fired, ["a"], "cleared messages never commit");
  }
  ok("gate: per-message commits; clearChannel/clear forget pending messages without committing");
}

// ----------------------------------------------------------------- quiet --
{
  // The channel-activity tracker (driven with an injected clock and sleeper
  // — no real waiting): a channel is quiet once it has been unchanged for
  // the window, a change while waiting restarts the window, and a running
  // turn watches the channel to abort its in-flight model request on any
  // change (the prompt-interruption feature, see index.ts).
  const makeClock = () => {
    let t = 1000;
    const sleepers: Array<() => void> = [];
    const now = (): number => t;
    // A sleep jumps the clock to its deadline; wake() lets the sleeper on.
    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        t += ms;
        sleepers.push(resolve);
      });
    const wake = (): void => {
      for (const r of sleepers.splice(0)) r();
    };
    return { now, sleep, wake };
  };

  // A change resolves once the channel stays unchanged for the window; a
  // channel with no recorded activity is already quiet.
  {
    const clock = makeClock();
    const a = new ChannelActivity({ now: clock.now, sleep: clock.sleep });
    await a.waitForQuiet("never-seen", 5000); // already quiet
    a.note("c1"); // activity at t=1000
    const p = a.waitForQuiet("c1", 5000);
    assert.equal(clock.now(), 6000, "the wait runs to the deadline (1000 + 5000)");
    await clock.wake();
    await p;
    assert.equal(clock.now(), 6000, "no further waiting once the window elapsed");
  }
  ok("quiet: the channel is quiet once it stays unchanged for the window (no-activity channels are quiet at once)");

  // Activity while waiting restarts the window from the newest change.
  {
    const clock = makeClock();
    const a = new ChannelActivity({ now: clock.now, sleep: clock.sleep });
    a.note("c1"); // activity at t=1000
    const p = a.waitForQuiet("c1", 5000); // the first window sleeps to t=6000
    a.note("c1"); // a new change while the wait is pending: the window restarts at 6000
    await clock.wake(); // the first sleep elapses; the tracker sees the newer change
    assert.equal(clock.now(), 11000, "the window restarted at the newest change (6000 + 5000)");
    await clock.wake(); // the restarted window elapses
    await p;
    assert.equal(clock.now(), 11000, "no further waiting once the window elapsed");
  }
  ok("quiet: activity while waiting restarts the window");

  // A watcher fires on every change for its channel (a running turn uses it
  // to abort the in-flight model request); the unsubscribe stops it.
  {
    const a = new ChannelActivity();
    let fired = 0;
    const unwatch = a.watch("c1", () => fired++);
    a.note("c1");
    a.note("c2"); // another channel does not fire c1's watcher
    assert.equal(fired, 1);
    unwatch();
    a.note("c1");
    assert.equal(fired, 1, "an unwatched channel no longer fires");
    // A watcher that unsubs itself while firing does not break the loop.
    let self = 0;
    const unSelf = a.watch("c3", () => {
      self++;
      unSelf();
    });
    a.note("c3");
    assert.equal(self, 1);
  }
  ok("quiet: watchers fire per channel and unsubscribe cleanly");

  // clearChannel forgets one channel (state and watchers); clear() forgets
  // everything (a deleted channel's turn must not keep waiting).
  {
    const clock = makeClock();
    const a = new ChannelActivity({ now: clock.now, sleep: clock.sleep });
    a.note("c1");
    a.note("c2");
    a.clearChannel("c1");
    await a.waitForQuiet("c1", 5000); // forgotten: quiet at once
    assert.equal(clock.now(), 1000, "no waiting for a cleared channel");
    a.clear();
    await a.waitForQuiet("c2", 5000);
    assert.equal(clock.now(), 1000, "clear() forgets everything");
  }
  ok("quiet: clearChannel/clear forget the channel's state");
}

// --------------------------------------------------------------- chime --
{
  // The chime decision (driven with a fake client — no HTTP): the model sees
  // the system prompt + the transcript and reports the decision as a call of
  // the chime tool (respond + reason). Text and failed calls stay silent.
  const transcript: ChatMessage[] = [
    { role: "user", content: "Alice: hi" },
    { role: "user", content: "Bob (bot): should we ship it?" },
  ];
  const toolChat = (args: Record<string, unknown>): ChimeChat => async () => ({
    content: "",
    toolCalls: [{ id: "t1", name: "chime", arguments: JSON.stringify(args) }],
  });
  const textChat = (content: string, fail = false): ChimeChat => async () => {
    if (fail) throw new Error("llm down");
    return { content, toolCalls: [] };
  };
  assert.deepEqual(await decideChime(toolChat({ respond: true, reason: "direct question" }), transcript),
    { respond: true, reason: "direct question" });
  assert.deepEqual(await decideChime(toolChat({ respond: false, reason: "just chatter" }), transcript),
    { respond: false, reason: "just chatter" });
  assert.deepEqual(await decideChime(toolChat({ respond: "yes", reason: "asks about me" }), transcript),
    { respond: true, reason: "asks about me" }, "a string 'yes' decides");
  assert.deepEqual(await decideChime(toolChat({ respond: "no", reason: "off topic" }), transcript),
    { respond: false, reason: "off topic" }, "a string 'no' decides");
  assert.equal(await decideChime(toolChat({ reason: "no flag" }), transcript), null, "a missing respond flag stays silent");
  assert.deepEqual(await decideChime(toolChat({ respond: false }), transcript),
    { respond: false, reason: "" }, "a missing reason is tolerated");
  for (const answer of ["YES — direct question", "NO chatter", "**YES**", "maybe", "",
    '{"respond":true,"reason":"question"}', '```json\n{"respond":false}\n```']) {
    assert.equal(await decideChime(textChat(answer), transcript), null, "text never decides");
  }
  assert.equal(await decideChime(textChat("", true), transcript), null);
  ok("chime: only tool calls decide; text, JSON and failed calls stay silent");
  assert.equal(await decideChime(async () => ({ content: "", reasoning: "YES", toolCalls: [] }), transcript), null);
  assert.equal(await decideChime(async () => ({ content: "YES", toolCalls: [{ id: "t", name: "other", arguments: '{"respond":true}' }] }), transcript), null);
  assert.equal(await decideChime(async () => ({ content: "NO chatter", toolCalls: [{ id: "t", name: "chime", arguments: "broken" }] }), transcript), null);
  ok("chime: unrelated tools, reasoning and text beside broken arguments never decide");

  // The normal request shares schemas; a broken decision gets a required, chime-only repair.
  for (const first of ["empty", "invalid", "multiple", "unrelated"] as const) {
    const requests: Array<{ messages: ChatMessage[]; tools?: ToolSpec[]; choice?: string; maxTokens?: number }> = [];
    const recovered = await decideChime(async (messages, tools, signal, options) => {
      requests.push({ messages, tools, choice: options?.toolChoice, maxTokens: options?.maxTokens });
      if (requests.length === 1) {
        if (first === "unrelated") return { content: "", toolCalls: [{ id: "unrelated", name: "file_read", arguments: "{}" }] };
        if (first === "multiple") return { content: "", toolCalls: [
          { id: "1", name: "chime", arguments: '{"respond":true}' },
          { id: "2", name: "chime", arguments: '{"respond":false}' },
        ] };
        return { content: first === "empty" ? "" : "maybe", toolCalls: [] };
      }
      return { content: "", toolCalls: [{ id: "fixed", name: "chime", arguments: '{"respond":false,"reason":"chatter"}' }] };
    }, transcript, undefined, undefined, undefined, undefined, chimeTools([{ name: "file_read", description: "read", parameters: {} }]));
    assert.deepEqual(requests[0].tools?.map(tool => tool.name), ["file_read", "chime"]);
    assert.deepEqual(recovered, { respond: false, reason: "chatter" });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].choice, "auto");
    assert.deepEqual(requests[1].tools, [CHIME_TOOL_SPEC]);
    assert.equal(requests[1].choice, "required");
    assert.equal(requests[0].maxTokens, CHIME_MAX_TOKENS);
    assert.equal(requests[1].maxTokens, CHIME_MAX_TOKENS, "repair also bounds generation");
    assert.deepEqual(requests[1].messages.slice(0, -1), requests[0].messages, "repair preserves the message prefix");
  }
  let attempts = 0;
  assert.equal(await decideChime(async () => { attempts++; return { content: "maybe", toolCalls: [] }; }, transcript), null);
  assert.equal(attempts, 2, "unusable decisions stop after one repair");
  for (const failure of [new Error("HTTP 400: tool_choice unsupported"), new Error("HTTP 422: tools unsupported"), new Error("model endpoint returned HTTP 401: unauthorized"), new Error("model request timed out"), new Error("HTTP 500: unavailable")]) {
    attempts = 0;
    assert.equal(await decideChime(async () => { attempts++; throw failure; }, transcript), null);
    assert.equal(attempts, 1, "outages and timeouts are not multiplied");
  }
  for (const failure of [new InterruptedError(), new Error("request (9000 tokens) exceeds the available context size (8000 tokens)")]) {
    attempts = 0;
    await assert.rejects(decideChime(async () => {
      if (++attempts === 1) return { content: "maybe", toolCalls: [] };
      throw failure;
    }, transcript), err => err === failure);
    assert.equal(attempts, 2, "repair propagates interruption/overflow to the turn runner");
  }
  ok("chime: validated decisions repair once, reject conflicts, preserve the prefix and propagate cancellation/overflow");

  // The decision instruction follows the shared context; chime is on the wire.
  let sent: ChatMessage[] = [];
  let sentTools: ToolSpec[] | undefined;
  const spying: ChimeChat = async (msgs, tools) => {
    sent = msgs;
    sentTools = tools;
    return { content: "", toolCalls: [{ id: "t1", name: "chime", arguments: '{"respond":false,"reason":"chatter"}' }] };
  };
  assert.deepEqual(await decideChime(spying, transcript), { respond: false, reason: "chatter" });
  assert.equal(sent.length, transcript.length + 1);
  assert.equal(sent.at(-1)!.role, "user");
  assert.equal(sent.at(-1)!.content, CHIME_SYSTEM_PROMPT);
  assert.deepEqual(sent.slice(0, -1), transcript);
  assert.deepEqual(sentTools, [CHIME_TOOL_SPEC]);
  ok("chime: the decision is one call (shared context + decision instruction) with the chime tool on the wire");

  let customCalls = 0;
  await decideChime(async (msgs) => {
    assert.equal(msgs[transcript.length].content, "Custom chime\nSecond line");
    customCalls++;
    return { content: customCalls === 1 ? "invalid" : "NO chatter", toolCalls: [] };
  }, transcript, undefined, undefined, undefined, "Custom chime\nSecond line");
  assert.equal(customCalls, 2, "custom prompt also reaches the repair request");
  await decideChime(spying, transcript, undefined, undefined, undefined, "  ");
  assert.equal(sent.at(-1)!.content, CHIME_SYSTEM_PROMPT);

  // The NO line posted to the channel: a UI line with the reason, truncated.
  assert.equal(formatChimeNo("just chatter"), "🔕 *chime: no — just chatter*");
  assert.equal(formatChimeNo(""), "🔕 *chime: no*");
  assert.ok(formatChimeNo("x".repeat(300)).includes("…"), "long reasons are truncated");
  assert.ok(formatChimeNo("multi\nline reason").includes("multi line reason"), "newlines collapse to spaces");
  ok("chime: the NO line is a UI line with the (truncated) reason");

  // An interrupted decision call (the channel changed while the decision was
  // in flight) is re-thrown, not swallowed into a silent NO: the turn waits
  // for the channel to go quiet and retries the decision.
  {
    const interrupting: ChimeChat = async () => {
      throw new InterruptedError();
    };
    await assert.rejects(decideChime(interrupting, transcript), InterruptedError);
    // The signal rides along to the decision call.
    let seenSignal: AbortSignal | undefined;
    const signalChat: ChimeChat = async (_msgs, _tools, signal) => {
      seenSignal = signal;
      return { content: "", toolCalls: [] };
    };
    const ctrl = new AbortController();
    await decideChime(signalChat, transcript, ctrl.signal);
    assert.equal(seenSignal, ctrl.signal);
  }
  ok("chime: an interrupted decision is re-thrown (the turn retries); the signal rides along");

  // A context-overflow rejection (the transcript outgrew the model's window
  // since the last measurement — the endpoint's 400, llama.cpp's exact
  // shape) is re-thrown like an interruption: the turn shrinks the context
  // and retries the decision once. A non-overflow failure above stays null.
  {
    const overflowing: ChimeChat = async () => {
      throw new Error(
        'model endpoint returned HTTP 400 : {"error":{"code":400,"message":"request (51000 tokens) exceeds the available context size (48000 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":51000,"n_ctx":48000}}',
      );
    };
    await assert.rejects(
      decideChime(overflowing, transcript),
      (err: unknown) => err instanceof Error && /exceeds the available context size/.test(err.message),
    );
  }
  ok("chime: a context-overflow rejection is re-thrown (the turn shrinks and retries once)");
}

// Shared tool schemas must not turn reply decisions into executable rounds.
{
  const trigger: ChatMessage[] = [{ role: "user", content: "Alice: @Glove should you respond?" }];
  const decision = { id: "d", name: "chime", arguments: '{"respond":false,"reason":"quiet"}' };
  const write = { id: "w", name: "write", arguments: "{}" };
  for (const mixed of [false, true]) {
    let requests = 0;
    let executions = 0;
    let repairs = 0;
    let recorded = 0;
    const registry = new ToolRegistry().register({ name: "write", description: "write", parameters: {} }, async () => {
      executions++;
      return "saved";
    });
    const messages = structuredClone(trigger);
    const tokens = new TurnTokens();
    const chat = chimeReplyChat(tokens.track(async (msgs, _cbs, tools) => {
      requests++;
      assert.ok(!msgs.some(m => m.toolCalls?.some(c => c.name === "chime")), "virtual decisions never enter history");
      if (requests === 1) {
        assert.deepEqual(tools?.map(t => t.name), ["write", "chime"]);
        return { content: "", toolCalls: mixed ? [decision, write] : [decision], usage: { input: 10, output: 2 } };
      }
      if (!mixed && requests === 2) {
        assert.deepEqual(tools, registry.specs(), "repair hides the virtual tool");
        assert.deepEqual(msgs.slice(0, -1), trigger);
        return { content: "", toolCalls: [write], usage: { input: 10, output: 2 } };
      }
      return { content: "saved your file", toolCalls: [], usage: { input: 10, output: 2 } };
    }), async () => { repairs++; });
    const outcome = await runToolTurn(messages, { registry, maxRounds: 1, chat,
      onToolCalls: calls => { assert.deepEqual(calls, [write]); },
      onRoundComplete: round => { recorded++; assert.deepEqual(round.calls, [write]); },
    });
    assert.equal(outcome.content, "saved your file");
    assert.equal(outcome.exhausted, false);
    assert.equal(executions, 1, "the real write executes exactly once");
    assert.equal(recorded, 1);
    assert.equal(outcome.toolRounds, 1, "virtual decisions consume no tool budget");
    assert.equal(repairs, mixed ? 0 : 1);
    assert.equal(tokens.calls, requests, "every repair is accounted separately");
    assert.equal(tokens.input, requests * 10);
    assert.equal(messages.length, 3, "only trigger and real tool round enter history");
  }
  ok("chime reply: decision-only and mixed calls never execute chime or replay real tools");

  let requests = 0;
  let repairs = 0;
  const answerChat = chimeReplyChat(async () => {
    requests++;
    return { content: "Here is the answer", reasoning: "thinking", toolCalls: [decision] };
  }, async () => { repairs++; });
  assert.deepEqual(await answerChat(trigger), { content: "Here is the answer", reasoning: "thinking", toolCalls: [] });
  assert.equal(requests, 1);
  assert.equal(repairs, 0, "text already streamed is preserved without duplicate delivery");
  requests = 0;
  await assert.rejects(chimeReplyChat(async () => {
    requests++;
    return { content: "", toolCalls: [decision] };
  })(trigger), /did not provide a reply/);
  assert.equal(requests, 2, "a model ignoring repair cannot loop forever");
  assert.deepEqual(trigger, [{ role: "user", content: "Alice: @Glove should you respond?" }]);
  ok("chime reply: keeps existing answers, bounds failed repairs and never mutates the trigger");

  const rejection = new Error("model endpoint returned HTTP 400 Bad Request: tools are not supported");
  requests = 0;
  const compatibilityChat = chimeReplyChat(async (_m, _c, tools) => {
    requests++;
    if (tools) throw rejection;
    return { content: "mention answered", toolCalls: [] };
  });
  assert.equal((await compatibilityChat(trigger)).content, "mention answered");
  assert.equal(requests, 2);
  assert.equal((await compatibilityChat(trigger)).content, "mention answered");
  assert.equal(requests, 3, "remember the rejection within this attempt");
  requests = 0;
  await assert.rejects(chimeReplyChat(async () => { requests++; throw rejection; })(trigger), err => err === rejection);
  assert.equal(requests, 2, "compatibility fallback is bounded too");
  ok("chime reply: tool-free endpoints can answer mentions with one compatibility fallback");

  for (const failure of [
    new InterruptedError(),
    new Error("model request timed out"),
    new Error("model endpoint returned HTTP 500: tools unsupported"),
    new Error("model endpoint returned HTTP 401: tools unsupported"),
    new Error("model endpoint returned HTTP 400: malformed message"),
    new Error("model endpoint returned HTTP 400: tools unsupported; request (9000 tokens) exceeds the available context size (8000 tokens)"),
  ]) {
    requests = 0;
    await assert.rejects(chimeReplyChat(async () => { requests++; throw failure; })(trigger), err => err === failure);
    assert.equal(requests, 1, "only explicit tool compatibility failures are retried");
    requests = 0;
    await assert.rejects(chimeReplyChat(async () => {
      if (++requests === 1) return { content: "", toolCalls: [decision] };
      throw failure;
    })(trigger), err => err === failure);
    assert.equal(requests, 2, "repair errors propagate without further retries");
  }
  requests = 0;
  await assert.rejects(chimeReplyChat(async () => { requests++; throw rejection; })(trigger,
    undefined, [{ name: "write", description: "write", parameters: {} }]), err => err === rejection);
  assert.equal(requests, 1, "never disable configured executable tools on a compatibility error");
  ok("chime reply: cancellation, overflow, outages and configured tool failures propagate");
}

// ----------------------------------------------------------------- split --
{
  assert.deepEqual(splitForDiscord(""), []);
  assert.deepEqual(splitForDiscord("hi"), ["hi"]);
  const exact = "a".repeat(2000);
  assert.deepEqual(splitForDiscord(exact), [exact]);
  const over = "a".repeat(2001);
  const c = splitForDiscord(over);
  assert.ok(c.length >= 2);
  assert.ok(c.every((x) => x.length <= 2000));
  ok("split: basic size limits");

  const longLine = "x".repeat(5000);
  const c2 = splitForDiscord(`pre\n${longLine}\npost`);
  assert.ok(c2.every((x) => x.length <= 2000));
  // the splitter only ever adds newlines (and fence tokens); with none present
  // here, stripping newlines must restore the exact original text
  assert.equal(c2.join("\n").replace(/\n/g, ""), `pre${longLine}post`);
  ok("split: oversized single line hard-split, content preserved");

  // Code fence that spans multiple chunks: every chunk must have balanced
  // fences and the code lines must remain in order.
  const codeLines = Array.from({ length: 100 }, (_, i) => `code line ${String(i).padStart(3, "0")} ${"y".repeat(40)}`);
  const text = ["intro", "```ts", ...codeLines, "```", "outro"].join("\n");
  assert.ok(text.length > 4000);
  const c3 = splitForDiscord(text);
  assert.ok(c3.length >= 3, `expected >= 3 chunks, got ${c3.length}`);
  for (const chunk of c3) {
    assert.ok(chunk.length <= 2000, `chunk too long: ${chunk.length}`);
    const fenceLines = chunk.split("\n").filter((l) => /^\s*(`{3,}|~{3,})/.test(l)).length;
    assert.equal(fenceLines % 2, 0, `unbalanced fences in chunk: ${JSON.stringify(chunk.slice(0, 60))}`);
  }
  const allCode = c3.join("\n").replace(/\n/g, "");
  let lastIdx = -1;
  for (const cl of codeLines) {
    const i = allCode.indexOf(cl);
    assert.ok(i >= 0 && i > lastIdx, "code line missing or out of order");
    lastIdx = i;
  }
  ok("split: code fence closed/reopened across chunks, lines in order");

  // Regression: a chunk boundary inside a fence must reserve room for the
  // closing token (emit() appends it), so no chunk may exceed maxChars.
  const tightFence = "```ts\n" + "a".repeat(1994) + "\nb";
  const c4 = splitForDiscord(tightFence);
  assert.ok(c4.every((x) => x.length <= 2000), `oversized chunk: ${c4.map((x) => x.length).join(",")}`);
  const tightFence2 = "~~~~\n" + "b".repeat(1995) + "\n";
  const c5 = splitForDiscord(tightFence2);
  assert.ok(c5.every((x) => x.length <= 2000), `oversized chunk: ${c5.map((x) => x.length).join(",")}`);

  // A carried-over tail + a fence-opener line must leave room for the closing
  // token: the carry check used to allow suffix+line == maxChars, then emit()
  // appended the token (maxChars+4) -> Discord 400, tail of reply lost.
  const carryOpener = "\n" + "x".repeat(1994) + "\n```ts";
  const c6 = splitForDiscord(carryOpener);
  assert.ok(c6.every((x) => x.length <= 2000), `oversized chunk: ${c6.map((x) => x.length).join(",")}`);
  const c7 = splitForDiscord(carryOpener + "\n" + "y".repeat(500));
  assert.ok(c7.every((x) => x.length <= 2000), `oversized chunk: ${c7.map((x) => x.length).join(",")}`);
  ok("split: fence-boundary chunks never exceed maxChars (closing token accounted for)");

  // A table that fits in one chunk is never split across messages, even
  // when the preceding text fills the chunk.
  const row = (tag: string, fill: number): string => `| ${tag} | ${"z".repeat(fill)} |`;
  const table1 = ["| A | B |", "| --- | --- |", row("r1", 200), row("r2", 200), row("r3", 200)];
  const text1 = ["p".repeat(1800), ...table1].join("\n");
  const tblChunks = splitForDiscord(text1);
  assert.ok(tblChunks.every((x) => x.length <= 2000));
  const t1 = tblChunks.filter((c) => c.includes("| A | B |"));
  assert.equal(t1.length, 1, "table header appears in exactly one chunk");
  assert.ok(t1[0].includes(row("r3", 200)), "whole table in that chunk");
  ok("split: table that fits in a chunk is kept whole");

  // A table longer than one chunk is split row-wise, repeating the header.
  const body = Array.from({ length: 30 }, (_, i) => row(`r${String(i).padStart(2, "0")}`, 120));
  const text2 = ["| A | B |", "| --- | --- |", ...body].join("\n");
  const bigChunks = splitForDiscord(text2);
  assert.ok(bigChunks.length >= 2, "big table spans several chunks");
  assert.ok(bigChunks.every((x) => x.length <= 2000));
  for (const c of bigChunks) {
    assert.ok(c.includes("| A | B |") && c.includes("| --- | --- |"), "each part repeats the header");
  }
  const flat = bigChunks.join("\n");
  let lastBigIdx = -1;
  for (const r of body) {
    const i = flat.indexOf(r, lastBigIdx + 1);
    assert.ok(i > lastBigIdx, `row out of order: ${r.slice(0, 20)}`);
    lastBigIdx = i;
  }
  ok("split: oversized table splits row-wise with repeated header");

  // Prose breaks prefer block boundaries (blank lines, headings, lists);
  // the carried-over tail starts the next chunk without leading blanks.
  const L = (ch: string, n: number): string => `${ch} ${ch.repeat(n)}`;
  const text3 = [L("a", 40), "", L("b", 40), "", L("c", 40), "", L("d", 40)].join("\n");
  const paraChunks = splitForDiscord(text3, 100);
  assert.ok(paraChunks.every((x) => x.length <= 100));
  assert.deepEqual(paraChunks, [
    `${L("a", 40)}\n\n${L("b", 40)}`,
    `${L("c", 40)}\n\n${L("d", 40)}`,
  ]);
  assert.equal(
    paraChunks.join("\n").replace(/\n/g, ""),
    text3.replace(/\n/g, ""),
    "content preserved",
  );
  ok("split: prose breaks at block boundaries, no leading blank chunks");

  // A heading right before a table stays with the table.
  const text5 = ["q".repeat(1800), "", "Summary Table", "| A | B |", "| --- | --- |", row("x", 200)].join("\n");
  const headChunks = splitForDiscord(text5);
  assert.ok(headChunks.every((x) => x.length <= 2000));
  assert.ok(headChunks.length >= 2);
  const lastChunk = headChunks[headChunks.length - 1];
  assert.ok(lastChunk.startsWith("Summary Table"), "heading carried into the table chunk");
  assert.ok(lastChunk.includes("| A | B |") && lastChunk.includes(row("x", 200)), "table whole in same chunk");
  ok("split: heading before a table stays with the table");

  const sec = ["# H", "x".repeat(60), "", "y".repeat(60), "z".repeat(60)].join("\n");
  const secChunks = splitForDiscord(sec, 100);
  assert.ok(secChunks.every((x) => x.length <= 100));
  assert.ok(secChunks[0].startsWith("# H") && secChunks[0].includes("x".repeat(60)), "heading keeps its paragraph");
  assert.equal(secChunks.join("\n").replace(/\n/g, ""), sec.replace(/\n/g, ""), "content preserved");
  ok("split: heading stays with its paragraph");

  // firstMaxChars (the activity message's room): the FIRST chunk is capped
  // to it — so a text streamed inside the message never pushes the message
  // past 2000 — while every chunk after the first uses the normal limit.
  const room = 1975;
  const capChunks = splitForDiscord("a".repeat(2500), 2000, room);
  assert.deepEqual(capChunks.map((c) => c.length), [room, 2500 - room], "first chunk capped to the room, the rest normal");
  // A single line longer than the room but shorter than a full chunk is
  // hard-split with the first piece under the cap.
  const midLine = "b".repeat(1990);
  const midChunks = splitForDiscord(midLine, 2000, room);
  assert.deepEqual(midChunks.map((c) => c.length), [room, 1990 - room], "mid-length line honors the first cap");
  // A fence that spans the first-chunk boundary: the closing token is still
  // accounted for inside the capped first chunk.
  const capFence = ["```ts", "c".repeat(room - 6), "d".repeat(300)].join("\n");
  const capFenceChunks = splitForDiscord(capFence, 2000, room);
  assert.ok(capFenceChunks.every((x) => x.length <= 2000), `no oversized chunk: ${capFenceChunks.map((x) => x.length).join(",")}`);
  assert.ok(capFenceChunks[0].length <= room, "the capped first chunk keeps its cap across a fence boundary");
  for (const c of capFenceChunks) {
    const fenceLines = c.split("\n").filter((l) => /^\s*(`{3,}|~{3,})/.test(l)).length;
    assert.equal(fenceLines % 2, 0, `unbalanced fences in chunk: ${JSON.stringify(c.slice(0, 40))}`);
  }
  // Text that fits the room is never split (even though it fits 2000).
  assert.deepEqual(splitForDiscord("e".repeat(room), 2000, room), ["e".repeat(room)]);
  assert.deepEqual(splitForDiscord("e".repeat(room + 1), 2000, room).map((c) => c.length), [room, 1]);
  ok("split: firstMaxChars caps the first chunk (the activity message's room)");
}

// --------------------------------------------------------------- format --
{
  // Non-math text (incl. prices) is untouched.
  assert.equal(sanitizeForDiscord("plain text, no math"), "plain text, no math");
  assert.equal(sanitizeForDiscord("costs $5 and $10 total"), "costs $5 and $10 total");
  // Inline math -> Unicode.
  assert.equal(sanitizeForDiscord("$\\uparrow$"), "↑");
  assert.equal(sanitizeForDiscord("PGC-1$\\alpha$"), "PGC-1α");
  assert.equal(sanitizeForDiscord("$\\text{H}^+$"), "H⁺");
  assert.equal(sanitizeForDiscord("$\\text{VO}_2 \\text{max}$"), "VO₂ max");
  assert.equal(sanitizeForDiscord("$a \\le b \\land c \\neq d$"), "a ≤ b ∧ c ≠ d");
  assert.equal(sanitizeForDiscord("$x_1 + x_2$"), "x₁ + x₂");
  assert.equal(sanitizeForDiscord("$\\frac{a}{b}$"), "a/b");
  assert.equal(sanitizeForDiscord("$\\sqrt{x}$"), "√x");
  // Unmapped sub/superscript characters keep the original span (the marker
  // is not dropped: a_b must not become ab, and a partial mix like xₐb is
  // worse than the source).
  assert.equal(sanitizeForDiscord("$a_b$"), "a_b");
  assert.equal(sanitizeForDiscord("$x^y$"), "x^y");
  // (braces are dropped by the leftover-braces cleanup, the text is not)
  assert.equal(sanitizeForDiscord("$x_{ab}$"), "x_ab");
  assert.equal(sanitizeForDiscord("$a_{b1}$"), "a_b1");
  // Display math and noise commands.
  assert.equal(sanitizeForDiscord("$$\\text{VO}_2 = \\text{CO} \\times a$$"), "VO₂ = CO × a");
  assert.equal(sanitizeForDiscord("$\\label{eq1} y$"), "y");
  ok("format: LaTeX math converted to Unicode, non-math $ left alone");
}

// --------------------------------------------------------------- images --
{
  // Production URL validation: only https on Discord's own CDN is trusted.
  assert.equal(isDiscordCdnUrl("https://cdn.discordapp.com/attachments/1/2/3/x.png"), true);
  assert.equal(isDiscordCdnUrl("http://cdn.discordapp.com/attachments/1/2/3/x.png"), false, "http refused");
  assert.equal(isDiscordCdnUrl("https://evil.example.com/attachments/x.png"), false, "other hosts refused");
  assert.equal(isDiscordCdnUrl("not a url"), false);
  // Without an injected fetch, a non-CDN URL is refused before any network call.
  const nonCdn = await fetchMessageImages(
    [{ url: "https://evil.example.com/x.png", name: "x.png", size: 10, contentType: "image/png" }],
    1024,
  );
  assert.equal(nonCdn.images.length, 0);
  assert.match(nonCdn.notes[0], /not a discord attachment/);
  ok("images: only https Discord-CDN URLs are trusted");

  const att = (over: Partial<MessageAttachmentLike> = {}): MessageAttachmentLike => ({
    url: "https://cdn.discordapp.com/attachments/1/2/3/img.png",
    name: "img.png",
    size: 3,
    contentType: "image/png",
    ...over,
  });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const fetchImpl: ImageFetch = () => Promise.resolve(new Response(bytes));

  // Success: a base64 data URI with the right MIME.
  const ok1 = await fetchMessageImages([att()], 1024, { fetchImpl });
  assert.equal(ok1.images.length, 1);
  assert.equal(ok1.images[0].url, `data:image/png;base64,${bytes.toString("base64")}`);
  assert.deepEqual(ok1.notes, []);
  // Unsupported type -> note, no download.
  const ok2 = await fetchMessageImages([att({ name: "x.bmp", contentType: "image/bmp" })], 1024, { fetchImpl });
  assert.equal(ok2.images.length, 0);
  assert.match(ok2.notes[0], /unsupported type image\/bmp/);
  // Declared size over the cap -> note, no download.
  const ok3 = await fetchMessageImages([att({ name: "big.png", size: 2048 })], 1024, { fetchImpl });
  assert.equal(ok3.images.length, 0);
  assert.match(ok3.notes[0], /2 KB exceeds the 1 KB limit/);
  // Declared small but actually over the cap -> note after the download.
  const ok4 = await fetchMessageImages([att({ name: "lie.png", size: 1 })], 2, { fetchImpl });
  assert.equal(ok4.images.length, 0);
  assert.match(ok4.notes[0], /exceeds/);
  // Non-2xx and thrown fetch failures become notes, never exceptions.
  const ok5 = await fetchMessageImages([att()], 1024, {
    fetchImpl: () => Promise.resolve(new Response("nope", { status: 404 })),
  });
  assert.equal(ok5.images.length, 0);
  assert.match(ok5.notes[0], /download failed \(HTTP 404\)/);
  const ok6 = await fetchMessageImages([att()], 1024, {
    fetchImpl: () => Promise.reject(new Error("dns down")),
  });
  assert.equal(ok6.images.length, 0);
  assert.match(ok6.notes[0], /download failed/);
  // More than the per-message cap: the rest are noted.
  const ok7 = await fetchMessageImages(
    [att({ name: "a.png" }), att({ name: "b.png" }), att({ name: "c.png" }), att({ name: "d.png" }), att({ name: "e.png" })],
    1024,
    { fetchImpl },
  );
  assert.equal(ok7.images.length, 4);
  assert.equal(ok7.notes.length, 1);
  assert.match(ok7.notes[0], /more than 4 images per message/);
  ok("images: data URIs, type/size/HTTP failures become notes, per-message cap");

  // skipNonImages (file contents enabled): non-image attachments are the
  // file pipeline's job — skipped silently (no "unsupported type" note) and
  // not counted against the per-message image cap. The default keeps the
  // classic note.
  const skip = await fetchMessageImages(
    [
      att({ name: "notes.md", contentType: "text/markdown" }),
      att(),
      att(),
      att(),
      att(),
      att({ name: "x.md", contentType: "text/markdown" }),
    ],
    1024,
    { fetchImpl, skipNonImages: true },
  );
  assert.equal(skip.images.length, 4);
  assert.deepEqual(skip.notes, []);
  const skipOff = await fetchMessageImages(
    [att({ name: "notes.md", contentType: "text/markdown" })],
    1024,
    { fetchImpl },
  );
  assert.match(skipOff.notes[0], /unsupported type text\/markdown/);
  ok("images: skipNonImages leaves non-image attachments to the file pipeline");
}

// ----------------------------------------------------------------- files --
{
  const att = (over: Partial<MessageAttachmentLike> = {}): MessageAttachmentLike => ({
    url: "https://cdn.discordapp.com/attachments/1/2/3/notes.md",
    name: "notes.md",
    size: 11,
    contentType: "text/markdown",
    ...over,
  });
  const fetchImpl: FileFetch = () => Promise.resolve(new Response(Buffer.from("# Notes\nbody")));

  // Binary filter: valid UTF-8 without NUL bytes is text; NUL, invalid
  // UTF-8, and empty buffers are not.
  assert.equal(isProbablyText(Buffer.from("hello")), true);
  assert.equal(isProbablyText(Buffer.from([0x00, 0x01])), false, "NUL byte");
  assert.equal(isProbablyText(Buffer.from([0xff, 0xfe, 0x80])), false, "invalid UTF-8");
  assert.equal(isProbablyText(Buffer.alloc(0)), false, "empty");
  // The fence grows past any backtick run in the content (it cannot escape).
  assert.equal(fenceFor("no backticks"), "```");
  assert.equal(fenceFor("a ``` b"), "````");
  assert.equal(fenceFor("````x````"), "`````");
  ok("files: binary filter and fence sizing");

  // Production URL validation: only https Discord-CDN URLs are trusted
  // (same as images), checked before any network call.
  const nonCdn = await fetchMessageFiles(
    [att({ url: "https://evil.example.com/notes.md" })],
    1024,
  );
  assert.equal(nonCdn.files.length, 0);
  assert.match(nonCdn.notes[0], /not a discord attachment/);
  // Image attachments belong to the image pipeline: ignored entirely here
  // (no files, no notes).
  const imgOnly = await fetchMessageFiles(
    [{ url: "https://cdn.discordapp.com/attachments/1/2/3/i.png", name: "i.png", size: 10, contentType: "image/png" }],
    1024,
    { fetchImpl },
  );
  assert.equal(imgOnly.files.length, 0);
  assert.deepEqual(imgOnly.notes, []);
  ok("files: only https Discord-CDN URLs are trusted, image attachments ignored");

  // Success: a labeled, fenced block; the header carries the name and size.
  const ok1 = await fetchMessageFiles([att()], 1024, { fetchImpl });
  assert.equal(ok1.files.length, 1);
  assert.deepEqual(ok1.notes, []);
  assert.equal(ok1.files[0].text, '[attachment "notes.md" (1 KB)]:\n```\n# Notes\nbody\n```');
  // Content with backtick runs gets a longer fence (the content stays inside).
  const ok2 = await fetchMessageFiles([att({ name: "code.md", size: 15 })], 1024, {
    fetchImpl: () => Promise.resolve(new Response(Buffer.from("a ``` b\n```c```"))),
  });
  assert.equal(ok2.files[0].text, "[attachment \"code.md\" (1 KB)]:\n````\na ``` b\n```c```\n````");
  // A leading BOM is stripped from the inlined content.
  const ok3 = await fetchMessageFiles([att({ size: 8 })], 1024, {
    fetchImpl: () => Promise.resolve(new Response(Buffer.from("\uFEFFhello"))),
  });
  assert.equal(ok3.files[0].text, '[attachment "notes.md" (1 KB)]:\n```\nhello\n```');
  ok("files: labeled fenced blocks, dynamic fence, BOM stripped");

  // Binary content (NUL byte / invalid UTF-8) and empty files become notes.
  const bin = await fetchMessageFiles([att()], 1024, {
    fetchImpl: () => Promise.resolve(new Response(Buffer.from([0x00, 0x01, 0x02]))),
  });
  assert.equal(bin.files.length, 0);
  assert.match(bin.notes[0], /binary content/);
  const badUtf8 = await fetchMessageFiles([att()], 1024, {
    fetchImpl: () => Promise.resolve(new Response(Buffer.from([0xff, 0xfe, 0x80]))),
  });
  assert.match(badUtf8.notes[0], /binary content/);
  const empty = await fetchMessageFiles([att({ size: 0 })], 1024, {
    fetchImpl: () => Promise.resolve(new Response(new Uint8Array(0))),
  });
  assert.match(empty.notes[0], /empty file/);
  ok("files: binary and empty attachments become notes");

  // Declared and actual size over the cap, plus download failures, become
  // notes, never exceptions (same convention as images).
  const big = await fetchMessageFiles([att({ size: 2048 })], 1024, { fetchImpl });
  assert.equal(big.files.length, 0);
  assert.match(big.notes[0], /2 KB exceeds the 1 KB limit/);
  const lie = await fetchMessageFiles([att({ size: 1 })], 2, { fetchImpl });
  assert.match(lie.notes[0], /exceeds/);
  const http404 = await fetchMessageFiles([att()], 1024, {
    fetchImpl: () => Promise.resolve(new Response("nope", { status: 404 })),
  });
  assert.match(http404.notes[0], /download failed \(HTTP 404\)/);
  const threw = await fetchMessageFiles([att()], 1024, {
    fetchImpl: () => Promise.reject(new Error("dns down")),
  });
  assert.match(threw.notes[0], /download failed/);
  // More than the per-message cap: the rest are noted.
  const many = await fetchMessageFiles(
    [att({ name: "a.md" }), att({ name: "b.md" }), att({ name: "c.md" }), att({ name: "d.md" })],
    1024,
    { fetchImpl },
  );
  assert.equal(many.files.length, 3);
  assert.equal(many.notes.length, 1);
  assert.match(many.notes[0], /more than 3 files per message/);
  ok("files: size caps and download failures become notes, per-message cap");
}

// ----------------------------------------------------------- compaction --
{
  const noFetch = { messages: { fetch: async () => { throw new Error("no"); } } } as unknown as GuildTextBasedChannel;

  // The startup seed merges with what already arrived, in chronological
  // order, and never duplicates an already-tracked id.
  const store = new ChannelContext();
  store.pushUser("Alice", "hello from the past", "s1", 1000, []);
  store.pushUser("Bob", "new message", "s2", 5000, []);
  // The same-millisecond pair arrives newest-first (like the API): the id
  // tie-break must restore the true order.
  store.seedFrom([
    { id: "s1", ts: 1000, role: "user", content: "old copy", name: "Alice", attachments: [] },
    { id: "s3", ts: 3000, role: "user", content: "between", name: "Carol", attachments: [] },
    { id: "1000000000000000002", ts: 6000, role: "user", content: "tie second", name: "Eve", attachments: [] },
    { id: "1000000000000000001", ts: 6000, role: "user", content: "tie first", name: "Frank", attachments: [] },
    { id: "s4", ts: 9000, role: "user", content: "after", name: "Dan", attachments: [] },
  ]);
  assert.deepEqual(
    store.snapshot().map((e) => `${e.name}:${e.content}`),
    ["Alice:hello from the past", "Carol:between", "Bob:new message", "Frank:tie first", "Eve:tie second", "Dan:after"],
  );
  assert.equal(store.seeded, true);
  // A bot-flagged arrival renders with the "(bot)" marker (the compaction
  // path, like the fallback path).
  const botStore = new ChannelContext();
  botStore.pushUser("Carl", "beep", "cb1", 1, [], true);
  assert.deepEqual(await contextToMessages(botStore, {
    systemPrompt: "",
    maxMessages: 10,
    enableImages: false,
    imagesMaxBytes: 1024,
    enableFileContents: false,
    fileContentsMaxBytes: 1024,
  }), [{ role: "user", content: "Carl (bot): beep" }]);
  // Token estimate: ~4 chars/token + a fixed cost per image in the window.
  assert.equal(estimateTokens("12345678"), 2);
  const est = new ChannelContext();
  est.pushUser("A", "a".repeat(800), "e1", 1, [
    { url: "https://cdn.discordapp.com/attachments/1/2/3/i.png", name: "i.png", size: 10, contentType: "image/png" },
  ]);
  assert.equal(est.estimateTokens("", 10), 1200, "200 text tokens + 1000 image tokens");
  // File contents: when enabled (fileMaxBytes given), non-image attachments
  // in the window add a cost of their size (capped at fileMaxBytes); images
  // keep their fixed cost. Off (undefined) adds nothing.
  const fest = new ChannelContext();
  fest.pushUser("A", "x", "e1", 1, [
    { url: "https://cdn.discordapp.com/attachments/1/2/3/big.txt", name: "big.txt", size: 8_000_000, contentType: "text/plain" },
  ]);
  fest.pushUser("B", "y", "e2", 2, [
    { url: "https://cdn.discordapp.com/attachments/1/2/3/small.md", name: "small.md", size: 2000, contentType: "text/markdown" },
    { url: "https://cdn.discordapp.com/attachments/1/2/3/i.png", name: "i.png", size: 10, contentType: "image/png" },
  ]);
  // off: text (1 + 1) + the image's fixed cost (1000), no file cost.
  assert.equal(fest.estimateTokens("", 2), 1002, "off: text + image, no file cost");
  // on: + file costs, each attachment capped at fileMaxBytes (8 MB and 2000
  // both cap to 1000 -> ceil(1000/4) each).
  assert.equal(fest.estimateTokens("", 2, 1000), 1502, "on: text + image + two capped file costs");
  ok("compaction store: seed merges chronologically (tracked ids win), token estimate");

  // A window bigger than Discord's 100-message fetch cap: the seed still
  // happens (capped at what Discord can give), so pre-startup messages are
  // not silently missing from the context. The fetch comes back newest-first
  // (like the API): same-millisecond messages must be ordered by their
  // snowflake id, not the API's order, and our own UI lines never enter the
  // seed.
  let seedLimit: number | undefined;
  const seedMsgs = [
    { id: "sc2", content: "the mention", createdTimestamp: 60, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
    { id: "sc-chime", content: "🔕 *chime: no — not for me*", createdTimestamp: 59, author: { id: "bot1", bot: true, username: "Glove" }, attachments: [] },
    { id: "sc-clear", content: "🧹 *cleared the channel's conversation history*", createdTimestamp: 57, author: { id: "bot1", bot: true, username: "Glove" }, attachments: [] },
    { id: "sc0", content: "🤔 *thought for 3s*", createdTimestamp: 58, author: { id: "bot1", bot: true, username: "Glove" }, attachments: [] },
    { id: "1000000000000000005", content: "burst three", createdTimestamp: 55, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
    { id: "1000000000000000003", content: "burst two", createdTimestamp: 55, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
    { id: "1000000000000000001", content: "burst one", createdTimestamp: 55, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
    { id: "sc1", content: "pre-startup", createdTimestamp: 50, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
  ];
  const seedChan = {
    messages: {
      fetch: async (o: { limit?: number }) => {
        seedLimit = o.limit;
        return { values: () => seedMsgs.values() };
      },
    },
  } as unknown as GuildTextBasedChannel;
  const capStore = new ChannelContext();
  capStore.pushUser("Alice", "the mention", "sc2", 60, []);
  const capRes = await buildChannelContext(seedChan, capStore, "sc2", {
    botId: "bot1",
    botName: "Glove",
    systemPrompt: "",
    maxMessages: 150,
    enableImages: false,
    imagesMaxBytes: 1024,
    enableFileContents: false,
    fileContentsMaxBytes: 1024,
    maxTokens: 100_000,
    keepMessages: 10,
    summarize: async () => "never",
  });
  assert.equal(seedLimit, 100, "the seed fetch is capped at Discord's limit");
  assert.equal(capStore.seeded, true, "the seed happened (not retried every turn)");
  assert.deepEqual(
    capRes!.map((x) => String(x.content)),
    ["Alice: pre-startup", "Alice: burst one", "Alice: burst two", "Alice: burst three", "Alice: the mention"],
  );
  ok("compaction: a window over Discord's 100-fetch cap still seeds (capped, UI lines skipped, burst ordered by id)");

  // A mention of the bot in a fetched (seeded) message is replaced by the
  // bot's Discord name, not stripped to nothing: the model must be able to
  // tell it was mentioned.
  {
    const nmChan = {
      messages: {
        fetch: async () => ({
          values: () =>
            [
              { id: "nm1", content: "<@bot1> ping", createdTimestamp: 1, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
              { id: "nm2", content: "ping <@!bot1> back", createdTimestamp: 2, author: { id: "bob", bot: false, username: "Bob" }, attachments: [] },
            ].values(),
        }),
      },
    } as unknown as GuildTextBasedChannel;
    const nmStore = new ChannelContext();
    nmStore.pushUser("Alice", "@Glove ping", "nm1", 1, []); // the live commit stored the name-replaced content
    const nmRes = await buildChannelContext(nmChan, nmStore, "nm1", {
      botId: "bot1",
      botName: "Glove",
      systemPrompt: "",
      maxMessages: 20,
      enableImages: false,
      imagesMaxBytes: 1024,
      enableFileContents: false,
      fileContentsMaxBytes: 1024,
      maxTokens: 100_000,
      keepMessages: 10,
      summarize: async () => "never",
    });
    assert.deepEqual(
      nmRes!.map((x) => String(x.content)),
      ["Alice: @Glove ping", "Bob: ping @Glove back"],
      "the tracked entry keeps its content; the fetched mention becomes the bot's Discord name",
    );
    ok("seed: a mention of the bot is replaced by its Discord name (never stripped to nothing)");
  }

  // A !clear committed while the startup seed fetch is still in flight wins:
  // its reset() marks the seed as taken, so the late fetch must not undo the
  // clear by re-seeding the channel's last-N messages.
  {
    let releaseSeed: (col: { values(): Iterable<MessageLike> }) => void = () => {};
    const rChan = {
      messages: {
        fetch: (): Promise<{ values(): Iterable<MessageLike> }> =>
          new Promise((resolve) => {
            releaseSeed = (col) => resolve(col);
          }),
      },
    } as unknown as GuildTextBasedChannel;
    const rstore = new ChannelContext();
    rstore.pushUser("Alice", "the mention", "r-mention", 1, []);
    const rBuild = buildChannelContext(rChan, rstore, "r-mention", {
      botId: "bot1",
      botName: "Glove",
      systemPrompt: "",
      maxMessages: 20,
      enableImages: false,
      imagesMaxBytes: 1024,
      enableFileContents: false,
      fileContentsMaxBytes: 1024,
      maxTokens: 100_000,
      keepMessages: 10,
      summarize: async () => "never",
    });
    rstore.reset(); // the !clear commits while the fetch is in flight
    releaseSeed({ values: () => [] });
    const rRes = await rBuild;
    assert.equal(rstore.length, 0, "the late seed did not undo the clear");
    assert.equal(rstore.seeded, true);
    assert.equal(rRes, null, "the cleared trigger skips the request");
    ok("seed: a !clear committed while the seed fetch is in flight wins (no late re-seed)");
  }

  // syncMessageUpdate: the context sync for an edit of an already-committed
  // message. Chunked bot replies store the RAW chunk content (the bot's own
  // final settle edit, which Discord echoes back as a messageUpdate, is a
  // no-op against it — a strip/trim comparison would rewrite the stored
  // reply on every chunked turn); a real edit stores what the channel shows
  // and re-derives the entry's content. Single-message entries take the
  // content with the bot's mention rendered as its Discord name, and their
  // attachment metadata follows the edit.
  {
    const sstore = new ChannelContext();
    sstore.pushAssistant("first chunk\n - list line\nthird", ["s-c1", "s-c2", "s-c3"], ["first chunk", " - list line", "third"]);
    const atts = () => ({ values: () => [] });
    // The bot's own settle edit of the list chunk: the raw content matches
    // the stored chunk (leading space included) -> no-op, the canonical text
    // is kept exactly.
    syncMessageUpdate(sstore, { id: "s-c2", content: " - list line", attachments: atts() }, "bot-1", "Glove");
    assert.equal(sstore.find("s-c2")!.content, "first chunk\n - list line\nthird", "the bot's own settle edit is a no-op (raw match, no trim)");
    // A real edit (by anyone): the raw new content is stored and the entry's
    // content is re-derived from the chunks.
    syncMessageUpdate(sstore, { id: "s-c2", content: "- edited list line", attachments: atts() }, "bot-1", "Glove");
    assert.equal(sstore.find("s-c2")!.chunks![1], "- edited list line", "the raw edit is stored");
    assert.equal(sstore.find("s-c2")!.content, "first chunk\n- edited list line\nthird", "the content is re-derived from the chunks");
    // A single-message entry takes the name-replaced content (what the
    // commit path stored)...
    sstore.pushUser("Alice", "hello @Glove", "s-u1", 1, []);
    syncMessageUpdate(sstore, { id: "s-u1", content: "hello again <@bot-1>!", attachments: atts() }, "bot-1", "Glove");
    assert.equal(sstore.find("s-u1")!.content, "hello again @Glove!", "the mention is the bot's Discord name (trim only at the ends, like the commit path)");
    // ...and its attachment metadata follows the edit (the pipelines
    // download from the stored metadata at turn time).
    const swapped = { url: "https://cdn.discordapp.com/a/2.png", name: "2.png", size: 5, contentType: "image/png" };
    syncMessageUpdate(sstore, { id: "s-u1", content: "hello again!", attachments: { values: () => [swapped] } }, "bot-1", "Glove");
    assert.deepEqual(sstore.find("s-u1")!.attachments, [swapped], "the attachment metadata follows the edit");
    ok("context sync: chunk edits store raw content (the bot's settle is a no-op), single entries render the bot's mention as its name, metadata follows the edit");
  }

  // prefixEndIndex: the chime transcript cut at the trigger. A message that
  // commits while the trigger's turn is building the context queues its own
  // turn — it must not shift the decision target ("the newest message below"
  // in the chime prompt must be the trigger itself). The cut is the prefix
  // of contextToMessages's output ending at the trigger's entry (system
  // prompt + summary + rendered entries up to and including it).
  {
    const ptstore = new ChannelContext();
    ptstore.pushUser("Alice", "old one", "ct-old1", 1, []);
    ptstore.pushAssistant("an old reply", ["ct-a1"]);
    ptstore.pushUser("Bob", "the trigger", "ct-trig", 3, []);
    ptstore.pushUser("Carol", "committed while the turn built", "ct-later", 4, []);
    const popts = {
      systemPrompt: "you are helpful",
      maxMessages: 10,
      enableImages: false,
      imagesMaxBytes: 1024,
      enableFileContents: false,
      fileContentsMaxBytes: 1024,
    };
    const pmsgs = await contextToMessages(ptstore, popts);
    assert.equal(pmsgs.length, 5, "system + four entries");
    const pcut = prefixEndIndex(ptstore, popts, "ct-trig");
    assert.equal(pcut, 4, "system + the two older entries + the trigger");
    assert.equal(String(pmsgs[pcut! - 1].content), "Bob: the trigger", "the cut ends at the trigger's message");
    assert.equal(String(pmsgs[pcut!].content), "Carol: committed while the turn built", "the newer entry sits right after the cut");
    const ptranscript = pmsgs.slice(0, pcut!).slice(1); // the reply's system prompt is not part of it
    assert.equal(ptranscript[ptranscript.length - 1].content, "Bob: the trigger", "the transcript ends with the trigger");
    // With a summary: it rides ahead of the cut prefix.
    await ptstore.compact(2, async () => "the summary", "ct-trig");
    const pmsgs2 = await contextToMessages(ptstore, popts);
    const pcut2 = prefixEndIndex(ptstore, popts, "ct-trig");
    assert.equal(pcut2, 3, "system + summary + the trigger (the older entries are folded)");
    assert.equal(String(pmsgs2[pcut2! - 1].content), "Bob: the trigger");
    assert.ok(String(pmsgs2[1].content).startsWith("Summary of the earlier messages"), "the summary stays ahead of the cut prefix");
    assert.equal(prefixEndIndex(ptstore, popts, "ct-missing"), null, "absent entry -> null (the caller falls back to the full transcript)");
    ok("chime transcript: prefixEndIndex cuts the transcript at the trigger (summary kept, newer entries excluded)");
  }

  // endWithTrigger: the reply request must end with the trigger's user
  // message. A message committed while the previous turn is still in
  // flight lands in the context before that turn's reply, so the context
  // can end with the bot's own reply — in that shape a prefill-assistant
  // endpoint (llama-server's default) "continues" the trailing assistant
  // message, echoing it back verbatim as the new reply (the duplicate
  // post) or rejecting the request outright when two replies trail
  // ("Cannot have 2 or more assistant messages at the end of the list").
  // The trigger moves to the end; the rest keeps its order; a trigger that
  // is already last is a no-op (same array back).
  {
    const etstore = new ChannelContext();
    etstore.pushUser("Alice", "the trigger", "et-trig", 1, []);
    etstore.pushUser("Bob", "committed while the turn built", "et-later", 2, []);
    etstore.pushAssistant("the previous reply", ["et-a1"]);
    const etopts: Parameters<typeof endWithTrigger>[1] = {
      systemPrompt: "sys",
      enableImages: false,
      enableFileContents: false,
    };
    const etrender: Parameters<typeof contextToMessages>[1] = {
      ...etopts,
      maxMessages: 10,
      imagesMaxBytes: 1024,
      fileContentsMaxBytes: 1024,
    };
    const etmsgs = await contextToMessages(etstore, etrender);
    assert.equal(String(etmsgs[etmsgs.length - 1].content), "the previous reply", "the context ends with the bot's reply");
    const etmoved = endWithTrigger(etstore, etopts, etmsgs, "et-trig");
    assert.deepEqual(
      etmoved.map((m) => [m.role, String(m.content)]),
      [
        ["system", "sys"],
        ["user", "Bob: committed while the turn built"],
        ["assistant", "the previous reply"],
        ["user", "Alice: the trigger"],
      ],
      "the trigger moves to the end, the rest keeps its order",
    );
    assert.equal(etmoved[etmoved.length - 1].role, "user", "the request ends with the trigger's user message");
    assert.notEqual(etmoved, etmsgs, "a new array is returned (the original is untouched)");
    assert.equal(String(etmsgs[etmsgs.length - 1].content), "the previous reply", "the original array keeps its shape");
    // Two trailing replies (the [A, A] shape the server rejects): the move
    // fixes it the same way — the request ends with the trigger.
    const et2store = new ChannelContext();
    et2store.pushUser("Alice", "the trigger", "et2-trig", 1, []);
    et2store.pushAssistant("first reply", ["et2-a1"]);
    et2store.pushAssistant("second reply", ["et2-a2"]);
    const et2msgs = await contextToMessages(et2store, etrender);
    assert.equal(String(et2msgs[et2msgs.length - 2].content), "first reply", "two trailing assistants");
    assert.equal(String(et2msgs[et2msgs.length - 1].content), "second reply");
    const et2moved = endWithTrigger(et2store, etopts, et2msgs, "et2-trig");
    assert.equal(et2moved[et2moved.length - 1].role, "user", "two trailing replies -> the request ends with the trigger");
    assert.equal(String(et2moved[et2moved.length - 1].content), "Alice: the trigger");
    // The usual case: the trigger is already the last entry — a no-op.
    const et3store = new ChannelContext();
    et3store.pushUser("Alice", "the trigger", "et3-trig", 1, []);
    const et3msgs = await contextToMessages(et3store, etrender);
    assert.equal(endWithTrigger(et3store, etopts, et3msgs, "et3-trig"), et3msgs, "trigger already last -> the same array back");
    // A trigger that is no longer in the context: unchanged (the caller
    // skips the turn).
    assert.equal(endWithTrigger(et3store, etopts, et3msgs, "et3-gone"), et3msgs, "absent trigger -> unchanged");
    ok("context: endWithTrigger moves the trigger to the end (no trailing assistant reply)");
  }

  // A single tracked reply grouped with a tracked multi-chunk reply (the
  // seed): the chunk list must stay aligned with the id list — a
  // misaligned lookup would corrupt the entry's content on the next chunk
  // edit ("undefined" holes, lost text).
  const gstore = new ChannelContext();
  const gNow = Date.now();
  gstore.pushAssistant("single reply", ["g-s1"]);
  gstore.pushAssistant("g-c1\ng-c2\ng-c3", ["g-c1", "g-c2", "g-c3"], ["g-c1 text", "g-c2 text", "g-c3 text"]);
  gstore.seedFrom([{ id: "g-u0", ts: gNow - 10_000, role: "user", content: "question", name: "Alice", attachments: [] }]);
  const gSnap = gstore.snapshot();
  assert.equal(gSnap.length, 2, "question + grouped reply");
  const gGrouped = gSnap[1];
  assert.deepEqual(gGrouped.ids, ["g-s1", "g-c1", "g-c2", "g-c3"]);
  assert.deepEqual(gGrouped.chunks, ["single reply", "g-c1 text", "g-c2 text", "g-c3 text"], "chunks aligned with ids");
  gstore.updateChunk("g-c3", "g-c3 text (edited)");
  assert.equal(gGrouped.content, "single reply\ng-c1 text\ng-c2 text\ng-c3 text (edited)", "the chunk edit re-derives the content, no holes");
  ok("compaction store: grouping keeps chunks aligned with ids (chunk edits resolve the right slot)");

  // A chunked reply in the channel before the bot started (its chunks are
  // separate Discord messages): the seed groups the close-together bot
  // entries back into one entry — one id per chunk, the per-chunk text — so
  // chunk edit/delete bookkeeping matches a live chunked reply. A bot
  // message posted later stays a separate entry.
  const rstore = new ChannelContext();
  rstore.seedFrom([
    { id: "r0", ts: 1000, role: "user", content: "question", name: "Alice", attachments: [] },
    { id: "r1", ts: 2000, role: "assistant", content: "reply part one", attachments: [] },
    { id: "r2", ts: 2500, role: "assistant", content: "reply part two", attachments: [] },
    { id: "r3", ts: 3000, role: "assistant", content: "reply part three", attachments: [] },
    { id: "r4", ts: 30_000, role: "assistant", content: "a later reply", attachments: [] },
    { id: "r5", ts: 40_000, role: "user", content: "thanks", name: "Alice", attachments: [] },
  ]);
  const rsnap = rstore.snapshot();
  assert.equal(rsnap.length, 4, "question + grouped reply + later reply + thanks");
  const grouped = rsnap[1];
  assert.deepEqual(grouped.ids, ["r1", "r2", "r3"], "one id per chunk");
  assert.equal(grouped.content, "reply part one\nreply part two\nreply part three");
  assert.deepEqual(grouped.chunks, ["reply part one", "reply part two", "reply part three"]);
  assert.equal(rsnap[2].content, "a later reply", "a far-apart bot message stays separate");
  // Chunk edit/delete bookkeeping on the grouped entry:
  rstore.updateChunk("r2", "reply part two (edited)");
  assert.equal(grouped.content, "reply part one\nreply part two (edited)\nreply part three");
  assert.ok(rstore.removeById("r1"), "any chunk id removes the whole reply");
  assert.equal(rstore.length, 3);
  ok("compaction store: seeded chunked reply groups into one entry (ids, chunks, edit, delete)");

  // A turn build compacts: the older part becomes a summary message, the
  // newest keep messages stay verbatim, and the summary rides ahead of them.
  const cstore = new ChannelContext();
  cstore.seedFrom(
    Array.from({ length: 8 }, (_, i) => ({
      id: `c${String(i + 1)}`,
      ts: 1000 + i * 100,
      role: "user" as const,
      content: `old message ${String(i + 1)}`,
      name: `P${String(i + 1)}`,
      attachments: [],
    })),
  );
  cstore.pushUser("Alice", "what was I saying?", "m1", 9000, []);
  const seenTranscripts: string[] = [];
  let summaryRequest: ChatMessage[] | null = null;
  const summarize = async (msgs: ChatMessage[]): Promise<string> => {
    summaryRequest = msgs;
    seenTranscripts.push(String(msgs[1].content));
    return "they discussed the launch plan";
  };
  const cOpts = {
    botId: "bot1",
    botName: "Glove",
    systemPrompt: "sys",
    maxMessages: 20,
    enableImages: false,
    imagesMaxBytes: 1024,
    enableFileContents: false,
    fileContentsMaxBytes: 1024,
    maxTokens: 20,
    keepMessages: 3,
    summarize,
  };
  const cres = await buildChannelContext(noFetch, cstore, "m1", cOpts);
  assert.deepEqual(cres, [
    { role: "system", content: "sys" },
    { role: "user", content: "Summary of the earlier messages in this channel (older messages were compacted):\nthey discussed the launch plan" },
    { role: "user", content: "P7: old message 7" },
    { role: "user", content: "P8: old message 8" },
    { role: "user", content: "Alice: what was I saying?" },
  ]);
  assert.equal(cstore.getSummary(), "they discussed the launch plan");
  assert.equal(cstore.length, 3, "only the newest 3 entries survive");
  assert.equal(seenTranscripts.length, 1, "one summarization call");
  assert.equal(summaryRequest![0].role, "system");
  assert.equal(summaryRequest![0].content, COMPACTION_SYSTEM_PROMPT, "plain (tool-less) summarization request");
  const transcript = seenTranscripts[0];
  assert.ok(transcript.includes("P1: old message 1"), "oldest messages in the transcript");
  assert.ok(!transcript.includes("old message 7"), "kept messages are not re-summarized");
  ok("compaction: old messages become a summary, newest kept verbatim");

  const customStore = new ChannelContext();
  customStore.pushUser("Alice", "old", "custom-old", 1, []);
  customStore.pushUser("Alice", "new", "custom-new", 2, []);
  await buildChannelContext(noFetch, customStore, "custom-new", {
    ...cOpts, keepMessages: 1, maxTokens: 1, compactionPrompt: "Custom summary",
    summarize: async (msgs) => {
      assert.equal(msgs[0].content, "Custom summary");
      return "custom summary result";
    },
  });
  assert.equal(customStore.getSummary(), "custom summary result");

  // A later compaction folds the previous summary into the new one.
  cstore.pushUser("Bob", "more talk", "m2", 10000, []);
  const cres2 = await buildChannelContext(noFetch, cstore, "m2", cOpts);
  assert.equal(seenTranscripts.length, 2, "second compaction runs");
  assert.ok(seenTranscripts[1].includes("Running summary of the older messages:"), "previous summary folded in");
  assert.ok(seenTranscripts[1].includes("they discussed the launch plan"));
  assert.ok(seenTranscripts[1].includes("P7: old message 7"), "now-old messages summarized");
  assert.deepEqual(
    cres2!.slice(2).map((x) => String(x.content)),
    ["P8: old message 8", "Alice: what was I saying?", "Bob: more talk"],
  );
  assert.equal(cstore.length, 3);
  ok("compaction: repeated compaction folds the running summary");

  // The mention deleted before its turn -> null (the turn is skipped).
  const dstore = new ChannelContext();
  dstore.pushUser("Alice", "hi", "d1", 1, []);
  assert.equal(await buildChannelContext(noFetch, dstore, "gone", cOpts), null);
  ok("compaction: mention deleted before its turn -> null");

  // Summarizer failure (or nothing to fold): the emergency trim drops the
  // oldest messages until the estimate fits, and the mention survives.
  const fstore = new ChannelContext();
  for (let i = 0; i < 6; i++) fstore.pushUser("U", "x".repeat(200), `f${String(i)}`, i, []);
  fstore.pushUser("Alice", "the mention", "fm", 99, []);
  const fOpts = {
    ...cOpts,
    maxTokens: 50,
    keepMessages: 2,
    summarize: async (): Promise<string> => {
      throw new Error("llm down");
    },
  };
  const fres = await buildChannelContext(noFetch, fstore, "fm", fOpts);
  assert.ok(fres !== null, "the turn still runs");
  assert.ok(fstore.has("fm"), "the mention survived the trim");
  assert.ok(!fstore.has("f0"), "the oldest message was trimmed");
  assert.equal(fstore.getSummary(), null, "no summary when the summarizer failed");
  assert.ok(fres!.some((msg) => msg.content === "Alice: the mention"));
  // Nothing older than the keep window to fold: the trim applies directly.
  const tstore = new ChannelContext();
  tstore.pushUser("A", "a".repeat(400), "t1", 1, []);
  tstore.pushUser("B", "b".repeat(400), "t2", 2, []);
  const tOpts = { ...cOpts, maxTokens: 150, keepMessages: 5, summarize: async () => "s" };
  await buildChannelContext(noFetch, tstore, "t2", tOpts);
  assert.equal(tstore.getSummary(), null, "nothing was folded");
  assert.ok(!tstore.has("t1"), "the oldest was trimmed to fit the budget");
  assert.ok(tstore.has("t2"), "the mention was protected");
  ok("compaction: summarizer failure falls back to an emergency trim (mention protected)");

  // The trigger prefers the endpoint's measured count (the model tokenizer's
  // truth, remembered from the previous turn) over the char estimate: a
  // measured size over the budget compacts even when the estimate is small,
  // and a measured size under the budget holds even when the estimate is
  // over. A compaction attempt forgets the measurement (it then describes
  // the pre-compaction context).
  const mstore = new ChannelContext();
  mstore.pushUser("A", "short", "m1", 1, []);
  mstore.pushUser("B", "short", "m2", 2, []);
  mstore.pushUser("C", "short", "m3", 3, []);
  mstore.pushUser("D", "short", "m4", 4, []);
  let mCalls = 0;
  const mOpts = { ...cOpts, maxTokens: 100, keepMessages: 2, summarize: async () => { mCalls += 1; return "m"; } };
  assert.notEqual(await buildChannelContext(noFetch, mstore, "m4", mOpts), null);
  assert.equal(mCalls, 0, "estimate under the budget: no compaction");
  mstore.setMeasuredTokens(5000);
  assert.notEqual(await buildChannelContext(noFetch, mstore, "m4", mOpts), null);
  assert.equal(mCalls, 1, "measured over the budget: compaction runs");
  assert.equal(mstore.getSummary(), "m");
  assert.equal(mstore.getMeasuredTokens(), null, "the pre-compaction measurement is forgotten");
  const mstore2 = new ChannelContext();
  for (let i = 0; i < 4; i++) mstore2.pushUser("U", "x".repeat(400), `mm${String(i)}`, i, []);
  mstore2.setMeasuredTokens(50);
  let mCalls2 = 0;
  const mOpts2 = { ...mOpts, summarize: async () => { mCalls2 += 1; return "m"; } };
  assert.notEqual(await buildChannelContext(noFetch, mstore2, "mm3", mOpts2), null);
  assert.equal(mCalls2, 0, "measured under the budget: the estimate does not trigger");
  assert.equal(mstore2.getSummary(), null);
  ok("compaction: the endpoint's measured tokens drive the trigger (both directions)");

  // Overflow recovery: the endpoint's rejection of an overfilled request
  // (llama.cpp's exact shape, as the LLM client surfaces it — HTTP 400 +
  // body, in stream and non-stream alike) is recognized, and its context
  // window is read from the error.
  const overflowErr = new Error(
    'model endpoint returned HTTP 400 : {"error":{"code":400,"message":"request (310413 tokens) exceeds the available context size (160000 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":310413,"n_ctx":160000}}',
  );
  assert.ok(isContextOverflowError(overflowErr), "llama.cpp's rejection matches");
  assert.equal(contextWindowFromOverflowError(overflowErr), 160000, "the window comes from the error");
  assert.ok(isContextOverflowError(new Error("context window overflow: n_tokens (99) > n_ctx (8)")));
  assert.ok(isContextOverflowError(new Error("This model's maximum context length is 4096 tokens.")));
  assert.ok(!isContextOverflowError(new Error("model request timed out after 600s")), "a timeout is not an overflow");
  assert.ok(!isContextOverflowError(new Error("model endpoint returned HTTP 500 : boom")), "an ordinary failure is not");
  assert.equal(contextWindowFromOverflowError(new Error("context window overflow")), null, "no numbers -> null");
  ok("overflow: detection and the window from the error (llama.cpp's exact shape)");

  // emergencyShrink: drops the oldest entries (never the protected mention)
  // until the estimate fits the target, and — only then — drops the running
  // summary.
  const sh = new ChannelContext();
  for (let i = 0; i < 6; i++) sh.pushUser("U", "x".repeat(200), `s${String(i)}`, i, []);
  assert.deepEqual(await sh.compact(2, async () => "summary text"), { ok: true }); // folds s0..s3
  for (let i = 0; i < 8; i++) sh.pushUser("U", "y".repeat(200), `s${String(6 + i)}`, 100 + i, []);
  // 10 entries x 50 estimated tokens + the summary (3) = 503 > 500: one
  // drop brings it under.
  sh.emergencyShrink("s9", 500, "", 10);
  assert.equal(sh.length, 9, "the oldest entry is dropped");
  assert.ok(!sh.has("s4"));
  assert.ok(sh.has("s5") && sh.has("s13"));
  assert.ok(sh.has("s9"), "the protected mention survives");
  assert.equal(sh.getSummary(), "summary text", "the summary is kept while the entries fit");
  // Only the (huge) protected entry left: no entry can be dropped, so the
  // summary goes instead.
  const sh2 = new ChannelContext();
  sh2.pushUser("A", "a".repeat(200), "a1", 0, []);
  sh2.pushUser("Big", "z".repeat(10000), "big", 1, []);
  assert.deepEqual(await sh2.compact(1, async () => "old summary"), { ok: true });
  sh2.emergencyShrink("big", 1000, "", 10);
  assert.equal(sh2.getSummary(), null, "the summary is the last thing dropped");
  assert.ok(sh2.has("big"), "the protected mention always survives");
  ok("overflow: emergencyShrink drops oldest entries (mention protected), the summary last");

  // Image window: older image attachments leave a note, recent ones are
  // downloaded and sent as parts; the summary renders ahead of the entries.
  const istore = new ChannelContext();
  const imgAtt: MessageAttachmentLike = {
    url: "https://cdn.discordapp.com/attachments/1/2/3/i.png",
    name: "img.png",
    size: 6,
    contentType: "image/png",
  };
  istore.seedFrom([
    { id: "i1", ts: 1, role: "user", content: "old image", name: "Alice", attachments: [imgAtt] },
    { id: "i2", ts: 2, role: "user", content: "recent one", name: "Bob", attachments: [imgAtt] },
    { id: "i3", ts: 3, role: "user", content: "recent two", name: "Carol", attachments: [imgAtt] },
  ]);
  const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x50, 0x0d, 0x0a]);
  const ires = await contextToMessages(istore, {
    systemPrompt: "",
    maxMessages: 2,
    enableImages: true,
    imagesMaxBytes: 1024,
    imageFetch: () => Promise.resolve(new Response(imgBytes)),
    enableFileContents: false,
    fileContentsMaxBytes: 1024,
  });
  const iPart = { type: "image_url", image_url: { url: `data:image/png;base64,${imgBytes.toString("base64")}` } };
  assert.deepEqual(ires, [
    { role: "user", content: 'Alice: old image\n*[attachment "img.png" not sent: older than the image window]*' },
    { role: "user", content: [{ type: "text", text: "Bob: recent one" }, iPart] },
    { role: "user", content: [{ type: "text", text: "Carol: recent two" }, iPart] },
  ]);
  const sstore = new ChannelContext();
  sstore.pushUser("A", "x", "s1", 1, []);
  sstore.pushUser("B", "y", "s2", 2, []);
  assert.deepEqual(await sstore.compact(1, async () => "the summary"), { ok: true });
  const sres = await contextToMessages(sstore, {
    systemPrompt: "",
    maxMessages: 10,
    enableImages: false,
    imagesMaxBytes: 1024,
    enableFileContents: false,
    fileContentsMaxBytes: 1024,
  });
  assert.deepEqual(sres, [
    { role: "user", content: "Summary of the earlier messages in this channel (older messages were compacted):\nthe summary" },
    { role: "user", content: "B: y" },
  ]);
  ok("compaction: image window notes, recent image parts, summary rendered first");

  // File window: older non-image attachments leave a note, recent ones are
  // inlined as labeled, fenced blocks (image attachments are the image
  // pipeline's job, so they stay unnoted here).
  const ffstore = new ChannelContext();
  const fileAtt2: MessageAttachmentLike = {
    url: "https://cdn.discordapp.com/attachments/1/2/3/notes.md",
    name: "notes.md",
    size: 11,
    contentType: "text/markdown",
  };
  ffstore.seedFrom([
    { id: "ff1", ts: 1, role: "user", content: "old file", name: "Alice", attachments: [fileAtt2] },
    { id: "ff2", ts: 2, role: "user", content: "recent file", name: "Bob", attachments: [fileAtt2] },
  ]);
  const fileBytes2 = Buffer.from("# Notes\nbody");
  const ffres = await contextToMessages(ffstore, {
    systemPrompt: "",
    maxMessages: 1,
    enableImages: false,
    imagesMaxBytes: 1024,
    enableFileContents: true,
    fileContentsMaxBytes: 1024,
    fileFetch: () => Promise.resolve(new Response(fileBytes2)),
  });
  const fileBlock2 = '[attachment "notes.md" (1 KB)]:\n```\n# Notes\nbody\n```';
  assert.deepEqual(ffres, [
    { role: "user", content: 'Alice: old file\n*[attachment "notes.md" not sent: older than the file window]*' },
    { role: "user", content: `Bob: recent file\n${fileBlock2}` },
  ]);
  ok("compaction: file window notes, recent files inlined");

  // Both pipelines on: the newest entry's image becomes an image_url part
  // and its file is inlined — no "unsupported type" note for the file (the
  // pipelines are mutually exclusive per attachment type); the older entry
  // leaves one window note per pipeline.
  const bfstore = new ChannelContext();
  bfstore.seedFrom([
    { id: "bf1", ts: 1, role: "user", content: "old mix", name: "Alice", attachments: [imgAtt, fileAtt2] },
    { id: "bf2", ts: 2, role: "user", content: "recent mix", name: "Bob", attachments: [imgAtt, fileAtt2] },
  ]);
  const bfres = await contextToMessages(bfstore, {
    systemPrompt: "",
    maxMessages: 1,
    enableImages: true,
    imagesMaxBytes: 1024,
    imageFetch: () => Promise.resolve(new Response(imgBytes)),
    enableFileContents: true,
    fileContentsMaxBytes: 1024,
    fileFetch: () => Promise.resolve(new Response(fileBytes2)),
  });
  const bfPart = { type: "image_url", image_url: { url: `data:image/png;base64,${imgBytes.toString("base64")}` } };
  assert.deepEqual(bfres, [
    {
      role: "user",
      content:
        'Alice: old mix\n*[attachment "img.png" not sent: older than the image window]*\n*[attachment "notes.md" not sent: older than the file window]*',
    },
    { role: "user", content: [{ type: "text", text: `Bob: recent mix\n${fileBlock2}` }, bfPart] },
  ]);
  ok("compaction: both pipelines on — image part + file block, no duplicate notes");

  // !clear: reset() drops every entry and the running summary, and
  // suppresses the startup seed — the next turn starts from messages that
  // arrived after the clear, not from the channel's last-N; a mention that
  // was queued before the clear no longer runs its turn.
  const kstore = new ChannelContext();
  kstore.seedFrom([
    { id: "k1", ts: 100, role: "user", content: "old talk", name: "Alice", attachments: [] },
  ]);
  kstore.pushUser("Bob", "more talk", "k2", 200, []);
  assert.deepEqual(await kstore.compact(1, async () => "sum of old talk"), { ok: true });
  assert.equal(kstore.getSummary(), "sum of old talk");
  kstore.setMeasuredTokens(123);
  kstore.reset();
  assert.equal(kstore.length, 0, "entries dropped");
  assert.equal(kstore.getSummary(), null, "summary dropped");
  assert.equal(kstore.seeded, true, "no re-seed after a clear");
  assert.equal(kstore.getMeasuredTokens(), null, "the measurement is forgotten too");
  // The next turn does not seed (the fetch below would throw if attempted)
  // and carries only what arrived after the clear.
  kstore.pushUser("Alice", "fresh start", "k3", 300, []);
  const kOpts = {
    botId: "bot1",
    botName: "Glove",
    systemPrompt: "",
    maxMessages: 20,
    enableImages: false,
    imagesMaxBytes: 1024,
    enableFileContents: false,
    fileContentsMaxBytes: 1024,
    maxTokens: 10_000,
    keepMessages: 5,
    summarize: async () => "never",
  };
  assert.deepEqual(await buildChannelContext(noFetch, kstore, "k3", kOpts), [
    { role: "user", content: "Alice: fresh start" },
  ]);
  // A mention queued before the clear: its message left the context, the
  // turn is skipped (no fetch attempted either — the mention check comes first).
  const kcleared = new ChannelContext();
  kcleared.pushUser("Alice", "queued before the clear", "km", 150, []);
  kcleared.reset();
  assert.equal(await buildChannelContext(noFetch, kcleared, "km", kOpts), null, "pre-clear mention -> null");
  ok("compaction: reset() drops entries + summary, suppresses the seed (pre-clear mention -> null)");

  // The whole turn conversation: appendTurn records each executed round
  // (the model's text + reasoning + the calls it requested, then the
  // results in order) and the final reply; the request renders it in full
  // (the assistant carries its tool calls and reasoning, the results are
  // tool messages), so a restart resumes with the unbroken history.
  const turnStore = new ChannelContext();
  turnStore.pushUser("Alice", "check the file for me", "m1", 100, []);
  turnStore.appendTurn(
    [
      {
        content: "let me look",
        reasoning: "first check the path",
        calls: [{ id: "call_a", name: "file_read", arguments: '{"path":"a.txt"}' }],
        results: [{ role: "tool", toolCallId: "call_a", name: "file_read", content: "file contents" }],
        ids: ["n1"],
      },
      {
        content: "", // a round that answered with calls only still renders (its calls carry it)
        calls: [{ id: "call_b", name: "file_read", arguments: '{"path":"b.txt"}' }],
        results: [{ role: "tool", toolCallId: "call_b", name: "file_read", content: "more contents" }],
        ids: [],
      },
    ],
    { content: "the answer is 42", reasoning: "wrapping up", ids: ["r1", "r2"], chunks: ["the answer is", "42"] },
  );
  const turnEntries = turnStore.snapshot();
  assert.deepEqual(
    turnEntries.map((e) => [e.role, e.content]),
    [
      ["user", "check the file for me"],
      ["assistant", "let me look"],
      ["tool", "file contents"],
      ["assistant", ""],
      ["tool", "more contents"],
      ["assistant", "the answer is 42"],
    ],
    "rounds (text, calls, results) and the final reply in order",
  );
  assert.equal(turnEntries[1].toolCalls?.[0].id, "call_a");
  assert.equal(turnEntries[1].reasoning, "first check the path");
  assert.equal(turnEntries[3].toolCalls?.length, 1, "the calls-only round keeps its calls");
  assert.equal(turnEntries[5].reasoning, "wrapping up", "the final reply keeps its reasoning");
  assert.deepEqual(turnEntries[5].chunks, ["the answer is", "42"]);
  const renderOpts: Parameters<typeof contextToMessages>[1] = {
    systemPrompt: "sys",
    maxMessages: 20,
    enableImages: false,
    imagesMaxBytes: 1024,
    enableFileContents: false,
    fileContentsMaxBytes: 1024,
  };
  const rendered = await contextToMessages(turnStore, renderOpts);
  assert.deepEqual(
    rendered.map((m) => [m.role, m.content]),
    [
      ["system", "sys"],
      ["user", "Alice: check the file for me"],
      ["assistant", "let me look"],
      ["tool", "file contents"],
      ["assistant", ""],
      ["tool", "more contents"],
      ["assistant", "the answer is 42"],
    ],
    "the request carries the full conversation in order",
  );
  assert.equal(rendered[3].toolCallId, "call_a");
  assert.equal(rendered[3].name, "file_read");
  assert.deepEqual(rendered[2].toolCalls, turnEntries[1].toolCalls);
  assert.equal(rendered[2].reasoningContent, "first check the path", "assistant reasoning on the wire message");
  assert.equal(rendered[6].reasoningContent, "wrapping up");
  ok("context: appendTurn records the whole turn and the request renders it in full");

  // Deleting the round's narration message drops the whole call/result
  // group (a history with unanswered calls or orphaned results would be
  // invalid for the endpoint); deleting the final reply drops only it.
  assert.ok(turnStore.removeById("n1"), "the round narration id resolves the group");
  assert.deepEqual(
    turnStore.snapshot().map((e) => [e.role, e.content]),
    [
      ["user", "check the file for me"],
      ["assistant", ""],
      ["tool", "more contents"],
      ["assistant", "the answer is 42"],
    ],
    "the calls-only round survived; the deleted round's calls and result are gone with it",
  );
  assert.ok(turnStore.removeById("r2"), "any chunk id of the final reply resolves it");
  const afterDelete = turnStore.snapshot();
  assert.deepEqual(
    afterDelete.map((e) => [e.role, e.content]),
    [
      ["user", "check the file for me"],
      ["assistant", ""],
      ["tool", "more contents"],
    ],
    "deleting the final reply drops only the final entry",
  );
  ok("context: deleting a round's narration drops the whole call/result group");

  // Trimming and compaction never split a tool-call group: an assistant's
  // calls must not outlive their results (or vice versa) — a split group
  // would be an invalid conversation for the endpoint.
  const groupStore = new ChannelContext();
  for (let i = 0; i < 6; i++) groupStore.pushUser("Alice", `old message ${i} ${"x".repeat(200)}`, `g${i}`, 100 + i, []);
  groupStore.appendTurn(
    [
      {
        content: "round narration",
        calls: [{ id: "cg1", name: "file_read", arguments: "{}" }],
        results: [{ role: "tool", toolCallId: "cg1", name: "file_read", content: "r1" }],
        ids: ["gn"],
      },
    ],
    { content: "final reply", ids: ["gf"] },
  );
  groupStore.pushUser("Alice", "the mention", "gm", 200, []);
  groupStore.emergencyTrim("gm", 600, "sys", 20);
  const trimmed = groupStore.snapshot();
  const assertGroupIntact = (entries: typeof trimmed): void => {
    for (let i = 0; i < entries.length - 1; i++) {
      const calls = entries[i].toolCalls;
      if (calls === undefined || calls.length === 0) continue;
      const ids = new Set(calls.map((c) => c.id));
      let j = i + 1;
      while (j < entries.length && entries[j].role === "tool") j++;
      const answered = new Set(entries.slice(i + 1, j).map((e) => e.toolCallId));
      assert.ok([...ids].every((id) => answered.has(id)), "every call has its result in the entry right after");
      // No orphaned result: a tool entry's call id must belong to the
      // preceding assistant entry.
      for (const t of entries.slice(i + 1, j)) assert.ok(ids.has(t.toolCallId ?? ""), "no orphaned tool result");
    }
  };
  assertGroupIntact(trimmed);
  assert.ok(groupStore.has("gm"), "the mention survived the trim");
  // Compaction: a keep boundary that lands inside a group folds the whole
  // group into the summary instead of leaving orphaned results behind.
  const groupStore2 = new ChannelContext();
  for (let i = 0; i < 4; i++) groupStore2.pushUser("Alice", `old ${i} ${"y".repeat(300)}`, `h${i}`, 100 + i, []);
  groupStore2.appendTurn(
    [
      {
        content: "narration",
        calls: [{ id: "cg2", name: "file_read", arguments: "{}" }],
        results: [{ role: "tool", toolCallId: "cg2", name: "file_read", content: "r2" }],
        ids: ["hn"],
      },
    ],
    { content: "final", ids: ["hf"] },
  );
  groupStore2.pushUser("Alice", "keep me 1", "hm1", 300, []);
  groupStore2.pushUser("Alice", "keep me 2", "hm2", 301, []);
  // keep=2: the newest two are the keep region; the boundary falls right
  // before "keep me 1", so the group is fully foldable — but with keep=3
  // the boundary falls INSIDE the group (between narration and result).
  const res2 = await groupStore2.compact(3, async () => "folded");
  assert.equal(res2.ok, true);
  const kept = groupStore2.snapshot();
  assertGroupIntact(kept);
  assert.ok(kept.some((e) => e.ids.includes("hn")) === kept.some((e) => e.toolCallId === "cg2"), "the group moved whole (narration and result together)");
  assert.ok(kept.some((e) => e.ids.includes("hm2")), "the newest message stayed verbatim");
  assert.ok(groupStore2.getSummary() === "folded");
  ok("context: trimming and compaction never split a tool-call group");

  // Serialize/restore: the persisted file round-trips the full turn
  // conversation (text, reasoning, calls, results, chunks, the summary,
  // the seeded flag, the measured size), and a malformed entry is skipped
  // rather than failing the whole channel's restore.
  const roundTrip = new ChannelContext();
  roundTrip.pushUser("Alice", "hello", "rt1", 10, []);
  roundTrip.appendTurn(
    [
      {
        content: "thinking out loud",
        reasoning: "the plan",
        calls: [{ id: "rtc", name: "file_read", arguments: "{}" }],
        results: [{ role: "tool", toolCallId: "rtc", name: "file_read", content: "data" }],
        ids: ["rtn"],
      },
    ],
    { content: "final", reasoning: "done thinking", ids: ["rtf1", "rtf2"], chunks: ["fi", "nal"] },
  );
  roundTrip.setMeasuredTokens(1234);
  const restored = ChannelContext.restore({
    seeded: true,
    summary: null,
    measuredTokens: 1234,
    entries: [
      ...roundTrip.serialize().entries,
      { role: "alien", content: "x", ids: ["bad"] } as unknown as ContextEntry, // unknown role -> skipped
      { role: "user", content: 42, ids: ["bad2"] } as unknown as ContextEntry, // non-string content -> skipped
      { role: "user", content: "survives", ids: "not-an-array" } as unknown as ContextEntry, // bad ids -> skipped
      { role: "assistant", content: "kept calls only", ids: [], ts: 777, toolCalls: [{ id: "x", name: "y", arguments: "z" }, { id: "", name: "z" }] } as ContextEntry, // the good call is kept, the broken one dropped
    ],
  });
  assert.equal(restored.seeded, true);
  assert.equal(restored.getMeasuredTokens(), 1234);
  assert.deepEqual(restored.snapshot(), [...roundTrip.snapshot(), { role: "assistant", content: "kept calls only", ids: [], ts: 777, attachments: [], toolCalls: [{ id: "x", name: "y", arguments: "z" }] }], "malformed entries skipped, the rest intact");
  assert.equal(restored.snapshot().length, roundTrip.length + 1);
  ok("context: serialize/restore round-trips the full turn conversation (malformed entries skipped)");

  const catchupData = roundTrip.serialize();
  catchupData.entries.forEach((e, i) => { e.ts = 100 + i * 10; });
  const catchup = ChannelContext.restore(catchupData);
  catchup.pushAssistant("", [], undefined, { reasoning: "a reasoning-only answer" });
  catchup.pushUser("Bob", "next question", "catchup-trigger", Date.now() + 1, []);
  catchup.seedFrom([
    { id: "between", ts: 115, role: "user", name: "Bob", content: "during the tool", attachments: [] },
    { id: "prior", ts: 105, role: "assistant", content: "earlier answer", attachments: [] },
  ]);
  const catchupEntries = catchup.snapshot();
  const callIndex = catchupEntries.findIndex((e) => e.toolCalls?.[0]?.id === "rtc");
  assert.ok(callIndex >= 0, "catch-up must not merge away the assistant's calls");
  assert.equal(catchupEntries[callIndex].reasoning, "the plan");
  assert.equal(catchupEntries[callIndex + 1].toolCallId, "rtc", "an offline message cannot split calls from results");
  assert.equal(catchup.find("rtf1")?.reasoning, "done thinking");
  const catchupMessages = await contextToMessages(catchup, renderOpts);
  assert.ok(catchupMessages.some((m) => m.content === "" && m.reasoningContent === "a reasoning-only answer"));
  assert.equal(prefixEndIndex(catchup, renderOpts, "catchup-trigger"), catchupMessages.length);
  assert.deepEqual(ChannelContext.restore(catchup.serialize()).snapshot(), catchup.snapshot());
  ok("context: catch-up preserves reasoning, tool groups and reasoning-only request entries");

  // File persistence: save writes atomically (tmp + rename, valid JSON),
  // load restores every channel, remove forgets one, and a missing or
  // corrupt file fails soft to an empty store (the old re-seed behavior).
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), "glove-persist-"));
  try {
    const pfile = path.join(pdir, "chats.json");
    const p1 = new ChatPersistence(pfile);
    const pc = new ChannelContext();
    pc.pushUser("Alice", "persisted hello", "p1", 1, []);
    pc.appendTurn(
      [
        {
          content: "n",
          reasoning: "r",
          calls: [{ id: "pc", name: "file_read", arguments: "{}" }],
          results: [{ role: "tool", toolCallId: "pc", name: "file_read", content: "d" }],
          ids: [],
        },
      ],
      { content: "f", ids: [] },
    );
    pc.reset(); // also prove reset persists (a cleared channel stays cleared across a restart)
    pc.pushUser("Alice", "after clear", "p2", 2, []);
    p1.save("chan1", pc);
    await p1.flush();
    assert.ok(fs.existsSync(pfile), "the file exists after the flush");
    assert.ok(!fs.existsSync(`${pfile}.tmp`), "the temp file is renamed away");
    const onDisk = JSON.parse(fs.readFileSync(pfile, "utf8")) as { version: number; channels: Record<string, unknown> };
    assert.equal(onDisk.version, 1);
    assert.equal(Object.keys(onDisk.channels).length, 1);
    const p2 = new ChatPersistence(pfile);
    const loaded = p2.load();
    assert.deepEqual(loaded.get("chan1")?.entries.map((e) => e.content), ["after clear"], "the cleared context restored from disk");
    p2.remove("chan1");
    await p2.flush();
    assert.equal((JSON.parse(fs.readFileSync(pfile, "utf8")) as { channels: Record<string, unknown> }).channels["chan1"], undefined, "remove forgets the channel");
    fs.writeFileSync(pfile, '{"version": 1, "channels": {"c": '); // a truncated write (a crash mid-write)
    assert.deepEqual([...new ChatPersistence(pfile).load().keys()], [], "a corrupt file fails soft to an empty store");
    for (const invalid of ["null", "42", '{"version":1,"channels":[]}']) {
      fs.writeFileSync(pfile, invalid);
      assert.deepEqual([...new ChatPersistence(pfile).load().keys()], [], "invalid JSON shapes fail soft");
    }
    assert.deepEqual([...new ChatPersistence(path.join(pdir, "missing.json")).load().keys()], [], "a missing file is an empty store (first run)");
    ok("persistence: save/load/remove round-trip the file (atomic), corrupt/missing files fail soft");

    // The store wires every context change to the persistence hook and
    // restore() puts a persisted context back (with the hook re-wired).
    const saved: Array<[string, string[]]> = [];
    const store = new ChannelContextStore((id, ctx) => saved.push([id, ctx.snapshot().map((e) => e.content)]));
    const sc = store.get("s1");
    sc.pushUser("Alice", "one", "s1a", 1, []);
    sc.pushUser("Bob", "two", "s1b", 2, []);
    assert.deepEqual(saved, [
      ["s1", ["one"]],
      ["s1", ["one", "two"]],
    ], "every change saves the whole channel");
    store.restore("s1", { seeded: true, summary: null, measuredTokens: null, clearedAt: null, entries: [{ role: "user", content: "restored", ids: ["sr"], ts: 3, attachments: [] }] });
    assert.deepEqual(store.get("s1").snapshot().map((e) => e.content), ["restored"], "restore replaces the channel's context");
    assert.equal(store.get("s1").seeded, false, "a restored conversation gets one catch-up seed at its first turn (offline messages)");
    ok("store: every context change fires the persistence hook; restore puts a context back");

    // The restart catch-up: a persisted conversation merges in what arrived
    // in the channel while the bot was offline (already-tracked ids win),
    // and a !clear's watermark keeps the restart from resurrecting the
    // conversation that was cleared. An empty (cleared) context never
    // re-seeds.
    const makeFetchChan = (msgs: Array<{ id: string; content: string; createdTimestamp: number; author: { id: string; bot: boolean; username: string } }>): GuildTextBasedChannel =>
      ({
        messages: {
          fetch: async () => ({ values: () => msgs.map((m) => ({ ...m, attachments: { values: () => [] as never[] } })).values() }),
        },
      }) as unknown as GuildTextBasedChannel;
    const seedOpts = (botId: string): Parameters<typeof buildChannelContext>[3] => ({
      botId,
      botName: "Glove",
      systemPrompt: "",
      maxMessages: 20,
      enableImages: false,
      imagesMaxBytes: 1024,
      enableFileContents: false,
      fileContentsMaxBytes: 1024,
      maxTokens: 100_000,
      keepMessages: 10,
      summarize: async () => "never",
    });

    // offline catch-up: the persisted context has "old" (tracked); the
    // channel now also holds "offline" (arrived while the bot was down) and
    // "new" (already tracked, wins over the fetched copy).
    const cuStore = new ChannelContext();
    cuStore.pushUser("Alice", "old", "cu-old", 100, []);
    cuStore.pushUser("Bob", "new", "cu-new", 300, []);
    const cuRestored = ChannelContext.restore(cuStore.serialize());
    cuRestored.seeded = false;
    const cuChan = makeFetchChan([
      { id: "cu-new", content: "new (edited while offline)", createdTimestamp: 300, author: { id: "bob", bot: false, username: "Bob" } },
      { id: "cu-off1", content: "offline one", createdTimestamp: 200, author: { id: "alice", bot: false, username: "Alice" } },
      { id: "cu-old", content: "old (edited while offline)", createdTimestamp: 100, author: { id: "alice", bot: false, username: "Alice" } },
    ]);
    const cuRes = await buildChannelContext(cuChan, cuRestored, "cu-new", seedOpts("bot1"));
    assert.deepEqual(
      cuRes!.map((x) => String(x.content)),
      ["Alice: old", "Alice: offline one", "Bob: new"],
      "offline messages merged in chronological order; tracked ids keep their (newer, live) content",
    );
    assert.equal(cuRestored.seeded, true, "the catch-up happened once");
    ok("persistence: a restart catches up the channel's offline messages into the persisted context");

    // the clear's watermark: messages older than the clear are not
    // re-imported by the catch-up (a clear is a fresh chat, even across a
    // restart); an empty (cleared) context never re-seeds at all.
    const clStore = new ChannelContext();
    clStore.pushUser("Alice", "after the clear", "cl-new", 500, []);
    const clearTime = Date.now();
    clStore.reset(); // the clear (drops the entry, sets the watermark)
    clStore.pushUser("Alice", "after the clear", "cl-new", 500, []);
    const clRestored = ChannelContext.restore(clStore.serialize());
    assert.ok(clRestored.getClearedAt() !== null && clRestored.getClearedAt()! >= clearTime, "the watermark survived the round-trip");
    clRestored.seeded = false;
    const clChan = makeFetchChan([
      { id: "cl-new", content: "after the clear", createdTimestamp: 500, author: { id: "alice", bot: false, username: "Alice" } },
      { id: "cl-pre", content: "before the clear", createdTimestamp: 100, author: { id: "alice", bot: false, username: "Alice" } },
    ]);
    const clRes = await buildChannelContext(clChan, clRestored, "cl-new", seedOpts("bot1"));
    assert.deepEqual(
      clRes!.map((x) => String(x.content)),
      ["Alice: after the clear"],
      "the pre-clear message is not resurrected by the restart",
    );
    const clCleared = new ChannelContext();
    clCleared.reset();
    const clEmpty = ChannelContext.restore(clCleared.serialize());
    clEmpty.seeded = clEmpty.length === 0; // what the store does on restore
    assert.equal(clEmpty.seeded, true, "a cleared (empty) context never re-seeds");
    ok("persistence: a !clear survives a restart (the catch-up honors the watermark; an empty context stays empty)");
  } finally {
    fs.rmSync(pdir, { recursive: true, force: true });
  }

  // Inspect actual serialized requests: all history and tool definitions
  // must match before the decision-only suffix, even with multimodal data.
  const sharedContext: ChatMessage[] = [
    { role: "system", content: "Shared identity and tool guidance" },
    { role: "user", content: "Summary: earlier conversation" },
    { role: "assistant", content: "", reasoningContent: "checking", toolCalls: [{ id: "c", name: "file_read", arguments: "{}" }] },
    { role: "tool", toolCallId: "c", name: "file_read", content: "file contents" },
    { role: "assistant", content: "it says 42", reasoningContent: "done" },
    { role: "user", content: [{ type: "text", text: "Bob: nice\nFile: example.txt\n```\nhello\n```" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] },
  ];
  const originalContext = structuredClone(sharedContext);
  const wireRequests: Array<{ messages: unknown[]; tools?: unknown[]; tool_choice?: string; max_tokens?: number }> = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    wireRequests.push(JSON.parse(body));
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/no-tools" && wireRequests.at(-1)!.tools) {
      res.statusCode = 422;
      res.end(JSON.stringify({ error: { message: "tools are not supported" } }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: wireRequests.length === 1 || req.url === "/decision-only"
      ? { content: "", tool_calls: [{ id: "decision", type: "function", function: { name: "chime", arguments: '{"respond":true,"reason":"question"}' } }] }
      : { content: "reply" } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new LlmClient({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, apiKey: "none", model: "local", stream: false, timeoutMs: 5000 });
    const sharedTools = chimeTools([{ name: "file_read", description: "Read a file", parameters: { type: "object" } }]);
    assert.equal((await decideChime((m, t, signal, options) => client.chat(m, undefined, t, signal, options),
      sharedContext, undefined, undefined, undefined, undefined, sharedTools))?.respond, true);
    await chimeReplyChat(client.chat.bind(client))(sharedContext, undefined, sharedTools.filter(tool => tool.name !== "chime"));
    assert.deepEqual(wireRequests[0].messages.slice(0, -1), wireRequests[1].messages);
    assert.deepEqual(wireRequests[0].tools, wireRequests[1].tools);
    assert.equal(wireRequests[0].tool_choice, wireRequests[1].tool_choice);
    assert.equal(wireRequests[0].max_tokens, CHIME_MAX_TOKENS);
    assert.equal(wireRequests[1].max_tokens, undefined);
    assert.deepEqual(sharedContext, originalContext, "decision does not mutate or persist its suffix");
    const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const toolFree = new LlmClient({ apiUrl: `${apiBase}/no-tools`, apiKey: "none", model: "local", stream: false, timeoutMs: 5000 });
    const beforeFallback = wireRequests.length;
    assert.equal((await chimeReplyChat(toolFree.chat.bind(toolFree))([{ role: "user", content: "@Glove hello" }])).content, "reply");
    assert.equal(wireRequests.length, beforeFallback + 2);
    assert.equal(wireRequests.at(-1)!.tools, undefined);
    assert.equal(wireRequests.at(-1)!.tool_choice, undefined, "tool-free fallback omits both fields on HTTP");

    const interrupted = new LlmClient({ apiUrl: `${apiBase}/decision-only`, apiKey: "none", model: "local", stream: false, timeoutMs: 5000 });
    const ctrl = new AbortController();
    const beforeRepair = wireRequests.length;
    await assert.rejects(chimeReplyChat(interrupted.chat.bind(interrupted), async () => { ctrl.abort(); })(
      sharedContext, undefined, undefined, ctrl.signal), InterruptedError);
    assert.equal(wireRequests.length, beforeRepair + 1, "activity before a repair prevents any stale HTTP request");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  ok("chime: serialized decision and reply share full context, tools and tool choice");

  // prefixEndIndex counts tool entries the way contextToMessages renders
  // them (a tool entry renders with its result text; a calls-only assistant
  // renders with its calls) — the chime cut stays exact with turns in the
  // history.
  const cutStore = new ChannelContext();
  cutStore.pushUser("Alice", "q", "cq", 1, []);
  cutStore.appendTurn(
    [
      {
        content: "n",
        calls: [{ id: "cc", name: "file_read", arguments: "{}" }],
        results: [{ role: "tool", toolCallId: "cc", name: "file_read", content: "d" }],
        ids: ["cn"],
      },
    ],
    { content: "f", ids: ["cf"] },
  );
  cutStore.pushUser("Bob", "the trigger", "ct", 2, []);
  const cutOpts: Parameters<typeof prefixEndIndex>[1] = { systemPrompt: "sys", enableImages: false, enableFileContents: false };
  assert.equal(prefixEndIndex(cutStore, cutOpts, "ct"), 6, "system + user + narration + tool + final + trigger");
  assert.equal(prefixEndIndex(cutStore, cutOpts, "cf"), 5, "the cut at the final reply includes the round's calls and result");
  assert.equal(prefixEndIndex(cutStore, cutOpts, "missing"), null);
  ok("context: prefixEndIndex counts tool entries (the cut stays exact with turns in the history)");

  // newestUserEntryAfter: the chime's supersede check. A chime decision
  // waits for the channel to go still before deciding, and is cancelled
  // when a newer trackable message has committed (its own turn, queued
  // behind, decides over the still conversation — a burst settles into one
  // decision). The bot's own words (assistant and tool entries) never
  // supersede: they are not new activity.
  const supStore = new ChannelContext();
  assert.equal(supStore.newestUserEntryAfter("missing"), null, "a trigger not in the context has no successor");
  supStore.pushUser("Alice", "one", "sp1", 1, []);
  assert.equal(supStore.newestUserEntryAfter("sp1"), null, "the newest message has no successor");
  supStore.appendTurn(
    [
      {
        content: "n",
        calls: [{ id: "st", name: "file_read", arguments: "{}" }],
        results: [{ role: "tool", toolCallId: "st", name: "file_read", content: "d" }],
        ids: ["sn"],
      },
    ],
    { content: "f", ids: ["sf"] },
  );
  assert.equal(supStore.newestUserEntryAfter("sp1"), null, "a turn's rounds and reply do not supersede");
  supStore.pushUser("Bob", "two", "sp2", 2, []);
  assert.equal(supStore.newestUserEntryAfter("sp1"), "sp2", "a newer message supersedes the older decision");
  supStore.pushUser("Bob", "three", "sp3", 3, []);
  assert.equal(supStore.newestUserEntryAfter("sp1"), "sp3", "the newest successor is reported");
  assert.equal(supStore.newestUserEntryAfter("sp2"), "sp3", "the middle message is superseded by the newest");
  assert.equal(supStore.newestUserEntryAfter("sp3"), null, "the newest message decides");
  ok("context: newestUserEntryAfter reports the newer trackable message that supersedes a chime decision");
}

// ----------------------------------------------------------------- queue --
{
  const events: string[] = [];
  let gate: (() => void) | null = null;
  let turnCount = 0;
  const deps = {
    runTurn: async (ch: string, turn: TurnRequest): Promise<void> => {
      turnCount++;
      events.push(`turn:${ch}:${turn.id}`);
      if (turn.id === "m1") await new Promise<void>((r) => (gate = r));
    },
  };

  const q = new ChannelQueue("c1", deps);
  q.push({ id: "m1", chime: false });
  q.push({ id: "m2", chime: true });
  await ticks(3);
  assert.deepEqual(events, ["turn:c1:m1"], "second turn waits for the first to finish");
  gate!();
  await ticks(5);
  assert.deepEqual(events, ["turn:c1:m1", "turn:c1:m2"], "turns run in arrival order (mention, chime)");
  assert.equal(turnCount, 2);
  ok("queue: one turn at a time, FIFO (mentions and chimes alike)");

  // A turn that throws must not kill the worker.
  const events2: string[] = [];
  const q2 = new ChannelQueue("c2", {
    runTurn: async (_c: string, turn: TurnRequest): Promise<void> => {
      if (turn.id === "a") throw new Error("boom");
      events2.push(turn.id);
    },
  });
  q2.push({ id: "a", chime: false });
  q2.push({ id: "b", chime: false });
  await ticks(5);
  assert.deepEqual(events2, ["b"], "worker survives a failed turn and keeps going");
  ok("queue: worker survives a failed turn");

  // newestPendingMentionAfter (the interrupted-turn supersede check,
  // index.ts): the queue reports the newest pending mention turn (chime:
  // false) whose trigger is newer than the given id — a mention turn
  // interrupted while such a turn waits behind it is discarded, and the
  // newer turn (which always responds) answers the newest information.
  // Chime turns never supersede a mention.
  let gate3: (() => void) | null = null;
  const q3 = new ChannelQueue("c3", {
    runTurn: async (_c: string, turn: TurnRequest): Promise<void> => {
      if (turn.id === "1") await new Promise<void>((r) => (gate3 = r));
    },
  });
  q3.push({ id: "1", chime: false }); // running
  q3.push({ id: "2", chime: true }); // pending chime: never supersedes
  q3.push({ id: "3", chime: false }); // pending mention
  await ticks(3);
  assert.equal(q3.newestPendingMentionAfter("0"), "3", "the newest pending mention turn is reported");
  assert.equal(q3.newestPendingMentionAfter("2"), "3", "a pending mention newer than an ambient turn supersedes it");
  assert.equal(q3.newestPendingMentionAfter("3"), null, "nothing pending is newer than the newest");
  gate3!();
  await ticks(5);
  assert.equal(q3.size, 0, "the queued turns ran");
  assert.equal(q3.newestPendingMentionAfter("0"), null, "nothing is pending once the queue drains");
  ok("queue: newestPendingMentionAfter reports the newer pending mention turn that supersedes an interrupted turn");
}

// --------------------------------------------------------------- writer --
{
  interface FakeMessage {
    id: string;
    content: string;
    edit: (u: { content: string }) => Promise<FakeMessage>;
    delete: () => Promise<void>;
  }
  const makeChannel = () => {
    const sent: string[] = [];
    const deleted: string[] = [];
    const messages: FakeMessage[] = [];
    let live: FakeMessage | null = null;
    let nextId = 0;
    const channel = {
      sendTyping: async (): Promise<void> => {},
      send: async (data: { content: string }) => {
        const m: FakeMessage = {
          id: `msg${String(++nextId)}`,
          content: data.content,
          edit: async (u) => {
            m.content = u.content;
            return m;
          },
          delete: async () => {
            deleted.push(m.id);
          },
        };
        live = m;
        messages.push(m);
        sent.push(data.content);
        return m;
      },
    };
    return { channel, sent, deleted, messages, getLive: () => live };
  };

  // first chunk creates the message; final edit applies the full text
  const a = makeChannel();
  const w1 = new ResponseWriter({
    channel: a.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w1.start();
  w1.chunk("Hel");
  await ticks(2);
  w1.chunk("lo");
  await ticks(2);
  assert.equal(a.sent.length, 1, "one message created on first chunk");
  assert.equal(a.sent[0], "Hel");
  const p1 = await w1.finish("Hello, world!");
  assert.equal(a.sent.length, 1, "no extra messages for a short reply");
  assert.equal(a.getLive()!.content, "Hello, world!");
  assert.equal(p1!.text, "Hello, world!", "posted text is the canonical reply");
  assert.deepEqual(p1!.messageIds, [a.getLive()!.id], "posted id is the live message's id");
  ok("writer: first-chunk create + final edit, posted ids reported");

  // >2000 chars split into multiple messages
  const b = makeChannel();
  const w2 = new ResponseWriter({
    channel: b.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w2.start();
  const long = "z".repeat(5000);
  const p2 = await w2.finish(long);
  assert.equal(b.sent.length, 3, "5000 chars -> 3 messages");
  assert.ok(b.sent.every((c) => c.length <= 2000));
  assert.equal(b.sent.join(""), long);
  assert.equal(p2!.messageIds.length, 3, "one id per chunk");
  assert.equal(p2!.text, long, "canonical reply kept in history");
  assert.deepEqual(p2!.chunks, b.sent, "per-chunk text recorded for edit tracking");
  ok("writer: >2000 chars split across multiple messages");

  // empty reply -> note
  const c = makeChannel();
  const w3 = new ResponseWriter({
    channel: c.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w3.start();
  const p3 = await w3.finish("");
  assert.equal(c.sent.length, 1);
  assert.match(c.sent[0], /no response/i);
  assert.equal(p3!.messageIds.length, 1);
  ok("writer: empty reply posts a note");

  // error after partial stream keeps the partial + note
  const d = makeChannel();
  const w4 = new ResponseWriter({
    channel: d.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w4.start();
  w4.chunk("partial text");
  await ticks(2);
  const p4 = await w4.reportError(new Error("model endpoint returned HTTP 500"));
  assert.equal(d.sent.length, 1);
  assert.match(d.getLive()!.content, /partial text/);
  assert.match(d.getLive()!.content, /generation failed/);
  assert.equal(p4!.messageIds.length, 1, "the error note is recorded in history too");
  ok("writer: error keeps partial text + note");

  // interrupt(): a prompt interrupted by channel activity withdraws the
  // partial reply — the partial text is stripped out of the one activity
  // message (it has no message of its own to delete), the thinking line
  // completes in place (kept, like a finished round's), and the writer is
  // done (a fresh attempt starts with a fresh writer).
  const i1 = makeChannel();
  const wi1 = new ResponseWriter({
    channel: i1.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  wi1.start();
  wi1.reason("thinking it through");
  await ticks(2);
  wi1.chunk("partial");
  await ticks(2);
  assert.equal(i1.sent.length, 1, "one activity message (the thinking + the live partial text)");
  assert.equal(i1.deleted.length, 0);
  await wi1.interrupt();
  assert.equal(i1.deleted.length, 0, "the partial text is stripped in place, not deleted");
  assert.match(i1.messages[0].content, /^🤔 \*thinking it through \(\d+s\)\*$/, "the thinking line completes in place, the partial text is gone");
  assert.equal(await wi1.interrupt(), undefined, "a second interrupt is a no-op");
  assert.equal(await wi1.finish("late"), null, "the interrupted writer posts nothing more");
  ok("writer: interrupt() strips the partial reply in place, keeps the thinking line, and finishes");

  // Interrupted before any reply content streamed: the live thinking
  // message completes into its terminal line and nothing else is withdrawn.
  const i2 = makeChannel();
  const wi2 = new ResponseWriter({
    channel: i2.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  wi2.start();
  wi2.reason("still thinking");
  await ticks(2);
  assert.equal(i2.sent.length, 1);
  await wi2.interrupt();
  assert.ok(i2.messages[0].content.startsWith("🤔 *still thinking"), "the thinking line completes in place");
  assert.equal(i2.deleted.length, 0, "no partial reply to withdraw");
  // A writer that never started: interrupt() is a harmless no-op.
  const i3 = makeChannel();
  const wi3 = new ResponseWriter({
    channel: i3.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  await wi3.interrupt();
  assert.equal(i3.sent.length, 0, "nothing posted, nothing withdrawn");
  ok("writer: interrupt() before the reply starts keeps the thinking line and posts nothing");

  // A chunk that fails mid-settle must not strand the remaining chunks:
  // they are still posted, and the reported text is what actually landed
  // (not the canonical reply, which includes the missing chunk).
  const emsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  let esends = 0;
  const echan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      esends++;
      if (esends === 2) throw new Error("rate limited");
      const m = { id: `e${String(esends)}`, content: data.content, deleted: false };
      emsgs.push(m);
      return {
        id: m.id,
        content: m.content,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return m;
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const w4b = new ResponseWriter({
    channel: echan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w4b.start();
  const long7 = "q".repeat(6000); // 3 chunks; the middle one fails
  const p4b = await w4b.finish(long7);
  assert.equal(emsgs.length, 2, "the failed chunk is missing, the others landed");
  assert.equal(p4b!.messageIds.length, 2, "only what landed is reported");
  assert.equal(p4b!.text, emsgs.map((m) => m.content).join("\n"), "visible text reported, not the canonical reply");
  ok("writer: a failed chunk does not strand the remaining ones");

  // Bot posts carry allowedMentions: user pings stay active, @everyone/@here
  // and role pings are suppressed (a stray mention must not ping the server).
  const amsgs: Array<{ id: string; content: string }> = [];
  const asendOpts: Array<Record<string, unknown>> = [];
  const aeditOpts: Array<Record<string, unknown>> = [];
  const achan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string; allowedMentions?: unknown }) => {
      const m = { id: `a${String(amsgs.length + 1)}`, content: data.content };
      amsgs.push(m);
      asendOpts.push(data);
      return {
        id: m.id,
        content: m.content,
        edit: async (u: { content: string; allowedMentions?: unknown }) => {
          m.content = u.content;
          aeditOpts.push(u);
          return m;
        },
        delete: async () => true,
      };
    },
  };
  const w4c = new ResponseWriter({
    channel: achan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w4c.start();
  w4c.chunk("hello @everyone");
  await ticks(2);
  const p4c = await w4c.finish("hello @everyone");
  assert.equal(p4c!.text, "hello @everyone", "the text itself is unchanged");
  assert.deepEqual(asendOpts[0].allowedMentions, { parse: ["users"] }, "sends suppress everyone/role pings");
  assert.deepEqual(aeditOpts[0].allowedMentions, { parse: ["users"] }, "edits (the settle) do too");
  ok("writer: posts suppress @everyone/@here pings (allowedMentions, user pings kept)");

  // A long reasoning stream keeps the preview bounded: the buffer holds a
  // tail, the last lines are visible, and the hidden count spans the whole
  // stream.
  const rmsgs: Array<{ id: string; content: string }> = [];
  const rchan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `r${String(rmsgs.length + 1)}`, content: data.content };
      rmsgs.push(m);
      return {
        id: m.id,
        content: m.content,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return m;
        },
        delete: async () => true,
      };
    },
  };
  const w4d = new ResponseWriter({
    channel: rchan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 1,
  });
  w4d.start();
  const manyLines = Array.from({ length: 2000 }, (_, i) => `thought line ${String(i)} ${"x".repeat(20)}`).join("\n");
  w4d.reason(manyLines);
  await ticks(3);
  const preview = (w4d as unknown as { reasoningPreview(max: number): string }).reasoningPreview(2000);
  assert.ok(preview.length <= 2000, `preview is bounded (got ${preview.length})`);
  assert.ok(preview.includes("thought line 1999"), "the last line is visible");
  assert.ok(preview.includes("1995 lines hidden"), `the hidden count spans the whole stream: ${preview.slice(0, 60)}`);
  assert.ok((w4d as unknown as { reasoningBuffer: string }).reasoningBuffer.length <= 8000, "the buffer holds only a tail");
  ok("writer: long reasoning keeps the preview bounded (tail + line count)");

  // discard(): a tool-call round's streamed *text* is settled in place (it
  // stays in the channel between the tool-activity lines — not deleted), and
  // the next round streams a fresh live message below it
  const msgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const dchan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `w${String(msgs.length)}`, content: data.content, deleted: false };
      msgs.push(m);
      return {
        id: m.id,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return { id: m.id };
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const w5 = new ResponseWriter({
    channel: dchan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w5.start();
  w5.chunk("transient");
  await ticks(2);
  w5.discard();
  await ticks(3);
  assert.equal(msgs.length, 1, "preview message created");
  assert.equal(msgs[0].deleted, false, "the round's text is not deleted on discard");
  assert.equal(msgs[0].content, "transient", "settled to the round's full text in place");
  w5.chunk("Final answer!");
  await ticks(2);
  const p5 = await w5.finish("Final answer!");
  assert.equal(msgs.length, 2, "next round streams a fresh live message");
  assert.equal(msgs[1].deleted, false);
  assert.equal(msgs[1].content, "Final answer!");
  assert.equal(p5!.text, "Final answer!");
  assert.deepEqual(p5!.messageIds, [msgs[1].id], "only the final reply is recorded");
  ok("writer: discard() settles the round's text in place, next round is fresh");

  // discard() resolves with what the round's text settled to (the message
  // ids + text, like finish) so the caller can record the round in the
  // channel history (its message ids keep edits and deletes in sync);
  // a round with no text settles to null.
  const rMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const rChan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `r${String(rMsgs.length)}`, content: data.content, deleted: false };
      rMsgs.push(m);
      return {
        id: m.id,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return { id: m.id };
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const wR = new ResponseWriter({
    channel: rChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  wR.start();
  wR.chunk("round one narration");
  await ticks(2);
  const d1 = await wR.discard();
  assert.equal(d1?.text, "round one narration", "the settled round's text is reported");
  assert.deepEqual(d1?.messageIds, [rMsgs[0].id], "the settled round's message id is reported");
  wR.chunk(""); // a calls-only round: nothing streams
  const d2 = await wR.discard();
  assert.equal(d2, null, "a textless round settles to null (the caller records the model's text instead)");
  await wR.finish("done");
  ok("writer: discard() resolves with the settled round (ids + text), null for a textless round");

  // Multi-round turn (the reported bug): with many tool calls in one turn the
  // text between the rounds used to be deleted — every round's narration
  // must now stay in the channel above the tool-activity lines (posted by
  // the caller), and only the final reply is recorded.
  const multiMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const multiChan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `mm${String(multiMsgs.length)}`, content: data.content, deleted: false };
      multiMsgs.push(m);
      return {
        id: m.id,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return { id: m.id };
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const wMulti = new ResponseWriter({
    channel: multiChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  wMulti.start();
  // Round 1: narration + tool call — the narration stays; the activity line
  // (caller-posted) lands below it
  wMulti.chunk("Let me check the docs.");
  await ticks(2);
  wMulti.discard();
  await ticks(3);
  await multiChan.send({ content: "🔎 web_search (activity)" });
  // Round 2: a fresh narration below the activity line, then another call
  wMulti.chunk("Now the second step.");
  await ticks(2);
  assert.equal(multiMsgs.length, 3, "narration 1 + activity + narration 2");
  assert.equal(multiMsgs[0].deleted, false, "round 1's text is not deleted");
  assert.equal(multiMsgs[0].content, "Let me check the docs.", "round 1's narration settled in place");
  assert.equal(multiMsgs[1].content, "🔎 web_search (activity)", "activity line sits between the narrations");
  assert.equal(multiMsgs[2].content, "Now the second step.", "round 2's narration is a fresh message");
  wMulti.discard();
  await ticks(3);
  await multiChan.send({ content: "📁 file_read (activity)" });
  // Final round: the reply is posted (and recorded)
  wMulti.chunk("Here is the answer.");
  await ticks(2);
  const pMulti = await wMulti.finish("Here is the answer.");
  assert.equal(multiMsgs.length, 5, "two narrations, two activity lines, final reply");
  assert.deepEqual(multiMsgs.map((m) => m.deleted), [false, false, false, false, false], "nothing is deleted between the tool-activity lines");
  assert.equal(multiMsgs[4].content, "Here is the answer.", "the final reply settles in place");
  assert.deepEqual(pMulti!.messageIds, [multiMsgs[4].id], "only the final reply is recorded");
  ok("writer: a multi-round turn keeps every round's narration in place");

  // LaTeX in model output is sanitized before posting (and in the history).
  const f = makeChannel();
  const w6 = new ResponseWriter({
    channel: f.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w6.start();
  const p6 = await w6.finish("The rate goes $\\uparrow$ and $\\text{H}^+$ matters");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0], "The rate goes ↑ and H⁺ matters");
  assert.equal(p6!.text, "The rate goes ↑ and H⁺ matters", "history records the sanitized text");
  ok("writer: LaTeX sanitized before posting and recording");

  // reasoning preview: shown live, capped at 2000 chars (tail kept), and
  // when the reply starts the thinking message completes in place into its
  // terminal line (first line of the thinking, truncated, + how long it
  // took) while the reply streams in a fresh message; reasoning is never
  // posted or recorded
  const g = makeChannel();
  const w7 = new ResponseWriter({
    channel: g.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w7.start();
  w7.reason("Let me think step by step. First, the units; ");
  await ticks(2);
  assert.equal(g.sent.length, 1, "thinking preview creates the live message");
  assert.match(g.sent[0], /^🤔 \*thinking: /);
  assert.ok(g.sent[0].includes("step by step"), "reasoning text visible live");
  w7.reason("x".repeat(5000));
  await ticks(2);
  const thinkLive = g.getLive()!.content;
  assert.equal(thinkLive.length, 2000, `reasoning preview capped at 2000 (got ${thinkLive.length})`);
  assert.ok(thinkLive.startsWith("🤔 *thinking: …"), "truncated with a leading …");
  assert.ok(thinkLive.endsWith("*"));
  w7.chunk("The answer is 42.");
  await ticks(2);
  assert.equal(g.sent.length, 1, "the reply settles inside the activity message");
  assert.match(
    g.messages[0].content,
    /^🤔 \*Let me think step by step\. First, the units; xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\.\.\. \(\d+s\)\*\nThe answer is 42\.$/,
    "thinking completes into first-line (truncated at the tool-line length) + seconds, the reply settles below it in the same message",
  );
  const p7 = await w7.finish("The answer is 42.");
  assert.equal(p7!.text, "The answer is 42.", "reasoning is not posted or recorded");
  assert.deepEqual(p7!.messageIds, [], "the reply settled inside the activity message (a UI line, recorded without a backing message)");
  ok("writer: reasoning preview live-capped, completes into a first-line + seconds line, never recorded");

  // long multi-line thinking: header + "N lines hidden" + the last 5 lines
  const h = makeChannel();
  const w7b = new ResponseWriter({
    channel: h.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w7b.start();
  const longThinking = Array.from({ length: 30 }, (_, i) => `thinking step ${String(i + 1).padStart(2, "0")} ${"z".repeat(50)}`).join("\n");
  w7b.reason(longThinking);
  await ticks(2);
  const thinkLong = h.getLive()!.content;
  assert.ok(thinkLong.startsWith("🤔 *thinking: …*\n*25 lines hidden*\n"), "hidden-line header");
  assert.ok(thinkLong.includes("step 26"), "last 5 lines kept");
  assert.ok(thinkLong.includes("step 30"), "last line kept");
  assert.ok(!thinkLong.includes("step 25"), "hidden lines dropped");
  assert.ok(thinkLong.length <= 2000, `long preview capped at 2000 (got ${thinkLong.length})`);
  ok("writer: long thinking shows 'N lines hidden' + the last 5 lines");

  // discard() persists the round's thinking as a terminal line in the
  // turn's shared activity message (not deleted) and clears the reasoning
  // buffer: the next round's live preview starts fresh (it shows only the
  // new round's reasoning, below the old round's terminal line)
  const actMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const actChan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `a${String(actMsgs.length)}`, content: data.content, deleted: false };
      actMsgs.push(m);
      return {
        id: m.id,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return { id: m.id };
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const w8 = new ResponseWriter({
    channel: actChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 0, // the test asserts the live preview edits, not their throttling
  });
  w8.start();
  w8.reason("old round thinking…");
  await ticks(2);
  assert.equal(actMsgs.length, 1, "thinking preview creates the shared message");
  assert.match(actMsgs[0].content, /thinking/);
  w8.discard();
  await ticks(3);
  assert.equal(actMsgs[0].deleted, false, "activity message persisted (not deleted) on discard");
  assert.match(actMsgs[0].content, /^🤔 \*old round thinking… \(\d+s\)\*$/, "completed into its terminal line");
  w8.reason("fresh round thinking");
  await ticks(2);
  assert.equal(actMsgs.length, 1, "the next round reuses the same message");
  assert.match(
    actMsgs[0].content,
    /^🤔 \*old round thinking… \(\d+s\)\*\n🤔 \*thinking: fresh round thinking\*$/,
    "the old round's terminal line stays above the new round's live preview (the cleared buffer does not leak into it)",
  );
  const p8 = await w8.finish("done");
  assert.equal(p8!.text, "done");
  ok("writer: discard() persists the round's thinking, next round continues the same message");
  // Every round's reasoning is persisted as its own terminal line in the
  // ONE shared activity message (posted on the first line, edited in place
  // across the rounds), so the channel shows a thought line for every round
  // — not just one at the very end — without a flood of separate messages.
  const tMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const tChan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `t${String(tMsgs.length)}`, content: data.content, deleted: false };
      tMsgs.push(m);
      return {
        id: m.id,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return { id: m.id };
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const wT = new ResponseWriter({
    channel: tChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 0, // the test asserts the live preview edits, not their throttling
  });
  wT.start();
  // Round 1: thinking only (no text to settle), then a tool call — the
  // terminal line lands in the shared message.
  wT.reason("Round one: gather the data.");
  await ticks(2);
  wT.discard();
  await ticks(3);
  assert.equal(tMsgs.length, 1, "round 1: the shared message");
  assert.match(tMsgs[0].content, /^🤔 \*Round one: gather the data\. \(\d+s\)\*$/, "round 1 thinking persisted by discard()");
  assert.equal(tMsgs[0].deleted, false, "shared message not deleted");
  // Round 2: thinking only, then a tool call — a fresh terminal line in the
  // same message.
  wT.reason("Round two: analyze it.");
  await ticks(2);
  assert.match(tMsgs[0].content, /Round one/, "round 1's line stays while round 2 previews below it");
  wT.discard();
  await ticks(3);
  assert.equal(tMsgs.length, 1, "round 2: the same message, a second line");
  assert.match(
    tMsgs[0].content,
    /^🤔 \*Round one: gather the data\. \(\d+s\)\*\n🤔 \*Round two: analyze it\. \(\d+s\)\*$/,
    "round 2 thinking appended by discard()",
  );
  // Round 3: thinking, then the final answer (the terminal line completes
  // when the reply takes over).
  wT.reason("Round three: answer.");
  await ticks(2);
  assert.equal(tMsgs.length, 1, "round 3: the same message, a live preview at the bottom");
  wT.chunk("The final answer.");
  await ticks(2);
  assert.match(
    tMsgs[0].content,
    /^🤔 \*Round one: gather the data\. \(\d+s\)\*\n🤔 \*Round two: analyze it\. \(\d+s\)\*\n🤔 \*Round three: answer\. \(\d+s\)\*\nThe final answer\.$/,
    "round 3 thinking completes when the reply starts, and the reply settles below it in the same message",
  );
  const pT = await wT.finish("The final answer.");
  assert.equal(pT!.text, "The final answer.");
  assert.deepEqual(pT!.messageIds, [], "the reply settled inside the activity message (a UI line, recorded without a backing message)");
  assert.deepEqual(tMsgs.map((m) => m.deleted), [false], "nothing is deleted");
  ok("writer: every round's reasoning persists as its own line in the one shared activity message");
  // A round that streams both reasoning and text: the thinking line completes
  // when the text takes over, and discard() settles the text in place (keeps
  // it, no deletion) — it must NOT post a second terminal line for the same
  // round.
  const uMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const uChan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `u${String(uMsgs.length)}`, content: data.content, deleted: false };
      uMsgs.push(m);
      return {
        id: m.id,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return { id: m.id };
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const wU = new ResponseWriter({
    channel: uChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  wU.start();
  wU.reason("Thinking then text.");
  await ticks(2);
  wU.chunk("transient text");
  await ticks(2);
  assert.equal(uMsgs.length, 1, "one message: the thinking line + the round's text");
  assert.match(uMsgs[0].content, /^🤔 \*Thinking then text\. \(\d+s\)\*\ntransient text$/, "the thinking completes when the text starts, and the text settles below it in the same message");
  assert.equal(uMsgs[0].deleted, false);
  const pU = await wU.discard();
  await ticks(3);
  assert.equal(uMsgs.length, 1, "discard() posts no second terminal line");
  assert.equal(uMsgs[0].deleted, false, "nothing is deleted (the text is inside the message)");
  assert.match(uMsgs[0].content, /^🤔 \*Thinking then text\. \(\d+s\)\*\ntransient text$/, "settled to the round's full text in place");
  assert.deepEqual(pU!.messageIds, [], "the round's text settled inside the activity message (a UI line, recorded without a backing message)");
  ok("writer: a reasoning + text round posts exactly one terminal line and keeps the text");

  // A round's text that outgrows the activity message's room demotes to its
  // own message(s) BELOW it (the channel order keeps matching the order
  // they happened): the first slice is budgeted to the room the settled
  // lines leave, the record keeps the slices' ids, and the next round's
  // lines open a FRESH activity message below the overflow.
  const dmMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const dmChan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `dm${String(dmMsgs.length)}`, content: data.content, deleted: false };
      dmMsgs.push(m);
      return {
        id: m.id,
        content: m.content,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return { id: m.id };
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const wD = new ResponseWriter({
    channel: dmChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 0, // the test asserts the live edits, not their throttling
  });
  wD.start();
  wD.reason("Thinking hard.");
  await ticks(2);
  const demotedText = "a".repeat(2500); // more than the room the line leaves
  wD.chunk(demotedText);
  await ticks(3);
  assert.equal(dmMsgs.length, 3, "the activity message + the demoted slices");
  assert.match(dmMsgs[0].content, /^🤔 \*Thinking hard\. \(\d+s\)\*$/, "the activity message goes back to its settled lines (the text demoted out)");
  assert.equal(dmMsgs[0].content.length + 1 + dmMsgs[1].content.length, 2000, "the first slice is budgeted exactly to the room the line left (stable across the demotion)");
  assert.ok(dmMsgs[1].content.length + dmMsgs[2].content.length === 2500, "the demoted slices hold the whole round text");
  const pD = await wD.discard();
  await ticks(3);
  assert.deepEqual(pD!.messageIds, [dmMsgs[1].id, dmMsgs[2].id], "the demoted text is recorded with its message ids (edit/delete sync stays correct)");
  assert.equal(pD!.text, demotedText);
  // The next round's lines open a FRESH activity message below the overflow,
  // and the next round's short reply settles inside it.
  wD.reason("Next round.");
  await ticks(2);
  assert.equal(dmMsgs.length, 4, "the next round's line opens a fresh activity message below the overflow");
  assert.match(dmMsgs[3].content, /^🤔 \*thinking: Next round\.\*$/, "the fresh message starts with the round's live preview");
  wD.discard();
  await ticks(3);
  assert.match(dmMsgs[3].content, /^🤔 \*Next round\. \(\d+s\)\*$/, "the fresh message completes the round's line in place");
  wD.chunk("Final.");
  await ticks(2);
  assert.equal(dmMsgs.length, 4, "the short final reply settles inside the fresh activity message");
  assert.match(dmMsgs[3].content, /^🤔 \*Next round\. \(\d+s\)\*\nFinal\.$/, "line then reply, in order");
  const pDF = await wD.finish("Final.");
  assert.deepEqual(pDF!.messageIds, [], "the in-message reply is recorded without a backing message");
  ok("writer: a round text that outgrows the room demotes below it; the next round's lines open fresh");

  // The whole turn's UI lines share ONE activity message, in the order they
  // happened: each round's thinking terminal line, then that round's
  // tool-call lines — a 3-round turn costs one activity message + the
  // reply, not one message per line.
  const ixMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const ixChan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `ix${String(ixMsgs.length)}`, content: data.content, deleted: false };
      ixMsgs.push(m);
      return {
        id: m.id,
        content: m.content,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return { id: m.id };
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const wIx = new ResponseWriter({
    channel: ixChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 0, // the test asserts the live preview edits, not their throttling
  });
  wIx.start();
  // Round 1: thinking, then its call.
  wIx.reason("Round one thinking");
  await ticks(2);
  wIx.discard();
  await ticks(3);
  await wIx.appendActivityLines([formatToolCall({ id: "x1", name: "web_search", arguments: '{"query":"a"}' })]);
  // Round 2: thinking, then two calls.
  wIx.reason("Round two thinking");
  await ticks(2);
  wIx.discard();
  await ticks(3);
  await wIx.appendActivityLines([
    formatToolCall({ id: "x2", name: "shell_exec", arguments: '{"command":"ls"}' }),
    formatToolCall({ id: "x3", name: "file_read", arguments: '{"path":"b"}' }),
  ]);
  // Round 3: thinking, then the final answer.
  wIx.reason("Round three thinking");
  await ticks(2);
  wIx.chunk("The answer.");
  await ticks(2);
  const pIx = await wIx.finish("The answer.");
  assert.equal(ixMsgs.length, 1, "ONE message holds the whole turn, no matter how many rounds");
  assert.equal(ixMsgs[0].deleted, false, "the activity message stays in the channel");
  assert.match(
    ixMsgs[0].content,
    /^🤔 \*Round one thinking \(\d+s\)\*\n🔎 \*web_search\(query="a"\)\*\n🤔 \*Round two thinking \(\d+s\)\*\n🐚 \*shell_exec\(command="ls"\)\*\n📁 \*file_read\(path="b"\)\*\n🤔 \*Round three thinking \(\d+s\)\*\nThe answer\.$/,
    "thinking lines, call lines and the reply interleaved in the order they happened",
  );
  assert.equal(pIx!.text, "The answer.");
  assert.deepEqual(pIx!.messageIds, [], "the reply settled inside the activity message (a UI line, recorded without a backing message)");
  ok("writer: one shared activity message holds every round's lines, in order");

  // A `*` from the model's reasoning (a markdown bullet or bold) must not
  // break the line's italic wrapping (it used to show as literal
  // asterisks): it is dropped from the live preview and the terminal line.
  const sMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const sChan = {
    sendTyping: async (): Promise<void> => {},
    send: async (data: { content: string }) => {
      const m = { id: `s${String(sMsgs.length)}`, content: data.content, deleted: false };
      sMsgs.push(m);
      return {
        id: m.id,
        content: m.content,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          return { id: m.id };
        },
        delete: async () => {
          m.deleted = true;
          return true;
        },
      };
    },
  };
  const wS = new ResponseWriter({
    channel: sChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  wS.start();
  wS.reason("*   User gochu asks to check the logs.");
  await ticks(2);
  assert.match(sMsgs[0].content, /^🤔 \*thinking: User gochu asks to check the logs\.\*$/, "asterisks dropped from the live preview");
  const pS = await wS.finish("ok");
  assert.match(sMsgs[0].content, /^🤔 \*User gochu asks to check the logs\. \(\d+s\)\*\nok$/, "asterisks dropped from the terminal line; the reply settles below it in the same message");
  assert.ok(!sMsgs[0].content.includes("**"), "no broken markdown in the line");
  assert.equal(pS!.text, "ok");
  ok("writer: a * in the model's reasoning cannot break the line's italics");

  // non-stream mode: the whole reasoning arrives at once (one reason() call,
  // no chunks); on finish the thinking line completes in place and the
  // reply settles below it in the same message
  const n = makeChannel();
  const w9 = new ResponseWriter({
    channel: n.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w9.start();
  w9.reason("Let me check the units first.");
  await ticks(2);
  assert.equal(n.sent.length, 1, "thinking preview creates the live message");
  const p9 = await w9.finish("The answer is 7.");
  assert.equal(n.sent.length, 1, "the reply settles inside the activity message");
  assert.match(n.messages[0].content, /^🤔 \*Let me check the units first\. \(\d+s\)\*\nThe answer is 7\.$/, "thinking line completed on finish (first line, untruncated), the reply below it");
  assert.equal(p9!.text, "The answer is 7.");
  assert.deepEqual(p9!.messageIds, [], "recorded without a backing message (the activity message is a UI line)");
  ok("writer: non-stream reasoning completes into a line, reply settles in the same message");

  // reasoning-only response (no content at all): the thinking line survives
  // and the "no response" note settles below it in the same message
  const o = makeChannel();
  const w10 = new ResponseWriter({
    channel: o.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w10.start();
  w10.reason("hmm, nothing to say…");
  await ticks(2);
  const p10 = await w10.finish("");
  assert.equal(o.sent.length, 1, "thinking line + note in the one message");
  assert.match(o.messages[0].content, /^🤔 \*hmm, nothing to say… \(\d+s\)\*\n\*\(the model returned no response\)\*$/, "thinking line completed (first line, untruncated), the note below it");
  assert.deepEqual(p10!.messageIds, [], "the note settled inside the activity message (recorded without a backing message)");
  ok("writer: reasoning-only turn keeps the thinking line, note posted fresh");

  // discard() must settle even a live message whose initial send is still in
  // flight when discard() runs (the settle happens in the chain step, which
  // is queued behind the pending updateLive)
  const raceMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const raceChan = {
    sendTyping: async (): Promise<void> => {},
    send: (content: string) =>
      new Promise((resolve) => {
        setImmediate(() => {
          const m = { id: `r${String(raceMsgs.length)}`, content, deleted: false };
          raceMsgs.push(m);
          resolve({
            id: m.id,
            edit: async (u: { content: string }) => {
              m.content = u.content;
              return { id: m.id };
            },
            delete: async () => {
              m.deleted = true;
              return true;
            },
          });
        });
      }),
  };
  const w11 = new ResponseWriter({
    channel: raceChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w11.start();
  w11.chunk("transient");
  await ticks(1); // the initial send is in flight (its setImmediate has not run)
  w11.discard();
  await ticks(4);
  assert.equal(raceMsgs.length, 1, "the preview message was created");
  assert.equal(raceMsgs[0].deleted, false, "in-flight preview settled (not deleted) on discard");
  assert.equal(raceMsgs[0].content, "transient", "settled to the round's full text");
  ok("writer: discard() also settles a preview whose initial send is in flight");

  // long streaming reply: a fresh live message is created per ~2000-char
  // slice, and the final post settles the live messages in place (no re-post)
  const e = makeChannel();
  const w12 = new ResponseWriter({
    channel: e.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w12.start();
  w12.chunk("a".repeat(2500));
  await ticks(2);
  assert.equal(e.sent.length, 2, "a second live message is created past 2000 chars");
  assert.equal(e.sent[0].length, 2000, "first slice is exactly 2000");
  assert.equal(e.sent[1].length, 500, "second slice holds the rest");
  w12.chunk("b".repeat(2000));
  await ticks(2);
  assert.equal(e.sent.length, 3, "third live message as the reply keeps growing");
  const full12 = "a".repeat(2500) + "b".repeat(2000);
  const p12 = await w12.finish(full12);
  assert.equal(e.sent.length, 3, "final chunks settle into the existing live messages");
  assert.deepEqual(e.messages.map((c) => c.content.length), [2000, 2000, 500], "each slice holds its final chunk");
  assert.equal(p12!.text, full12, "canonical reply recorded");
  assert.equal(p12!.messageIds.length, 3, "one id per slice, in send order");
  ok("writer: long reply streams as multiple live messages, settles in place");

  // code fence spanning a slice boundary: every live message shows balanced
  // fences while streaming (the preview uses the same splitter as the post)
  const f2 = makeChannel();
  const w13 = new ResponseWriter({
    channel: f2.channel as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  w13.start();
  const codeLines = Array.from({ length: 40 }, (_, i) => `const value${String(i).padStart(2, "0")} = ${"x".repeat(50)};`);
  const codeText = ["Here is the code:", "```ts", ...codeLines, "```", "Done."].join("\n");
  w13.chunk(codeText);
  await ticks(2);
  assert.ok(f2.sent.length >= 2, `fence spans a slice boundary (got ${f2.sent.length} messages)`);
  for (const c of f2.sent) {
    const fenceLines = c.split("\n").filter((l) => /^\s*(`{3,}|~{3,})/.test(l)).length;
    assert.equal(fenceLines % 2, 0, `unbalanced fences in live message: ${JSON.stringify(c.slice(0, 40))}`);
  }
  const p13 = await w13.finish(codeText);
  assert.ok(p13!.text.includes("```ts"), "final reply keeps the fence");
  assert.equal(p13!.messageIds.length, f2.sent.length);
  ok("writer: live slices keep code fences balanced across messages");
}

// -------------------------------------------------------------- executor --
{
  assert.deepEqual(parseToolArgs(""), {});
  assert.deepEqual(parseToolArgs(' {"a": 1} '), { a: 1 });
  assert.throws(() => parseToolArgs("not json"), /not valid JSON/);
  assert.throws(() => parseToolArgs("[1,2]"), /JSON object/);
  assert.equal(argString({ q: " hi " }, "q"), "hi");
  assert.throws(() => argString({}, "q"), /missing required/);
  assert.equal(argOptionalString({ p: "x" }, "p"), "x");
  assert.equal(argOptionalString({}, "p"), undefined);
  assert.equal(argInt({ n: 99 }, "n", 5, 1, 10), 10, "clamped to max");
  assert.equal(argInt({}, "n", 5, 1, 10), 5, "default");
  assert.throws(() => argInt({ n: "x" }, "n", 5, 1, 10), /integer/);
  ok("executor: arg parsing and clamping");

  const order: string[] = [];
  const registry = new ToolRegistry()
    .register(
      { name: "echo", description: "", parameters: {} },
      async (args) => {
        order.push("start");
        await ticks(2);
        order.push("end");
        return `echo:${JSON.stringify(args)}`;
      },
    )
    .register({ name: "boom", description: "", parameters: {} }, async () => {
      throw new Error("kaboom");
    });
  assert.equal(registry.size, 2);
  assert.deepEqual(registry.specs().map((s) => s.name), ["echo", "boom"]);
  assert.throws(
    () => registry.register({ name: "echo", description: "", parameters: {} }, async () => ""),
    /already registered/,
  );
  ok("executor: registry holds specs and rejects duplicates");

  const results = await executeToolCalls(registry, [
    { id: "c1", name: "echo", arguments: '{"x": 1}' },
    { id: "c2", name: "nope", arguments: "{}" },
    { id: "c3", name: "echo", arguments: "broken{" },
    { id: "c4", name: "boom", arguments: "{}" },
  ]);
  assert.deepEqual(results.map((r) => r.toolCallId), ["c1", "c2", "c3", "c4"], "order preserved");
  assert.equal(results[0].role, "tool");
  assert.equal(results[0].name, "echo");
  assert.equal(results[0].content, 'echo:{"x":1}');
  assert.match(results[1].content, /unknown tool "nope"/);
  assert.match(results[2].content, /not valid JSON/);
  assert.match(results[3].content, /kaboom/);
  ok("executor: unknown tools and bad args become Error results, order kept");

  order.length = 0;
  await executeToolCalls(registry, [
    { id: "a", name: "echo", arguments: "{}" },
    { id: "b", name: "echo", arguments: "{}" },
  ]);
  assert.deepEqual(order, ["start", "start", "end", "end"], "calls run concurrently");
  ok("executor: tool calls run concurrently");
}

// ------------------------------------------------------------------- loop --
{
  const registry = new ToolRegistry().register(
    { name: "echo", description: "", parameters: {} },
    async (args: Record<string, unknown>) => `echo:${JSON.stringify(args)}`,
  );

  // two rounds: a tool call, then the final answer
  const script: ChatResult[] = [
    { content: "", toolCalls: [{ id: "t1", name: "echo", arguments: '{"x":"y"}' }] },
    { content: "final answer", toolCalls: [] },
  ];
  let i = 0;
  const specsSeen: Array<unknown> = [];
  const callsSeen: Array<unknown> = [];
  const messages: ChatMessage[] = [{ role: "user", content: "go" }];
  const out = await runToolTurn(messages, {
    chat: async (_msgs, _cb, tools) => {
      specsSeen.push(tools);
      return script[i++];
    },
    registry,
    maxRounds: 3,
    onToolCalls: (calls) => callsSeen.push(calls),
  });
  assert.equal(out.content, "final answer");
  assert.equal(out.toolRounds, 1);
  assert.equal(out.exhausted, false);
  assert.equal(specsSeen.length, 2);
  assert.ok(Array.isArray(specsSeen[0]) && (specsSeen[0] as unknown[]).length === 1, "specs sent while tools registered");
  const last = messages[messages.length - 1];
  assert.equal(last.role, "tool");
  assert.equal(last.toolCallId, "t1");
  assert.equal(last.content, 'echo:{"x":"y"}');
  const prev = messages[messages.length - 2];
  assert.equal(prev.role, "assistant");
  assert.deepEqual(prev.toolCalls, script[0].toolCalls);
  assert.deepEqual(callsSeen, [script[0].toolCalls], "onToolCalls fires once with the round's calls");
  ok("loop: tool round executed, results appended, final answer returned");

  // Reasoning + rounds: each executed round's reasoning travels with the
  // next request (sent back so a reasoning model continues its own
  // thinking) and is reported to onRoundComplete (the caller records the
  // whole turn in the channel history); the final round's reasoning is on
  // the outcome.
  const scriptR: ChatResult[] = [
    { content: "checking the units", reasoning: "unit analysis first", toolCalls: [{ id: "t1", name: "echo", arguments: "{}" }] },
    { content: "final with thinking", reasoning: "wrapping up", toolCalls: [] },
  ];
  let iR = 0;
  const roundsSeen: Array<Record<string, unknown>> = [];
  const roundSignals: number[] = [];
  const msgsR: ChatMessage[] = [{ role: "user", content: "go" }];
  const outR = await runToolTurn(msgsR, {
    chat: async (msgs) => {
      const n = iR;
      if (n === 1) {
        // The second request must carry the first round's full conversation:
        // the assistant's text + reasoning + calls, then the tool result.
        const a = msgs[1];
        const t = msgs[2];
        assert.equal(a.role, "assistant");
        assert.equal(a.content, "checking the units");
        assert.equal(a.reasoningContent, "unit analysis first", "the round's reasoning travels with the next request");
        assert.deepEqual(a.toolCalls, scriptR[0].toolCalls);
        assert.equal(t.role, "tool");
        assert.equal(t.toolCallId, "t1");
        assert.equal(t.content, "echo:{}");
        roundSignals.push(msgs.length);
      }
      return scriptR[iR++];
    },
    registry,
    maxRounds: 3,
    onToolRound: async () => {
      roundSignals.push(-1);
    },
    onRoundComplete: (r) => {
      roundsSeen.push(r as unknown as Record<string, unknown>);
    },
  });
  assert.equal(outR.content, "final with thinking");
  assert.equal(outR.toolRounds, 1);
  assert.equal(outR.reasoning, "wrapping up", "the final round's reasoning is on the outcome");
  assert.deepEqual(roundSignals, [-1, 3], "onToolRound settles before the tools run, the request carries text+assistant+tool");
  assert.equal(roundsSeen.length, 1, "onRoundComplete fires once per executed round");
  assert.equal(roundsSeen[0].content, "checking the units");
  assert.equal(roundsSeen[0].reasoning, "unit analysis first");
  assert.deepEqual(roundsSeen[0].calls, scriptR[0].toolCalls);
  assert.deepEqual(roundsSeen[0].results, [{ role: "tool", toolCallId: "t1", name: "echo", content: "echo:{}" }]);
  ok("loop: round reasoning travels with the next request and is reported to onRoundComplete");

  // budget exhausted: the model keeps requesting tools
  let toolRoundSignals = 0;
  const callsSeen2: Array<unknown> = [];
  const out2 = await runToolTurn([{ role: "user", content: "go" }], {
    chat: async () => ({ content: "", toolCalls: [{ id: "t", name: "echo", arguments: "{}" }] }),
    registry,
    maxRounds: 2,
    onToolRound: () => toolRoundSignals++,
    onToolCalls: (calls) => callsSeen2.push(calls),
  });
  assert.equal(out2.exhausted, true);
  assert.equal(out2.toolRounds, 2);
  assert.equal(toolRoundSignals, 2, "onToolRound fires only for the rounds that execute — the cutoff round's text is the final reply, not transient");
  assert.equal(callsSeen2.length, 2, "onToolCalls fires only for executed rounds, not the cutoff");
  ok("loop: maxRounds cutoff reported as exhausted");

  // empty registry: plain chat, no tools argument
  let gotTools: unknown = "unset";
  const out3 = await runToolTurn([{ role: "user", content: "hi" }], {
    chat: async (_m, _d, tools) => {
      gotTools = tools;
      return { content: "hi", toolCalls: [] };
    },
    registry: new ToolRegistry(),
    maxRounds: 1,
  });
  assert.equal(out3.content, "hi");
  assert.equal(gotTools, undefined, "no tools argument when the registry is empty");
  ok("loop: empty registry means a plain chat");
}

// -------------------------------------------------------------- tools --
{
  // The system note advertises exactly the enabled families: the model
  // must never claim a tool that is not registered (the note used to be
  // static, listing all four families even when only one was enabled).
  const base = {
    DISCORD_TOKEN: "t",
    DISCORD_GUILD_ID: "g",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
  };
  const { config: zimCfg, errors: zimErrs } = parseConfig({
    ...base,
    ZIMTOOLS_ENABLED: "true",
    ZIM_FILE: "/tmp/wiki.zim",
  });
  assert.deepEqual(zimErrs, []);
  const zimOnly = buildTools(zimCfg);
  assert.equal(zimOnly.registry.size, 2);
  assert.ok(zimOnly.systemNote?.includes("wikipedia_search"));
  assert.ok(zimOnly.systemNote?.includes("wikipedia_read"));
  assert.ok(!zimOnly.systemNote?.includes("web_search"), "web tools not advertised");
  assert.ok(!zimOnly.systemNote?.includes("web_fetch"), "web tools not advertised");
  assert.ok(!zimOnly.systemNote?.includes("file_"), "file tools not advertised");
  assert.ok(!zimOnly.systemNote?.includes("shell_exec"), "shell tool not advertised");
  assert.ok(!zimOnly.systemNote?.includes("vault_"), "vault tools not advertised");
  assert.ok(zimOnly.systemNote?.includes("Summarize tool results"), "the common rule stays");
  const { config: vaultOnlyCfg, errors: vaultOnlyErrs } = parseConfig({
    ...base,
    VAULTTOOLS_ENABLED: "true",
    VAULT_DIR: "/tmp/vault",
  });
  assert.deepEqual(vaultOnlyErrs, []);
  const vaultOnly = buildTools(vaultOnlyCfg);
  assert.equal(vaultOnly.registry.size, 3);
  for (const name of ["vault_search", "vault_read", "vault_links"]) {
    assert.ok(vaultOnly.systemNote?.includes(name), `the note advertises ${name}`);
  }
  assert.ok(!vaultOnly.systemNote?.includes("wikipedia_"), "zim tools not advertised");
  const { config: allCfg, errors: allErrs } = parseConfig({
    ...base,
    WEBTOOLS_ENABLED: "true",
    FILETOOLS_ENABLED: "true",
    SHELLTOOLS_ENABLED: "true",
    ZIMTOOLS_ENABLED: "true",
    ZIM_FILE: "/tmp/wiki.zim",
    VAULTTOOLS_ENABLED: "true",
    VAULT_DIR: "/tmp/vault",
  });
  assert.deepEqual(allErrs, []);
  const all = buildTools(allCfg);
  assert.equal(all.registry.size, 11);
  for (const name of [
    "web_search",
    "web_fetch",
    "file_read",
    "file_write",
    "file_edit",
    "shell_exec",
    "wikipedia_search",
    "wikipedia_read",
    "vault_search",
    "vault_read",
    "vault_links",
  ]) {
    assert.ok(all.systemNote?.includes(name), `the note advertises ${name}`);
  }
  const { config: noneCfg, errors: noneErrs } = parseConfig(base);
  assert.deepEqual(noneErrs, []);
  const none = buildTools(noneCfg);
  assert.equal(none.registry.size, 0);
  assert.equal(none.systemNote, null, "nothing registered, no note");
  ok("tools: the system note lists exactly the enabled families (null with none)");
}

// ------------------------------------------------------------- activity --
{
  // one persistent line per call: icon, name, up to two args, … for the rest
  assert.equal(
    formatToolCall({ id: "a1", name: "web_search", arguments: '{"query":"quantum computing","n":5,"lang":"en"}' }),
    '🔎 *web_search(query="quantum computing", n=5, …)*',
  );
  assert.equal(formatToolCall({ id: "a2", name: "file_read", arguments: '{"path":"notes.md"}' }), '📁 *file_read(path="notes.md")*');
  assert.equal(formatToolCall({ id: "a5", name: "shell_exec", arguments: '{"command":"git status"}' }), '🐚 *shell_exec(command="git status")*');
  assert.equal(formatToolCall({ id: "a3", name: "mystery_tool", arguments: "not json" }), "🔧 *mystery_tool*", "unparseable args tolerated");

  const longUrl = "https://example.com/" + "x".repeat(200);
  const oneLine = formatToolCall({ id: "b1", name: "web_fetch", arguments: JSON.stringify({ url: longUrl }) });
  assert.ok(oneLine.includes("…"), "long values truncated");
  assert.ok(oneLine.length < 200, `line stays short (${oneLine.length})`);

  assert.equal(formatToolCall({ id: "d1", name: "web_search", arguments: '{"query":"a*b*c"}' }), '🔎 *web_search(query="abc")*', "asterisks dropped so the italics stay intact");
  // JSON-escaped backslash: the parsed query value is the LaTeX `$\alpha$`
  assert.equal(formatToolCall({ id: "d2", name: "web_search", arguments: '{"query":"$x^2$ and $\\\\alpha$"}' }), '🔎 *web_search(query="x² and α")*', "math in args sanitized");
  ok("activity: one line per call, args truncated, asterisks dropped, math sanitized");

  // The turn's whole tool activity lives in a single message (posted by the
  // first round, edited in place by every later round — a round's calls
  // arrive together, so they cost one edit) — one new Discord message per
  // turn, no matter how many calls run.
  const batched: Array<{ id: string; content: string; edits: number }> = [];
  const batchedChan = {
    send: async (data: { content: string }) => {
      const m = { id: `ta${String(batched.length + 1)}`, content: data.content, edits: 0 };
      batched.push(m);
      return {
        id: m.id,
        content: m.content,
        edit: async (u: { content: string }) => {
          m.content = u.content;
          m.edits += 1;
          return m;
        },
      };
    },
  };
  const wAct = new ResponseWriter({
    channel: batchedChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  await wAct.appendActivityLines([
    formatToolCall({ id: "t1", name: "web_search", arguments: '{"query":"quantum computing"}' }),
    formatToolCall({ id: "t2", name: "file_read", arguments: '{"path":"notes.md"}' }),
    formatToolCall({ id: "t3", name: "shell_exec", arguments: '{"command":"git status"}' }),
  ]);
  assert.equal(batched.length, 1, "one new message for the whole turn");
  assert.equal(batched[0].edits, 0, "the first round posts, not edits");
  assert.equal(
    batched[0].content,
    ['🔎 *web_search(query="quantum computing")*', '📁 *file_read(path="notes.md")*', '🐚 *shell_exec(command="git status")*'].join("\n"),
    "a round's lines land together, in call order",
  );
  await wAct.appendActivityLines([formatToolCall({ id: "t4", name: "wikipedia_search", arguments: '{"query":"z"}' })]);
  assert.equal(batched.length, 1, "the second round reuses the message");
  assert.equal(batched[0].edits, 1, "later rounds edit it in place");
  assert.ok(batched[0].content.endsWith('📚 *wikipedia_search(query="z")*'), "the new round's line is appended");
  assert.match(batched[0].content, /^🔎 \*/, "the first line keeps its icon (the message stays a UI line, never context)");
  ok("activity: the turn's rounds share one message (posted once, edited in place)");

  // The 2000-char cap: the oldest lines are dropped behind the "… N earlier
  // calls …" header (which keeps a leading icon, so the message stays a UI
  // line) and the newest lines are kept.
  let capSends = 0;
  let capContent = "";
  const capChan = {
    send: async (data: { content: string }) => {
      capSends += 1;
      capContent = data.content;
      return {
        id: "tc1",
        content: capContent,
        edit: async (u: { content: string }) => {
          capContent = u.content;
          return { id: "tc1", content: capContent };
        },
      };
    },
  };
  const wCap = new ResponseWriter({
    channel: capChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  const capArgs = JSON.stringify({ query: "q".repeat(60), url: "https://example.com/" + "x".repeat(60) });
  await wCap.appendActivityLines(
    Array.from({ length: 40 }, (_, i) => formatToolCall({ id: `c${String(i)}`, name: "web_search", arguments: capArgs })),
  );
  assert.equal(capSends, 1, "still one message after 40 calls");
  assert.ok(capContent.length <= 2000, `the cap keeps the message under 2000 (got ${capContent.length})`);
  const capLines = capContent.split("\n");
  const earlier = Number(capLines[0].match(/… (\d+) earlier activity lines …/)?.[1] ?? -1);
  assert.ok(earlier > 0, `the header counts the dropped lines (got: ${capLines[0]})`);
  assert.equal(earlier + capLines.length - 1, 40, "kept + dropped = every call");
  assert.match(capLines[capLines.length - 1], /web_search/, "the newest lines are kept");
  // A round thinking under a nearly-full message: the live preview gets the
  // room the settled lines leave, and the message never overflows.
  await wCap.reason("still thinking…");
  await ticks(2);
  assert.ok(capContent.length <= 2000, `the preview fits the remaining room (got ${capContent.length})`);
  assert.match(capContent, /^🔧 \*… \d+ earlier activity lines …\*\n/, "the header leads");
  assert.ok(capContent.endsWith("🤔 *thinking: still thinking…*"), "the preview trails the kept lines");
  ok("activity: the 2000-char cap drops the oldest lines behind the header");

  // A failed first post is retried on the next round (the retry carries
  // every call so far); a failed edit keeps the last good content and is
  // retried the same way.
  const flaky = { sends: 0, edits: 0, content: "", failSend: false, failEdit: false };
  const flakyChan = {
    send: async (data: { content: string }) => {
      flaky.sends += 1;
      if (flaky.failSend) {
        flaky.failSend = false;
        throw new Error("rate limited");
      }
      flaky.content = data.content;
      return {
        id: "tf1",
        content: flaky.content,
        edit: async (u: { content: string }) => {
          flaky.edits += 1;
          if (flaky.failEdit) {
            flaky.failEdit = false;
            throw new Error("rate limited");
          }
          flaky.content = u.content;
          return { id: "tf1", content: flaky.content };
        },
      };
    },
  };
  const wFlaky = new ResponseWriter({
    channel: flakyChan as unknown as GuildTextBasedChannel,
    typingIntervalMs: 3_600_000,
    throttleMs: 2000,
  });
  flaky.failSend = true;
  await wFlaky.appendActivityLines([formatToolCall({ id: "f1", name: "web_search", arguments: '{"query":"a"}' })]);
  assert.equal(flaky.sends, 1, "the first post was attempted");
  await wFlaky.appendActivityLines([formatToolCall({ id: "f2", name: "file_read", arguments: '{"path":"b"}' })]);
  assert.equal(flaky.sends, 2, "the failed post is retried on the next round");
  assert.ok(flaky.content.includes("web_search") && flaky.content.includes("file_read"), "the retried post carries every call");
  flaky.failEdit = true;
  await wFlaky.appendActivityLines([formatToolCall({ id: "f3", name: "shell_exec", arguments: '{"command":"c"}' })]);
  assert.equal(flaky.edits, 1, "the edit was attempted");
  assert.ok(!flaky.content.includes("shell_exec"), "a failed edit keeps the last good content");
  await wFlaky.appendActivityLines([formatToolCall({ id: "f4", name: "wikipedia_search", arguments: '{"query":"d"}' })]);
  assert.equal(flaky.edits, 2, "the next round retries the edit");
  assert.ok(flaky.content.includes("shell_exec") && flaky.content.includes("wikipedia_search"), "the retried edit carries every call");
  ok("activity: failed posts/edits are retried on the next round");
}

// ------------------------------------------------------------ web tools --
// The in-process web tools used to be tested in the Python sidecar smoke
// suite; these groups pin the TS port.
{
  const fakeResolver =
    (addrs: string | string[]): ((host: string, port: number) => Promise<string[]>) =>
    async (_host: string, _port: number): Promise<string[]> => (Array.isArray(addrs) ? addrs : [addrs]);

  const pub = await resolveUrl("http://example.com/a?b=1", { resolver: fakeResolver("93.184.216.34") });
  assert.equal(pub.ip, "93.184.216.34");
  assert.equal(pub.port, 80);
  assert.equal(pub.path, "/a?b=1");
  const pubPort = await resolveUrl("http://example.com:8080/x", { resolver: fakeResolver("203.0.113.7") });
  assert.equal(pubPort.port, 8080);
  const https = await resolveUrl("https://example.com", { resolver: fakeResolver("2001:4860:4860::8888") });
  assert.equal(https.scheme, "https");
  assert.equal(https.port, 443);
  assert.equal(https.path, "/");
  ok("ssrf: public hosts pinned, scheme/port/path preserved");

  const blocked: Array<[string, string[]]> = [
    ["http://127.0.0.1/", ["127.0.0.1"]],
    ["http://10.1.2.3/", ["10.1.2.3"]],
    ["http://172.16.0.9/", ["172.16.0.9"]],
    ["http://192.168.0.9/", ["192.168.0.9"]],
    ["http://169.254.169.254/latest/meta-data/", ["169.254.169.254"]],
    ["http://100.64.1.2/", ["100.64.1.2"]],
    ["http://[::1]/", ["::1"]],
    ["http://[fe80::1]/", ["fe80::1"]],
    ["http://[fd12::1]/", ["fd12::1"]],
    ["http://[::ffff:10.0.0.1]/", ["::ffff:10.0.0.1"]],
  ];
  for (const [url, addrs] of blocked) {
    await assert.rejects(resolveUrl(url, { resolver: fakeResolver(addrs) }), /blocked/i);
  }
  ok("ssrf: loopback/RFC1918/link-local/CGNAT/ULA and mapped-v4 blocked");

  await assert.rejects(
    resolveUrl("http://example.com/", { resolver: fakeResolver(["93.184.216.34", "10.0.0.8"]) }),
    /blocked/i,
  );
  ok("ssrf: mixed public/private records refused (strict)");

  const priv = await resolveUrl("http://127.0.0.1:9/", { allowPrivate: true, resolver: fakeResolver("127.0.0.1") });
  assert.equal(priv.port, 9);
  ok("ssrf: allowPrivate escape hatch");

  await assert.rejects(resolveUrl("ftp://example.com/", { resolver: fakeResolver("93.184.216.34") }), /scheme/i);
  await assert.rejects(resolveUrl("http://user:pw@example.com/", { resolver: fakeResolver("93.184.216.34") }), /credential/i);
  await assert.rejects(resolveUrl("http://nope.invalid/", { resolver: async () => { throw new Error("boom"); } }), /could not resolve/i);
  await assert.rejects(resolveUrl("not a url", {}), /invalid URL/i);
  ok("ssrf: bad scheme/credentials/resolve failures rejected");

  let now = 1_000;
  const cache = new FetchCache<string>(100, 2, () => now);
  cache.put("a", "1");
  assert.equal(cache.get("a"), "1");
  now = 1_099;
  assert.equal(cache.get("a"), "1");
  now = 1_101;
  assert.equal(cache.get("a"), null);
  cache.put("a", "1");
  cache.put("b", "2");
  cache.put("c", "3");
  assert.equal(cache.get("a"), null); // evicted: oldest entry
  assert.equal(cache.get("b"), "2");
  assert.equal(cache.get("c"), "3");
  ok("cache: TTL expiry and oldest-first eviction");

  const html =
    "<!doctype html><html><head><title>  My Page  </title><script>var x=1;</script></head>" +
    "<body><nav>menu</nav><article><h1>Head</h1><p>First paragraph.</p><pre>  keep  spaces  </pre></article><footer>foot</footer></body></html>";
  assert.equal(extractTitle(html), "My Page");
  const content = extractContent(html);
  assert.ok(content.includes("First paragraph."), content);
  assert.ok(content.includes("keep  spaces"), "pre whitespace preserved");
  assert.ok(!content.includes("menu"), "nav dropped");
  assert.ok(!content.includes("foot"), "footer dropped");
  assert.ok(!content.includes("var x=1;"), "script dropped");
  assert.equal(extractTitle("<html><body>t</body></html>"), "");
  assert.equal(extractContent(""), "");
  ok("extract: title and main content, noise and scripts dropped");

  const ddg = (_q: string): Promise<Response> =>
    Promise.resolve(
      new Response(
        "<!doctype html><html><body>" +
          '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">A</a>' +
          '<a class="result__snippet" href="#">Snippet A</a>' +
          '<a class="result__a" href="https://example.com/b">B</a>' +
          "</body></html>",
      ),
    );
  const results = await searchDuckDuckGo("cats", 10, { fetchImpl: ddg, timeoutMs: 1000 });
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/a");
  assert.equal(results[0].snippet, "Snippet A");
  assert.equal(results[1].url, "https://example.com/b");
  assert.equal(results[1].snippet, "");
  const capped = await searchDuckDuckGo("cats", 1, { fetchImpl: ddg, timeoutMs: 1000 });
  assert.equal(capped.length, 1);
  await assert.rejects(
    searchDuckDuckGo("cats", 5, { fetchImpl: async () => new Response("nope", { status: 503 }), timeoutMs: 1000 }),
    /HTTP 503/,
  );
  await assert.rejects(searchDuckDuckGo("  ", 5, { fetchImpl: ddg, timeoutMs: 1000 }), /must not be empty/i);
  ok("web search: DDG rows normalized, redirect links unwrapped, capped, errors");
}

// ------------------------------------------------------------ file tools --
// In-process file tools (path confinement + operations) ported from the
// removed Python sidecar; these groups pin the TS port.
{
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "glove-filetest-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "glove-outside-")));
  try {
    // -- confinement
    fs.mkdirSync(path.join(ws, "sub"));
    const fileInSub = path.join(ws, "sub", "a.txt");
    fs.writeFileSync(fileInSub, "hello");
    assert.equal(resolveInWorkspace(ws, "sub/a.txt"), fileInSub);
    assert.equal(resolveInWorkspace(ws, "/sub/a.txt"), fileInSub);
    assert.equal(resolveInWorkspace(ws, undefined), ws);
    assert.equal(resolveInWorkspace(ws, "."), ws);
    assert.throws(() => resolveInWorkspace(ws, "../outside"), /escapes/);
    assert.throws(() => resolveInWorkspace(ws, "sub/../../outside"), /escapes/);
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    fs.symlinkSync(outside, path.join(ws, "link"));
    assert.throws(() => resolveInWorkspace(ws, "link/secret.txt"), /escapes/);
    fs.symlinkSync(fileInSub, path.join(ws, "sub", "alias.txt"));
    assert.equal(resolveInWorkspace(ws, "sub/alias.txt"), fileInSub);
    ok("file paths: traversal and symlink escapes rejected, inner symlinks ok");

    const ops: fileOps.FileOpsOptions = {
      readMaxBytes: 1000,
      writeMaxBytes: 10,
    };

    // -- write
    const w1 = await fileOps.writeFile(ws, "notes/a.txt", "hello\n", true, ops.writeMaxBytes);
    assert.equal(w1.bytesWritten, 6);
    await assert.rejects(fileOps.writeFile(ws, "no/dirs/x.txt", "x", false, 10), /does not exist/);
    await assert.rejects(fileOps.writeFile(ws, "notes/a.txt", "x".repeat(11), true, 10), /write cap/);
    await assert.rejects(fileOps.writeFile(ws, "notes", "x", true, 10), /overwrite a directory/);
    ok("file write: create_dirs, cap, directory guard");

    // -- read
    fs.writeFileSync(path.join(ws, "big.txt"), "abcdef");
    const r1 = await fileOps.readFile(ws, "big.txt", 0, 2, ops.readMaxBytes);
    assert.equal(r1.content, "ab");
    assert.equal(r1.bytesRead, 2);
    assert.ok(r1.truncated);
    const r2 = await fileOps.readFile(ws, "big.txt", 4, undefined, ops.readMaxBytes);
    assert.equal(r2.content, "ef");
    assert.ok(!r2.truncated);
    await assert.rejects(fileOps.readFile(ws, "big.txt", 7, undefined, 100), /past the end/);
    fs.writeFileSync(path.join(ws, "bin.dat"), Buffer.from([0, 1, 2]));
    await assert.rejects(fileOps.readFile(ws, "bin.dat", 0, undefined, 100), /binary/);
    await assert.rejects(fileOps.readFile(ws, "notes", 0, undefined, 100), /not a file/);
    await assert.rejects(fileOps.readFile(ws, "missing.txt", 0, undefined, 100), /not a file/);
    ok("file read: windows, truncation, binary refusal, errors");

    // -- edit
    fs.writeFileSync(path.join(ws, "e.txt"), "aXbXcXa");
    const eAll = await fileOps.editFile(ws, "e.txt", "X", "Y", true, ops.readMaxBytes, ops.writeMaxBytes);
    assert.equal(eAll.replacements, 3);
    assert.equal(fs.readFileSync(path.join(ws, "e.txt"), "utf8"), "aYbYcYa");
    const eFirst = await fileOps.editFile(ws, "e.txt", "Y", "Z", false, ops.readMaxBytes, ops.writeMaxBytes);
    assert.equal(eFirst.replacements, 1);
    assert.equal(fs.readFileSync(path.join(ws, "e.txt"), "utf8"), "aZbYcYa");
    await assert.rejects(
      fileOps.editFile(ws, "e.txt", "", "x", false, ops.readMaxBytes, ops.writeMaxBytes),
      /must not be empty/,
    );
    await assert.rejects(
      fileOps.editFile(ws, "e.txt", "nope", "x", false, ops.readMaxBytes, ops.writeMaxBytes),
      /not found/,
    );
    fs.writeFileSync(path.join(ws, "bad.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    await assert.rejects(
      fileOps.editFile(ws, "bad.txt", "x", "y", false, ops.readMaxBytes, ops.writeMaxBytes),
      /not valid UTF-8/,
    );
    await assert.rejects(
      fileOps.editFile(ws, "missing.txt", "x", "y", false, ops.readMaxBytes, ops.writeMaxBytes),
      /not a file/,
    );
    // Caps: a file larger than the read cap is refused before reading, and
    // an edit that grows the content past the write cap is refused (the
    // file is left untouched).
    fs.writeFileSync(path.join(ws, "bigedit.txt"), "Q".repeat(1500));
    await assert.rejects(
      fileOps.editFile(ws, "bigedit.txt", "Q", "R", false, 1000, 10),
      /too large to edit/,
    );
    fs.writeFileSync(path.join(ws, "ecap.txt"), "ab");
    await assert.rejects(fileOps.editFile(ws, "ecap.txt", "ab", "a".repeat(11), false, 1000, 10), /write cap/);
    assert.equal(fs.readFileSync(path.join(ws, "ecap.txt"), "utf8"), "ab", "rejected edit leaves the file untouched");
    ok("file edit: exact span, replace_all, empty new_text, caps, errors");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ shell tools --
// The in-process shell tool: commands run via /bin/sh in a temp workspace,
// with a deadline and a combined output cap (exit code, stdout, stderr,
// timeout kill, buffer-overflow kill, missing workdir).
{
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "glove-shelltest-")));
  const tools = new ShellTools({ cwd: ws, timeoutMs: 2000, maxOutputBytes: 1000, maxResultChars: 50_000 });
  try {
    const out = await tools.exec("echo hello && echo world >&2", 10);
    assert.ok(out.startsWith("$ echo hello && echo world >&2"), out);
    assert.ok(out.includes("exit: 0"), out);
    assert.ok(out.includes("stdout:\nhello"), out);
    assert.ok(out.includes("stderr:\nworld"), out);
    ok("shell: exit code, stdout and stderr reported");

    const bad = await tools.exec("exit 3", 10);
    assert.ok(bad.includes("exit: 3"), bad);
    assert.ok(bad.includes("(no output)"), bad);
    ok("shell: non-zero exit, no-output note");

    const slow = await tools.exec("sleep 5", 1);
    assert.ok(slow.includes("timed out after 1s (killed)"), slow);
    ok("shell: deadline kills a slow command");

    const flood = await tools.exec("yes | head -c 100000", 10);
    assert.ok(flood.includes("output exceeded the 1000 byte cap (killed)"), flood);
    ok("shell: output cap kills a chatty command, partial output returned");

    const noWs = new ShellTools({ cwd: path.join(ws, "nope"), timeoutMs: 1000, maxOutputBytes: 1000, maxResultChars: 50_000 });
    await assert.rejects(noWs.exec("true", 5), /does not exist/);
    ok("shell: missing working directory refused");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ zim tools --
// The ZIM (offline Wikipedia) reader and tools, exercised against a small
// synthetic ZIM v6 archive built in a temp dir (one zstd whole-frame
// cluster, one raw cluster, redirects, a non-C namespace).
{
  // -- synthetic archive writer
  const wikiHtml = (inner: string): string =>
    "<!doctype html><html><head><title>t</title></head><body>" +
    '<div id="mw-content-text" class="mw-body-content"><div class="mw-parser-output">' +
    inner +
    '<div class="reflist"><ol class="references"><li>[1] a fake citation</li></ol></div>' +
    '<div class="navbox">nav junk</div>' +
    '<div class="zim-footer">This article is issued from Wikipedia.</div>' +
    "</div></div></body></html>";

  const clusterTable = (blobs: Buffer[], osz: number): Buffer => {
    const n = blobs.length + 1; // one more offset than blobs
    const table = Buffer.alloc(n * osz);
    let pos = n * osz;
    for (let i = 0; i < n; i++) {
      if (osz === 4) table.writeUInt32LE(pos, i * 4);
      else table.writeBigUInt64LE(BigInt(pos), i * 8);
      if (i < blobs.length) pos += blobs[i].length;
    }
    return table;
  };
  const zstdCluster = (blobs: Buffer[]): Buffer =>
    Buffer.concat([Buffer.from([0x05]), zstdCompressSync(Buffer.concat([clusterTable(blobs, 4), ...blobs]))]);
  const rawCluster = (blobs: Buffer[]): Buffer =>
    Buffer.concat([Buffer.from([0x01]), clusterTable(blobs, 4), ...blobs]);

  const contentDirent = (ns: string, pathName: string, title: string, cluster: number, blob: number): Buffer => {
    const fixed = Buffer.alloc(16);
    fixed.writeUInt16LE(0, 0); // mime 0 = text/html
    fixed[2] = 0;
    fixed[3] = ns.charCodeAt(0);
    fixed.writeUInt32LE(1, 4); // revision
    fixed.writeUInt32LE(cluster, 8);
    fixed.writeUInt32LE(blob, 12);
    return Buffer.concat([fixed, Buffer.from(pathName + "\0"), Buffer.from(title + "\0")]);
  };
  const redirectDirent = (ns: string, pathName: string, title: string, target: number): Buffer => {
    // A redirect dirent has a 12-byte fixed part (no cluster/blob fields).
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16LE(0xffff, 0);
    fixed[2] = 0;
    fixed[3] = ns.charCodeAt(0);
    fixed.writeUInt32LE(1, 4);
    fixed.writeUInt32LE(target, 8);
    return Buffer.concat([fixed, Buffer.from(pathName + "\0"), Buffer.from(title + "\0")]);
  };

  // Generic archive writer: [header][mime list][clusters][dirents]
  // [pathPtr list][clusterPtr list][16 zero bytes]. Dirents must be
  // pre-sorted by namespace+path.
  const writeZimArchive = (
    file: string,
    clusters: Buffer[],
    dirents: Buffer[],
    mime: Buffer = Buffer.concat([Buffer.from("text/html\0"), Buffer.from("text/plain\0"), Buffer.from("\0")]),
  ): void => {
    const base = 80 + mime.length;
    const clusterPtr = Buffer.alloc(8 * clusters.length);
    let cpos = base;
    for (let i = 0; i < clusters.length; i++) {
      clusterPtr.writeBigUInt64LE(BigInt(cpos), i * 8);
      cpos += clusters[i].length;
    }
    const pathPtr = Buffer.alloc(8 * dirents.length);
    let off = cpos;
    for (let i = 0; i < dirents.length; i++) {
      pathPtr.writeBigUInt64LE(BigInt(off), i * 8);
      off += dirents[i].length;
    }
    const pathPtrPos = BigInt(off);
    const clusterPtrPos = pathPtrPos + BigInt(pathPtr.length);
    const header = Buffer.alloc(80);
    header.writeUInt32LE(0x044d495a, 0); // magic
    header.writeUInt16LE(6, 4);
    header.writeUInt16LE(1, 6);
    header.writeUInt32LE(dirents.length, 24);
    header.writeUInt32LE(clusters.length, 28);
    header.writeBigUInt64LE(pathPtrPos, 32);
    header.writeBigUInt64LE(0xffffffffffffffffn, 40); // titlePtrPos (unused)
    header.writeBigUInt64LE(clusterPtrPos, 48);
    header.writeBigUInt64LE(80n, 56);
    header.writeUInt32LE(0xffffffff, 64); // mainPage (unused)
    header.writeUInt32LE(0xffffffff, 68); // layoutPage (unused);
    header.writeBigUInt64LE(pathPtrPos + BigInt(pathPtr.length + clusterPtr.length), 72); // checksumPos
    fs.writeFileSync(
      file,
      Buffer.concat([header, mime, ...clusters, ...dirents, pathPtr, clusterPtr, Buffer.alloc(16)]),
    );
  };

  const writeSmallZim = (file: string): void => {
    const aardvark = wikiHtml(
      '<div role="note" class="hatnote">"Aardvark" redirects here. For other uses, see <a>other</a>.</div>' +
        "<h1>Aardvark</h1>" +
        "<p>The aardvark is a stocky, long-snouted African mammal.</p>" +
        '<p>It is related to the <a href="Hyrax">hyrax</a> and the <i>porcupine</i>.</p>' +
        '<span class="mw-editsection">[edit]</span><math alttext="a^{2}">img</math>' +
        "<h2>References</h2>", // empty section after stripping: heading must vanish
    );
    const einstein = wikiHtml(
      '<h1>Albert Einstein</h1><p>Albert Einstein was a German-born theoretical physicist.</p>' +
        "<ul><li>special relativity</li><li>general relativity</li></ul>",
    );
    const zebra = wikiHtml("<h1>Zebra</h1><p>A zebra is a striped equine.</p>");
    const mainPage = wikiHtml("<h1>Main Page</h1><p>Welcome to the main page.</p>");
    writeZimArchive(
      file,
      [
        zstdCluster([Buffer.from(aardvark), Buffer.from(einstein)]),
        rawCluster([Buffer.from(zebra), Buffer.from(mainPage)]),
      ],
      [
        contentDirent("C", "Aardvark", "Aardvark", 0, 0),
        contentDirent("C", "Albert_Einstein", "Albert Einstein", 0, 1),
        redirectDirent("C", "Banana", "Banana", 1),
        redirectDirent("C", "Loop_A", "Loop A", 4),
        redirectDirent("C", "Loop_B", "Loop B", 3),
        contentDirent("C", "Zebra", "Zebra", 1, 0),
        contentDirent("W", "MainPage", "Main Page", 1, 1),
      ],
    );
  };

  const zimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "glove-zimtest-")));
  const zimFile = path.join(zimDir, "wiki.zim");
  const bigFile = path.join(zimDir, "big.zim");
  try {
    writeSmallZim(zimFile);
    // A 123-entry archive: > 64 entries forces the sequential byte-walk
    // scan path (the small archive only exercises the random-access path).
    {
      const n = 120;
      const blobs: Buffer[] = [];
      const dirents: Buffer[] = [];
      for (let i = 0; i < n; i++) {
        const name = `Article ${String(i).padStart(3, "0")}`;
        blobs.push(Buffer.from(wikiHtml(`<h1>${name}</h1><p>Synthetic body ${i}.</p>`)));
        dirents.push(contentDirent("C", `Article_${String(i).padStart(3, "0")}`, name, 0, i));
      }
      blobs.push(Buffer.from(wikiHtml("<h1>Whale</h1><p>A whale is a large marine mammal.</p>")));
      blobs.push(Buffer.from(wikiHtml("<h1>Xylophone</h1><p>A xylophone is a percussion instrument.</p>")));
      dirents.push(contentDirent("C", "Whale", "Whale", 0, n));
      dirents.push(contentDirent("C", "Xylophone", "Xylophone", 0, n + 1));
      dirents.push(contentDirent("C", "Yak", "Yak", 1, 0));
      writeZimArchive(
        bigFile,
        [zstdCluster(blobs), rawCluster([Buffer.from(wikiHtml("<h1>Yak</h1><p>A yak is a bovine.</p>"))])],
        dirents,
      );
    }
    const reader = await ZimReader.open(zimFile, { scanBudgetMs: 5000 });
    assert.equal(reader.entries, 7);

    // -- search
    let r = await reader.search("Aardvark", 5);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].title, "Aardvark");
    assert.equal(r.results[0].match, "exact");
    assert.equal(r.partial, false);
    r = await reader.search("albert einstein", 5);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].title, "Albert Einstein");
    assert.equal(r.results[0].match, "exact");
    r = await reader.search("albert", 5);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].title, "Albert Einstein");
    assert.equal(r.results[0].match, "prefix");
    r = await reader.search("ebra", 5);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].title, "Zebra");
    assert.equal(r.results[0].match, "substring");
    r = await reader.search("loop", 5);
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results.map((x) => x.title).sort(), ["Loop A", "Loop B"]);
    assert.ok(r.results.every((x) => x.redirect));
    r = await reader.search("Main Page", 5);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].ns, "W");
    r = await reader.search("zebrafish", 5);
    assert.equal(r.results.length, 0);
    await assert.rejects(reader.search("   ", 5), /must not be empty/);
    ok("zim reader: search exact/case-insensitive/prefix/substring/multi/none");

    // -- read
    let art = await reader.read("Aardvark", 10_000);
    assert.equal(art.title, "Aardvark");
    assert.ok(art.text.includes("long-snouted African mammal"), art.text);
    assert.ok(art.text.includes("# Aardvark"), "heading marked");
    assert.ok(art.text.includes("[a^{2}]"), "math alttext kept");
    assert.ok(art.text.includes("It is related to the hyrax and the porcupine."), "inline content stays on one line");
    assert.ok(!art.text.includes("redirects here"), "hatnote dropped");
    assert.ok(!art.text.includes("issued from"), "zim footer dropped");
    assert.ok(!art.text.includes("# References"), "empty section heading dropped");
    assert.ok(!art.text.includes("fake citation"), "references dropped");
    assert.ok(!art.text.includes("nav junk"), "navbox dropped");
    assert.ok(!art.text.includes("[edit]"), "edit spans dropped");
    assert.equal(art.truncated, false);
    art = await reader.read("Albert Einstein", 10_000);
    assert.equal(art.title, "Albert Einstein");
    assert.ok(art.text.includes("theoretical physicist"));
    art = await reader.read("Albert_Einstein", 10_000);
    assert.equal(art.title, "Albert Einstein"); // wiki-style path works too
    art = await reader.read("Zebra", 10_000);
    assert.ok(art.text.includes("striped equine"), "raw cluster readable");
    art = await reader.read("Banana", 10_000);
    assert.equal(art.title, "Albert Einstein", "redirect followed");
    assert.ok(art.text.includes("theoretical physicist"));
    art = await reader.read("Zebra", 10);
    assert.equal(art.truncated, true);
    assert.equal(art.text.length, 10);
    await assert.rejects(reader.read("Loop A", 100), /redirect loop/);
    await assert.rejects(reader.read("Pigeon", 100), /no article/);
    await assert.rejects(reader.read("", 100), /must not be empty/);
    ok("zim reader: read zstd/raw clusters, redirects, truncation, errors");
    await reader.close();

    // -- big archive: exercises the sequential byte-walk scan path
    const bigReader = await ZimReader.open(bigFile, { scanBudgetMs: 5000 });
    assert.equal(bigReader.entries, 123);
    let br = await bigReader.search("Article_042", 5);
    assert.equal(br.results.length, 1);
    assert.equal(br.results[0].title, "Article 042");
    assert.equal(br.results[0].match, "exact");
    br = await bigReader.search("a", 5);
    assert.equal(br.results.length, 5, "capped to the limit");
    assert.ok(br.results.every((x) => x.title.startsWith("Article ")), JSON.stringify(br.results));
    br = await bigReader.search("xylo", 5);
    assert.equal(br.results.length, 1);
    assert.equal(br.results[0].title, "Xylophone");
    assert.equal(br.results[0].match, "prefix");
    // The prefix scan window must be bounded, not the whole directory
    // (the old code padded the keys with \x00/\xff, which always yielded
    // [0, pathPtrLen)): for a mid-archive prefix it starts after the first
    // entries and spans far less than the directory.
    const win = bigReader as unknown as { pathPtrLen: number; prefixWindow: (q: string) => Promise<[number, number]> };
    const [wa, wb] = await win.prefixWindow("Xylo");
    assert.ok(wa > 0, `window start ${wa} is not after the first entries`);
    assert.ok(wb - wa < win.pathPtrLen, `window [${wa}, ${wb}) spans the whole directory`);
    const bart = await bigReader.read("Xylophone", 10_000);
    assert.ok(bart.text.includes("percussion instrument"));
    const bakt = await bigReader.read("Yak", 10_000);
    assert.ok(bakt.text.includes("bovine"), "raw cluster");
    await bigReader.close();
    ok("zim reader: big archive exact/prefix/capped search and reads via sequential walk");

    // -- bad files
    const badFile = path.join(zimDir, "bad.zim");
    fs.writeFileSync(badFile, Buffer.from("definitely not a zim archive, just some bytes"));
    await assert.rejects(ZimReader.open(badFile, { scanBudgetMs: 1000 }), /not a ZIM file/);
    const truncFile = path.join(zimDir, "trunc.zim");
    fs.writeFileSync(truncFile, fs.readFileSync(zimFile).subarray(0, 100));
    await assert.rejects(ZimReader.open(truncFile, { scanBudgetMs: 1000 }), /ZIM/);
    await assert.rejects(ZimReader.open(path.join(zimDir, "missing.zim"), { scanBudgetMs: 1000 }), /cannot open/);
    ok("zim reader: bad magic, truncated file, missing file rejected");

    // A mime list whose entries straddle the 64 KB read chunks: the carried
    // bytes must not be double-counted into the file offset (which used to
    // skip the tail, silently truncating the list).
    {
      const longMime1 = "a".repeat(70000);
      const longMime2 = "b".repeat(70000);
      const bigMime = Buffer.concat([
        Buffer.from("text/html\0"),
        Buffer.from(longMime1 + "\0"),
        Buffer.from("aaa\0"),
        Buffer.from(longMime2 + "\0"),
        Buffer.from("\0"),
      ]);
      const mimeFile = path.join(zimDir, "bigmime.zim");
      writeZimArchive(
        mimeFile,
        [rawCluster([Buffer.from("<h1>Mime</h1>")])],
        [contentDirent("C", "Mime", "Mime", 0, 0)],
        bigMime,
      );
      const mimeReader = await ZimReader.open(mimeFile, { scanBudgetMs: 1000 });
      assert.deepEqual((mimeReader as unknown as { mimeList: string[] }).mimeList, [
        "text/html",
        longMime1,
        "aaa",
        longMime2,
      ]);
      await mimeReader.close();
      ok("zim reader: mime list straddling read chunks is parsed whole");
    }

    // -- tool layer
    const tools = new ZimTools({ file: zimFile, maxResults: 8, scanBudgetMs: 5000, maxTextChars: 10_000 });
    const registry = new ToolRegistry();
    registerZimTools(registry, tools);
    assert.equal(registry.size, 2);
    assert.ok(registry.has("wikipedia_search"));
    assert.ok(registry.has("wikipedia_read"));
    const results = await executeToolCalls(registry, [
      { id: "z1", name: "wikipedia_search", arguments: '{"query": "loop"}' },
      { id: "z2", name: "wikipedia_read", arguments: '{"title": "Banana"}' },
    ]);
    assert.equal(results.length, 2);
    assert.ok(results[0].content.includes('2 match(es) for "loop"'), results[0].content);
    assert.ok(results[0].content.includes("Loop A [redirect]") || results[0].content.includes("Loop A"));
    assert.ok(results[0].content.includes("wikipedia_read"), "suggests the read tool");
    assert.ok(results[1].content.startsWith("Wikipedia: Albert Einstein"), results[1].content);
    assert.ok(results[1].content.includes("theoretical physicist"));
    const broken = new ZimTools({ file: path.join(zimDir, "missing.zim"), maxResults: 8, scanBudgetMs: 5000, maxTextChars: 10_000 });
    await assert.rejects(broken.search("x", 5), /cannot open/);
    // The no-match hint only suggests web_search when the web family is
    // registered (it used to suggest it unconditionally).
    const miss = await tools.search("definitely absent", 5);
    assert.ok(miss.startsWith("No article in the local Wikipedia archive matches"), miss);
    assert.ok(!miss.includes("web_search"), "no hint at a tool that is not registered");
    const withWeb = new ZimTools({ file: zimFile, maxResults: 8, scanBudgetMs: 5000, maxTextChars: 10_000, webSearchAvailable: true });
    assert.ok((await withWeb.search("definitely absent", 5)).includes("web_search"));
    withWeb.abort();
    tools.abort();
    ok("zim tools: registry wiring, search/read results, broken file surfaces as error");
    ok("zim tools: the no-match hint only suggests web_search when it is registered");

    // -- config
    const { config: zc, errors: ze } = parseConfig({
      DISCORD_TOKEN: "t",
      DISCORD_GUILD_ID: "g",
      MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
      ZIMTOOLS_ENABLED: "true",
      ZIM_FILE: "/tmp/wiki.zim",
      ZIMTOOLS_SEARCH_MAX_RESULTS: "4",
      ZIMTOOLS_SCAN_BUDGET_S: "3",
    });
    assert.deepEqual(ze, []);
    assert.equal(zc.tools.zim.enabled, true);
    assert.equal(zc.tools.zim.file, "/tmp/wiki.zim");
    assert.equal(zc.tools.zim.searchMaxResults, 4);
    assert.equal(zc.tools.zim.scanBudgetMs, 3000);
    const { errors: zbad } = parseConfig({
      DISCORD_TOKEN: "t",
      DISCORD_GUILD_ID: "g",
      MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
      ZIMTOOLS_ENABLED: "true",
    });
    assert.ok(zbad.some((e) => e.includes("ZIM_FILE")), `got: ${zbad.join("; ")}`);
    ok("config: zim tools env parsing and ZIM_FILE requirement");

    // -- activity icon
    const line = formatToolCall({ id: "z3", name: "wikipedia_read", arguments: '{"title": "Zebra"}' });
    assert.ok(line.startsWith("📚"), line);
    ok("activity: wikipedia tools get the book icon");
  } finally {
    fs.rmSync(zimDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------- vault tools --
// The vault (offline Wikipedia notes) tools, exercised against a synthetic
// vault built in a temp dir: an index.tsv with a title collision (the
// deduplicated "(2)" file name), notes with frontmatter and wikilinks, a
// long note (truncation), and a body-searchable note.
{
  const vaultDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "glove-vaulttest-")));
  try {
    const note = (name: string, title: string, body: string): void => {
      fs.writeFileSync(
        path.join(vaultDir, `${name}.md`),
        `---\ntitle: "${title}"\npath: "${title.replace(/ /g, "_")}"\nsource: "Wikipedia (en, 2026-06, nopic)"\n---\n\n${body}\n`,
      );
    };
    note("Albert Einstein", "Albert Einstein", "German physicist. See [[Nobel Prize]] and [[Relativity]].\n\n## Life\nBorn in Ulm.\n");
    note("Aardvark", "Aardvark", "A large pig-like animal. It eats termites and ants.\n");
    // One title, two file names (the build deduplicates FILE names, not
    // titles), and the title is not itself a file name — the ambiguity
    // path (a direct file name, e.g. "A-B", still reads straight).
    note("A-B", "A B", "First of two colliding notes. Links to [[Albert Einstein]] and [[Nobel Prize]].\n");
    note("A-B (2)", "A B", "Second of two colliding notes (deduplicated file name).\n");
    note("Long Note", "Long Note", "para one. ".repeat(4000));
    note("Quantum Zzz", "Quantum Zzz", "The word zeppelinite appears here for the body scan.\n");
    // A title whose lowercase is length-changing (U+0130 -> "i" + combining
    // dot): the prefilter copy must stay 1:1 aligned with the lines.
    note("İzmir", "İzmir", "A city on the Aegean.\n");
    fs.writeFileSync(
      path.join(vaultDir, "index.tsv"),
      [
        "Albert Einstein\tAlbert Einstein",
        "Aardvark\tAardvark",
        "A B\tA-B",
        "A B\tA-B (2)",
        "Long Note\tLong Note",
        "Quantum Zzz\tQuantum Zzz",
        "İzmir\tİzmir",
      ].join("\n") + "\n",
    );

    // Deterministic fake body scan (test-only escape hatch): only
    // "zeppelinite" hits one note's body; "partial" is flagged time-limited.
    const fakeBody = async (query: string): Promise<BodyScanOutcome> => {
      if (query.toLowerCase() === "zeppelinite") return { files: ["Quantum Zzz"], partial: false, engine: "js" };
      if (query.toLowerCase() === "partial") return { files: ["Aardvark"], partial: true, engine: "js" };
      return { files: [], partial: false, engine: "js" };
    };
    const tools = new VaultTools({ dir: vaultDir, maxResults: 8, scanBudgetMs: 5000, maxTextChars: 2000, bodyScan: fakeBody });

    // -- title search: exact (case- and space/underscore-insensitive), prefix, substring
    const ein = await tools.search("EINSTEIN", 5);
    assert.ok(ein.includes("Offline Wikipedia vault (7 notes)"), ein);
    assert.ok(ein.includes("1. Albert Einstein"), ein);
    assert.ok(!ein.includes("Bodies"), "a title-only match lists no bodies");
    const ab = await tools.search("A_B", 5);
    assert.ok(ab.includes("1. A B [file: A-B]"), ab);
    assert.ok(ab.includes("2. A B [file: A-B (2)]"), ab);
    assert.ok((await tools.search("Aardv", 5)).includes("1. Aardvark"), "prefix match");
    assert.ok((await tools.search("zzz", 5)).includes("1. Quantum Zzz"), "substring match");
    // length-changing lowercase (U+0130): ascii and dotted queries both hit,
    // and the extracted line stays line-aligned (exactly one title line)
    const izAscii = await tools.search("izmir", 5);
    assert.ok(izAscii.includes("1. İzmir"), izAscii);
    assert.equal(izAscii.split("\n").length, 4, "header + Titles: + one hit + footer");
    assert.ok((await tools.search("İzmir", 5)).includes("1. İzmir"), "dotted query");
    ok("vault: title search exact/prefix/substring, case- and space-insensitive");

    // -- body search (fake), the partial flag, the no-match hint
    const bodyHit = await tools.search("zeppelinite", 5);
    assert.ok(bodyHit.includes("Bodies (notes containing the query):"), bodyHit);
    assert.ok(bodyHit.includes("- Quantum Zzz"), bodyHit);
    assert.ok(!bodyHit.includes("Titles:"), "a body-only match lists no titles");
    const partial = await tools.search("partial", 5);
    assert.ok(partial.includes("(scan was time-limited; refine the query for more)"), partial);
    const miss = await tools.search("definitely absent", 5);
    assert.ok(miss.startsWith("No note in the offline Wikipedia vault"), miss);
    assert.ok(!miss.includes("web_search"), "no hint at a tool that is not registered");
    const withWeb = new VaultTools({
      dir: vaultDir,
      maxResults: 8,
      scanBudgetMs: 5000,
      maxTextChars: 2000,
      bodyScan: fakeBody,
      webSearchAvailable: true,
    });
    assert.ok((await withWeb.search("definitely absent", 5)).includes("web_search"));
    withWeb.abort();
    ok("vault: body search hits, partial flag, no-match hint only when web_search is registered");

    // -- read: by title, by file stem, ambiguity, missing, traversal
    const einRead = await tools.read("Albert Einstein");
    assert.ok(einRead.startsWith("Wikipedia vault: Albert Einstein (Albert Einstein.md"), einRead);
    assert.ok(einRead.includes("German physicist"), einRead);
    assert.ok(!einRead.includes('title: "Albert Einstein"'), "the frontmatter is dropped");
    const einUnder = await tools.read("ALBERT_EINSTEIN");
    assert.ok(einUnder.includes("German physicist"), "spaces and underscores are interchangeable");
    const dedup = await tools.read("A-B (2)");
    assert.ok(dedup.includes("Second of two colliding notes"), "the deduplicated file name reads directly");
    const first = await tools.read("A-B");
    assert.ok(first.includes("First of two colliding notes"), "a file name reads straight");
    await assert.rejects(tools.read("A B"), /ambiguous note "A B"/, "one title, two file names, no direct file");
    await assert.rejects(tools.read("Nope"), /no note matching "Nope"/);
    await assert.rejects(tools.read("../etc/passwd"), /flat/, "path traversal refused");
    await assert.rejects(tools.read("a/b"), /flat/, "no path separators");
    ok("vault: read by title or file, ambiguity and traversal errors");

    // -- truncation and abstract mode
    const longRead = await tools.read("Long Note");
    assert.ok(longRead.includes("[truncated]"), longRead);
    const abs = await tools.read("Long Note", "abstract");
    assert.ok(abs.includes("— abstract"), abs);
    assert.ok(abs.includes("path: Long_Note"), "the frontmatter is rendered in abstract mode");
    assert.ok(abs.includes("[abstract cut — use mode"), abs);
    assert.ok(abs.length < 1500, `the abstract stays small (${abs.length} chars)`);
    ok("vault: full read truncates, abstract mode is frontmatter + note start");

    // -- links
    const links = await tools.links("Albert Einstein");
    assert.ok(links.includes("2 wikilink(s)"), links);
    assert.ok(links.includes("1. Nobel Prize") && links.includes("2. Relativity"), links);
    assert.ok(links.endsWith("Follow one with vault_read."), links);
    assert.ok((await tools.links("Aardvark")).includes("no [[wikilinks]]"), "no links reported");
    ok("vault: wikilinks listed in order, none reported when absent");

    // -- registry + executor wiring (errors surface as tool results)
    const registry = new ToolRegistry();
    registerVaultTools(registry, tools);
    assert.equal(registry.size, 3);
    const res = await executeToolCalls(registry, [
      { id: "v1", name: "vault_search", arguments: JSON.stringify({ query: "zeppelinite", max_results: 3 }) },
      { id: "v2", name: "vault_read", arguments: JSON.stringify({ note: "A B", mode: "weird" }) },
      { id: "v3", name: "vault_links", arguments: JSON.stringify({ note: "Aardvark" }) },
    ]);
    assert.ok(res[0].content.includes("- Quantum Zzz"), res[0].content);
    assert.ok(res[1].content.startsWith("Error:") && res[1].content.includes('must be "full" or "abstract"'), res[1].content);
    assert.ok(res[2].content.includes("no [[wikilinks]]"), res[2].content);
    const broken = new VaultTools({ dir: "/nonexistent/vault-dir", maxResults: 8, scanBudgetMs: 5000, maxTextChars: 2000 });
    const brokenReg = new ToolRegistry().register(VAULT_SEARCH_SPEC, (args) => broken.search(argString(args, "query"), 5));
    const bres = await executeToolCalls(brokenReg, [{ id: "v4", name: "vault_search", arguments: '{"query":"x"}' }]);
    assert.ok(bres[0].content.startsWith("Error:") && bres[0].content.includes("not found"), bres[0].content);
    ok("vault tools: registry wiring, bad args and a broken dir surface as error results");
    tools.abort();

    // -- body scan engines: the js scan directly, rg via a fake ripgrep,
    // missing rg falling back, and the deadline killing the rg child
    assert.deepEqual(await jsScan(vaultDir, "zeppelinite", 5000, 5), { files: ["Quantum Zzz"], partial: false, engine: "js" });
    assert.deepEqual(await jsScan(vaultDir, "absent word", 5000, 5), { files: [], partial: false, engine: "js" });
    const rgScript = path.join(vaultDir, "fake-rg.sh");
    fs.writeFileSync(
      rgScript,
      "#!/bin/sh\nq=\"$6\"; dir=\"$7\"\nfind \"$dir\" -name '*.md' -type f | while IFS= read -r f; do\n  grep -q -i -F -- \"$q\" \"$f\" 2>/dev/null && printf '%s\\n' \"$f\"\ndone\nexit 0\n",
    );
    fs.chmodSync(rgScript, 0o755);
    assert.deepEqual(await scanBody(vaultDir, "zeppelinite", 5000, 5, { rgPath: rgScript }), {
      files: ["Quantum Zzz"],
      partial: false,
      engine: "rg",
    });
    const fallback = await scanBody(vaultDir, "zeppelinite", 5000, 5, { rgPath: "/nonexistent/rg" });
    assert.equal(fallback.engine, "js", "a missing ripgrep falls back to the js scan");
    assert.deepEqual(fallback.files, ["Quantum Zzz"]);
    const slowRg = path.join(vaultDir, "fake-rg-slow.sh");
    fs.writeFileSync(slowRg, "#!/bin/sh\nsleep 2\nexit 0\n");
    fs.chmodSync(slowRg, 0o755);
    const slow = await scanBody(vaultDir, "zeppelinite", 200, 5, { rgPath: slowRg });
    assert.equal(slow.engine, "rg");
    assert.ok(slow.partial, "the deadline kills the ripgrep child and flags partial");
    ok("body scan: js engine, rg engine, missing-rg fallback, deadline -> partial");

    // -- config
    const { config: vc, errors: ve } = parseConfig({
      DISCORD_TOKEN: "t",
      DISCORD_GUILD_ID: "g",
      MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
      VAULTTOOLS_ENABLED: "true",
      VAULT_DIR: "/tmp/vault",
      VAULTTOOLS_SEARCH_MAX_RESULTS: "4",
      VAULTTOOLS_SCAN_BUDGET_S: "3",
      VAULTTOOLS_RG_PATH: "/usr/bin/rg",
    });
    assert.deepEqual(ve, []);
    assert.equal(vc.tools.vault.enabled, true);
    assert.equal(vc.tools.vault.dir, "/tmp/vault");
    assert.equal(vc.tools.vault.searchMaxResults, 4);
    assert.equal(vc.tools.vault.scanBudgetMs, 3000);
    assert.equal(vc.tools.vault.rgPath, "/usr/bin/rg");
    const { config: vdefault } = parseConfig({
      DISCORD_TOKEN: "t",
      DISCORD_GUILD_ID: "g",
      MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    });
    assert.equal(vdefault.tools.vault.rgPath, "rg", "rgPath defaults to rg on PATH");
    const { errors: vbad } = parseConfig({
      DISCORD_TOKEN: "t",
      DISCORD_GUILD_ID: "g",
      MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
      VAULTTOOLS_ENABLED: "true",
    });
    assert.ok(vbad.some((e) => e.includes("VAULT_DIR")), `got: ${vbad.join("; ")}`);
    ok("config: vault tools env parsing and the VAULT_DIR requirement");

    // -- activity icon
    const vline = formatToolCall({ id: "v9", name: "vault_read", arguments: '{"note": "Zebra"}' });
    assert.ok(vline.startsWith("🗃"), vline);
    ok("activity: vault tools get the cabinet icon");
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- llm --
{
  const seenRequests: Array<{ auth: string | undefined; ct: string | undefined; body: unknown; url: string }> = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      seenRequests.push({ auth: req.headers.authorization, ct: req.headers["content-type"], body: JSON.parse(body), url });
      if (url.includes("chime-recovery")) {
        const request = JSON.parse(body);
        if (request.tools) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "tool_choice required is unsupported" } }));
        } else {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "NO — this is chatter" } }] })}\n\n`);
          res.end("data: [DONE]\n\n");
        }
        return;
      }
      if (url.includes("slow")) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "late" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 300);
        return;
      }
      if (url.includes("tokenhold")) {
        // Prefill ends after ONE token: the content delta arrives, then the
        // stream pauses (the generation an abort may not cut) and completes
        // — an abort after the first token must be ignored, and the
        // request resolves with what was generated.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "start" } }] })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " end" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 200);
        return;
      }
      if (url.includes("hold")) {
        // Pure prefill hold: no token is ever sent — the request sits in
        // prompt processing (interruptable) until the client aborts it.
        // Deliberately no data, no [DONE] and no end(): the stream stays
        // open until aborted.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        return;
      }
      if (url.includes("slowjson")) {
        // Non-stream with a delayed body: the single response has only
        // happened once it arrives, which the client cannot observe in
        // advance — the call stays interruptable throughout.
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "slow non-stream" } }] }));
        }, 300);
        return;
      }
      if (url.includes("err500")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      if (url.includes("errbody")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model exploded" } }));
        return;
      }
      if (url.includes("nonstream")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "non-stream reply" } }] }));
        return;
      }
      if (url.includes("toolstream")) {
        // Two tool calls streamed as fragments: first chunk carries ids +
        // names + argument heads, the second chunk carries argument tails
        // (and NO id/name — the reassembly must not drop those).
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Let me search." } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "web_search", arguments: '{"qu' } },
                    { index: 1, id: "call_2", function: { name: "web_fetch", arguments: '{"url' } },
                  ],
                },
              },
            ],
          })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: 'ery": "cats"}' } },
                    { index: 1, function: { arguments: '": "http://example.com"}' } },
                  ],
                },
              },
            ],
          })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (url.includes("reasoning")) {
        // Some endpoints stream the model's thinking under `reasoning`,
        // others under `reasoning_content`; both must reach onReasoning.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Let me " } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think." } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "42" } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (url.includes("reasonjson")) {
        // Non-stream: the whole thinking arrives as one field on the message.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "the answer", reasoning_content: "the thinking" } }] }));
        return;
      }
      if (url.includes("usagejson")) {
        // Non-stream: an OpenAI-style usage block.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168, prompt_tokens_details: { cached_tokens: 100 } } }),
        );
        return;
      }
      if (url.includes("usagelegacy")) {
        // Non-stream: llama.cpp's legacy top-level counters (no usage block).
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "done" } }], prompt_tokens: 77, completion_tokens: 8 }));
        return;
      }
      if (url.includes("usagetime")) {
        // Stream: llama.cpp's final chunk carries timings (the prompt-cache
        // split: cache_n + prompt_n = the full prompt; predicted_n = the
        // completion) — no usage block.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], timings: { cache_n: 55, prompt_n: 4, predicted_n: 18 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (url.includes("usagechunk")) {
        // Stream: the final chunk's usage block wins over its timings.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 9, completion_tokens: 3 }, timings: { cache_n: 1, prompt_n: 1, predicted_n: 999 } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (url.includes("tooljson")) {
        // Non-stream: whole tool_calls, arguments as a JSON object (not a string).
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [{ id: "call_3", type: "function", function: { name: "web_fetch", arguments: { url: "http://example.com" } } }],
                },
              },
            ],
          }),
        );
        return;
      }
      // default: SSE stream with noise lines mixed in
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": keep-alive\n\n");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`);
      res.write("data: {not json\n\n");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const deltas: string[] = [];
  const streamClient = new LlmClient({
    apiUrl: `${base}/v1/stream`,
    apiKey: "none",
    model: "local",
    stream: true,
    timeoutMs: 5000,
  });
  const full = await streamClient.chat([{ role: "user", content: "hi" }], { onDelta: (d) => deltas.push(d) });
  assert.equal(full.content, "Hello world");
  assert.deepEqual(full.toolCalls, []);
  assert.deepEqual(deltas, ["Hel", "lo ", "world"]);

  // streamed reasoning/thinking: both field names reach onReasoning, never
  // onDelta, and the result's content is untouched
  const rDeltas: string[] = [];
  const rContent: string[] = [];
  const rRes = await new LlmClient({
    apiUrl: `${base}/v1/reasoning`,
    apiKey: "none",
    model: "local",
    stream: true,
    timeoutMs: 5000,
  }).chat(
    [{ role: "user", content: "?" }],
    {
      onDelta: (d) => rContent.push(d),
      onReasoning: (d) => rDeltas.push(d),
    },
  );
  assert.equal(rRes.content, "42");
  assert.deepEqual(rRes.toolCalls, []);
  assert.deepEqual(rContent, ["42"], "content deltas untouched");
  assert.deepEqual(rDeltas, ["Let me ", "think."], "reasoning and reasoning_content both picked up");
  assert.equal(rRes.reasoning, "Let me think.", "the accumulated reasoning is on the result");
  ok("llm: streamed reasoning reaches onReasoning and the result");

  // non-stream: the reasoning blob is handed over whole
  const rDeltasNs: string[] = [];
  const rNs = await new LlmClient({
    apiUrl: `${base}/v1/reasonjson`,
    apiKey: "none",
    model: "m",
    stream: false,
    timeoutMs: 5000,
  }).chat([{ role: "user", content: "?" }], { onReasoning: (d) => rDeltasNs.push(d) });
  assert.equal(rNs.content, "the answer");
  assert.deepEqual(rDeltasNs, ["the thinking"], "non-stream reasoning handed over whole");
  assert.equal(rNs.reasoning, "the thinking", "the reasoning is on the result");
  ok("llm: non-stream reasoning handed to onReasoning and the result");

  const r0 = seenRequests[0];
  assert.equal(r0.auth, "Bearer none");
  assert.equal(r0.ct, "application/json");
  assert.deepEqual(r0.body, {
    model: "local",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  ok("llm: streaming SSE (malformed/comment lines tolerated, contract correct)");

  const nsClient = new LlmClient({
    apiUrl: `${base}/v1/nonstream`,
    apiKey: "k",
    model: "m",
    stream: false,
    timeoutMs: 5000,
  });
  const ns = await nsClient.chat([{ role: "user", content: "hi" }]);
  assert.equal(ns.content, "non-stream reply");
  assert.deepEqual(seenRequests.at(-1)!.body, {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });
  ok("llm: non-streaming single reply");

  // Token usage: the endpoint's own counts, captured when the response
  // reports them — the usage object, llama.cpp's legacy top-level
  // counters, and the streamed final chunk's timings (prompt_n + cache_n
  // prompt tokens, predicted_n completion tokens).
  const uJson = await new LlmClient({
    apiUrl: `${base}/v1/usagejson`,
    apiKey: "none",
    model: "m",
    stream: false,
    timeoutMs: 5000,
  }).chat([]);
  assert.deepEqual(uJson.usage, { input: 123, output: 45, cachedInput: 100 });
  const uLegacy = await new LlmClient({
    apiUrl: `${base}/v1/usagelegacy`,
    apiKey: "none",
    model: "m",
    stream: false,
    timeoutMs: 5000,
  }).chat([]);
  assert.deepEqual(uLegacy.usage, { input: 77, output: 8 }, "legacy top-level counters");
  const uTimings = await new LlmClient({ apiUrl: `${base}/v1/usagetime`, apiKey: "none", model: "m", stream: true, timeoutMs: 5000 }).chat([]);
  assert.deepEqual(uTimings.usage, { input: 59, output: 18, cachedInput: 55 }, "timings: prompt_n + cache_n / predicted_n");
  const uChunk = await new LlmClient({ apiUrl: `${base}/v1/usagechunk`, apiKey: "none", model: "m", stream: true, timeoutMs: 5000 }).chat([]);
  assert.deepEqual(uChunk.usage, { input: 9, output: 3 }, "the usage block beats timings");
  assert.equal(full.usage, undefined, "no usage fields anywhere -> no usage");
  ok("llm: token usage parsed from responses (usage object, legacy counters, streamed timings)");

  const slowClient = new LlmClient({
    apiUrl: `${base}/v1/slow`,
    apiKey: "none",
    model: "local",
    stream: true,
    timeoutMs: 100,
  });
  await assert.rejects(slowClient.chat([]), /timed out after 0s|timed out/);
  ok("llm: per-request timeout aborts and reports");

  // abort() must cancel ALL in-flight requests (two channels generating at
  // once), not just the most recently started one
  const holdClient = new LlmClient({
    apiUrl: `${base}/v1/hold`,
    apiKey: "none",
    model: "local",
    stream: true,
    timeoutMs: 60_000, // long enough that only abort() can end these
  });
  const p1 = holdClient.chat([{ role: "user", content: "one" }]);
  await ticks(3);
  const p2 = holdClient.chat([{ role: "user", content: "two" }]);
  await ticks(3);
  const abortAt = Date.now();
  holdClient.abort();
  const [r1, r2] = await Promise.allSettled([p1, p2]);
  assert.ok(Date.now() - abortAt < 5_000, "abort() must cancel promptly, not wait for the timeout");
  assert.equal(r1.status, "rejected", "first in-flight request cancelled");
  assert.equal(r2.status, "rejected", "second in-flight request cancelled");
  assert.match((r1.reason as Error).message, /timed out/);
  assert.match((r2.reason as Error).message, /timed out/);
  ok("llm: abort() cancels all in-flight requests, not just the latest");

  // The caller's signal (the channel-activity interruption) interrupts a
  // request while its PROMPT is still being processed (before the model's
  // first token): it is reported as an InterruptedError — not a timeout —
  // and a pre-aborted signal fails the request at once (no request goes
  // out). (The /v1/hold route sends no token, so the request stays in
  // prefill until aborted.)
  {
    const pre = new AbortController();
    pre.abort();
    const t0 = Date.now();
    await assert.rejects(
      holdClient.chat([{ role: "user", content: "pre" }], undefined, undefined, pre.signal),
      InterruptedError,
    );
    assert.ok(Date.now() - t0 < 1000, "a pre-aborted signal fails the request at once");
    const mid = new AbortController();
    const p = holdClient.chat([{ role: "user", content: "mid" }], undefined, undefined, mid.signal);
    await ticks(3);
    const t1 = Date.now();
    mid.abort();
    await assert.rejects(p, InterruptedError);
    assert.ok(Date.now() - t1 < 5000, "the signal cancels promptly, not at the timeout");
  }
  ok("llm: the caller's signal interrupts prefill (InterruptedError, not a timeout)");

  // Once generation has started (the first token arrived), the signal is
  // ignored: reasoning, tool calls and the response run to completion and
  // the request RESOLVES with what was generated.
  {
    const tokenClient = new LlmClient({
      apiUrl: `${base}/v1/tokenhold`,
      apiKey: "none",
      model: "local",
      stream: true,
      timeoutMs: 5000,
    });
    const gen = new AbortController();
    let resolveDelta: () => void = () => {};
    const deltaArrived = new Promise<void>((r) => (resolveDelta = r));
    const p = tokenClient.chat(
      [{ role: "user", content: "gen" }],
      { onDelta: () => resolveDelta() },
      undefined,
      gen.signal,
    );
    await deltaArrived;
    gen.abort(); // the first token has arrived: this must be ignored
    const res = await p;
    assert.equal(res.content, "start end", "the generation ran to completion despite the abort");
  }
  ok("llm: an abort after the first token is ignored (the generation runs to completion)");

  {
    const mention = new AbortController();
    const client = new LlmClient({ apiUrl: `${base}/v1/tokenhold`, apiKey: "none", model: "local", stream: true, timeoutMs: 5000 });
    const pending = client.chat([{ role: "user", content: "old prompt" }],
      { onDelta: () => mention.abort() }, undefined, undefined, { interruptSignal: mention.signal });
    await assert.rejects(pending, InterruptedError);
    await assert.rejects(client.chat([{ role: "user", content: "stale" }], undefined, undefined, undefined,
      { interruptSignal: mention.signal }), InterruptedError);
  }
  ok("llm: a human mention interrupts after the first token and prevents another stale request");


  // Non-stream calls stay interruptable throughout: their single response
  // has only happened once the body arrives, which the client cannot
  // observe in advance — a mid-flight abort still reports InterruptedError.
  {
    const ns = new AbortController();
    const p = new LlmClient({
      apiUrl: `${base}/v1/slowjson`,
      apiKey: "none",
      model: "local",
      stream: false,
      timeoutMs: 60_000,
    }).chat([{ role: "user", content: "ns" }], undefined, undefined, ns.signal);
    await ticks(3);
    ns.abort();
    await assert.rejects(p, InterruptedError);
  }
  ok("llm: non-stream requests stay interruptable (InterruptedError, not a timeout)");

  await assert.rejects(
    new LlmClient({ apiUrl: `${base}/v1/err500`, apiKey: "none", model: "m", stream: false, timeoutMs: 5000 }).chat([]),
    /HTTP 500/,
  );
  ok("llm: non-2xx surfaces status + body");

  await assert.rejects(
    new LlmClient({ apiUrl: `${base}/v1/errbody`, apiKey: "none", model: "m", stream: false, timeoutMs: 5000 }).chat([]),
    /model endpoint error: model exploded/,
  );
  ok("llm: 200-with-error-object surfaced");

  await assert.rejects(
    new LlmClient({ apiUrl: "http://127.0.0.1:1/v1", apiKey: "none", model: "m", stream: false, timeoutMs: 5000 }).chat([]),
    /could not reach model endpoint/,
  );
  ok("llm: connection refused reported honestly");

  // tool calls: streamed fragments reassembled by index; tools on the wire;
  // assistant+tool messages serialized to the OpenAI wire shape
  const toolClient = new LlmClient({
    apiUrl: `${base}/v1/toolstream`,
    apiKey: "none",
    model: "local",
    stream: true,
    timeoutMs: 5000,
  });
  const toolRes = await toolClient.chat(
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"query":"cats"}' }] },
      { role: "tool", toolCallId: "call_1", name: "web_search", content: "results" },
    ],
    undefined,
    [{ name: "web_search", description: "search the web", parameters: { type: "object" } }],
  );
  assert.equal(toolRes.content, "Let me search.");
  assert.deepEqual(toolRes.toolCalls, [
    { id: "call_1", name: "web_search", arguments: '{"query": "cats"}' },
    { id: "call_2", name: "web_fetch", arguments: '{"url": "http://example.com"}' },
  ]);
  const toolBody = seenRequests.at(-1)!.body as Record<string, unknown>;
  const toolsWire = toolBody.tools as Array<Record<string, unknown>>;
  assert.equal(toolsWire.length, 1, "tools array sent");
  assert.equal(toolsWire[0].type, "function");
  assert.equal((toolsWire[0].function as Record<string, unknown>).name, "web_search");
  assert.equal(toolBody.tool_choice, "auto");
  assert.equal(toolBody.max_tokens, undefined, "ordinary replies keep the endpoint output limit");
  const trackedToolChat = new TurnTokens().track((messages, callbacks, tools, signal, options) => toolClient.chat(messages, callbacks, tools, signal, options));
  await trackedToolChat([{ role: "user", content: "decide" }], undefined, [CHIME_TOOL_SPEC], undefined, { toolChoice: "required" });
  assert.equal((seenRequests.at(-1)!.body as Record<string, unknown>).tool_choice, "required", "required tool choice survives accounting and reaches HTTP");
  const wireMsgs = toolBody.messages as Array<Record<string, unknown>>;
  assert.equal(wireMsgs[1].role, "assistant");
  const wireTcs = wireMsgs[1].tool_calls as Array<Record<string, unknown>>;
  assert.equal(wireTcs[0].id, "call_1");
  assert.equal(wireTcs[0].type, "function");
  assert.equal((wireTcs[0].function as Record<string, unknown>).arguments, '{"query":"cats"}');
  assert.equal(wireMsgs[2].role, "tool");
  assert.equal(wireMsgs[2].tool_call_id, "call_1");
  assert.equal(wireMsgs[2].content, "results");
  ok("llm: streamed tool-call fragments reassembled, tools + wire shapes correct");

  const toolNs = await new LlmClient({
    apiUrl: `${base}/v1/tooljson`,
    apiKey: "none",
    model: "m",
    stream: false,
    timeoutMs: 5000,
  }).chat([]);
  assert.equal(toolNs.content, "");
  assert.deepEqual(toolNs.toolCalls, [
    { id: "call_3", name: "web_fetch", arguments: '{"url":"http://example.com"}' },
  ]);
  ok("llm: non-stream tool_calls normalized (object args stringified)");

  // multimodal: an array of text/image parts passes through to the wire
  // unchanged (string content is still sent as a string)
  const mmParts: unknown = [
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ];
  await streamClient.chat([{ role: "user", content: mmParts as ChatMessage["content"] }]);
  const mmBody = seenRequests.at(-1)!.body as Record<string, unknown>;
  assert.deepEqual(mmBody.messages, [{ role: "user", content: mmParts }], "parts sent as-is");
  ok("llm: multimodal content parts pass through to the wire");

  // Reasoning round-trip: an assistant message's stored reasoning is sent
  // back to the endpoint as reasoning_content (both plain and with tool
  // calls) so a reasoning model continues from its own thinking; messages
  // without reasoning carry no such field.
  await nsClient.chat([
    { role: "user", content: "go" },
    { role: "assistant", content: "thinking out loud", reasoningContent: "step one" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }], reasoningContent: "step two" },
    { role: "tool", toolCallId: "c1", name: "echo", content: "ok" },
    { role: "assistant", content: "no reasoning here" },
  ]);
  const rtWire = (seenRequests.at(-1)!.body as Record<string, unknown>).messages as Array<Record<string, unknown>>;
  assert.equal(rtWire[1].reasoning_content, "step one", "plain assistant reasoning sent back");
  assert.equal(rtWire[2].reasoning_content, "step two", "a tool-calling assistant's reasoning sent back");
  assert.equal((rtWire[2].tool_calls as unknown[]).length, 1, "tool calls alongside the reasoning");
  assert.equal("reasoning_content" in rtWire[4], false, "no field without reasoning");
  assert.equal("reasoning_content" in rtWire[3], false, "tool messages never carry it");
  ok("llm: assistant reasoning round-trips as reasoning_content on the wire");

  const recoveryClient = new LlmClient({ apiUrl: `${base}/v1/chime-recovery`, apiKey: "none", model: "local", stream: true, timeoutMs: 5000 });
  const account = new TurnTokens();
  const recoveryChat = account.track((messages, callbacks, tools, signal, options) => recoveryClient.chat(messages, callbacks, tools, signal, options));
  const requestStart = seenRequests.length;
  assert.deepEqual(await decideChime((messages, tools, signal, options) => recoveryChat(messages, undefined, tools, signal, options), [{ role: "user", content: "hello" }]),
    null);
  const recoveryRequests = seenRequests.slice(requestStart).map(r => r.body as Record<string, unknown>);
  assert.equal(recoveryRequests.length, 1);
  assert.equal(recoveryRequests[0].tool_choice, "auto");
  assert.equal(recoveryRequests[0].max_tokens, CHIME_MAX_TOKENS);
  ok("chime: real HTTP tool rejection stays silent without a text fallback");

  server.close();
}

// ---------------------------------------------------------------- metrics --
{
  // The /slots probe: parses and aggregates the llama-server's slot report
  // (trailing slash on the base URL tolerated), and fails soft to null on
  // every kind of failure. The aggregated window is ONE slot's n_ctx (the
  // smallest — llama-server splits -c across its -np slots, so a request
  // gets one slot's window; the sum would be -np times too large), and the
  // use is the largest slot's last-request token count.
  let slotsResponse: { status: number; body: string } | "slow" = {
    status: 200,
    body: JSON.stringify([
      { id: 0, n_ctx: 4096, n_prompt_tokens: 1234, is_processing: true },
      { id: 1, n_ctx: 8192, n_prompt_tokens: 66, state: "available" },
    ]),
  };
  const slotsServer = http.createServer((req, res) => {
    if ((req.url ?? "") !== "/slots") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (slotsResponse === "slow") return; // never responds: the probe's timeout must cut it off
    res.writeHead(slotsResponse.status, { "Content-Type": "application/json" });
    res.end(slotsResponse.body);
  });
  await new Promise<void>((r) => slotsServer.listen(0, "127.0.0.1", r));
  const slotsPort = (slotsServer.address() as AddressInfo).port;
  const m = new LlamaMetrics({ baseUrl: `http://127.0.0.1:${slotsPort}/`, timeoutMs: 400 });
  assert.deepEqual(await m.snapshot(), {
    slots: [
      { id: 0, ctxSize: 4096, lastRequestTokens: 1234, processing: true },
      { id: 1, ctxSize: 8192, lastRequestTokens: 66, processing: false },
    ],
    ctxSize: 4096, // the per-slot window (the smallest slot's n_ctx), not the sum
    lastRequestTokens: 1234, // the largest slot's last request, not the sum
    processing: true,
  });
  slotsResponse = { status: 500, body: "boom" };
  assert.equal(await m.snapshot(), null, "non-2xx");
  slotsResponse = { status: 200, body: JSON.stringify({ slots: [] }) };
  assert.equal(await m.snapshot(), null, "not an array");
  slotsResponse = { status: 200, body: "not json" };
  assert.equal(await m.snapshot(), null, "not JSON");
  slotsResponse = { status: 200, body: JSON.stringify([{ n_prompt_tokens: 5 }]) };
  assert.equal(await m.snapshot(), null, "slots without a usable context size");
  slotsResponse = "slow";
  assert.equal(await m.snapshot(), null, "the probe's own timeout");
  assert.equal(
    await new LlamaMetrics({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }).snapshot(),
    null,
    "connection refused",
  );
  slotsServer.close();
  ok("metrics: the /slots probe parses and aggregates, and fails soft to null");

  // Per-turn accounting: the endpoint's own counts, summed over the turn's
  // model calls (the largest prompt kept, not the sum); calls without usage
  // are ignored.
  const t = new TurnTokens();
  let i = 0;
  const fake = async (_msgs: ChatMessage[]): Promise<ChatResult> => {
    i += 1;
    if (i === 1) return { content: "a", toolCalls: [], usage: { input: 100, output: 10 } };
    if (i === 2) return { content: "b", toolCalls: [] }; // no usage: ignored
    return { content: "c", toolCalls: [], usage: { input: 50, output: 5 } };
  };
  const tracked = t.track(fake);
  await tracked([{ role: "user", content: "1" }]);
  await tracked([{ role: "user", content: "2" }]);
  await tracked([{ role: "user", content: "3" }]);
  assert.equal(t.input, 150);
  assert.equal(t.output, 15);
  assert.equal(t.peakInput, 100, "the largest prompt, not the sum");
  assert.equal(t.calls, 2);
  ok("metrics: turn tokens accumulate per call (input/output sums, peak prompt, usage-less calls ignored)");

  // The automatic compaction budget: the window minus the completion
  // headroom; a window too small to leave room derives nothing.
  assert.equal(deriveCompactionBudget(160000), 155904);
  assert.equal(deriveCompactionBudget(5000), 904);
  assert.equal(deriveCompactionBudget(4500), 404);
  assert.equal(deriveCompactionBudget(4096), null, "window minus headroom too small");
  assert.equal(deriveCompactionBudget(1000), null);
  ok("metrics: the automatic budget = window minus completion headroom (too-small window -> null)");
}

// Human mentions stop at tool boundaries without replaying completed work.
{
  for (const duringTool of [false, true]) {
    const mention = new AbortController();
    let executions = 0;
    let completed = 0;
    const registry = new ToolRegistry().register({ name: "write", description: "", parameters: {} }, async () => {
      executions++;
      mention.abort();
      return "saved";
    });
    const pending = runToolTurn([{ role: "user", content: "old request" }], {
      registry, maxRounds: 3, interruptSignal: mention.signal,
      chat: async () => ({ content: "", toolCalls: [{ id: "1", name: "write", arguments: "{}" }] }),
      onToolCalls: () => { if (!duringTool) mention.abort(); },
      onRoundComplete: () => { completed++; },
    });
    await assert.rejects(pending, (err: unknown) => duringTool
      ? err instanceof Error && !isInterruptedError(err)
      : isInterruptedError(err));
    assert.equal(executions, duringTool ? 1 : 0);
    assert.equal(completed, duringTool ? 1 : 0);
  }
  ok("loop: mentions skip unstarted tools and preserve already executing tool results");
}

// ---------------------------------------------------- regression fixes --
{
  for (const mutation of ["clear", "delete", "edit", "arrival", "failure"] as const) {
    const context = new ChannelContext();
    context.seeded = true;
    for (let i = 1; i <= 4; i++) context.pushUser("User", "old text ".repeat(20), String(i), i, []);
    let resolve!: (text: string) => void;
    let reject!: (err: Error) => void;
    const pending = buildChannelContext({} as GuildTextBasedChannel, context, "4", {
      botId: "bot", botName: "Bot", systemPrompt: "", maxMessages: 20,
      enableImages: false, imagesMaxBytes: 1024, enableFileContents: false,
      fileContentsMaxBytes: 1024, maxTokens: 1, keepMessages: 1,
      summarize: () => new Promise<string>((yes, no) => { resolve = yes; reject = no; }),
    });
    if (mutation === "clear") {
      context.reset();
      context.pushUser("User", "new conversation", "5", 5, []);
    } else if (mutation === "delete") context.removeById("1");
    else if (mutation === "edit") context.updateContent("1", "corrected text");
    else context.pushUser("User", "new message", "5", 5, []);
    const expected = context.serialize();
    if (mutation === "failure") reject(new Error("summarizer failed"));
    else resolve("stale summary");
    const built = await pending;
    assert.deepEqual(context.serialize(), expected, "stale compaction must neither apply nor emergency-trim");
    if (mutation === "clear") assert.equal(built, null, "cleared trigger skips the turn");
  }
  ok("compaction: concurrent clears, deletes, edits and arrivals preserve current context even on summarizer failure");
}
{
  for (const failure of [new InterruptedError(), new Error("request (9000 tokens) exceeds the available context size (8000 tokens)")]) {
    let executions = 0;
    let requests = 0;
    const context = new ChannelContext();
    const registry = new ToolRegistry().register({ name: "write", description: "", parameters: {} }, async () => {
      executions++;
      return "operation completed";
    });
    const rounds: Parameters<ChannelContext["appendTurn"]>[0] = [];
    const run = () => runToolTurn([{ role: "user", content: "do it" }], {
      registry, maxRounds: 3,
      chat: async () => {
        if (++requests === 1) return { content: "writing", toolCalls: [{ id: "write1", name: "write", arguments: "{}" }] };
        throw failure;
      },
      onRoundComplete: (round) => { rounds.push({ ...round, ids: [] }); },
    });
    // Same classification as the turn runner: retry only interruption/overflow;
    // all other failures record completed rounds through the ordinary error path.
    try { await run(); assert.fail("expected continuation failure"); } catch (err) {
      if (isInterruptedError(err) || isContextOverflowError(err)) await run();
      else context.appendTurn(rounds, { content: String(err), ids: [] });
    }
    assert.equal(executions, 1);
    assert.equal(requests, 2);
    assert.equal(context.snapshot().filter(e => e.role === "tool")[0]?.content, "operation completed");
    assert.match(context.snapshot().at(-1)!.content, /automatic retry was skipped/);
    await assert.rejects(runToolTurn([], { registry, maxRounds: 3, chat: async () => { throw failure; } }), err => err === failure);
  }
  ok("loop: interruption and overflow after execution retain results without replay; pre-tool failures remain retryable");
}
{
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let finishDns!: (ips: string[]) => void;
    const pending = pinnedFetch("http://example.test", {
      timeoutMs: 100, maxBytes: 1024,
      resolver: () => new Promise(resolve => { finishDns = resolve; }),
    });
    const checked = assert.rejects(pending, /timed out/);
    mock.timers.tick(100);
    await checked; // resolves even though DNS is still pending
    finishDns(["127.0.0.1"]);
    await ticks(2); // late rejection is handled, no socket is started
    let resolutions = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pinnedFetch("http://example.test", {
      timeoutMs: 100, maxBytes: 1024, signal: controller.signal,
      resolver: async () => { resolutions++; return ["127.0.0.1"]; },
    }), /aborted/);
    assert.equal(resolutions, 0, "already aborted fetch does not resolve DNS");
    const duringDns = new AbortController();
    const aborted = pinnedFetch("http://example.test", {
      timeoutMs: 100, maxBytes: 1024, signal: duringDns.signal,
      resolver: () => new Promise(() => {}),
    });
    const abortCheck = assert.rejects(aborted, /aborted/);
    duringDns.abort();
    await abortCheck;
  } finally { mock.timers.reset(); }
  ok("web fetch: deadline and external abort bound DNS waiting, including pre-aborted requests");
}
{
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    for (const outcome of ["yes", "no", "broken", "failure", "interrupted", "overflow"] as const) {
      let typing = 0;
      let finish!: (result: ChatResult) => void;
      let fail!: (error: Error) => void;
      const response = new Promise<ChatResult>((resolve, reject) => { finish = resolve; fail = reject; });
      const pending = decideChime(() => response, [], undefined,
        { sendTyping: async () => { typing++; }, intervalMs: 100 });
      const checked = outcome === "interrupted" || outcome === "overflow" ? assert.rejects(pending) : pending;
      assert.equal(typing, 1, "decision starts typing immediately");
      mock.timers.tick(100);
      assert.equal(typing, 2, "typing refreshes during the decision");
      if (outcome === "failure") fail(new Error("offline"));
      else if (outcome === "interrupted") fail(new InterruptedError());
      else if (outcome === "overflow") fail(new Error("request (9000 tokens) exceeds the available context size (8000 tokens)"));
      else finish({ content: outcome === "broken" ? "garbage" : "", toolCalls: outcome === "broken" ? [] : [{ id: "decision", name: "chime", arguments: JSON.stringify({ respond: outcome === "yes", reason: "test" }) }] });
      await checked;
      mock.timers.tick(500);
      assert.equal(typing, 2, "all exit paths stop refreshing typing");
    }
    assert.equal((await decideChime(async () => ({ content: "", toolCalls: [{ id: "t", name: "chime", arguments: '{"respond":true,"reason":"test"}' }] }), [], undefined,
      { sendTyping: async () => { throw new Error("Discord unavailable"); }, intervalMs: 100 }))?.respond, true);
  } finally { mock.timers.reset(); }
  ok("chime: typing starts and refreshes during decisions, stops on every outcome, and tolerates Discord errors");
}

// Recovery indexes are disposable; the journal remains authoritative.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glove-archive-index-"));
  const index = path.join(dir, "recovery-index.json");
  const journal = path.join(dir, "events.jsonl");
  let archive = new ConversationArchive(dir, undefined, true);
  try {
    const context = new ChannelContext();
    context.pushUser("Alice", "retired", "100", 100, []);
    context.appendTurn([], { content: "reply", ids: ["101"] }, "recorded");
    archive.record("context.checkpoint", { channelId: "c" }, context.serialize());
    context.reset();
    archive.record("context.checkpoint", { channelId: "c" }, context.serialize());
    archive.record("channel.deleted", { channelId: "gone" }, {});
    archive.record("discord.message", { channelId: "c", messageId: "200" }, {});
    archive.record("catchup.started", { channelId: "c" }, { after: "100" });
    archive.record("turn.started", { turnId: "pending" }, {});
    archive.record("tool.started", { executionId: "tool" }, {});
    archive.record("model.started", { requestId: "request" }, {});
    const blob = archive.putBlob(Buffer.from("attachment"));
    archive.record("attachment.saved", {}, { url: "attachment-url", blob });
    const cache = (archive as unknown as { indexedEntries: Set<string> }).indexedEntries;
    for (let i = cache.size; i < 16_384; i++) cache.add(`evictable:${i}`);
    const oldest = cache.values().next().value!;
    context.pushUser("Bob", "new entry after cache fills", "201", 201, []);
    archive.record("context.checkpoint", { channelId: "other" }, context.serialize());
    assert.equal(cache.size, 16_384, "checkpoint deduplication cache stays bounded");
    assert.equal(cache.has(oldest), false, "oldest cached hash is evictable");
    assert.equal(archive.wasTracked("c", "100"), true, "cache eviction preserves retired IDs");
    archive.close();
    assert.equal(cache.size, 0, "close releases the deduplication cache");
    assert.equal(archive.messageCursors().size, 0, "close releases recovery maps");
    assert.equal(archive.incomplete().turns.length, 0);
    const savedIndex = fs.readFileSync(index);
    archive = new ConversationArchive(dir, undefined, true);
    assert.equal(archive.wasTracked("c", "100"), true);
    assert.equal(archive.hasRecordedTurn("recorded"), true);
    assert.equal(archive.restoreContexts().get("c")?.entries.length, 0);
    assert.equal(archive.restoreContexts().get("gone"), null);
    assert.equal(archive.catchupCursors().get("c"), "100");
    assert.equal(archive.attachment("attachment-url")?.toString(), "attachment");
    assert.deepEqual(archive.incomplete().turns.map(r => r.scope.turnId), ["pending"]);
    assert.deepEqual(archive.incomplete().requests.map(r => r.scope.requestId), ["request"]);
    assert.deepEqual(archive.incomplete().tools.map(r => r.scope.executionId), ["tool"]);
    archive.record("tool.finished", { executionId: "tool" }, {});
    archive.record("discord.message", { channelId: "c", messageId: "300" }, {});
    archive.close();
    // Simulate a crash after appending records but before refreshing the cache.
    fs.writeFileSync(index, savedIndex);
    fs.appendFileSync(journal, '{"torn":');
    archive = new ConversationArchive(dir, undefined, true);
    assert.ok(archive.recoveredTail);
    assert.equal(archive.incomplete().tools.length, 0);
    assert.equal(archive.messageCursors().get("c"), "300");
    archive.close();
    const goodIndex = fs.readFileSync(index);
    fs.writeFileSync(index, "broken cache");
    archive = new ConversationArchive(dir, undefined, true);
    assert.equal(archive.messageCursors().get("c"), "300", "damaged index falls back to full recovery");
    archive.close();
    const original = fs.readFileSync(journal, "utf8");
    fs.writeFileSync(index, goodIndex);
    fs.writeFileSync(journal, original.replace('"seq":1', '"seq":9'));
    assert.throws(() => new ConversationArchive(dir, undefined, true), /corrupt/,
      "changed indexed prefix invalidates the cache and fails closed");
    fs.writeFileSync(journal, original);
    // Old unused bytes are checked on access or exhaustive inspection, not warm startup.
    fs.writeFileSync(path.join(dir, "blobs", blob), "damaged");
    archive = new ConversationArchive(dir, undefined, true);
    assert.throws(() => archive.attachment("attachment-url"), /corrupt/);
    archive.close();
    assert.throws(() => new ConversationArchive(dir), /corrupt/);
    ok("archive: indexed recovery retains state, replays crash suffixes, quarantines tails and rejects changed journals");
  } finally { archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------- durable archive --
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glove-archive-"));
  const journal = path.join(dir, "events.jsonl");
  const records = (): ArchiveRecord[] => fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ArchiveRecord);
  let archive = new ConversationArchive(dir);
  try {
    assert.throws(() => new ConversationArchive(dir), /already owned/, "a second writer is refused");
    const context = new ChannelContext();
    context.onChange = () => archive.record("context.checkpoint", { channelId: "c" }, context.serialize());
    context.pushUser("Alice", "remember this original", "100", 100, []);
    const beforeTurn = records().length;
    context.appendTurn([{
      content: "original narration", reasoning: "full reasoning", ids: ["101"],
      calls: [{ id: "call", name: "echo", arguments: '{"value":"original argument"}' }],
      results: [{ toolCallId: "call", name: "echo", content: "original tool result" }],
    }], { content: "original response", reasoning: "final reasoning", ids: ["102"] });
    assert.equal(records().length, beforeTurn + 1, "whole turn is one atomic checkpoint, never orphaned calls");
    const fullCheckpoint = records().at(-1)!;
    context.pushUser("Bob", "recent", "103", 103, []);
    await context.compact(1, async () => "lossy summary", "103");
    context.reset();
    assert.equal(archive.restoreContexts().get("c")?.entries.length, 0);
    const original = archive.readData<{ entries: Array<{ content: string; reasoning?: string }> }>(fullCheckpoint);
    assert.ok(original.entries.some((e) => e.content === "original tool result"));
    assert.ok(original.entries.some((e) => e.reasoning === "full reasoning"));
    assert.equal(archive.wasTracked("c", "100"), true, "retired IDs remain excluded from seeding");
    archive.record("discord.message", { channelId: "c", messageId: "200" }, { content: "before edit" });
    archive.record("catchup.started", { channelId: "c" }, { after: "200" });
    archive.record("discord.message", { channelId: "c", messageId: "400" }, { content: "new arrival during catch-up" });
    archive.record("discord.message", { channelId: "c", messageId: "200" }, { content: "after edit" });
    archive.record("discord.deleted", { channelId: "c", messageId: "200" }, {});
    archive.record("tool.started", { channelId: "c", executionId: "unfinished" }, { call: { id: "maybe-executed" } });
    const seq = records().at(-1)!.seq;
    archive.close();
    fs.appendFileSync(journal, '{"version":1,"seq":');
    archive = new ConversationArchive(dir);
    assert.ok(archive.recoveredTail);
    assert.equal(fs.readFileSync(archive.recoveredTail!, "utf8"), '{"version":1,"seq":');
    assert.equal(archive.record("reopened", {}, {}), seq + 1);
    assert.deepEqual(archive.incomplete().tools.map((r) => r.scope.executionId), ["unfinished"]);
    assert.equal(archive.catchupCursors().get("c"), "200", "restart retains the offline gap despite newer gateway arrivals");
    assert.equal(archive.restoreContexts().get("c")?.entries.length, 0, "clear survives archive recovery");
    assert.equal(archive.wasTracked("c", "100"), true);
    assert.deepEqual(records().filter((r) => r.type === "discord.message" && r.scope.messageId === "200").map((r) => archive.readData(r)), [
      { content: "before edit" }, { content: "after edit" },
    ]);
    ok("archive: full history survives compaction, clear, edits, deletions, torn-tail recovery and restart");

    let release!: (text: string) => void;
    let executions = 0;
    const registry = new ToolRegistry().register({ name: "echo", description: "test", parameters: {} }, async (args) => {
      executions++;
      assert.ok(records().some((r) => r.type === "tool.started" && archive.readData<{ call: { arguments: string } }>(r).call.arguments === JSON.stringify(args)), "start is durable before handler execution");
      if (args.slow) return new Promise<string>((resolve) => { release = resolve; });
      return "fast result";
    });
    const pending = executeToolCalls(registry, [
      { id: "duplicate", name: "echo", arguments: '{"slow":true}' },
      { id: "duplicate", name: "echo", arguments: "{}" },
    ], archiveTools(archive, { channelId: "c", turnId: "tools", round: 0 }));
    await ticks(3);
    assert.ok(records().some((r) => r.type === "tool.finished" && archive.readData<{ result: { content: string } }>(r).result.content === "fast result"), "fast result is durable while the other tool still runs");
    assert.equal(archive.incomplete().tools.length, 2, "old indeterminate execution and current slow execution");
    release("slow result");
    assert.deepEqual((await pending).map((r) => r.content), ["slow result", "fast result"]);
    assert.equal(archive.incomplete().tools.length, 1);
    const executionIds = records().filter((r) => r.type === "tool.started" && r.scope.turnId === "tools").map((r) => r.scope.executionId);
    assert.equal(new Set(executionIds).size, 2, "model-supplied duplicate IDs do not collide in the archive");
    archive.close();
    await assert.rejects(executeToolCalls(registry, [{ id: "never", name: "echo", arguments: "{}" }], archiveTools(archive, {})), /closed/);
    assert.equal(executions, 2, "archive failure prevents tool execution");
    archive = new ConversationArchive(dir);
    assert.equal(executions, 2, "recovery never replays a handler");
    ok("archive: tools journal before execution and individually on completion; recovery never replays side effects");

    const att = { url: "https://cdn.discordapp.com/attachments/a/b/file.txt", name: "file.txt", size: 12, contentType: "text/plain" };
    const bytes = Buffer.from("original file\n");
    const saved = await fetchMessageFiles([att], 1000, {
      storage: archiveAttachments(archive, { channelId: "c", messageId: "200" }),
      fetchImpl: async () => new Response(bytes),
    });
    assert.equal(saved.files.length, 1);
    const imageAtt = { ...att, url: att.url + ".png", name: "file.png", contentType: "image/png" };
    const imageResult = await fetchMessageImages([imageAtt], 1000, {
      storage: archiveAttachments(archive, { channelId: "c" }), fetchImpl: async () => new Response(bytes),
    });
    const captured = records().filter((r) => r.type === "attachment.saved").map((r) => archive.readData<{ blob: string }>(r).blob);
    assert.equal(captured[0], captured[1], "identical attachment bytes deduplicate by content");
    archive.close();
    archive = new ConversationArchive(dir);
    const storage = archiveAttachments(archive, { channelId: "c" });
    const unavailable = async (): Promise<Response> => { throw new Error("CDN expired"); };
    assert.deepEqual(await fetchMessageFiles([att], 1000, { storage, fetchImpl: unavailable }), saved);
    assert.deepEqual(await fetchMessageImages([imageAtt], 1000, { storage, fetchImpl: unavailable }), imageResult);
    assert.equal((await fetchMessageFiles([att], 1, { storage, fetchImpl: unavailable })).files.length, 0, "cache does not bypass byte caps");
    await assert.rejects(fetchMessageFiles([{ ...att, url: att.url + "?new" }], 1000, {
      storage: { load: () => null, save: () => { throw new Error("disk full"); } }, fetchImpl: async () => new Response(bytes),
    }), /disk full/, "archive failure must not silently send unarchived file content");
    ok("archive: attachment bytes deduplicate and survive expired URLs across restart, with limits enforced");

    const partialChat = archiveChat(archive, { channelId: "c", turnId: "partial" }, async (_messages, cbs) => {
      cbs?.onRequest?.({ messages: [], stream: true });
      cbs?.onResponseBytes?.(Buffer.from('data: {"choices":[{"delta":{"reasoning":"unfinished thought"}}]}\n\n'));
      throw new Error("connection lost");
    });
    await assert.rejects(partialChat([]), /connection lost/);
    const partial = records().filter((r) => r.scope.turnId === "partial");
    assert.ok(partial.some((r) => r.type === "model.failed"));
    assert.ok(archive.readBlob(archive.readData<{ blob: string }>(partial.find((r) => r.type === "model.bytes")!).blob).includes("unfinished thought"));
    ok("archive: failed generations retain received reasoning bytes and failure identity");
  } finally {
    archive.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glove-archive-corrupt-"));
  try {
    const archive = new ConversationArchive(dir);
    archive.record("test", {}, { preserved: true });
    archive.close();
    const journal = path.join(dir, "events.jsonl");
    const original = fs.readFileSync(journal, "utf8");
    fs.writeFileSync(journal, original.replace('"seq":1', '"seq":2'));
    assert.throws(() => new ConversationArchive(dir), /corrupt/);
    assert.equal(fs.readFileSync(journal, "utf8"), original.replace('"seq":1', '"seq":2'), "complete corrupt records are never silently truncated");
    fs.writeFileSync(journal, original);
    const row = JSON.parse(original) as ArchiveRecord;
    fs.writeFileSync(path.join(dir, "blobs", row.data), "corrupt");
    assert.throws(() => new ConversationArchive(dir), /blob is corrupt/);
    ok("archive: journal and payload corruption fail closed without destroying evidence");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

{
  const messages = Array.from({ length: 251 }, (_, i) => ({ id: String(1000 + i) }));
  const seen: string[] = [];
  let fetches = 0;
  await captureCatchup("1000", async (before) => {
    fetches++;
    return messages.filter((m) => !before || BigInt(m.id) < BigInt(before)).slice(-100).reverse();
  }, (message) => { seen.push(message.id); });
  assert.equal(fetches, 3);
  assert.equal(seen.length, 250);
  assert.equal(new Set(seen).size, 250);
  assert.ok(!seen.includes("1000"));
  let firstRunFetches = 0;
  await captureCatchup(null, async () => { firstRunFetches++; return messages.slice(-100); }, () => {});
  assert.equal(firstRunFetches, 1, "first archive baseline is bounded");
  await assert.rejects(captureCatchup("1000", async () => messages.slice(-100), () => {}), /did not advance/);
  ok("archive: offline catch-up paginates beyond 100 messages and rejects nonadvancing pages");
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glove-recover-turns-"));
  let archive = new ConversationArchive(dir);
  const makeStore = (): ChannelContextStore => {
    const store = new ChannelContextStore((channelId, context) => archive.record("context.checkpoint", { channelId }, context.serialize()));
    for (const [id, data] of archive.restoreContexts()) if (data) store.restore(id, data);
    return store;
  };
  try {
    let store = makeStore();
    store.get("c").pushUser("Alice", "do work", "trigger", 100, []);
    const scope = { channelId: "c", turnId: "interrupted", messageId: "trigger", attempt: 0, round: 0, purpose: "reply" as const };
    archive.record("turn.started", scope, { id: "trigger", chime: false });
    const calls = [{ id: "one", name: "echo", arguments: "{}" }, { id: "two", name: "echo", arguments: "{}" }];
    archive.record("model.finished", scope, { content: "raw narration", reasoning: "retained thought", toolCalls: calls });
    const observer = archiveTools(archive, scope);
    observer.started(calls[0], 0);
    observer.started(calls[1], 1);
    observer.finished({ role: "tool", name: "echo", toolCallId: "one", content: "completed before crash" }, 0);
    archive.close();
    archive = new ConversationArchive(dir);
    store = makeStore();
    assert.equal(recoverTurns(archive, store), 1);
    const entries = store.get("c").snapshot();
    assert.equal(entries[1].reasoning, "retained thought");
    assert.equal(entries[2].content, "completed before crash");
    assert.match(entries[3].content, /indeterminate.*restart/);
    assert.equal(entries[3].toolCallId, "two");
    assert.equal(archive.incomplete().tools.length, 1, "archive evidence remains indeterminate, never forged into a completed execution");
    const recovered = store.get("c").serialize();
    archive.close();
    archive = new ConversationArchive(dir);
    store = makeStore();
    assert.equal(recoverTurns(archive, store), 0);
    assert.deepEqual(store.get("c").snapshot(), ChannelContext.restore(recovered).snapshot(), "second restart does not duplicate recovered work");
    archive.record("turn.started", { ...scope, turnId: "checkpointed" }, {});
    store.get("c").appendTurn([], { content: "already recorded before crash", ids: [] }, "checkpointed");
    assert.equal(recoverTurns(archive, store), 0, "crash after checkpoint but before turn.finished stays idempotent");
    archive.record("turn.started", { ...scope, turnId: "cleared" }, {});
    archive.record("model.finished", { ...scope, turnId: "cleared" }, { content: "must not restore", toolCalls: [] });
    store.get("c").reset();
    assert.equal(recoverTurns(archive, store), 0);
    assert.equal(store.get("c").length, 0, "cleared trigger prevents resurrection");
    const deleted = store.get("gone");
    deleted.pushUser("Alice", "old", "old", 1, []);
    archive.record("channel.deleted", { channelId: "gone" }, {});
    store.clear("gone");
    deleted.setMeasuredTokens(10);
    assert.equal(archive.restoreContexts().get("gone"), null, "late turn accounting cannot resurrect a deleted channel");
    ok("archive: crash recovery restores completed work once, labels uncertain tools, and respects clears/deletions");
  } finally { archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glove-recover-chime-repair-"));
  let archive = new ConversationArchive(dir);
  try {
    const store = new ChannelContextStore();
    store.get("c").pushUser("Alice", "write once", "trigger", 100, []);
    const scope = { channelId: "c", turnId: "repair", messageId: "trigger", attempt: 0, round: 0 };
    archive.record("context.checkpoint", { channelId: "c" }, store.get("c").serialize());
    archive.record("turn.started", scope, { id: "trigger", chime: false });
    const decision = { id: "d", name: "chime", arguments: '{"respond":false}' };
    const write = { id: "w", name: "write", arguments: "{}" };
    let calls = 0;
    const chat = chimeReplyChat(archiveChat(archive, { ...scope, purpose: "reply-candidate" }, async () => {
      calls++;
      return { content: "", toolCalls: calls === 1 ? [decision] : [decision, write] };
    }));
    const result = await chat([{ role: "user", content: "write once" }], undefined,
      [{ name: "write", description: "write", parameters: {} }]);
    archive.record("reply.accepted", { ...scope, purpose: "reply" }, result);
    const observer = archiveTools(archive, scope);
    observer.started(write, 0);
    observer.finished({ role: "tool", name: "write", toolCallId: "w", content: "saved once" }, 0);
    // Simulate a crash after the tool result, before the atomic turn checkpoint.
    archive.close();
    archive = new ConversationArchive(dir);
    const restored = new ChannelContextStore();
    for (const [id, data] of archive.restoreContexts()) if (data) restored.restore(id, data);
    assert.equal(recoverTurns(archive, restored), 1);
    const entries = restored.get("c").snapshot();
    assert.deepEqual(entries[1].toolCalls, [write]);
    assert.equal(entries[2].toolCallId, "w");
    assert.equal(entries[2].content, "saved once");
    assert.equal(entries.filter(e => e.role === "tool").length, 1, "no duplicated round or phantom chime result");
    assert.equal(recoverTurns(archive, restored), 0);
    assert.equal(calls, 2, "recovery never replays model calls");
    assert.equal([...archive.records()].filter(r => r.type === "model.finished" && r.scope.purpose === "reply-candidate").length, 2,
      "raw rejected and mixed responses remain in the durable archive");
    ok("archive: reply repair recovery restores only accepted calls with correctly paired results");
  } finally { archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glove-archive-http-"));
  const archive = new ConversationArchive(dir);
  const sse = 'data: {"choices":[{"delta":{"reasoning_content":"full thought","content":"hello 🌍","tool_calls":[{"index":0,"id":"tc","function":{"name":"echo","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
  const json = JSON.stringify({ choices: [{ message: { content: "json answer", reasoning_content: "json thought" } }] });
  let wireRequest = "";
  let brokenResponse: http.ServerResponse | undefined;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      wireRequest = body;
      if (req.url === "/json") { res.setHeader("Content-Type", "application/json"); res.end(json); }
      else if (req.url === "/broken") {
        brokenResponse = res;
        res.setHeader("Content-Type", "text/event-stream");
        res.write('data: {"choices":[{"delta":{"reasoning_content":"unfinished reasoning"}}]}\n\n');
      } else { res.setHeader("Content-Type", "text/event-stream"); res.end(sse); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const mode of ["stream", "json", "broken"]) {
      const llm = new LlmClient({ apiUrl: `${base}/${mode}`, apiKey: "archive-test-secret-key", model: "test-model", stream: mode !== "json", timeoutMs: 5000 });
      const chat = archiveChat(archive, { channelId: "c", turnId: mode }, llm.chat.bind(llm));
      const pending = chat([{ role: "user", content: "exact input" }], { onReasoning: () => { if (mode === "broken") brokenResponse?.destroy(); } });
      if (mode === "broken") await assert.rejects(pending);
      else assert.equal((await pending).reasoning, mode === "stream" ? "full thought" : "json thought");
      const events = [...archive.records()].filter((r) => r.scope.turnId === mode);
      assert.deepEqual(archive.readData(events.find((r) => r.type === "model.request")!), JSON.parse(wireRequest));
      const received = Buffer.concat(events.filter((r) => r.type === "model.bytes").map((r) => archive.readBlob(archive.readData<{ blob: string }>(r).blob))).toString("utf8");
      if (mode === "broken") assert.match(received, /unfinished reasoning/);
      else assert.equal(received, mode === "stream" ? sse : json, "exact response bytes preserved, including SSE framing and Unicode");
    }
    for (const file of fs.readdirSync(path.join(dir, "blobs"))) {
      assert.ok(!fs.readFileSync(path.join(dir, "blobs", file)).includes("archive-test-secret-key"), "authorization headers are never archived");
    }
    ok("archive: real HTTP JSON/SSE requests, responses, reasoning, tool fragments and broken streams round-trip without auth headers");
  } finally {
    archive.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "glove-archive-cli-"));
  const dir = path.join(parent, "archive");
  const archive = new ConversationArchive(dir);
  archive.record("discord.message", { channelId: "c", messageId: "1" }, { content: "export me" });
  archive.close();
  const cli = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, ["--import", "tsx", "src/archive-cli.ts", ...args], { encoding: "utf8" });
  try {
    const inspected = cli("inspect", dir);
    assert.equal(inspected.status, 0, String(inspected.stderr));
    assert.equal(JSON.parse(String(inspected.stdout)).lastSequence, 1);
    const exported = cli("export", dir, "--channel=c");
    assert.equal(exported.status, 0, String(exported.stderr));
    assert.equal(JSON.parse(String(exported.stdout)).payload.content, "export me");
    assert.notEqual(cli("purge", dir).status, 0);
    assert.ok(fs.existsSync(dir), "purge without confirmation keeps archive intact");
    const locked = new ConversationArchive(dir);
    assert.notEqual(cli("purge", dir, "--confirm").status, 0);
    locked.close();
    fs.writeFileSync(path.join(parent, "chats.json"), "working context");
    assert.equal(cli("purge", dir, "--confirm").status, 0);
    assert.ok(!fs.existsSync(dir));
    assert.equal(fs.readFileSync(path.join(parent, "chats.json"), "utf8"), "working context");
    ok("archive: inspect/export work; purge requires explicit confirmation and refuses an active writer");
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}

console.log(`\n${checks} check groups passed`);
