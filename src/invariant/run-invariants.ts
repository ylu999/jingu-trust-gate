import type { ExecutionResult, TaskSpec } from "../types.js";
import type { InvariantFailure } from "../failure/types.js";
import { checkScope } from "./scope.js";
import { checkNoOp } from "./no-op.js";

export function runInvariants(result: ExecutionResult, task: TaskSpec): InvariantFailure[] {
  return [checkScope(result, task), checkNoOp(result)].filter((f): f is InvariantFailure => f !== null);
}
