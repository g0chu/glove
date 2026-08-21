import type { ChatMessage, ChatResult, StreamCallbacks, ToolCall, ToolSpec } from "../llm/client.js";
import { executeToolCalls, ToolRegistry } from "./executor.js";

/**
 * One full "tool turn": keep calling the model until it answers with plain
 * content, executing the tools it asks for in between.
 *
 * Kept pure (all I/O via `deps.chat`) so the loop is unit-testable without
 * a model, the network, or Discord. The intermediate assistant/tool messages
 * live only in this function's `messages` array — the channel history only
 * ever sees the final posted reply, so the sliding-window semantics are
 * untouched.
 */
export interface ToolTurnDeps {
  /**
   * One model request. `tools` is the registry's spec list (or undefined
   * when no tool is registered). The stream callbacks, if any, belong to
   * the caller (e.g. the live writer).
   */
  chat: (messages: ChatMessage[], callbacks?: StreamCallbacks, tools?: ToolSpec[]) => Promise<ChatResult>;
  registry: ToolRegistry;
  /** Max number of tool-execution rounds before the turn is cut off. */
  maxRounds: number;
  /**
   * Called right after a response that contains tool calls is fully
   * received (and before the next round starts). The caller uses this to
   * discard any streamed preview text — it is transient, not the answer.
   */
  onToolRound?: () => void;
  /**
   * Called with the calls about to execute, right before execution starts
   * (awaited, so any posted activity messages land first). The caller uses
   * this to surface what the tools are doing — one persistent message per
   * call; the results themselves stay internal (they only reach the model).
   */
  onToolCalls?: (calls: ToolCall[]) => void | Promise<void>;
}

export interface ToolTurnOutcome {
  /** The model's final answer text ("" when it produced none). */
  content: string;
  /** How many tool rounds actually executed. */
  toolRounds: number;
  /** True when the turn was cut off at maxRounds while the model still wanted tools. */
  exhausted: boolean;
}

export async function runToolTurn(messages: ChatMessage[], deps: ToolTurnDeps): Promise<ToolTurnOutcome> {
  const tools = deps.registry.specs();
  let toolRounds = 0;
  for (;;) {
    const res = await deps.chat(messages, undefined, tools.length > 0 ? tools : undefined);
    if (res.toolCalls.length === 0) {
      return { content: res.content, toolRounds, exhausted: false };
    }
    if (toolRounds >= deps.maxRounds) {
      // The model still wants tools but the budget is spent: stop and let
      // the caller post what it has (possibly nothing at all).
      deps.onToolRound?.();
      return { content: res.content, toolRounds, exhausted: true };
    }
    deps.onToolRound?.();
    await deps.onToolCalls?.(res.toolCalls);
    const results = await executeToolCalls(deps.registry, res.toolCalls);
    messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
    for (const r of results) {
      messages.push({ role: "tool", toolCallId: r.toolCallId, name: r.name, content: r.content });
    }
    toolRounds++;
  }
}
