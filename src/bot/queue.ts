import { compareDiscordIds } from "../llm/context.js";
import { errMsg, log } from "../log.js";

/**
 * One queued turn: the triggering message (in the channel context when the
 * turn runs) plus whether the model must first decide whether to respond at
 * all. `chime: false` is a mention — the bot always responds. `chime: true`
 * is any message that did not mention the bot (chime enabled): the model
 * decides, and a NO posts the decision + reason as a UI line (no reply).
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
   * (a declined chime posts only the decision line, never a reply).
   */
  runTurn: (channelId: string, turn: TurnRequest) => Promise<void>;
}

/**
 * FIFO queue + serial worker for a single channel (PLAN.md §4).
 *
 * Every trackable message lands in the channel context as soon as it
 * stabilizes (mention or ambient); this queue only holds the *turns to run*:
 * mentions (which always respond) and, with chime enabled, every other
 * non-mention message (which the model may decline). Semantics:
 *  - one turn (trigger -> model reply) at a time;
 *  - duplicate trigger IDs are ignored, including completed triggers;
 *  - queued triggers included in a delivered answer can be discarded;
 *  - turns run in arrival order;
 *  - without chime, ambient (non-mention) messages never trigger a turn;
 *  - a trigger whose message left the channel context (deleted) before its
 *    turn runs is skipped by runTurn.
 */
export class ChannelQueue {
  private pending: TurnRequest[] = [];
  private pumping = false;
  private readonly requested = new Set<string>();

  constructor(
    private readonly channelId: string,
    private readonly deps: QueueDeps,
  ) {}

  get size(): number {
    return this.pending.length;
  }

  /**
   * The trigger id of the newest pending (not yet run) mention turn
   * (`chime: false`) whose trigger is newer than `id` (snowflake order), or
   * null when no such turn is queued. The interrupted-turn supersede check
   * (index.ts): a mention turn interrupted while a newer mention turn waits
   * behind it is discarded — the newer turn always responds, over a context
   * that carries everything, so it is the one that answers the channel's
   * newest information. Chime turns never supersede a mention (their
   * decision may stay silent), and a turn whose trigger left the context
   * will be skipped; `exists` lets callers exclude removed triggers.
   */
  newestPendingMentionAfter(id: string, exists: (id: string) => boolean = () => true): string | null {
    let found: string | null = null;
    for (const t of this.pending) {
      if (!t.chime && exists(t.id) && compareDiscordIds(t.id, id) > 0 &&
        (found === null || compareDiscordIds(t.id, found) > 0)) found = t.id;
    }
    return found;
  }

  /** Queue a previously unseen trigger, in arrival order. */
  push(request: TurnRequest): void {
    if (this.requested.has(request.id)) return;
    this.requested.add(request.id);
    this.pending.push(request);
    void this.pump();
  }

  /** Drop queued triggers already included in a successfully delivered answer. */
  discardCovered(ids: Iterable<string>): void {
    const covered = new Set(ids);
    this.pending = this.pending.filter((turn) => !covered.has(turn.id));
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
