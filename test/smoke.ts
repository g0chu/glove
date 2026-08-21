/**
 * Smoke tests: config parsing, history window, code-fence-aware chunk
 * splitting, queue semantics, response writer behavior, the tool executor
 * and tool loop, and the LLM client (stream + non-stream + tool calls +
 * errors) against a local mock OpenAI-compatible server. Run with: npm test
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { GuildTextBasedChannel } from "discord.js";
import { parseConfig } from "../src/config.js";
import { ChannelHistory, toRequestMessages } from "../src/llm/history.js";
import { LlmClient, type ChatMessage, type ChatResult } from "../src/llm/client.js";
import { ChannelQueue } from "../src/bot/queue.js";
import { ResponseWriter, splitForDiscord } from "../src/bot/writer.js";
import { ToolRegistry, executeToolCalls, parseToolArgs, argString, argOptionalString, argInt } from "../src/tools/executor.js";
import { runToolTurn } from "../src/tools/loop.js";

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
  ok("config: parses valid env and applies defaults");

  const { errors: badErrors } = parseConfig({
    DISCORD_TOKEN: "",
    DISCORD_GUILD_ID: "",
    MODEL_API_URL: "not a url",
    MODEL_TIMEOUT_S: "abc",
    MODEL_STREAM: "banana",
  });
  assert.ok(badErrors.length >= 4, `expected >= 4 errors, got ${badErrors.length}`);
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
    FILETOOLS_TIMEOUT_S: "5",
    TOOLS_MAX_ROUNDS: "7",
  });
  assert.deepEqual(te, []);
  assert.equal(tc.tools.web.enabled, true);
  assert.equal(tc.tools.web.timeoutMs, 12000);
  assert.equal(tc.tools.web.fetchMaxBytes, 2048);
  assert.equal(tc.tools.web.maxRedirects, 2);
  assert.equal(tc.tools.web.cacheTtlMs, 60000);
  assert.equal(tc.tools.web.cacheMaxEntries, 4);
  assert.equal(tc.tools.web.searchMaxResults, 3);
  assert.equal(tc.tools.file.enabled, true);
  assert.equal(tc.tools.file.baseUrl, "http://127.0.0.1:8378"); // default
  assert.equal(tc.tools.file.timeoutMs, 5000);
  assert.equal(tc.tools.maxRounds, 7);
  ok("config: tools section parses env and applies defaults");

  const { config: td } = parseConfig({
    DISCORD_TOKEN: "t",
    DISCORD_GUILD_ID: "g",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
  });
  assert.equal(td.tools.web.enabled, false, "web tools off by default");
  assert.equal(td.tools.file.enabled, false, "file tools off by default");
  assert.equal(td.tools.file.baseUrl, "http://127.0.0.1:8378");
  assert.equal(td.tools.web.searchMaxResults, 10); // default
  assert.equal(td.tools.maxRounds, 5);
  ok("config: tools disabled by default");

  const { errors: toolErrs } = parseConfig({
    DISCORD_TOKEN: "t",
    DISCORD_GUILD_ID: "g",
    MODEL_API_URL: "http://localhost:8080/v1/chat/completions",
    WEBTOOLS_FETCH_MAX_BYTES: "abc",
    TOOLS_MAX_ROUNDS: "0",
  });
  assert.ok(toolErrs.some((e) => e.includes("WEBTOOLS_FETCH_MAX_BYTES")), `got: ${toolErrs.join("; ")}`);
  assert.ok(toolErrs.some((e) => e.includes("TOOLS_MAX_ROUNDS")), `got: ${toolErrs.join("; ")}`);
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
        sent.push(content);
        return m;
      },
    };
    return { channel, sent, getLive: () => live };
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
  const messages: ChatMessage[] = [{ role: "user", content: "go" }];
  const out = await runToolTurn(messages, {
    chat: async (_msgs, _d, tools) => {
      specsSeen.push(tools);
      return script[i++];
    },
    registry,
    maxRounds: 3,
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
  ok("loop: tool round executed, results appended, final answer returned");

  // budget exhausted: the model keeps requesting tools
  let toolRoundSignals = 0;
  const out2 = await runToolTurn([{ role: "user", content: "go" }], {
    chat: async () => ({ content: "", toolCalls: [{ id: "t", name: "echo", arguments: "{}" }] }),
    registry,
    maxRounds: 2,
    onToolRound: () => toolRoundSignals++,
  });
  assert.equal(out2.exhausted, true);
  assert.equal(out2.toolRounds, 2);
  assert.equal(toolRoundSignals, 3, "onToolRound fires for every tool-call response, incl. the cutoff");
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
  const full = await streamClient.chat([{ role: "user", content: "hi" }], (d) => deltas.push(d));
  assert.equal(full.content, "Hello world");
  assert.deepEqual(full.toolCalls, []);
  assert.deepEqual(deltas, ["Hel", "lo ", "world"]);
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
