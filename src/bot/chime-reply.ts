import type { ChatFn } from "../llm/metrics.js";
import type { ChatResult } from "../llm/client.js";
import { isInterruptedError } from "../llm/client.js";
import { isContextOverflowError } from "../llm/context.js";
import { log } from "../log.js";
import { CHIME_TOOL_NAME, chimeTools } from "./chime.js";

/**
 * Advertise the shared schemas without letting the virtual decision tool
 * enter the executable tool loop. Wrap an archived/token-counted chat so
 * every compatibility or repair request is recorded and measured separately.
 */
export function chimeReplyChat(chat: ChatFn, onRepair?: () => Promise<unknown>): ChatFn {
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
    if (!result.toolCalls.some((call) => call.name === CHIME_TOOL_NAME)) return result;
    const withoutChime = (res: ChatResult): ChatResult => ({
      ...res, toolCalls: res.toolCalls.filter((call) => call.name !== CHIME_TOOL_NAME),
    });
    result = withoutChime(result);
    // Preserve an actual answer or executable calls from a mixed response.
    // The decision itself is neither executed nor added to working history.
    if (result.content.trim() || result.toolCalls.length > 0) return result;

    // A decision-only response is not an answer. Nothing has executed, so
    // one repair is safe. Hide chime on this exceptional request to prevent
    // an unknown-tool loop; normal requests retain the shared schemas.
    log.warn("reply returned only a chime decision; retrying once with reply tools");
    await onRepair?.();
    result = withoutChime(await chat([...messages, {
      role: "system",
      content: "The decision phase is over. Answer the preceding conversation now. Do not call chime or decide whether to respond. Use the available tools if needed, or provide the reply text.",
    }], callbacks, realTools, signal, options));
    if (!result.content.trim() && result.toolCalls.length === 0) {
      throw new Error("model did not provide a reply after the chime decision repair");
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
