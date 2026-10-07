import type { ChatMessage } from "./client.js";

/** Select model-specific wire behavior without changing persisted history. */
export type ModelCompatibility = "auto" | "generic" | "gemma4";

/** Recognize Gemma 4 model IDs, including paths and quantized filenames. */
export function usesGemma4(model: string, compatibility: ModelCompatibility = "auto"): boolean {
  return compatibility === "gemma4" || (compatibility === "auto" && /(?:^|[^a-z0-9])gemma[-_ ]?4(?:[^0-9]|$)/i.test(model));
}

const THOUGHT_MARKERS = [
  { open: "<|channel>thought", close: "<channel|>" },
  { open: "<think>", close: "</think>" },
  { open: "<analysis>", close: "</analysis>" },
];

/** Split leading thought blocks incrementally, including markers split across SSE chunks. */
export class ThoughtSplitter {
  private buffer = "";
  private state: "prefix" | "thought" | "answer" = "prefix";
  private close = "";

  constructor(private readonly answer: (text: string) => void, private readonly thought: (text: string) => void) {}

  /** Feed raw content; thought text never reaches the answer callback. */
  push(text: string): void {
    if (this.state === "answer") { this.answer(text); return; }
    this.buffer += text;
    for (;;) {
      if (this.state === "prefix") {
        const candidate = this.buffer.trimStart();
        const marker = THOUGHT_MARKERS.find(({ open }) => candidate.startsWith(open));
        if (marker) {
          this.buffer = candidate.slice(marker.open.length);
          this.close = marker.close;
          this.state = "thought";
        } else if (THOUGHT_MARKERS.some(({ open }) => open.startsWith(candidate))) {
          return;
        } else {
          this.state = "answer";
          if (this.buffer) this.answer(this.buffer);
          this.buffer = "";
          return;
        }
      }
      const end = this.buffer.indexOf(this.close);
      if (end !== -1) {
        if (end > 0) this.thought(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + this.close.length);
        this.state = "prefix";
        continue;
      }
      // Retain only a possible partial closing marker, streaming everything else.
      let retained = Math.min(this.buffer.length, this.close.length - 1);
      while (retained > 0 && !this.close.startsWith(this.buffer.slice(-retained))) retained--;
      const available = this.buffer.length - retained;
      if (available > 0) this.thought(this.buffer.slice(0, available));
      this.buffer = this.buffer.slice(available);
      return;
    }
  }

  /** Flush an unfinished thought as reasoning, never as an answer. */
  finish(): void {
    if (this.buffer) (this.state === "thought" ? this.thought : this.answer)(this.buffer);
    this.buffer = "";
  }
}

/** Prepare Gemma's outgoing history; retain reasoning only in the active tool sequence. */
export function gemmaMessages(messages: ChatMessage[], reasoningFromIndex = messages.length): ChatMessage[] {
  return messages.map((message, index) => {
    let content = message.content;
    let inlineReasoning = "";
    if (message.role === "assistant" && typeof content === "string") {
      let answer = "";
      const splitter = new ThoughtSplitter(text => { answer += text; }, text => { inlineReasoning += text; });
      splitter.push(content);
      splitter.finish();
      content = answer;
    } else if (message.role === "user" && Array.isArray(content)) {
      // Google's recommended image-before-text order; keep each kind's internal order.
      content = [...content.filter(part => part.type === "image_url"), ...content.filter(part => part.type !== "image_url")];
    }
    const { reasoningContent, ...rest } = message;
    const reasoning = (reasoningContent ?? "") + inlineReasoning;
    return { ...rest, content, ...(message.role === "assistant" && index >= reasoningFromIndex && reasoning ? { reasoningContent: reasoning } : {}) };
  });
}
