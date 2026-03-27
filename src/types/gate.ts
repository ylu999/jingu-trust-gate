// Layer 1: Proposal-level structural validation
export type StructureValidationResult = {
  kind: "structure";
  valid: boolean;
  errors: Array<{
    field: string;
    reasonCode: string;
    message?: string;
  }>;
};

// Layer 2: Unit-level semantic evaluation
export type UnitEvaluationResult = {
  kind: "unit";
  unitId: string;
  decision: "approve" | "downgrade" | "reject";
  reasonCode: string;
  newGrade?: string; // only when decision === "downgrade"; value defined by policy
  annotations?: Record<string, unknown>;
};

// Layer 3: Cross-unit conflict detection
export type ConflictDetectionResult = {
  kind: "conflict";
  conflictAnnotations: ConflictAnnotation[];
};

export type ConflictAnnotation = {
  unitIds: string[];
  conflictCode: string; // e.g. "TEMPORAL_CONFLICT", "ATTRIBUTE_CONFLICT"
  sources: string[]; // SupportRef IDs involved
  description?: string;
};

// Unified audit log view (NOT used as control plane)
export type GateResultLog =
  | StructureValidationResult
  | UnitEvaluationResult
  | ConflictDetectionResult;
