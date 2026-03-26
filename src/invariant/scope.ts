import type { ExecutionResult, TaskSpec } from "../types.js";
import type { InvariantFailure } from "../failure/types.js";

export function checkScope(result: ExecutionResult, task: TaskSpec): InvariantFailure | null {
  for (const file of result.changedFiles) {
    const allowed = task.allowedFiles.some((pattern) => {
      const base = pattern.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
      return file.startsWith(base);
    });
    if (!allowed) {
      return { type: "SCOPE_VIOLATION", file };
    }
  }
  return null;
}
