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

For llama-server installations affected by [llama.cpp #24440](https://github.com/ggml-org/llama.cpp/issues/24440)
(reported with Gemma 4, MTP and `-sm tensor`), set
`MODEL_DISABLE_PROMPT_CACHE=true` in your environment and restart Glove.
This sends llama-server's `cache_prompt: false` on every model request,
including chime decisions/repairs, tool rounds, summaries and retries. It is
a mitigation for reuse of stale KV/checkpoint state, not a verified fix for
the upstream CUDA crash. Prompt processing will be slower. The default is
`false`, which omits this llama-server extension for other providers.

Avoid manually editing/regenerating old assistant or system messages on
affected servers. Glove itself cannot guarantee an append-only request
prefix: edits/deletes, compaction, chime calls and
interrupted attempts can all change it, and channels share server slots.
Discord's live reply edits update display text; disabling `MODEL_STREAM`
does not prevent these request-prefix changes. If the crash persists with
cache reuse disabled, use a server build/configuration verified to work
without the affected tensor/MTP combination.

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
  call is accepted; plain text (including YES/NO and JSON) never decides. Chime decision and repair calls use the endpoint's default output limit; the bot sends no `max_tokens` cap.
  An unusable decision gets one repair with unchanged tool schemas and an extra instruction; HTTP
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
  On restart, all available messages since the last completed REST snapshot
  are merged in Discord order. Before every model attempt, REST refresh fills
  missed gateway gaps and reconciles every retained message's current content,
  attachments, reactions and deletion state. These requests are sequential;
  longer retained conversations take more time to reconcile. Partial gateway
  updates are fetched completely before replacing stored content.
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
  Channel folders contain readable JSON/JSONL, complete turn records, and
  attachments with their original extensions. Attachment capture is enabled
  independently of model image/file input (`ARCHIVE_ATTACHMENTS_ENABLED`).
  Recovery restores completed work without repeating tools or Discord posts.
  See [ARCHIVE.md](ARCHIVE.md) for limits, recovery, folder export, migration, and purge.
- **Errors:** model timeouts, connection failures, bad SSE, and Discord API
  errors produce a short honest message in the channel; the bot keeps going.

## Tools (web search/fetch + file workspace + shell + offline Wikipedia)

The bot can run four optional tool families, all **in-process** (no
sidecars, no Docker). All are **opt-in** (default `false`) and need a model
endpoint that supports function calling (`tools`). With all disabled, the bot
advertises no executable tool families. Enabled tools are described in their
function schemas; tool guidance is not appended to `MODEL_SYSTEM_PROMPT`.
The local `chime` schema is also shared by decision and reply requests.

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
- **wikipedia tools**: `wikipedia_search`, `wikipedia_intro`, `wikipedia_sections`,
  `wikipedia_section`, and `wikipedia_read` over a local
  **offline Wikipedia archive** (a ZIM file pointed to by `ZIM_FILE`, e.g.
  the en.wikipedia "all nopic" dump in `./workspace`). The reader works
  directly on the file using indexed path lookups and time-budgeted title scans. `wikipedia_read` returns the article as clean plain text
  (references, TOC and navigation dropped). Choose `intro`, `sections`,
  `section`, or `full` when reading.
- **vault tools**: `vault_search`, `vault_intro`, `vault_sections`, `vault_section`,
  `vault_read`, and `vault_links` browse
  an offline Wikipedia markdown vault configured with `VAULT_DIR`. Read modes
  match the ZIM tools, and search also checks note contents.
- **memory tool**: `memory` manages persistent named notes shared across
  conversations. See [Persistent memory](#persistent-memory).

A turn may run several model rounds: a round that ends in tool calls keeps
its text in place (it stays in the channel above the activity lines), the
tools execute — calls appear in the turn’s shared activity message
(name + arguments only; `DISCORD_SHOW_TOOL_ACTIVITY`) — and the next round
continues with the results in context. Completed rounds, including narration,
reasoning, tool calls/results, and the final reply, are recorded in channel history.
`TOOLS_MAX_ROUNDS` (default 5) caps the rounds.

### Setup

Nothing to build or run — the tools live in the bot process. Just set
`WEBTOOLS_ENABLED=true`, `FILETOOLS_ENABLED=true`, `SHELLTOOLS_ENABLED=true`,
`ZIMTOOLS_ENABLED=true` (with `ZIM_FILE` pointing at a ZIM archive),
`VAULTTOOLS_ENABLED=true` (with `VAULT_DIR` pointing at a markdown vault),
and/or `MEMORYTOOLS_ENABLED=true` in `.env` and restart the bot.

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

## Message reactions

The model sees each message's current emoji reactions, with readable emoji names and counts. Adds, removals and clearing reactions update the stored conversation, including reactions on the bot's replies and uncached older messages. Reaction changes interrupt an active model request so it can rebuild from the updated context; they do not queue a new reply by themselves. Startup catch-up and the pre-turn refresh also reconcile reactions on every retained Discord message, and fetched channel history includes existing reactions. Cleared, deleted or compacted messages are not resurrected by reactions.

With `MODEL_ENABLE_IMAGES=true`, reaction pictures are included even on messages outside the attachment image window. Custom emoji use a static first-frame PNG from Discord's CDN; standard emoji use [Twemoji](https://github.com/jdecked/twemoji) artwork (CC BY 4.0) from a fixed GitHub source. Each picture is labeled with its emoji name and message ID. Downloads have a 10-second deadline, reject redirects and respect `MODEL_IMAGES_MAX_BYTES`; unavailable pictures leave a note. Names/counts remain visible with images disabled. Rendered pictures and download failures persist across restarts. Unicode names come from Unicode 16.0, under the [Unicode data license](src/bot/UNICODE-LICENSE.txt).

## API inspector

Run `npm run ui`, then open **http://127.0.0.1:3210**. The read-only web UI can run alongside the bot or browse its history while it is stopped. It reads `CHATS_ARCHIVE_DIR` from `.env` (default `./data/archive`) without acquiring the bot's archive lock. No Discord token or model connection is needed to run the UI. Set `WEB_UI_PORT` to change its port; after a build, run `node dist/ui-cli.js` instead.

The UI is one continuous, chronological feed of conversation messages, assistant output, reasoning, tool arguments/results and errors. Labeled sections distinguish user messages, reasoning, tool calls, named tool results and assistant responses, with a separate accent color for each. **Auto-collapse** is enabled by default: all sections except assistant responses collapse when complete. Turn it off to keep completed blocks open; manually opened or closed blocks keep their state when toggling. Reasoning stays open while streaming and collapses when response text or tool calls begin; tool calls collapse at generation completion. Finished inputs and tool results start collapsed. Any section can be reopened manually. Filter by channel ID, request ID, purpose or status. Repeated prompt history is omitted by default; enable **Full prompts** to show all input messages, including system instructions. Copy or save the loaded feed as text. Replies, chime decisions, repair attempts and compaction calls carry time/channel labels in the same feed, including failed and unfinished requests.

**Live updates** poll every half second; parsed response batches arrive up to one second apart. **Auto-scroll** follows new output while you are at the bottom. Scrolling up keeps your reading position and shows a new-interaction count on **Jump to bottom**; that button returns to the latest output and resumes following. **Load earlier history** prepends older entries without moving the message you are reading. Turn live updates off to pause, or use **Refresh** for a single update. Sections collapse once on completion; manual reopening or closing is preserved during later updates. Completed responses are reused rather than fetched and rendered again on every poll. The UI shows captured API activity, not endpoint-internal prompt-processing progress.

The UI binds only to `127.0.0.1` and does not load external assets. Conversation content is visible to anyone who can access that local address; authorization headers are never archived or displayed. A pending request from an earlier bot session remains marked pending because the archive has no completion for it. Structured requests and parsed responses remain in the archive; older raw captures are still readable. Images appear as attachment labels; image data is never loaded into the page. History is loaded in pages of 20 interactions, with at most four detail requests in flight. Restart the UI after replacing or purging its archive.

## Configuration

See [.env.example](.env.example) for the documented list.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | run from source with tsx |
| `npm run build` | compile TypeScript to `dist/` |
| `npm start` | run the compiled bot |
| `npm run ui` | open the local API interaction inspector at http://127.0.0.1:3210 |
| `npm run typecheck` | type-check without emitting |
| `npm test` | smoke tests (config, history, chunking, queue, writer, tool loop, in-process web/file/shell/zim tools, LLM client incl. tool calls vs. a mock endpoint) |

### Shared prompts and caching

Replies, chime decisions and compaction share `MODEL_SYSTEM_PROMPT` unchanged.
No tool guidance or phase instructions are added to that master prompt.
Requests preserve conversation order, including when a reply follows a queued
trigger. Endpoints must support trailing system instructions and generating a
new reply after assistant history without treating it as an assistant prefill.

When chime is enabled, decisions and replies share the exact system prompt,
full conversation (including reasoning, tool calls/results, summary and
attachments), and ordered tool definitions. Both use `tool_choice: "auto"`:
changing this can change the server's rendered prompt. The decision adds a
short **system-role** instruction **after** that shared context. Completed YES
and NO decisions are retained in the same channel history: the instruction,
original assistant text/reasoning and chime call, a matching tool result, and
an instruction ending the decision phase. A YES reply extends that exact
request prefix; a NO waits for new activity with its decision still in history.
The decision exchange is checkpointed atomically and survives restart and
crash recovery without duplication. Compaction and overflow remove exchanges
whole, preserving call/result pairing. Interrupted or unusable decisions are
not retained. Unusable decisions still get one repair with unchanged schemas
and `tool_choice: "auto"`.

Each reply with chime enabled appends a fresh system instruction identifying
its triggering Discord message and the message's index in that request. A direct
mention requires a reply immediately; a YES turn continues its accepted decision.
The instruction scopes historical chime instructions and decisions to their
earlier phases, so a previous NO does not silence a later mention. It is transient:
it stays with the current tool loop, is rebuilt for interruption/overflow retries,
and never becomes a persistent conversation entry. Decision history and the shared
request prefix remain intact.

During replies, chime is a registered local tool. Its call and result are
retained with any other calls in the round, including mixed responses. The
result tells the model to continue the reply already underway; mentions always
receive a reply. These rounds use the normal `TOOLS_MAX_ROUNDS` limit.

With no executable tools enabled, a reply receiving an explicit HTTP 400/422
tool-compatibility rejection retries once without tool metadata. Other errors
propagate, and configured executable tools are never silently disabled.
Interruption signals apply to every repair/fallback; already executed tools
are not replayed. Every structured request/parsed result is archived and counted separately;
crash recovery uses the accepted reply with all its paired tool results, so
rejected candidates cannot create duplicate rounds or mispaired tool results.

Compaction also sends the full active context with the same ordered tool
schemas and `tool_choice: "auto"`, followed by a system instruction specifying
which older portion to summarize. Roles, reasoning, tool calls/results and
attachments remain intact. Tools are never executed during compaction; a tool
call is treated as a failed summary. Applying the summary still replaces older
history, so the next request necessarily has a different prefix. Compaction
instructions are not stored in working history.

Compatible endpoints can reuse the conversation prefix instead of processing
it twice. The bot logs `chime prompt cache: X/Y input tokens reused` when usage
includes cache counts; missing counts mean unknown, not a cache miss.
Per-turn logs also report cache reuse across all calls that provide cache counts.
Decisions themselves are never cached.

Attachment windows control initial admission. Once rendered, attachment text,
image parts and skip notes are persisted unchanged until the message is edited,
its attachments/settings change, or it leaves context through compaction, clear
or deletion. Aging and signed CDN URL refreshes no longer rewrite old messages.
This keeps admitted attachments in the token budget until compaction; download
failure notes are also stable (edit or re-upload the message to retry).

Original model text is retained separately from Discord's formatted delivery
text, including across restart and crash recovery. Discord settle echoes preserve
it; real edits replace it. Existing saved entries without original text continue
using their stored text.

The latest valid request measures each channel's context. Compaction and overflow
recovery discard earlier measurements, including measurements arriving after a
clear or edit. Turn-wide peak usage remains diagnostic; `/slots` usage is never
assigned to a channel because the slot may belong to another conversation.
Without attributable request usage the bot uses its context estimate.

[llama-server documents](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
server prompt caching. Actual reuse depends on its version, chat template,
model and available slot/cache state. Real edits, compaction, configuration
changes and intervening requests can reduce reuse. Matching request prefixes
enables caching but cannot guarantee zero prompt reprocessing. No server
settings are changed by the bot.

Chime and compaction prompts can be overridden with `BOT_CHIME_PROMPT` and
`CONTEXT_COMPACTION_PROMPT` in `.env`. Missing or blank values keep the built-in
prompts. `BOT_CHIME_PROMPT` supplies the trailing decision instruction; the
shared identity comes from `MODEL_SYSTEM_PROMPT`. `CONTEXT_COMPACTION_PROMPT`
supplies the trailing summary instruction, never a replacement master prompt. Use quoted values for multiline prompts. Set `BOT_CHIME_SHOW_NO=false`
to hide chime NO decisions in Discord while keeping their diagnostic logs
(default: `true`). Restart the bot after changing these settings.


### Channel activity interruptions

Typing, new messages, edits and deletions from other users or bots immediately
interrupt the active model request during prompt processing, reasoning or reply
text. Partial replies are withdrawn. The bot waits for the channel to settle,
then rebuilds the prompt with updated context. Unstarted tools are skipped;
running tools finish and their results are retained before continuing, without
replaying completed rounds or resetting the turn's tool budget.

Duplicate trigger IDs are ignored. A newer pending mention supersedes an older
mention before generation starts, including bursts that arrived before an
attempt began watching activity. After a successful answer, queued triggers
already included in that answer's prompt are removed. Messages arriving later
remain eligible for their own turn. Chime bursts continue to settle into the
newest message's decision; ambient messages do not cancel an unanswered mention.

The stability gate commits pending messages in Discord snowflake order within each channel. A newer stable mention waits for earlier pending messages to finish stabilizing, so their final content precedes it in the prompt. Other channels remain independent. Deleting an earlier pending message releases stable messages behind it; clearing a channel or shutting down discards all its pending messages.

Before each mention or chime attempt, the bot waits for `DISCORD_MESSAGE_STABLE_MS`
without messages, edits, deletions, or typing from other users/bots. It then fetches
fresh Discord history, paginating new-message gaps and reconciling the latest 100
tracked user messages for edits and confirmed deletions. Activity during the fetch
discards that snapshot; discovered changes restart the quiet wait before rebuilding
the prompt. Refresh failures stop the attempt rather than answer from stale history.
The bot’s own activity is excluded. Channel activity cancels generation as well
as prompt processing.

Offline Wikipedia browsing uses separate tools with no `mode` argument:

- `wikipedia_intro` / `vault_intro`: the introduction before article sections.
- `wikipedia_sections` / `vault_sections`: section IDs and headings, without body text.
- `wikipedia_section` / `vault_section`: one section and its subsections; requires `section` (an ID or exact heading).
- `wikipedia_read` / `vault_read`: paginated article text, with optional `query` for literal matching excerpts.

For example, call `wikipedia_sections({"title":"Albert Einstein"})`,
then `wikipedia_section({"title":"Albert Einstein","section":"2"})`.
The vault tools use `note` instead of `title`. Introduction and section tools also
accept `query` to find excerpts in their selected text. Legacy `mode` arguments
are rejected; choose the corresponding tool instead.
`offset` and `max_chars` paginate the selected
text; responses report the next offset when more remains. Reads default to 3000
characters, capped by `TOOLS_MAX_RESULT_CHARS`. Sections and matches remain
accessible beyond that cap. Outlines are paginated too; their offsets refer to
the rendered outline. Query offsets refer to the selected article/section text.

### Persistent memory

Set `MEMORYTOOLS_ENABLED=true` and restart to expose the `memory` tool. It can
`save`, `read`, `search`, `list`, and `delete` named notes; saving the same key
replaces its content. Search matches note keys and contents without regard to
case. Notes survive restarts, compaction, and `!clear`, and are retrieved through
tool calls rather than automatically added to every prompt.

The store is **shared across all channels and users**: include user/channel
identity in keys for personal preferences. It is not private per-user storage.
`MEMORYTOOLS_FILE` defaults to `./data/memory.json`; its parent directory is
created on the first save. `MEMORYTOOLS_MAX_BYTES` (default 1000000) bounds the
entire JSON store, and `TOOLS_MAX_RESULT_CHARS` caps results. Writes are serialized
and use a synced temporary file plus atomic rename. Invalid stores return tool
errors without overwriting the file. Use one bot process per memory file.
Deleting a note removes it from this store; tool calls/results already captured
in the durable archive remain subject to the archive retention rules.

The tool functionality and schema review is documented in [TOOL_AUDIT.md](TOOL_AUDIT.md).
