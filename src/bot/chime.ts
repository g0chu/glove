import type { ChatMessage, LlmClient } from "../llm/client.js";
import { errMsg, log } from "../log.js";

/**
 * The system prompt of the chime decision: the model looks at the channel's
 * transcript (which ends with the message to decide about) and answers
 * whether the bot should respond to it. The answer is a single word — YES
 * (respond) or NO (stay silent) — so the decision costs one small tool-less
 * chat call to the same endpoint.
 */
export const CHIME_SYSTEM_PROMPT =
  "You are deciding whether a Discord bot should respond to the newest message in the conversation below. " +
  "Reply with exactly one word: YES if the bot should answer that message, NO if it should stay silent. " +
  "Choose NO when the message does not need an answer, is not relevant to the bot, is small talk or " +
  "chatter between other participants, or a reply from the bot would only interrupt. " +
  "Reply with only YES or NO.";

/**
 * One chime decision: a single tool-less chat call over the transcript.
 * YES only when the answer starts with "yes" (case-insensitive); anything
 * else — NO, garbage, an empty answer, or a failed call — stays silent: a
 * broken decision must not make the bot post an unasked-for reply.
 */
export async function decideChime(llm: LlmClient, transcript: ChatMessage[]): Promise<boolean> {
  let content: string;
  try {
    content = (await llm.chat([{ role: "system", content: CHIME_SYSTEM_PROMPT }, ...transcript])).content;
  } catch (err) {
    log.warn(`chime decision failed: ${errMsg(err)}; staying silent`);
    return false;
  }
  return content.trim().toUpperCase().startsWith("YES");
}
