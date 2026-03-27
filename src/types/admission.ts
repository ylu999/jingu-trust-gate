import type { ConflictAnnotation, UnitEvaluationResult } from "./gate.js";

export type UnitStatus =
  | "approved"
  | "downgraded"
  | "rejected"
  | "approved_with_conflict";

export type AdmittedUnit<TUnit> = {
  unit: TUnit;
  unitId: string;
  status: UnitStatus;
  appliedGrades: string[]; // grade chain after downgrade(s)
  evaluationResults: UnitEvaluationResult[];
  conflictAnnotation?: ConflictAnnotation; // required when status === "approved_with_conflict"
  supportIds: string[]; // which SupportRefs were bound to this unit
};

export type AdmissionResult<TUnit> = {
  proposalId: string;
  admittedUnits: AdmittedUnit<TUnit>[]; // approved + downgraded + approved_with_conflict
  rejectedUnits: AdmittedUnit<TUnit>[]; // rejected only
  hasConflicts: boolean;
  auditId: string; // links to AuditEntry
  retryAttempts?: number;
};
