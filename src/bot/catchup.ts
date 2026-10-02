/**
 * Capture every available message newer than a durable cursor. Fetch newest
 * first in pages of 100, stopping at the boundary. A new archive captures
 * one baseline page. The caller commits its cursor only after this succeeds;
 * repeated captures after a crash are observations, never queued turns.
 */
export async function captureCatchup<T extends { id: string }>(
  after: string | null,
  fetchPage: (before?: string) => Promise<T[]>,
  capture: (message: T) => void,
): Promise<string | null> {
  let before: string | undefined;
  let newest: string | null = null;
  for (;;) {
    const page = await fetchPage(before);
    if (page.length === 0) return newest;
    page.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    newest ??= page.at(-1)!.id;
    for (const message of page) {
      if (after === null || BigInt(message.id) > BigInt(after)) capture(message);
    }
    const oldest = page[0].id;
    if (after === null || BigInt(oldest) <= BigInt(after) || page.length < 100) return newest;
    if (before !== undefined && BigInt(oldest) >= BigInt(before)) throw new Error("discord catch-up did not advance");
    before = oldest;
  }
}

/** Do not advance durable REST coverage past an arrival still awaiting commit. */
export function coveredDiscordCursor(after: string | null, newest: string | null, deferredIds: string[]): string | null {
  let through = newest === null || (after !== null && BigInt(after) > BigInt(newest)) ? after : newest;
  for (const id of deferredIds) {
    if (through !== null && BigInt(id) <= BigInt(through) && (after === null || BigInt(id) > BigInt(after))) {
      through = (BigInt(id) - 1n).toString();
    }
  }
  return through;
}
