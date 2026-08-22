# TODO — known issues

Found during the bug hunt (see the "done" list for the earlier pass). Every fix
includes a regression test in `test/smoke.ts`; green = `npm test` +
`npm run typecheck`.

## Done (this pass)

### 9. A chunked bot reply re-seeds as N separate assistant entries after restart
- **Where**: the seed path — `ChannelContext.seedFrom` (compaction) and the
  classic `contextFromMessages` own-reply path — saw the channel's last-N
  messages, where a chunked reply is N separate Discord messages. Each became
  its own assistant entry: raw ``` close/reopen tokens visible at chunk
  boundaries, and per-chunk edit/delete instead of one-entry semantics.
- **Fix**: consecutive bot messages posted close together are grouped back
  into one entry (content joined with "\n", one id per chunk, per-chunk
  `chunks` array, so edit/delete bookkeeping matches a live chunked reply).
  - `src/llm/context.ts`: `groupConsecutiveReplies` + `BOT_REPLY_GROUP_GAP_MS`
    (5 s) wired into `seedFrom`.
  - `src/bot/context.ts`: `contextFromMessages` accumulates consecutive own
    messages and flushes them as one entry (same gap).
- **Why 5 s**: writer throttles are ~1–2 s, so chunks of one reply land
  well within the gap; two real replies are usually minutes apart. A user
  message between chunks breaks the group. Recorded (in-window) replies are
  never re-grouped — they already carry all chunk ids.

### 10. `@everyone`/`@here` in model output pings the whole server
- **Where**: all bot posts (reply chunks, thinking previews, notes) and the
  tool-activity lines.
- **Fix**: every `send`/`edit` carries `allowedMentions: { parse: ["users"] }`
  (`SAFE_MENTIONS` in `src/bot/writer.ts`, also used by the activity lines in
  `src/index.ts`): user pings stay active (the model can address a person),
  while @everyone/@here and role pings are suppressed. The text itself is
  unchanged — the mention just doesn't ping.

### 11. `settle` cascade: one failed chunk edit strands the remaining chunks
- **Where**: `ResponseWriter.settle` — a throw on chunk i aborted the loop;
  chunks after i were never posted and `finish`/`reportError` reported the
  canonical text as if everything had landed.
- **Fix**: each chunk is posted best-effort (failures are logged, the loop
  continues); a live message that failed to settle keeps its last preview.
  `finish`/`reportError` report the canonical text only when every chunk
  landed — otherwise the visible text of what actually was posted.

### 12. `reasoningStartedAt` timer edge — analyzed, unreachable, no change
- **Where**: `ResponseWriter.reason` only sets the timer when the reply buffer
  is still empty — exactly the condition under which a thinking message exists
  (`updateThinking` creates it only when `buffer` is empty). So whenever a
  thinking message is shown, the timer is already set and the "thought for
  Ns" line is accurate.

### 13. Unbounded `reasoningBuffer` growth
- **Where**: `ResponseWriter.reason` appended every reasoning delta with no
  cap — a long thinking stream grew memory without bound while only the last
  5 lines (~2000 chars) were ever displayed.
- **Fix**: the buffer keeps only the last 8000 chars; the "N lines hidden"
  count comes from a tracked total line count (newlines + trailing-line flag),
  so the preview stays accurate; inline ("whole thinking") mode is used only
  while the buffer is complete.

## Done (earlier pass)

1. **`splitForDiscord` fence overflow** — the fit check didn't reserve room
   for the closing token `emit()` appends when a fence is open → chunks up to
   `maxChars+5` → Discord 400. Fixed by reserving `closeOverhead` in the fit
   check and the reopened-chunk check.
2. **Fence-opener variant** (fuzzer) — a line that *opens* a fence was checked
   against the pre-toggle state; the opener itself could overflow. Fixed by
   computing the post-line-toggle fence state for the overhead.
3. **`breakCarryOver` carried-tail + fence opener overflow** — the carried
   chunk's eventual `emit()` wasn't checked against the closing-token
   budget. Fixed by reserving the post-line-toggle overhead in the suffix
   fit check (with a `hardSplit` guard for oversized lines).
4. **`prefixWindow` degenerate bounds** — both bounds were the whole
   directory, making the "bounded window" a full scan. Fixed: narrowest
   per-namespace bounds over `nsCandidates`.
5. **`readMimeList` offset bug** — `off += buf.length` double-counted
   `acc`, truncating the list at a straddle. Fixed: `off += bytesRead`.
6. **`BOT_UI_RE` missing 📚** — ZIM activity lines leaked into model
   context. Fixed: 📚 added to the UI-line regex.
7. **`editFile` had no size caps** — unbounded `fs.readFile` + no write cap.
   Fixed: stat-first read cap + `writeMaxBytes` (propagated through
   `filetools.ts`).
8. **`replaceScript` marker loss** — any unmapped subscript/superscript char
   dropped the `_`/`^` marker entirely. Fixed: all-or-nothing per group
   (keep raw if the group can't be fully mapped).
