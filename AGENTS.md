# AGENTS.md

Discord bot bridging guild text channels to any OpenAI-compatible Chat Completions endpoint. Single-package TypeScript (ESM, NodeNext, strict), discord.js v14 + native `fetch`. Node >= 20. No linter, formatter, or CI.

## Commands

```bash
npm install              # use npm (package-lock.json present)
cp .env.example .env     # fill in values; .env is gitignored
npm run dev              # run from source (tsx)
npm run build && npm start   # compile src/ -> dist/ and run
npm run typecheck        # tsc --noEmit
npm test                 # smoke tests: single script test/smoke.ts, no test selection
```

- **Done means green**: `npm test` **and** `npm run typecheck` — `tsx` does not typecheck, a green test run proves nothing about types.
- No lint/format scripts; match the surrounding code by eye.

## Layout

- `src/index.ts` — the only entrypoint: `messageCreate` → `bot/router.ts` (guild/text-channel/mention filters) → `bot/queue.ts` → the turn loop → `llm/client.ts` + `bot/writer.ts`.
- `src/config.ts` — env parsing; `loadConfig()` calls `process.exit(1)` on missing/invalid values (required: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `MODEL_API_URL`). In tests, use the pure `parseConfig(env)` instead. All knobs documented in `.env.example`.
- `src/bot/` (client, router, queue, writer, format), `src/llm/` (SSE client, history), `src/tools/` (registry/executor, tool loop, in-process `WebTools` in `web/` + `FileTools` in `file/`, `activity.ts` for tool-call lines).
- Both tool families run **in-process** (no sidecars, no Docker) and are opt-in (`WEBTOOLS_ENABLED`/`FILETOOLS_ENABLED`, default `false`).
- `test/smoke.ts` — the entire test suite. `workspace/` — the bot's live file workspace (gitignored, real data). `dist/` — build artifact. `.venv/` — leftover of the removed Python sidecar; ignore it, the project is TypeScript-only.

## Invariants pinned by `test/smoke.ts` (change only together with the tests)

- **Queue** (`bot/queue.ts`): one turn per channel at a time; queues serialize per channel, not globally (multiple channels generate concurrently). The queue holds only *mentions*, in arrival order; every trackable message (mention or ambient) is appended to the channel history immediately on `messageCreate`, keyed by Discord message id. Ambient messages never trigger a reply.
- **History** (`llm/history.ts`): per-channel in-memory sliding window (last `MODEL_CONTEXT_MAX_MESSAGES`), no persistence, ambient messages consume the window. `messageUpdate`/`messageDelete`/`messageDeleteBulk`/`channelDelete` keep it in sync. A chunked bot reply is one entry with one id per chunk: any chunk id resolves it, a chunk edit rebuilds the visible text, a chunk delete drops the whole reply.
- **LLM client** (`llm/client.ts`): the per-request `AbortController` timeout covers the whole stream; `abort()` must cancel **all** in-flight requests. `tools`/`tool_choice:"auto"` are sent only when a non-empty registry is passed; streamed `delta.tool_calls` fragments are reassembled by index. `chat()` takes `StreamCallbacks { onDelta?, onReasoning? }`; `onReasoning` receives `delta.reasoning`/`delta.reasoning_content` (provider-dependent; reasoning is never part of the result).
- **Writer** (`bot/writer.ts`): 2000-char limit; `splitForDiscord` never splits inside a code fence (closes it, reopens in the next chunk), keeps markdown tables together (a spanning table repeats its header row in every part; a title line right before a table is carried into the table's chunk), prefers paragraph/heading/list boundaries. The live preview shows, in priority order, the streamed reply or the tail-capped `🤔 *thinking: …*` reasoning line; edits are throttled, but a change of what is shown (thinking → reply) lands immediately. `discard()` drops an in-progress preview without finishing the turn (between tool rounds). `bot/format.ts` sanitizes model text before posting and before it lands in history: any `$...$` math is rewritten to Unicode (non-math `$`, e.g. prices, is left alone).
- **Tool loop** (`tools/loop.ts`): a round ending in tool calls is transient (its preview is discarded via `onToolRound` → `writer.discard()`); `onToolCalls` is called with the calls right before they execute and is **awaited** — the caller posts one persistent activity message per call (`tools/activity.ts` `formatToolCall`: icon + name + up to two args, results never shown; these bot messages never enter channel history). Tools execute concurrently (`tools/executor.ts`); results become `tool`-role messages that live only in the turn — **only the final posted reply reaches channel history**. `TOOLS_MAX_ROUNDS` caps the rounds; exhaustion with no text posts a note. A broken tool never kills the turn (failures become `Error: …` tool results).
- **Tool security**: `web_fetch` (`src/tools/web/ssrf.ts`) validates URLs against an SSRF blocklist and connects to the *pinned resolved IP* (anti-DNS-rebinding); redirects are re-validated hop by hop. File paths (`src/tools/file/paths.ts`) are confined to the workspace with symlink-escape rejection; `src/tools/file/ops.ts` refuses binaries, caps reads/writes/searches, and never deletes the workspace root.

## Gotchas

- The bot needs the **MESSAGE CONTENT privileged intent** enabled in the Discord Developer Portal (app → Bot → Privileged Gateway Intents); without it, message content silently arrives empty.
- `MODEL_ENABLE_IMAGES=true` is a no-op in v1 (warns at startup).
- The endpoint only speaks tools if its chat template supports function calling (llama.cpp needs a tool-capable template). If it rejects `tools`, keep `WEBTOOLS_ENABLED`/`FILETOOLS_ENABLED` off.
- File tools need the `FILETOOLS_WORKSPACE` directory (default `./workspace`) to exist — it is not created automatically; failures surface per call and the turn continues.
- Comments in `src/config.ts`, `src/bot/queue.ts`, `src/bot/router.ts`, `src/llm/client.ts` reference `PLAN.md §N`, but PLAN.md is not in the repo.

## Style

- `tsconfig`: strict, ES2022, NodeNext — **relative imports need explicit `.js` extensions even in `.ts` files**: `import { x } from "./bot/queue.js"`.
- 2-space indent, double quotes, semicolons; `import type` for type-only imports; explicit return types on exported functions; JSDoc on exported symbols; lowercase error messages without trailing period; log via `src/log.ts`.
- Runtime deps are deliberately minimal (only `discord.js` + `dotenv`; HTTP is native `fetch`). Do not add runtime dependencies without confirming with the user.

## Testing conventions

- `test/smoke.ts` is hermetic: mock OpenAI-compatible server on an ephemeral port, fake Discord channels, injected DNS/search backends, temp workspace dirs; no `.env`, Discord, or network. Plain `node:assert/strict`, no framework; final line prints the count (currently 62 check groups).
- Async is driven with `ticks()` (`setImmediate`), not real sleeps — follow the pattern. Shape: one block per area, `ok(name)` check groups.

## Working agreements

- The user drives commits — don't commit unless explicitly asked (observed style: conventional subjects, `feat: …`).
- Never edit or commit: `dist/`, `workspace/`, `.env`, `node_modules/`.
- Ask before: changing queue/history/writer semantics pinned by tests, changing the SSRF blocklist or workspace-confinement rules in `src/tools/`, enabling tools in `.env`.
