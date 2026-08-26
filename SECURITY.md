# Security Policy

## Reporting a vulnerability

If you have discovered a security vulnerability in this project, please report
it privately. **Do not disclose it as a public issue.**

Disclose it as a private
[security advisory](https://github.com/g0chu/glove/security/advisories/new).

This project is maintained on a reasonable-effort basis; please allow
reasonable time (up to 90 days) to work on a fix before public exposure.

Before submitting a report:

- Search existing issues — already-reported problems will likely be rejected
  as duplicates.
- Include a working proof of concept (a script or exact reproduction steps).

## Covered topics

Only vulnerabilities in these areas are considered valid:

- **SSRF protection** (`src/tools/web/`): bypassing the URL blocklist,
  DNS-rebinding against the pinned-IP connect, or mixed public/private
  resolution.
- **Workspace confinement** (`src/tools/file/`): escaping
  `FILETOOLS_WORKSPACE` via symlinks or path tricks.
- **Shell tool** (`src/tools/shelltools.ts`): bypassing the per-command
  deadline or output cap in a way that hangs or floods the bot.
- **Turn/queue handling** (`src/bot/`, `src/llm/`): a crash or infinite loop
  triggered by malformed model or Discord input that kills the bot process.

## Out of scope

- Misconfiguration: leaked `DISCORD_TOKEN` or `MODEL_API_URL`, running the
  bot on an untrusted host.
- Denial of service via volume (flooded channels, huge attachments) — the bot
  is expected to degrade, not crash.
- The model endpoint itself (llama.cpp, vLLM, LM Studio, …) — report it there.
