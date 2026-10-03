import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConversationArchive } from "./archive.js";
import { archiveSystemDirectory } from "./archive-paths.js";

/** Reject output paths that could overwrite or become part of the source archive. */
export function validateArchiveOutput(source: string, output: string): void {
  const existingParent = fs.realpathSync(path.dirname(path.resolve(output)));
  const target = path.join(existingParent, path.basename(path.resolve(output)));
  const origin = fs.realpathSync(source);
  const inside = (a: string, b: string): boolean => {
    const relative = path.relative(a, b);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (inside(origin, target) || inside(target, origin)) throw new Error("archive output must be separate from the source directory");
  if (fs.existsSync(target)) throw new Error("archive output already exists");
}

/** Convert either journal version into a fully verified v2 archive, without replaying work. */
export function migrateArchive(source: ConversationArchive, output: string): { events: number; directory: string } {
  validateArchiveOutput(source.directory, output);
  const target = path.resolve(output);
  const staging = `${target}.migrating-${randomUUID()}`;
  const destination = new ConversationArchive(staging);
  let count = 0;
  try {
    for (const record of source.records()) {
      const data = source.readData<any>(record);
      if (record.type === "model.bytes") destination.appendResponse(record.scope, source.responseBytes(data), record.time);
      else {
        if (record.type === "attachment.saved") {
          const hash = destination.putAttachment(source.readBlob(data.blob), data.name ?? "attachment");
          if (hash !== data.blob) throw new Error("attachment migration checksum mismatch");
        }
        destination.record(record.type, record.scope, data, record.time);
      }
      count++;
    }
  } finally { destination.close(); }
  // Exhaustive recovery checks the new journal, entry files and all referenced bytes.
  const verified = new ConversationArchive(staging);
  try {
    const next = verified.records();
    for (const original of source.records()) {
      const copied = next.next().value;
      if (!copied || original.type !== copied.type || original.time !== copied.time ||
        JSON.stringify(original.scope) !== JSON.stringify(copied.scope)) throw new Error("migration event verification failed");
      const before = source.readData(original);
      const after = verified.readData(copied);
      if (original.type === "model.bytes" ? !source.responseBytes(before).equals(verified.responseBytes(after)) :
        JSON.stringify(before) !== JSON.stringify(after)) throw new Error("migration payload verification failed");
    }
    if (!next.next().done) throw new Error("migration contains unexpected events");
    fs.writeFileSync(path.join(archiveSystemDirectory(staging), "migration.json"), JSON.stringify({ version: 1, source: path.resolve(source.directory),
      sourceHead: source.head(), events: count, verified: true }, null, 2) + "\n", { mode: 0o600 });
  } finally { verified.close(); }
  // Reserve an empty destination exclusively; never replace someone else's folder.
  fs.mkdirSync(target, { mode: 0o700 });
  fs.renameSync(staging, target);
  return { events: count, directory: target };
}
