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
  archive stores the structured request once, response status, parsed result,
  and any failure. During streaming, `model.progress` batches retain text,
  reasoning and indexed tool-call fragments. Completed results include reasoning
  and unexecuted calls at the tool-round limit. HTTP/SSE framing, malformed or
  incomplete wire frames, and authorization headers are not retained in new captures.
- Tool execution intent before any handler starts, then each result as soon as
  that handler finishes. Concurrent tools have distinct execution IDs even if
  the endpoint repeats its own call IDs. Results preserve their original call
  order in model history.
- Original attachment bytes, including binary formats, captured independently
  of the model's image/file enable flags. Filenames keep their extensions;
  metadata retains the exact original name, content type and checksum. Captured
  bytes can be reused after a CDN URL expires. Exact model inputs retain the
  inlined file text and image data too.
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

New writes use version 2: `_system/events.jsonl` contains sequential, hash-chained records
with JSON payloads directly inside each record. No database or new dependency
is required. A typical archive looks like this:

```text
archive/
  README.md                    # short guide to the folders
  channels/general--<channel-id>/
    channel.json                # available channel name / guild metadata
    context.json                # latest working context (null after deletion)
    events/YYYY-MM-DD.jsonl     # readable channel event history
    turns/YYYY-MM-DD/HH-mm-ss.sss--reply--<turn-id>/
      events.jsonl              # incremental turn events
      turn.json                 # complete or recovered/incomplete turn
    attachments/<message-id>/
      Meeting notes--<id>--<checksum>.pdf
      metadata/<filename>.json
  _system/
    events.jsonl                # authoritative events, with inline JSON
    checkpoints/<sha256>.json   # shared checkpoint entries and manifests
    attachments/<sha256>/Meeting notes.pdf # immutable original attachment bytes
    responses/<request-id>.bin  # legacy raw captures, when present
    recovery-index.json
    layout.json
    quarantine/torn-tail-<id>.bin # incomplete journal tails, when present
```

Channel folder names use the first observed Discord name plus the channel ID;
the ID distinguishes channels with identical names. Folders stay stable across
channel renames, while `channel.json` reflects the current name. A channel without
name metadata uses `channel--<id>`. Turn folders use the UTC start date/time and a
`reply` or `chime` label; a turn crossing midnight keeps its original folder.
Original attachment filenames retain spaces, Unicode and extensions where portable;
unsafe or overly long names are encoded without losing the original name in metadata.

Channel views are derived from the verified journal. `context.json` is a convenient
view, not the recovery source. Completed turn JSON includes model exchanges,
reasoning, tool intent/results, delivery and status. Incomplete turn snapshots are
written on close or view rebuild; their JSONL files contain the incremental work.
Native attachment views use hard links where supported, with copy fallback;
exports always copy bytes so they are independent backups. Treat archive files as
immutable, including hard-linked attachment views.

New model captures retain parsed output instead of exact HTTP response bytes.
Text, reasoning and indexed tool-call fragments are batched for up to one second
or 16 Ki characters, whichever comes first. Each committed batch is journaled
and synced normally. Failures/interruption flush the pending batch before the
failure record; successful completion writes the full parsed result instead of
duplicating the pending batch. This removes per-network-chunk file writes,
checksums, journal fsyncs and duplicated transport metadata. The request body is
stored once rather than also copying the conversation into `model.started`.

A sudden process crash can lose the unflushed partial-output batch (up to one
second). Completed model results, tool intents/results and context checkpoints
remain immediately durable. Wire-level debugging, including malformed or
incomplete frames, is unavailable for new captures. Attachment bytes still
retain their original formats for reuse after CDN URLs expire.

Existing `model.bytes` records and response files remain readable and verifiable;
no existing evidence is removed or rewritten. Legacy ranges carry byte offsets,
lengths and SHA-256 checksums. JSONL readers frame large inline requests without
repeatedly copying the growing line. Checkpoint manifests reference shared
`.json` entries, so repeated checkpoints do not duplicate every old entry in
the journal.

Content files and directory entries are synced before the corresponding journal
record is appended and synced. An archive write failure stops the bot instead of
continuing with unrecorded model/tool work. Use a local filesystem with reliable
`fsync` and atomic rename semantics; hardware/filesystem failures can still defeat
software durability. The archive grows until explicitly purged; there is no
automatic retention limit.

Bot startup uses a disposable, checksummed `_system/recovery-index.json`. It verifies the
entire indexed journal prefix with SHA-256, restores derived recovery state, then
fully verifies and replays any newer records. The first startup (or a missing,
damaged, incompatible, or invalidated index) performs the full scan. The index is
saved atomically after successful recovery and on clean shutdown; after a crash,
records since the last index are scanned again. Index write failures leave the
durable journal intact and only affect startup speed.

Clean warm startup does not reread every historical payload. Content is hash-verified when
read, including restored working contexts and attachments. Readable views rebuild
on first upgrade or after an unclean session; this reads historical payloads and
can take longer for a large archive. Removing `_system/layout.json` while stopped also
forces a view rebuild. To check all recorded
payloads and response/attachment bytes for disk corruption, stop the bot and run
`npm run archive -- inspect`; CLI commands always use exhaustive recovery.
The index can be removed while stopped to force a full startup verification.

Journal hashing uses a fixed 1 MiB buffer. Checkpoint entries are indexed one at
a time, with at most 16,384 entry hashes kept for deduplication; this accelerator
is not persisted. Recovery indexes larger than 64 MiB are skipped. Closing the
archive releases all in-memory indexes. Required retired-message IDs, recorded
turn IDs, attachment references and recovery metadata still grow with history;
dropping these would break recovery or revive cleared history.

Only one process may own an archive. `_system/.lock` records its PID and a unique owner ID.
A dead PID's lock is reclaimed on restart. `_system/.claim` serializes lock acquisition;
if a process dies during that short acquisition step, inspect the archive and
verify that no writer is running before manually removing `_system/.claim`. A live or
reused PID blocks acquisition rather than risking two writers.

A partial final journal line is copied to `_system/quarantine/torn-tail-*.bin`, then removed
from the active journal. Complete corrupt records fail startup; missing/corrupt referenced payloads fail
when verified (during exhaustive recovery, suffix replay, or content access),
without silently replacing history with an empty archive.
Unreferenced blobs or temporary files from an interrupted write may remain.

Startup reports unfinished requests, turns, and tool executions. Completed work
from unfinished turns returns to working history once. Unknown tool outcomes get
explicitly labeled synthetic error results in **working history**, while the
archive retains the original incomplete evidence. Recovery invokes no model,
tool, or Discord send. A recorded turn ID prevents duplicate recovery; a clear
or removed trigger prevents restoring old working history. Shutdown aborts work
and waits up to 30 seconds for active turns/catch-up before exiting. Work still
unfinished at that point remains identifiable in the archive.

Offline capture paginates beyond Discord's 100-message page limit to the last
completed REST cursor. All available messages in that gap enter working context
chronologically; historical mentions do not queue replies. Every retained
Discord message ID (including bot reply chunks) is reconciled for edits,
attachments, reactions and deletions, using page observations first and direct
fetches for missing IDs. Live events take precedence. A newly archived channel
takes one baseline page, with the working seed bounded by
`MODEL_CONTEXT_MAX_MESSAGES` (at most 100).

Before each model attempt, refresh repeats reconciliation and paginates from
the last completed REST cursor. New gateway messages do not advance that cursor,
so a new mention cannot hide missed messages before it. Interrupted or failed
refreshes retain their original boundary across a crash. Completion is recorded
only after context checkpoints, and pending arrivals keep the cursor behind
their uncommitted IDs. Legacy archives reconcile once from their oldest tracked
ID to repair earlier gaps. Retired IDs and clear watermarks prevent resurrection.
Network/permission failures leave catch-up pending for retry; incomplete startup
catch-up skips the turn. Fetches are sequential and respect Discord rate limits;
long retained conversations require more REST requests than the former 100-ID
reconciliation window.

## Inspect and export

Stop the bot first; these commands acquire the archive's single-writer lock and
verify it using the same recovery reader. They can quarantine a torn final line.

```bash
npm run archive -- inspect ./data/archive
npm run archive -- export ./data/archive --channel=DISCORD_CHANNEL_ID
npm run archive -- export ./data/archive --channel=DISCORD_CHANNEL_ID --output=./conversation-export
```

For a clean JSONL export without npm's script banner:

```bash
node --import tsx src/archive-cli.ts export ./data/archive --channel=DISCORD_CHANNEL_ID > conversation.jsonl
```

Omit `--channel` to export all events. Without `--output`, the command retains its
JSONL stdout behavior; decoded checkpoint manifests expand to complete entries.
New parsed progress/results are included directly. This stream alone does not
include attachment or legacy response bytes. Version 1
`model.bytes` payloads refer to `blobs/<hash>`; version 2 payloads identify a range
in `_system/responses/<request-id>.bin`. Concatenate the committed ranges in event order
to reconstruct the received HTTP body.

With `--output`, export creates a self-contained folder containing expanded JSON
events, channel/turn views, original-format attachment copies, metadata and response
files, using the same named channel and dated turn folders. Internal export files
live under `_system/`; its `events.jsonl` contains expanded events and `export.json`
identifies the export format. Attachment `file` paths and response ranges resolve within the export.
The output must not exist and must be separate from the source archive. Folder
exports are for browsing and sharing; they are not bot recovery archives. Copy
the whole native archive directory for a recovery backup.

## Attachment capture settings

`ARCHIVE_ATTACHMENTS_ENABLED=true` is the default. Every observed message's
attachments are queued for background capture, including fetched offline history;
model image/file settings still independently determine what enters prompts.

- `ARCHIVE_ATTACHMENT_MAX_BYTES=25000000`: maximum bytes per attachment.
- `ARCHIVE_ATTACHMENTS_MAX_PER_MESSAGE=10`: maximum attachments per observation.
- `ARCHIVE_ATTACHMENT_TIMEOUT_S=30`: deadline per download.

Only HTTPS Discord CDN URLs are accepted and redirects are refused. Downloads
read incrementally and enforce the received-byte cap even if metadata is wrong.
Capture is sequential with at most 256 pending message observations; repeated
observations are deduplicated and saved bytes are reused across signature refreshes.
Oversized, unavailable, timed-out and queue-rejected attachments retain an
`attachment.skipped` event explaining why their bytes are absent. A later message
observation can retry failed downloads. Shutdown aborts capture and waits for its
bookkeeping alongside active turns. Setting capture to false disables this
independent background capture; model-admitted downloads still archive their bytes.

## Upgrade and migration

Existing version 1 archives remain readable by the bot, CLI and web UI. New events
use version 2 in the same journal; original records and blobs remain intact. The
first opening builds readable channel views. No migration is required to resume.

To convert all old payloads and attachments into native version 2 storage, stop
the bot and create a verified copy:

```bash
npm run archive -- migrate ./data/archive --output=./data/archive-v2
```

Migration preserves event order, timestamps, scopes, checkpoints, original bytes
and unfinished operations. It invokes no model, tool or Discord send. The copy
is exhaustively verified and compared with the source before publication;
`_system/migration.json` records the source head and verification. Existing outputs and
paths inside the source are refused. Failed migrations may leave a sibling
`.migrating-*` directory for inspection; the original archive is retained.

After a successful migration, set `CHATS_ARCHIVE_DIR` to the new directory and
restart the bot and web UI. Keep the original until you have checked the new copy.

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
