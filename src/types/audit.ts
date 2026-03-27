import type { GateResultLog } from "./gate.js";
import type { ProposalKind } from "./proposal.js";

export type AuditEntry = {
  auditId: string; // UUID
  timestamp: string; // ISO 8601
  proposalId: string;
  proposalKind: ProposalKind;
  totalUnits: number;
  approvedCount: number;
  downgradeCount: number;
  rejectedCount: number;
  conflictCount: number;
  // unitId → supportIds used during evaluation (for traceability)
  unitSupportMap: Record<string, string[]>;
  gateResults: GateResultLog[];
  retryAttempts?: number;
  metadata?: Record<string, unknown>;
};

export interface AuditWriter {
  append(entry: AuditEntry): Promise<void>;
}
