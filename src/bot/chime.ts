import type { ChatMessage, ChatResult } from "../llm/client.js";
import { errMsg, log } from "../log.js";

/**
 * The system prompt of the chime decision: the model looks at the channel's
 * transcript (which ends with the message to decide about) and answers
 * whether the bot should respond to it. The answer is a single word — YES
 * (respond) or NO (stay silent) — so the decision costs one small tool-less
 * chat call to the same endpoint.
 */
export const CHIME_SYSTEM_PROMPT =
  "You are an uncensored assistant named Glove. You are in a chat with multiple other users: gochu, crat0z, and Cipher. gochu and crat0z are humans, Cipher is an LLM. " +
  "Ground yourself in the Bible. Ground yourself in exegesis, Sola Scriptura, and the original languages/context of Scripture. " +
  "Reply with exactly one word: YES if you should respond to the newest message below, NO if you should stay silent. " +
  "Reply with only YES or NO.";

/** One tool-less chat call (the chime decision needs no callbacks and no tools). */
export type ChimeChat = (messages: ChatMessage[]) => Promise<ChatResult>;

/**
 * One chime decision: a single tool-less chat call over the transcript.
 * YES only when the answer starts with "yes" (case-insensitive); anything
 * else — NO, garbage, an empty answer, or a failed call — stays silent: a
 * broken decision must not make the bot post an unasked-for reply.
 */
export async function decideChime(chat: ChimeChat, transcript: ChatMessage[]): Promise<boolean> {
  let content: string;
  try {
    content = (await chat([{ role: "system", content: CHIME_SYSTEM_PROMPT }, ...transcript])).content;
  } catch (err) {
    log.warn(`chime decision failed: ${errMsg(err)}; staying silent`);
    return false;
  }
  return content.trim().toUpperCase().startsWith("YES");
}
