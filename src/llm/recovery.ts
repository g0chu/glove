import type { ConversationArchive, ArchiveRecord } from "./archive.js";
import type { ChannelContextStore, ChannelContext } from "./context.js";
import type { ChatMessage, ChatResult, ToolCall } from "./client.js";
import type { ToolResultMessage } from "../tools/executor.js";
import type { PostedReply } from "../bot/writer.js";

type RecoveredRound = Parameters<ChannelContext["appendTurn"]>[0][number];

/**
 * Recover completed model/tool work into working history once, without
 * network I/O or replay. The immutable journal retains the actual evidence;
 * synthetic tool results below explicitly identify uncertain outcomes.
 * A cleared/deleted trigger never restores an old turn into working history.
 */
export function recoverTurns(archive: ConversationArchive, contexts: ChannelContextStore): number {
  const pending = new Map(archive.incomplete().turns.map((record) => [record.scope.turnId!, record]));
  if (!pending.size) return 0;
  const evidence = new Map<string, ArchiveRecord[]>();
  const checkpoints = new Map<string, number>();
  const relevant = new Set(["model.finished", "reply.accepted", "tool.started", "tool.finished", "round.finished", "discord.delivery", "chime.accepted"]);
  for (const record of archive.records()) {
    if (record.type === "context.checkpoint" && record.scope.channelId) checkpoints.set(record.scope.channelId, record.seq);
    const turnId = record.scope.turnId;
    if (!turnId || !pending.has(turnId) || !relevant.has(record.type)) continue;
    const rows = evidence.get(turnId) ?? [];
    rows.push(record);
    evidence.set(turnId, rows);
  }
  let recovered = 0;
  for (const [turnId, start] of pending) {
    const { channelId, messageId } = start.scope;
    const context = channelId && contexts.has(channelId) ? contexts.get(channelId) : null;
    if (!context || !messageId || !context.has(messageId) || archive.hasRecordedTurn(turnId)) {
      archive.record("turn.recovered", start.scope, { restored: false, reason: "already recorded or trigger removed" });
      continue;
    }
    const rows = evidence.get(turnId) ?? [];
    const decisions = rows.filter((record) => record.type === "chime.accepted");
    let retainedDecisions = 0;
    for (const record of decisions) {
      const exchange = archive.readData<{ exchangeId: string; messages: ChatMessage[]; position?: number; timestamp?: number }>(record);
      // A later checkpoint is authoritative: a missing exchange was already
      // compacted/trimmed, so recovery must not resurrect it from the journal.
      if ((checkpoints.get(channelId!) ?? 0) < record.seq) {
        context.appendExchange(exchange.messages, exchange.exchangeId, exchange.position, exchange.timestamp);
      }
      if (context.snapshot().some((entry) => entry.exchangeId === exchange.exchangeId)) retainedDecisions++;
    }
    const rounds: RecoveredRound[] = [];
    let final: Parameters<ChannelContext["appendTurn"]>[1] | undefined;
    // Shared-schema replies can make multiple raw requests for one round.
    // Only the accepted result can start its tools, including reply chime calls.
    // Legacy reply records remain recoverable; raw candidates stay archived.
    const models = rows.filter((r) => (r.type === "model.finished" || r.type === "reply.accepted") && r.scope.purpose === "reply");
    for (const model of models) {
      if (archive.hasRecordedTurn(`${turnId}:attempt:${model.scope.attempt}`)) continue;
      const result = archive.readData<ChatResult>(model);
      const sameRound = rows.filter((r) => r.scope.attempt === model.scope.attempt && r.scope.round === model.scope.round);
      if (result.toolCalls.length === 0) {
        final = { content: result.content, reasoning: result.reasoning, ids: [] };
        continue;
      }
      const starts = sameRound.filter((r) => r.type === "tool.started");
      if (!starts.length) continue; // requested but never executed (including round cutoff)
      const completed = sameRound.find((r) => r.type === "round.finished");
      const delivery = completed ? archive.readData<{ delivery: PostedReply | null }>(completed).delivery : null;
      const results = result.toolCalls.map((call: ToolCall, index): ToolResultMessage => {
        const intent = starts.find((r) => archive.readData<{ index: number }>(r).index === index);
        const finished = intent ? sameRound.find((r) => r.type === "tool.finished" && r.scope.executionId === intent.scope.executionId) : undefined;
        if (finished) return archive.readData<{ result: ToolResultMessage }>(finished).result;
        return {
          role: "tool", name: call.name, toolCallId: call.id,
          content: intent
            ? "Error: execution outcome is indeterminate after process restart; side effects may have occurred. Do not automatically repeat this operation; reconcile its state first."
            : "Error: this call was not started before process restart",
        };
      });
      rounds.push({ content: delivery?.text ?? result.content, modelContent: result.content, reasoning: result.reasoning, calls: result.toolCalls, results, ids: delivery?.messageIds ?? [], chunks: delivery?.chunks });
    }
    const delivered = [...rows].reverse().find((r) => r.type === "discord.delivery");
    if (delivered) {
      const data = archive.readData<{ posted: PostedReply | null; raw: string; reasoning?: string }>(delivered);
      final = { content: data.posted?.text ?? data.raw, modelContent: data.raw, reasoning: data.reasoning, ids: data.posted?.messageIds ?? [], chunks: data.posted?.chunks };
    }
    if (rounds.length || final) {
      context.appendTurn(rounds, final ?? { content: "[turn interrupted by process restart; retained tool results above, no automatic replay]", ids: [] }, turnId);
      recovered++;
    }
    if (retainedDecisions > 0 && !rounds.length && !final) recovered++;
    archive.record("turn.recovered", start.scope, { restored: retainedDecisions > 0 || rounds.length > 0 || final !== undefined });
  }
  return recovered;
}
