/** Timestamped console logging + small error helpers. */

const ts = (): string => new Date().toISOString();

export const log = {
  info: (...args: unknown[]): void => {
    console.log(ts(), ...args);
  },
  warn: (...args: unknown[]): void => {
    console.warn(ts(), "[warn]", ...args);
  },
  error: (...args: unknown[]): void => {
    console.error(ts(), "[error]", ...args);
  },
};

/** Extract a human-readable message from an unknown thrown value. */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Truncate a string to at most `n` characters (with an ellipsis). */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}
