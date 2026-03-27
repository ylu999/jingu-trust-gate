import type { Proposal } from "./proposal.js";
import type {
  StructureValidationResult,
  UnitEvaluationResult,
  ConflictAnnotation,
} from "./gate.js";
import type { SupportRef, UnitWithSupport } from "./support.js";
import type { AdmittedUnit } from "./admission.js";
import type { VerifiedContext, RenderContext } from "./renderer.js";
import type { RetryFeedback, RetryContext } from "./retry.js";

export interface HarnessPolicy<TUnit> {
  // Step 1: validate Proposal structure (proposal-level)
  validateStructure(proposal: Proposal<TUnit>): StructureValidationResult;

  // Step 2: bind support to each unit (which SupportRefs apply to this unit)
  bindSupport(unit: TUnit, supportPool: SupportRef[]): UnitWithSupport<TUnit>;

  // Step 3: evaluate each unit against its bound support
  evaluateUnit(
    unitWithSupport: UnitWithSupport<TUnit>,
    context: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult;

  // Step 4: detect cross-unit conflicts
  detectConflicts(
    units: UnitWithSupport<TUnit>[],
    supportPool: SupportRef[]
  ): ConflictAnnotation[];

  // Step 5: render admitted units → VerifiedContext for Claude API input
  render(
    admittedUnits: AdmittedUnit<TUnit>[],
    supportPool: SupportRef[],
    context: RenderContext
  ): VerifiedContext;

  // Step 6: build structured retry feedback from gate results
  buildRetryFeedback(
    unitResults: UnitEvaluationResult[],
    context: RetryContext
  ): RetryFeedback;
}
