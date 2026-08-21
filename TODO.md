# TODO — web search/fetch + file tools

Snapshot: bot side **and** the Python sidecar are implemented and tested
(`npm test` 35 groups, `tools/test/smoke.py` 27 groups, `npm run typecheck`).
Docker build/up + live checks and the commit remain.

## Done

- [x] Bot side (`src/`): `llm/client.ts` tool calls (streamed fragment
      reassembly, `tools`/`tool_choice` on the wire), `tools/executor.ts`
      (registry, arg validation, concurrent execution), `tools/loop.ts`
      (pure `runToolTurn`), `tools/webtools.ts` / `filetools.ts` (sidecar
      clients + function specs), `tools/index.ts` (`buildTools`),
      `bot/writer.ts` `discard()`, `config.ts` tools section (opt-in,
      defaults off), `index.ts` turn loop, `test/smoke.ts`
- [x] Python sidecar (`tools/server/`): errors, config, ssrf (blocklist +
      pinned socket, per-hop redirect re-validation), fetcher (size cap,
      HTTPS/SNI), cache (TTL + max entries), web/{search,extract,browser,
      router}, file/{paths,router} (confinement, read windows, binary
      detection, exact-span edit), app factory; `tools/Dockerfile`,
      `tools/requirements.txt`
- [x] `docker-compose.yml` — `webtools` (127.0.0.1:8377) + `filetools`
      (profile `files`, 127.0.0.1:8378, bind mount `./workspace:/workspace`);
      read_only rootfs + tmpfs, cap_drop ALL, mem/cpu limits, healthchecks
- [x] `tools/test/smoke.py` — 27 check groups green via
      `.venv/bin/python tools/test/smoke.py` (hermetic: injected search
      backend, local http.server, temp workspace)
- [x] Docs: `.env.example`, `README.md` (tools section), `.gitignore`
      (`workspace/`, `.venv/`, `__pycache__/`), `AGENTS.md` (architecture +
      gotchas updated)

## Remaining

### 1. Live verification (needs Docker)

- [ ] `docker compose build`
- [ ] `docker compose up -d webtools` and `docker compose --profile files up -d`
- [ ] Live curl checks: `/health` on both, `/search` (real DDG), `/fetch`
      (real page; verify markdown + browser fallback), file round-trip
      through `./workspace`, persistence across container restart
- [ ] End-to-end: enable `WEBTOOLS_ENABLED`/`FILETOOLS_ENABLED` in `.env`,
      mention the bot, verify multi-round tool turns, transient-preview
      deletion, and the exhaustion note

### 2. Finish

- [ ] Commit (bot side / sidecar as separate commits, or one) — awaiting call

## Open notes

- llama.cpp only speaks tools with a function-calling chat template — if the
  endpoint rejects `tools`, keep `WEBTOOLS_ENABLED`/`FILETOOLS_ENABLED` off.
- Browser path can't pin DNS (Chromium resolves itself); pre-validation only.
  Documented residual, fine for a single-user bot.
- `file_edit` allows empty `new_text` (deleting a span) by design.
