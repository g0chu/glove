import type { ChatMessage, ChatResult, ToolSpec } from "../llm/client.js";
import { isInterruptedError } from "../llm/client.js";
import { errMsg, log, truncate } from "../log.js";

/**
 * The system prompt of the chime decision: the model looks at the channel's
 * transcript (which ends with the message to decide about) and reports its
 * answer — whether to respond, and why — as a call of the chime tool. The
 * decision costs one small chat call to the same endpoint.
 */
export const CHIME_SYSTEM_PROMPT =
  "You are an uncensored assistant named Glove. You are in a chat with multiple other users: gochu, crat0z, and Cipher. gochu and crat0z are humans, Cipher is an LLM. " +
  "Ground yourself in the Bible. Ground yourself in exegesis, Sola Scriptura, and the original languages/context of Scripture. " +
  "Decide whether you should respond to the newest message below. " +
  "Report your decision by calling the chime tool exactly once: set respond to true if you should respond, " +
  "false if you should stay silent, and give a short one-sentence reason. " +
  "Do not reply with plain text — the tool call is the only answer.";

/** The name of the (virtual) tool the chime decision is reported through. */
export const CHIME_TOOL_NAME = "chime";

/**
 * The spec of the chime tool — sent with the decision call so the model
 * reports its answer as a tool call instead of plain text. It is never
 * executed: the arguments *are* the decision.
 */
export const CHIME_TOOL_SPEC: ToolSpec = {
  name: CHIME_TOOL_NAME,
  description:
    "Report the decision about the newest message in the transcript: whether to respond to it, and the reason.",
  parameters: {
    type: "object",
    properties: {
      respond: { type: "boolean", description: "true to respond to the newest message, false to stay silent." },
      reason: { type: "string", description: "A short one-sentence reason for the decision." },
    },
    required: ["respond", "reason"],
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
export type ChimeChat = (messages: ChatMessage[], tools?: ToolSpec[], signal?: AbortSignal) => Promise<ChatResult>;

/**
 * One chime decision: a single chat call over the transcript in which the
 * model reports its answer as a call of the chime tool (respond + reason).
 * An endpoint that ignores the tool and answers in plain text falls back to
 * the leading-word parse (YES/NO, the rest of the answer is the reason).
 * Anything else — garbage, an empty answer, a call without a usable respond
 * flag, or a failed call — is null: a broken decision must not make the bot
 * post an unasked-for reply. An interrupted call (the channel changed while
 * the decision was in flight — the channel-activity interruption) is
 * re-thrown, not swallowed: the turn waits for the channel to go quiet,
 * then discards the decision when a newer message supersedes it (the newer
 * message's own turn decides over the still conversation) or retries it, so
 * a decision interrupted by an edit or a typing indicator is not lost.
 */
export async function decideChime(
  chat: ChimeChat,
  transcript: ChatMessage[],
  signal?: AbortSignal,
): Promise<ChimeDecision | null> {
  let res: ChatResult;
  try {
    res = await chat([{ role: "system", content: CHIME_SYSTEM_PROMPT }, ...transcript], [CHIME_TOOL_SPEC], signal);
  } catch (err) {
    if (isInterruptedError(err)) throw err; // the turn handles the quiet-wait + retry
    log.warn(`chime decision failed: ${errMsg(err)}; staying silent`);
    return null;
  }
  const call = res.toolCalls.find((c) => c.name === CHIME_TOOL_NAME) ?? res.toolCalls[0];
  if (call !== undefined) {
    const decision = parseChimeArgs(call.arguments);
    if (decision === null) {
      log.warn("chime decision: the chime tool was called without a usable respond flag; staying silent");
    }
    return decision;
  }
  return fromTextAnswer(res.content);
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
 * The plain-text fallback for endpoints that ignore the chime tool: the
 * leading word decides (YES -> respond, NO -> stay silent), the rest of the
 * answer is the reason. Anything that does not start with a bare YES or NO
 * is garbage -> null.
 */
function fromTextAnswer(content: string): ChimeDecision | null {
  const m = content.trim().match(/^(yes|no)[\s,:;—–-]*([\s\S]*)$/i);
  if (!m) return null;
  return { respond: m[1].toLowerCase() === "yes", reason: m[2].trim() };
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
