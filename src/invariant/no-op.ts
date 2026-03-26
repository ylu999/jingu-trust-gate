import type { ExecutionResult } from "../types.js";
import type { InvariantFailure } from "../failure/types.js";

export function checkNoOp(result: ExecutionResult): InvariantFailure | null {
  if (result.changedFiles.length === 0) {
    return { type: "NO_OP" };
  }
  return null;
}
