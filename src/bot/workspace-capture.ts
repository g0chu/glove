/**
 * Saving Discord attachments to the file workspace.
 *
 * Every committed trackable message's attachments — any type, images
 * included — are downloaded from Discord's CDN and saved to the file
 * workspace (FILETOOLS_WORKSPACE, default ./workspace) under their original
 * names, with Discord-style " (2)" suffixes on name collisions. The capture
 * runs in the background, serialized, and is best-effort: a missing
 * workspace, a non-CDN URL, an oversized file or a download failure is a
 * logged skip, never a crash, and an existing file is never overwritten.
 * Saved files survive past the CDN URL expiry and are available to the
 * file/shell tools.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MessageAttachmentLike } from "../llm/client.js";
import { humanBytes, isDiscordCdnUrl } from "./images.js";

/** An attachment (or its download) over the workspace's byte cap. */
class WorkspaceLimitError extends Error {}

/** Hard per-file cap (512 MiB): anything Discord's standard tiers can send. */
export const WORKSPACE_ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024;
/** Deadline per download (ms): background work, aborted on shutdown. */
export const WORKSPACE_ATTACHMENT_TIMEOUT_MS = 600_000;

export interface WorkspaceCaptureOptions {
  /** The file workspace directory to save into (must exist, like the file tools). */
  workspace: string;
  /** Hard cap per saved file (bytes). */
  maxBytes: number;
  /** Deadline per download (ms). */
  timeoutMs: number;
  /** Test-only: replace the native fetch. Production never sets this. */
  fetchImpl?: typeof fetch;
}

/** One attachment saved to the workspace. */
export interface SavedAttachment {
  attachment: MessageAttachmentLike;
  /** The absolute path the file was written to. */
  file: string;
  bytes: number;
}

/** One attachment that was not saved, with the reason. */
export interface SkippedAttachment {
  attachment: MessageAttachmentLike;
  reason: string;
}

/** What one committed message's attachments produced. */
export interface WorkspaceCaptureResult {
  saved: SavedAttachment[];
  skipped: SkippedAttachment[];
}

/**
 * Make an attachment name a safe single path segment: the same character
 * set the archive rejects (path separators, control characters, Windows
 * reserved characters) replaced, leading dots dropped, trailing
 * spaces/dots dropped, and the name kept under the filesystem's 255-byte
 * filename limit (the extension is preserved). An empty result becomes
 * "attachment".
 */
export function safeWorkspaceName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[ .]+$/, "");
  if (cleaned === "") return "attachment";
  const extension = /\.[a-zA-Z0-9]{1,16}$/.exec(cleaned)?.[0] ?? "";
  const characters = [...(extension ? cleaned.slice(0, -extension.length) : cleaned)];
  while (characters.length > 0 && Buffer.byteLength(characters.join("") + extension) > 200) characters.pop();
  return (characters.join("") || "attachment") + extension;
}

/**
 * The workspace directory to save into, or null when the configured path
 * does not exist or is not a directory (the file workspace must exist,
 * like for the file tools — it is not created here).
 */
export function resolveWorkspaceDir(workspace: string): string | null {
  try {
    const resolved = fs.realpathSync(path.resolve(workspace));
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * The destination path for a saved name: the name itself when free,
 * otherwise Discord-style collision suffixes ("name (2).ext",
 * "name (3).ext", …) — an existing file is never overwritten.
 */
export function uniqueDestination(dir: string, name: string): string {
  const candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const extension = path.extname(name);
  const stem = extension === "" ? name : name.slice(0, -extension.length);
  for (let n = 2; ; n++) {
    const next = path.join(dir, `${stem} (${n})${extension}`);
    if (!fs.existsSync(next)) return next;
  }
}

/**
 * Download one committed message's attachments into the workspace. Never
 * throws: every problem (missing workspace, non-CDN URL, oversized file,
 * HTTP failure, timeout, disk error) becomes a skip with a reason. Writes
 * are atomic (temp file + rename), so a concurrent file/shell tool never
 * sees a half-written file, and redirects are refused like for the
 * archive capture.
 */
export async function captureWorkspaceAttachments(
  attachments: Iterable<MessageAttachmentLike>,
  options: WorkspaceCaptureOptions,
  signal?: AbortSignal,
): Promise<WorkspaceCaptureResult> {
  const result: WorkspaceCaptureResult = { saved: [], skipped: [] };
  const values = [...attachments];
  const skip = (attachment: MessageAttachmentLike, reason: string): void => {
    result.skipped.push({ attachment, reason });
  };
  const root = resolveWorkspaceDir(options.workspace);
  if (root === null) {
    const why = `workspace ${path.resolve(options.workspace)} does not exist or is not a directory`;
    for (const attachment of values) skip(attachment, why);
    return result;
  }
  const fetchImpl = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  for (const attachment of values) {
    if (signal?.aborted) { skip(attachment, "shutdown"); continue; }
    if (!isDiscordCdnUrl(attachment.url)) { skip(attachment, "not a discord attachment"); continue; }
    if (!Number.isFinite(attachment.size) || attachment.size < 0) {
      skip(attachment, "attachment size is unknown");
      continue;
    }
    if (attachment.size > options.maxBytes) {
      skip(attachment, `${humanBytes(attachment.size)} exceeds the ${humanBytes(options.maxBytes)} workspace limit`);
      continue;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs);
    let bytes: Buffer | null = null;
    try {
      const response = await fetchImpl(attachment.url, { signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) > options.maxBytes) {
        await response.body?.cancel();
        throw new WorkspaceLimitError(`download exceeds the ${humanBytes(options.maxBytes)} workspace limit`);
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
              throw new WorkspaceLimitError(`download exceeds the ${humanBytes(options.maxBytes)} workspace limit`);
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      bytes = Buffer.concat(chunks, size);
    } catch (error) {
      if (error instanceof WorkspaceLimitError) skip(attachment, error.message);
      else skip(attachment, controller.signal.aborted ? "download aborted or timed out"
        : `download failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    const dest = uniqueDestination(root, safeWorkspaceName(attachment.name));
    const temp = `${dest}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, dest);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* the temp file is already gone */ }
      skip(attachment, `save failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    result.saved.push({ attachment, file: dest, bytes: bytes.byteLength });
  }
  return result;
}

/**
 * Background capture of committed messages' attachments: saves are
 * serialized (one message at a time, so name-collision checks and writes
 * cannot race) and never block the commit that queued them.
 */
export class WorkspaceAttachmentCapture {
  private tail: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();

  constructor(
    private readonly options: WorkspaceCaptureOptions,
    private readonly onResult?: (result: WorkspaceCaptureResult) => void,
    private readonly onError?: (error: unknown) => void,
  ) {}

  /** Queue a committed message's attachments for saving (a no-op when empty or after stop()). */
  observe(attachments: Iterable<MessageAttachmentLike>): void {
    if (this.controller.signal.aborted) return;
    const values = [...attachments];
    if (values.length === 0) return;
    this.tail = this.tail.then(async () => {
      const result = await captureWorkspaceAttachments(values, this.options, this.controller.signal);
      // A shutdown skip is not news: nothing was saved and the bot is exiting.
      if (this.controller.signal.aborted && result.saved.length === 0) return;
      this.onResult?.(result);
    }).catch((error: unknown) => { this.onError?.(error); });
  }

  /** Abort pending downloads and await the queued saves before the process exits. */
  stop(): Promise<void> {
    this.controller.abort();
    return this.tail;
  }
}
