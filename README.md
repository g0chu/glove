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
  `MODEL_SYSTEM_PROMPT` is prepended to every request.
- **Streaming:** by default the answer is built up live: typing indicator
  while generating, message created on the first chunk, edits throttled to
  at least `DISCORD_STREAM_UPDATE_THROTTLE_MS` apart. Set `MODEL_STREAM=false`
  for a single reply instead.
- **Chunking:** replies longer than Discord's 2000-char limit are split into
  multiple messages, preferring newlines and never cutting inside a code
  fence (fences are closed/reopened across the boundary).
- **Queue:** one turn per channel at a time. Messages that arrive while a
  reply is generating are queued: the first queued mention starts the next
  turn, and non-mention messages ahead of it are appended to the channel
  history as context leading into that mention. Non-mentions on their own
  never trigger a reply.
- **Errors:** model timeouts, connection failures, bad SSE, and Discord API
  errors produce a short honest message in the channel; the bot keeps going.

## Configuration

See [.env.example](.env.example) for the documented list.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | run from source with tsx |
| `npm run build` | compile TypeScript to `dist/` |
| `npm start` | run the compiled bot |
| `npm run typecheck` | type-check without emitting |
| `npm test` | smoke tests (config, history, chunking, queue, writer, LLM client vs. a mock endpoint) |
