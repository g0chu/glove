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

export interface Config {
  discord: DiscordConfig;
  model: ModelConfig;
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

  const token = required("DISCORD_TOKEN");
  const guildId = required("DISCORD_GUILD_ID");
  const apiUrl = required("MODEL_API_URL");

  if (apiUrl) {
    try {
      const u = new URL(apiUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        errors.push(`MODEL_API_URL must be http(s) (got "${apiUrl}")`);
      }
    } catch {
      errors.push(`MODEL_API_URL is not a valid URL: "${apiUrl}"`);
    }
  }

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
