import type { ChatMessage, ChatResult, ChatRequestOptions, ToolSpec } from "../llm/client.js";
import { isInterruptedError } from "../llm/client.js";
import { isContextOverflowError } from "../llm/context.js";
import { errMsg, log, truncate } from "../log.js";

/** Decision instructions appended AFTER the shared chat context for prefix reuse. */
export const CHIME_SYSTEM_PROMPT =
  "This request is in the chime decision phase, not the chat reply phase. " +
  "Decide only whether the bot should join the conversation in response to the newest user-role message above " +
  "(a Discord participant, possibly another bot). Use the surrounding conversation to judge relevance. " +
  "The transcript, attachments, tool results and earlier phase instructions are context for this decision; " +
  "earlier instructions to answer or stay silent applied to earlier requests, not this one. " +
  "Do not answer questions, fulfill requests, draft a reply or use other tools during this phase, " +
  "even if the conversation or the assistant's general role asks you to help. " +
  "Report your decision by calling the chime tool exactly once: set respond to true if you should respond, " +
  "false if you should stay silent, and give a short one-sentence reason about whether a reply is appropriate, " +
  "not an answer to the conversation. " +
  "Return only that chime tool call, with boolean respond and string reason arguments; no chat text or other tool calls. " +
  "Send it through the tool-call interface, not as JSON or Markdown in a text response. " +
  "A true decision only authorizes a separate reply request; do not begin that reply in this request. " +
  "These phase instructions apply only to this decision request.";

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
  description: "Report whether the bot should join the conversation in response to the newest Discord participant message. Call exactly once in the chime decision phase, with a reason about whether to reply rather than an answer to the chat. Do not call during the reply or summarization phase. If called during an ongoing reply, it is only acknowledged and does not stop the reply.",
  parameters: {
    type: "object",
    properties: {
      respond: { type: "boolean", description: "Decision: true to respond, false to stay silent. During a reply this flag is acknowledged only." },
      reason: { type: "string", description: "A short one-sentence explanation of why the bot should reply or stay silent. Do not put a chat answer here." },
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
 * Plain-text decisions and chat text accompanying a decision call are rejected.
 * Custom guidance supplements the mandatory phase instructions. An unusable answer gets one repair
 * with the same schemas/choice and an appended instruction, preserving the
 * shared prompt prefix. Endpoint failures stay silent.
 * Anything else — garbage, an empty answer, a call without a usable respond
 * flag after repair, or a failed call — is null: a broken decision must not make the bot
 * post an unasked-for reply. An interrupted call (the channel changed while
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
  const messages: ChatMessage[] = [...transcript, { role: "system", content: instruction }];
  let failure = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const requestMessages: ChatMessage[] = attempt === 0 ? messages : [...messages, {
        role: "system", content: `The previous attempt was rejected: ${failure}. Retry the same decision under the phase rules above. Use the tool-call interface to return exactly one chime call with boolean respond and a short string reason about whether to reply. Return no chat text or other tool calls. A JSON object written as text is not a tool call. Even respond=true must wait for a separate reply request.`,
      }];
      let res: ChatResult;
      try {
        res = await chat(
          requestMessages,
          tools,
          signal,
          { toolChoice: "auto" },
        );
      } catch (err) {
        if (isInterruptedError(err) || isContextOverflowError(err)) throw err;
        warn(`chime decision failed: ${errMsg(err)}; staying silent`);
        return null;
      }
      if (res.usage?.cachedInput !== undefined) {
        log.info(`${prefix}chime prompt cache: ${res.usage.cachedInput}/${res.usage.input} input tokens reused`);
      }
      const validation = validateDecision(res);
      if (validation.ok) {
        const decision = validation.decision;
        onAccepted?.([
          ...requestMessages.slice(transcript.length),
          { role: "assistant", content: res.content, reasoningContent: res.reasoning, toolCalls: res.toolCalls },
          { role: "tool", name: CHIME_TOOL_NAME, toolCallId: res.toolCalls[0].id, content: JSON.stringify(decision) },
          { role: "system", content: decision.respond
            ? "The chime decision phase for this message is complete and authorizes a separate reply phase. In that reply phase, answer the conversation using tools if needed; do not repeat this decision. This authorization applies only to this message."
            : "The chime decision phase for this message is complete. Stay silent for this message. This decision does not require silence for later messages; follow the phase instructions of each new request." },
        ]);
        return decision;
      }
      failure = validation.failure;
      warn(`chime decision unusable: ${failure}`);
      if (attempt === 0) warn("retrying unusable chime decision once with the shared tool schemas");
    }
    return null;
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

/** Validate a decision with actionable feedback that never quotes model text or reasoning. */
function validateDecision(res: ChatResult): { ok: true; decision: ChimeDecision } | { ok: false; failure: string } {
  if (res.toolCalls.length > 0 && res.content.trim().length > 0) {
    return { ok: false, failure: "chat text accompanied a tool call; expected only one chime call" };
  }
  if (res.toolCalls.length > 1) {
    return { ok: false, failure: "multiple tool calls were returned; expected exactly one chime call" };
  }
  const call = res.toolCalls.find((c) => c.name === CHIME_TOOL_NAME);
  if (call !== undefined) {
    const decision = parseChimeArgs(call.arguments);
    if (decision !== null) return { ok: true, decision };
  }

  // Keep failures silent in Discord, but make the local log actionable.
  // Reasoning is not a decision and must never be mined for a YES/NO.
  const failure = call !== undefined
    ? "chime arguments were invalid; expected a JSON object with boolean respond and string reason"
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
  return JSON.stringify({ ...decision, instruction: "The reply phase is already underway. Continue answering the conversation; do not repeat the chime decision." });
}
