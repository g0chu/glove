/**
 * TTL + size-bounded in-memory cache for successful fetch results.
 * Entries expire after a TTL and the cache evicts the oldest entry once
 * `maxEntries` is exceeded. The clock is injectable so tests can advance
 * time without sleeping.
 */
interface Entry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export class FetchCache<T> {
  private readonly data = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): T | null {
    const entry = this.data.get(key);
    if (entry === undefined) return null;
    if (this.now() > entry.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  put(key: string, value: T): void {
    const now = this.now();
    this.data.set(key, { value, storedAt: now, expiresAt: now + this.ttlMs });
    for (const [k, e] of this.data) {
      if (now > e.expiresAt) this.data.delete(k);
    }
    while (this.data.size > this.maxEntries) {
      let oldest: string | null = null;
      for (const [k, e] of this.data) {
        if (oldest === null || e.storedAt < (this.data.get(oldest) as Entry<T>).storedAt) oldest = k;
      }
      if (oldest === null) break;
      this.data.delete(oldest);
    }
  }

  clear(): void {
    this.data.clear();
  }

  get size(): number {
    return this.data.size;
  }
}
