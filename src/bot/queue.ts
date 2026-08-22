import { errMsg, log } from "../log.js";

export interface QueueDeps {
  /**
   * Run one full turn for a queued mention. The mention is already in the
   * channel history (see index.ts); this callback builds the request from
   * the current history, calls the model, and posts the reply.
   */
  runTurn: (channelId: string, mentionId: string) => Promise<void>;
}

/**
 * FIFO queue + serial worker for a single channel (PLAN.md §4).
 *
 * Every trackable message lands in the channel history as soon as it
 * arrives (mention or ambient); this queue only holds *mentions*, i.e. the
 * turns to run. Semantics:
 *  - one turn (mention -> model reply) at a time;
 *  - mentions arriving while a turn is in flight are queued, not dropped;
 *  - turns run in arrival order;
 *  - ambient (non-mention) messages never trigger a turn;
 *  - a mention whose message left the channel context (deleted) before its
 *    turn runs is skipped by runTurn.
 */
export class ChannelQueue {
  private pending: string[] = [];
  private pumping = false;

  constructor(
    private readonly channelId: string,
    private readonly deps: QueueDeps,
  ) {}

  get size(): number {
    return this.pending.length;
  }

  /** Queue a mention to be answered, in arrival order. */
  push(mentionId: string): void {
    this.pending.push(mentionId);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length > 0) {
        const mentionId = this.pending.shift()!;
        try {
          await this.deps.runTurn(this.channelId, mentionId);
        } catch (err) {
          // runTurn is expected to handle its own errors; belt and braces so
          // the worker never dies and the channel loop keeps going.
          log.error(`channel ${this.channelId}: turn failed: ${errMsg(err)}`);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}

/** Lazily creates a ChannelQueue per channel id. */
export class QueueStore {
  private readonly byChannel = new Map<string, ChannelQueue>();

  constructor(private readonly deps: QueueDeps) {}

  get(channelId: string): ChannelQueue {
    let q = this.byChannel.get(channelId);
    if (!q) {
      q = new ChannelQueue(channelId, this.deps);
      this.byChannel.set(channelId, q);
    }
    return q;
  }
}
