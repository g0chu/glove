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
- **Live peek at the work:** while generating, a live message shows the
  model's streamed reasoning ("🤔 *thinking: …*" — the whole thinking while
  it fits, then a "N lines hidden" line + the last 5 lines, capped at 2000
  chars) when the endpoint sends reasoning deltas (`DISCORD_SHOW_REASONING`,
   default on). When the reply starts, that message completes in place into a
   "🤔 *thought for Ns*" line that stays above the reply, which streams in
   its own message (with `MODEL_STREAM=false` the line completes when the
   reply is ready and the reply posts as a separate message). The reasoning
   text is never posted or recorded. Tool
  activity is different: each tool call is posted as its own **persistent** short
  message ("🔎 *web_search(query=\"…\")*" — name + arguments only, results
  never shown; `DISCORD_SHOW_TOOL_ACTIVITY`, default on). These are bot
  messages and never enter the channel context.
- **Chunking:** replies longer than Discord's 2000-char limit are split
  into multiple messages, preferring newlines, keeping markdown tables
  together (a table that must span messages repeats its header row in each
  part), and never cutting inside a code fence (fences are closed/reopened
  across the boundary).
- **Formatting:** any math the model emits as `$...$` LaTeX is rewritten
  to plain Unicode before posting (Discord renders markdown but not LaTeX).
- **Queue:** one turn per channel at a time. Mentions that arrive while a
  reply is generating are queued and answered in order. Non-mentions on
  their own never trigger a reply, but they are part of the context.
- **Clear:** sending `!clear` (exact match, case-insensitive) in a text
  channel resets that channel's model context for a fresh chat: the command
  is neither tracked nor answered, the bot posts a short confirmation line
  ("🧹 *…*"), and everything before it is forgotten — in compaction mode the
  context (entries + summary) is dropped and not re-seeded, in classic mode
  the live fetch only considers messages after the command. Mentions queued
  before the clear are skipped.
- **Errors:** model timeouts, connection failures, bad SSE, and Discord API
  errors produce a short honest message in the channel; the bot keeps going.

## Tools (web search/fetch + file workspace + offline Wikipedia)

The bot can run three optional tool families, all **in-process** (no
sidecars, no Docker). All are **opt-in** (default `false`) and need a model
endpoint that supports function calling (`tools`). With all disabled, the bot
behaves exactly as before. The model is only told about the families you
enabled — a short system-prompt note lists exactly those, so the bot never
claims tools it does not have.

- **web tools**: `web_search` (DuckDuckGo) and `web_fetch` (plain
  pinned-socket HTTP fetch with SSRF protection, content extraction, and a
  TTL-bounded result cache). No browser rendering, so JavaScript-heavy pages
  may come back incomplete.
- **file tools**: `file_list`, `file_read`, `file_write`, `file_edit`,
  `file_delete`, `file_search` over a persistent workspace. The workspace
  lives in **`./workspace`** next to the repo (gitignored) and survives
  restarts.
- **wikipedia tools**: `wikipedia_search` and `wikipedia_read` over a local
  **offline Wikipedia archive** (a ZIM file pointed to by `ZIM_FILE`, e.g.
  the en.wikipedia "all nopic" dump in `./workspace`). The reader works
  directly on the file — binary search over the ~20M-entry directory plus
  a time-budgeted title scan, so lookups on a 50 GB archive take well under
  a second. `wikipedia_read` returns the article as clean plain text
  (references, TOC and navigation dropped).

A turn may run several model rounds: rounds that end in tool calls are
transient (their streamed preview is deleted), the tools execute — each
call is posted as its own persistent activity message (name + arguments
only; `DISCORD_SHOW_TOOL_ACTIVITY`) — and the next round continues with
the results in context. Only the final reply is posted and recorded in the
channel history. `TOOLS_MAX_ROUNDS` (default 5) caps the rounds.

### Setup

Nothing to build or run — the tools live in the bot process. Just set
`WEBTOOLS_ENABLED=true`, `FILETOOLS_ENABLED=true` and/or
`ZIMTOOLS_ENABLED=true` (with `ZIM_FILE` pointing at a ZIM archive) in `.env`
and restart the bot.

### Notes

- **Security:** `web_fetch` validates every URL against an SSRF blocklist
  (loopback, RFC1918, link-local/metadata, CGNAT, …) and connects to the
  *resolved* IP to prevent DNS rebinding; redirects are re-validated hop by
  hop (max 5).
- `file_edit` replaces an exact text span; `new_text` may be empty (deleting
  the span). Paths are confined to the workspace; symlink escapes are rejected.
- The model endpoint must speak function calling (e.g. llama.cpp with a
  tool-supporting chat template). If the endpoint rejects `tools`, keep the
  `*_ENABLED` flags off.
- The wikipedia tools read ZIM v6 archives. Wikipedia ZIM article clusters
  are zstd-compressed, so the reader needs **Node >= 22.15** (built-in zstd);
  other ZIM features (e.g. LZMA2-compressed clusters) are reported as
  per-call errors, never crashes.
- Per-tool caps (fetch size, redirect hops, cache, search result caps,
  workspace limits, …) are in `.env.example` and have sensible defaults.

## Configuration

See [.env.example](.env.example) for the documented list.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | run from source with tsx |
| `npm run build` | compile TypeScript to `dist/` |
| `npm start` | run the compiled bot |
| `npm run typecheck` | type-check without emitting |
| `npm test` | smoke tests (config, history, chunking, queue, writer, tool loop, in-process web/file/zim tools, LLM client incl. tool calls vs. a mock endpoint) |
