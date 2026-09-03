import type { GuildTextBasedChannel, Message } from "discord.js";
import type { ChatMessage, ContentPart } from "../llm/client.js";
import { BOT_REPLY_GROUP_GAP_MS, type ChannelContext, type SeedEntry } from "../llm/context.js";
import { ChannelHistory, speakerLabel, toRequestMessages } from "../llm/history.js";
import { errMsg, log } from "../log.js";
import { fetchMessageFiles, type FileFetch } from "./files.js";
import {
  fetchMessageImages,
  isImageAttachment,
  type AttachmentImage,
  type ImageFetch,
  type MessageAttachmentLike,
} from "./images.js";
import { stripMentionText } from "./router.js";

/** Discord's hard cap on `messages.fetch` `limit`. */
const DISCORD_FETCH_LIMIT = 100;

/** A channel message as the context builder sees it (discord.js messages are adapted into it). */
export interface MessageLike {
  id: string;
  content: string;
  /** The display name is the guild nickname when set, else the global username. */
  author: { id: string; bot: boolean; name: string };
  /** A Collection (discord.js) or a plain array — both expose `.values()`. */
  attachments: { values(): Iterable<MessageAttachmentLike> };
  /** The Discord createdTimestamp (the startup seed merges by it). */
  createdTimestamp: number;
}

/**
 * A discord.js message as the context builder sees it. The display name is
 * the guild nickname when set, else the global username; webhook messages
 * have no member, so their webhook name is used.
 */
function toMessageLike(m: Message): MessageLike {
  return {
    id: m.id,
    content: m.content,
    author: { id: m.author.id, bot: m.author.bot, name: m.member?.displayName ?? m.author.username },
    attachments: m.attachments,
    createdTimestamp: m.createdTimestamp,
  };
}

/** One compaction (summarization) attempt's settings and summarizer. */
export interface CompactionOptions {
  /** Estimated tokens (see llm/context.ts) at which the context compacts. */
  maxTokens: number;
  /** How many of the newest messages survive a compaction verbatim. */
  keepMessages: number;
  /** One plain (tool-less) chat call over the old transcript (production: the same model endpoint). */
  summarize: (messages: ChatMessage[]) => Promise<string>;
}

export interface ContextOptions {
  /** The bot's own user id (its non-reply lines are never context). */
  botId: string;
  systemPrompt: string;
  /**
   * The channel's last N Discord messages: the startup seed size in
   * compaction mode, the sliding window in classic mode, and (both modes)
   * the window of messages whose image attachments are actually downloaded.
   */
  maxMessages: number;
  enableImages: boolean;
  imagesMaxBytes: number;
  /** Test-only: inject the image fetch (production uses the native one). */
  imageFetch?: ImageFetch;
  /** When true, the text content of non-image attachments is inlined into the context. */
  enableFileContents: boolean;
  /** Max bytes per downloaded file attachment (bigger ones are skipped). */
  fileContentsMaxBytes: number;
  /** Test-only: inject the file fetch (production uses the native one). */
  fileFetch?: FileFetch;
  /** Set = compaction mode (persistent per-channel context); unset = the classic live fetch. */
  compaction?: CompactionOptions;
  /**
   * Classic mode (`!clear` boundary): only messages strictly after this
   * Discord message id enter the context. When the id is not among the
   * fetched messages, the clear fell out of the last-N window and nothing
   * is dropped.
   */
  resetAfter?: string | null;
}

/**
 * One conversation entry: exactly one Discord message (or one bot reply).
 * Inlined file-content blocks (when file contents are enabled) are folded
 * into `text` at construction time — the entry's text is the whole body the
 * model sees.
 */
interface ContextEntry {
  role: "user" | "assistant";
  text: string;
  images: AttachmentImage[];
}

/**
 * The bot's own UI lines — the tool-activity message (one per turn, edited
 * in place as calls arrive: its first line is "🔎 *…*", "📁 *…*", "📚 *…*",
 * "🔧 *…*" or the "🔧 *… N earlier calls …*" header) and the thinking line
 * ("🤔 *thought for Ns*") — are posted for humans, not part of the
 * conversation: they never enter the model context.
 */
const BOT_UI_RE = /^(?:🤔|🔎|📁|🔧|📚|🧹) \*/;

/**
 * Build the `messages` array for a turn.
 *
 * Compaction mode (opts.compaction set): the per-channel persistent context
 * is the source of truth. It is seeded once with the channel's last
 * `maxMessages` Discord messages (fetched live, so it survives bot restarts
 * and includes every author, not just the ones seen since the start), then
 * only grows as messages arrive. When its estimated size passes
 * `compaction.maxTokens`, the older part is replaced by a model-written
 * summary and the newest `compaction.keepMessages` messages stay verbatim.
 * Returns null when the mention is no longer in the context (deleted while
 * queued): the turn should be skipped.
 *
 * Classic mode (opts.compaction unset): the channel's last `maxMessages`
 * Discord messages, fetched live each turn. Mapping (chronological order;
 * every Discord message is its own request message — except our own
 * unrecorded replies, whose chunks are grouped back into one entry — so
 * the model sees the chat as it actually went):
 *  - our recorded replies (in the channel history) appear once with their
 *    canonical text, no matter how many Discord messages back them;
 *  - our unrecorded replies (posted before a restart) appear once as well:
 *    consecutive own messages posted close together (<= 5 s) are the chunks
 *    of one chunked reply and are joined into a single assistant entry;
 *  - our other posted lines (tool activity, thinking) are skipped;
 *  - everything else (humans, other bots, webhooks — including the mention
 *    itself) is a user message built from the fetched message (so its
 *    attachments are seen), with bot mentions stripped and prefixed by the
 *    author's display name (`Name: …`, `Name (bot): …` for other bots; an
 *    image-only message is just `Name:`) so the model can tell who said
 *    what; the bot's own replies are unlabeled — the assistant role is the
 *    identity;
 *  - image attachments (png/jpeg/webp/gif) become image_url parts when
 *    images are enabled; a skipped image leaves a one-line note (when file
 *    contents are enabled, non-image attachments belong to the file
 *    pipeline and are not noted here);
 *  - non-image attachments are downloaded and inlined as labeled, fenced
 *    blocks when file contents are enabled (a skipped attachment leaves a
 *    one-line note);
 *  - messages that carry no text, no images, and no file blocks are dropped;
 *  - a `resetAfter` boundary (the `!clear` command's message id) drops
 *    every message up to and including it; when the boundary is not among
 *    the fetched messages, the clear fell out of the last-N window and
 *    nothing is dropped;
 *  - the system prompt (when non-empty) comes first.
 *
 * Returns null in classic mode when the mention is no longer among the
 * channel's last `maxMessages` messages (deleted, pushed out while queued,
 * or before the `!clear` boundary). When the fetch itself fails (or the
 * window is bigger than Discord's fetch cap), the in-memory window is used
 * instead so the bot keeps working when the API is flaky.
 */
export async function buildChannelContext(
  channel: GuildTextBasedChannel,
  context: ChannelContext,
  history: ChannelHistory,
  mentionId: string,
  opts: ContextOptions,
): Promise<ChatMessage[] | null> {
  if (opts.compaction) return buildCompactedContext(channel, context, mentionId, opts);
  let fetched: MessageLike[] | null = null;
  if (opts.maxMessages <= DISCORD_FETCH_LIMIT) {
    try {
      const col = await channel.messages.fetch({ limit: opts.maxMessages });
      fetched = [...col.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(toMessageLike);
    } catch (err) {
      log.warn(
        `could not fetch the channel's last ${opts.maxMessages} messages (${errMsg(err)}); using the in-memory window`,
      );
    }
  }
  if (fetched === null) return toRequestMessages(history, opts.systemPrompt);
  return contextFromMessages(fetched, history, mentionId, opts);
}

/**
 * Compaction mode: seed the persistent context once (live fetch), compact
 * it when the estimated request size passes the budget, then render it.
 */
async function buildCompactedContext(
  channel: GuildTextBasedChannel,
  context: ChannelContext,
  mentionId: string,
  opts: ContextOptions,
): Promise<ChatMessage[] | null> {
  const c = opts.compaction!;
  if (!context.has(mentionId)) return null; // deleted before its turn ran
  if (!context.seeded) {
    const seed = await seedMessages(channel, opts.maxMessages);
    if (seed !== null) {
      context.seedFrom(seed.map((m) => toSeedEntry(m, opts.botId)).filter((e): e is SeedEntry => e !== null));
    }
    // fetch failed: the context keeps working from what arrived, and the
    // seed is retried on the next turn
  }
  // File contents add a per-attachment cost to the estimate (their size,
  // capped at the download limit); undefined = the feature is off.
  const fileCost = opts.enableFileContents ? opts.fileContentsMaxBytes : undefined;
  if (context.estimateTokens(opts.systemPrompt, opts.maxMessages, fileCost) > c.maxTokens) {
    const res = await context.compact(c.keepMessages, c.summarize, mentionId);
    if (res.ok) {
      log.info(
        `channel context filled the budget (~${c.maxTokens} est. tokens); compacted to a summary + ${context.length} recent message(s)`,
      );
    } else {
      log.warn(
        `context compaction did not apply (${res.reason}); trimming the oldest messages to fit the budget`,
      );
      context.emergencyTrim(mentionId, c.maxTokens, opts.systemPrompt, opts.maxMessages, fileCost);
    }
  }
  return contextToMessages(context, opts);
}

/** The channel's last N messages in chronological order, or null (failure / over the fetch cap). */
async function seedMessages(channel: GuildTextBasedChannel, limit: number): Promise<MessageLike[] | null> {
  if (limit > DISCORD_FETCH_LIMIT) return null;
  try {
    const col = await channel.messages.fetch({ limit });
    return [...col.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(toMessageLike);
  } catch (err) {
    log.warn(`could not seed the channel context from its last ${limit} messages (${errMsg(err)}); retrying next turn`);
    return null;
  }
}

/** A fetched message as a seed entry (our UI lines — tool activity, thinking — are never context). */
function toSeedEntry(m: MessageLike, botId: string): SeedEntry | null {
  if (m.author.id === botId && BOT_UI_RE.test(m.content)) return null;
  const entry: SeedEntry = {
    id: m.id,
    ts: m.createdTimestamp,
    role: m.author.id === botId ? "assistant" : "user",
    content: stripMentionText(m.content, botId),
    attachments: [...m.attachments.values()],
  };
  if (m.author.id !== botId) {
    entry.name = m.author.name;
    entry.bot = m.author.bot;
  }
  return entry;
}

/**
 * Render a persistent channel context into the request `messages` array:
 * the system prompt (when non-empty), the compaction summary (as a user
 * message — the role is the safest across llama.cpp chat templates), then
 * every entry in order. User entries are prefixed by the author's display
 * name (`Name: …`, `Name (bot): …` for other bots); assistant entries are
 * unlabeled — the role is the identity. Image attachments of the newest
 * `maxMessages` entries become image_url parts (a skipped attachment leaves
 * a one-line note); older image attachments leave a note instead of being
 * re-downloaded every turn. Non-image attachments of those entries are
 * downloaded and inlined as labeled, fenced blocks when file contents are
 * enabled (older ones leave a note instead). Entries that carry no text,
 * no images, and no file blocks are dropped.
 */
export async function contextToMessages(
  context: ChannelContext,
  opts: Pick<
    ContextOptions,
    "systemPrompt" | "maxMessages" | "enableImages" | "imagesMaxBytes" | "imageFetch" | "enableFileContents" | "fileContentsMaxBytes" | "fileFetch"
  >,
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  if (opts.systemPrompt.trim().length > 0) out.push({ role: "system", content: opts.systemPrompt });
  const summary = context.getSummary();
  if (summary && summary.trim().length > 0) {
    out.push({
      role: "user",
      content: `Summary of the earlier messages in this channel (older messages were compacted):\n${summary.trim()}`,
    });
  }
  const entries = context.snapshot();
  const imageWindowStart = entries.length - opts.maxMessages;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const images: AttachmentImage[] = [];
    const files: string[] = [];
    const notes: string[] = [];
    if (opts.enableImages) {
      if (i >= imageWindowStart) {
        const res = await fetchMessageImages(e.attachments, opts.imagesMaxBytes, {
          fetchImpl: opts.imageFetch,
          // With file contents on, non-image attachments are the file
          // pipeline's job (no "unsupported type" notes for them).
          skipNonImages: opts.enableFileContents,
        });
        images.push(...res.images);
        notes.push(...res.notes);
      } else {
        // Outside the image window: a note instead of re-downloading every turn.
        for (const att of e.attachments) {
          if (isImageAttachment(att)) {
            notes.push(`*[attachment "${att.name}" not sent: older than the image window]*`);
          }
        }
      }
    }
    if (opts.enableFileContents) {
      if (i >= imageWindowStart) {
        const res = await fetchMessageFiles(e.attachments, opts.fileContentsMaxBytes, {
          fetchImpl: opts.fileFetch,
        });
        files.push(...res.files.map((f) => f.text));
        notes.push(...res.notes);
      } else {
        // Outside the file window: a note instead of re-downloading every turn.
        for (const att of e.attachments) {
          if (!isImageAttachment(att)) {
            notes.push(`*[attachment "${att.name}" not sent: older than the file window]*`);
          }
        }
      }
    }
    const label = e.role === "user" && e.name ? speakerLabel(e.name, e.bot ?? false) : "";
    const text =
      e.content.length > 0
        ? label
          ? `${label}: ${e.content}`
          : e.content
        : label
          ? `${label}:`
          : "";
    const body = [text, ...files, ...notes].filter((s) => s.length > 0).join("\n");
    if (body.length === 0 && images.length === 0 && files.length === 0) continue; // carries nothing
    if (images.length === 0) {
      if (body.length > 0) out.push({ role: e.role, content: body });
    } else {
      const parts: ContentPart[] = [];
      if (body.length > 0) parts.push({ type: "text", text: body });
      for (const img of images) parts.push({ type: "image_url", image_url: { url: img.url } });
      out.push({ role: e.role, content: parts });
    }
  }
  return out;
}

/**
 * Map a chronological list of channel messages to the request `messages`
 * array — the pure core of buildChannelContext, driven with fakes in the
 * tests. Returns null when the mention is not among the messages (or is
 * before the `!clear` boundary).
 */
export async function contextFromMessages(
  fetched: MessageLike[],
  history: ChannelHistory,
  mentionId: string,
  opts: ContextOptions,
): Promise<ChatMessage[] | null> {
  // A `!clear` boundary: only messages strictly after the clear command's
  // own message enter the context. When the boundary id is not among the
  // fetched messages, the clear fell out of the last-N window and nothing
  // is dropped.
  let relevant = fetched;
  const boundary = opts.resetAfter;
  if (boundary) {
    let start = -1;
    for (let i = fetched.length - 1; i >= 0; i--) {
      if (fetched[i].id === boundary) {
        start = i + 1;
        break;
      }
    }
    if (start !== -1) relevant = fetched.slice(start);
  }
  if (!relevant.some((m) => m.id === mentionId)) return null;

  const entries: ContextEntry[] = [];
  const emitted = new Set<string>();
  let lastTs = 0; // the last message that could continue a reply group
  // A chunked reply from before a restart (no history entry) is several
  // consecutive own messages: group the close-together ones back into one
  // assistant entry (the live stores keep a chunked reply as one entry,
  // one id per chunk). The assistant role says who, so it is not labeled.
  let group: { texts: string[]; images: AttachmentImage[]; files: string[]; notes: string[] } | null = null;
  const flushGroup = (): void => {
    if (!group) return;
    const body = [group.texts.join("\n"), ...group.files, ...group.notes].filter((s) => s.length > 0).join("\n");
    if (body.length > 0 || group.images.length > 0) {
      entries.push({ role: "assistant", text: body, images: group.images });
    }
    group = null;
  };
  for (const m of relevant) {
    const entry = history.find(m.id);
    if (entry && entry.role === "assistant") {
      // A recorded bot reply: emit it once, with its canonical text, on
      // the first of its message ids (a chunked reply is one assistant
      // message). User entries are built from the fetched message instead,
      // so attachments (images) are seen.
      flushGroup();
      lastTs = m.createdTimestamp;
      if (entry.ids.some((id) => emitted.has(id))) continue;
      for (const id of entry.ids) emitted.add(id);
      entries.push({ role: "assistant", text: entry.content, images: [] });
      continue;
    }
    const own = m.author.id === opts.botId;
    if (own && BOT_UI_RE.test(m.content)) continue; // UI line, never context

    const text = stripMentionText(m.content, opts.botId);
    const images: AttachmentImage[] = [];
    const files: string[] = [];
    const notes: string[] = [];
    if (opts.enableImages) {
      const res = await fetchMessageImages(m.attachments.values(), opts.imagesMaxBytes, {
        fetchImpl: opts.imageFetch,
        // With file contents on, non-image attachments are the file
        // pipeline's job (no "unsupported type" notes for them).
        skipNonImages: opts.enableFileContents,
      });
      images.push(...res.images);
      notes.push(...res.notes);
    }
    if (opts.enableFileContents) {
      const res = await fetchMessageFiles(m.attachments.values(), opts.fileContentsMaxBytes, {
        fetchImpl: opts.fileFetch,
      });
      files.push(...res.files.map((f) => f.text));
      notes.push(...res.notes);
    }
    if (own) {
      if (text.length === 0 && images.length === 0 && files.length === 0) continue; // carries nothing
      if (group === null || m.createdTimestamp - lastTs > BOT_REPLY_GROUP_GAP_MS) flushGroup();
      group ??= { texts: [], images: [], files: [], notes: [] };
      group.texts.push(text);
      group.images.push(...images);
      group.files.push(...files);
      group.notes.push(...notes);
      lastTs = m.createdTimestamp;
      continue;
    }
    flushGroup();
    const body = [text, ...files, ...notes].filter((s) => s.length > 0).join("\n");
    if (body.length === 0 && images.length === 0) continue; // carries nothing
    // Who said what: prefix the author's display name (a "(bot)" marker for
    // other bots); an image-only message is just the label.
    const label = speakerLabel(m.author.name, m.author.bot);
    entries.push({ role: "user", text: body.length > 0 ? `${label}: ${body}` : `${label}:`, images });
    lastTs = m.createdTimestamp;
  }
  flushGroup();

  const out: ChatMessage[] = [];
  if (opts.systemPrompt.trim().length > 0) out.push({ role: "system", content: opts.systemPrompt });
  for (const e of entries) {
    if (e.images.length === 0) {
      if (e.text.length > 0) out.push({ role: e.role, content: e.text });
    } else {
      const parts: ContentPart[] = [];
      if (e.text.length > 0) parts.push({ type: "text", text: e.text });
      for (const img of e.images) parts.push({ type: "image_url", image_url: { url: img.url } });
      out.push({ role: e.role, content: parts });
    }
  }
  return out;
}
