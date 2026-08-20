import type { ChatMessage } from "./client.js";

export type Role = "user" | "assistant";

export interface HistoryMessage {
  role: Role;
  content: string;
}

/** Per-channel in-memory sliding window of the last N messages. */
export class ChannelHistory {
  private readonly messages: HistoryMessage[] = [];

  constructor(private readonly maxMessages: number) {}

  push(role: Role, content: string): void {
    this.messages.push({ role, content });
    while (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
  }

  snapshot(): HistoryMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages.length = 0;
  }

  get length(): number {
    return this.messages.length;
  }
}

/** Lazily creates a ChannelHistory per channel id. */
export class ConversationStore {
  private readonly byChannel = new Map<string, ChannelHistory>();

  constructor(private readonly maxMessages: number) {}

  get(channelId: string): ChannelHistory {
    let h = this.byChannel.get(channelId);
    if (!h) {
      h = new ChannelHistory(this.maxMessages);
      this.byChannel.set(channelId, h);
    }
    return h;
  }
}

/**
 * Build the `messages` array for a request: optional system message
 * (when MODEL_SYSTEM_PROMPT is non-empty) followed by the channel history.
 */
export function toRequestMessages(history: ChannelHistory, systemPrompt: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (systemPrompt.trim().length > 0) {
    out.push({ role: "system", content: systemPrompt });
  }
  for (const m of history.snapshot()) {
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
