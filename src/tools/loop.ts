import type { ChatMessage, ChatResult, StreamCallbacks, ToolCall, ToolSpec } from "../llm/client.js";
import { executeToolCalls, ToolRegistry, type ToolResultMessage } from "./executor.js";

/**
 * One executed tool round of a turn: the model's answer for the round (its
 * text and reasoning) plus the calls it requested and their results — the
 * whole conversation fragment the model will see in the next round, and
 * what the caller records in the channel history.
 */
export interface ToolRound {
  /** The round's assistant text ("" when the model only called tools). */
  content: string;
  /** The round's reasoning, when the endpoint sent it. */
  reasoning?: string;
  /** The tool calls the model requested. */
  calls: ToolCall[];
  /** The executed results, one per call, in call order. */
  results: ToolResultMessage[];
}

/**
 * One full "tool turn": keep calling the model until it answers with plain
 * content, executing the tools it asks for in between.
 *
 * Kept pure (all I/O via `deps.chat`) so the loop is unit-testable without
 * a model, the network, or Discord. The intermediate assistant/tool messages
 * are appended to the caller's `messages` array (the next round continues
 * with them — including each round's reasoning, sent back as
 * `reasoning_content`), and reported to the caller via `onRoundComplete` so
 * the whole turn can be recorded in the channel history.
 */
export interface ToolTurnDeps {
  /**
   * One model request. `tools` is the registry's spec list (or undefined
   * when no tool is registered). The stream callbacks, if any, belong to
   * the caller (e.g. the live writer). `signal`, when the turn has one
   * (see `signal` below), is the turn's abort signal.
   */
  chat: (
    messages: ChatMessage[],
    callbacks?: StreamCallbacks,
    tools?: ToolSpec[],
    signal?: AbortSignal,
  ) => Promise<ChatResult>;
  registry: ToolRegistry;
  /** Max number of tool-execution rounds before the turn is cut off. */
  maxRounds: number;
  /**
   * When provided, it is passed to every model call of the turn, so the
   * caller can abort the in-flight request mid-turn (the channel-activity
   * interruption, see index.ts: the channel changed while the prompt was
   * being processed). An already-aborted signal makes the next call fail
   * with the client's interruption error, which the caller turns into a
   * quiet-wait, after which the turn is discarded (a newer turn supersedes
   * it) or retried. Tool calls that are already executing run to
   * completion (they have their own deadlines); only model calls are
   * aborted.
   */
  signal?: AbortSignal;
  /**
   * Called right after a response that contains tool calls is fully
   * received (and before the next round starts) — never for the cutoff
   * round, whose text the caller's `finish()` posts as the final reply.
   * The caller uses this to settle the round's streamed preview *text* in
   * place (the round's narration stays in the channel between the
   * tool-activity lines) and to complete the round's thinking into a
   * terminal line so the reasoning shows up between the tool-activity
   * messages. Awaited: the caller settles the round's messages (and learns
   * their ids) before the tool activity is posted.
   */
  onToolRound?: () => void | Promise<void>;
  /**
   * Called with the calls about to execute, right before execution starts
   * (awaited, so any posted activity messages land first). The caller uses
   * this to surface what the tools are doing — one persistent message per
   * call; the results themselves stay internal (they only reach the model).
   */
  onToolCalls?: (calls: ToolCall[]) => void | Promise<void>;
  /**
   * Called once per executed round, after the results are in (and appended
   * to `messages`): the caller records the round in the channel history
   * (text, reasoning, calls and results — the turn's conversation is
   * preserved in full, not just the final reply).
   */
  onRoundComplete?: (round: ToolRound) => void;
}

export interface ToolTurnOutcome {
  /** The model's final answer text ("" when it produced none). */
  content: string;
  /** How many tool rounds actually executed. */
  toolRounds: number;
  /** True when the turn was cut off at maxRounds while the model still wanted tools. */
  exhausted: boolean;
  /** The final round's reasoning, when the endpoint sent it. */
  reasoning?: string;
}

export async function runToolTurn(messages: ChatMessage[], deps: ToolTurnDeps): Promise<ToolTurnOutcome> {
  const tools = deps.registry.specs();
  let toolRounds = 0;
  for (;;) {
    const res = await deps.chat(messages, undefined, tools.length > 0 ? tools : undefined, deps.signal);
    if (res.toolCalls.length === 0) {
      const out: ToolTurnOutcome = { content: res.content, toolRounds, exhausted: false };
      if (res.reasoning) out.reasoning = res.reasoning;
      return out;
    }
    if (toolRounds >= deps.maxRounds) {
      // The model still wants tools but the budget is spent: stop and let
      // the caller post what it has (possibly nothing at all). This round
      // is the turn's last — its text is the final reply (posted and
      // recorded by the caller's `finish()`, which also completes the
      // round's thinking line), so no onToolRound: the text is not
      // transient here. Its (unexecuted) tool calls are not recorded either:
      // they were never run, so a history carrying them would be invalid
      // (an assistant's calls must be answered by tool results).
      const out: ToolTurnOutcome = { content: res.content, toolRounds, exhausted: true };
      if (res.reasoning) out.reasoning = res.reasoning;
      return out;
    }
    await deps.onToolRound?.();
    await deps.onToolCalls?.(res.toolCalls);
    const results = await executeToolCalls(deps.registry, res.toolCalls);
    const round: ToolRound = { content: res.content, calls: res.toolCalls, results };
    if (res.reasoning) round.reasoning = res.reasoning;
    // The next round continues with the round's full conversation: text,
    // reasoning (sent back so a reasoning model continues its own thinking)
    // and the tool results.
    const assistant: ChatMessage = { role: "assistant", content: res.content, toolCalls: res.toolCalls };
    if (res.reasoning) assistant.reasoningContent = res.reasoning;
    messages.push(assistant);
    for (const r of results) messages.push(r);
    deps.onRoundComplete?.(round);
    toolRounds++;
  }
}
