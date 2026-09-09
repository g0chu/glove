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
): Promise<void> {
  let before: string | undefined;
  for (;;) {
    const page = await fetchPage(before);
    if (page.length === 0) return;
    page.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    for (const message of page) {
      if (after === null || BigInt(message.id) > BigInt(after)) capture(message);
    }
    const oldest = page[0].id;
    if (after === null || BigInt(oldest) <= BigInt(after) || page.length < 100) return;
    if (before !== undefined && BigInt(oldest) >= BigInt(before)) throw new Error("discord catch-up did not advance");
    before = oldest;
  }
}
