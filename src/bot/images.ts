/**
 * Downloading image attachments for the model.
 *
 * A message's attachments are turned into `image_url` content parts
 * (base64 data URIs, the OpenAI multimodal shape). Only Discord's own CDN
 * is a trusted attachment source, and anything that cannot be sent
 * (unsupported type, over the byte cap, download failure) never throws —
 * it becomes a short note that rides along in the message's text, so the
 * model knows an attachment was there but was not sent.
 */

import { SUPPORTED_IMAGE_TYPES } from "../llm/client.js";
import type { MessageAttachmentLike } from "../llm/client.js";

export { isImageAttachment } from "../llm/client.js";
export type { MessageAttachmentLike } from "../llm/client.js";

/** One downloaded image, ready to send as an image_url content part. */
export interface AttachmentImage {
  /** `data:` URI (base64) for the image_url part. */
  url: string;
}

/** What one message's attachments produced: images plus skip notes. */
export interface ImageDownload {
  images: AttachmentImage[];
  /** One short Discord-italic note per attachment that could not be sent. */
  notes: string[];
}

/** Injectable fetch (tests pass a fake; production uses the native fetch). */
export type ImageFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchImagesOptions {
  /**
   * Test-only: replace the native fetch (e.g. with a local mock server).
   * When set, the Discord-CDN URL validation is skipped — the injected
   * fetch is trusted to guard its own URLs. Never set in production.
   */
  fetchImpl?: ImageFetch;
  /**
   * When true, non-image attachments are skipped silently instead of
   * leaving an "unsupported type" note: the file pipeline (file contents
   * enabled) owns them, and noting them here would report the same
   * attachment twice. Default (false) keeps the classic behavior: every
   * attachment that is not a supported image type leaves a note.
   */
  skipNonImages?: boolean;
}

/** Only Discord's own CDN is a trusted attachment source. */
const CDN_HOST = "cdn.discordapp.com";
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Hard cap on images per message (keeps one request from ballooning). */
const MAX_IMAGES_PER_MESSAGE = 4;

/** True when the URL is an https attachment on Discord's CDN. */
export function isDiscordCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === CDN_HOST;
  } catch {
    return false;
  }
}

/** A byte count as a human-readable size (e.g. "1 KB", "2.5 MB"). */
export function humanBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  return `${Math.ceil(n / 1024)} KB`;
}

/**
 * Download the image attachments of one message for the model. Never
 * throws: every problem (unsupported type, non-CDN URL, oversized file,
 * HTTP failure, timeout) becomes a one-line note instead. With
 * `skipNonImages` set, non-image attachments are the file pipeline's job
 * and are skipped silently (no note) — the pipelines are mutually
 * exclusive per attachment type.
 */
export async function fetchMessageImages(
  attachments: Iterable<MessageAttachmentLike>,
  maxBytes: number,
  opts: FetchImagesOptions = {},
): Promise<ImageDownload> {
  const fetchImpl = opts.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const images: AttachmentImage[] = [];
  const notes: string[] = [];
  const note = (att: MessageAttachmentLike, why: string): void => {
    notes.push(`*[attachment "${att.name}" not sent: ${why}]*`);
  };
  let attempted = 0;
  for (const att of attachments) {
    const mime = SUPPORTED_IMAGE_TYPES[att.contentType ?? ""];
    if (!mime) {
      // Non-image attachment: the file pipeline's job when it runs (the
      // caller sets skipNonImages) — noting it here would report the same
      // attachment twice.
      if (!opts.skipNonImages) note(att, `unsupported type ${att.contentType ?? "unknown"}`);
      continue;
    }
    if (attempted >= MAX_IMAGES_PER_MESSAGE) {
      note(att, `more than ${MAX_IMAGES_PER_MESSAGE} images per message`);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetchImpl(att.url, { signal: controller.signal });
      if (!res.ok) {
        note(att, `download failed (HTTP ${res.status})`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        note(att, `${humanBytes(buf.byteLength)} exceeds the ${humanBytes(maxBytes)} limit`);
        continue;
      }
      images.push({ url: `data:${mime};base64,${buf.toString("base64")}` });
    } catch {
      note(att, controller.signal.aborted ? "download timed out" : "download failed");
    } finally {
      clearTimeout(timer);
    }
  }
  return { images, notes };
}
