# Context preservation review

Reviewed 2026-09-08. The working context preserves completed tool rounds and
endpoint-provided reasoning, but it is not a lossless conversation archive.

## Fixes in this review

- Catch-up seeding keeps assistant tool calls and their results together when
  sorting fetched messages into history. Previously, a fetched message with an
  intermediate timestamp could split the group and produce invalid requests.
- Reply grouping no longer merges entries carrying reasoning or tool calls.
  Previously, grouping could discard the second entry's metadata.
- Reasoning-only assistant entries survive request rendering. Prefix counting
  includes them and empty tool results, keeping trigger positioning correct.
- If final delivery to Discord fails entirely, the completed model response is
  retained without message IDs instead of becoming an empty history entry.
- A JSON `null` context file fails soft instead of crashing startup; an array
  in place of the channels object is rejected as well.

Regression coverage exercises catch-up, tool adjacency, reasoning-only rendering,
prefix counting, serialization, and invalid persistence shapes. The delivery
fallback is covered by typechecking and review of the turn/writer integration;
the suite does not directly exercise the production event runner end to end.

## Archive implementation

The approved archive design is implemented. See [ARCHIVE.md](ARCHIVE.md) for
storage, commands, migration, recovery, and capture limits.

- An append-only journal and immutable content-addressed blobs retain captured
  Discord revisions, exact model request/response data, reasoning, tool intents
  and individual results, attachment bytes, and working-context checkpoints.
- Compaction, overflow trimming, edits, deletions, and clears change working
  context while preserving archived originals.
- Tool intents are durable before execution; individual results are durable
  before waiting for the rest of a concurrent batch. Unknown outcomes are
  explicitly indeterminate. Recovery never automatically replays a tool or post.
- Interrupted turns recover completed work exactly once into working context,
  respecting removed triggers and clears. Whole turns checkpoint atomically.
- Offline archive capture paginates from a durable cursor; recent known user
  messages are reconciled where possible. Retired IDs cannot be seeded back
  into working context. Deleted channels detach late persistence callbacks.
- Inspection/export and an explicit, offline archive purge are available.

## Limits that remain

This is preservation of observed data, not a guarantee of reconstructing anything
Discord or the endpoint never supplied. Missing permissions, deletions before
capture, hidden reasoning, disabled/oversized attachments, and machine/storage
failures still impose limits. An external effect and its journaled result cannot
be made one atomic transaction; recovery labels this uncertainty instead of
assuming the effect failed. Working context still compacts and does not
implicitly retrieve the whole archive. Raw generations and received partial
streams remain available in the archive even when they are unsuitable as valid
Chat Completions history.
