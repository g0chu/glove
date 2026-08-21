# Glove — Discord ↔ Chat Completions Bridge

A Discord bot that bridges a server's text channels to any **OpenAI-compatible
Chat Completions endpoint**. @mention the bot in any text channel of the
configured guild and it forwards the channel's recent conversation to the
model, streaming the answer back as a live-updating message.

## Requirements

- Node.js 20+
- A Discord application + bot token
- **Message Content privileged intent enabled**: Developer Portal → your app
  → Bot → Privileged Gateway Intents → **MESSAGE CONTENT INTENT** (without
  this, messages arrive with empty content and the bot cannot work)
- A running Chat Completions endpoint (llama.cpp server, vLLM, LM Studio,
  Ollama's OpenAI shim, …)

## Setup

```bash
cp .env.example .env   # then fill in your values
npm install
npm run dev            # or: npm run build && npm start
```

## Behavior

- **Trigger:** the bot answers only when @mentioned (replies to its messages
  count as mentions) in any text channel of `DISCORD_GUILD_ID`.
- **Memory:** per-channel sliding window of the last
  `MODEL_CONTEXT_MAX_MESSAGES` (default 20) messages; an optional
  `MODEL_SYSTEM_PROMPT` is prepended to every request. Every message in the
  channel enters the window as soon as it arrives (mentions and non-mentions
  alike), and edits and deletions are reflected, so the model always sees
  the channel's current state.
- **Streaming:** by default the answer is built up live: typing indicator
  while generating, message created on the first chunk, edits throttled to
  at least `DISCORD_STREAM_UPDATE_THROTTLE_MS` apart. Set `MODEL_STREAM=false`
  for a single reply instead.
- **Chunking:** replies longer than Discord's 2000-char limit are split into
  multiple messages, preferring newlines and never cutting inside a code
  fence (fences are closed/reopened across the boundary).
- **Queue:** one turn per channel at a time. Mentions that arrive while a
  reply is generating are queued and answered in order. Non-mentions on
  their own never trigger a reply, but they are part of the context.
- **Errors:** model timeouts, connection failures, bad SSE, and Discord API
  errors produce a short honest message in the channel; the bot keeps going.

## Tools (web search/fetch + file workspace)

The bot can call two optional Dockerized Python sidecars. Both are **opt-in**
(default `false`) and need a model endpoint that supports function calling
(`tools`). With both disabled, the bot behaves exactly as before.

- **webtools** (`:8377`): `web_search` (DuckDuckGo via `ddgs`) and
  `web_fetch` (plain pinned-socket HTTP with readability extraction, headless
  Chromium fallback for JavaScript-heavy pages, result cache with TTL).
- **filetools** (`:8378`): `file_list`, `file_read`, `file_write`, `file_edit`,
  `file_delete`, `file_search` over a persistent workspace. The bot's file
  workspace lives in **`./workspace`** next to the repo (gitignored); it is
  bind-mounted into the container and survives restarts and rebuilds.

A turn may run several model rounds: rounds that end in tool calls are
transient (their streamed preview is deleted), the tools execute, and the
next round continues with the results in context. Only the final reply is
posted and recorded. `TOOLS_MAX_ROUNDS` (default 5) caps the rounds.

### Setup

```bash
docker compose build
docker compose up -d webtools            # web search + fetch
docker compose --profile files up -d     # + file workspace
```

Then set `WEBTOOLS_ENABLED=true` and/or `FILETOOLS_ENABLED=true` in `.env`
and restart the bot.

### Notes

- **Security:** the sidecar ports bind to `127.0.0.1` only. `web_fetch`
  validates every URL against an SSRF blocklist (loopback, RFC1918,
  link-local/metadata, CGNAT, …) and connects to the *resolved* IP to
  prevent DNS rebinding; redirects are re-validated hop by hop (max 5).
  The browser fallback cannot pin DNS (Chromium resolves itself), so it is
  pre-validation only — a documented residual, fine for a single-user bot.
- `file_edit` replaces an exact text span; `new_text` may be empty (deleting
  the span). Paths are confined to the workspace; symlink escapes are rejected.
- The model endpoint must speak function calling (e.g. llama.cpp with a
  tool-supporting chat template). If the endpoint rejects `tools`, keep the
  `*_ENABLED` flags off.
- Sidecar env vars (`FETCH_TIMEOUT_S`, `CACHE_TTL_S`, `BROWSER_ENABLED`,
  `WORKSPACE_DIR`, caps, …) are documented in `tools/server/config.py` and
  have sensible defaults; the bot-side flags are in `.env.example`.

## Configuration

See [.env.example](.env.example) for the documented list.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | run from source with tsx |
| `npm run build` | compile TypeScript to `dist/` |
| `npm start` | run the compiled bot |
| `npm run typecheck` | type-check without emitting |
| `npm test` | smoke tests (config, history, chunking, queue, writer, tool loop, LLM client incl. tool calls vs. a mock endpoint) |
| `.venv/bin/python tools/test/smoke.py` | sidecar smoke tests (ssrf, paths, extract, search, cache, all endpoints via TestClient) |
