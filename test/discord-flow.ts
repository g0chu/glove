/** Exercise the real entrypoint and event handlers without Discord or real sleeps. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client, ChannelType, Collection, type Message, type GuildTextBasedChannel } from "discord.js";
import { InterruptedError, LlmClient, type ChatMessage, type ChatResult } from "../src/llm/client.js";
import { CHIME_SYSTEM_PROMPT } from "../src/bot/chime.js";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function ticks(): Promise<void> { for (let i = 0; i < 30; i++) await tick(); }
let now = 1_800_000_000_000;
Date.now = () => now;
type Timer = { at: number; fn: () => void; unref(): Timer };
const timers = new Set<Timer>();
globalThis.setTimeout = ((fn: () => void, ms = 0) => {
  const timer: Timer = { at: now + ms, fn, unref() { return this; } };
  timers.add(timer);
  return timer;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((timer: Timer) => { timers.delete(timer); }) as unknown as typeof clearTimeout;
async function advance(ms: number): Promise<void> {
  const end = now + ms;
  for (;;) {
    const timer = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!timer) break;
    now = timer.at;
    timers.delete(timer);
    timer.fn();
    await ticks();
  }
  now = end;
  await ticks();
}

let client!: Client;
Client.prototype.login = async function (): Promise<string> {
  client = this;
  this.user = { id: "bot", username: "Glove", tag: "Glove" } as Client["user"];
  return "fake-token";
};
Client.prototype.destroy = async function (): Promise<void> {};
const requests: ChatMessage[][] = [];
let duringChat: ((signal?: AbortSignal) => Promise<ChatResult>) | undefined;
let chimeRespond = false;
LlmClient.prototype.chat = async function (messages, _callbacks, _tools, signal, options): Promise<ChatResult> {
  requests.push(structuredClone(messages));
  if (signal?.aborted) throw new InterruptedError();
  const hook = duringChat;
  duringChat = undefined;
  if (hook) return hook(signal);
  if (messages.at(-1)?.role === "system" && messages.at(-1)?.content === CHIME_SYSTEM_PROMPT) {
    assert.equal(options?.maxTokens, undefined, "chime decisions use the endpoint output limit");
    return { content: "", toolCalls: [{ id: `decision-${requests.length}`, name: "chime",
      arguments: JSON.stringify({ respond: chimeRespond, reason: "conversation settled" }) }] };
  }
  return { content: `answer ${requests.length}`, toolCalls: [] };
};

type FakeMessage = Message & { content: string };
const history = new Map<string, FakeMessage>();
let postedId = 0;
let pageHook: (() => Promise<void>) | undefined;
let oneHook: (() => Promise<void>) | undefined;
const channel = {
  id: "channel", name: "general", guildId: "guild", guild: { id: "guild", name: "Test Server" }, type: ChannelType.GuildText,
  isTextBased: () => true,
  sendTyping: async () => {},
  messages: {
    fetch: async (options: { message?: string; before?: string; limit?: number }) => {
      const hook = options.message ? oneHook : pageHook;
      if (options.message) oneHook = undefined; else pageHook = undefined;
      // Take the REST snapshot before allowing gateway activity to race it.
      const items = [...history.values()].filter((m) => !options.before || BigInt(m.id) < BigInt(options.before))
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, options.limit ?? 100);
      const single = options.message ? history.get(options.message) : undefined;
      await hook?.();
      if (options.message) {
        if (!single) throw Object.assign(new Error("unknown message"), { code: 10008 });
        return single;
      }
      return new Collection(items.map((m) => [m.id, m]));
    },
  },
  send: async ({ content }: { content: string }) => {
    postedId = Math.max(postedId, ...[...history.keys()].map(Number)) + 1;
    const message = makeMessage(String(postedId), content, "bot");
    history.set(message.id, message);
    client.emit("messageCreate", message);
    return message;
  },
} as unknown as GuildTextBasedChannel;

function makeMessage(id: string, content: string, authorId = "human"): FakeMessage {
  const message = {
    id, content, channel, channelId: channel.id, guildId: "guild", guild: { id: "guild" },
    author: { id: authorId, username: authorId, bot: authorId !== "human" },
    createdTimestamp: now, editedTimestamp: null, partial: false,
    attachments: new Collection(), reactions: { cache: new Collection() },
    mentions: { has: (id: string) => message.content.includes(`<@${id}>`), users: new Collection(), members: new Collection() },
    toJSON: () => ({ id, content: message.content, author: message.author, createdTimestamp: message.createdTimestamp }),
    edit: async ({ content }: { content: string }) => {
      const previous = { ...message };
      message.content = content;
      client.emit("messageUpdate", previous as unknown as Message, message as unknown as Message);
      return message;
    },
    delete: async () => { history.delete(id); client.emit("messageDelete", message as unknown as Message); },
  };
  return message as unknown as FakeMessage;
}
function create(id: string, content: string, authorId = "human"): FakeMessage {
  const message = makeMessage(id, content, authorId);
  history.set(id, message);
  client.emit("messageCreate", message);
  return message;
}
function edit(message: FakeMessage, content: string): FakeMessage {
  const updated = { ...message, content, editedTimestamp: now } as FakeMessage;
  history.set(message.id, updated);
  client.emit("messageUpdate", message, updated);
  return updated;
}
const prompt = (): string => JSON.stringify(requests.at(-1));
function entries(): Array<{ content: string; ids: string[] }> {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "chats.json"), "utf8")).channels.channel.entries;
}

async function run(): Promise<void> {
  let release!: () => void;
  await import("../src/index.js");
  await ticks();
  assert(client);
  client.channels.cache.set(channel.id, channel);
  if (process.env.FLOW_MODE === "restart") {
    now += 100_000;
    for (const entry of entries()) {
      for (const id of entry.ids) {
        const message = makeMessage(id, entry.content, "answer" === entry.content.slice(0, 6) ||
          entry.content === "uninterrupted reply" ? "bot" : entry.content === "!clear" ? "other-bot" : "human");
        history.set(id, message);
      }
    }
    // A restart must not import pre-clear history or old UI lines.
    const old = makeMessage("100", "pre-clear retired history");
    old.createdTimestamp = 1_800_000_000_000;
    history.set(old.id, old);
    history.set("2202", makeMessage("2202", "🤔 *old UI line*", "bot"));
    for (let id = 2400; id <= 2520; id++) history.set(String(id), makeMessage(String(id), `offline gap ${id}`));
    client.emit("clientReady", client as never);
    await ticks();
    create("2600", "<@bot> check restart history");
    await advance(200);
    assert.equal(requests.length, 1);
    for (let id = 2400; id <= 2520; id++) assert(prompt().includes(`offline gap ${id}`));
    assert(prompt().includes("uninterrupted reply"), "the persisted model reply survives catch-up");
    assert(!prompt().includes("pre-clear retired history"));
    assert(!prompt().includes("old UI line"));

    // A deleted channel cannot be restored by an in-flight REST response.
    pageHook = () => new Promise<void>((resolve) => { release = resolve; });
    create("2700", "<@bot> channel disappears during refresh");
    await advance(200);
    client.emit("channelDelete", channel);
    release();
    await ticks();
    await advance(200);
    assert.equal(requests.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(process.cwd(), "chats.json"), "utf8"));
    assert.equal(saved.channels.channel, undefined);
    process.emit("SIGTERM");
    return;
  }
  if (process.env.FLOW_MODE === "chime") {
    create("100", "first ambient message");
    await advance(100);
    create("200", "newest ambient message", "other-bot");
    await advance(100);
    client.emit("typingStart", { channel, user: { id: "human" } } as never);
    await advance(9999);
    assert.equal(requests.length, 0);
    await advance(1);
    assert.equal(requests.length, 1, "only the newest ambient trigger decides after stillness");
    assert(prompt().includes("first ambient message"));
    assert.equal(requests[0][0].role, "system");
    assert(String(requests[0][1].content).includes('channels["channel"]'));
    assert(String(requests[0][1].content).includes('"name":"general"'));
    assert(String(requests[0][1].content).includes('"guildName":"Test Server"'));
    const savedChannel = JSON.parse(fs.readFileSync(path.join(process.cwd(), "chats.json"), "utf8")).channels.channel.channel;
    assert.deepEqual(savedChannel, { id: "channel", name: "general", guildId: "guild", guildName: "Test Server" });
    assert(prompt().includes("other-bot (bot): newest ambient message"));
    assert(entries().some((e) => e.content.includes("conversation settled")), "completed NO exchange is retained");
    assert(!entries().some((e) => e.content.startsWith("🔕")), "NO delivery is UI only");
    create("250", "<@bot> answer after NO");
    await advance(200);
    assert.equal(requests.length, 2, "a mention after NO bypasses the decision gate");
    const noMention = requests.at(-1)!;
    assert(noMention.some((m) => typeof m.content === "string" && m.content.includes("Stay silent for this message")));
    assert.equal(noMention.at(-1)?.role, "system");
    assert(String(noMention.at(-1)?.content).includes("reply phase for Discord message 250"));
    assert(String(noMention.at(-1)?.content).includes("directly mentions the bot and requires a reply"));
    assert(String(noMention.at(-1)?.content).includes("apply only to their earlier decision phases and messages"));
    const triggerIndex = Number(String(noMention.at(-1)?.content).match(/message index (\d+)/)![1]);
    assert(String(noMention[triggerIndex].content).includes("@Glove answer after NO"));
    assert(!entries().some((e) => e.content.startsWith("This request is in the reply phase")), "reply instruction is transient");
    duringChat = async (signal) => {
      const ambient = history.get("200")!;
      edit(ambient, "edited during chime decision");
      assert(signal?.aborted);
      throw new InterruptedError();
    };
    chimeRespond = true;
    create("300", "another ambient trigger");
    await advance(200);
    assert.equal(requests.length, 3, "the interrupted decision produces no reply");
    await advance(200);
    assert.equal(requests.length, 5, "a fresh YES decision runs one reply");
    assert(prompt().includes("edited during chime decision"));
    assert(!prompt().includes("🔕"));
    create("400", "<@bot> mention always answers");
    await advance(200);
    assert.equal(requests.length, 6, "mentions bypass the chime decision");
    assert(!prompt().includes("🔕"));
    duringChat = async () => {
      // Accept YES, then interrupt its reply with a newer direct mention.
      duringChat = async (signal) => {
        create("600", "<@bot> answer after interrupted YES");
        assert(signal?.aborted);
        throw new InterruptedError();
      };
      return { content: "", toolCalls: [{ id: "interrupted-yes", name: "chime", arguments: '{"respond":true,"reason":"reply warranted"}' }] };
    };
    create("500", "ambient before interrupted YES");
    await advance(200);
    assert.equal(requests.length, 8, "YES enters reply before being interrupted");
    assert(String(requests.at(-1)?.at(-1)?.content).includes("reply phase for Discord message 500"));
    await advance(200);
    assert.equal(requests.length, 9, "newer mention supersedes interrupted chime without a decision call");
    const afterYes = requests.at(-1)!;
    assert(afterYes.some((m) => m.toolCalls?.some((call) => call.id === "interrupted-yes")), "completed YES stays in history");
    assert(String(afterYes.at(-1)?.content).includes("reply phase for Discord message 600"));
    assert(String(afterYes.at(-1)?.content).includes("directly mentions the bot and requires a reply"));
    assert(!entries().some((e) => e.content.startsWith("This request is in the reply phase")));
    duringChat = async () => {
      duringChat = async (signal) => {
        client.emit("typingStart", { channel, user: { id: "human" } } as never);
        assert(signal?.aborted);
        throw new InterruptedError();
      };
      return { content: "", toolCalls: [{ id: "retry-yes", name: "chime", arguments: '{"respond":true,"reason":"continue"}' }] };
    };
    create("700", "ambient reply interrupted by typing");
    await advance(200);
    assert.equal(requests.length, 11);
    await advance(9999);
    assert.equal(requests.length, 11, "no retry while the typing indicator is active");
    await advance(1);
    assert.equal(requests.length, 13, "typing interruption retries the YES turn over retained history");
    const retriedYes = requests.at(-1)!;
    assert(retriedYes.some((m) => m.toolCalls?.some((call) => call.id === "retry-yes")));
    assert(String(retriedYes.at(-1)?.content).includes("reply phase for Discord message 700"));
    assert(String(retriedYes.at(-1)?.content).includes("chime decision for this message is complete and allows a reply"));
    assert.equal(retriedYes.filter((m) => String(m.content).startsWith("This request is in the reply phase")).length, 1,
      "retry gets one fresh instruction, without accumulating earlier attempt instructions");
    assert(!entries().some((e) => e.content.startsWith("This request is in the reply phase")));
    process.emit("SIGTERM");
    return;
  }

  // A newer stable mention waits behind a continuously edited bot message.
  let streamed = create("100", "unfinished", "other-bot");
  await advance(50);
  create("200", "<@bot> explain the result");
  await advance(50);
  streamed = edit(streamed, "still unfinished");
  await advance(100);
  assert.equal(requests.length, 0, "no model call before earlier pending text stabilizes");
  streamed = edit(streamed, "final streamed result");
  await advance(199);
  assert.equal(requests.length, 0);
  await advance(1);
  assert.equal(requests.length, 1);
  assert(prompt().includes("other-bot (bot): final streamed result"));
  assert(!prompt().includes("unfinished"));

  // A deletion while pending contributes neither context nor a turn.
  const deleted = create("300", "<@bot> deleted pending trigger");
  await deleted.delete();
  await advance(200);
  assert.equal(requests.length, 1);
  assert(!entries().some((e) => e.ids.includes("300")));

  // Gateway activity invalidates a REST snapshot before it can overwrite edits.
  pageHook = async () => { streamed = edit(streamed, "newer gateway result"); };
  create("400", "<@bot> check fresh data");
  await advance(200);
  assert.equal(requests.length, 1, "activity during REST prevents generation");
  await advance(200);
  assert.equal(requests.length, 2);
  assert(prompt().includes("newer gateway result"));
  assert(!prompt().includes("final streamed result"));

  // An edit during generation aborts the attempt; its retry sees updated history.
  duringChat = async (signal) => {
    streamed = edit(streamed, "edited during generation");
    assert(signal?.aborted);
    throw new InterruptedError();
  };
  create("500", "<@bot> wait for the edit");
  await advance(200);
  assert.equal(requests.length, 3);
  await advance(200);
  assert.equal(requests.length, 4);
  assert(prompt().includes("edited during generation"));
  assert(!entries().some((e) => e.content === "answer 3"));

  // A partial update holds the earlier gate until complete REST data returns.
  oneHook = () => new Promise<void>((resolve) => { release = resolve; });
  const pending = create("600", "partial placeholder", "other-bot");
  const complete = { ...pending, content: "complete fetched message", editedTimestamp: now } as FakeMessage;
  history.set("600", complete);
  const partial = { ...pending, partial: true, author: null } as unknown as Message;
  client.emit("messageUpdate", pending, partial);
  await ticks();
  create("700", "<@bot> use the complete message");
  await advance(200);
  assert.equal(requests.length, 4, "a held older update prevents a newer mention from starting");
  release();
  await ticks();
  await advance(199);
  assert.equal(requests.length, 4);
  await advance(1);
  assert.equal(requests.length, 5);
  assert(prompt().includes("complete fetched message"));
  assert(!prompt().includes("partial placeholder"));

  // Stable human clear resets history and survives the persisted checkpoint.
  create("800", "<@bot> !clear");
  await advance(200);
  assert.deepEqual(entries(), []);
  assert.equal(requests.length, 5);
  await advance(1);
  create("900", "<@bot> fresh conversation");
  await advance(200);
  assert.equal(requests.length, 6);
  assert(prompt().includes("fresh conversation"));
  assert(!prompt().includes("complete fetched message"));
  assert(!prompt().includes("chime: no"));

  // Reaction REST snapshots must correct a pending message after a missed edit.
  const reactionPending = create("1000", "stale reaction placeholder", "other-bot");
  await advance(100);
  const reactionFresh = { ...reactionPending, content: "final text recovered by reaction", editedTimestamp: now } as FakeMessage;
  history.set(reactionFresh.id, reactionFresh);
  client.emit("messageReactionRemoveAll", reactionPending);
  await ticks();
  create("1100", "<@bot> read the reaction message");
  await advance(100);
  assert.equal(requests.length, 6, "reaction observation restarts stability for changed pending text");
  await advance(100);
  assert.equal(requests.length, 7);
  assert(prompt().includes("final text recovered by reaction"));
  assert(!prompt().includes("stale reaction placeholder"));

  // REST finds committed edits and deletes even when gateway events were missed.
  history.set("1000", { ...reactionFresh, content: "edit recovered by pre-turn REST", editedTimestamp: now } as FakeMessage);
  history.delete("900");
  create("1200", "<@bot> reconcile missed events");
  await advance(200);
  assert.equal(requests.length, 7, "changed REST history requires a fresh quiet attempt");
  await advance(200);
  assert.equal(requests.length, 8);
  assert(prompt().includes("edit recovered by pre-turn REST"));
  assert(!prompt().includes("fresh conversation"));

  // A deleted message cannot be restored by its delayed partial-update fetch.
  oneHook = () => new Promise<void>((resolve) => { release = resolve; });
  const doomed = create("1300", "<@bot> removed during partial fetch");
  client.emit("messageUpdate", doomed, { ...doomed, partial: true, author: null } as unknown as Message);
  await ticks();
  await doomed.delete();
  release();
  await ticks();
  await advance(200);
  assert.equal(requests.length, 8);
  assert(!entries().some((e) => e.ids.includes(doomed.id)));

  // Typing extends the quiet window; a newer mention covers the older one once.
  create("1400", "<@bot> older queued question");
  await advance(100);
  create("1500", "<@bot> newest queued question");
  await advance(100);
  client.emit("typingStart", { channel, user: { id: "human" } } as never);
  await advance(9999);
  assert.equal(requests.length, 8);
  await advance(1);
  assert.equal(requests.length, 9, "a burst of mentions produces one answer over the full prompt");
  assert(prompt().includes("older queued question"));
  assert(prompt().includes("newest queued question"));

  // Other bots cannot clear history; own activity cannot cancel a model call.
  create("1600", "!clear", "other-bot");
  duringChat = async (signal) => {
    await channel.send({ content: "🤔 *own activity*" });
    assert.equal(signal?.aborted, false);
    return { content: "uninterrupted reply", toolCalls: [] };
  };
  create("1700", "<@bot> keep the bot clear as text");
  await advance(200);
  assert.equal(requests.length, 10);
  assert(prompt().includes("other-bot (bot): !clear"));
  assert(prompt().includes("newest queued question"));
  assert(entries().some((e) => e.content === "uninterrupted reply"));

  // More than a page of missed gateway arrivals must be stabilized before answering.
  for (let id = 1800; id <= 1920; id++) history.set(String(id), makeMessage(String(id), `online missed gap ${id}`));
  create("2000", "<@bot> include the whole missed gap");
  await advance(200);
  assert.equal(requests.length, 10, "discovered arrivals must pass the stability gate before generation");
  await advance(200);
  assert.equal(requests.length, 11);
  for (let id = 1800; id <= 1920; id++) assert(prompt().includes(`online missed gap ${id}`));

  // A REST permission failure cannot cause an answer from incomplete history.
  pageHook = async () => { throw Object.assign(new Error("forbidden snapshot"), { code: 50013 }); };
  create("2100", "<@bot> failed refresh");
  await advance(200);
  assert.equal(requests.length, 11);
  create("2200", "<@bot> refresh restored");
  await advance(200);
  assert.equal(requests.length, 12);
  assert(prompt().includes("refresh restored"));

  process.emit("SIGTERM");
}

void run().catch((error) => { console.error(error); process.exit(1); });
