import type { GuildTextBasedChannel, Message } from "discord.js";
import type { ChatMessage, ContentPart } from "../llm/client.js";
import { ChannelHistory, speakerLabel, toRequestMessages } from "../llm/history.js";
import { errMsg, log } from "../log.js";
import {
  fetchMessageImages,
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
  };
}

export interface ContextOptions {
  /** The bot's own user id (its non-reply lines are never context). */
  botId: string;
  systemPrompt: string;
  /** The channel's last N Discord messages make up the context. */
  maxMessages: number;
  enableImages: boolean;
  imagesMaxBytes: number;
  /** Test-only: inject the image fetch (production uses the native one). */
  imageFetch?: ImageFetch;
}

/** One conversation entry: exactly one Discord message (or one bot reply). */
interface ContextEntry {
  role: "user" | "assistant";
  text: string;
  images: AttachmentImage[];
}

/**
 * The bot's own UI lines — tool activity ("🔎 *…*", "📁 *…*", "🔧 *…*")
 * and the thinking line ("🤔 *thought for Ns*") — are posted for humans,
 * not part of the conversation: they never enter the model context.
 */
const BOT_UI_RE = /^(?:🤔|🔎|📁|🔧) \*/;

/**
 * Build the `messages` array for a turn: the channel's last `maxMessages`
 * Discord messages, fetched live so the context is exactly what is in the
 * channel right now (it survives bot restarts and includes every author,
 * not just the ones the in-memory window happened to catch).
 *
 * Mapping (chronological order; every Discord message is its own request
 * message, never merged, so the model sees the chat as it actually went):
 *  - our recorded replies (in the channel history) appear once with their
 *    canonical text, no matter how many Discord messages back them;
 *  - our other posted lines (tool activity, thinking) are skipped;
 *  - everything else (humans, other bots, webhooks — including the mention
 *    itself) is a user message built from the fetched message (so its
 *    attachments are seen), with bot mentions stripped and prefixed by the
 *    author's display name (`Name: …`, `Name (bot): …` for other bots; an
 *    image-only message is just `Name:`) so the model can tell who said
 *    what; the bot's own replies are unlabeled — the assistant role is the
 *    identity;
 *  - image attachments (png/jpeg/webp/gif) become image_url parts when
 *    images are enabled; a skipped attachment leaves a one-line note;
 *  - messages that carry no text and no images are dropped;
 *  - the system prompt (when non-empty) comes first.
 *
 * Returns null when the mention is no longer among the channel's last
 * `maxMessages` messages (deleted, or pushed out while queued): the turn
 * should be skipped. When the fetch itself fails (or the window is bigger
 * than Discord's fetch cap), the in-memory window is used instead so the
 * bot keeps working when the API is flaky.
 */
export async function buildChannelContext(
  channel: GuildTextBasedChannel,
  history: ChannelHistory,
  mentionId: string,
  opts: ContextOptions,
): Promise<ChatMessage[] | null> {
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
 * Map a chronological list of channel messages to the request `messages`
 * array — the pure core of buildChannelContext, driven with fakes in the
 * tests. Returns null when the mention is not among the messages.
 */
export async function contextFromMessages(
  fetched: MessageLike[],
  history: ChannelHistory,
  mentionId: string,
  opts: ContextOptions,
): Promise<ChatMessage[] | null> {
  if (!fetched.some((m) => m.id === mentionId)) return null;

  const entries: ContextEntry[] = [];
  const emitted = new Set<string>();
  for (const m of fetched) {
    const entry = history.find(m.id);
    if (entry && entry.role === "assistant") {
      // A recorded bot reply: emit it once, with its canonical text, on
      // the first of its message ids (a chunked reply is one assistant
      // message). User entries are built from the fetched message instead,
      // so attachments (images) are seen.
      if (entry.ids.some((id) => emitted.has(id))) continue;
      for (const id of entry.ids) emitted.add(id);
      entries.push({ role: "assistant", text: entry.content, images: [] });
      continue;
    }
    const own = m.author.id === opts.botId;
    if (own && BOT_UI_RE.test(m.content)) continue; // UI line, never context

    const text = stripMentionText(m.content, opts.botId);
    const images: AttachmentImage[] = [];
    const notes: string[] = [];
    if (opts.enableImages) {
      const res = await fetchMessageImages(m.attachments.values(), opts.imagesMaxBytes, {
        fetchImpl: opts.imageFetch,
      });
      images.push(...res.images);
      notes.push(...res.notes);
    }
    const body = [text, ...notes].filter((s) => s.length > 0).join("\n");
    if (body.length === 0 && images.length === 0) continue; // carries nothing
    if (own) {
      // A bot reply from before a restart (no history entry): the assistant
      // role says who, so it is not labeled.
      entries.push({ role: "assistant", text: body, images });
      continue;
    }
    // Who said what: prefix the author's display name (a "(bot)" marker for
    // other bots); an image-only message is just the label.
    const label = speakerLabel(m.author.name, m.author.bot);
    entries.push({ role: "user", text: body.length > 0 ? `${label}: ${body}` : `${label}:`, images });
  }

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
