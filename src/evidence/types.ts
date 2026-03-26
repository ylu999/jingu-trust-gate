export type EvidenceEntry = {
  taskId: string;
  iteration: number;
  verifyPass: boolean;
  verifyExitCode: number;
  decision: string;
  changedFiles: string[];
  timestamp: number;
  failureType?: string;
};
