/**
 * Smoke tests: config parsing, history window, code-fence-aware chunk
 * splitting, queue semantics, response writer behavior, the tool executor
 * and tool loop, the in-process web/file tools, and the LLM client
 * (stream + non-stream + tool calls + errors) against a local mock
 * OpenAI-compatible server. Run with: npm test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { GuildTextBasedChannel } from "discord.js";
import { parseConfig } from "../src/config.js";
import { ChannelHistory, toRequestMessages } from "../src/llm/history.js";
import { LlmClient, type ChatMessage, type ChatResult } from "../src/llm/client.js";
import { ChannelQueue } from "../src/bot/queue.js";
import { ResponseWriter, splitForDiscord } from "../src/bot/writer.js";
import { sanitizeForDiscord } from "../src/bot/format.js";
import { ToolRegistry, executeToolCalls, parseToolArgs, argString, argOptionalString, argInt } from "../src/tools/executor.js";
import { runToolTurn } from "../src/tools/loop.js";
import { formatToolCall } from "../src/tools/activity.js";
import { resolveUrl } from "../src/tools/web/ssrf.js";
import { FetchCache } from "../src/tools/web/cache.js";
import { extractTitle, extractContent } from "../src/tools/web/extract.js";
import { searchDuckDuckGo } from "../src/tools/web/search.js";
import { resolveInWorkspace } from "../src/tools/file/paths.js";
import * as fileOps from "../src/tools/file/ops.js";

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
  });
  assert.deepEqual(errors, []);
  assert.equal(config.discord.token, "tok");
  assert.equal(config.discord.guildId, "123");
  assert.equal(config.model.stream, false);
  assert.equal(config.model.timeoutMs, 5000);
  assert.equal(config.model.contextMaxMessages, 7);
  assert.equal(config.model.apiKey, "k1");
  assert.equal(config.discord.typingIntervalMs, 5000); // default
  assert.equal(config.discord.streamUpdateThrottleMs, 2000); // default
  assert.equal(config.discord.showReasoning, true); // default
  assert.equal(config.discord.showToolActivity, true); // default
  ok("config: parses valid env and applies defaults");

  const { errors: badErrors } = parseConfig({
    DISCORD_TOKEN: "",
    DISCORD_GUILD_ID: "",
    MODEL_API_URL: "not a url",
    MODEL_TIMEOUT_S: "abc",
    MODEL_STREAM: "banana",
    DISCORD_SHOW_REASONING: "maybe",
  });
  assert.ok(badErrors.length >= 5, `expected >= 5 errors, got ${badErrors.length}`);
  assert.ok(badErrors.some((e) => e.includes("DISCORD_SHOW_REASONING")), `got: ${badErrors.join("; ")}`);
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
    TOOLS_MAX_RESULT_CHARS: "12345",
    TOOLS_MAX_ROUNDS: "7",
    DISCORD_SHOW_REASONING: "false",
    DISCORD_SHOW_TOOL_ACTIVITY: "false",
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
  assert.equal(tc.tools.file.listMaxEntries, 500); // default
  assert.equal(tc.tools.maxResultChars, 12345);
  assert.equal(tc.tools.maxRounds, 7);
  ok("config: tools section parses env and applies defaults");

  const { config: td } = parseConfig({
    DISCORD_TOKEN: "t",
    DISCORD_GUILD_ID: "g",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
  });
  assert.equal(td.tools.web.enabled, false, "web tools off by default");
  assert.equal(td.tools.file.enabled, false, "file tools off by default");
  assert.equal(td.tools.file.workspace, "./workspace");
  assert.equal(td.tools.web.searchMaxResults, 10); // default
  assert.equal(td.tools.maxResultChars, 200_000); // default
  assert.equal(td.tools.maxRounds, 5);
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
}

// --------------------------------------------------------------- history --
{
  const h = new ChannelHistory(3);
  h.push("user", "a", ["1"]);
  h.push("assistant", "b", ["2"]);
  h.push("user", "c", ["3"]);
  h.push("user", "d", ["4"]);
  h.push("assistant", "e", ["5"]);
  assert.deepEqual(
    h.snapshot().map((m) => `${m.role}:${m.content}`),
    ["user:c", "user:d", "assistant:e"],
  );
  ok("history: sliding window keeps only the last N");

  // Edits update in place (keeping position); deletes drop the entry.
  const h2 = new ChannelHistory(10);
  h2.push("user", "hi", ["10"]);
  h2.push("assistant", "hello", ["11"]);
  h2.push("user", "thanks", ["12"]);
  h2.updateContent("10", "hii (edited)");
  assert.deepEqual(h2.snapshot().map((m) => m.content), ["hii (edited)", "hello", "thanks"]);
  assert.equal(h2.has("11"), true);
  assert.equal(h2.removeById("11"), true, "assistant entry removed by its message id");
  assert.deepEqual(h2.snapshot().map((m) => m.content), ["hii (edited)", "thanks"]);
  assert.equal(h2.removeById("nope"), false, "unknown id is a no-op");
  ok("history: id-based edit/delete keeps the window in sync");

  // Chunked assistant replies: any chunk id resolves the entry, and editing
  // a chunk rebuilds the visible text from the stored chunks.
  const h3 = new ChannelHistory(10);
  h3.push("assistant", "canonical full reply", ["20", "21"], ["part one", "part two"]);
  assert.equal(h3.find("21")!.content, "canonical full reply");
  h3.updateChunk("21", "part two (edited)");
  assert.equal(h3.find("21")!.content, "part one\npart two (edited)");
  assert.equal(h3.find("20")!.content, "part one\npart two (edited)", "first chunk id resolves the same entry");
  h3.updateChunk("21", "part two");
  assert.equal(h3.find("20")!.content, "part one\npart two", "editing back rebuilds too");
  assert.equal(h3.removeById("20"), true, "deleting any chunk drops the whole reply");
  assert.equal(h3.length, 0);
  ok("history: chunked assistant entries (rebuild on edit, drop on delete)");

  const h4 = new ChannelHistory(10);
  h4.push("user", "", ["30"]); // e.g. a bare mention: tracked, but no text
  h4.push("user", "hi", ["31"]);
  assert.deepEqual(toRequestMessages(h4, "You are helpful."), [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(toRequestMessages(h4, "   "), [{ role: "user", content: "hi" }]);
  ok("history: request messages skip textless entries, with/without system prompt");
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
  // Display math and noise commands.
  assert.equal(sanitizeForDiscord("$$\\text{VO}_2 = \\text{CO} \\times a$$"), "VO₂ = CO × a");
  assert.equal(sanitizeForDiscord("$\\label{eq1} y$"), "y");
  ok("format: LaTeX math converted to Unicode, non-math $ left alone");
}

// ----------------------------------------------------------------- queue --
{
  const events: string[] = [];
  let gate: (() => void) | null = null;
  let turnCount = 0;
  const deps = {
    runTurn: async (ch: string, mentionId: string): Promise<void> => {
      turnCount++;
      events.push(`turn:${ch}:${mentionId}`);
      if (mentionId === "m1") await new Promise<void>((r) => (gate = r));
    },
  };

  const q = new ChannelQueue("c1", deps);
  q.push("m1");
  q.push("m2");
  await ticks(3);
  assert.deepEqual(events, ["turn:c1:m1"], "second mention waits for the first turn to finish");
  gate!();
  await ticks(5);
  assert.deepEqual(events, ["turn:c1:m1", "turn:c1:m2"], "mentions run in arrival order");
  assert.equal(turnCount, 2);
  ok("queue: one turn at a time, FIFO");

  // A turn that throws must not kill the worker.
  const events2: string[] = [];
  const q2 = new ChannelQueue("c2", {
    runTurn: async (_c: string, mentionId: string): Promise<void> => {
      if (mentionId === "a") throw new Error("boom");
      events2.push(mentionId);
    },
  });
  q2.push("a");
  q2.push("b");
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
      send: async (content: string) => {
        const m: FakeMessage = {
          id: `msg${String(++nextId)}`,
          content,
          edit: async (u) => {
            m.content = u.content;
            return m;
          },
        };
        live = m;
        messages.push(m);
        sent.push(content);
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

  // discard(): a tool-call round's streamed preview is deleted, and the
  // next round streams a fresh live message
  const msgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const dchan = {
    sendTyping: async (): Promise<void> => {},
    send: async (content: string) => {
      const m = { id: `w${String(msgs.length)}`, content, deleted: false };
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
  assert.equal(msgs[0].deleted, true, "preview deleted on discard");
  w5.chunk("Final answer!");
  await ticks(2);
  const p5 = await w5.finish("Final answer!");
  assert.equal(msgs.length, 2, "next round streams a fresh live message");
  assert.equal(msgs[1].deleted, false);
  assert.equal(msgs[1].content, "Final answer!");
  assert.equal(p5!.text, "Final answer!");
  assert.deepEqual(p5!.messageIds, [msgs[1].id]);
  ok("writer: discard() deletes the transient preview, next round is fresh");

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
  // when the reply starts the thinking message completes in place ("🤔
  // *thought for Ns*") while the reply streams in a fresh message;
  // reasoning is never posted or recorded
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
  assert.match(g.messages[0].content, /^🤔 \*thought for \d+s\*$/, "thinking message completes in place");
  assert.equal(g.getLive()!.content, "The answer is 42.", "reply takes over in its own message");
  const p7 = await w7.finish("The answer is 42.");
  assert.equal(p7!.text, "The answer is 42.", "reasoning is not posted or recorded");
  assert.deepEqual(p7!.messageIds, [g.messages[1].id], "only the reply message is recorded");
  ok("writer: reasoning preview live-capped, completes into a 'thought for' line, never recorded");

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

  // discard() also clears the reasoning buffer: the next round's thinking
  // starts fresh instead of continuing the old one
  const actMsgs: Array<{ id: string; content: string; deleted: boolean }> = [];
  const actChan = {
    sendTyping: async (): Promise<void> => {},
    send: async (content: string) => {
      const m = { id: `a${String(actMsgs.length)}`, content, deleted: false };
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
  assert.equal(actMsgs[0].deleted, true, "preview deleted on discard");
  w8.reason("fresh round thinking");
  await ticks(2);
  assert.equal(actMsgs.length, 2, "next round gets a fresh message");
  assert.match(actMsgs[1].content, /fresh round/);
  assert.doesNotMatch(actMsgs[1].content, /old round/, "cleared reasoning does not leak into the new round");
  const p8 = await w8.finish("done");
  assert.equal(p8!.text, "done");
  ok("writer: discard() clears the reasoning buffer, next round is fresh");

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
  assert.match(n.messages[0].content, /^🤔 \*thought for \d+s\*$/, "thinking line completed on finish");
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
  assert.match(o.messages[0].content, /^🤔 \*thought for \d+s\*$/, "thinking line completed");
  assert.match(o.messages[1].content, /no response/i, "note posts as its own message");
  assert.equal(p10!.messageIds.length, 1, "only the note is recorded");
  ok("writer: reasoning-only turn keeps the thinking line, note posted fresh");

  // discard() must delete even a live message whose initial send is still in
  // flight when discard() runs (the capture happens in the chain step, which
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
  assert.equal(raceMsgs[0].deleted, true, "in-flight preview deleted on discard");
  ok("writer: discard() also deletes a preview whose initial send is in flight");
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
  assert.equal(toolRoundSignals, 3, "onToolRound fires for every tool-call response, incl. the cutoff");
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

// ------------------------------------------------------------- activity --
{
  // one persistent line per call: icon, name, up to two args, … for the rest
  assert.equal(
    formatToolCall({ id: "a1", name: "web_search", arguments: '{"query":"quantum computing","n":5,"lang":"en"}' }),
    '🔎 *web_search(query="quantum computing", n=5, …)*',
  );
  assert.equal(formatToolCall({ id: "a2", name: "file_read", arguments: '{"path":"notes.md"}' }), '📁 *file_read(path="notes.md")*');
  assert.equal(formatToolCall({ id: "a3", name: "mystery_tool", arguments: "not json" }), "🔧 *mystery_tool*", "unparseable args tolerated");

  const longUrl = "https://example.com/" + "x".repeat(200);
  const oneLine = formatToolCall({ id: "b1", name: "web_fetch", arguments: JSON.stringify({ url: longUrl }) });
  assert.ok(oneLine.includes("…"), "long values truncated");
  assert.ok(oneLine.length < 200, `line stays short (${oneLine.length})`);

  assert.equal(formatToolCall({ id: "d1", name: "web_search", arguments: '{"query":"a*b*c"}' }), '🔎 *web_search(query="abc")*', "asterisks dropped so the italics stay intact");
  // JSON-escaped backslash: the parsed query value is the LaTeX `$\alpha$`
  assert.equal(formatToolCall({ id: "d2", name: "web_search", arguments: '{"query":"$x^2$ and $\\\\alpha$"}' }), '🔎 *web_search(query="x² and α")*', "math in args sanitized");
  ok("activity: one line per call, args truncated, asterisks dropped, math sanitized");
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
      listMaxEntries: 100,
      searchMaxResults: 500,
      searchMaxFiles: 10_000,
      searchMaxFileBytes: 100_000,
      lineMaxChars: 500,
    };

    // -- write
    const w1 = await fileOps.writeFile(ws, "notes/a.txt", "hello\n", true, ops.writeMaxBytes);
    assert.equal(w1.bytesWritten, 6);
    await assert.rejects(fileOps.writeFile(ws, "no/dirs/x.txt", "x", false, 10), /does not exist/);
    await assert.rejects(fileOps.writeFile(ws, "notes/a.txt", "x".repeat(11), true, 10), /write cap/);
    await assert.rejects(fileOps.writeFile(ws, "notes", "x", true, 10), /overwrite a directory/);
    ok("file write: create_dirs, cap, directory guard");

    // -- list
    fs.writeFileSync(path.join(ws, "top.txt"), "top");
    const listing = await fileOps.listFiles(ws, undefined, ops.listMaxEntries);
    assert.equal(listing.path, ".");
    assert.deepEqual(
      listing.entries.map((e) => `${e.name}:${e.type}`),
      ["link:dir", "notes:dir", "sub:dir", "top.txt:file"],
    );
    const noteListing = await fileOps.listFiles(ws, "notes", ops.listMaxEntries);
    assert.equal(noteListing.path, "notes");
    assert.equal(noteListing.entries.length, 1);
    assert.equal(noteListing.entries[0].name, "a.txt");
    assert.ok(typeof noteListing.entries[0].size === "number");
    assert.ok(noteListing.entries[0].mtime?.includes("UTC") ?? false);
    await assert.rejects(fileOps.listFiles(ws, "notes/a.txt", ops.listMaxEntries), /not a directory/);
    await assert.rejects(fileOps.listFiles(ws, "missing", ops.listMaxEntries), /not a directory/);
    ok("file list: dirs-first, size/mtime, path display, errors");

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
    const eAll = await fileOps.editFile(ws, "e.txt", "X", "Y", true);
    assert.equal(eAll.replacements, 3);
    assert.equal(fs.readFileSync(path.join(ws, "e.txt"), "utf8"), "aYbYcYa");
    const eFirst = await fileOps.editFile(ws, "e.txt", "Y", "Z", false);
    assert.equal(eFirst.replacements, 1);
    assert.equal(fs.readFileSync(path.join(ws, "e.txt"), "utf8"), "aZbYcYa");
    await assert.rejects(fileOps.editFile(ws, "e.txt", "", "x", false), /must not be empty/);
    await assert.rejects(fileOps.editFile(ws, "e.txt", "nope", "x", false), /not found/);
    fs.writeFileSync(path.join(ws, "bad.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    await assert.rejects(fileOps.editFile(ws, "bad.txt", "x", "y", false), /not valid UTF-8/);
    await assert.rejects(fileOps.editFile(ws, "missing.txt", "x", "y", false), /not a file/);
    ok("file edit: exact span, replace_all, empty new_text, errors");

    // -- delete
    fs.writeFileSync(path.join(ws, "del.txt"), "x");
    assert.equal((await fileOps.deletePath(ws, "del.txt")).deleted, "file");
    fs.mkdirSync(path.join(ws, "tree"));
    fs.writeFileSync(path.join(ws, "tree", "f.txt"), "x");
    assert.equal((await fileOps.deletePath(ws, "tree")).deleted, "dir");
    assert.ok(!fs.existsSync(path.join(ws, "tree")));
    await assert.rejects(fileOps.deletePath(ws, ""), /workspace root/);
    await assert.rejects(fileOps.deletePath(ws, "nope"), /not found/);
    ok("file delete: file, directory tree, root guard, errors");

    // -- search
    fs.writeFileSync(path.join(ws, "s1.txt"), "alpha\nbeta alpha\n");
    fs.mkdirSync(path.join(ws, "sdir"));
    fs.writeFileSync(path.join(ws, "sdir", "s2.txt"), "alpha gamma\n");
    const found = await fileOps.searchFiles(ws, undefined, "alpha", false, 100, ops);
    assert.deepEqual(
      found.matches.map((m) => `${m.file}:${m.line}`),
      ["s1.txt:1", "s1.txt:2", "sdir/s2.txt:1"],
    );
    const literal = await fileOps.searchFiles(ws, undefined, "a.l+", true, 100, ops);
    assert.equal(literal.matches.length, 0); // literal: no regex metachars
    const anchored = await fileOps.searchFiles(ws, undefined, "^alpha", false, 100, ops);
    assert.deepEqual(
      anchored.matches.map((m) => `${m.file}:${m.line}`),
      ["s1.txt:1", "sdir/s2.txt:1"],
    );
    const cappedResults = await fileOps.searchFiles(ws, undefined, "alpha", false, 2, ops);
    assert.equal(cappedResults.matches.length, 2);
    assert.ok(cappedResults.truncated);
    await assert.rejects(fileOps.searchFiles(ws, undefined, "[", false, 10, ops), /invalid regular expression/);
    await assert.rejects(fileOps.searchFiles(ws, "s1.txt", "alpha", false, 10, ops), /not a directory/);
    ok("file search: walk order, literal vs regex, capping, invalid pattern");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
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

  server.close();
}

console.log(`\n${checks} check groups passed`);
