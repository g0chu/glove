import { errMsg, log } from "../log.js";

/**
 * One queued turn: the triggering message (in the channel context when the
 * turn runs) plus whether the model must first decide whether to respond at
 * all. `chime: false` is a mention — the bot always responds. `chime: true`
 * is a message from another bot that did not mention the bot (chime
 * enabled): the model decides, and a NO stays silent.
 */
export interface TurnRequest {
  id: string;
  chime: boolean;
}

export interface QueueDeps {
  /**
   * Run one full turn for a queued turn request. The triggering message is
   * already in the channel context (see index.ts); this callback builds the
   * request from the current context, calls the model, and posts the reply
   * (a declined chime posts nothing).
   */
  runTurn: (channelId: string, turn: TurnRequest) => Promise<void>;
}

/**
 * FIFO queue + serial worker for a single channel (PLAN.md §4).
 *
 * Every trackable message lands in the channel context as soon as it
 * stabilizes (mention or ambient); this queue only holds the *turns to run*:
 * mentions (which always respond) and, with chime enabled, other bots'
 * non-mention messages (which the model may decline). Semantics:
 *  - one turn (trigger -> model reply) at a time;
 *  - turns arriving while one is in flight are queued, not dropped;
 *  - turns run in arrival order;
 *  - ambient (non-mention, non-chime) messages never trigger a turn;
 *  - a trigger whose message left the channel context (deleted) before its
 *    turn runs is skipped by runTurn.
 */
export class ChannelQueue {
  private pending: TurnRequest[] = [];
  private pumping = false;

  constructor(
    private readonly channelId: string,
    private readonly deps: QueueDeps,
  ) {}

  get size(): number {
    return this.pending.length;
  }

  /** Queue a turn to run, in arrival order. */
  push(request: TurnRequest): void {
    this.pending.push(request);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length > 0) {
        const turn = this.pending.shift()!;
        try {
          await this.deps.runTurn(this.channelId, turn);
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
