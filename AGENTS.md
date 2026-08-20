# AGENTS.md

Discord bot bridging guild text channels to any OpenAI-compatible Chat Completions endpoint. Single-package TypeScript (ESM, NodeNext), discord.js v14 + native `fetch`. Node >= 20.

## Commands

- `npm test` — smoke tests: one script (`test/smoke.ts`), plain `node:assert`, no framework, no test selection. Hermetic: mock OpenAI server on an ephemeral port + fake Discord channels; no `.env` or Discord access needed.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run dev` — run from source (tsx); `npm run build` compiles to `dist/`; `npm start` runs the compiled bot.
- No lint, formatter, or CI is configured.

## Gotchas that bite

- Relative imports must use explicit `.js` extensions even in `.ts` files (NodeNext ESM): `import { x } from "./bot/queue.js"`.
- `dist/` is a build artifact (gitignored) — never edit it.
- Code comments in `src/config.ts`, `src/index.ts`, `src/llm/client.ts`, `src/bot/queue.ts`, `src/bot/router.ts` reference `PLAN.md §N`, but PLAN.md is not in the repo.

## Config

- Env via `.env` (gitignored); documented in `.env.example`. Loaded by `import "dotenv/config"` in `src/config.ts`.
- `loadConfig()` calls `process.exit(1)` on missing/invalid env (required: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `MODEL_API_URL`). In tests, exercise the pure `parseConfig(env)` instead.

## Architecture (src/)

- `index.ts` wires everything: `messageCreate` → `bot/router.ts` (guild + text-channel + human filter, mention detection) → `bot/queue.ts` → turn in `index.ts` → `llm/client.ts` + `bot/writer.ts`.
- Queue (`bot/queue.ts`): one turn per channel at a time. The queue only holds *mentions* (pending turns), in arrival order; every trackable message — mention or ambient — is appended to the channel history immediately on `messageCreate`, keyed by its Discord message id. Ambient messages still never trigger a reply. These semantics are pinned by `test/smoke.ts` — preserve them.
- `llm/history.ts`: per-channel in-memory sliding window (last `MODEL_CONTEXT_MAX_MESSAGES`); no persistence, and ambient messages consume the window. Entries are keyed by Discord message id(s) so `messageUpdate`/`messageDelete`/`messageDeleteBulk`/`channelDelete` keep the context in sync with the channel; a chunked bot reply is one entry with one id per chunk (any chunk id resolves it, a chunk edit rebuilds the visible text, a chunk delete drops the whole reply).
- `llm/client.ts`: per-request `AbortController` timeout covers the whole stream. `abort()` must cancel **all** in-flight requests — multiple channels generate concurrently (the queue serializes per channel, not globally).
- `bot/writer.ts`: Discord's 2000-char limit; `splitForDiscord` never splits inside a code fence (closes it, reopens in the next chunk); live-stream preview edits are throttled by `throttleMs`.

## Operational

- The bot needs the **MESSAGE CONTENT privileged intent** enabled in the Discord Developer Portal (app → Bot → Privileged Gateway Intents); without it, message content silently arrives empty.
- `MODEL_ENABLE_IMAGES=true` is a no-op in v1 (warns at startup).
- Async in `test/smoke.ts` is driven with `ticks()` (setImmediate), not real sleeps — follow the pattern when adding tests.
