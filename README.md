# Glove — Discord ↔ Chat Completions Bridge

[![CI](https://github.com/g0chu/glove/actions/workflows/ci.yml/badge.svg)](https://github.com/g0chu/glove/actions/workflows/ci.yml)

A Discord bot that bridges text channels to any **OpenAI-compatible
Chat Completions endpoint**. @mention the bot in any text channel of the
configured guild — or of any guild it is in, when `DISCORD_GUILD_ID` is
left empty — and it forwards the channel's recent conversation to the model,
streaming the answer back as a live-updating message.

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

- **Trigger:** the bot answers when @mentioned (replies to its messages
  count as mentions) in any text channel of `DISCORD_GUILD_ID` — or of any
  guild the bot is a member of when `DISCORD_GUILD_ID` is left empty (DMs
  are never tracked). Mentions from other bots queue a turn too, so a bot's
  answer can ask the model for more; other bots' messages are tracked as
  context and labeled `(bot)` in it, while the bot's own messages never
  are. Without a mention, a message only triggers the bot when chime is on
  (below).
- **Chime** (`BOT_CHIME_ENABLED`, default off): non-mention messages from
  humans or other bots queue a decision after the channel goes quiet. The
  bot shows a typing indicator while the model decides. YES runs a normal
  reply; NO optionally posts a short decision and reason. Only a `chime` tool
  call is accepted; plain text (including YES/NO and JSON) never decides.
  An unusable decision gets one repair with the tool still required; HTTP
  failures, timeouts and outages do not retry. Both decision requests cap
  output at 1,024 tokens (including reasoning on compatible endpoints).
  Typing refreshes stop when the decision finishes. Failure logs
  identify the channel and message; streaming timeouts report whether generation
  started, distinguishing a first-token wait from unfinished generation.
- **Recovery safety:** compaction discards stale summaries if the context
  changes while the model is summarizing. Interrupted or overflowing turns
  retry only before tools execute. After execution, the bot retains the
  completed rounds and reports that it stopped, avoiding automatic replay
  of writes or shell commands. Web-fetch deadlines include DNS waiting.
- **Stability gate:** a message is committed to the channel context (and
  able to queue a turn) only once it has been unchanged for
  `DISCORD_MESSAGE_STABLE_MS` (default 2000). Other bots stream their
  replies by posting a message and editing it as the text arrives; the gate
  commits the completed message instead of every partial edit, so the model
  sees it whole — and a mention that only exists in the final form queues
  exactly one turn. A message deleted while still pending never enters the
  context (nothing is lost: it simply never happened).
- **Memory:** per-channel context that starts with the channel's last
  `MODEL_CONTEXT_MAX_MESSAGES` (default 20) messages when the bot first
  talks there, then only grows as new messages arrive — every message is
  tracked (mentions and non-mentions alike), and edits and deletions are
  reflected, so nothing is lost from the context. When the estimated
  request size reaches `CONTEXT_COMPACTION_MAX_TOKENS`, the older part is
  replaced by a summary the model itself writes and the newest
  `CONTEXT_COMPACTION_KEEP_MESSAGES` messages stay verbatim. An optional
  `MODEL_SYSTEM_PROMPT` is prepended to every request.
- **Streaming:** by default the answer is built up live: typing indicator
  while generating, message created on the first chunk, edits throttled to
  at least `DISCORD_STREAM_UPDATE_THROTTLE_MS` apart. Set `MODEL_STREAM=false`
  for a single reply instead.
- **Live peek at the work:** while generating, a live message shows the
  model's streamed reasoning ("🤔 *thinking: …*" — the whole thinking while
  it fits, then a "N lines hidden" line + the last 5 lines, capped at 2000
  chars) when the endpoint sends reasoning deltas (`DISCORD_SHOW_REASONING`,
   default on). When the reply starts — or when a tool-call round ends, so
   each round's thinking is kept — that message completes in place into a
   terminal line: the first line of the thinking (truncated after 50 chars,
   `...` when cut) plus how long it took, e.g. "🤔 *Let me check the units
   first. (12s)*". That line stays in the channel (above the reply, which
   streams in its own message; with `MODEL_STREAM=false` the line completes
   when the reply is ready and the reply posts as a separate message), so a
   multi-tool turn shows a thought line per round, not just one at the end.
   The reasoning text itself is never posted or recorded. Tool activity is
   different: each tool call is posted as its own **persistent** short message
   ("🔎 *web_search(query=\"…\")*" — name + arguments only, results never
   shown; `DISCORD_SHOW_TOOL_ACTIVITY`, default on). These are bot messages
   and never enter the channel context.
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
  ("🧹 *…*"), the context (entries + summary) is dropped and not re-seeded,
  and the next turn starts from messages that arrive after the clear.
  Mentions queued before the clear are skipped (their mention is no longer
  in the context). The durable archive retains the earlier conversation;
  `!clear` does not purge it.
- **Archive:** `CHATS_ARCHIVE_DIR` (default `./data/archive`) preserves captured
  messages and edits, model requests/responses and reasoning, individual tool
  starts/results, and fetched attachment bytes independently of compaction.
  Recovery restores completed work without repeating tools or Discord posts.
  See [ARCHIVE.md](ARCHIVE.md) for retention, recovery, export, and purge.
- **Errors:** model timeouts, connection failures, bad SSE, and Discord API
  errors produce a short honest message in the channel; the bot keeps going.

## Tools (web search/fetch + file workspace + shell + offline Wikipedia)

The bot can run four optional tool families, all **in-process** (no
sidecars, no Docker). All are **opt-in** (default `false`) and need a model
endpoint that supports function calling (`tools`). With all disabled, the bot
behaves exactly as before. The model is only told about the families you
enabled — a short system-prompt note lists exactly those, so the bot never
claims tools it does not have.

- **web tools**: `web_search` (DuckDuckGo) and `web_fetch` (plain
  pinned-socket HTTP fetch with SSRF protection, content extraction, and a
  TTL-bounded result cache). No browser rendering, so JavaScript-heavy pages
  may come back incomplete.
- **file tools**: `file_read`, `file_write` and `file_edit` over a
  persistent workspace. The workspace lives in **`./workspace`** next to the
  repo (gitignored) and survives restarts.
- **shell tool**: `shell_exec` runs a shell command via `/bin/sh` in the
  file workspace and returns the exit code plus capped stdout and stderr.
  Use it for what the file tools cannot do — running programs, git,
  package managers, scripts. Commands are **not** sandboxed; a per-command
  deadline and an output cap keep a single call from hanging or flooding
  the context.
- **wikipedia tools**: `wikipedia_search` and `wikipedia_read` over a local
  **offline Wikipedia archive** (a ZIM file pointed to by `ZIM_FILE`, e.g.
  the en.wikipedia "all nopic" dump in `./workspace`). The reader works
  directly on the file — binary search over the ~20M-entry directory plus
  a time-budgeted title scan, so lookups on a 50 GB archive take well under
  a second. `wikipedia_read` returns the article as clean plain text
  (references, TOC and navigation dropped).

A turn may run several model rounds: a round that ends in tool calls keeps
its text in place (it stays in the channel above the activity lines), the
tools execute — each call is posted as its own persistent activity message
(name + arguments only; `DISCORD_SHOW_TOOL_ACTIVITY`) — and the next round
continues with the results in context. Only the final reply is recorded in
the channel history. `TOOLS_MAX_ROUNDS` (default 5) caps the rounds.

### Setup

Nothing to build or run — the tools live in the bot process. Just set
`WEBTOOLS_ENABLED=true`, `FILETOOLS_ENABLED=true`, `SHELLTOOLS_ENABLED=true`
and/or `ZIMTOOLS_ENABLED=true` (with `ZIM_FILE` pointing at a ZIM archive)
in `.env` and restart the bot.

### Notes

- **Security:** `web_fetch` validates every URL against an SSRF blocklist
  (loopback, RFC1918, link-local/metadata, CGNAT, …) and connects to the
  *resolved* IP to prevent DNS rebinding; redirects are re-validated hop by
  hop (max 5).
- `file_edit` replaces an exact text span; `new_text` may be empty (deleting
  the span). Paths are confined to the workspace; symlink escapes are rejected.
- `shell_exec` is not sandboxed: commands run in the file workspace, so
  prefer read-only or workspace-local commands. `SHELLTOOLS_TIMEOUT_S`
  (default 30) is the deadline per command (and the cap for the tool's
  `timeout_s` argument); `SHELLTOOLS_MAX_OUTPUT_BYTES` (default 100000) caps
  the combined stdout+stderr kept from one command.
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
| `npm test` | smoke tests (config, history, chunking, queue, writer, tool loop, in-process web/file/shell/zim tools, LLM client incl. tool calls vs. a mock endpoint) |

### Chime prompt caching

Chime keeps its system prompt and tool schema fixed, with new conversation
messages at the end. Compatible servers can reuse that prefix. The bot logs
`chime prompt cache: X/Y input tokens reused` when usage includes cache counts;
missing counts mean unknown, not a cache miss. Decisions themselves are never
cached.

[llama-server documents](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
`cache_prompt` as enabled by default. Its `--cache-ram` and slot configuration
control how cached prompts survive intervening requests; check your installed
version before tuning them. Chime and reply prompts have different instructions
and tool schemas, so reuse between those request types is limited. Edits and
compaction also change prefixes. No server settings are changed by the bot.

Chime and compaction prompts can be overridden with `BOT_CHIME_PROMPT` and
`CONTEXT_COMPACTION_PROMPT` in `.env`. Missing or blank values keep the built-in
prompts. Use quoted values for multiline prompts. Set `BOT_CHIME_SHOW_NO=false`
to hide chime NO decisions in Discord while keeping their diagnostic logs
(default: `true`). Restart the bot after changing these settings.
