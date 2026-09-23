import { InterruptedError } from "../llm/client.js";
import { compareDiscordIds } from "../llm/context.js";

/** Fetch a fresh recent page plus any gap since the newest tracked message.
 * Reconcile missing recent entries individually: absence from a page is not deletion.
 * Callers discard this snapshot if gateway activity occurred during the fetch.
 */
export async function fetchFreshMessages<T extends { id: string }>(
  trackedIds: string[],
  fetchPage: (before?: string) => Promise<T[]>,
  fetchOne: (id: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ messages: T[]; deleted: string[] }> {
  if (signal?.aborted) throw new InterruptedError();
  const newest = [...trackedIds].sort(compareDiscordIds).at(-1);
  const found = new Map<string, T>();
  let before: string | undefined;
  for (;;) {
    const page = await fetchPage(before);
    if (signal?.aborted) throw new InterruptedError();
    for (const message of page) found.set(message.id, message);
    const oldest = page.map((m) => m.id).sort(compareDiscordIds)[0];
    if (!newest || page.length < 100 || !oldest || compareDiscordIds(oldest, newest) <= 0) break;
    if (before && compareDiscordIds(oldest, before) >= 0) throw new Error("discord refresh pagination did not advance");
    before = oldest;
  }
  const deleted: string[] = [];
  for (const id of trackedIds) {
    if (found.has(id)) continue;
    try { found.set(id, await fetchOne(id)); }
    catch (err) {
      if ((err as { code?: unknown }).code !== 10008) throw err;
      deleted.push(id);
    }
  }
  if (signal?.aborted) throw new InterruptedError();
  return { messages: [...found.values()].sort((a, b) => compareDiscordIds(a.id, b.id)), deleted };
}
