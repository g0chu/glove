import "dotenv/config";
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { ConversationArchive } from "./llm/archive.js";
import { exportArchive } from "./llm/archive-layout.js";
import { migrateArchive, validateArchiveOutput } from "./llm/archive-migration.js";
import { errMsg, log } from "./log.js";

const [command, ...args] = process.argv.slice(2);
const directory = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? process.env.CHATS_ARCHIVE_DIR ?? "./data/archive");

try {
  if (!["inspect", "export", "migrate", "purge"].includes(command)) throw new Error("usage: archive <inspect|export|migrate|purge> [directory] [--channel=ID] [--output=DIR] [--confirm]");
  if (!fs.existsSync(path.join(directory, "events.jsonl"))) throw new Error("directory does not contain an archive journal");
  if (command === "purge" && !args.includes("--confirm")) throw new Error("purge requires --confirm; stop the bot first");
  const archive = new ConversationArchive(directory);
  try {
    if (command === "inspect") {
      const types: Record<string, number> = {};
      let lastSequence = 0;
      for (const record of archive.records()) {
        types[record.type] = (types[record.type] ?? 0) + 1;
        lastSequence = record.seq;
      }
      process.stdout.write(JSON.stringify({ directory, lastSequence, types, recoveredTail: archive.recoveredTail,
        incomplete: archive.incomplete(), channels: [...archive.restoreContexts().keys()] }, null, 2) + "\n");
    } else if (command === "export") {
      const channelId = args.find((arg) => arg.startsWith("--channel="))?.slice("--channel=".length);
      const output = args.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
      if (output !== undefined) {
        if (!output) throw new Error("export requires a nonempty output directory");
        validateArchiveOutput(directory, output);
        exportArchive(archive, path.resolve(output), channelId);
        process.stdout.write(`exported conversation folder to ${path.resolve(output)}\n`);
      } else {
        for (const record of archive.records()) {
          if (channelId !== undefined && record.scope.channelId !== channelId) continue;
          if (!process.stdout.write(JSON.stringify({ ...record, payload: archive.readData(record) }) + "\n")) await once(process.stdout, "drain");
        }
      }
    } else if (command === "migrate") {
      const output = args.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
      if (!output) throw new Error("migrate requires --output=DIR; the source archive is retained");
      if (args.some(arg => arg.startsWith("--channel="))) throw new Error("migration requires the whole archive; use export for one channel");
      process.stdout.write(JSON.stringify(migrateArchive(archive, output), null, 2) + "\n");
    } else {
      // Move the owned archive out of the way atomically. A new process
      // starting at the original path cannot be removed by the deletion.
      const removed = `${directory}.purging-${randomUUID()}`;
      fs.renameSync(directory, removed);
      fs.rmSync(removed, { recursive: true });
      process.stdout.write(`purged archive ${directory}; the working CHATS_FILE was not removed\n`);
    }
  } finally { archive.close(); }
} catch (err) {
  log.error(errMsg(err));
  process.exitCode = 1;
}
