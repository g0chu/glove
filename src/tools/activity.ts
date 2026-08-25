import { sanitizeForDiscord, truncateActivityContent } from "../bot/format.js";
import type { ToolCall } from "../llm/client.js";
import { parseToolArgs } from "./executor.js";

/** One line's icon, by tool family. */
function iconFor(name: string): string {
  if (name.startsWith("web_")) return "🔎";
  if (name.startsWith("file_")) return "📁";
  if (name.startsWith("wikipedia_")) return "📚";
  if (name.startsWith("shell_")) return "🐚";
  return "🔧";
}

/**
 * Render one argument value for display: strings are quoted, everything
 * else JSON-ified; whitespace is collapsed (one line per call) and long
 * values are truncated. Asterisks are dropped — the whole line is wrapped
 * in italics and a `*` from the model would break the markdown.
 */
function argValue(v: unknown): string {
  let s: string;
  if (typeof v === "string") {
    s = v.replace(/\s+/g, " ").trim();
  } else {
    s = JSON.stringify(v) ?? String(v);
  }
  s = s.replace(/\*/g, "");
  s = truncateActivityContent(s);
  return typeof v === "string" ? `"${s}"` : s;
}

/**
 * Format one tool call as a short activity line for Discord — what the bot
 * is doing, not what it found (the results are deliberately never shown).
 * Up to two arguments are shown; the line is sanitized (model-supplied args
 * may contain math markup) and wrapped in italics.
 */
export function formatToolCall(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = parseToolArgs(call.arguments);
  } catch {
    // Unparseable args: show the name only (the call will fail and the
    // model sees the error as a tool result).
  }
  const names = Object.keys(args);
  let detail = "";
  if (names.length > 0) {
    const shown = names.slice(0, 2).map((k) => `${k}=${argValue(args[k])}`);
    detail = `(${shown.join(", ")}${names.length > 2 ? ", …" : ""})`;
  }
  return sanitizeForDiscord(`${iconFor(call.name)} *${call.name}${detail}*`);
}
