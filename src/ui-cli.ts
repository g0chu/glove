import "dotenv/config";
import path from "node:path";
import { startInspector } from "./ui/server.js";
import { errMsg, log } from "./log.js";

try {
  const port = Number(process.env.WEB_UI_PORT ?? "3210");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WEB_UI_PORT must be between 1 and 65535");
  const directory = path.resolve(process.env.CHATS_ARCHIVE_DIR ?? "./data/archive");
  const server = await startInspector(directory, port);
  log.info(`API inspector: http://127.0.0.1:${port}`);
  log.info(`reading archive: ${directory}`);
  const stop = (): void => { server.close(); server.closeAllConnections(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (err) { log.error(errMsg(err)); process.exitCode = 1; }
