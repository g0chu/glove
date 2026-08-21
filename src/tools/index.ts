import type { Config } from "../config.js";
import { ToolRegistry } from "./executor.js";
import { FileToolsClient, registerFileTools } from "./filetools.js";
import { WebToolsClient, registerWebTools } from "./webtools.js";

/** Everything abortable the tool stack owns (wired into shutdown). */
export interface ToolsSetup {
  registry: ToolRegistry;
  clients: Array<{ abort(): void }>;
}

/**
 * Build the tool registry from config. A family is registered only when
 * enabled (its sidecar container must be running, and the model endpoint
 * must support function calling). With nothing enabled the registry is
 * empty and the model is called exactly as before.
 */
export function buildTools(cfg: Config): ToolsSetup {
  const registry = new ToolRegistry();
  const clients: Array<{ abort(): void }> = [];
  if (cfg.tools.web.enabled) {
    const client = new WebToolsClient({ baseUrl: cfg.tools.web.baseUrl, timeoutMs: cfg.tools.web.timeoutMs });
    clients.push(client);
    registerWebTools(registry, client);
  }
  if (cfg.tools.file.enabled) {
    const client = new FileToolsClient({ baseUrl: cfg.tools.file.baseUrl, timeoutMs: cfg.tools.file.timeoutMs });
    clients.push(client);
    registerFileTools(registry, client);
  }
  return { registry, clients };
}

/**
 * Appended to the system prompt when at least one tool is registered.
 * Kept short: local models follow compact instructions better.
 */
export const TOOLS_SYSTEM_NOTE: string = [
  "You have tools. Use them instead of guessing when a question needs information you do not have:",
  "- web_search: search DuckDuckGo (title, URL, snippet per result), then web_fetch to read a promising result.",
  "- web_fetch: returns a page's main content as markdown.",
  "- file_list, file_read, file_write, file_edit, file_delete, file_search: manage the bot's persistent file workspace (paths are relative to its root; file_edit replaces an exact text span).",
  "Rules: for current or unknown facts, search and cite the URLs you used in your answer. Summarize tool results; do not paste whole pages back. Use the workspace for notes, drafts, and data that should survive across conversations.",
].join("\n");
