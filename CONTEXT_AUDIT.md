# Discord context audit

Reviewed message admission, REST refresh, startup catch-up, seed merging,
attachment downloads/storage, reactions, and context persistence.

All four context findings below have been fixed following approval. Their
descriptions and locations document the original failures before the changes.

## Fixes made

- Enable `GuildMessageTyping`: the existing `typingStart` interruption handler
  could not receive guild typing events without this intent.
- Use `cache: false` for seed, archive pagination, and startup reconciliation.
  discord.js otherwise patches cached Message objects in place. A stale REST
  observation could overwrite a message held by the stability gate before the
  caller checks whether gateway activity superseded that observation.
- Stop individual-message refresh requests immediately after interruption.
  Previously the loop continued requesting all missing tracked IDs after an
  activity event, only discarding its results at the end.
- Resolve archived attachment bytes by immutable Discord attachment identity
  as well as the original URL. Refreshed `ex`, `is`, and `hm` signatures no
  longer prevent reuse. Other URL parameters, paths, and hosts remain distinct;
  original archive records and recovery-index format are preserved.
- Signature-only URL refreshes persist new metadata without interrupting a turn
  or invalidating measured prompt size; actual attachment replacements still
  invalidate measurements and rendered attachment contents.

## Context findings addressed

### High: archived offline history is not fully merged into model context

Locations: `src/index.ts:134`, `src/bot/context.ts:142`,
`src/bot/context.ts:294`.

Archive catch-up captures all available messages after its durable cursor,
but its capture callback only archives them. The model's startup seed imports
only `min(MODEL_CONTEXT_MAX_MESSAGES, 100)` latest messages. For example, after
250 offline messages and a new mention, older offline messages can be present
in the archive yet absent from the model's conversation. A successful catch-up
does not guarantee complete working context.

Implemented: merge the complete successful catch-up into working context in
Discord order, preserving clear watermarks, retired IDs, live-event precedence,
tool groups, and bot UI exclusions. Historical observations do not enqueue
old mentions or replay bot actions. Context checkpoints precede completion.

### High: a new tracked trigger hides gaps before it

Locations: `src/bot/refresh.ts:15`, `src/index.ts:376`, `src/index.ts:398`.

Refresh paginates only until it reaches the newest tracked ID, then admits
untracked messages only when newer than that same ID. If message 1 is known,
messages 2 through 200 were missed, and new mention 201 commits, refresh stops
on the first page because it contains 201. Messages 2 through 101 are not fetched;
messages 102 through 200 are fetched but not admitted. After the one-time seed,
even a single missed message before a new trigger can remain absent.

Implemented: use a separately maintained, successfully reconciled REST cursor
rather than the newest context entry. Missing arrivals stabilize through the
gate and are inserted before newer triggers chronologically. Unfinished REST
coverage survives crashes; pending arrivals hold the cursor back. Legacy
archives reconcile once from their oldest tracked ID to repair previous gaps.

### Medium: older retained messages can keep stale edits and deleted content

Locations: `src/index.ts:145`, `src/index.ts:376`.

Both startup and per-turn direct reconciliation select only the latest 100
stored Discord IDs. Working context can contain far more. An older retained
message edited/deleted while the bot is offline, or during a missed gateway
event, is not checked unless it happens to be included in another REST page.
The model may continue receiving its obsolete text, attachments, or reactions.

Implemented: reconcile all retained backing IDs at startup and before every
model attempt, sequentially, using page observations first and direct fetches
for IDs outside those pages. Only Discord error 10008 establishes deletion;
permission failures do not delete context. This increases REST calls for long
retained conversations. Failed startup reconciliation skips the turn rather
than generating from a known incomplete transcript.

### Medium: seed observations lack per-message event precedence

Locations: `src/bot/context.ts:142-158`, `src/index.ts:929-1042`.

The seed protects concurrent clear operations and preserves existing tracked
text, but it unconditionally refreshes reactions from the fetched snapshot.
A newer reaction event may be overwritten. A fetched, previously untracked
message deleted while seed REST is in flight can also be imported afterward:
removing a nonexistent context entry leaves no seed-visible tombstone, and
`archive.wasTracked` is not a deletion filter. Aborting a model attempt does
not undo mutations already made by its context builder.

Implemented: reject seed observations after activity cancellation or concurrent
context mutation, before applying reactions or entries. Pending/retired/live
IDs are excluded from historical admission. Invalidated seeds remain retryable.

### Partial updates and reaction refreshes

Uncached Discord updates can lack complete content, author or attachment
metadata. They now trigger a complete REST fetch. Per-message gateway revisions
discard results and failures overtaken by newer events, including deletes.
Pending messages are held until the fetch completes, then restart stability;
newer messages cannot commit ahead of an unresolved older update. Reaction
refreshes use the same stale-observation guard. Channel deletion and shutdown
prevent late observations from recreating working context.

## Validation

Regression coverage includes a 250-message offline gap, gaps before a new
mention, edits/deletes outside the latest 100 IDs, interrupted reconciliation,
seed reaction/deletion races, partial-fetch ordering, held gate timers,
clear/retired/UI protections, attachment signature refreshes, and durable cursor
recovery through both full journal replay and the warm recovery index.

## Coverage limits

- Attachments intentionally have feature switches, admission windows, per-message
  counts, byte caps, and supported-type/text checks. Frozen skip/failure notes
  tell the model what was omitted, but do not supply those attachment contents.
- Compacted history remains a summary; reconciliation operates on retained
  messages and cannot directly revise individual messages already folded into it.
- Message adapters currently omit embeds, stickers, polls, and reply-reference
  metadata. Referenced messages outside fetched history are not fetched. These
  are additional coverage limits if “anything fetched from Discord” includes
  all visible Discord message types.
- Discord REST cannot reconstruct messages created and deleted while the bot
  was disconnected, nor intermediate offline edits. Complete current available
  history is attainable; complete unseen historical activity is not.

The first-run baseline and attachment admission settings remain explicit
coverage limits. Complete available history is distinct from unseen historical
activity that Discord no longer exposes.
