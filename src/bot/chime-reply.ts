import type { ChatFn } from "../llm/metrics.js";
import type { ChatResult } from "../llm/client.js";
import { isInterruptedError } from "../llm/client.js";
import { isContextOverflowError } from "../llm/context.js";
import { log } from "../log.js";
import { CHIME_TOOL_NAME, chimeTools } from "./chime.js";

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
