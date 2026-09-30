import type { Config } from "../config.js";
import { MemoryTools, registerMemoryTools } from "./memorytools.js";
import { ToolRegistry } from "./executor.js";
import { FileTools, registerFileTools } from "./filetools.js";
import { ShellTools, registerShellTools } from "./shelltools.js";
import { WebTools, registerWebTools } from "./webtools.js";
import { ZimTools, registerZimTools } from "./zimtools.js";
import { VaultTools, registerVaultTools } from "./vaulttools.js";

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
      maxResultChars: cfg.tools.maxResultChars,
    });
    clients.push(file);
    registerFileTools(registry, file);
    bullets.push(
      "- file_read, file_write, file_edit: manage the bot's persistent file workspace (paths are relative to its root; file_edit replaces an exact text span).",
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
      "- shell_exec: run /bin/sh on the host, starting in the workspace; returns capped output and exit status.",
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
      "- wikipedia_search, wikipedia_read: offline Wikipedia title/path search and paginated text. Choose mode intro, sections, section or full; query finds targeted excerpts.",
    );
    rules.push("Cite Wikipedia article titles when you use wikipedia_read.");
  }
  if (cfg.tools.vault.enabled) {
    const vault = new VaultTools({
      dir: cfg.tools.vault.dir,
      maxResults: cfg.tools.vault.searchMaxResults,
      scanBudgetMs: cfg.tools.vault.scanBudgetMs,
      maxTextChars: cfg.tools.maxResultChars,
      rgPath: cfg.tools.vault.rgPath,
      // The no-match hint may only point at web_search when the web
      // family is registered too.
      webSearchAvailable: cfg.tools.web.enabled,
    });
    clients.push(vault);
    registerVaultTools(registry, vault);
    bullets.push(
      "- vault_search, vault_read, vault_links: offline Wikipedia title/text search, paginated markdown and outgoing links. Choose mode intro, sections, section or full; query finds targeted excerpts.",
    );
    rules.push("Cite the vault note titles when you use vault_read.");
  }
  if (cfg.tools.memory.enabled) {
    const memory = new MemoryTools(cfg.tools.memory.file, cfg.tools.memory.maxBytes, cfg.tools.maxResultChars);
    registerMemoryTools(registry, memory);
    bullets.push("- memory: save, read, search, list or delete persistent named notes shared across bot conversations.");
    rules.push("Search relevant memory before relying on remembered facts; include user/channel identity in note keys when appropriate.");
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
