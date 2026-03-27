import type { UnitEvaluationResult, ConflictAnnotation } from "../types/gate.js";
import type { AdmittedUnit, UnitStatus } from "../types/admission.js";

export function hasStructureErrors(
  errors: Array<{ field: string; reasonCode: string }>
): boolean {
  return errors.length > 0;
}

export function hasRejections(results: UnitEvaluationResult[]): boolean {
  return results.some((r) => r.decision === "reject");
}

export function resolveStatus(
  evaluation: UnitEvaluationResult,
  conflictAnnotations: ConflictAnnotation[]
): UnitStatus {
  if (evaluation.decision === "reject") return "rejected";
  const hasConflict = conflictAnnotations.some((c) =>
    c.unitIds.includes(evaluation.unitId)
  );
  if (hasConflict) return "approved_with_conflict";
  if (evaluation.decision === "downgrade") return "downgraded";
  return "approved";
}

export function buildAdmittedUnit<TUnit>(
  unit: TUnit,
  unitId: string,
  evaluationResult: UnitEvaluationResult,
  conflictAnnotations: ConflictAnnotation[],
  supportIds: string[],
  previousGrade?: string
): AdmittedUnit<TUnit> {
  const status = resolveStatus(evaluationResult, conflictAnnotations);
  const appliedGrades: string[] = previousGrade ? [previousGrade] : [];
  if (evaluationResult.newGrade) {
    appliedGrades.push(evaluationResult.newGrade);
  }
  const matchedConflicts = conflictAnnotations.filter((c) =>
    c.unitIds.includes(unitId)
  );
  return {
    unit,
    unitId,
    status,
    appliedGrades,
    evaluationResults: [evaluationResult],
    conflictAnnotations:
      status === "approved_with_conflict" ? matchedConflicts : undefined,
    supportIds,
  };
}

export function partitionUnits<TUnit>(admittedUnits: AdmittedUnit<TUnit>[]): {
  admitted: AdmittedUnit<TUnit>[];
  rejected: AdmittedUnit<TUnit>[];
} {
  return {
    admitted: admittedUnits.filter((u) => u.status !== "rejected"),
    rejected: admittedUnits.filter((u) => u.status === "rejected"),
  };
}
