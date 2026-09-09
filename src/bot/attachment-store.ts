import type { ArchiveScope, ConversationArchive } from "../llm/archive.js";
import type { MessageAttachmentLike } from "../llm/client.js";

/** Optional durable byte store, independent of attachment network validation. */
export interface AttachmentStore {
  load: (attachment: MessageAttachmentLike) => Buffer | null;
  save: (attachment: MessageAttachmentLike, bytes: Buffer) => void;
}

/** Preserve downloaded bytes with metadata, and reuse them after CDN expiry. */
export function archiveAttachments(archive: ConversationArchive, scope: ArchiveScope): AttachmentStore {
  return {
    load: (att) => archive.attachment(att.url),
    save: (att, bytes) => {
      const blob = archive.putBlob(bytes);
      archive.record("attachment.saved", scope, { ...att, blob, downloadedBytes: bytes.length });
    },
  };
}
