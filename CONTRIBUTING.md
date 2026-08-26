# Contributors

Glove is small and self-contained, so the bar is simple: **`npm test` and
`npm run typecheck` are green** ("done means green" — `tsx` does not
typecheck, so a green test run proves nothing about types).

## Getting started

```bash
npm install
cp .env.example .env   # then fill in your values
npm run dev            # or: npm run build && npm start
```

See [README.md](README.md) for behavior and [AGENTS.md](AGENTS.md) for the
architecture map and the behavior pinned by `test/smoke.ts`.

## Code style

- Relative imports need explicit `.js` extensions in `.ts` files.
- 2-space indent, double quotes, semicolons; `import type` for type-only
  imports; explicit return types on exported functions; JSDoc on exported
  symbols.
- Lowercase error messages without a trailing period; log via `src/log.ts`,
  never bare `console.log`.
- No new runtime dependencies without discussion — the runtime stays
  `discord.js` + `dotenv`.

## Pull requests

### Before you start

- Search open issues and PRs first — duplicates will likely be closed without
  review.
- Features begin with an issue, not a PR.
- Bug-fix PRs include a regression test in `test/smoke.ts` (a plain
  `ok(name)` check group) that fails before the change and passes after.

### Preparing your PR

- One change per PR; no unrelated edits.
- Conventional subjects: `feat: …`, `fix: …` (maintainers squash-merge).
- `npm test` and `npm run typecheck` pass locally before you push.
- Ask before changing queue/history/writer/context semantics pinned by tests,
  the SSRF blocklist or workspace-confinement rules, or enabling tools in
  `.env`.

### After submitting

- Expect requests for modification; keep the PR small and rebased on `main`.
- Wait for CI before merging.

## AI usage policy

AI-generated code is allowed. You are 100% responsible for every line, however
it was produced.

1. Disclose how AI was used in the PR description.
2. Check for an existing PR addressing the same change first; if one exists,
   comment there instead of opening a duplicate.
3. Perform a comprehensive manual review prior to submitting.
4. Be prepared to explain every line of code you submitted.

## Code of conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md): be kind and
assume good faith.
