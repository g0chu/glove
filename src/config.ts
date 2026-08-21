import "dotenv/config";

export interface DiscordConfig {
  token: string;
  applicationId: string | null;
  guildId: string;
  typingIntervalMs: number;
  streamUpdateThrottleMs: number;
}

export interface ModelConfig {
  apiUrl: string;
  apiKey: string;
  name: string;
  enableImages: boolean;
  stream: boolean;
  systemPrompt: string;
  contextMaxMessages: number;
  timeoutMs: number;
}

/** One tool family (web, file): a Dockerized sidecar the bot calls locally. */
export interface ToolFamilyConfig {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
}

export interface ToolsConfig {
  web: ToolFamilyConfig;
  file: ToolFamilyConfig;
  /** Max tool-execution rounds per turn before the turn is cut off. */
  maxRounds: number;
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
  const guildId = required("DISCORD_GUILD_ID");
  const apiUrl = required("MODEL_API_URL");
  if (apiUrl) httpUrlOk("MODEL_API_URL", apiUrl);

  const webBaseUrl = optional("WEBTOOLS_BASE_URL", "http://127.0.0.1:8377");
  const fileBaseUrl = optional("FILETOOLS_BASE_URL", "http://127.0.0.1:8378");
  httpUrlOk("WEBTOOLS_BASE_URL", webBaseUrl);
  httpUrlOk("FILETOOLS_BASE_URL", fileBaseUrl);

  const config: Config = {
    discord: {
      token,
      applicationId: env.DISCORD_APPLICATION_ID?.trim() || null,
      guildId,
      typingIntervalMs: intEnv("DISCORD_TYPING_INTERVAL_MS", 5000, 1000),
      streamUpdateThrottleMs: intEnv("DISCORD_STREAM_UPDATE_THROTTLE_MS", 2000, 500),
    },
    model: {
      apiUrl,
      apiKey: optional("MODEL_API_KEY", "none"),
      name: optional("MODEL_NAME", "local"),
      enableImages: boolEnv("MODEL_ENABLE_IMAGES", false),
      stream: boolEnv("MODEL_STREAM", true),
      systemPrompt: optional("MODEL_SYSTEM_PROMPT", ""),
      contextMaxMessages: intEnv("MODEL_CONTEXT_MAX_MESSAGES", 20, 1),
      timeoutMs: intEnv("MODEL_TIMEOUT_S", 120, 1) * 1000,
    },
    tools: {
      // Off by default: not every Chat Completions endpoint supports
      // function calling, and the sidecars must be running first.
      web: {
        enabled: boolEnv("WEBTOOLS_ENABLED", false),
        baseUrl: webBaseUrl,
        // Generous: the browser fallback can take a while on slow pages.
        timeoutMs: intEnv("WEBTOOLS_TIMEOUT_S", 90, 1) * 1000,
      },
      file: {
        enabled: boolEnv("FILETOOLS_ENABLED", false),
        baseUrl: fileBaseUrl,
        timeoutMs: intEnv("FILETOOLS_TIMEOUT_S", 30, 1) * 1000,
      },
      maxRounds: intEnv("TOOLS_MAX_ROUNDS", 5, 1),
    },
  };

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
