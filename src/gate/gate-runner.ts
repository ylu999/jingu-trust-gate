import { randomUUID } from "node:crypto";
import type { Proposal } from "../types/proposal.js";
import type { SupportRef, UnitWithSupport } from "../types/support.js";
import type { GatePolicy } from "../types/policy.js";
import type { AdmissionResult } from "../types/admission.js";
import type { AuditWriter } from "../types/audit.js";
import {
  hasStructureErrors,
  buildAdmittedUnit,
  partitionUnits,
} from "./gate-utils.js";
import { buildAuditEntry } from "../audit/audit-entry.js";

export class GateRunner<TUnit> {
  constructor(
    private readonly policy: GatePolicy<TUnit>,
    private readonly auditWriter?: AuditWriter
  ) {}

  async run(
    proposal: Proposal<TUnit>,
    supportPool: SupportRef[]
  ): Promise<AdmissionResult<TUnit>> {
    const auditId = randomUUID();
    const proposalContext = {
      proposalId: proposal.id,
      proposalKind: proposal.kind,
    };

    // Step 1: Structure validation (proposal-level)
    const structureResult = this.policy.validateStructure(proposal);
    if (hasStructureErrors(structureResult.errors)) {
      // Structure failure = all units are structure-rejected (not silently lost)
      const structureRejected = proposal.units.map((unit, i) =>
        buildAdmittedUnit(
          unit,
          (unit as Record<string, unknown>)["id"] as string ?? `unit-${i}`,
          {
            kind: "unit",
            unitId: (unit as Record<string, unknown>)["id"] as string ?? `unit-${i}`,
            decision: "reject",
            reasonCode: "STRUCTURE_INVALID",
          },
          [],
          []
        )
      );
      const auditEntry = buildAuditEntry({
        auditId,
        proposal,
        allUnits: structureRejected,
        gateResults: [structureResult],
        unitSupportMap: {},
      });
      await this.auditWriter?.append(auditEntry);
      return {
        proposalId: proposal.id,
        admittedUnits: [],
        rejectedUnits: structureRejected,
        hasConflicts: false,
        auditId,
        retryAttempts: 1,
      };
    }

    // Step 2: Bind support + evaluate each unit
    const unitSupportMap: Record<string, string[]> = {};
    const evaluationResults = proposal.units.map((unit) => {
      const bound = this.policy.bindSupport(unit, supportPool);
      // Ensure supportRefs is populated even if policy only sets supportIds
      if (!bound.supportRefs) {
        (bound as { supportRefs: SupportRef[] }).supportRefs =
          supportPool.filter((s) => bound.supportIds.includes(s.id));
      }
      const supportIds = bound.supportIds;
      const evalResult = this.policy.evaluateUnit(bound, proposalContext);
      unitSupportMap[evalResult.unitId] = supportIds;
      return { unit, evalResult, supportIds };
    });

    // Step 3: Conflict detection (cross-unit)
    // Reconstruct UnitWithSupport[] from evaluationResults so policy can inspect bound evidence
    const unitsWithSupport: UnitWithSupport<TUnit>[] = evaluationResults.map(({ unit, supportIds }) => ({
      unit,
      supportIds,
      supportRefs: supportPool.filter((s) => supportIds.includes(s.id)),
    }));
    const conflictAnnotations = this.policy.detectConflicts(
      unitsWithSupport,
      supportPool
    );

    // Step 4: Build AdmittedUnit[] for all units
    // Units involved in a blocking conflict are force-rejected
    const blockingConflictUnitIds = new Set<string>(
      conflictAnnotations
        .filter((a) => a.severity === "blocking")
        .flatMap((a) => a.unitIds)
    );

    const allAdmittedUnits = evaluationResults.map(
      ({ unit, evalResult, supportIds }) => {
        const overriddenResult =
          blockingConflictUnitIds.has(evalResult.unitId) &&
          evalResult.decision !== "reject"
            ? {
                ...evalResult,
                decision: "reject" as const,
                reasonCode: "BLOCKING_CONFLICT",
              }
            : evalResult;
        return buildAdmittedUnit(
          unit,
          overriddenResult.unitId,
          overriddenResult,
          conflictAnnotations,
          supportIds
        );
      }
    );

    const { admitted, rejected } = partitionUnits(allAdmittedUnits);

    // Step 5: Write audit
    const allGateResults = [
      structureResult,
      ...evaluationResults.map((e) => e.evalResult),
      { kind: "conflict" as const, conflictAnnotations },
    ];
    const auditEntry = buildAuditEntry({
      auditId,
      proposal,
      allUnits: allAdmittedUnits,
      gateResults: allGateResults,
      unitSupportMap,
    });
    await this.auditWriter?.append(auditEntry);

    return {
      proposalId: proposal.id,
      admittedUnits: admitted,
      rejectedUnits: rejected,
      hasConflicts: conflictAnnotations.length > 0,
      auditId,
      retryAttempts: 1,
    };
  }
}
