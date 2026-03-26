export type RunTaskOptions = {
  workspaceDir: string;
  evidenceDir?: string;
  maxRetries?: number;
  /** Optional separate workspace directory for the agent (defaults to workspaceDir). */
  agentWorkspaceDir?: string;
};
