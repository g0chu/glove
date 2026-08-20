import { errMsg, log } from "../log.js";

export interface QueueItem {
  content: string;
  isMention: boolean;
}

export interface QueueDeps {
  /** Ambient (non-mention) message rides along with the next turn. */
  onAmbient: (channelId: string, content: string) => void;
  /** Run one full turn: append user message, call the model, post the reply. */
  runTurn: (channelId: string, content: string) => Promise<void>;
}

/**
 * FIFO queue + serial worker for a single channel (PLAN.md §4).
 *
 * Semantics:
 *  - one turn (mention -> model reply) at a time;
 *  - messages arriving while a turn is in flight are queued, not dropped;
 *  - the first queued mention starts the next turn;
 *  - non-mention messages sitting before that mention are appended to the
 *    channel history (as user turns) so the model sees them as context
 *    leading into the mention;
 *  - non-mentions with no later mention stay buffered until a mention
 *    arrives (they never trigger a reply on their own).
 */
export class ChannelQueue {
  private pending: QueueItem[] = [];
  private pumping = false;

  constructor(
    private readonly channelId: string,
    private readonly deps: QueueDeps,
  ) {}

  get size(): number {
    return this.pending.length;
  }

  push(item: QueueItem): void {
    this.pending.push(item);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const mentionIndex = this.pending.findIndex((m) => m.isMention);
        if (mentionIndex === -1) break; // only ambient messages: keep them buffered
        const mention = this.pending[mentionIndex];
        const ambient = this.pending.splice(0, mentionIndex);
        this.pending.shift(); // drop the mention itself; it becomes the turn
        for (const a of ambient) {
          this.deps.onAmbient(this.channelId, a.content);
        }
        try {
          await this.deps.runTurn(this.channelId, mention.content);
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
