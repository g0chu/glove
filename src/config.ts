import "dotenv/config";

export interface DiscordConfig {
  token: string;
  applicationId: string | null;
  /** The single guild to act in; empty = every guild the bot is a member of. */
  guildId: string;
  typingIntervalMs: number;
  streamUpdateThrottleMs: number;
  /** Show the model's streamed reasoning ("thinking") live, when the endpoint sends it. */
  showReasoning: boolean;
  /** Show which tools are running while a turn executes (names + args; results never shown). */
  showToolActivity: boolean;
  /**
   * The stability window (ms) before a trackable message is committed to the
   * channel context and can queue a turn: the message must be unchanged
   * (no edits) for this long. Other bots stream their replies by editing a
   * posted message as the text arrives, so the window keeps the model from
   * seeing partial text.
   */
  messageStableMs: number;
  /**
   * Chime: with this on, any message that does not mention the bot (a
   * human's or another bot's) still queues a turn in which the model decides
   * (one small call over the channel transcript, answered by calling the
   * chime tool — respond + reason) whether to respond at all — YES runs a
   * normal turn, NO posts the decision + reason as a UI line. Mentions
   * (from any author) always respond.
   */
  chimeEnabled: boolean;
  /** Post chime NO decisions to Discord. */
  showChimeNo: boolean;
  /** Custom chime system prompt; empty uses the built-in prompt. */
  chimePrompt: string;
}

export interface ModelConfig {
  apiUrl: string;
  apiKey: string;
  name: string;
  enableImages: boolean;
  /** Max bytes per downloaded image attachment (bigger ones are skipped). */
  imagesMaxBytes: number;
  /** When true, the text content of non-image attachments is inlined into the context. */
  enableFileContents: boolean;
  /** Max bytes per downloaded file attachment (bigger ones are skipped). */
  fileContentsMaxBytes: number;
  stream: boolean;
  systemPrompt: string;
  /** Last-N seed size / image window. */
  contextMaxMessages: number;
  /**
   * Tokens (measured by the endpoint when it reports usage, else
   * estimated) at which the channel context is compacted — or, when
   * `compactionAuto` is true, the fallback budget until the automatic
   * budget is derived from the server's context window at startup.
   */
  compactionMaxTokens: number;
  /**
   * True when CONTEXT_COMPACTION_MAX_TOKENS is empty: the budget is set
   * automatically from the llama-server's context window at startup
   * (window minus the completion headroom — needs MODEL_METRICS_ENABLED),
   * falling back to `compactionMaxTokens` until it can be derived.
   */
  compactionAuto: boolean;
  /** How many of the newest messages survive a compaction verbatim. */
  compactionKeepMessages: number;
  /** Custom summarization system prompt; empty uses the built-in prompt. */
  compactionPrompt: string;
  /**
   * When true, the bot uses the model side's own tokenizer counts: the
   * turn's token usage is reported per turn, the compaction trigger compares
   * the budget against the endpoint-measured prompt size, and the
   * llama-server's /slots endpoint is probed for the current context state.
   */
  metricsEnabled: boolean;
  /** The llama-server base URL for metrics (default: the chat endpoint's origin). */
  metricsUrl: string;
  /** Per-metrics-request timeout (ms). */
  metricsTimeoutMs: number;
  timeoutMs: number;
  /**
   * The JSON file the per-channel conversation contexts are persisted to
   * (the compactable working history; the durable archive retains originals
   * and takes precedence over this copy on restart).
   */
  chatsFile: string;
  /** Durable append-only history, independent of working-context compaction. */
  archiveDir: string;
}

/** Web tool family (in-process: the bot does the search/fetch itself, no sidecar). */
export interface WebToolsConfig {
  enabled: boolean;
  /** Deadline per search/fetch call. */
  timeoutMs: number;
  /** Max response body bytes kept from a fetch. */
  fetchMaxBytes: number;
  /** Max redirect hops per fetch. */
  maxRedirects: number;
  /** Fetch-result cache entry lifetime. */
  cacheTtlMs: number;
  /** Fetch-result cache size cap. */
  cacheMaxEntries: number;
  /** Hard cap on search results (the tool arg is clamped to this). */
  searchMaxResults: number;
}

/**
 * File tool family (in-process): a persistent workspace directory on the
 * host that the bot can read/write/edit. All paths are confined to the
 * workspace (see src/tools/file/paths.ts).
 */
export interface FileToolsConfig {
  enabled: boolean;
  workspace: string;
  readMaxBytes: number;
  writeMaxBytes: number;
}

/**
 * Shell tool family (in-process): run one shell command via /bin/sh in
 * the file workspace, with a per-command deadline and a combined
 * stdout+stderr output cap (see src/tools/shelltools.ts).
 */
export interface ShellToolsConfig {
  enabled: boolean;
  /** Max deadline per command (ms). */
  timeoutMs: number;
  /** Max combined stdout+stderr bytes kept from one command. */
  maxOutputBytes: number;
}

/**
 * ZIM tool family (in-process): search and read articles from a local
 * offline Wikipedia archive (a ZIM file on disk, see src/tools/zim/).
 */
export interface ZimToolsConfig {
  enabled: boolean;
  /** Path to the ZIM archive file (required when enabled). */
  file: string;
  /** Hard cap on search results (the tool arg is clamped to this). */
  searchMaxResults: number;
  /** Time budget for a full-archive title scan. */
  scanBudgetMs: number;
}

/**
 * Vault tool family (in-process): search and read notes of a local
 * offline Wikipedia vault of markdown notes (one flat note per article,
 * built by the wiki2vault project — see src/tools/vault/).
 */
export interface VaultToolsConfig {
  enabled: boolean;
  /** Path to the vault directory (required when enabled). */
  dir: string;
  /** Hard cap on search results (the tool arg is clamped to this). */
  searchMaxResults: number;
  /** Time budget (ms) for the title scan and the body scan. */
  scanBudgetMs: number;
  /** The ripgrep binary for the body scan ("rg" = from PATH; a missing binary falls back to a bounded JS scan). */
  rgPath: string;
}

export interface ToolsConfig {
  web: WebToolsConfig;
  file: FileToolsConfig;
  shell: ShellToolsConfig;
  zim: ZimToolsConfig;
  vault: VaultToolsConfig;
  /** Max tool-execution rounds per turn before the turn is cut off. */
  maxRounds: number;
  /** Hard cap on characters in one tool result (all families). */
  maxResultChars: number;
}

export interface Config {
  discord: DiscordConfig;
  model: ModelConfig;
  tools: ToolsConfig;
}

export interface ParseResult {
  config: Config;
  errors: string[];
}

/**
 * Pure-ish config parsing (testable without touching process.exit).
 * Defaults follow PLAN.md §2.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): ParseResult {
  const errors: string[] = [];

  const required = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) {
      errors.push(`missing required environment variable: ${name}`);
      return "";
    }
    return v;
  };

  const optional = (name: string, dflt: string): string => {
    const v = env[name]?.trim();
    return v ? v : dflt;
  };

  const intEnv = (name: string, dflt: number, min: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      errors.push(`${name} must be an integer >= ${min} (got "${raw}")`);
      return dflt;
    }
    return n;
  };

  const boolEnv = (name: string, dflt: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return dflt;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    errors.push(`${name} must be a boolean like true/false (got "${raw}")`);
    return dflt;
  };

  const httpUrlOk = (name: string, value: string): boolean => {
    if (!value) return true;
    try {
      const u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        errors.push(`${name} must be http(s) (got "${value}")`);
        return false;
      }
      return true;
    } catch {
      errors.push(`${name} is not a valid URL: "${value}"`);
      return false;
    }
  };

  const token = required("DISCORD_TOKEN");
  // Optional: when empty the bot responds in every text channel of every
  // guild it is a member of (DMs are never tracked).
  const guildId = optional("DISCORD_GUILD_ID", "");
  const apiUrl = required("MODEL_API_URL");
  if (apiUrl) httpUrlOk("MODEL_API_URL", apiUrl);

  const config: Config = {
    discord: {
      token,
      applicationId: env.DISCORD_APPLICATION_ID?.trim() || null,
      guildId,
      typingIntervalMs: intEnv("DISCORD_TYPING_INTERVAL_MS", 5000, 1000),
      streamUpdateThrottleMs: intEnv("DISCORD_STREAM_UPDATE_THROTTLE_MS", 2000, 500),
      showReasoning: boolEnv("DISCORD_SHOW_REASONING", true),
      showToolActivity: boolEnv("DISCORD_SHOW_TOOL_ACTIVITY", true),
      messageStableMs: intEnv("DISCORD_MESSAGE_STABLE_MS", 2000, 0),
      chimeEnabled: boolEnv("BOT_CHIME_ENABLED", false),
      showChimeNo: boolEnv("BOT_CHIME_SHOW_NO", true),
      chimePrompt: optional("BOT_CHIME_PROMPT", ""),
    },
    model: {
      apiUrl,
      apiKey: optional("MODEL_API_KEY", "none"),
      name: optional("MODEL_NAME", "local"),
      enableImages: boolEnv("MODEL_ENABLE_IMAGES", false),
      imagesMaxBytes: intEnv("MODEL_IMAGES_MAX_BYTES", 10_485_760, 1024),
      enableFileContents: boolEnv("MODEL_ENABLE_FILE_CONTENTS", false),
      fileContentsMaxBytes: intEnv("MODEL_FILE_CONTENT_MAX_BYTES", 1_000_000, 1024),
      stream: boolEnv("MODEL_STREAM", true),
      systemPrompt: optional("MODEL_SYSTEM_PROMPT", ""),
      contextMaxMessages: intEnv("MODEL_CONTEXT_MAX_MESSAGES", 20, 1),
      compactionMaxTokens: 0, // filled in below (empty env = automatic budget)
      compactionAuto: false, // filled in below
      compactionKeepMessages: intEnv("CONTEXT_COMPACTION_KEEP_MESSAGES", 20, 1),
      compactionPrompt: optional("CONTEXT_COMPACTION_PROMPT", ""),
      metricsEnabled: boolEnv("MODEL_METRICS_ENABLED", false),
      metricsUrl: optional("MODEL_METRICS_URL", ""),
      metricsTimeoutMs: intEnv("MODEL_METRICS_TIMEOUT_MS", 5000, 100),
      timeoutMs: intEnv("MODEL_TIMEOUT_S", 120, 1) * 1000,
      chatsFile: optional("CHATS_FILE", "./data/chats.json"),
      archiveDir: optional("CHATS_ARCHIVE_DIR", "./data/archive"),
    },
    tools: {
      // Off by default: not every Chat Completions endpoint supports
      // function calling. All families run in-process, so enabling one
      // only needs the env vars below (and, for the file and shell tools,
      // the workspace directory on disk).
      web: {
        enabled: boolEnv("WEBTOOLS_ENABLED", false),
        timeoutMs: intEnv("WEBTOOLS_TIMEOUT_S", 90, 1) * 1000,
        fetchMaxBytes: intEnv("WEBTOOLS_FETCH_MAX_BYTES", 5_000_000, 1_024),
        maxRedirects: intEnv("WEBTOOLS_MAX_REDIRECTS", 5, 0),
        cacheTtlMs: intEnv("WEBTOOLS_CACHE_TTL_S", 300, 0) * 1000,
        cacheMaxEntries: intEnv("WEBTOOLS_CACHE_MAX_ENTRIES", 256, 1),
        searchMaxResults: intEnv("WEBTOOLS_SEARCH_MAX_RESULTS", 10, 1),
      },
      file: {
        enabled: boolEnv("FILETOOLS_ENABLED", false),
        workspace: optional("FILETOOLS_WORKSPACE", "./workspace"),
        readMaxBytes: intEnv("FILETOOLS_READ_MAX_BYTES", 1_000_000, 1_024),
        writeMaxBytes: intEnv("FILETOOLS_WRITE_MAX_BYTES", 5_000_000, 1_024),
      },
      shell: {
        enabled: boolEnv("SHELLTOOLS_ENABLED", false),
        timeoutMs: intEnv("SHELLTOOLS_TIMEOUT_S", 30, 1) * 1000,
        maxOutputBytes: intEnv("SHELLTOOLS_MAX_OUTPUT_BYTES", 100_000, 1_024),
      },
      zim: {
        enabled: boolEnv("ZIMTOOLS_ENABLED", false),
        file: env.ZIM_FILE?.trim() ?? "",
        searchMaxResults: intEnv("ZIMTOOLS_SEARCH_MAX_RESULTS", 8, 1),
        scanBudgetMs: intEnv("ZIMTOOLS_SCAN_BUDGET_S", 10, 1) * 1000,
      },
      vault: {
        enabled: boolEnv("VAULTTOOLS_ENABLED", false),
        dir: env.VAULT_DIR?.trim() ?? "",
        searchMaxResults: intEnv("VAULTTOOLS_SEARCH_MAX_RESULTS", 8, 1),
        scanBudgetMs: intEnv("VAULTTOOLS_SCAN_BUDGET_S", 10, 1) * 1000,
        rgPath: optional("VAULTTOOLS_RG_PATH", "rg"),
      },
      maxRounds: intEnv("TOOLS_MAX_ROUNDS", 5, 1),
      maxResultChars: intEnv("TOOLS_MAX_RESULT_CHARS", 200_000, 1_000),
    },
  };

  if (config.tools.zim.enabled && config.tools.zim.file.length === 0) {
    errors.push("ZIM_FILE is required when ZIMTOOLS_ENABLED is true");
  }
  if (config.tools.vault.enabled && config.tools.vault.dir.length === 0) {
    errors.push("VAULT_DIR is required when VAULTTOOLS_ENABLED is true");
  }

  // The compaction budget: an explicit CONTEXT_COMPACTION_MAX_TOKENS wins;
  // an EMPTY one (the variable is present but blank) means "derive it from
  // the server's context window at startup" (the fallback budget applies
  // until that happens); a missing variable keeps the plain default.
  {
    const raw = env.CONTEXT_COMPACTION_MAX_TOKENS;
    if (raw !== undefined && raw.trim() === "") {
      config.model.compactionAuto = true;
      config.model.compactionMaxTokens = 4000; // fallback until derived
    } else {
      config.model.compactionMaxTokens = intEnv("CONTEXT_COMPACTION_MAX_TOKENS", 4000, 128);
    }
  }

  // Metrics probe the llama-server on the chat endpoint's host by default
  // (llama-server serves /slots next to /v1/chat/completions).
  if (config.model.metricsUrl === "") {
    try {
      config.model.metricsUrl = new URL(apiUrl).origin;
    } catch {
      // MODEL_API_URL failed to parse (already reported above): leave the
      // metrics URL empty; the probes simply fail soft at runtime.
    }
  }
  if (config.model.metricsUrl !== "") httpUrlOk("MODEL_METRICS_URL", config.model.metricsUrl);

  return { config, errors };
}

/** Load and validate config from the environment; fail fast with clear errors. */
export function loadConfig(): Config {
  const { config, errors } = parseConfig();
  if (errors.length > 0) {
    for (const e of errors) console.error(`[config] ${e}`);
    console.error("[config] fix .env and restart");
    process.exit(1);
  }
  return config;
}
