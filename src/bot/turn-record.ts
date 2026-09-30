import type { ChannelContext } from "../llm/context.js";
import type { ToolRound } from "../tools/loop.js";
import type { PostedReply } from "./writer.js";

/** Preserve model text separately from Discord delivery text and editable chunks. */
export function recordTurn(
  turnId: string,
  context: ChannelContext,
  rounds: ToolRound[],
  roundSettled: Array<PostedReply | null>,
  posted: PostedReply | null,
  finalReasoning?: string,
  finalContent = "",
): void {
  context.appendTurn(
    rounds.map((r, i) => {
      const settled = roundSettled[i];
      return {
        content: settled?.text ?? r.content,
        modelContent: r.content,
        reasoning: r.reasoning,
        calls: r.calls,
        results: r.results,
        ids: settled?.messageIds ?? [],
        chunks: settled?.chunks,
      };
    }),
    {
      content: posted?.text ?? finalContent,
      modelContent: finalContent,
      reasoning: finalReasoning,
      ids: posted?.messageIds ?? [],
      chunks: posted?.chunks,
    },
    turnId,
  );
}
