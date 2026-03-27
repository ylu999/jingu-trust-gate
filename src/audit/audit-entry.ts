import type { AuditEntry } from "../types/audit.js";
import type { Proposal } from "../types/proposal.js";
import type { AdmittedUnit } from "../types/admission.js";
import type { GateResultLog } from "../types/gate.js";

export function buildAuditEntry<TUnit>({
  auditId,
  proposal,
  allUnits,
  gateResults,
  unitSupportMap,
  retryAttempts,
}: {
  auditId: string;
  proposal: Proposal<TUnit>;
  allUnits: AdmittedUnit<TUnit>[];
  gateResults: GateResultLog[];
  unitSupportMap: Record<string, string[]>;
  retryAttempts?: number;
}): AuditEntry {
  const approvedCount = allUnits.filter((u) => u.status === "approved").length;
  const downgradedCount = allUnits.filter(
    (u) => u.status === "downgraded"
  ).length;
  const rejectedCount = allUnits.filter((u) => u.status === "rejected").length;
  const conflictCount = allUnits.filter(
    (u) => u.status === "approved_with_conflict"
  ).length;

  return {
    auditId,
    timestamp: new Date().toISOString(),
    proposalId: proposal.id,
    proposalKind: proposal.kind,
    totalUnits: proposal.units.length,
    approvedCount,
    downgradedCount,
    rejectedCount,
    conflictCount,
    unitSupportMap,
    gateResults,
    retryAttempts,
  };
}
