/**
 * Per-channel chat activity for the prompt-interruption feature. Two kinds
 * of channel change are tracked:
 *
 * - `note` — a NEW message from another user or bot. It is the only event
 *   that interrupts a running model request (the attempt's watcher aborts
 *   it), and it restarts the stillness wait.
 * - `touch` — any other change to the channel's content: an edit, a
 *   deletion, a reaction, a rename. It restarts the stillness wait (a chime
 *   must still decide over a still conversation) but does NOT interrupt: the
 *   model finishes over the pre-change text, and the change is synced into
 *   the context for the next turn (or the retry, when a newer message
 *   interrupts the attempt).
 *
 * The bot's own posts never count (see index.ts, which notes/touches only
 * trackable external events). Typing indicators are not activity at all:
 * they do not change the conversation's content, and holding the stillness
 * wait or aborting an in-flight request on them would stall a turn for as
 * long as anyone keeps composing (Discord typing lasts minutes); the message
 * that is typed interrupts the turn through its own event once it arrives.
 *
 * After an interruption the turn waits for the channel to go quiet — no
 * note or touch for the stability window (DISCORD_MESSAGE_STABLE_MS) — and
 * is then either discarded (a newer turn supersedes it — the newer turn
 * responds to the newest information) or retried with the updated context
 * (see index.ts).
 */
export interface ActivityOptions {
  /** Test-only: inject the sleeper (production uses setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Test-only: inject the clock (production uses Date.now). */
  now?: () => number;
}

/**
 * The activity tracker: when each channel last changed (notes and touches
 * alike hold the stillness wait), who is watching for new messages (notes
 * fire the channel's watchers — a running turn uses that to abort its
 * in-flight model request), and a per-channel epoch that counts every note
 * and touch (the pre-turn refresh compares it across its REST snapshot to
 * detect gateway activity that raced the fetch — see index.ts).
 * `waitForQuiet` resolves once the channel has been unchanged (no note or
 * touch) for the stability window, restarting the window on every change
 * while waiting.
 */
export class ChannelActivity {
  private readonly lastActivity = new Map<string, number>();
  private readonly watchers = new Map<string, Set<(mention: boolean) => void>>();
  private readonly epochs = new Map<string, number>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: ActivityOptions = {}) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** Record a new message in a channel: the stillness window restarts and the channel's watchers fire (a running turn aborts its in-flight model request). */
  note(channelId: string, mention = false): void {
    this.lastActivity.set(channelId, this.now());
    this.epochs.set(channelId, (this.epochs.get(channelId) ?? 0) + 1);
    const ws = this.watchers.get(channelId);
    if (ws) {
      // Iterate over a copy: a watcher may unsubscribe itself while firing.
      for (const w of [...ws]) w(mention);
    }
  }

  /** Record a change that is not a new message (an edit, a deletion, a reaction, a rename): the stillness window restarts, but no watcher fires — only a new message from another user interrupts a running model request. */
  touch(channelId: string): void {
    this.lastActivity.set(channelId, this.now());
    this.epochs.set(channelId, (this.epochs.get(channelId) ?? 0) + 1);
  }

  /** The channel's activity epoch: bumped by every note and touch, 0 for an unseen channel. The pre-turn refresh compares it across its REST snapshot to detect gateway activity that raced the fetch. */
  epochOf(channelId: string): number {
    return this.epochs.get(channelId) ?? 0;
  }

  /**
   * Watch a channel's new messages: `onActivity` fires on every note for
   * the channel (a running turn aborts its in-flight model request).
   * Touches (edits, deletions, reactions, renames) do not fire watchers.
   * Returns an unsubscribe function (the attempt's end).
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
   * activity (note or touch) for `quietMs` after the most recent one
   * (activity while waiting restarts the window). A channel with no
   * recorded activity is already quiet.
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
    this.epochs.delete(channelId);
  }

  /** Forget everything (shutdown). */
  clear(): void {
    this.lastActivity.clear();
    this.watchers.clear();
    this.epochs.clear();
  }
}
