import type { Message, OmitPartialGroupDMChannel } from "discord.js";

/**
 * A message as delivered by the Discord events the gate listens to
 * (messageCreate / messageUpdate): its channel is never a
 * PartialGroupDMChannel (those don't surface to these events).
 */
export type GateMessage = OmitPartialGroupDMChannel<Message>;

/** A gate timer handle (the injected scheduler's token). */
export type GateTimer = unknown;

export interface GateOptions {
  /**
   * The stability window (ms): a message is committed once it has been
   * unchanged (no edits) for this long.
   */
  stableMs: number;
  /** Commit a message that has been stable for the whole window (its final state). */
  onCommit: (message: GateMessage) => void;
  /** Test-only: inject the timer (production uses setTimeout). */
  schedule?: (fn: () => void, ms: number) => GateTimer;
  /** Test-only: inject the timer cancel (production uses clearTimeout). */
  cancel?: (t: GateTimer) => void;
}

interface GateEntry {
  /** The latest version of the message (edits replace it, so it is final when the timer fires). */
  message: GateMessage;
  channelId: string;
  timer: GateTimer;
  ready: boolean;
}

/**
 * The stability gate: a trackable message is committed (tracked in the
 * channel context, able to queue a turn) only once it has been unchanged
 * for `stableMs`.
 *
 * Other bots stream their replies by posting a message and editing it as
 * the text arrives. Committing on arrival would send the model partial
 * text — and queue a turn for a mention that only exists in the final
 * form. So every arrival (and every edit while still pending) restarts the
 * window; when it fires, the message is committed exactly once, with the
 * latest state it has seen. A message deleted (or whose channel is deleted)
 * while still pending never commits: it was never tracked, so nothing is
 * lost. Edits after the commit sync the context through the usual
 * message-update path instead.
 */
export class MessageGate {
  private readonly pending = new Map<string, GateEntry>();
  private readonly schedule: (fn: () => void, ms: number) => GateTimer;
  private readonly cancel: (t: GateTimer) => void;

  constructor(private readonly opts: GateOptions) {
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** How many messages are still in their stability window. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Register a fresh trackable message, or refresh one that is still
   * pending (an edit): the latest version wins and the stability window
   * restarts from now.
   */
  arrive(message: GateMessage): void {
    const prev = this.pending.get(message.id);
    if (prev) this.cancel(prev.timer);
    const entry: GateEntry = { message, channelId: message.channel?.id ?? "", timer: undefined, ready: false };
    entry.timer = this.schedule(() => {
      // Only the entry that is still stored for this id commits: an edit
      // replaced it (this timer was cancelled) or a delete/channel-delete
      // dropped it.
      if (this.pending.get(message.id) !== entry) return;
      entry.ready = true;
      this.drain(entry.channelId);
    }, this.opts.stableMs);
    this.pending.set(message.id, entry);
  }

  /** Commit stable messages in Discord order, waiting for earlier pending edits. */
  private drain(channelId: string): void {
    const entries = [...this.pending.values()]
      .filter((entry) => entry.channelId === channelId)
      .sort((a, b) => a.message.id.length - b.message.id.length ||
        (a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0));
    for (const entry of entries) {
      if (!entry.ready) break;
      if (this.pending.get(entry.message.id) !== entry) continue;
      this.pending.delete(entry.message.id);
      this.opts.onCommit(entry.message);
    }
  }

  /** True while the message is in its stability window (edits refresh the gate, not the context). */
  isPending(messageId: string): boolean {
    return this.pending.has(messageId);
  }

  /**
   * Drop a still-pending message (deleted before it stabilized): it never
   * commits. Returns true when a pending message was dropped.
   */
  drop(messageId: string): boolean {
    const entry = this.pending.get(messageId);
    if (!entry) return false;
    this.cancel(entry.timer);
    this.pending.delete(messageId);
    this.drain(entry.channelId);
    return true;
  }

  /** Forget a channel's still-pending messages (the channel was deleted). */
  clearChannel(channelId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.channelId === channelId) {
        this.cancel(entry.timer);
        this.pending.delete(id);
      }
    }
  }

  /** Forget everything (shutdown): no pending message commits. */
  clear(): void {
    for (const entry of this.pending.values()) this.cancel(entry.timer);
    this.pending.clear();
  }
}
