# AGENTS.md

Discord bot bridging guild text channels to any OpenAI-compatible Chat Completions endpoint. Single-package TypeScript (ESM, NodeNext, strict), discord.js v14 + native `fetch`. Node >= 20. No linter, formatter, or CI.

## 1. Project Overview & Architecture

@mention the bot in a text channel of the configured guild and it forwards the channel's recent conversation to the model, streaming the answer back as a live-updating message. Optional in-process tool families (web search/fetch, file workspace) are opt-in via env.

```
src/
  index.ts      entrypoint: Discord event wiring, turn runner, shutdown
  config.ts     env parsing (parseConfig pure / loadConfig exits on error)
  log.ts        timestamped console logging, errMsg/truncate helpers
  bot/          client.ts (discord.js intents), router.ts (trackable/mention
                filters), queue.ts (per-channel FIFO), writer.ts (streaming
                post + chunking), format.ts (LaTeX→Unicode sanitize)
  llm/          client.ts (minimal OpenAI-compatible SSE/JSON client),
                history.ts (per-channel sliding window)
  tools/        executor.ts (registry + arg helpers), loop.ts (tool rounds),
                activity.ts (per-call activity lines), index.ts (buildTools),
                web/ (search, fetcher, ssrf, cache, extract), file/ (ops, paths)
test/
  smoke.ts      the entire test suite (single script)
```

Key flow: every *trackable* message (human, text channel, target guild) enters the channel history on arrival; only *mentions* queue a turn. A turn = `runToolTurn` (model ↔ tools rounds, capped by `TOOLS_MAX_ROUNDS`) → `ResponseWriter` posts the final reply. Both tool families run **in-process** (no sidecars, no Docker) and are opt-in (`WEBTOOLS_ENABLED`/`FILETOOLS_ENABLED`, default `false`).

Repo dirs: `dist/` = build artifact, `workspace/` = the bot's live file workspace (gitignored, real data), `.venv/` = leftover of a removed Python sidecar — ignore it, the project is TypeScript-only.

## 2. Build & Development Commands

```bash
npm install               # use npm (package-lock.json present)
cp .env.example .env      # fill in values; .env is gitignored
npm run dev               # run from source (tsx)
npm run build && npm start  # compile src/ -> dist/ and run the compiled bot
npm run typecheck         # tsc --noEmit
npm test                  # smoke tests (tsx test/smoke.ts)
```

- **Done means green**: `npm test` **and** `npm run typecheck` — `tsx` does not typecheck, so a green test run proves nothing about types.
- No lint/format scripts; match the surrounding code by eye.
- Required env: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `MODEL_API_URL`; everything else documented in `.env.example`.

## 3. Testing Guidelines

- The whole suite is `test/smoke.ts`, run via `npm test`. No test framework, no test selection, no config.
- It is hermetic: a mock OpenAI-compatible HTTP server on an ephemeral port, fake Discord channels, injected DNS/search backends, temp workspace dirs; no `.env`, Discord, or network needed.
- Plain `node:assert/strict`; one block per area, `ok(name)` check groups; the final line prints the count (currently **66 check groups**).
- Async is driven with `ticks()` (`setImmediate`), not real sleeps — follow the pattern.
- In tests use the pure `parseConfig(env)`, never `loadConfig()` (it calls `process.exit(1)`).
- Web-tool tests use `WebToolsOptions.allowPrivate`/`resolver`/`searchFetch` (tests-only escape hatches; never enable in production).

## 4. Code Style & Naming Conventions

- `tsconfig`: strict, ES2022, NodeNext — **relative imports need explicit `.js` extensions even in `.ts` files**: `import { x } from "./bot/queue.js"`.
- 2-space indent, double quotes, semicolons; `import type` for type-only imports; explicit return types on exported functions; JSDoc comments on exported symbols (and on non-obvious private ones).
- Lowercase error messages without a trailing period; log via `src/log.ts` (`log.info/warn/error`, `errMsg()`), never bare `console.log` outside `log.ts`/config errors.
- Defensive by default: malformed model input, SSE lines, and Discord API errors are tolerated where it keeps the bot alive; a broken tool becomes an `Error: …` tool result, never a crash.
- Naming: `PascalCase` classes/interfaces, `camelCase` functions/vars, `UPPER_SNAKE` for constants and env var names, `kebab-free` filenames (lowercase: `webtools.ts`, `file/ops.ts`).
- Runtime deps are deliberately minimal (only `discord.js` + `dotenv`; HTTP is native `fetch`). Do not add runtime dependencies without confirming with the user.

## 5. Working Agreements

- The user drives commits — don't commit unless explicitly asked (observed style: conventional subjects, e.g. `feat: …`, `fix: …`).
- Never edit or commit: `dist/`, `workspace/`, `.env`, `node_modules/`.
- Ask before: changing queue/history/writer semantics pinned by tests, changing the SSRF blocklist or workspace-confinement rules in `src/tools/`, or enabling tools in `.env`.
- Keep changes self-contained; the repo has no CI, so `npm test` + `npm run typecheck` are the only gates.

## Invariants pinned by `test/smoke.ts` (change only together with the tests)

- **Queue** (`bot/queue.ts`): one turn per channel at a time; queues serialize per channel, not globally (multiple channels generate concurrently). The queue holds only *mentions*, in arrival order; a mention deleted/evicted before its turn is skipped.
- **History** (`llm/history.ts`): per-channel in-memory sliding window (last `MODEL_CONTEXT_MAX_MESSAGES`), no persistence. `messageUpdate`/`messageDelete`/`messageDeleteBulk`/`channelDelete` keep it in sync. A chunked bot reply is one entry with one id per chunk: any chunk id resolves it, a chunk edit rebuilds the visible text, a chunk delete drops the whole reply.
- **LLM client** (`llm/client.ts`): the per-request `AbortController` timeout covers the whole stream; `abort()` must cancel **all** in-flight requests. `tools`/`tool_choice:"auto"` are sent only when a non-empty registry is passed; streamed `delta.tool_calls` fragments are reassembled by index. `chat()` takes `StreamCallbacks { onDelta?, onReasoning? }`; `onReasoning` receives `delta.reasoning`/`delta.reasoning_content` (provider-dependent; reasoning is never part of the result).
- **Writer** (`bot/writer.ts`): 2000-char limit; `splitForDiscord` never splits inside a code fence (closes it, reopens in the next chunk), keeps markdown tables together (a spanning table repeats its header row in every part; a title line right before a table is carried into the table's chunk), prefers paragraph/heading/list boundaries. While the model is thinking, a **thinking live message** shows the streamed reasoning (whole text while it fits; otherwise header + "*N lines hidden*" + last 5 lines, capped at 2000 chars); when the reply starts — or at finish when no reply content ever streamed (non-stream mode, reasoning-only) — that message **completes in place** into a terminal "🤔 *thought for Ns*" line that stays above the reply, which **streams in its own fresh message** (edits throttled to `throttleMs`; over 2000 chars shows the tail). Reasoning is never posted or recorded. `discard()` deletes the in-progress live messages (thinking + reply preview) without finishing the turn — used between tool rounds. `bot/format.ts` sanitizes model text before posting and before it lands in history: any `$...$` math is rewritten to Unicode (non-math `$`, e.g. prices, is left alone).
- **Tool loop** (`tools/loop.ts`): a round ending in tool calls is transient (its preview is discarded via `onToolRound` → `writer.discard()`); `onToolCalls` is called with the calls right before they execute and is **awaited** — the caller posts one persistent activity message per call (`tools/activity.ts` `formatToolCall`: icon + name + up to two args, results never shown; these bot messages never enter channel history). Tools execute concurrently (`tools/executor.ts`); results become `tool`-role messages that live only in the turn — **only the final posted reply reaches channel history**. `TOOLS_MAX_ROUNDS` caps the rounds; exhaustion with no text posts a note.
- **Tool security**: `web_fetch` (`src/tools/web/ssrf.ts`) validates URLs against an SSRF blocklist and connects to the *pinned resolved IP* (anti-DNS-rebinding); redirects are re-validated hop by hop; mixed public/private resolution is refused (strict). File paths (`src/tools/file/paths.ts`) are confined to the workspace with symlink-escape rejection (including dangling symlinks); `src/tools/file/ops.ts` refuses binaries, caps reads/writes/searches, and never deletes the workspace root.

## Gotchas

- The bot needs the **MESSAGE CONTENT privileged intent** enabled in the Discord Developer Portal (app → Bot → Privileged Gateway Intents); without it, message content silently arrives empty.
- `MODEL_ENABLE_IMAGES=true` is a no-op in v1 (warns at startup).
- The endpoint only speaks tools if its chat template supports function calling (llama.cpp needs a tool-capable template). If it rejects `tools`, keep `WEBTOOLS_ENABLED`/`FILETOOLS_ENABLED` off.
- File tools need the `FILETOOLS_WORKSPACE` directory (default `./workspace`) to exist — it is not created automatically; failures surface per call and the turn continues.
