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
  /** Tokens (the endpoint's measured prompt size when known, else the char estimate) at which the context compacts. */
  maxTokens: number;
  /** How many of the newest messages survive a compaction verbatim. */
  keepMessages: number;
  /** One plain (tool-less) chat call over the old transcript (production: the same model endpoint). */
  summarize: (messages: ChatMessage[]) => Promise<string>;
}

/**
 * The bot's own UI lines — the tool-activity message (one per turn, edited
 * in place as calls arrive: its first line is "🔎 *…*", "📁 *…*", "🐚 *…*",
 * "📚 *…*", "🔧 *…*" or the "🔧 *… N earlier calls …*" header), the
 * thinking line ("🤔 *thought for Ns*"), the clear confirmation ("🧹
 * *…") and the chime NO line ("🔕 *chime: no …", see formatChimeNo in
 * bot/chime.ts) — are posted for humans, not part of the conversation:
 * they never enter the model context, and the seed must not re-introduce
 * them after a restart. Every icon a UI line can start with must be
 * listed here — a missed icon lets that line into the context. (The
 * tool-round narrations are NOT UI lines: they are the bot's own reply
 * text, tracked live as the round entries of the turn's record — the
 * model's history keeps the whole turn — and a persisted context is
 * never re-seeded, so the seed only sees them on a first-run channel,
 * where they are the model's own complete words.)
 */
const BOT_UI_RE = /^(?:🤔|🔎|📁|🐚|🔧|📚|🧹|🔕) \*/;

/**
 * Build the `messages` array for a turn from the channel's persistent
 * context. A context without the seed yet gets one live fetch of the
 * channel's last `maxMessages` Discord messages — either the first turn in
 * a channel the bot has never tracked, or the one restart catch-up of a
 * restored conversation (merging in what arrived while the bot was offline;
 * already-tracked ids win, and the clear's watermark keeps a restart from
 * re-importing what was cleared) — then only grows as messages arrive.
 * When its size — the endpoint's own measured prompt size (its tokenizer's
 * truth, remembered from the previous turn) when known, else the char
 * estimate — passes `maxTokens`, the older part is replaced by a
 * model-written summary and the newest `keepMessages` messages stay
 * verbatim. Returns null when the mention is no longer in the context
 * (deleted while queued): the turn should be skipped.
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
    if (seed !== null && !context.seeded) {
      // A !clear committed while the fetch was in flight wins: its reset()
      // already marked the seed as taken, so the late fetch must not undo
      // the clear by re-seeding the channel's last-N.
      // A persisted context's catch-up seed (the channel was talked in
      // while the bot was offline) honors the clear's watermark too: no
      // message older than the clear is re-imported after a restart.
      const clearedAt = context.getClearedAt();
      context.seedFrom(
        seed
          .map((m) => toSeedEntry(m, opts.botId))
          .filter((e): e is SeedEntry => e !== null)
          .filter((e) => clearedAt === null || e.ts > clearedAt),
      );
    }
    // fetch failed: the context keeps working from what arrived, and the
    // seed is retried on the next turn
  }
  // File contents add a per-attachment cost to the estimate (their size,
  // capped at the download limit); undefined = the feature is off.
  const fileCost = opts.enableFileContents ? opts.fileContentsMaxBytes : undefined;
  // The size check prefers the endpoint's own count of this channel's last
  // request (measured tokens, counted by the model's tokenizer) over the
  // char estimate; after a compaction attempt the measurement is forgotten,
  // since it then describes the pre-compaction context.
  const measured = context.getMeasuredTokens();
  const estimate = context.estimateTokens(opts.systemPrompt, opts.maxMessages, fileCost);
  const size = measured !== null ? measured : estimate;
  if (size > opts.maxTokens) {
    const res = await context.compact(opts.keepMessages, opts.summarize, mentionId);
    context.setMeasuredTokens(null);
    if (res.ok) {
      log.info(
        `channel context filled the budget (${measured !== null ? `measured ${measured}` : `estimated ${estimate}`} tokens > ${opts.maxTokens}); compacted to a summary + ${context.length} recent message(s)`,
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
 * Sync an already-committed message's new state into the channel context
 * (a messageUpdate that arrives after the stability commit). A
 * single-message entry takes the new content with the bot's mentions
 * stripped (the model's view of non-bot messages); a chunked bot reply's
 * chunk takes the RAW new content — the stored chunks are the raw posted
 * text, so the bot's own final settle edit (which Discord echoes back as a
 * messageUpdate) is a no-op only against the raw content, and a real edit
 * (by anyone) stores exactly what the channel shows; the entry's content
 * is re-derived from the chunks (see ChannelContext.updateChunk). The
 * single-message entry's attachment metadata follows the edit too (the
 * image/file pipelines download from the stored metadata at turn time).
 */
export function syncMessageUpdate(
  context: ChannelContext,
  message: { id: string; content: string; attachments: { values(): Iterable<MessageAttachmentLike> } },
  botId: string,
): void {
  const entry = context.find(message.id);
  if (!entry) return; // not in this channel's context
  if (entry.ids.length === 1) {
    const newContent = stripMentionText(message.content, botId);
    if (newContent !== entry.content) context.updateContent(message.id, newContent);
    context.updateAttachments(
      message.id,
      [...message.attachments.values()].map((a) => ({
        url: a.url,
        name: a.name,
        size: a.size,
        contentType: a.contentType ?? null,
      })),
    );
  } else if (entry.chunks) {
    const i = entry.ids.indexOf(message.id);
    if (i !== -1 && entry.chunks[i] !== message.content) {
      context.updateChunk(message.id, message.content);
    }
  }
}

/**
 * The exclusive end index of the prefix of the messages array that
 * contextToMessages produces which ends at the entry containing `entryId`
 * — the system prompt (when non-empty), the summary (when present), and
 * every rendered entry up to and including it. The chime transcript is cut
 * there so a message committed after the trigger (while the turn's context
 * was building) does not shift the decision target: the prompt's "the
 * newest message below" must be the trigger itself. Null when the entry is
 * not in the context. Uses the same rendering rule as contextToMessages:
 * a user entry always renders (its name label alone), an assistant entry
 * renders when it has text (bot messages are posted without attachments, so
 * the text is all they carry).
 */
export function prefixEndIndex(
  context: ChannelContext,
  opts: Pick<ContextOptions, "systemPrompt" | "enableImages" | "enableFileContents">,
  entryId: string,
): number | null {
  const entries = context.snapshot();
  const idx = entries.findIndex((e) => e.ids.includes(entryId));
  if (idx === -1) return null;
  let n = opts.systemPrompt.trim().length > 0 ? 1 : 0;
  const summary = context.getSummary();
  if (summary && summary.trim().length > 0) n += 1;
  for (let i = 0; i <= idx; i++) {
    const e = entries[i];
    // Same rendering rule as contextToMessages: a user entry always renders
    // (its name label alone), a tool entry renders with its result text,
    // an assistant entry renders with its text or its tool calls. (The
    // in-window-attachment case for a textless assistant is unreachable —
    // bot messages carry no attachments — and the pipelines never apply to
    // tool entries, so the rule above is exact.)
    if (e.role === "user" || e.content.length > 0 || (e.toolCalls?.length ?? 0) > 0) {
      n += 1;
      continue;
    }
    if (e.attachments.length > 0 && (opts.enableImages || opts.enableFileContents)) n += 1;
  }
  return n;
}

/**
 * The chime decision's view of a built turn context: the conversation
 * without the model's internal machinery — tool results drop out, assistant
 * messages lose their tool calls and reasoning, and an assistant message
 * that carried only calls (no text) drops out entirely. The decision is
 * about the newest message, not about a past turn's tooling, so the
 * transcript stays small and focused.
 */
/**
 * The reply request must end with the trigger's user message. The trigger
 * is committed before its turn runs, but a turn's reply lands in the
 * context only when the turn ends — a message committed while the previous
 * turn is still in flight therefore sits in the context before that reply,
 * and the rendered request can end with the bot's own reply instead of the
 * trigger. An endpoint that prefills a trailing assistant message
 * (llama-server's `prefill-assistant` default) then "continues" the bot's
 * last reply: it echoes the message back verbatim (content and reasoning)
 * as the new reply — a duplicate post — and rejects the request outright
 * when two replies trail ("Cannot have 2 or more assistant messages at the
 * end of the list"). Moving the trigger to the end keeps the whole
 * conversation and makes the trigger the newest message again — what the
 * turn is answering. A no-op when the trigger is already last (the usual
 * case) or no longer in the context.
 */
export function endWithTrigger(
  context: ChannelContext,
  opts: Pick<ContextOptions, "systemPrompt" | "enableImages" | "enableFileContents">,
  messages: ChatMessage[],
  triggerId: string,
): ChatMessage[] {
  const cut = prefixEndIndex(context, opts, triggerId);
  if (cut === null || cut >= messages.length) return messages;
  return [...messages.slice(0, cut - 1), ...messages.slice(cut), messages[cut - 1]];
}

export function chimeTranscript(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => m.role !== "tool" && !(m.role === "assistant" && typeof m.content === "string" && m.content.length === 0))
    .map((m) => (m.role === "assistant" ? { role: "assistant" as const, content: m.content } : m));
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
    if (e.role === "tool") {
      // Tool results travel with the request as plain tool messages (they
      // answer the calls of the preceding assistant entry — the endpoint
      // pairs them by id).
      out.push({ role: "tool", toolCallId: e.toolCallId ?? "", name: e.name ?? "", content: e.content });
      continue;
    }
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
    // An assistant entry that requested tools carries them even when it has
    // no text (the model answered with calls only) — the history must not
    // lose the call/result pairing.
    if (body.length === 0 && images.length === 0 && files.length === 0 && (e.toolCalls?.length ?? 0) === 0) continue; // carries nothing
    const msg: ChatMessage =
      images.length === 0 ? { role: e.role, content: body } : { role: e.role, content: [] };
    if (images.length > 0) {
      const parts = msg.content as ContentPart[];
      if (body.length > 0) parts.push({ type: "text", text: body });
      for (const img of images) parts.push({ type: "image_url", image_url: { url: img.url } });
    }
    if (e.reasoning !== undefined && e.reasoning.length > 0) msg.reasoningContent = e.reasoning;
    if (e.toolCalls !== undefined && e.toolCalls.length > 0) msg.toolCalls = e.toolCalls;
    out.push(msg);
  }
  return out;
}

