/**
 * Per-channel chat activity for the prompt-interruption feature: a channel
 * is active while it changes — a new message, an edit, or a typing
 * indicator (the bot's own posts and typing never count, see index.ts,
 * which notes only trackable events). A turn's in-flight model request is
 * aborted on any activity in the channel it is answering (the attempt
 * watches the tracker); after the interruption the turn waits for the
 * channel to go quiet — no activity for the stability window (
 * DISCORD_MESSAGE_STABLE_MS) — and is then either discarded (a newer turn
 * supersedes it — the newer turn responds to the newest information) or
 * retried with the updated context (see index.ts).
 */
export interface ActivityOptions {
  /** Test-only: inject the sleeper (production uses setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Test-only: inject the clock (production uses Date.now). */
  now?: () => number;
}

/**
 * The activity tracker: when each channel last changed, and who is watching
 * for changes. `note` records a change (and fires the channel's watchers —
 * a running turn uses that to abort its in-flight model request);
 * `waitForQuiet` resolves once the channel has been unchanged for the
 * stability window, restarting the window on every new change while waiting.
 */
export class ChannelActivity {
  private readonly lastActivity = new Map<string, number>();
  private readonly watchers = new Map<string, Set<(mention: boolean) => void>>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: ActivityOptions = {}) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** Record a change in a channel (a new message, an edit, a typing indicator). */
  note(channelId: string, mention = false): void {
    this.lastActivity.set(channelId, this.now());
    const ws = this.watchers.get(channelId);
    if (ws) {
      // Iterate over a copy: a watcher may unsubscribe itself while firing.
      for (const w of [...ws]) w(mention);
    }
  }

  /**
   * Watch a channel's changes: `onActivity` fires on every note for the
   * channel (a running turn aborts its in-flight model request). Returns an
   * unsubscribe function (the attempt's end).
   */
  watch(channelId: string, onActivity: (mention: boolean) => void): () => void {
    let ws = this.watchers.get(channelId);
    if (!ws) {
      ws = new Set();
      this.watchers.set(channelId, ws);
    }
    ws.add(onActivity);
    return () => {
      const set = this.watchers.get(channelId);
      if (!set) return;
      set.delete(onActivity);
      if (set.size === 0) this.watchers.delete(channelId);
    };
  }

  /**
   * Wait for the channel to go quiet: resolve once there has been no
   * activity for `quietMs` after the most recent one (activity while
   * waiting restarts the window). A channel with no recorded activity is
   * already quiet.
   */
  async waitForQuiet(channelId: string, quietMs: number): Promise<void> {
    for (;;) {
      const last = this.lastActivity.get(channelId);
      if (last === undefined) return; // nothing seen: already quiet
      const waitMs = last + quietMs - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      if (this.lastActivity.get(channelId) === last) return; // quiet for the window
    }
  }

  /** Forget a channel (it was deleted): its state and watchers are gone. */
  clearChannel(channelId: string): void {
    this.lastActivity.delete(channelId);
    this.watchers.delete(channelId);
  }

  /** Forget everything (shutdown). */
  clear(): void {
    this.lastActivity.clear();
    this.watchers.clear();
  }
}
