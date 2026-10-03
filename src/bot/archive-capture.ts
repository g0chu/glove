import type { ArchiveScope, ConversationArchive } from "../llm/archive.js";
import { attachmentIdentity, type MessageAttachmentLike } from "../llm/client.js";
import { isDiscordCdnUrl } from "./images.js";
import { archiveAttachments } from "./attachment-store.js";

/** Attachment capture limits are independent of model attachment admission. */
export interface ArchiveCaptureOptions {
  enabled: boolean;
  maxBytes: number;
  maxPerMessage: number;
  timeoutMs: number;
  /** Injected transport for hermetic tests; source validation still applies. */
  fetchImpl?: typeof fetch;
}

/** Capture arbitrary file types without decoding, following redirects, or exceeding byte limits. */
export async function captureArchiveAttachments(
  archive: ConversationArchive, scope: ArchiveScope, attachments: Iterable<MessageAttachmentLike>,
  options: ArchiveCaptureOptions, signal?: AbortSignal,
): Promise<void> {
  if (!options.enabled) return;
  let count = 0;
  const storage = archiveAttachments(archive, scope);
  for (const attachment of attachments) {
    const skip = (reason: string): void => { archive.record("attachment.skipped", scope, { ...attachment, reason }); };
    if (signal?.aborted) { skip("shutdown"); continue; }
    if (count++ >= options.maxPerMessage) { skip("per-message attachment limit"); continue; }
    if (!isDiscordCdnUrl(attachment.url)) { skip("not a discord attachment"); continue; }
    if (!Number.isFinite(attachment.size) || attachment.size < 0 || attachment.size > options.maxBytes) {
      skip("attachment exceeds archive byte limit"); continue;
    }
    let bytes = storage.load(attachment);
    if (bytes && bytes.length > options.maxBytes) { skip("attachment exceeds archive byte limit"); continue; }
    if (!bytes) {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, options.timeoutMs);
      try {
        const response = await (options.fetchImpl ?? fetch)(attachment.url, { signal: controller.signal, redirect: "error" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const length = response.headers.get("content-length");
        if (length && Number(length) > options.maxBytes) {
          await response.body?.cancel();
          throw new Error("attachment exceeds archive byte limit");
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.length;
              if (size > options.maxBytes) {
                await reader.cancel();
                throw new Error("attachment exceeds archive byte limit");
              }
              chunks.push(next.value);
            }
          } finally { reader.releaseLock(); }
        }
        bytes = Buffer.concat(chunks, size);
      } catch (error) {
        skip(controller.signal.aborted ? "download aborted or timed out" : `download failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }
    // Disk errors propagate through the archive's fatal write handler.
    storage.save(attachment, bytes);
  }
}

/** Bounded sequential background capture, independent of channel turn scheduling. */
export class ArchiveAttachmentCapture {
  private tail: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();
  private readonly saved = new Set<string>();
  private readonly controller = new AbortController();

  constructor(private readonly archive: ConversationArchive, private readonly options: ArchiveCaptureOptions,
    private readonly onError: (error: unknown) => void) {}

  /** Queue newly observed attachment revisions without blocking Discord event handling. */
  observe(scope: ArchiveScope, attachments: Iterable<MessageAttachmentLike>): void {
    if (!this.options.enabled || this.controller.signal.aborted) return;
    const values = [...attachments];
    if (!values.length) return;
    const key = JSON.stringify([scope.channelId, scope.messageId, values.map(a => [attachmentIdentity(a.url), a.name, a.size])]);
    if (this.pending.has(key) || this.saved.has(key)) return;
    if (this.pending.size >= 256) {
      for (const attachment of values) this.archive.record("attachment.skipped", scope, { ...attachment, reason: "archive download queue is full" });
      return;
    }
    this.pending.add(key);
    this.tail = this.tail.then(async () => {
      await captureArchiveAttachments(this.archive, scope, values, this.options, this.controller.signal);
      if (values.every(a => this.archive.attachment(a.url) !== null)) {
        this.saved.add(key);
        if (this.saved.size > 4096) this.saved.delete(this.saved.values().next().value!);
      }
    }).catch(this.onError).finally(() => { this.pending.delete(key); });
  }

  /** Stop downloads and await queued capture bookkeeping before closing the archive. */
  stop(): Promise<void> { this.controller.abort(); return this.tail; }
}
