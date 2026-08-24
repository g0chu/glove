/**
 * Smoke tests: config parsing, history window, code-fence-aware chunk
 * splitting, image attachment downloads, turn-context building (last-N
 * channel messages) incl. the compaction mode (persistent per-channel
 * context: seed, growth, summarization, emergency trim) and the !clear
 * command (fresh-chat reset in both modes), queue semantics,
 * response writer behavior (incl.
 * multi-message streaming of long replies), the tool executor and tool
 * loop, the in-process web/file/zim tools (against a synthetic ZIM file
 * built in a temp dir), and the LLM client (stream +
 * non-stream + tool calls + errors + multimodal wire shape) against a
 * local mock OpenAI-compatible server. Run with: npm test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { GuildTextBasedChannel } from "discord.js";
import { parseConfig } from "../src/config.js";
import { ChannelHistory, ConversationStore, toRequestMessages } from "../src/llm/history.js";
import { CLEAR_CONFIRMATION, isClearCommand } from "../src/bot/router.js";
import { ChannelContext, COMPACTION_SYSTEM_PROMPT, estimateTokens } from "../src/llm/context.js";
import { LlmClient, type ChatMessage, type ChatResult } from "../src/llm/client.js";
import { ChannelQueue } from "../src/bot/queue.js";
import { ResponseWriter, splitForDiscord } from "../src/bot/writer.js";
import { sanitizeForDiscord } from "../src/bot/format.js";
import { fetchMessageImages, isDiscordCdnUrl, type ImageFetch, type MessageAttachmentLike } from "../src/bot/images.js";
import { buildChannelContext, contextFromMessages, contextToMessages, type MessageLike } from "../src/bot/context.js";
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
  assert.equal(config.model.compactionMaxTokens, 1234);
  assert.equal(config.model.compactionKeepMessages, 5);
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
    MODEL_IMAGES_MAX_BYTES: "0",
    CONTEXT_COMPACTION_MAX_TOKENS: "abc",
  });
  assert.ok(badErrors.length >= 7, `expected >= 7 errors, got ${badErrors.length}`);
  assert.ok(badErrors.some((e) => e.includes("DISCORD_SHOW_REASONING")), `got: ${badErrors.join("; ")}`);
  assert.ok(badErrors.some((e) => e.includes("MODEL_IMAGES_MAX_BYTES")), `got: ${badErrors.join("; ")}`);
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
    TOOLS_MAX_RESULT_CHARS: "12345",
    TOOLS_MAX_ROUNDS: "7",
    DISCORD_SHOW_REASONING: "false",
    DISCORD_SHOW_TOOL_ACTIVITY: "false",
    CONTEXT_COMPACTION_ENABLED: "false",
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
  assert.equal(tc.model.compactionEnabled, false);
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
  assert.equal(td.model.enableImages, false, "image input off by default");
  assert.equal(td.model.imagesMaxBytes, 10_485_760); // default
  assert.equal(td.model.compactionEnabled, true, "compaction on by default");
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
  h4.push("user", "hi", ["31"], undefined, "Alice");
  assert.deepEqual(toRequestMessages(h4, "You are helpful."), [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Alice: hi" },
  ]);
  assert.deepEqual(toRequestMessages(h4, "   "), [{ role: "user", content: "Alice: hi" }]);
  ok("history: request messages skip textless entries, label speakers, system prompt optional");

  // !clear (classic mode): the store clears the window and records the
  // boundary message id; a newer clear moves it; forgetting the channel
  // (delete) forgets it too.
  const store = new ConversationStore(5);
  store.get("c1").push("user", "old talk", ["o1"], undefined, "Alice");
  assert.equal(store.getResetAfter("c1"), null, "no boundary yet");
  store.markCleared("c1", "cl1");
  assert.equal(store.get("c1").length, 0, "the in-memory window is cleared");
  assert.equal(store.getResetAfter("c1"), "cl1");
  store.get("c1").push("user", "new talk", ["n1"], undefined, "Alice");
  store.markCleared("c1", "cl2");
  assert.equal(store.getResetAfter("c1"), "cl2", "a newer clear moves the boundary");
  assert.equal(store.get("c1").length, 0, "cleared again");
  store.markCleared("c2", "cl3");
  assert.equal(store.getResetAfter("c2"), "cl3", "works for a channel without a window yet");
  store.clear("c1");
  assert.equal(store.getResetAfter("c1"), null, "forgetting the channel forgets the boundary");
  ok("history: !clear clears the window and records/moves the boundary (channel clear forgets it)");
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
}

// ---------------------------------------------------------------- context --
{
  const authors = {
    alice: { id: "alice", bot: false, name: "Alice" },
    carl: { id: "carl", bot: true, name: "Carl" }, // another bot: unfiltered, enters as user
    bot: { id: "bot1", bot: true, name: "Glove" },
  };
  let n = 0;
  const m = (author: { id: string; bot: boolean }, content: string, attachments: MessageAttachmentLike[] = []): MessageLike => ({
    id: `x${String(++n)}`,
    createdTimestamp: 1_000_000 + n * 1000,
    content,
    author,
    attachments,
  });

  const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const imageFetch: ImageFetch = () => Promise.resolve(new Response(imgBytes));
  const imgAtt: MessageAttachmentLike = { url: "https://cdn.discordapp.com/attachments/1/2/3/i.png", name: "img.png", size: imgBytes.length, contentType: "image/png" };
  const bigAtt: MessageAttachmentLike = { url: "https://cdn.discordapp.com/attachments/1/2/3/b.png", name: "big.png", size: 2048, contentType: "image/png" };

  const hello = m(authors.alice, "hello");
  const oldReply = m(authors.bot, "old reply"); // not in history (bot restarted since)
  const beep = m(authors.carl, "beep");
  const think = m(authors.bot, "🤔 *thought for 3s*"); // our UI line
  const activity = m(authors.bot, "🔎 *web_search(query=\"x\")*"); // our UI line
  const wiki = m(authors.bot, "📚 *wikipedia_search(query=\"loop\")*"); // our UI line
  const chunkA = m(authors.bot, "part one");
  const chunkB = m(authors.bot, "part two");
  const thanks = m(authors.alice, "thanks");
  const imgOnly = m(authors.alice, "", [imgAtt]);
  const sure = m(authors.bot, "sure!");
  const big = m(authors.alice, "look at this", [bigAtt]);
  const errNote = m(authors.bot, "⚠️ *generation failed: boom*");
  // the mention carries an image too: it must survive the history lookup
  const mention = m(authors.alice, "<@bot1> describe this", [imgAtt]);
  const fetchedList = [hello, oldReply, beep, think, activity, wiki, chunkA, chunkB, thanks, imgOnly, sure, big, errNote, mention];

  const hist = new ChannelHistory(20);
  hist.push("assistant", "full reply", [chunkA.id, chunkB.id], ["part one", "part two"]);
  hist.push("assistant", "sure!", [sure.id]);
  hist.push("assistant", "⚠️ *generation failed: boom*", [errNote.id]);
  hist.push("user", "describe this", [mention.id]);

  const opts = {
    botId: "bot1",
    systemPrompt: "sys",
    maxMessages: 20,
    enableImages: true,
    imagesMaxBytes: 1024,
    imageFetch,
  };
  const imgPart = { type: "image_url", image_url: { url: `data:image/png;base64,${imgBytes.toString("base64")}` } };
  const res = await contextFromMessages(fetchedList, hist, mention.id, opts);
  assert.deepEqual(res, [
    { role: "system", content: "sys" },
    { role: "user", content: "Alice: hello" },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "Carl (bot): beep" },
    { role: "assistant", content: "full reply" },
    { role: "user", content: "Alice: thanks" },
    { role: "user", content: [{ type: "text", text: "Alice:" }, imgPart] },
    { role: "assistant", content: "sure!" },
    { role: "user", content: "Alice: look at this\n*[attachment \"big.png\" not sent: 2 KB exceeds the 1 KB limit]*" },
    { role: "assistant", content: "⚠️ *generation failed: boom*" },
    { role: "user", content: [{ type: "text", text: "Alice: describe this" }, imgPart] },
  ]);
  ok("context: last-N mapping (speaker labels, bot marker, UI lines skipped, chunked reply once, no merging, images, mention stripped)");

  // Images disabled: attachments ignored entirely (no images, no notes).
  const res2 = await contextFromMessages(fetchedList, hist, mention.id, { ...opts, enableImages: false });
  assert.deepEqual(res2, [
    { role: "system", content: "sys" },
    { role: "user", content: "Alice: hello" },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "Carl (bot): beep" },
    { role: "assistant", content: "full reply" },
    { role: "user", content: "Alice: thanks" },
    { role: "assistant", content: "sure!" },
    { role: "user", content: "Alice: look at this" },
    { role: "assistant", content: "⚠️ *generation failed: boom*" },
    { role: "user", content: "Alice: describe this" },
  ]);
  // The mention gone from the window (deleted / pushed out) -> null: skip the turn.
  assert.equal(await contextFromMessages(fetchedList.slice(0, -1), hist, mention.id, opts), null);
  ok("context: images disabled ignores attachments; mention gone -> null");

  // A chunked reply from before a restart (no history entry): the
  // consecutive own messages posted close together (the reply's chunks) are
  // one assistant entry again; a reply posted later stays separate.
  const gm = (content: string, ts: number): MessageLike => ({
    id: `g${String(++n)}`,
    createdTimestamp: ts,
    content,
    author: authors.bot,
    attachments: [],
  });
  const um = (content: string, ts: number): MessageLike => ({
    id: `u${String(++n)}`,
    createdTimestamp: ts,
    content,
    author: authors.alice,
    attachments: [],
  });
  const ga = gm("chunk one", 2_000_000);
  const gb = gm("chunk two", 2_000_000 + 1500);
  const gc = gm("chunk three", 2_000_000 + 3000);
  const gd = gm("a later reply", 2_000_000 + 20_000); // 17 s after gc: a distinct reply
  const gq = um("the question", 2_000_000 + 30_000);
  const glist = [ga, gb, gc, gd, gq];
  const gres = await contextFromMessages(glist, new ChannelHistory(20), gq.id, opts);
  assert.deepEqual(gres, [
    { role: "system", content: "sys" },
    { role: "assistant", content: "chunk one\nchunk two\nchunk three" },
    { role: "assistant", content: "a later reply" },
    { role: "user", content: "Alice: the question" },
  ]);
  // A user message between two chunks breaks the group.
  const gs = gm("chunk one", 3_000_000);
  const gt = um("interrupting", 3_000_000 + 500);
  const gu = gm("chunk two", 3_000_000 + 1000);
  const gres2 = await contextFromMessages([gs, gt, gu], new ChannelHistory(20), gt.id, opts);
  assert.deepEqual(gres2, [
    { role: "system", content: "sys" },
    { role: "assistant", content: "chunk one" },
    { role: "user", content: "Alice: interrupting" },
    { role: "assistant", content: "chunk two" },
  ]);
  ok("context: unrecorded chunked reply (close-together own messages) is one assistant entry again");

  // Wrapper: fetches with limit = maxMessages, sorts oldest-first, and a
  // fetch failure falls back to the in-memory window (bot keeps working).
  // discord.js-shaped (the wrapper adapts them): the second message has a
  // guild nickname, which must win over the username.
  const apiList = [
    { id: "b", content: "second", createdTimestamp: 200, author: { id: "alice", bot: false, username: "Alice" }, member: { displayName: "Al" }, attachments: [] },
    { id: "a", content: "first", createdTimestamp: 100, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
  ];
  let seenLimit: number | undefined;
  const chan = {
    messages: {
      fetch: async (o: { limit?: number }) => {
        seenLimit = o.limit;
        return { values: () => apiList.values() };
      },
    },
  } as unknown as GuildTextBasedChannel;
  const wOpts = { botId: "bot1", systemPrompt: "", maxMessages: 20, enableImages: false, imagesMaxBytes: 1024 };
  const wr = await buildChannelContext(chan, new ChannelContext(), new ChannelHistory(20), "b", wOpts);
  assert.equal(seenLimit, 20, "fetch limit is the window size");
  assert.deepEqual(
    wr,
    [
      { role: "user", content: "Alice: first" },
      { role: "user", content: "Al: second" },
    ],
    "sorted oldest-first, one message per Discord message (no merging)",
  );
  assert.equal(await buildChannelContext(chan, new ChannelContext(), new ChannelHistory(20), "nope", wOpts), null);

  const throwing = { messages: { fetch: async () => { throw new Error("api down"); } } } as unknown as GuildTextBasedChannel;
  const fh = new ChannelHistory(20);
  fh.push("user", "hi", ["1"], undefined, "Alice");
  const fb = await buildChannelContext(throwing, new ChannelContext(), fh, "1", { ...wOpts, systemPrompt: "sys" });
  assert.deepEqual(fb, [
    { role: "system", content: "sys" },
    { role: "user", content: "Alice: hi" },
  ], "fetch failure falls back to the in-memory window (speakers labeled)");
  ok("context: wrapper fetch (limit, ordering) and in-memory fallback");

  // !clear boundary: only messages strictly after the clear command's own
  // message enter the context; a mention before it never runs its turn; when
  // the boundary fell out of the last-N window, everything is kept.
  const clearMsg = m(authors.alice, "!clear");
  const fresh = m(authors.alice, "fresh question");
  const clearOpts = { ...opts, systemPrompt: "", resetAfter: clearMsg.id };
  assert.deepEqual(
    await contextFromMessages([hello, clearMsg, fresh], new ChannelHistory(20), fresh.id, clearOpts),
    [{ role: "user", content: "Alice: fresh question" }],
    "only messages after the boundary (the clear itself included in neither)",
  );
  assert.equal(
    await contextFromMessages([hello, clearMsg, fresh], new ChannelHistory(20), hello.id, clearOpts),
    null,
    "a pre-clear mention never runs its turn",
  );
  assert.deepEqual(
    await contextFromMessages([fresh], new ChannelHistory(20), fresh.id, { ...opts, systemPrompt: "", resetAfter: "gone" }),
    [{ role: "user", content: "Alice: fresh question" }],
    "boundary out of the window: nothing dropped",
  );
  ok("context: the !clear boundary drops earlier messages (pre-clear mention -> null, out-of-window boundary -> kept)");

  // The clear confirmation line is a bot UI line: never context.
  const confirmed = m(authors.bot, CLEAR_CONFIRMATION);
  const afterClear = m(authors.alice, "now we start fresh");
  assert.deepEqual(
    await contextFromMessages([confirmed, afterClear], new ChannelHistory(20), afterClear.id, { ...opts, systemPrompt: "" }),
    [{ role: "user", content: "Alice: now we start fresh" }],
  );
  ok("context: the clear confirmation line is a UI line, never context");

  // Wrapper: the live fetch respects the boundary end to end.
  const cApiList = [
    { id: "co1", content: "old talk", createdTimestamp: 100, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
    { id: "ccl", content: "!clear", createdTimestamp: 200, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
    { id: "cn1", content: "fresh talk", createdTimestamp: 300, author: { id: "alice", bot: false, username: "Alice" }, attachments: [] },
  ];
  const cChan = {
    messages: {
      fetch: async () => ({ values: () => cApiList.values() }),
    },
  } as unknown as GuildTextBasedChannel;
  const cwOpts = { ...wOpts, resetAfter: "ccl" };
  assert.deepEqual(await buildChannelContext(cChan, new ChannelContext(), new ChannelHistory(20), "cn1", cwOpts), [
    { role: "user", content: "Alice: fresh talk" },
  ]);
  assert.equal(await buildChannelContext(cChan, new ChannelContext(), new ChannelHistory(20), "co1", cwOpts), null, "pre-clear mention -> null");
  ok("context: wrapper live fetch respects the !clear boundary (pre-clear mention -> null)");
}

// ----------------------------------------------------------- compaction --
{
  const noFetch = { messages: { fetch: async () => { throw new Error("no"); } } } as unknown as GuildTextBasedChannel;

  // The startup seed merges with what already arrived, in chronological
  // order, and never duplicates an already-tracked id.
  const store = new ChannelContext();
  store.pushUser("Alice", "hello from the past", "s1", 1000, []);
  store.pushUser("Bob", "new message", "s2", 5000, []);
  store.seedFrom([
    { id: "s1", ts: 1000, role: "user", content: "old copy", name: "Alice", attachments: [] },
    { id: "s3", ts: 3000, role: "user", content: "between", name: "Carol", attachments: [] },
    { id: "s4", ts: 9000, role: "user", content: "after", name: "Dan", attachments: [] },
  ]);
  assert.deepEqual(
    store.snapshot().map((e) => `${e.name}:${e.content}`),
    ["Alice:hello from the past", "Carol:between", "Bob:new message", "Dan:after"],
  );
  assert.equal(store.seeded, true);
  // Token estimate: ~4 chars/token + a fixed cost per image in the window.
  assert.equal(estimateTokens("12345678"), 2);
  const est = new ChannelContext();
  est.pushUser("A", "a".repeat(800), "e1", 1, [
    { url: "https://cdn.discordapp.com/attachments/1/2/3/i.png", name: "i.png", size: 10, contentType: "image/png" },
  ]);
  assert.equal(est.estimateTokens("", 10), 1200, "200 text tokens + 1000 image tokens");
  ok("compaction store: seed merges chronologically (tracked ids win), token estimate");

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
    compaction: { maxTokens: 20, keepMessages: 3, summarize },
  };
  const cres = await buildChannelContext(noFetch, cstore, new ChannelHistory(20), "m1", cOpts);
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
  const cres2 = await buildChannelContext(noFetch, cstore, new ChannelHistory(20), "m2", cOpts);
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
  assert.equal(await buildChannelContext(noFetch, dstore, new ChannelHistory(20), "gone", cOpts), null);
  ok("compaction: mention deleted before its turn -> null");

  // Summarizer failure (or nothing to fold): the emergency trim drops the
  // oldest messages until the estimate fits, and the mention survives.
  const fstore = new ChannelContext();
  for (let i = 0; i < 6; i++) fstore.pushUser("U", "x".repeat(200), `f${String(i)}`, i, []);
  fstore.pushUser("Alice", "the mention", "fm", 99, []);
  const fOpts = {
    ...cOpts,
    compaction: {
      maxTokens: 50,
      keepMessages: 2,
      summarize: async (): Promise<string> => {
        throw new Error("llm down");
      },
    },
  };
  const fres = await buildChannelContext(noFetch, fstore, new ChannelHistory(20), "fm", fOpts);
  assert.ok(fres !== null, "the turn still runs");
  assert.ok(fstore.has("fm"), "the mention survived the trim");
  assert.ok(!fstore.has("f0"), "the oldest message was trimmed");
  assert.equal(fstore.getSummary(), null, "no summary when the summarizer failed");
  assert.ok(fres!.some((msg) => msg.content === "Alice: the mention"));
  // Nothing older than the keep window to fold: the trim applies directly.
  const tstore = new ChannelContext();
  tstore.pushUser("A", "a".repeat(400), "t1", 1, []);
  tstore.pushUser("B", "b".repeat(400), "t2", 2, []);
  const tOpts = { ...cOpts, compaction: { maxTokens: 150, keepMessages: 5, summarize: async () => "s" } };
  await buildChannelContext(noFetch, tstore, new ChannelHistory(20), "t2", tOpts);
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
  const sres = await contextToMessages(sstore, { systemPrompt: "", maxMessages: 10, enableImages: false, imagesMaxBytes: 1024 });
  assert.deepEqual(sres, [
    { role: "user", content: "Summary of the earlier messages in this channel (older messages were compacted):\nthe summary" },
    { role: "user", content: "B: y" },
  ]);
  ok("compaction: image window notes, recent image parts, summary rendered first");

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
    compaction: { maxTokens: 10_000, keepMessages: 5, summarize: async () => "never" },
  };
  assert.deepEqual(await buildChannelContext(noFetch, kstore, new ChannelHistory(20), "k3", kOpts), [
    { role: "user", content: "Alice: fresh start" },
  ]);
  // A mention queued before the clear: its message left the context, the
  // turn is skipped (no fetch attempted either — the mention check comes first).
  const kcleared = new ChannelContext();
  kcleared.pushUser("Alice", "queued before the clear", "km", 150, []);
  kcleared.reset();
  assert.equal(await buildChannelContext(noFetch, kcleared, new ChannelHistory(20), "km", kOpts), null, "pre-clear mention -> null");
  ok("compaction: reset() drops entries + summary, suppresses the seed (pre-clear mention -> null)");
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

  // discard(): a tool-call round's streamed preview is deleted, and the
  // next round streams a fresh live message
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

// -------------------------------------------------------------- tools --
{
  // The system note advertises exactly the enabled families: the model
  // must never claim a tool that is not registered (the note used to be
  // static, listing all three families even when only one was enabled).
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
  assert.ok(zimOnly.systemNote?.includes("Summarize tool results"), "the common rule stays");
  const { config: allCfg, errors: allErrs } = parseConfig({
    ...base,
    WEBTOOLS_ENABLED: "true",
    FILETOOLS_ENABLED: "true",
    ZIMTOOLS_ENABLED: "true",
    ZIM_FILE: "/tmp/wiki.zim",
  });
  assert.deepEqual(allErrs, []);
  const all = buildTools(allCfg);
  assert.equal(all.registry.size, 10);
  for (const name of [
    "web_search",
    "web_fetch",
    "file_list",
    "file_read",
    "file_write",
    "file_edit",
    "file_delete",
    "file_search",
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
