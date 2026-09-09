/**
 * Downloading text-file attachments for the model.
 *
 * A message's non-image attachments are turned into context text: the file
 * is downloaded (Discord's own CDN is the only trusted source, as with
 * images) and its content is inlined into the message's context text as a
 * labeled, fenced block, so the model can read shared files. Only readable
 * text is inlined (valid UTF-8 without NUL bytes); anything else — binary
 * content, oversized files, download failures — never throws: it becomes a
 * short note that rides along in the message's text, so the model knows an
 * attachment was there but was not sent.
 */

import type { MessageAttachmentLike } from "../llm/client.js";
import { isImageAttachment } from "../llm/client.js";
import { humanBytes, isDiscordCdnUrl } from "./images.js";
import type { AttachmentStore } from "./attachment-store.js";

/** One downloaded file, ready to inline into the message's context text. */
export interface AttachmentFile {
  /** The formatted block: a header line plus the content in a code fence. */
  text: string;
}

/** What one message's attachments produced: file blocks plus skip notes. */
export interface FileDownload {
  files: AttachmentFile[];
  /** One short Discord-italic note per attachment that could not be sent. */
  notes: string[];
}

/** Injectable fetch (tests pass a fake; production uses the native fetch). */
export type FileFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchFilesOptions {
  /** Archive/cache bytes without bypassing source validation or byte limits. */
  storage?: AttachmentStore;
  /**
   * Test-only: replace the native fetch (e.g. with a local mock server).
   * When set, the Discord-CDN URL validation is skipped — the injected
   * fetch is trusted to guard its own URLs. Never set in production.
   */
  fetchImpl?: FileFetch;
}

const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Hard cap on files inlined per message (inlined text is context-expensive). */
const MAX_FILES_PER_MESSAGE = 3;

/**
 * Heuristic binary filter: a readable file is valid UTF-8 without NUL
 * bytes. The strict decode rejects most binary formats (a zip or image is
 * not valid UTF-8), the NUL byte rejects the rest. An empty file is not
 * text either (the caller notes it as empty).
 */
export function isProbablyText(buf: Buffer): boolean {
  if (buf.byteLength === 0) return false;
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fence long enough to survive the content: a run of backticks inside
 * the file would otherwise close the fence early and let the content
 * escape into the surrounding context text. The default fence is three
 * backticks; any longer run in the content grows it by one.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`{3,}/g) ?? []) {
    if (run.length > longest) longest = run.length;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** One file's context block: a header line, then the content in a fence. */
function formatFileBlock(att: MessageAttachmentLike, size: number, content: string): string {
  const fence = fenceFor(content);
  return `[attachment "${att.name}" (${humanBytes(size)})]:\n${fence}\n${content}\n${fence}`;
}

/**
 * Download the non-image attachments of one message for the model. Image
 * attachments are left to the image pipeline (image_url parts) and are
 * ignored here entirely. Never throws: every problem (non-CDN URL,
 * oversized file, HTTP failure, timeout, binary content) becomes a one-line
 * note instead.
 */
export async function fetchMessageFiles(
  attachments: Iterable<MessageAttachmentLike>,
  maxBytes: number,
  opts: FetchFilesOptions = {},
): Promise<FileDownload> {
  const fetchImpl = opts.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const files: AttachmentFile[] = [];
  const notes: string[] = [];
  const note = (att: MessageAttachmentLike, why: string): void => {
    notes.push(`*[attachment "${att.name}" not sent: ${why}]*`);
  };
  let attempted = 0;
  for (const att of attachments) {
    if (isImageAttachment(att)) continue; // the image pipeline's job
    if (attempted >= MAX_FILES_PER_MESSAGE) {
      note(att, `more than ${MAX_FILES_PER_MESSAGE} files per message`);
      continue;
    }
    if (!opts.fetchImpl && !isDiscordCdnUrl(att.url)) {
      note(att, "not a discord attachment");
      continue;
    }
    if (att.size > maxBytes) {
      note(att, `${humanBytes(att.size)} exceeds the ${humanBytes(maxBytes)} limit`);
      continue;
    }
    attempted++;
    let buf = opts.storage?.load(att) ?? null;
    const cached = buf !== null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      if (!buf) {
        const res = await fetchImpl(att.url, { signal: controller.signal });
        if (!res.ok) {
          note(att, `download failed (HTTP ${res.status})`);
          continue;
        }
        buf = Buffer.from(await res.arrayBuffer());
      }
    } catch {
      note(att, controller.signal.aborted ? "download timed out" : "download failed");
    } finally {
      clearTimeout(timer);
    }
    if (!buf) continue;
    if (buf.byteLength > maxBytes) {
      note(att, `${humanBytes(buf.byteLength)} exceeds the ${humanBytes(maxBytes)} limit`);
      continue;
    }
    if (!cached) opts.storage?.save(att, buf);
    if (!isProbablyText(buf)) {
      note(att, buf.byteLength === 0 ? "empty file" : "binary content");
      continue;
    }
    // A leading BOM is valid text but noise for the model.
    const content = buf.toString("utf8").replace(/^\uFEFF/, "");
    files.push({ text: formatFileBlock(att, buf.byteLength, content) });
  }
  return { files, notes };
}
