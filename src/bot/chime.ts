import timers from "node:timers/promises";
import type { ChatMessage, ChatResult, ChatRequestOptions, ToolCall, ToolSpec } from "../llm/client.js";
import { InterruptedError, isInterruptedError, ModelConnectionError, systemInstructionMessage } from "../llm/client.js";
import { isContextOverflowError } from "../llm/context.js";
import { errMsg, log, truncate } from "../log.js";

/** Decision instructions appended AFTER the shared chat context for prefix reuse, as plain sentences in the imperative. */
export const CHIME_SYSTEM_PROMPT =
  "Decide whether to join the conversation after the newest user-role message (a Discord participant, possibly a bot). " +
  "Use the surrounding conversation. " +
  "Return exactly one chime tool call with a boolean respond and a short string reason about whether a reply is useful. " +
  "Do not return chat text or other tool calls; JSON in text is not a tool call. Even respond=true leaves the answer to a separate reply request.";

/** Keep tool definitions and their order identical across decision and reply requests. */
export function chimeTools(tools: ToolSpec[]): ToolSpec[] {
  return [...tools.filter((tool) => tool.name !== CHIME_TOOL_NAME), CHIME_TOOL_SPEC];
}

/** The name of the tool the chime decision is reported through. */
export const CHIME_TOOL_NAME = "chime";

/**
 * The spec of the chime tool — sent with the decision call so the model
 * reports its answer as a tool call instead of plain text. Decision calls
 * are acknowledged locally; reply calls use the registered reply handler.
 */
export const CHIME_TOOL_SPEC: ToolSpec = {
  name: CHIME_TOOL_NAME,
  description: "Decide whether to join the Discord conversation. Use only for chime decisions, not replies or summaries.",
  parameters: {
    type: "object",
    properties: {
      respond: { type: "boolean", description: "True to reply, false to stay silent." },
      reason: { type: "string", description: "Brief reason for joining or staying silent, not a chat answer." },
    },
    required: ["respond", "reason"],
    additionalProperties: false,
  },
};

/** The model's chime decision: whether to respond, and why. */
export interface ChimeDecision {
  /** YES — the bot should respond (a normal turn runs). */
  respond: boolean;
  /** The model's reason for the decision ("" when the model gave none). */
  reason: string;
}

/** One chat request that can carry a tool spec (the decision sends the chime tool). */
export type ChimeChat = (messages: ChatMessage[], tools?: ToolSpec[], signal?: AbortSignal, options?: ChatRequestOptions) => Promise<ChatResult>;

/**
 * One chime decision: a validated tool call over the shared context in which the
 * model reports its answer as a call of the chime tool (respond + reason).
 * A chime call with usable arguments is the decision — even when chat text or
 * other calls accompany it (the retained exchange keeps only the deciding
 * call); only answers without a successful chime call (plain text, reasoning
 * alone, unrelated tools, broken arguments, empty) get the repair retry.
 * The decision and its repairs send `tool_choice: "required"`, so the answer
 * always carries a tool call and a plain-text answer is impossible; a call of a
 * different tool or broken chime arguments still fail validation and get the repair.
 * `tool_choice` is a request parameter, not prompt content, so forcing it keeps the
 * shared serialized prefix (tools + messages) reusable by the YES reply. Custom
 * guidance supplements the mandatory phase instructions. Unusable answers retry until valid
 * with the same schemas/choice and one replaceable validation reminder, preserving
 * the shared prompt prefix without accumulating rejected responses or instructions.
 * Transient pre-response connection failures get two cancellable delayed retries;
 * HTTP, timeout and permanent connection failures return null and stay silent.
 * An interrupted call (the channel changed while
 * the decision was in flight — the channel-activity interruption) is
 * re-thrown, not swallowed: the turn waits for the channel to go quiet,
 * then discards the decision when a newer message supersedes it (the newer
 * message's own turn decides over the still conversation) or retries it, so
 * a decision interrupted by an edit or a typing indicator is not lost. A
 * context-overflow rejection (the transcript outgrew the model's window
 * since the last measurement) is re-thrown the same way: the turn shrinks
 * the context and retries the decision once, so an overfilled transcript is
 * recovered like a turn's overflow instead of silently dying.
 */
export async function decideChime(
  chat: ChimeChat,
  transcript: ChatMessage[],
  signal?: AbortSignal,
  typing?: { sendTyping: () => Promise<unknown>; intervalMs: number },
  diagnosticContext?: { channelId: string; messageId: string },
  decisionPrompt?: string,
  tools: ToolSpec[] = chimeTools([]),
  onAccepted?: (exchange: ChatMessage[]) => void,
): Promise<ChimeDecision | null> {
  const prefix = diagnosticContext
    ? `channel ${diagnosticContext.channelId}: message ${diagnosticContext.messageId}: ` : "";
  const warn = (message: string): void => log.warn(`${prefix}${message}`);
  let timer: ReturnType<typeof setInterval> | undefined;
  const sendTyping = async (): Promise<void> => {
    try { await typing?.sendTyping(); } catch { /* Discord typing is best-effort. */ }
  };
  if (typing && !signal?.aborted) {
    void sendTyping();
    timer = setInterval(() => { void sendTyping(); }, typing.intervalMs);
    timer.unref?.();
  }
  const custom = decisionPrompt?.trim();
  const instruction = custom
    ? `Custom guidance for deciding whether to reply (subject to the phase rules below):\n${custom}\n\n${CHIME_SYSTEM_PROMPT}`
    : CHIME_SYSTEM_PROMPT;
  const messages: ChatMessage[] = [...transcript, systemInstructionMessage("chime-decision", instruction)];
  let failure = "";
  let connectionRetries = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new InterruptedError();
      const requestMessages: ChatMessage[] = failure === "" ? messages : [...messages, systemInstructionMessage(
        "chime-repair",
        `Invalid decision: ${failure}. Retry with exactly one chime tool call (boolean respond, short string reason), no chat text or other calls.`,
      )];
      let res: ChatResult;
      try {
        res = await chat(
          requestMessages,
          tools,
          signal,
          { toolChoice: "required" },
        );
      } catch (err) {
        if (signal?.aborted) throw new InterruptedError();
        if (isInterruptedError(err) || isContextOverflowError(err)) throw err;
        if (err instanceof ModelConnectionError && err.retryable && connectionRetries < 2) {
          connectionRetries++;
          warn(`chime connection failed: ${errMsg(err)}; retrying (${connectionRetries}/2)`);
          try {
            await timers.setTimeout(250 * connectionRetries, undefined, { signal });
          } catch (delayError) {
            if (signal?.aborted) throw new InterruptedError();
            throw delayError;
          }
          continue;
        }
        warn(`chime decision failed: ${errMsg(err)}; staying silent`);
        return null;
      }
      connectionRetries = 0;
      if (signal?.aborted) throw new InterruptedError();
      if (res.usage?.cachedInput !== undefined) {
        log.info(`${prefix}chime prompt cache: ${res.usage.cachedInput}/${res.usage.input} input tokens reused`);
      }
      res = separateDecisionReasoning(res);
      const validation = validateDecision(res);
      if (validation.ok) {
        const decision = validation.decision;
        onAccepted?.([
          ...requestMessages.slice(transcript.length),
          // Only the deciding call is retained: any other calls in the answer
          // were never executed, and a history carrying them without results
          // would be invalid.
          { role: "assistant", content: res.content, reasoningContent: res.reasoning, toolCalls: [validation.call] },
          { role: "tool", name: CHIME_TOOL_NAME, toolCallId: validation.call.id, content: JSON.stringify(decision) },
          systemInstructionMessage("chime-result", decision.respond
            ? "Decision complete: a separate request may now reply to this message."
            : "Decision complete: no reply to this message. Later requests are independent."),
        ]);
        return decision;
      }
      failure = validation.failure;
      warn(`chime decision unusable: ${failure}`);
      // Yield even for an immediately resolved client so activity can cancel retries.
      await timers.setImmediate();
    }
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

/** Recognize explicitly marked leading thinking without guessing whether prose is a chat answer. */
function separateDecisionReasoning(res: ChatResult): ChatResult {
  let content = res.content;
  const reasoning: string[] = res.reasoning ? [res.reasoning] : [];
  let found = false;
  while (true) {
    const block = /^\s*(?:<(think|analysis)>([\s\S]*?)<\/\1>|<\|channel>thought\b([\s\S]*?)<channel\|>)/.exec(content);
    if (!block) break;
    found = true;
    const thought = (block[2] ?? block[3]).trim();
    if (thought) reasoning.push(thought);
    content = content.slice(block[0].length);
  }
  return found ? { ...res, content, reasoning: reasoning.join("\n\n") } : res;
}

/**
 * Validate a decision with actionable feedback that never quotes model text or
 * reasoning. A chime call with usable arguments is the decision even when chat
 * text or other calls accompany it (no repair); the failure messages cover
 * only answers without a successful chime call.
 */
function validateDecision(res: ChatResult): { ok: true; decision: ChimeDecision; call: ToolCall } | { ok: false; failure: string } {
  for (const call of res.toolCalls) {
    if (call.name !== CHIME_TOOL_NAME) continue;
    const decision = parseChimeArgs(call.arguments);
    if (decision !== null) return { ok: true, decision, call };
  }

  // Keep failures silent in Discord, but make the local log actionable.
  // Reasoning is not a decision and must never be mined for a YES/NO.
  const failure = res.toolCalls.some((c) => c.name === CHIME_TOOL_NAME)
    ? "chime arguments were invalid; expected a JSON object with boolean respond and string reason"
    : res.toolCalls.length > 1
      ? "multiple tool calls were returned; expected exactly one chime call"
      : res.toolCalls.length > 0
        ? "a different tool was called; only chime is allowed in the decision phase"
        : res.content.trim().length > 0
          ? "plain text was returned instead of a chime tool call"
          : res.reasoning?.trim()
            ? "reasoning was returned without a chime tool call; reasoning alone is not a decision"
            : "the response was empty; a chime tool call is required";
  return { ok: false, failure };
}

/**
 * The arguments of a chime tool call as a decision, or null when they carry
 * no usable respond flag (a broken decision). A "yes"/"no" string is
 * tolerated where a boolean was asked for; a missing reason is an empty
 * string (the spec requires it, but endpoints may omit it).
 */
function parseChimeArgs(raw: string): ChimeDecision | null {
  let args: unknown;
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    try {
      args = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const o = args as Record<string, unknown>;
  let respond: boolean | null = null;
  if (typeof o.respond === "boolean") {
    respond = o.respond;
  } else if (typeof o.respond === "string") {
    const u = o.respond.trim().toUpperCase();
    if (u === "YES" || u === "TRUE") respond = true;
    else if (u === "NO" || u === "FALSE") respond = false;
  }
  if (respond === null) return null;
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  return { respond, reason };
}

/**
 * The line posted to the channel when the chime decision is NO (a UI line —
 * like the clear confirmation, it is never tracked in the context). The
 * reason is trimmed, newlines collapsed, and truncated so a long-winded
 * model cannot flood the channel.
 */
export function formatChimeNo(reason: string): string {
  const r = truncate(reason.trim().replace(/\s*\n+\s*/g, " "), 200);
  return r === "" ? "🔕 *chime: no*" : `🔕 *chime: no — ${r}*`;
}

/** A reply-phase decision is acknowledged and retained like every other tool call. */
export async function executeReplyChime(args: Record<string, unknown>): Promise<string> {
  const decision = parseChimeArgs(JSON.stringify(args));
  if (!decision) throw new Error("invalid chime decision arguments");
  return JSON.stringify({ ...decision, instruction: "Reply already underway. Continue answering; do not repeat the decision." });
}
