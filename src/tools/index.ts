import type { Config } from "../config.js";
import { ToolRegistry } from "./executor.js";
import { FileTools, registerFileTools } from "./filetools.js";
import { WebTools, registerWebTools } from "./webtools.js";
import { ZimTools, registerZimTools } from "./zimtools.js";

/** Everything abortable the tool stack owns (wired into shutdown). */
export interface ToolsSetup {
  registry: ToolRegistry;
  clients: Array<{ abort(): void }>;
}

/**
 * Build the tool registry from config. A family is registered only when
 * enabled (and the model endpoint must support function calling). With
 * nothing enabled the registry is empty and the model is called exactly as
 * before.
 */
export function buildTools(cfg: Config): ToolsSetup {
  const registry = new ToolRegistry();
  const clients: Array<{ abort(): void }> = [];
  if (cfg.tools.web.enabled) {
    const web = new WebTools({
      timeoutMs: cfg.tools.web.timeoutMs,
      fetchMaxBytes: cfg.tools.web.fetchMaxBytes,
      maxRedirects: cfg.tools.web.maxRedirects,
      cacheTtlMs: cfg.tools.web.cacheTtlMs,
      cacheMaxEntries: cfg.tools.web.cacheMaxEntries,
      searchMaxResults: cfg.tools.web.searchMaxResults,
      maxResultChars: cfg.tools.maxResultChars,
    });
    clients.push(web);
    registerWebTools(registry, web);
  }
  if (cfg.tools.file.enabled) {
    const file = new FileTools({
      workspace: cfg.tools.file.workspace,
      readMaxBytes: cfg.tools.file.readMaxBytes,
      writeMaxBytes: cfg.tools.file.writeMaxBytes,
      listMaxEntries: cfg.tools.file.listMaxEntries,
      searchMaxResults: cfg.tools.file.searchMaxResults,
      searchMaxFiles: cfg.tools.file.searchMaxFiles,
      searchMaxFileBytes: cfg.tools.file.searchMaxFileBytes,
      lineMaxChars: cfg.tools.file.lineMaxChars,
      maxResultChars: cfg.tools.maxResultChars,
    });
    clients.push(file);
    registerFileTools(registry, file);
  }
  if (cfg.tools.zim.enabled) {
    const zim = new ZimTools({
      file: cfg.tools.zim.file,
      maxResults: cfg.tools.zim.searchMaxResults,
      scanBudgetMs: cfg.tools.zim.scanBudgetMs,
      maxTextChars: cfg.tools.maxResultChars,
    });
    clients.push(zim);
    registerZimTools(registry, zim);
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
  "- web_fetch: returns a page's main content as text.",
  "- file_list, file_read, file_write, file_edit, file_delete, file_search: manage the bot's persistent file workspace (paths are relative to its root; file_edit replaces an exact text span).",
  "- wikipedia_search, wikipedia_read: an offline Wikipedia archive on this machine (no internet needed) — search article titles, then read the article text. Prefer it for established facts: people, places, events, science topics.",
  "Rules: for current or unknown facts, search and cite the URLs you used in your answer. Cite Wikipedia article titles when you use wikipedia_read. Summarize tool results; do not paste whole pages back. Use the workspace for notes, drafts, and data that should survive across conversations.",
].join("\n");
