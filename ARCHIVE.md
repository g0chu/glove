# Durable conversation archive

`CHATS_ARCHIVE_DIR` defaults to `./data/archive`. The archive is enabled on startup;
no new dependency or tool permission is needed. Existing `CHATS_FILE` contexts are
imported on the first start. Once a channel has an archived checkpoint, it takes
precedence over `CHATS_FILE` on restart. The JSON file remains a convenient copy
of the compactable working context.

## What is retained

- Captured Discord message creates, updates, stable commits, fetched offline
  observations, and deletions. Original content is retained before mention
  replacement. Own-message gateway observations include posted UI messages.
- Every model call: reply rounds, chime decisions/repairs, and compaction. The
  archive stores the input messages/options, exact JSON request body, response
  status, received response body bytes, normalized result, and any failure.
  This includes endpoint-provided reasoning, tool-call fragments, unfinished
  streams, and unexecuted calls at the tool-round limit. Authorization headers
  are excluded.
- Tool execution intent before any handler starts, then each result as soon as
  that handler finishes. Concurrent tools have distinct execution IDs even if
  the endpoint repeats its own call IDs. Results preserve their original call
  order in model history.
- Downloaded attachment bytes under the existing image/file enable flags,
  per-message limits, and byte caps. Captured bytes can be reused after a CDN URL
  expires. Exact model inputs retain the inlined file text and image data too.
- Working-context checkpoints, including original reasoning, calls/results,
  and responses before compaction or overflow trimming. Entry blobs are shared
  between checkpoints. Clear and channel-delete events retain previous history.
- Canonical final delivery text/IDs separately from the raw model result, plus
  completed round narration delivery records.

`!clear` resets only the working context. It does not erase the archive. Discord
edits and deletions likewise update working context while preserving previous
observations in the archive. The model still receives a bounded, compactable
context; archival storage does not automatically put all historical content
back into every prompt or add an archive-search tool.

## Durability and recovery

`events.jsonl` contains versioned, sequential, hash-chained records. Each record
links to an immutable SHA-256 payload in `blobs/`. Binary response chunks and
attachments also use content-addressed blobs. Context payloads use manifests
referencing immutable entries, so repeated snapshots share large text/results.

Blob contents and directory entries are synced before the corresponding journal
record is appended and synced. An archive write failure stops the bot instead of
continuing with unrecorded model/tool work. Use a local filesystem with reliable
`fsync` and atomic rename semantics; hardware/filesystem failures can still defeat
software durability. The archive grows until explicitly purged; there is no
automatic retention limit. Journal scanning on startup verifies recorded payloads.

Only one process may own an archive. `.lock` records its PID and a unique owner ID.
A dead PID's lock is reclaimed on restart. `.claim` serializes lock acquisition;
if a process dies during that short acquisition step, inspect the archive and
verify that no writer is running before manually removing `.claim`. A live or
reused PID blocks acquisition rather than risking two writers.

A partial final journal line is copied to a `torn-tail-*.bin` file, then removed
from the active journal. Complete corrupt records or missing/corrupt referenced
payloads fail startup without silently replacing history with an empty archive.
Unreferenced blobs or temporary files from an interrupted write may remain.

Startup reports unfinished requests, turns, and tool executions. Completed work
from unfinished turns returns to working history once. Unknown tool outcomes get
explicitly labeled synthetic error results in **working history**, while the
archive retains the original incomplete evidence. Recovery invokes no model,
tool, or Discord send. A recorded turn ID prevents duplicate recovery; a clear
or removed trigger prevents restoring old working history. Shutdown aborts work
and waits up to 30 seconds for active turns/catch-up before exiting. Work still
unfinished at that point remains identifiable in the archive.

Offline capture paginates beyond Discord's 100-message page limit to the previous
durable cursor. Its original boundary survives a crash during catch-up. Recent
stored user messages (up to 100) are fetched individually to reconcile offline
edits/deletions; live events take precedence. A newly archived channel takes one
baseline page. Network/permission failures leave catch-up pending for retry.
Retired working-context IDs are excluded from subsequent seeding.

## Inspect and export

Stop the bot first; these commands acquire the archive's single-writer lock and
verify it using the same recovery reader. They can quarantine a torn final line.

```bash
npm run archive -- inspect ./data/archive
npm run archive -- export ./data/archive --channel=DISCORD_CHANNEL_ID
```

For a clean JSONL export without npm's script banner:

```bash
node --import tsx src/archive-cli.ts export ./data/archive --channel=DISCORD_CHANNEL_ID > conversation.jsonl
```

Omit `--channel` to export all events. Exported rows include decoded JSON payloads;
context manifests expand to complete entries. A `blob` field inside a payload
references exact bytes in `blobs/<hash>`. Concatenate `model.bytes` blobs in
sequence order for a request ID to reconstruct its received HTTP body. Copy the
whole archive directory for a complete backup, including binary content.

## Explicit purge

With the bot stopped:

```bash
npm run archive -- purge ./data/archive --confirm
```

This permanently removes that archive, after verifying it and acquiring its lock.
It does not remove `CHATS_FILE`; any remaining working context is imported into
a new archive on the next start. To erase both kinds of history, separately
remove the configured `CHATS_FILE` while stopped as well. Discord channel history
is independent and may still be seeded into a fresh installation.

## Capture limits

The archive preserves what the bot observes; it cannot recover reasoning the
endpoint never exposes, messages deleted before capture, unavailable Discord
history, or bytes never downloaded under the configured attachment limits.
Bytes received before a process crash but not yet committed may be absent.
An external side effect can finish just before a crash prevents its result from
being recorded; its outcome is indeterminate, not proof that it failed.
Working-history summaries remain lossy, and the Discord event runner has not been
validated against a live guild by the hermetic test suite.
