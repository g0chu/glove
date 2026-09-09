import { randomUUID } from "node:crypto";
import type { ConversationArchive, ArchiveScope } from "../llm/archive.js";
import type { ToolExecutionObserver } from "./executor.js";

/** Journal individual executions with unique IDs, even if model call IDs repeat. */
export function archiveTools(archive: ConversationArchive, scope: ArchiveScope): ToolExecutionObserver {
  const executions = new Map<number, string>();
  return {
    started: (call, index) => {
      const executionId = randomUUID();
      executions.set(index, executionId);
      archive.record("tool.started", { ...scope, executionId }, { call, index });
    },
    finished: (result, index) => {
      const executionId = executions.get(index);
      if (!executionId) throw new Error("tool result has no archived execution start");
      archive.record("tool.finished", { ...scope, executionId }, { result, index });
    },
  };
}
