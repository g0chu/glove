import { EMOJI_NAMES } from "./emoji-names.js";
import type { ImageFetch } from "./images.js";

/** One emoji's current aggregate reaction count on a Discord message. */
export interface ReactionSnapshot {
  id: string | null;
  name: string;
  emoji: string;
  count: number;
}

/** Minimal shape shared by full Discord messages and test fixtures. */
export interface ReactionMessage {
  reactions?: { cache: { values(): Iterable<{ emoji: { id: string | null; name: string | null }; count: number | null }> } };
}

/** Stable ordering keeps identical REST and gateway snapshots identical. */
export function snapshotReactions(message: ReactionMessage): ReactionSnapshot[] {
  return [...(message.reactions?.cache.values() ?? [])].filter((r) => (r.count ?? 0) > 0).map((r) => {
    const emoji = r.emoji.name ?? "unknown emoji";
    return { id: r.emoji.id, emoji, name: r.emoji.id ? emoji : EMOJI_NAMES[emoji] ?? emoji, count: r.count! };
  }).sort((a, b) => (a.id ?? a.emoji).localeCompare(b.id ?? b.emoji));
}

/** Fixed image sources only; custom emoji use a static PNG of their first frame. */
export function reactionImageUrl(reaction: ReactionSnapshot): string {
  if (reaction.id && /^\d+$/.test(reaction.id)) return `https://cdn.discordapp.com/emojis/${reaction.id}.png?size=64`;
  // Twemoji keeps variation selectors in joined sequences (for example rainbow flags).
  const emoji = reaction.emoji.includes("\u200d") ? reaction.emoji : reaction.emoji.replace(/\ufe0f/g, "");
  const points = [...emoji].map((c) => c.codePointAt(0)!.toString(16)).join("-");
  return `https://raw.githubusercontent.com/jdecked/twemoji/v16.0.1/assets/72x72/${points}.png`;
}

/** Download a bounded PNG from a fixed emoji source, with no redirects. */
export async function fetchReactionImage(reaction: ReactionSnapshot, maxBytes: number, fetchImpl: ImageFetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(reactionImageUrl(reaction), { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch { return null; }
}
