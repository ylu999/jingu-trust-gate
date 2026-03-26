import type { TaskSpec, ExecutionResult } from "../types.js";

export type RunTaskOptions = {
  workspaceDir: string;
  evidenceDir?: string;
  maxRetries?: number;
  /** Optional separate workspace directory for the agent (defaults to workspaceDir). */
  agentWorkspaceDir?: string;
  /** Optional agent override — when provided, replaces the default Claude adapter. */
  agentExecuteFn?: (task: TaskSpec, workspaceDir: string) => Promise<ExecutionResult>;
};
