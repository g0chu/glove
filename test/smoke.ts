/**
 * Smoke tests: config parsing, the stability gate (a message commits once
 * it has been unchanged for the window), code-fence-aware chunk splitting,
 * image attachment downloads, turn-context building (the persistent
 * per-channel context: seed, growth, compaction, emergency trim) and the
 * !clear command (fresh-chat reset), queue semantics, response writer
 * behavior (incl. multi-message streaming of long replies), the tool
 * executor and tool loop, the in-process web/file/shell/zim tools (against
 * a synthetic ZIM file built in a temp dir), and the LLM client (stream +
 * non-stream + tool calls + errors + multimodal wire shape) against a
 * local mock OpenAI-compatible server. Run with: npm test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ChannelType, type GuildTextBasedChannel, type Message } from "discord.js";
import { parseConfig } from "../src/config.js";
import { CLEAR_CONFIRMATION, isClearCommand, isMentionOf, isTrackable } from "../src/bot/router.js";
import { ChannelContext, COMPACTION_SYSTEM_PROMPT, estimateTokens } from "../src/llm/context.js";
import { MessageGate, type GateMessage } from "../src/bot/gate.js";
import { CHIME_SYSTEM_PROMPT, decideChime } from "../src/bot/chime.js";
import { LlmClient, type ChatMessage, type ChatResult } from "../src/llm/client.js";
import { ChannelQueue, type TurnRequest } from "../src/bot/queue.js";
import { ResponseWriter, splitForDiscord } from "../src/bot/writer.js";
import { sanitizeForDiscord } from "../src/bot/format.js";
import { fetchMessageImages, isDiscordCdnUrl, type ImageFetch, type MessageAttachmentLike } from "../src/bot/images.js";
import { fetchMessageFiles, fenceFor, isProbablyText, type FileFetch } from "../src/bot/files.js";
import { buildChannelContext, contextToMessages, type MessageLike } from "../src/bot/context.js";
import { ToolRegistry, executeToolCalls, parseToolArgs, argString, argOptionalString, argInt } from "../src/tools/executor.js";
import { runToolTurn } from "../src/tools/loop.js";
import { formatToolCall, ToolActivityPoster } from "../src/tools/activity.js";
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

// --------------------------------------------------------------- chime --
{
  // The chime decision (driven with a fake client — no HTTP): the model sees
  // the system prompt + the transcript and answers YES/NO; anything that is
  // not a YES (garbage, empty, a failed call) keeps the bot silent.
  const fakeLlm = (content: string, fail = false): LlmClient =>
    ({
      chat: async (): Promise<ChatResult> => {
        if (fail) throw new Error("llm down");
        return { content, toolCalls: [] };
      },
    }) as unknown as LlmClient;
  const transcript: ChatMessage[] = [
    { role: "user", content: "Alice: hi" },
    { role: "user", content: "Bob (bot): should we ship it?" },
  ];
  assert.equal(await decideChime(fakeLlm("YES"), transcript), true);
  assert.equal(await decideChime(fakeLlm("yes"), transcript), true, "case-insensitive");
  assert.equal(await decideChime(fakeLlm("YES — it asks a direct question"), transcript), true, "the leading word decides");
  assert.equal(await decideChime(fakeLlm("NO"), transcript), false);
  assert.equal(await decideChime(fakeLlm("no, it is just chatter"), transcript), false);
  assert.equal(await decideChime(fakeLlm("maybe"), transcript), false, "garbage stays silent");
  assert.equal(await decideChime(fakeLlm(""), transcript), false, "an empty answer stays silent");
  assert.equal(await decideChime(fakeLlm("", true), transcript), false, "a failed call stays silent");
  ok("chime: YES only on a YES answer (NO, garbage, empty, and errors stay silent)");

  // The decision call is tool-less: system prompt first, then the transcript
  // (which ends with the message to decide about) — nothing else.
  let sent: ChatMessage[] = [];
  const spying = {
    chat: async (msgs: ChatMessage[]): Promise<ChatResult> => {
      sent = msgs;
      return { content: "YES", toolCalls: [] };
    },
  } as unknown as LlmClient;
  await decideChime(spying, transcript);
  assert.equal(sent.length, transcript.length + 1);
  assert.equal(sent[0].role, "system");
  assert.equal(sent[0].content, CHIME_SYSTEM_PROMPT);
  assert.deepEqual(sent.slice(1), transcript);
  ok("chime: the decision is one tool-less call (system prompt + transcript)");
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
  kstore.reset();
  assert.equal(kstore.length, 0, "entries dropped");
  assert.equal(kstore.getSummary(), null, "summary dropped");
  assert.equal(kstore.seeded, true, "no re-seed after a clear");
  // The next turn does not seed (the fetch below would throw if attempted)
  // and carries only what arrived after the clear.
  kstore.pushUser("Alice", "fresh start", "k3", 300, []);
  const kOpts = {
    botId: "bot1",
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
}

// --------------------------------------------------------------- writer --
{
  interface FakeMessage {
    id: string;
    content: string;
    edit: (u: { content: string }) => Promise<FakeMessage>;
  }
  const makeChannel = () => {
    const sent: string[] = [];
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
        };
        live = m;
        messages.push(m);
        sent.push(data.content);
        return m;
      },
    };
    return { channel, sent, messages, getLive: () => live };
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
  const preview = (w4d as unknown as { reasoningPreview(): string }).reasoningPreview();
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
  assert.equal(g.sent.length, 2, "reply streams in a fresh message");
  assert.match(g.messages[0].content, /^🤔 \*Let me think step by step\. First, the units; xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\.\.\. \(\d+s\)\*$/, "thinking completes into first-line (truncated at the tool-line length) + seconds");
  assert.equal(g.getLive()!.content, "The answer is 42.", "reply takes over in its own message");
  const p7 = await w7.finish("The answer is 42.");
  assert.equal(p7!.text, "The answer is 42.", "reasoning is not posted or recorded");
  assert.deepEqual(p7!.messageIds, [g.messages[1].id], "only the reply message is recorded");
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

  // discard() persists the round's thinking (the live thinking message is
  // completed into its terminal line, not deleted) and clears the reasoning
  // buffer: the next round's thinking starts fresh instead of continuing
  // the old one
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
    throttleMs: 2000,
  });
  w8.start();
  w8.reason("old round thinking…");
  await ticks(2);
  assert.equal(actMsgs.length, 1, "thinking preview creates the live message");
  assert.match(actMsgs[0].content, /thinking/);
  w8.discard();
  await ticks(3);
  assert.equal(actMsgs[0].deleted, false, "thinking message persisted (not deleted) on discard");
  assert.match(actMsgs[0].content, /^🤔 \*old round thinking… \(\d+s\)\*$/, "completed into its terminal line");
  w8.reason("fresh round thinking");
  await ticks(2);
  assert.equal(actMsgs.length, 2, "next round gets a fresh message");
  assert.match(actMsgs[1].content, /fresh round/);
  assert.doesNotMatch(actMsgs[1].content, /old round/, "cleared reasoning does not leak into the new round");
  const p8 = await w8.finish("done");
  assert.equal(p8!.text, "done");
  ok("writer: discard() persists the round's thinking, next round is fresh");
  // Every tool-call round's reasoning is persisted as its own terminal line
  // (the live thinking message is completed in place, never deleted), so the
  // channel shows a thought line between each round's tool activity — not
  // just one at the very end.
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
    throttleMs: 2000,
  });
  wT.start();
  // Round 1: thinking only (no text to settle), then a tool call — thinking
  // persisted by discard().
  wT.reason("Round one: gather the data.");
  await ticks(2);
  wT.discard();
  await ticks(3);
  assert.equal(tMsgs.length, 1, "round 1: the thinking line");
  assert.match(tMsgs[0].content, /^🤔 \*Round one: gather the data\. \(\d+s\)\*$/, "round 1 thinking persisted by discard()");
  assert.equal(tMsgs[0].deleted, false, "round 1 thinking line not deleted");
  // Round 2: thinking only, then a tool call — a fresh terminal line.
  wT.reason("Round two: analyze it.");
  await ticks(2);
  wT.discard();
  await ticks(3);
  assert.equal(tMsgs.length, 2, "round 2: a fresh thinking line");
  assert.match(tMsgs[1].content, /^🤔 \*Round two: analyze it\. \(\d+s\)\*$/, "round 2 thinking persisted by discard()");
  // Round 3: thinking, then the final answer (the thinking line completes
  // when the reply takes over).
  wT.reason("Round three: answer.");
  await ticks(2);
  assert.equal(tMsgs.length, 3, "round 3: a fresh thinking line");
  wT.chunk("The final answer.");
  await ticks(2);
  assert.match(tMsgs[2].content, /^🤔 \*Round three: answer\. \(\d+s\)\*$/, "round 3 thinking completes when the reply starts");
  assert.equal(tMsgs.length, 4, "the reply streams in a fresh message");
  assert.equal(tMsgs[3].content, "The final answer.", "the reply is a fresh message");
  const pT = await wT.finish("The final answer.");
  assert.equal(pT!.text, "The final answer.");
  assert.equal(tMsgs[3].content, "The final answer.", "the reply settles in place");
  assert.deepEqual(tMsgs.map((m) => m.deleted), [false, false, false, false], "no thinking line is deleted");
  ok("writer: every tool-call round's reasoning persists as its own terminal line");
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
  assert.equal(uMsgs.length, 2, "thinking line + text preview");
  assert.match(uMsgs[0].content, /^🤔 \*Thinking then text\. \(\d+s\)\*$/, "thinking completes when the text starts");
  assert.equal(uMsgs[0].deleted, false);
  assert.equal(uMsgs[1].content, "transient text");
  wU.discard();
  await ticks(3);
  assert.equal(uMsgs.length, 2, "discard() posts no second terminal line");
  assert.equal(uMsgs[1].deleted, false, "the round's text is settled in place (not deleted)");
  assert.equal(uMsgs[1].content, "transient text", "settled to the round's full text");
  assert.equal(uMsgs[0].deleted, false, "the thinking line is kept");
  assert.match(uMsgs[0].content, /^🤔 \*Thinking then text\. \(\d+s\)\*$/, "the thinking line is unchanged");
  ok("writer: a reasoning + text round posts exactly one terminal line and keeps the text");

  // non-stream mode: the whole reasoning arrives at once (one reason() call,
  // no chunks); on finish the thinking line completes in place and the
  // reply posts as a fresh message below it
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
  assert.equal(n.sent.length, 2, "reply posts as a fresh message");
  assert.match(n.messages[0].content, /^🤔 \*Let me check the units first\. \(\d+s\)\*$/, "thinking line completed on finish (first line, untruncated)");
  assert.equal(n.getLive()!.content, "The answer is 7.");
  assert.equal(p9!.text, "The answer is 7.");
  assert.deepEqual(p9!.messageIds, [n.messages[1].id], "only the reply message is recorded");
  ok("writer: non-stream reasoning completes into a line, reply posted fresh");

  // reasoning-only response (no content at all): the thinking line survives
  // and the "no response" note posts below it
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
  assert.equal(o.sent.length, 2, "thinking line + note");
  assert.match(o.messages[0].content, /^🤔 \*hmm, nothing to say… \(\d+s\)\*$/, "thinking line completed (first line, untruncated)");
  assert.match(o.messages[1].content, /no response/i, "note posts as its own message");
  assert.equal(p10!.messageIds.length, 1, "only the note is recorded");
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
  assert.ok(zimOnly.systemNote?.includes("Summarize tool results"), "the common rule stays");
  const { config: allCfg, errors: allErrs } = parseConfig({
    ...base,
    WEBTOOLS_ENABLED: "true",
    FILETOOLS_ENABLED: "true",
    SHELLTOOLS_ENABLED: "true",
    ZIMTOOLS_ENABLED: "true",
    ZIM_FILE: "/tmp/wiki.zim",
  });
  assert.deepEqual(allErrs, []);
  const all = buildTools(allCfg);
  assert.equal(all.registry.size, 8);
  for (const name of [
    "web_search",
    "web_fetch",
    "file_read",
    "file_write",
    "file_edit",
    "shell_exec",
    "wikipedia_search",
    "wikipedia_read",
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
  const poster = new ToolActivityPoster(batchedChan as unknown as GuildTextBasedChannel);
  await poster.addCalls([
    { id: "t1", name: "web_search", arguments: '{"query":"quantum computing"}' },
    { id: "t2", name: "file_read", arguments: '{"path":"notes.md"}' },
    { id: "t3", name: "shell_exec", arguments: '{"command":"git status"}' },
  ]);
  assert.equal(batched.length, 1, "one new message for the whole turn");
  assert.equal(batched[0].edits, 0, "the first round posts, not edits");
  assert.equal(
    batched[0].content,
    ['🔎 *web_search(query="quantum computing")*', '📁 *file_read(path="notes.md")*', '🐚 *shell_exec(command="git status")*'].join("\n"),
    "a round's lines land together, in call order",
  );
  await poster.addCalls([{ id: "t4", name: "wikipedia_search", arguments: '{"query":"z"}' }]);
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
  const capPoster = new ToolActivityPoster(capChan as unknown as GuildTextBasedChannel);
  const capArgs = JSON.stringify({ query: "q".repeat(60), url: "https://example.com/" + "x".repeat(60) });
  await capPoster.addCalls(Array.from({ length: 40 }, (_, i) => ({ id: `c${String(i)}`, name: "web_search", arguments: capArgs })));
  assert.equal(capSends, 1, "still one message after 40 calls");
  assert.ok(capContent.length <= 2000, `the cap keeps the message under 2000 (got ${capContent.length})`);
  const capLines = capContent.split("\n");
  const earlier = Number(capLines[0].match(/… (\d+) earlier calls …/)?.[1] ?? -1);
  assert.ok(earlier > 0, `the header counts the dropped lines (got: ${capLines[0]})`);
  assert.equal(earlier + capLines.length - 1, 40, "kept + dropped = every call");
  assert.match(capLines[capLines.length - 1], /web_search/, "the newest lines are kept");
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
  const flakyPoster = new ToolActivityPoster(flakyChan as unknown as GuildTextBasedChannel);
  flaky.failSend = true;
  await flakyPoster.addCalls([{ id: "f1", name: "web_search", arguments: '{"query":"a"}' }]);
  assert.equal(flaky.sends, 1, "the first post was attempted");
  await flakyPoster.addCalls([{ id: "f2", name: "file_read", arguments: '{"path":"b"}' }]);
  assert.equal(flaky.sends, 2, "the failed post is retried on the next round");
  assert.ok(flaky.content.includes("web_search") && flaky.content.includes("file_read"), "the retried post carries every call");
  flaky.failEdit = true;
  await flakyPoster.addCalls([{ id: "f3", name: "shell_exec", arguments: '{"command":"c"}' }]);
  assert.equal(flaky.edits, 1, "the edit was attempted");
  assert.ok(!flaky.content.includes("shell_exec"), "a failed edit keeps the last good content");
  await flakyPoster.addCalls([{ id: "f4", name: "wikipedia_search", arguments: '{"query":"d"}' }]);
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

// ------------------------------------------------------------------- llm --
{
  const seenRequests: Array<{ auth: string | undefined; ct: string | undefined; body: unknown; url: string }> = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      seenRequests.push({ auth: req.headers.authorization, ct: req.headers["content-type"], body: JSON.parse(body), url });
      if (url.includes("slow")) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "late" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 300);
        return;
      }
      if (url.includes("hold")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "start" } }] })}\n\n`);
        // deliberately no [DONE] and no end(): the stream stays open until
        // the client aborts it
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
  ok("llm: streamed reasoning reaches onReasoning only");

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
  ok("llm: non-stream reasoning handed to onReasoning");

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

  server.close();
}

console.log(`\n${checks} check groups passed`);
