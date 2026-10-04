import { randomUUID } from "node:crypto";
import type { ConversationArchive, ArchiveScope } from "./archive.js";
import type { ChatFn } from "./metrics.js";
import type { ToolCall } from "./client.js";
import { errMsg } from "../log.js";

/** Parsed output batch; tool fields are fragments, with IDs replacing earlier IDs. */
export interface ModelProgress {
  content: string;
  reasoning: string;
  toolCalls: (ToolCall & { index: number })[];
}

/** Archive structured requests/results and bounded batches of partial model output. */
export function archiveChat(archive: ConversationArchive, scope: ArchiveScope, chat: ChatFn): ChatFn {
  return async (messages, callbacks, tools, signal, options) => {
    const request = { ...scope, requestId: randomUUID() };
    // The wire request callback retains the full input once, before network I/O.
    archive.record("model.started", request, { options });
    let content = "", reasoning = "", size = 0;
    const calls = new Map<number, ToolCall & { index: number }>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let captureFailure: unknown;
    const flush = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (captureFailure) throw captureFailure;
      if (!size) return;
      archive.record("model.progress", request, { content, reasoning, toolCalls: [...calls.values()] } satisfies ModelProgress);
      content = "";
      reasoning = "";
      size = 0;
      calls.clear();
    };
    const changed = (length: number): void => {
      if (captureFailure) throw captureFailure;
      size += length;
      if (size >= 16 * 1024) flush();
      else if (!timer) {
        timer = setTimeout(() => {
          // Archive failures poison the writer and invoke its fatal handler.
          // Retain the error too, for callers without a process-level handler.
          try { flush(); } catch (err) { captureFailure = err; }
        }, 1000);
        timer.unref();
      }
    };
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
        onDelta: (delta) => {
          content += delta;
          changed(delta.length);
          callbacks?.onDelta?.(delta);
        },
        onReasoning: (delta) => {
          reasoning += delta;
          changed(delta.length);
          callbacks?.onReasoning?.(delta);
        },
        onToolCallDelta: (index, delta) => {
          const call = calls.get(index) ?? { index, id: "", name: "", arguments: "" };
          if (delta.id) call.id = delta.id;
          call.name += delta.name ?? "";
          call.arguments += delta.arguments ?? "";
          calls.set(index, call);
          changed((delta.id?.length ?? 0) + (delta.name?.length ?? 0) + (delta.arguments?.length ?? 0) + 1);
          callbacks?.onToolCallDelta?.(index, delta);
        },
      }, tools, signal, options);
      // A completed result supersedes the pending batch; avoid storing it twice.
      if (captureFailure) throw captureFailure;
      archive.record("model.finished", request, result);
      return result;
    } catch (err) {
      flush();
      archive.record("model.failed", request, { error: errMsg(err) });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
