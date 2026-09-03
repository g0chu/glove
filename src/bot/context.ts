import type { GuildTextBasedChannel, Message } from "discord.js";
import type { ChatMessage, ContentPart } from "../llm/client.js";
import {
  compareDiscordIds,
  speakerLabel,
  type ChannelContext,
  type SeedEntry,
} from "../llm/context.js";
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

export interface ContextOptions {
  /** The bot's own user id (its non-reply lines are never context). */
  botId: string;
  systemPrompt: string;
  /**
   * The channel's last N Discord messages: the startup seed size, and the
   * window of messages whose image attachments are actually downloaded.
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
  /** Estimated tokens (see llm/context.ts) at which the context compacts. */
  maxTokens: number;
  /** How many of the newest messages survive a compaction verbatim. */
  keepMessages: number;
  /** One plain (tool-less) chat call over the old transcript (production: the same model endpoint). */
  summarize: (messages: ChatMessage[]) => Promise<string>;
}

/**
 * The bot's own UI lines — the tool-activity message (one per turn, edited
 * in place as calls arrive: its first line is "🔎 *…*", "📁 *…*", "🐚 *…*",
 * "📚 *…*", "🔧 *…*" or the "🔧 *… N earlier calls …*" header) and the
 * thinking line ("🤔 *thought for Ns*") — are posted for humans, not part
 * of the conversation: they never enter the model context. Every icon the
 * activity lines can start with (see iconFor in tools/activity.ts) must be
 * listed here — a missed icon lets that activity line into the context.
 */
const BOT_UI_RE = /^(?:🤔|🔎|📁|🐚|🔧|📚|🧹) \*/;

/**
 * Build the `messages` array for a turn from the channel's persistent
 * context. The context is seeded once with the channel's last `maxMessages`
 * Discord messages (fetched live, so it survives bot restarts and includes
 * every author, not just the ones seen since the start), then only grows as
 * messages arrive. When its estimated size passes `maxTokens`, the older
 * part is replaced by a model-written summary and the newest
 * `keepMessages` messages stay verbatim. Returns null when the mention is no
 * longer in the context (deleted while queued): the turn should be skipped.
 */
export async function buildChannelContext(
  channel: GuildTextBasedChannel,
  context: ChannelContext,
  mentionId: string,
  opts: ContextOptions,
): Promise<ChatMessage[] | null> {
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
  if (context.estimateTokens(opts.systemPrompt, opts.maxMessages, fileCost) > opts.maxTokens) {
    const res = await context.compact(opts.keepMessages, opts.summarize, mentionId);
    if (res.ok) {
      log.info(
        `channel context filled the budget (~${opts.maxTokens} est. tokens); compacted to a summary + ${context.length} recent message(s)`,
      );
    } else {
      log.warn(
        `context compaction did not apply (${res.reason}); trimming the oldest messages to fit the budget`,
      );
      context.emergencyTrim(mentionId, opts.maxTokens, opts.systemPrompt, opts.maxMessages, fileCost);
    }
  }
  return contextToMessages(context, opts);
}

/**
 * The channel's last min(N, 100) messages in chronological order (Discord's
 * fetch caps at 100 — a bigger window seeds with what Discord can give, so
 * the context still gains the pre-startup messages), or null (fetch
 * failure: the seed is retried on the next turn).
 */
async function seedMessages(channel: GuildTextBasedChannel, limit: number): Promise<MessageLike[] | null> {
  const n = Math.min(limit, DISCORD_FETCH_LIMIT);
  try {
    const col = await channel.messages.fetch({ limit: n });
    return [...col.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp || compareDiscordIds(a.id, b.id))
      .map(toMessageLike);
  } catch (err) {
    log.warn(`could not seed the channel context from its last ${n} messages (${errMsg(err)}); retrying next turn`);
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

