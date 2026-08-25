import type { Config } from "../config.js";
import { ToolRegistry } from "./executor.js";
import { FileTools, registerFileTools } from "./filetools.js";
import { ShellTools, registerShellTools } from "./shelltools.js";
import { WebTools, registerWebTools } from "./webtools.js";
import { ZimTools, registerZimTools } from "./zimtools.js";

/** Everything abortable the tool stack owns (wired into shutdown). */
export interface ToolsSetup {
  registry: ToolRegistry;
  clients: Array<{ abort(): void }>;
  /**
   * System prompt note listing exactly the registered tool families (null
   * when nothing is registered). Only registered families are advertised:
   * the model must not claim tools it does not have.
   */
  systemNote: string | null;
}

/**
 * Build the tool registry from config. A family is registered only when
 * enabled (and the model endpoint must support function calling). With
 * nothing enabled the registry is empty, the note is null, and the model
 * is called exactly as before.
 */
export function buildTools(cfg: Config): ToolsSetup {
  const registry = new ToolRegistry();
  const clients: Array<{ abort(): void }> = [];
  // The system prompt note, built from exactly the families registered
  // below. Kept short: local models follow compact instructions better.
  const bullets: string[] = [];
  const rules: string[] = [];
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
    bullets.push(
      "- web_search: search DuckDuckGo (title, URL, snippet per result), then web_fetch to read a promising result.",
      "- web_fetch: returns a page's main content as text.",
    );
    rules.push("For current or unknown facts, search and cite the URLs you used in your answer.");
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
    bullets.push(
      "- file_list, file_read, file_write, file_edit, file_delete, file_search: manage the bot's persistent file workspace (paths are relative to its root; file_edit replaces an exact text span).",
    );
    rules.push("Use the workspace for notes, drafts, and data that should survive across conversations.");
  }
  if (cfg.tools.shell.enabled) {
    const shell = new ShellTools({
      cwd: cfg.tools.file.workspace,
      timeoutMs: cfg.tools.shell.timeoutMs,
      maxOutputBytes: cfg.tools.shell.maxOutputBytes,
      maxResultChars: cfg.tools.maxResultChars,
    });
    clients.push(shell);
    registerShellTools(registry, shell);
    bullets.push(
      "- shell_exec: run a shell command in the bot's file workspace via /bin/sh (returns the exit code plus stdout and stderr, capped). Use for what the file tools cannot do: running programs, git, package managers, scripts.",
    );
    rules.push("shell_exec is not sandboxed: prefer read-only or workspace-local commands and never run destructive commands without the user asking.");
  }
  if (cfg.tools.zim.enabled) {
    const zim = new ZimTools({
      file: cfg.tools.zim.file,
      maxResults: cfg.tools.zim.searchMaxResults,
      scanBudgetMs: cfg.tools.zim.scanBudgetMs,
      maxTextChars: cfg.tools.maxResultChars,
      // The no-match hint may only point at web_search when the web
      // family is registered too.
      webSearchAvailable: cfg.tools.web.enabled,
    });
    clients.push(zim);
    registerZimTools(registry, zim);
    bullets.push(
      "- wikipedia_search, wikipedia_read: an offline Wikipedia archive on this machine (no internet needed) — search article titles, then read the article text. Prefer it for established facts: people, places, events, science topics.",
    );
    rules.push("Cite Wikipedia article titles when you use wikipedia_read.");
  }
  const systemNote = bullets.length
    ? [
        "You have tools. Use them instead of guessing when a question needs information you do not have:",
        ...bullets,
        `Rules: ${[...rules, "Summarize tool results; do not paste whole pages back."].join(" ")}`,
      ].join("\n")
    : null;
  return { registry, clients, systemNote };
}
