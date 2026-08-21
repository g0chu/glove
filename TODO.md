# TODO — web search/fetch + file tools

Snapshot (updated after the in-process migration): both tool families now
run **in-process in the bot** — `src/tools/web/` (ssrf, fetcher, extract,
search, cache) and `src/tools/file/` (paths, ops). The Python sidecar
(`tools/`) and `docker-compose.yml` were removed; no Docker anywhere.
`npm test` (62 check groups) + `npm run typecheck` are green; the migration
is committed.

## Done (original sidecar migration — historical; the sidecar was later removed)

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

### Live verification (no Docker needed)

- [ ] Enable `WEBTOOLS_ENABLED`/`FILETOOLS_ENABLED` in `.env`, restart the
      bot, mention it, and verify multi-round tool turns, transient-preview
      deletion, and the exhaustion note
- [ ] Verify `./workspace` round-trips (write/edit/search/delete) and
      persists across bot restarts

## Open notes

- llama.cpp only speaks tools with a function-calling chat template — if the
  endpoint rejects `tools`, keep `WEBTOOLS_ENABLED`/`FILETOOLS_ENABLED` off.
- `web_fetch` has no browser rendering (JavaScript-heavy pages may come back
  incomplete) by design.
- `file_edit` allows empty `new_text` (deleting a span) by design.
