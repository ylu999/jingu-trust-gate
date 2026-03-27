export type SupportRef = {
  id: string;        // system-internal ID — used in supportIds (audit traceability)
  sourceType: string;
  sourceId: string;  // business ID — used in evidenceRefs matching (policy's bindSupport)
  confidence?: number;
  attributes?: Record<string, unknown>;
  retrievedAt?: string; // ISO 8601
};

export type UnitWithSupport<TUnit> = {
  unit: TUnit;
  supportIds: string[];   // IDs of bound SupportRefs (for audit traceability)
  supportRefs: SupportRef[]; // full SupportRef objects (for attribute inspection in evaluateUnit)
};
