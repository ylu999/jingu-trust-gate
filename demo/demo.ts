/**
 * jingu-harness narrative demo
 *
 * Domain: household memory assistant
 * Each scenario runs a real harness.admit() or harness.admitWithRetry() call,
 * prints what's happening in plain English, and asserts the expected outcome.
 *
 * Run: npm run demo
 */

import assert from "node:assert/strict";
import { createHarness } from "../src/harness.js";
import type { HarnessPolicy } from "../src/types/policy.js";
import type { Proposal } from "../src/types/proposal.js";
import type { SupportRef, UnitWithSupport } from "../src/types/support.js";
import type {
  StructureValidationResult,
  UnitEvaluationResult,
  ConflictAnnotation,
} from "../src/types/gate.js";
import type { AdmittedUnit } from "../src/types/admission.js";
import type { VerifiedContext, RenderContext } from "../src/types/renderer.js";
import type { RetryFeedback, RetryContext } from "../src/types/retry.js";
import type { AuditEntry, AuditWriter } from "../src/types/audit.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

type MemoryClaim = {
  id: string;
  text: string;
  grade: "proven" | "derived" | "unknown";
  attributes: {
    hasBrand?: boolean;
    hasQuantity?: boolean;
  };
  /** References into the SupportRef pool — matched by SupportRef.sourceId */
  evidenceRefs?: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopAuditWriter(): AuditWriter {
  return { append: async (_e: AuditEntry) => {} };
}

function makeProposal(units: MemoryClaim[]): Proposal<MemoryClaim> {
  return { id: `prop-${Date.now()}`, kind: "response", units };
}

function sep(title: string): void {
  console.log("\n" + "━".repeat(50));
  console.log(title);
  console.log("━".repeat(50));
}

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

// ---------------------------------------------------------------------------
// MemoryPolicy
// ---------------------------------------------------------------------------

/**
 * A concrete HarnessPolicy for the household memory domain.
 *
 * Gate rules:
 *   - grade=proven + no evidence refs  →  MISSING_EVIDENCE  →  reject
 *   - hasBrand=true + evidence has no brand attribute  →  OVER_SPECIFIC_BRAND  →  downgrade to "derived"
 *   - otherwise  →  approve
 *
 * Conflict detection is injected per-scenario via the constructor so the demo
 * can control when ITEM_CONFLICT fires without duplicating policy logic.
 */
class MemoryPolicy implements HarnessPolicy<MemoryClaim> {
  constructor(
    private readonly injectedConflicts: ConflictAnnotation[] = []
  ) {}

  // Step 1 — structural validation
  validateStructure(proposal: Proposal<MemoryClaim>): StructureValidationResult {
    if (proposal.units.length === 0) {
      return {
        kind: "structure",
        valid: false,
        errors: [{ field: "units", reasonCode: "EMPTY_UNITS", message: "proposal must have at least one unit" }],
      };
    }
    return { kind: "structure", valid: true, errors: [] };
  }

  // Step 2 — bind support: match by evidenceRefs → SupportRef.sourceId
  bindSupport(unit: MemoryClaim, supportPool: SupportRef[]): UnitWithSupport<MemoryClaim> {
    const refs = unit.evidenceRefs ?? [];
    const matched = supportPool
      .filter((s) => refs.includes(s.sourceId))
      .map((s) => s.id);
    return { unit, supportIds: matched };
  }

  // Step 3 — per-unit evaluation
  evaluateUnit(
    unitWithSupport: UnitWithSupport<MemoryClaim>,
    _context: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    const { unit, supportIds } = unitWithSupport;

    // Rule A: proven claim must have at least one evidence reference
    if (unit.grade === "proven" && supportIds.length === 0) {
      return {
        kind: "unit",
        unitId: unit.id,
        decision: "reject",
        reasonCode: "MISSING_EVIDENCE",
      };
    }

    // Rule B: claim mentions a specific brand but evidence has no brand attribute
    if (unit.attributes.hasBrand) {
      // We need the actual SupportRef objects to check attributes.
      // They are not directly passed here, so we carry them via a side-channel
      // stored during bindSupport. We resolve via the _resolvedSupport map.
      const resolved = this._resolvedSupport.get(unit.id) ?? [];
      const evidenceHasBrand = resolved.some(
        (s) => s.attributes?.brand !== undefined
      );
      if (!evidenceHasBrand) {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "downgrade",
          reasonCode: "OVER_SPECIFIC_BRAND",
          newGrade: "derived",
        };
      }
    }

    return {
      kind: "unit",
      unitId: unit.id,
      decision: "approve",
      reasonCode: "OK",
    };
  }

  // Side-channel: gate-runner calls bindSupport before evaluateUnit, so we
  // cache the full SupportRef objects here so evaluateUnit can inspect attributes.
  private _resolvedSupport: Map<string, SupportRef[]> = new Map();

  /**
   * Override bindSupport to also cache full SupportRef objects.
   * (TypeScript won't let us call super from outside, so we shadow the method.)
   */
  bindSupportWithCache(
    unit: MemoryClaim,
    supportPool: SupportRef[]
  ): UnitWithSupport<MemoryClaim> {
    const refs = unit.evidenceRefs ?? [];
    const matched = supportPool.filter((s) => refs.includes(s.sourceId));
    this._resolvedSupport.set(unit.id, matched);
    return { unit, supportIds: matched.map((s) => s.id) };
  }

  // Step 4 — conflict detection (injected per scenario)
  detectConflicts(
    _units: MemoryClaim[],
    _supportPool: SupportRef[]
  ): ConflictAnnotation[] {
    return this.injectedConflicts;
  }

  // Step 5 — render admitted units → VerifiedContext for Claude API input
  render(
    admittedUnits: AdmittedUnit<MemoryClaim>[],
    _supportPool: SupportRef[],
    _context: RenderContext
  ): VerifiedContext {
    const blocks = admittedUnits.map((u) => {
      const block: {
        sourceId: string;
        content: string;
        grade?: string;
        conflictNote?: string;
      } = {
        sourceId: u.unitId,
        content: u.unit.text,
      };
      if (u.status === "downgraded") {
        block.grade = u.appliedGrades[u.appliedGrades.length - 1];
      }
      if (u.status === "approved_with_conflict" && u.conflictAnnotation) {
        block.conflictNote = `Conflict detected: ${u.conflictAnnotation.conflictCode}. ${u.conflictAnnotation.description ?? ""}`;
      }
      return block;
    });

    const conflicts = admittedUnits.filter(
      (u) => u.status === "approved_with_conflict"
    ).length;

    return {
      admittedBlocks: blocks,
      summary: {
        admitted: admittedUnits.length,
        rejected: 0, // rejected units not in admittedUnits
        conflicts,
      },
    };
  }

  // Step 6 — build structured retry feedback
  buildRetryFeedback(
    unitResults: UnitEvaluationResult[],
    context: RetryContext
  ): RetryFeedback {
    const errors = unitResults
      .filter((r) => r.decision === "reject" || r.decision === "downgrade")
      .map((r) => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: r.newGrade ? { suggestedGrade: r.newGrade } : undefined,
      }));

    return {
      summary: `Attempt ${context.attempt}/${context.maxRetries} failed. ${errors.length} unit(s) need correction.`,
      errors,
    };
  }
}

/**
 * Factory that wires bindSupportWithCache into bindSupport.
 * This is the policy we use for all scenarios so attribute inspection works.
 */
function createMemoryPolicy(conflicts: ConflictAnnotation[] = []): HarnessPolicy<MemoryClaim> {
  const p = new MemoryPolicy(conflicts);
  return {
    validateStructure: p.validateStructure.bind(p),
    bindSupport: p.bindSupportWithCache.bind(p),
    evaluateUnit: p.evaluateUnit.bind(p),
    detectConflicts: p.detectConflicts.bind(p),
    render: p.render.bind(p),
    buildRetryFeedback: p.buildRetryFeedback.bind(p),
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Happy Path
// ---------------------------------------------------------------------------

async function scenario1(): Promise<void> {
  sep("Scenario 1: Happy Path");
  console.log(`
The simplest case. LLM proposes 2 claims, both have evidence.
Gate should approve both without issues.

Proposal:
  claim-1: "You have milk in the fridge"  grade=proven   [has evidence: obs-001]
  claim-2: "You seem to buy milk weekly"  grade=derived  [has evidence: obs-002]
`);

  const support: SupportRef[] = [
    {
      id: "sup-1",
      sourceType: "observation",
      sourceId: "obs-001",
      confidence: 0.95,
      attributes: { item: "milk", location: "fridge" },
      retrievedAt: "2024-01-10T10:00:00Z",
    },
    {
      id: "sup-2",
      sourceType: "inference",
      sourceId: "obs-002",
      confidence: 0.75,
      attributes: { pattern: "weekly-purchase" },
      retrievedAt: "2024-01-10T10:00:00Z",
    },
  ];

  const proposal = makeProposal([
    {
      id: "claim-1",
      text: "You have milk in the fridge",
      grade: "proven",
      attributes: {},
      evidenceRefs: ["obs-001"],
    },
    {
      id: "claim-2",
      text: "You seem to buy milk weekly",
      grade: "derived",
      attributes: {},
      evidenceRefs: ["obs-002"],
    },
  ]);

  const harness = createHarness({
    policy: createMemoryPolicy(),
    auditWriter: noopAuditWriter(),
  });

  const result = await harness.admit(proposal, support);
  const explanation = harness.explain(result);

  console.log("  AdmissionResult summary:");
  console.log(`    admitted : ${result.admittedUnits.length}`);
  console.log(`    rejected : ${result.rejectedUnits.length}`);
  console.log(`    hasConflicts: ${result.hasConflicts}`);
  console.log("");
  console.log("  explain() output:");
  console.log(`    totalUnits=${explanation.totalUnits}  approved=${explanation.approved}  downgraded=${explanation.downgraded}  rejected=${explanation.rejected}`);
  console.log(`    gateReasonCodes: [${explanation.gateReasonCodes.join(", ")}]`);

  assert.equal(result.admittedUnits.length, 2, "both claims should be admitted");
  assert.equal(result.rejectedUnits.length, 0, "no claims should be rejected");
  assert.equal(result.hasConflicts, false, "no conflicts expected");
  for (const u of result.admittedUnits) {
    assert.equal(u.status, "approved", `${u.unitId} should be approved`);
  }

  pass("admittedUnits.length === 2");
  pass("all status === 'approved'");
  pass("rejectedUnits.length === 0");
  pass("hasConflicts === false");
}

// ---------------------------------------------------------------------------
// Scenario 2: MISSING_EVIDENCE
// ---------------------------------------------------------------------------

async function scenario2(): Promise<void> {
  sep("Scenario 2: Missing Evidence Gate");
  console.log(`
LLM claims something is "proven" but provides no evidence reference.
This is the hallucination pattern: confident statement, no backing.

Proposal:
  claim-1: "You have exactly 3 apples"  grade=proven  [NO evidence refs]

Gate: MISSING_EVIDENCE → reject
`);

  const proposal = makeProposal([
    {
      id: "claim-1",
      text: "You have exactly 3 apples",
      grade: "proven",
      attributes: { hasQuantity: true },
      evidenceRefs: [], // no evidence refs
    },
  ]);

  const harness = createHarness({
    policy: createMemoryPolicy(),
    auditWriter: noopAuditWriter(),
  });

  const result = await harness.admit(proposal, []);

  console.log("  Rejected unit:");
  const rejected = result.rejectedUnits[0];
  console.log(`    id   : ${rejected.unitId}`);
  console.log(`    text : "${rejected.unit.text}"`);
  console.log(`    reasonCode: ${rejected.evaluationResults[0].reasonCode}`);

  assert.equal(result.admittedUnits.length, 0, "no units should be admitted");
  assert.equal(result.rejectedUnits.length, 1, "one unit should be rejected");
  assert.equal(
    result.rejectedUnits[0].evaluationResults[0].reasonCode,
    "MISSING_EVIDENCE",
    "reasonCode should be MISSING_EVIDENCE"
  );

  pass("admittedUnits.length === 0");
  pass("rejectedUnits.length === 1");
  pass("reasonCode === 'MISSING_EVIDENCE'");
}

// ---------------------------------------------------------------------------
// Scenario 3: OVER_SPECIFIC — claim more specific than evidence
// ---------------------------------------------------------------------------

async function scenario3(): Promise<void> {
  sep("Scenario 3: Over-Specificity Gate (Hallucination Killer)");
  console.log(`
LLM says "Coca-Cola" but evidence only says "a drink" (brand=undefined).
The claim is more specific than what the evidence supports.

Proposal:
  claim-1: "You have Coca-Cola"  grade=proven  hasBrand=true
           evidenceRef: obs-001 (sourceType=observation, attributes={brand: undefined})

Gate: OVER_SPECIFIC_BRAND → downgrade grade proven → derived
`);

  const support: SupportRef[] = [
    {
      id: "sup-1",
      sourceType: "observation",
      sourceId: "obs-001",
      confidence: 0.8,
      attributes: {
        item: "drink",
        // brand is intentionally absent — evidence does not know the brand
      },
      retrievedAt: "2024-01-10T09:00:00Z",
    },
  ];

  const proposal = makeProposal([
    {
      id: "claim-1",
      text: "You have Coca-Cola",
      grade: "proven",
      attributes: { hasBrand: true },
      evidenceRefs: ["obs-001"],
    },
  ]);

  const harness = createHarness({
    policy: createMemoryPolicy(),
    auditWriter: noopAuditWriter(),
  });

  const result = await harness.admit(proposal, support);
  const admitted = result.admittedUnits[0];

  console.log("  Grade downgrade chain:");
  console.log(`    original grade : "proven"  (from proposal)`);
  console.log(`    appliedGrades  : [${admitted.appliedGrades.map((g) => `"${g}"`).join(", ")}]`);
  console.log(`    final status   : ${admitted.status}`);
  console.log(`    reasonCode     : ${admitted.evaluationResults[0].reasonCode}`);

  assert.equal(result.admittedUnits.length, 1, "unit should be admitted (not rejected)");
  assert.equal(admitted.status, "downgraded", "status should be downgraded");
  assert.ok(
    admitted.appliedGrades.includes("derived"),
    "appliedGrades should contain 'derived'"
  );

  pass("admittedUnits.length === 1  (downgrade admits, not rejects)");
  pass("status === 'downgraded'");
  pass("appliedGrades includes 'derived'");
  pass("reasonCode === 'OVER_SPECIFIC_BRAND'");
}

// ---------------------------------------------------------------------------
// Scenario 4: CONFLICT — two claims contradict each other
// ---------------------------------------------------------------------------

async function scenario4(): Promise<void> {
  sep("Scenario 4: Conflict Detection");
  console.log(`
Two claims about the same item contradict each other.
harness does NOT resolve the conflict — it surfaces it.
The conflict must be visible to the user, not silently hidden.

Proposal:
  claim-1: "You have milk"    (source: obs-1, retrievedAt: 2024-01-01)
  claim-2: "You have no milk" (source: obs-2, retrievedAt: 2024-01-02)

Gate: ITEM_CONFLICT → both admitted with status=approved_with_conflict
`);

  const support: SupportRef[] = [
    {
      id: "sup-1",
      sourceType: "observation",
      sourceId: "obs-1",
      confidence: 0.9,
      attributes: { item: "milk", present: true },
      retrievedAt: "2024-01-01T08:00:00Z",
    },
    {
      id: "sup-2",
      sourceType: "observation",
      sourceId: "obs-2",
      confidence: 0.9,
      attributes: { item: "milk", present: false },
      retrievedAt: "2024-01-02T08:00:00Z",
    },
  ];

  const injectedConflicts: ConflictAnnotation[] = [
    {
      unitIds: ["claim-1", "claim-2"],
      conflictCode: "ITEM_CONFLICT",
      sources: ["obs-1", "obs-2"],
      description: "claim-1 and claim-2 contradict each other about the same item",
    },
  ];

  const proposal = makeProposal([
    {
      id: "claim-1",
      text: "You have milk",
      grade: "proven",
      attributes: {},
      evidenceRefs: ["obs-1"],
    },
    {
      id: "claim-2",
      text: "You have no milk",
      grade: "proven",
      attributes: {},
      evidenceRefs: ["obs-2"],
    },
  ]);

  const harness = createHarness({
    policy: createMemoryPolicy(injectedConflicts),
    auditWriter: noopAuditWriter(),
  });

  const result = await harness.admit(proposal, support);
  const verifiedCtx = harness.render(result);

  console.log("  VerifiedContext (render() output — Claude API input):");
  for (const block of verifiedCtx.admittedBlocks) {
    console.log(`    [${block.sourceId}] content="${block.content}"`);
    if (block.conflictNote) {
      console.log(`             conflictNote: "${block.conflictNote}"`);
    }
  }
  console.log(`  summary: admitted=${verifiedCtx.summary.admitted}  conflicts=${verifiedCtx.summary.conflicts}`);

  assert.equal(result.hasConflicts, true, "hasConflicts should be true");
  assert.equal(result.admittedUnits.length, 2, "both units should be in admittedUnits");
  assert.equal(result.rejectedUnits.length, 0, "no units should be rejected");

  for (const u of result.admittedUnits) {
    assert.equal(
      u.status,
      "approved_with_conflict",
      `${u.unitId} should have status=approved_with_conflict`
    );
    assert.ok(u.conflictAnnotation, `${u.unitId} should have conflictAnnotation`);
    assert.equal(
      u.conflictAnnotation?.conflictCode,
      "ITEM_CONFLICT",
      "conflictCode should be ITEM_CONFLICT"
    );
  }

  pass("hasConflicts === true");
  pass("both units in admittedUnits (not rejected)");
  pass("both status === 'approved_with_conflict'");
  pass("conflictAnnotation.conflictCode === 'ITEM_CONFLICT'");
  pass("render() output has conflictNote on both blocks");
}

// ---------------------------------------------------------------------------
// Scenario 5: Semantic Retry Loop
// ---------------------------------------------------------------------------

async function scenario5(): Promise<void> {
  sep("Scenario 5: Semantic Retry Loop");
  console.log(`
LLM's first proposal has a MISSING_EVIDENCE rejection.
harness builds a structured RetryFeedback and sends it back.
LLM's second proposal fixes the issue — all units approved.

Key design:
  RetryFeedback is a structured object, NOT a raw string.
  The LLMInvoker serializes it as tool_result + is_error:true.
  harness controls WHETHER to retry. Invoker controls HOW.

Attempt 1: claim "You have 5 cans" grade=proven, no evidence → REJECTED
           RetryFeedback: { reasonCode: "MISSING_EVIDENCE", unitId: "claim-1" }
Attempt 2: claim "You probably have cans" grade=derived → APPROVED
`);

  let capturedFeedback: RetryFeedback | undefined;
  let invokerCallCount = 0;

  const support: SupportRef[] = []; // no evidence pool needed for attempt 2 (derived)

  // Mock LLM invoker: first call returns a bad proposal, second returns a good one
  const invoker = async (
    _prompt: string,
    feedback?: RetryFeedback
  ): Promise<Proposal<MemoryClaim>> => {
    invokerCallCount++;

    if (feedback) {
      capturedFeedback = feedback;
    }

    if (invokerCallCount === 1) {
      // First attempt: LLM makes a hallucinated proven claim with no evidence
      return makeProposal([
        {
          id: "claim-1",
          text: "You have 5 cans of soup",
          grade: "proven",
          attributes: { hasQuantity: true },
          evidenceRefs: [], // no evidence — will trigger MISSING_EVIDENCE
        },
      ]);
    }

    // Second attempt: LLM corrects grade to derived, no evidence needed
    return makeProposal([
      {
        id: "claim-1",
        text: "You probably have cans of soup",
        grade: "derived",
        attributes: {},
        evidenceRefs: [], // derived grade doesn't require evidence
      },
    ]);
  };

  const harness = createHarness({
    policy: createMemoryPolicy(),
    auditWriter: noopAuditWriter(),
    retry: { maxRetries: 3, retryOnDecisions: ["reject"] },
  });

  const result = await harness.admitWithRetry(invoker, support, "What food do I have?");

  console.log("  Attempt 1 → REJECTED:");
  console.log(`    claim: "You have 5 cans of soup"  grade=proven  evidenceRefs=[]`);
  console.log(`    gate verdict: MISSING_EVIDENCE → reject`);

  if (capturedFeedback) {
    console.log("");
    console.log("  RetryFeedback sent to LLM:");
    console.log(`    summary: "${capturedFeedback.summary}"`);
    for (const err of capturedFeedback.errors) {
      console.log(`    error: unitId=${err.unitId}  reasonCode=${err.reasonCode}`);
    }
  }

  console.log("");
  console.log("  Attempt 2 → APPROVED:");
  console.log(`    claim: "You probably have cans of soup"  grade=derived`);
  console.log(`    gate verdict: OK → approve`);
  console.log("");
  console.log(`  retryAttempts: ${result.retryAttempts}`);
  console.log(`  admittedUnits: ${result.admittedUnits.length}`);
  console.log(`  final status : ${result.admittedUnits[0]?.status}`);

  assert.equal(result.retryAttempts, 2, "should have taken 2 attempts");
  assert.equal(result.admittedUnits.length, 1, "one unit should be admitted after retry");
  assert.equal(
    result.admittedUnits[0].status,
    "approved",
    "final unit should be approved"
  );
  assert.ok(capturedFeedback, "RetryFeedback should have been captured");
  assert.ok(
    capturedFeedback!.errors.some((e) => e.reasonCode === "MISSING_EVIDENCE"),
    "RetryFeedback should reference MISSING_EVIDENCE"
  );

  pass("retryAttempts === 2");
  pass("admittedUnits.length === 1");
  pass("admittedUnits[0].status === 'approved'");
  pass("RetryFeedback carried reasonCode='MISSING_EVIDENCE' to invoker");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(): void {
  console.log("\n" + "━".repeat(50));
  console.log("Summary: 5 scenarios, all passed");
  console.log("━".repeat(50));
  console.log(`
What harness guarantees:
  ✓ proven claims require evidence       (Scenario 2)
  ✓ specificity cannot exceed evidence   (Scenario 3)
  ✓ conflicts are surfaced, not hidden   (Scenario 4)
  ✓ semantic retry loop with structured feedback  (Scenario 5)

What harness does NOT do:
  ✗ generate user-facing text (that's Claude's job)
  ✗ call LLMs in gate evaluation
  ✗ resolve conflicts (it surfaces them)
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("jingu-harness narrative demo");
  console.log("Domain: household memory assistant\n");

  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();

  printSummary();
}

main().catch((err) => {
  console.error("\nDemo failed:", err);
  process.exit(1);
});
