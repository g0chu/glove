import { randomUUID } from "node:crypto";
import type { ConversationArchive, ArchiveScope } from "./archive.js";
import type { ChatFn } from "./metrics.js";
import { errMsg } from "../log.js";

/** Archive every request, raw response chunk, normalized result and failure. */
export function archiveChat(archive: ConversationArchive, scope: ArchiveScope, chat: ChatFn): ChatFn {
  return async (messages, callbacks, tools, signal, options) => {
    const request = { ...scope, requestId: randomUUID() };
    archive.record("model.started", request, { messages, tools, options });
    try {
      const result = await chat(messages, {
        ...callbacks,
        onRequest: (body) => {
          archive.record("model.request", request, body);
          callbacks?.onRequest?.(body);
        },
        onResponse: (status) => {
          archive.record("model.status", request, { status });
          callbacks?.onResponse?.(status);
        },
        onResponseBytes: (bytes) => {
          archive.record("model.bytes", request, { blob: archive.putBlob(bytes), size: bytes.byteLength });
          callbacks?.onResponseBytes?.(bytes);
        },
      }, tools, signal, options);
      archive.record("model.finished", request, result);
      return result;
    } catch (err) {
      archive.record("model.failed", request, { error: errMsg(err) });
      throw err;
    }
  };
}
