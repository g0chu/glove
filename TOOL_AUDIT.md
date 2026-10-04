# Tool functionality and schema audit

Reviewed 2026-09-30 against `823fd94` and the working-tree memory/Wikipedia changes.
The targeted Wikipedia implementation originated in `576cad1`; `004acb2` subsequently
updated schema descriptions. This review covers all 12 executable tools plus the
local `chime` tool, their registration, argument parsing, execution, cancellation,
output limits, model request wiring, and archive lifecycle.

## Findings corrected in this working tree

| Finding | Correction and verification |
| --- | --- |
| Wikipedia browsing choices were obscure, and `abstract` was a 1000-character prefix rather than the introduction. | ZIM/vault read schemas expose `intro`, `sections`, `section`, and `full`. Legacy `abstract`/`outline` remain supported. Executor-level tests exercise both backends. |
| A page title heading could make the lead empty. | An initial H1 is treated as the title; intro/lead ends at the next heading. A long introduction is paginated rather than clipped at 1000 characters. |
| HTML extraction discarded a parent heading whose content existed only in subsections. | Retain parents with descendant text, still discard empty sections. Regression checks extraction followed by targeted reading. |
| A numeric heading could collide with an outline ID. | Exact IDs take precedence over heading names. Regression checks a heading named `1`. |
| Section boundary discovery repeatedly sliced/scanned the heading list. | Use a reverse stack to find the next heading at the same or shallower level. Nested section tests verify boundaries. |
| `file_read` could report continuation beyond content hidden by its character cap. | Reduce the byte window before reading; displayed continuation follows visible content. Test a 3000-byte file with a 1000-character result cap. |
| Invalid file boolean arguments silently became false; integer arguments accepted booleans, arrays, and unsafe integers. | Reject these values before operations. Numeric strings remain tolerated; declared integers are still clamped to documented ranges. Tests cover malformed inputs and unchanged files. |
| Shell cap was per stream despite being documented as combined stdout/stderr; max-buffer kills could be classified as timeouts. | Count combined output, bound returned bytes, classify output overflow before generic killed status. Regression produces 700 bytes on each stream with a 1000-byte cap. |
| Web search was not cancelled by tool-stack shutdown. | Track search controllers alongside fetch controllers and combine caller cancellation with the request timeout. Injected pending search proves shutdown cancellation. |
| DuckDuckGo redirect host matching accepted unrelated domains ending in `duckduckgo.com`. | Require the exact domain or a dot-delimited subdomain. Regression verifies an unrelated suffix domain is not unwrapped. This does not change the SSRF blocklist. |
| Vault ripgrep queries beginning with `-` could be interpreted as options. | Add `--` before the literal query. Regression exercises a `--literal-option` query through the subprocess path. |
| Vault filename parsing assumed each stdout chunk contained complete newline-delimited names; stderr collection was unbounded. | Use NUL-delimited names, retain incomplete chunks, decode streaming UTF-8, stop collecting after the result limit, and cap stderr diagnostics. Fake-ripgrep tests use the same NUL protocol. |
| Vault shutdown tracked only the last concurrent subprocess. | Track a set of active children, remove closed children, and kill all on shutdown. Also kill a child that starts after shutdown. Reviewed against concurrent execution in the registry. |
| Documentation claimed only final replies were retained and generated tool guidance was inserted into the master prompt. | README now reflects full round retention, the shared activity message, schema-based guidance, and all available families. |

## Tool-by-tool contract

| Tool | Functionality and schema agreement | Limits / important behavior |
| --- | --- | --- |
| `web_search` | Required nonempty query; default 5 results, clamped to 1–10 and config. Returns titles, URLs, snippets. | DuckDuckGo HTML search; timeout and shutdown cancellation; result characters capped. No browser rendering. |
| `web_fetch` | Required absolute HTTP(S) URL; extracts title/text, reports final URL and body truncation. | SSRF validation, pinned IP, credential rejection, redirect/body/deadline limits and TTL cache. Character cap can further truncate output. |
| `file_read` | Required workspace-relative path; byte offset, optional byte limit. Zero/omitted limit uses configured cap. | Offset clamped to 0–100000000; limit clamped to 0–1000000 and configured/read-result budgets. NUL heuristic rejects binary-looking files. |
| `file_write` | Required path and exact string content; empty content is valid. Optional boolean `create_dirs`, default false. | Whole-file overwrite, configured UTF-8 byte cap, existing workspace required. |
| `file_edit` | Required path, nonempty exact `old_text`, exact `new_text`; optional boolean `replace_all`, default false. | First occurrence by default; strict UTF-8, read/write byte caps, no-match fails without writing. Whitespace is preserved. |
| `shell_exec` | Required command; integer timeout defaults to config, minimum 1, clamped to configured cap. | `/bin/sh`, workspace is initial directory only; unsandboxed. Combined output cap and deadline; returns partial output on kill. |
| `wikipedia_search` | Required title/path query, max 256 normalized characters; 5 default results, clamped to 1–10/config. | Exact/prefix/substring title/path search; time-limited scans. Does not search article bodies. Redirects reported. |
| `wikipedia_read` | Required exact title/wiki path; explicit intro/sections/section/full modes, section selector, literal query and pagination. | Redirect resolution and ambiguity errors. Defaults to 3000 text characters, capped by config. Header/continuation metadata are extra. Full article text is available before selection. |
| `vault_search` | Required query, max 256 normalized characters; 5 default results per title/body list, clamped to 1–10/config. | Ranked title matches plus literal case-insensitive body matches; ripgrep with JS fallback. Scan limits can produce partial results. |
| `vault_read` | Required note title/file stem; shared Wikipedia browsing modes and pagination. | File stem first, then normalized exact title; ambiguous titles require stems. Frontmatter omitted except legacy abstract mode. User-supplied names reject separators and `..`. |
| `vault_links` | Required note title/stem; same resolution as read. | Up to 50 unique unanchored wikilink targets in appearance order. Anchored links are not returned; extracted link collection itself caps at 200. |
| `memory` | Required action enum; save/read/delete require a key, save requires string content, search requires query. Empty saved content is allowed. | Shared bot-wide store, exact keys up to 200 characters, case-insensitive substring search, serialized operations, atomic renamed writes, total-store byte cap and result character cap. Corrupt stores fail without overwrite. |
| `chime` | Boolean respond and string reason declared required. Decision phase accepts one chime call; reply phase acknowledges it and continues. | Intentionally tolerates yes/no strings and missing reason for endpoint compatibility. Decision generation uses the endpoint output limit; one repair for unusable responses. Calls are not authorization to execute other tools in the decision phase. |

All schemas use object parameters with `additionalProperties: false`. The schema
regression checks unique names, declared required fields, descriptions, and the
four explicit Wikipedia modes across all 13 tools. Tool specs are sent as OpenAI
function objects with `tool_choice: "auto"`; they do not enable strict structured
outputs, which many compatible endpoints do not support.

The registry validates the argument JSON object and invokes each tool's argument
helpers; it is not a general JSON Schema validator. Unknown extra properties are
ignored by handlers even though schemas ask the model not to send them. Optional
strings may be absent/null/blank. Integer helpers intentionally accept numeric
strings and clamp ranges. Conditional requirements such as memory keys and
Wikipedia section selectors are enforced by handlers and described in schemas.
The model must receive updated schemas after restarting the bot.

## Execution and recovery review

- Disabled families are absent from the registry. No tools or dependencies were
  enabled/added by this review. Existing SSRF and file-workspace rules remain.
- Tool failures become paired `Error: …` results. Concurrent executions preserve
  result order. Memory serializes its own operations so concurrent calls do not
  lose notes; other tool families still execute concurrently.
- Archive observers journal every intent before starting a batch and each result
  immediately on completion, with unique execution IDs. Archive failures propagate
  rather than being converted into ordinary model-visible tool errors.
- Completed tool rounds include text, reasoning, calls and results. Interruption
  retains completed work; recovery does not automatically replay tools. The round
  cap counts execution rounds, not individual calls.
- Chime/reply schemas retain a shared ordered prefix. Tool-free fallback is limited
  to explicit compatibility rejection with no other executable tools enabled.
- Existing smoke coverage exercises model SSE/JSON function-call assembly, errors,
  round limits, archive recovery, SSRF and file confinement. It uses fixtures and
  local mock endpoints, not a live Discord guild or a production Wikipedia dump.

## Remaining findings and limitations

These remain visible follow-up work; passing tests do not establish stronger
permissions, durability, or resource bounds than the implementation provides.

| Priority | Finding / affected code | Recommended follow-up |
| --- | --- | --- |
| High for untrusted vault data | `vaulttools.ts` validates the requested note but trusts the file stem returned from `index.tsv`; `readNoteFile` follows symlinks. A fixture with `Alias<TAB>../outside` reads outside the vault, as does a symlink named `Linked.md`. Both were reproduced in an isolated temp directory. | Treat the configured vault/index as trusted today. Define and enforce a vault-root confinement policy for resolved filenames and symlinks before accepting untrusted corpora. This review does not change confinement rules. |
| Medium | `shelltools.ts` kills the immediate shell, not an entire process group. Descendants may survive or retain pipes; a signal-ignoring process is not guaranteed to obey the configured deadline. Shutdown kills are currently reported as timeouts. | Add process-tree termination and distinct cancellation reporting, with Linux/macOS coverage. The command deadline is not a host sandbox. |
| Medium | `file/paths.ts` checks paths before async operations. A concurrent local actor can change symlinks between checks and use. File writes are not atomic, and concurrent edits to the same file can lose updates. | Define the local workspace trust model; consider descriptor-based operations, atomic writes, and per-path serialization. Preserve the existing confinement contract with dedicated race tests. |
| Medium | `web/search.ts` reads the entire search response with `res.text()`. Vault corpus loading, note reads, and JS fallback scans read whole files/listings; scan deadlines are checked around work, not a hard bound on each filesystem read. | Add explicit input byte caps and bounded reads, and cancellation for JS scans. Existing result caps only limit what is returned to the model. |
| Medium | Vault search and links do not uniformly apply `TOOLS_MAX_RESULT_CHARS`; read headers/frontmatter and browsing metadata are outside the text budget. Other tool truncation markers are also extra. Large title/index entries can expand results beyond the nominal cap. | Decide whether the cap means body text or complete serialized result, then implement a shared limiter that preserves pagination metadata. Current browsing schemas explicitly describe metadata as extra. |
| Low / correctness | `file_read` detects NULs only in the first 8192 bytes and decodes read windows permissively. Invalid UTF-8 or a byte window split inside a character can produce replacement characters. | Distinguish raw byte-window reading from strict text reading; specify safe UTF-8 pagination behavior. `file_edit` already decodes strictly. |
| Low / completeness | Wikipedia outlines use ATX headings; setext headings are not recognized. Intro assumes an initial H1 is a page title. ZIM search does not support body search or outgoing links; vault link extraction excludes anchored links and may report a capped count as a total. | Add heading-format/link support if actual corpus samples require it; keep these capabilities explicit rather than claiming full MediaWiki navigation. |
| Low / completeness | Search/resolve scans are budgeted, so misses and ambiguity detection need not be exhaustive. Vault title ranking collects a bounded candidate set, and its cached index does not refresh until restart. Ripgrep searches recursively whereas the advertised vault layout is flat. | Report incomplete resolution clearly, validate flat corpus layout, and add explicit corpus reload if live rebuilds need support. |
| Design limitation | Memory has one shared namespace, no per-user authorization, no multi-process lock, no paginated results, and no automatic prompt injection. A large search/list/read can be truncated. Delete removes the active note but not archived calls/results. Its renamed file is synced, but the parent directory is not fsynced. | Use one bot process and descriptive identity-aware keys. Add scopes, pagination, locking, or stronger crash durability only after defining the desired contract. |
| Compatibility choice | Schema strictness and runtime tolerance differ deliberately; no general schema enforcement or per-round tool-call count limit exists. | Avoid silently adding strict endpoint requirements. If enforcing all schemas or limiting concurrent calls, define compatibility behavior and test tool-result pairing. |

## Validation

`npm run typecheck` passed; `npm test` passed all 218 check groups. Regression coverage
includes Wikipedia modes and section boundaries, file pagination and argument
validation, combined shell output, search cancellation and redirect-host matching,
literal vault queries, memory persistence/corruption/concurrency, and schema shape
for every registered tool. No live endpoint validation or macOS execution was
performed locally; CI remains responsible for its configured platform checks.
