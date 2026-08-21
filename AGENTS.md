# AGENTS.md

Discord bot bridging guild text channels to any OpenAI-compatible Chat Completions endpoint. Single-package TypeScript (ESM, NodeNext), discord.js v14 + native `fetch`. Node >= 20.

**Current state:** both tool families run in-process in the bot — the web tools (`web_search`/`web_fetch`) in `src/tools/web/` (ssrf, fetcher, extract, search, cache) behind the `WebTools` class, and the file tools in `src/tools/file/` (paths, ops) behind the `FileTools` class over the `./workspace` directory. No sidecars, no Docker — the Python sidecar (`tools/`) and `docker-compose.yml` were removed once the last tool family moved in-process.

## 1. Project Overview & Architecture

@mention the bot in a text channel of the configured guild → the channel's recent conversation is sent to the model → the answer is streamed back as a live-edited message, chunked at Discord's 2000-char limit.

- `src/` — the bot (compiled to `dist/`):
  - `index.ts` wires everything: `messageCreate` → `bot/router.ts` (guild + text-channel + human filter, mention detection) → `bot/queue.ts` → the turn in `index.ts` → `llm/client.ts` + `bot/writer.ts`.
  - `config.ts` (env parsing), `log.ts` (logging/error helpers), `bot/` (client, router, queue, writer), `llm/` (client, history), `tools/` (registry/executor, tool loop, in-process `WebTools` + `FileTools` and their `web/`/`file/` modules).
- `test/smoke.ts` — bot smoke tests (single script, no framework).
- `workspace/` — the bot's persistent file workspace (gitignored, accessed directly by the bot process); `dist/` — build artifact (gitignored).

Key semantics — **pinned by `test/smoke.ts`, preserve them**:

- **Queue** (`bot/queue.ts`): one turn per channel at a time. The queue only holds *mentions* (pending turns), in arrival order; every trackable message — mention or ambient — is appended to the channel history immediately on `messageCreate`, keyed by its Discord message id. Ambient messages still never trigger a reply.
- **History** (`llm/history.ts`): per-channel in-memory sliding window (last `MODEL_CONTEXT_MAX_MESSAGES`); no persistence, and ambient messages consume the window. Entries are keyed by Discord message id(s) so `messageUpdate`/`messageDelete`/`messageDeleteBulk`/`channelDelete` keep the context in sync; a chunked bot reply is one entry with one id per chunk (any chunk id resolves it, a chunk edit rebuilds the visible text, a chunk delete drops the whole reply).
- **LLM client** (`llm/client.ts`): per-request `AbortController` timeout covers the whole stream. `abort()` must cancel **all** in-flight requests — multiple channels generate concurrently (the queue serializes per channel, not globally). `tools`/`tool_choice:"auto"` are sent only when a non-empty registry is passed; streamed `delta.tool_calls` fragments are reassembled by index.
- **Writer** (`bot/writer.ts`): Discord's 2000-char limit; `splitForDiscord` never splits inside a code fence (closes it, reopens in the next chunk); live-stream preview edits are throttled by `throttleMs`; `discard()` drops an in-progress preview without finishing the turn (used between tool rounds).
- **Tool loop** (`tools/loop.ts`): `runToolTurn` loops model rounds per turn: a round ending in tool calls is transient (its streamed preview is discarded via `onToolRound` → `writer.discard()`), the tools execute concurrently (`tools/executor.ts`), and their results are appended as `tool`-role messages that live only in the turn — **only the final posted reply reaches channel history**, so sliding-window semantics are untouched. `TOOLS_MAX_ROUNDS` caps the rounds; exhaustion with no text posts a note. A broken tool never kills the turn (failures become `Error: …` tool results).
- **Tool security**: `web_fetch` (`src/tools/web/ssrf.ts`) validates URLs against an SSRF blocklist and connects to the *pinned resolved IP* (anti-DNS-rebinding); redirects re-validate hop by hop. File paths (`src/tools/file/paths.ts`) are confined to the workspace with symlink-escape rejection; the operations (`src/tools/file/ops.ts`) refuse binaries, cap reads/writes/searches, and never delete the workspace root.

## 2. Build & Development Commands

```bash
npm install                 # JS deps (package-lock.json present — use npm)
cp .env.example .env        # then fill in your values
npm run dev                 # run from source (tsx)
npm run build               # compile src/ -> dist/ (tsc)
npm start                   # run the compiled bot
npm run typecheck           # tsc --noEmit
```

- Env via `.env` (gitignored), documented in `.env.example`; loaded by `import "dotenv/config"` in `src/config.ts`. Required: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `MODEL_API_URL` — `loadConfig()` calls `process.exit(1)` on missing/invalid values. In tests, exercise the pure `parseConfig(env)` instead.

Operational gotchas:

- The bot needs the **MESSAGE CONTENT privileged intent** enabled in the Discord Developer Portal (app → Bot → Privileged Gateway Intents); without it, message content silently arrives empty.
- `MODEL_ENABLE_IMAGES=true` is a no-op in v1 (warns at startup).
- The model endpoint only speaks tools if its chat template supports function calling (e.g. llama.cpp needs a tool-capable template). If it rejects `tools`, keep `WEBTOOLS_ENABLED`/`FILETOOLS_ENABLED` at their `false` defaults.
- The file tools need the `FILETOOLS_WORKSPACE` directory (default `./workspace`) to exist; create it if it's missing. Failures still surface honestly per-call and the turn continues.
- Code comments in `src/config.ts`, `src/bot/queue.ts`, `src/bot/router.ts`, `src/llm/client.ts` reference `PLAN.md §N`, but PLAN.md is not in the repo.

## 3. Testing Guidelines

- `npm test` — bot smoke tests: one script (`test/smoke.ts`), plain `node:assert/strict`, no framework, no test selection (50 check groups). Hermetic: mock OpenAI-compatible server on an ephemeral port, fake Discord channels, injected DNS/search backends, temp workspace directories; no `.env`, Discord, Docker, or network access. Covers config parsing, history window, code-fence chunking, queue, writer (incl. `discard()`), the executor, the tool loop, the in-process web tools (SSRF guard, cache, extraction, search) and file tools (path confinement, all file ops), and the LLM client (SSE, non-stream, errors, timeouts, `abort()`, tool-call wire shapes).
- Run it plus `npm run typecheck`. Note: `tsx` does not typecheck — a green `npm test` does not imply a green typecheck.
- Async in `test/smoke.ts` is driven with `ticks()` (`setImmediate`), not real sleeps — follow the pattern when adding tests. Shape: one block per area, `ok(name)` check groups, a final "N check groups passed" line.
- The queue/history/chunking/writer/loop/client semantics in section 1 are pinned by tests — don't change them without updating the tests in the same change.

## 4. Code Style & Naming Conventions

TypeScript (`src/`):

- `tsconfig.json`: `strict`, `ES2022`, `NodeNext`. **Relative imports must use explicit `.js` extensions even in `.ts` files**: `import { x } from "./bot/queue.js"`.
- 2-space indent, double quotes, semicolons, trailing commas in multi-line literals.
- `import type` for type-only imports; interfaces for option/config objects (`LlmClientOptions`, `WebToolsOptions`, …); classes use constructor parameter properties (`private readonly`).
- Explicit return-type annotations on exported functions (`export function parseConfig(env: NodeJS.ProcessEnv): ParseResult`).
- Naming: PascalCase types/classes, camelCase functions/methods, `UPPER_SNAKE_CASE` constants (`MAX_RESULT_CHARS`, `BLOCKED_V4`), numeric separators in large literals (`200_000`).
- JSDoc `/** */` on exported symbols describing behavior/contracts; `//` comments for non-obvious "why". Error messages are lowercase, no trailing period (`"could not reach model endpoint …"`); log via `src/log.ts` (`log.info/warn/error`, `errMsg(err)`).
- Failures are thrown as `Error`/`ToolError` with human-readable messages; in the tool path they surface as `Error: …` tool results the model can react to.

No linter, formatter, or CI is configured — match the surrounding code by eye.

## 5. Working Agreements

- **Dependencies**: runtime deps are deliberately minimal (only `discord.js` + `dotenv`; HTTP is native `fetch`, no SSE library, no browser). Do not add runtime dependencies without confirming with the user first.
- **Never edit or commit**: `dist/`, `workspace/`, `.env`, `node_modules/` — all gitignored, and `workspace/` is live bot data.
- **Commits**: the user drives commits — don't commit unless explicitly asked. Observed style: conventional subjects (`feat: …`).
- **Ask before**: changing queue/history/writer semantics pinned by `test/smoke.ts`; changing the SSRF blocklist or the workspace-confination rules in `src/tools/`; enabling tools in `.env`.
- **Done means green**: `npm test` and `npm run typecheck`.
