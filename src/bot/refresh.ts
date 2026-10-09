import { InterruptedError } from "../llm/client.js";
import { compareDiscordIds } from "../llm/context.js";

/**
 * Individual message fetches in flight during a reconcile. Discord's REST
 * rate limiter paces them to the bucket regardless, so a pool wider than the
 * bucket only improves pipelining instead of hammering the endpoint.
 */
export const RECONCILE_CONCURRENCY = 16;

/**
 * Fetch each retained ID not already in `found` (the page observations) and
 * not excluded by `skip` (IDs whose current state this process already
 * observed), with bounded concurrency. An abort stops new fetches before they
 * start; in-flight fetches complete, then InterruptedError propagates. A
 * 10008 (unknown message) is a confirmed deletion, not a failure; any other
 * error rejects.
 */
export async function reconcileMessageIds<T extends { id: string }>(
  ids: string[],
  found: Map<string, T>,
  fetchOne: (id: string) => Promise<T>,
  opts: { aborted?: () => boolean; skip?: (id: string) => boolean } = {},
): Promise<{ fetched: Map<string, T>; deleted: string[] }> {
  if (opts.aborted?.()) throw new InterruptedError();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    if (!id || found.has(id)) continue;
    if (opts.skip?.(id)) continue;
    missing.push(id);
  }
  const fetched = new Map<string, T>();
  const deleted: string[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.aborted?.()) return;
      const index = cursor;
      cursor += 1;
      if (index >= missing.length) return;
      const id = missing[index];
      try {
        fetched.set(id, await fetchOne(id));
      } catch (err) {
        if ((err as { code?: unknown }).code !== 10008) throw err;
        deleted.push(id);
      }
      if (opts.aborted?.()) throw new InterruptedError();
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, missing.length) }, () => worker()));
  if (opts.aborted?.()) throw new InterruptedError();
  return { fetched, deleted };
}

/** Fetch a fresh recent page plus any gap since the last successful REST snapshot.
 * Reconcile all missing retained entries individually (bounded concurrency):
 * absence from a page is not deletion. IDs the caller already knows to be
 * current (`skip`) are not re-fetched. Callers discard this snapshot if
 * gateway activity occurred during the fetch.
 */
export async function fetchFreshMessages<T extends { id: string }>(
  trackedIds: string[],
  fetchPage: (before?: string) => Promise<T[]>,
  fetchOne: (id: string) => Promise<T>,
  signal?: AbortSignal,
  after?: string | null,
  skip: (id: string) => boolean = () => false,
): Promise<{ messages: T[]; deleted: string[]; newestId: string | null }> {
  if (signal?.aborted) throw new InterruptedError();
  // Without a cursor, cover the retained history rather than a newly arrived
  // trigger which may have jumped over a missed gateway gap.
  const boundary = after === undefined ? [...trackedIds].sort(compareDiscordIds)[0] : after;
  const found = new Map<string, T>();
  let before: string | undefined;
  let newestId: string | null = null;
  for (;;) {
    const page = await fetchPage(before);
    if (signal?.aborted) throw new InterruptedError();
    newestId ??= page.map((m) => m.id).sort(compareDiscordIds).at(-1) ?? null;
    for (const message of page) found.set(message.id, message);
    const oldest = page.map((m) => m.id).sort(compareDiscordIds)[0];
    if (!boundary || page.length < 100 || !oldest || compareDiscordIds(oldest, boundary) <= 0) break;
    if (before && compareDiscordIds(oldest, before) >= 0) throw new Error("discord refresh pagination did not advance");
    before = oldest;
  }
  const { fetched, deleted } = await reconcileMessageIds(trackedIds, found, fetchOne, {
    aborted: () => signal?.aborted === true,
    skip,
  });
  for (const [id, message] of fetched) found.set(id, message);
  if (signal?.aborted) throw new InterruptedError();
  return { messages: [...found.values()].sort((a, b) => compareDiscordIds(a.id, b.id)), deleted, newestId };
}
