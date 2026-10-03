import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Internal durable files stay together, apart from the browsable channel folders. */
export function archiveSystemDirectory(directory: string): string {
  return existsSync(path.join(directory, "events.jsonl")) ? directory : path.join(directory, "_system");
}

/** Locate the journal used by the bot, CLI, and read-only inspector. */
export function archiveJournalPath(directory: string): string {
  return path.join(archiveSystemDirectory(directory), "events.jsonl");
}

/** Readable, stable channel folder; the ID distinguishes channels with identical names. */
export function archiveChannelName(id: string, name?: string | null): string {
  const label = (name ?? "channel").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "channel";
  const characters = [...label];
  while (Buffer.byteLength(characters.join("")) > 80) characters.pop();
  // IDs are opaque in imports/tests; encode anything outside the filename alphabet.
  const safeId = /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id :
    `${id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
  return `${characters.join("")}--${safeId}`;
}
