export type SupportRef = {
  id: string;
  sourceType: string;
  sourceId: string;
  confidence?: number;
  attributes?: Record<string, unknown>;
  retrievedAt?: string; // ISO 8601
};

export type UnitWithSupport<TUnit> = {
  unit: TUnit;
  supportIds: string[];   // IDs of bound SupportRefs (for audit traceability)
  supportRefs: SupportRef[]; // full SupportRef objects (for attribute inspection in evaluateUnit)
};
