import type { ChatFn } from "../llm/metrics.js";
import type { ChatResult } from "../llm/client.js";
import { isInterruptedError } from "../llm/client.js";
import { isContextOverflowError } from "../llm/context.js";
import { log } from "../log.js";
import { CHIME_TOOL_NAME, chimeTools } from "./chime.js";

/** Transient instruction for the current reply, appended after the shared history. */
export function replyPhaseInstruction(triggerId: string, messageIndex: number, directMention: boolean): string {
  return `Reply to Discord message ${triggerId} at message index ${messageIndex} (zero-based). ` +
    (directMention
      ? "It mentions you and requires an answer. "
      : "Its chime decision allows an answer. ") +
    "Use the full updated conversation, including later messages and completed tool results. " +
    "Earlier phase instructions apply only to their original requests. Use tools as needed, but do not call chime; a chime acknowledgment does not end this reply. " +
    "Reply text must contain the user-facing answer, not internal planning or thinking-process notes. Keep internal reasoning in the endpoint's separate reasoning field, if supported.";
}

/**
 * Transient continuation instruction appended after the partial generation
 * of an interrupted reply attempt (see index.ts): it keeps the retried
 * attempt locked in with reality — the partial was withdrawn and never
 * delivered, the conversation above is the channel's current state, and the
 * reply now generated is posted fresh as a standalone message.
 */
export function interruptionContinuationInstruction(): string {
  return "Your previous reply attempt was interrupted by activity in this channel (a new message, an edit or a typing indicator) and withdrawn: the preceding assistant message is the partial generation you had produced when it stopped — it was never delivered as a final answer, and no reply for this turn has been posted yet. The conversation above reflects the channel's current state, including everything that arrived or changed since. Continue from the partial generation over the updated conversation: the newer messages may change what you were answering, and the reply you now generate is posted as a fresh standalone message, so make it stand on its own (repeat or rephrase the partial text where it helps). Do not treat the partial text as a delivered answer.";
}

/**
 * Advertise the shared schemas; chime calls use the registered reply handler
 * and remain in the executable loop and its history. Wrap an archived/token-counted
 * chat so every compatibility request is recorded and measured separately.
 */
export function chimeReplyChat(chat: ChatFn): ChatFn {
  let toolFreeEndpoint = false;
  return async (messages, callbacks, tools, signal, options) => {
    const executableTools = tools?.filter((tool) => tool.name !== CHIME_TOOL_NAME) ?? [];
    const realTools = executableTools.length > 0 ? executableTools : undefined;
    let result: ChatResult;
    try {
      result = await chat(messages, callbacks,
        toolFreeEndpoint && !realTools ? undefined : chimeTools(executableTools), signal, options);
    } catch (err) {
      // Only retry an explicit request rejection, with no real tools enabled.
      // Outages, interruption, overflow and generation failures propagate.
      if (realTools || toolFreeEndpoint || !isToolRejection(err)) throw err;
      toolFreeEndpoint = true;
      log.warn("reply endpoint rejected chime tool metadata; retrying without tools");
      result = await chat(messages, callbacks, undefined, signal, options);
    }
    return result;
  };
}

/** Only the client's explicit HTTP 400/422 tool-compatibility rejections qualify. */
function isToolRejection(err: unknown): boolean {
  return err instanceof Error &&
    !isInterruptedError(err) && !isContextOverflowError(err) &&
    /^model endpoint returned HTTP (?:400|422)\b/.test(err.message) &&
    /(?:tools?|tool_choice|function calling)/i.test(err.message) &&
    /(?:not support|unsupported|not (?:allowed|implemented|available)|does not allow|unknown (?:field|parameter)|unrecognized (?:field|parameter))/i.test(err.message);
}
