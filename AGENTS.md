# AGENTS.md

Discord bot bridging guild text channels to any OpenAI-compatible Chat Completions endpoint. TypeScript (ESM, NodeNext, strict), discord.js v14 + native `fetch`; runtime deps are only `discord.js`/`dotenv`. Node >= 22.15 (built-in zstd is needed by the ZIM reader). No linter, formatter, or CI.

## 1. Project Overview & Architecture

@mention the bot in a text channel of the configured guild (`DISCORD_GUILD_ID`; empty = any guild the bot is a member of) and it forwards the channel's recent conversation to the model, streaming the answer back as a live-updating message. Every *trackable* message (human, text channel, target guild) enters the channel's conversation store on arrival; only *mentions* queue a turn.

- **Context** — `CONTEXT_COMPACTION_ENABLED` (default on):
  - **compaction** (`llm/context.ts`): per-channel in-memory context, seeded once with the channel's last N messages (live fetch, survives restarts), then only grows. When the token estimate (~4 chars/token) passes `CONTEXT_COMPACTION_MAX_TOKENS`, everything older than the newest `CONTEXT_COMPACTION_KEEP_MESSAGES` messages is folded into a model-written summary (one tool-less chat call to the same endpoint, sent as a *user* message, ≤4000 chars). The turn's mention is never folded or trimmed.
  - **classic** (`llm/history.ts`): each turn builds context from the channel's last N messages (live fetch); the in-memory sliding window is the fallback when the fetch fails.
- **Clear** — `!clear` in a text channel resets that channel's model context for a fresh chat: compaction mode drops entries + summary and suppresses the startup seed (no re-seed); classic mode clears the sliding window and remembers the command's message id as a boundary the live fetch respects (only later messages enter the context). The command is neither tracked nor answered (a bot mention alongside it is swallowed too); the bot posts a confirmation line (🧹, a UI line, never context). Mentions queued before the clear are skipped (their message left the context / sits before the boundary).
- **Turn** — `runToolTurn` (`tools/loop.ts`): model ↔ tool rounds capped by `TOOLS_MAX_ROUNDS`; tool results live only in the turn. Then `ResponseWriter` posts the final reply. Only the final reply reaches channel history; tool-activity (🔎/📁/🔧) and thinking (🤔) lines are posted but never tracked.
- **Images** — `MODEL_ENABLE_IMAGES=true`: image attachments (png/jpeg/webp/gif) of the newest `MODEL_CONTEXT_MAX_MESSAGES` entries are downloaded per turn from the Discord CDN (≤4 per message, `MODEL_IMAGES_MAX_BYTES` cap) and sent as base64 `image_url` parts; unsent attachments leave a one-line note.
- **Tools** — three opt-in in-process families (default `false`): `WEBTOOLS_ENABLED` (DuckDuckGo search + SSRF-protected fetch), `FILETOOLS_ENABLED` (ops confined to `FILETOOLS_WORKSPACE`, default `./workspace`, which must exist), `ZIMTOOLS_ENABLED` (offline Wikipedia, `ZIM_FILE` → ZIM v6 archive). The system prompt note (`tools/index.ts`, built by `buildTools`) lists exactly the enabled families — the model is never told about disabled ones; the ZIM no-match hint only suggests `web_search` when the web family is enabled.

```
src/
  index.ts    entrypoint: event wiring, turn runner, shutdown
  config.ts   parseConfig (pure) / loadConfig (exits on error)
  log.ts      timestamped logging, errMsg/truncate
  bot/        client (intents), router (trackable/mention), queue (per-channel
              FIFO), writer (streaming post + chunking), format (LaTeX→Unicode),
              context (turn context), images (attachment → image_url parts)
  llm/        client (OpenAI-compatible SSE/JSON), history (classic window),
              context (compaction: seed, estimate, summarize, emergency trim)
  tools/      executor (registry + args), loop (rounds), activity (per-call
              lines), index (buildTools), webtools/filetools/zimtools,
              web/ (search, fetcher, ssrf, cache, extract), file/ (ops, paths),
              zim/ (reader, text)
test/
  smoke.ts    the entire test suite
```

Repo dirs: `dist/` = build artifact, `workspace/` = live file workspace (gitignored), `.venv/` = leftover of a removed Python sidecar — ignore it.

## 2. Build & Development Commands

```bash
npm install               # npm only (package-lock.json present)
cp .env.example .env      # fill in values; .env is gitignored
npm run dev               # run from source (tsx)
npm run build && npm start  # compile src/ -> dist/ and run
npm run typecheck         # tsc --noEmit
npm test                  # smoke tests (tsx test/smoke.ts)
```

- **Done means green**: `npm test` **and** `npm run typecheck` — `tsx` does not typecheck, so a green test run proves nothing about types.
- Required env: `DISCORD_TOKEN`, `MODEL_API_URL`; `DISCORD_GUILD_ID` is optional (empty = respond in every text channel of every guild the bot is in); everything else in `.env.example`.

## 3. Testing Guidelines

- Whole suite is `test/smoke.ts` via `npm test` — no framework, no selection, no config. Hermetic: mock OpenAI-compatible HTTP server on an ephemeral port, fake Discord channels, injected DNS/search backends, temp workspace dirs; no `.env`/Discord/network needed.
- Plain `node:assert/strict`; `ok(name)` check groups (currently **104**); the final line prints the count.
- Async is driven with `ticks()` (`setImmediate`), not real sleeps.
- In tests use the pure `parseConfig(env)`, never `loadConfig()` (calls `process.exit(1)`).
- Web-tool tests use `WebToolsOptions.allowPrivate`/`resolver`/`searchFetch` — tests-only escape hatches, never enable in production.

## 4. Code Style & Naming Conventions

- Relative imports need explicit `.js` extensions even in `.ts` files: `import { x } from "./bot/queue.js"`.
- 2-space indent, double quotes, semicolons; `import type` for type-only imports; explicit return types on exported functions; JSDoc on exported symbols.
- Lowercase error messages without a trailing period; log via `src/log.ts`, never bare `console.log` outside `log.ts`/config errors.
- Defensive by default: malformed model input/SSE/Discord errors are tolerated where it keeps the bot alive; a broken tool becomes an `Error: …` tool result, never a crash.
- Naming: `PascalCase` types, `camelCase` functions/vars, `UPPER_SNAKE` constants/env, lowercase filenames.
- Do not add runtime dependencies without confirming with the user.

## 5. Working Agreements

- The user drives commits — don't commit unless explicitly asked (style: conventional subjects, `feat: …`/`fix: …`).
- Never edit or commit: `dist/`, `workspace/`, `.env`, `node_modules/`.
- Ask before: changing queue/history/writer/context semantics pinned by tests, changing the SSRF blocklist or workspace-confinement rules, or enabling tools in `.env`.
- No CI — `npm test` + `npm run typecheck` are the only gates; keep changes self-contained.

## Behavior pinned by `test/smoke.ts` (change only together with the tests)

- **Queue**: per-channel FIFO; one turn at a time per channel (channels run concurrently); holds only *mentions*, in arrival order; a mention deleted before its turn is skipped.
- **Classic history**: per-channel in-memory sliding window (last `MODEL_CONTEXT_MAX_MESSAGES`); syncs on message update/delete/bulk-delete/channel-delete; a chunked reply is one entry with one id per chunk (any chunk id resolves it; a chunk edit rebuilds the text; a chunk delete drops the whole reply).
- **Clear**: `!clear` (trimmed, case-insensitive, bot mentions stripped) resets the channel context — compaction: `reset()` drops entries + summary and marks the seed as taken (no re-seed); classic: the window is cleared and the command's message id is recorded as the boundary (`markCleared`/`getResetAfter`) — the live fetch keeps only messages strictly after it (boundary out of the last-N window → nothing dropped; a pre-clear mention → null). The 🧹 confirmation line is a UI line, never context; the command itself is never tracked or answered.
- **Compaction**: the seed merges the live last-N with what already arrived, chronologically by `createdTimestamp` (tracked ids win). Over budget → `compact()` folds everything older than the keep window (plus any existing summary) via one tool-less call — never the turn's mention; on summarizer failure or nothing foldable → `emergencyTrim` drops the oldest entries (never the mention) until the estimate fits.
- **Turn context**: system prompt first, then the summary as a labeled user message, then entries in order — user entries prefixed `Name: …` (`Name (bot): …` for other bots), the bot's own replies as unlabeled assistant messages, textless entries with no images dropped. If the mention is no longer in the context (deleted/pushed out), the turn is skipped. Classic mode: live last-N fetch (all authors; the in-memory window is the fallback on failure or > Discord's 100-fetch cap); every other message is its own user message, never merged; recorded replies appear once with canonical text; tool/thinking lines never appear.
- **LLM client**: the per-request timeout covers the whole stream; `abort()` cancels all in-flight requests. `tools`/`tool_choice` are sent only with a non-empty registry; streamed `delta.tool_calls` are reassembled by index. `chat()` takes `StreamCallbacks { onDelta?, onReasoning? }`; reasoning is never part of the result. Message `content` is a string or an array of text/image parts (pass through to the wire unchanged).
- **Writer**: ≤2000 chars; `splitForDiscord` never splits inside a code fence (closes it, reopens in the next chunk), keeps tables together (a spanning table repeats its header row), prefers paragraph/heading/list boundaries. While thinking, a live message shows the streamed reasoning (whole text while it fits; otherwise header + "*N lines hidden*" + last 5 lines), completing in place to "🤔 *thought for Ns*" when the reply starts (or at finish when nothing streamed); the reply then streams in its own fresh live message(s) (only the growing last chunk is edited, throttled; a new live message is created per chunk; each settles in place at finish, remaining chunks posted fresh). Reasoning is never posted or recorded. `discard()` deletes the in-progress live messages — used between tool rounds. `format.ts` rewrites `$…$` math to Unicode before posting/record (non-math `$` untouched).
- **Tool loop**: a round ending in tool calls is transient (its preview is discarded); `onToolCalls` is **awaited** right before execution (the caller posts one persistent activity message per call: icon + name + up to two args, results never shown); tools execute concurrently; results become `tool`-role messages that live only in the turn. `TOOLS_MAX_ROUNDS` caps the rounds; exhaustion with no text posts a note.
- **Tool security**: `web_fetch` validates URLs against an SSRF blocklist, connects to the pinned resolved IP (anti-DNS-rebinding), re-validates redirects hop by hop, and refuses mixed public/private resolution. File paths are confined to the workspace (symlink escapes, including dangling, rejected); ops refuse binaries, cap reads/writes/searches, and never delete the workspace root. ZIM reads are read-only and bounded: single fd with targeted reads (never mmap'd), size-capped LRU entry/cluster caches, time-budgeted title scans, hop-capped redirects with loop detection.

## Gotchas

- The bot needs the **MESSAGE CONTENT privileged intent** enabled (Developer Portal → app → Bot → Privileged Gateway Intents); without it, message content silently arrives empty.
- `MODEL_ENABLE_IMAGES=true` requires a vision-capable endpoint; images are downloaded at turn time only (last-N window), never on message arrival.
- Keep `CONTEXT_COMPACTION_MAX_TOKENS` comfortably below the llama-server context size (`-c`, default only 4096), and `CONTEXT_COMPACTION_KEEP_MESSAGES` small enough that keep-messages + summary fit — otherwise `emergencyTrim` starts dropping recent messages. The estimate is a char heuristic, not a real tokenizer.
- The endpoint must support function calling (llama.cpp needs a tool-capable chat template); if it rejects `tools`, keep the `*_ENABLED` flags off.
- `FILETOOLS_WORKSPACE` (default `./workspace`) must exist — not created automatically; failures surface per call and the turn continues.
- ZIM: v6 only (Wikipedia clusters are zstd-compressed → Node >= 22.15); LZMA2 clusters/non-v6 surface as per-call errors, never crashes. `wikipedia_search` matches titles/paths only (exact → prefix → budgeted substring scan), not article bodies; `wikipedia_read` returns clean text (references/TOC/nav dropped), truncated to `TOOLS_MAX_RESULT_CHARS`.
