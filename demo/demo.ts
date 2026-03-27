/**
 * jingu-trust-gate narrative demo
 *
 * This demo IS the documentation. Read the terminal output and you will
 * understand the entire system — no external docs needed.
 *
 * Domain: household memory assistant (LLM that recalls what is in your home)
 *
 * Run: npm run demo
 */

import assert from "node:assert/strict";
import { createTrustGate } from "../src/trust-gate.js";
import { ClaudeContextAdapter, OpenAIContextAdapter, GeminiContextAdapter } from "../examples/integration/adapter-examples.js";
import { approve, reject, downgrade } from "../src/helpers/index.js";
import type { GatePolicy } from "../src/types/policy.js";
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
  console.log("\n" + "═".repeat(70));
  console.log(`  ${title}`);
  console.log("═".repeat(70));
}

function subsep(title: string): void {
  console.log("\n  " + "─".repeat(60));
  console.log(`  ${title}`);
  console.log("  " + "─".repeat(60));
}

function pass(msg: string): void {
  console.log(`  [PASS] ${msg}`);
}

function label(key: string, value: unknown): void {
  console.log(`    ${key.padEnd(22)}: ${JSON.stringify(value)}`);
}

function explain(text: string): void {
  const width = 66;
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      lines.push(current.trim());
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current.trim()) lines.push(current.trim());
  for (const line of lines) {
    console.log(`  | ${line}`);
  }
}

// ---------------------------------------------------------------------------
// MemoryPolicy
// ---------------------------------------------------------------------------

/**
 * MemoryPolicy is the INJECTED business logic for this demo.
 *
 * jingu-trust-gate core carries ZERO business semantics.
 * The policy decides what "valid" means for this domain.
 *
 * Gate rules implemented here:
 *   - grade=proven + no evidence refs  →  MISSING_EVIDENCE  →  reject
 *   - hasBrand=true + evidence has no brand attr  →  OVER_SPECIFIC_BRAND  →  downgrade to "derived"
 *   - otherwise  →  approve
 *
 * Conflict detection is injected per-scenario so the demo can control
 * when ITEM_CONFLICT fires without duplicating policy logic.
 */
class MemoryPolicy implements GatePolicy<MemoryClaim> {
  constructor(
    private readonly injectedConflicts: ConflictAnnotation[] = []
  ) {}

  // Gate Step 1: structural validation (is the proposal well-formed?)
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

  // Gate Step 2: bind each unit to its supporting evidence
  bindSupport(unit: MemoryClaim, supportPool: SupportRef[]): UnitWithSupport<MemoryClaim> {
    const refs = unit.evidenceRefs ?? [];
    const matched = supportPool.filter((s) => refs.includes(s.sourceId));
    return { unit, supportIds: matched.map((s) => s.id), supportRefs: matched };
  }

  // Gate Step 3: per-unit semantic evaluation
  evaluateUnit(
    unitWithSupport: UnitWithSupport<MemoryClaim>,
    _context: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    const { unit, supportIds, supportRefs } = unitWithSupport;

    // Rule A: proven claim must have at least one evidence reference
    if (unit.grade === "proven" && supportIds.length === 0) {
      return reject(unit.id, "MISSING_EVIDENCE");
    }

    // Rule B: claim asserts a specific brand but evidence has no brand attribute
    // Uses supportRefs directly — no side-channel needed
    if (unit.attributes.hasBrand) {
      const evidenceHasBrand = supportRefs.some(
        (s) => s.attributes?.brand !== undefined
      );
      if (!evidenceHasBrand) {
        return downgrade(unit.id, "OVER_SPECIFIC_BRAND", "derived");
      }
    }

    return approve(unit.id);
  }

  // Gate Step 4: cross-unit conflict detection
  detectConflicts(
    _units: UnitWithSupport<MemoryClaim>[],
    _supportPool: SupportRef[]
  ): ConflictAnnotation[] {
    return this.injectedConflicts;
  }

  // Gate Step 5: render admitted units → VerifiedContext (input to LLM API)
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
        unsupportedAttributes?: string[];
      } = {
        sourceId: u.unitId,
        content: u.unit.text,
      };
      if (u.status === "downgraded") {
        block.grade = u.appliedGrades[u.appliedGrades.length - 1];
        // Mark the attributes that caused the downgrade
        if (u.evaluationResults.some((r) => r.reasonCode === "OVER_SPECIFIC_BRAND")) {
          block.unsupportedAttributes = ["brand"];
        }
      }
      if (u.status === "approved_with_conflict" && u.conflictAnnotations && u.conflictAnnotations.length > 0) {
        block.conflictNote = u.conflictAnnotations.map((c) => `${c.conflictCode}: ${c.description ?? ""}`).join("; ");
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
        rejected: 0,
        conflicts,
      },
    };
  }

  // Gate Step 6: build structured retry feedback for LLMInvoker
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

function createMemoryPolicy(conflicts: ConflictAnnotation[] = []): GatePolicy<MemoryClaim> {
  const p = new MemoryPolicy(conflicts);
  return {
    validateStructure: p.validateStructure.bind(p),
    bindSupport: p.bindSupport.bind(p),
    evaluateUnit: p.evaluateUnit.bind(p),
    detectConflicts: p.detectConflicts.bind(p),
    render: p.render.bind(p),
    buildRetryFeedback: p.buildRetryFeedback.bind(p),
  };
}

// ===========================================================================
// OPENING: Three Iron Laws
// ===========================================================================

function printIronLaws(): void {
  sep("WHAT IS JINGU-TRUST-GATE?");
  console.log();
  explain("jingu-trust-gate = deterministic admission control for LLM output.");
  console.log();
  explain("It treats LLM output as untrusted input — the same way a web server treats user input.");
  explain("LLM proposes. jingu-trust-gate decides what can be trusted.");
  console.log();
  console.log("  THREE IRON LAWS:");
  console.log();
  console.log("  Law 1 — Gate Engine: zero LLM calls");
  explain("All gate evaluation is pure code. No AI judges AI. This guarantees determinism and auditability.");
  console.log();
  console.log("  Law 2 — Policy is injected");
  explain("jingu-trust-gate core carries no business semantics. The caller injects a GatePolicy that defines what 'valid' means for their domain.");
  console.log();
  console.log("  Law 3 — Every admission decision is written to audit log");
  explain("Every admit() call writes an AuditEntry. The system is accountable by design, not by convention.");
  console.log();
  console.log("  THE PIPELINE:");
  console.log();
  console.log("    LLM output");
  console.log("       |");
  console.log("       v");
  console.log("    Proposal<TUnit>             ← typed, schema-validated by LLM API");
  console.log("       |");
  console.log("       v");
  console.log("    gate.admit(proposal, support)");
  console.log("       |  Gate Step 1: validateStructure()  — structural check");
  console.log("       |  Gate Step 2: bindSupport()        — match units to evidence");
  console.log("       |  Gate Step 3: evaluateUnit()       — semantic evaluation");
  console.log("       |  Gate Step 4: detectConflicts()    — cross-unit truth check");
  console.log("       |  (all pure code, zero LLM)");
  console.log("       v");
  console.log("    AdmissionResult             ← who passed, who failed, conflicts");
  console.log("       |");
  console.log("       v");
  console.log("    gate.render(result)      ← Gate Step 5: policy renders admitted units");
  console.log("       |");
  console.log("       v");
  console.log("    VerifiedContext             ← semantic structure, NOT user text");
  console.log("       |");
  console.log("       v");
  console.log("    Adapter.adapt(verifiedCtx)  ← wire format for target LLM API");
  console.log("       |");
  console.log("       v");
  console.log("    Claude / OpenAI / Gemini API call");
  console.log();
  explain("IMPORTANT: jingu-trust-gate does not write 'You have milk in the fridge' for users.");
  explain("It produces search_result blocks / tool messages / content parts that the LLM uses to generate the final response. This is the correct separation of concerns.");
  console.log();
  console.log("  WHEN TO USE jingu-trust-gate:");
  console.log();
  explain("USE when: you have a retrieval system (RAG, vector DB, knowledge base) and LLM output must be grounded in it. Use when you need to prevent hallucinated certainty. Use when you run multi-LLM pipelines. Use when you need audit trails.");
  console.log();
  explain("DO NOT USE when: your task is purely creative (writing, brainstorming) with no support pool. Do not use when you need sub-100ms latency. Do not use if you expect jingu-trust-gate to rewrite or fix LLM output — it labels problems, it does not solve them.");
}

// ===========================================================================
// Scenario 1: Happy Path
// ===========================================================================

async function scenario1(): Promise<void> {
  sep("Scenario 1: Happy Path — Zero Friction");
  console.log();
  explain("The simplest case. LLM proposes 2 claims, both with evidence. The gate approves both without friction. This is the baseline: when LLM does its job correctly, jingu-trust-gate gets out of the way.");
  console.log();

  subsep("INPUT — What the LLM proposed");
  console.log();
  console.log("  Proposal:");
  console.log('    claim-1: "You have milk in the fridge"  grade=proven   evidenceRefs=["obs-001"]');
  console.log('    claim-2: "You seem to buy milk weekly"  grade=derived  evidenceRefs=["obs-002"]');
  console.log();
  console.log("  Support pool:");
  console.log('    obs-001: sourceType=observation  confidence=0.95  attributes={item:"milk", location:"fridge"}');
  console.log('    obs-002: sourceType=inference     confidence=0.75  attributes={pattern:"weekly-purchase"}');

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

  const gate = createTrustGate({
    policy: createMemoryPolicy(),
    auditWriter: noopAuditWriter(),
  });

  subsep("GATE EXECUTION — gate.admit()");
  console.log();
  console.log("  Step 1 — validateStructure(): 2 units present  → valid");
  console.log("  Step 2 — bindSupport():");
  console.log("            claim-1 evidenceRefs=[obs-001]  matched sup-1");
  console.log("            claim-2 evidenceRefs=[obs-002]  matched sup-2");
  console.log("  Step 3 — evaluateUnit():");
  console.log('            claim-1: grade=proven, supportIds=[sup-1]  → approve (OK)');
  console.log('            claim-2: grade=derived, supportIds=[sup-2]  → approve (OK)');
  console.log("  Step 4 — detectConflicts(): no conflicts detected");

  const result = await gate.admit(proposal, support);
  const explanation = gate.explain(result);

  subsep("OUTPUT — AdmissionResult");
  console.log();
  label("admittedUnits.length", result.admittedUnits.length);
  label("rejectedUnits.length", result.rejectedUnits.length);
  label("hasConflicts", result.hasConflicts);
  for (const u of result.admittedUnits) {
    label(`  ${u.unitId}.status`, u.status);
    label(`  ${u.unitId}.appliedGrades`, u.appliedGrades);
  }
  console.log();
  console.log("  explain() summary:");
  label("  totalUnits", explanation.totalUnits);
  label("  approved", explanation.approved);
  label("  downgraded", explanation.downgraded);
  label("  rejected", explanation.rejected);
  label("  gateReasonCodes", explanation.gateReasonCodes);

  subsep("RENDER — gate.render() → VerifiedContext");
  console.log();
  const verifiedCtx = gate.render(result);
  for (const block of verifiedCtx.admittedBlocks) {
    console.log(`    block[${block.sourceId}]:`);
    label("      content", block.content);
    if (block.grade) label("      grade", block.grade);
    if (block.conflictNote) label("      conflictNote", block.conflictNote);
  }
  console.log();
  explain("VerifiedContext is the input to the LLM API adapter — not user text. The adapter converts it to the wire format the target LLM expects.");

  assert.equal(result.admittedUnits.length, 2);
  assert.equal(result.rejectedUnits.length, 0);
  assert.equal(result.hasConflicts, false);
  for (const u of result.admittedUnits) {
    assert.equal(u.status, "approved");
  }
  assert.equal(verifiedCtx.admittedBlocks.length, 2);

  console.log();
  pass("admittedUnits.length === 2");
  pass("all status === 'approved'");
  pass("rejectedUnits.length === 0");
  pass("hasConflicts === false");
  pass("VerifiedContext has 2 blocks");
}

// ===========================================================================
// Scenario 2: Missing Evidence (Anti-Pattern caught)
// ===========================================================================

async function scenario2(): Promise<void> {
  sep("Scenario 2: Missing Evidence — Hallucination Pattern Caught");
  console.log();
  explain("ANTI-PATTERN: LLM asserts grade=proven but provides no evidence reference. This is the classic hallucination pattern: confident statement, no backing.");
  console.log();
  explain("The gate catches this deterministically. No LLM re-evaluation. Pure code.");

  subsep("INPUT — What the LLM proposed");
  console.log();
  console.log("  Proposal:");
  console.log('    claim-1: "You have exactly 3 apples"  grade=proven  evidenceRefs=[]');
  console.log();
  console.log("  Notice: grade=proven but evidenceRefs is empty.");
  console.log("  The LLM stated a precise quantity with full confidence and zero backing.");

  const proposal = makeProposal([
    {
      id: "claim-1",
      text: "You have exactly 3 apples",
      grade: "proven",
      attributes: { hasQuantity: true },
      evidenceRefs: [],
    },
  ]);

  const gate = createTrustGate({
    policy: createMemoryPolicy(),
    auditWriter: noopAuditWriter(),
  });

  subsep("GATE EXECUTION — gate.admit()");
  console.log();
  console.log("  Step 1 — validateStructure(): 1 unit present  → valid");
  console.log("  Step 2 — bindSupport(): evidenceRefs=[]  → supportIds=[]  (nothing matched)");
  console.log("  Step 3 — evaluateUnit():");
  console.log("            grade=proven, supportIds=[]");
  console.log("            Rule A fires: proven claim requires at least one evidence reference");
  console.log("            → decision: reject  reasonCode: MISSING_EVIDENCE");
  console.log("  Step 4 — detectConflicts(): no injected conflicts → returns []");

  const result = await gate.admit(proposal, []);

  subsep("OUTPUT — AdmissionResult");
  console.log();
  const rejected = result.rejectedUnits[0];
  label("admittedUnits.length", result.admittedUnits.length);
  label("rejectedUnits.length", result.rejectedUnits.length);
  console.log();
  console.log("  Rejected unit details:");
  label("    unitId", rejected.unitId);
  label("    unit.text", rejected.unit.text);
  label("    unit.grade", rejected.unit.grade);
  label("    reasonCode", rejected.evaluationResults[0].reasonCode);
  label("    decision", rejected.evaluationResults[0].decision);
  console.log();
  explain("The claim is not admitted. It will not reach the LLM context. The LLM will not generate a response based on hallucinated certainty.");
  console.log();
  explain("WHY THIS MATTERS: If this claim were passed through, the LLM would tell the user 'You have exactly 3 apples' with high confidence. The user would act on false information. jingu-trust-gate prevents this at the boundary.");
  console.log();
  explain("LIMITATION: jingu-trust-gate cannot tell why supportIds is empty. 'LLM cited wrong evidence refs' and 'the evidence simply does not exist in your system' both look identical — MISSING_EVIDENCE. If your support pool has no observations about apples, retry will not fix this. Build your retrieval system first, then use jingu-trust-gate to enforce that claims stay within what was retrieved.");

  assert.equal(result.admittedUnits.length, 0);
  assert.equal(result.rejectedUnits.length, 1);
  assert.equal(result.rejectedUnits[0].evaluationResults[0].reasonCode, "MISSING_EVIDENCE");
  assert.equal(result.rejectedUnits[0].evaluationResults[0].decision, "reject");

  console.log();
  pass("admittedUnits.length === 0  (nothing passed)");
  pass("rejectedUnits.length === 1");
  pass("reasonCode === 'MISSING_EVIDENCE'");
  pass("decision === 'reject'");
}

// ===========================================================================
// Scenario 3: Over-Specificity (Precision Degraded, Not Rejected)
// ===========================================================================

async function scenario3(): Promise<void> {
  sep("Scenario 3: Over-Specificity — Precision Calibrated to Evidence");
  console.log();
  explain("ANTI-PATTERN: LLM says 'Coca-Cola' but the evidence only says 'a drink' (no brand attribute). The claim is more specific than what the evidence supports.");
  console.log();
  explain("jingu-trust-gate response: downgrade grade from proven to derived, mark unsupportedAttributes=[\"brand\"]. The claim IS admitted — but with reduced confidence and a caveat.");
  console.log();
  explain("IMPORTANT: jingu-trust-gate does NOT rewrite 'Coca-Cola' to 'drink'. It is not an editor. It marks the precision boundary and lets the downstream LLM decide how to communicate it.");

  subsep("INPUT — What the LLM proposed");
  console.log();
  console.log("  Proposal:");
  console.log('    claim-1: "You have Coca-Cola"  grade=proven  hasBrand=true  evidenceRefs=["obs-001"]');
  console.log();
  console.log("  Support pool:");
  console.log('    obs-001: sourceType=observation  attributes={item:"drink"}  (no brand field)');
  console.log();
  console.log('  The evidence knows there is "a drink" but does NOT know the brand.');

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

  const gate = createTrustGate({
    policy: createMemoryPolicy(),
    auditWriter: noopAuditWriter(),
  });

  subsep("GATE EXECUTION — gate.admit()");
  console.log();
  console.log("  Step 1 — validateStructure(): 1 unit  → valid");
  console.log("  Step 2 — bindSupport(): evidenceRefs=[obs-001]  → matched sup-1");
  console.log("  Step 3 — evaluateUnit():");
  console.log("            grade=proven, supportIds=[sup-1]  → passes Rule A (has evidence)");
  console.log("            hasBrand=true → inspect evidence for brand attribute");
  console.log("            sup-1.attributes.brand === undefined");
  console.log("            Rule B fires: claim asserts brand but evidence has none");
  console.log("            → decision: downgrade  reasonCode: OVER_SPECIFIC_BRAND  newGrade: 'derived'");

  const result = await gate.admit(proposal, support);
  const admitted = result.admittedUnits[0];

  subsep("OUTPUT — AdmissionResult");
  console.log();
  label("admittedUnits.length", result.admittedUnits.length);
  label("rejectedUnits.length", result.rejectedUnits.length);
  console.log();
  console.log("  Admitted unit (downgraded):");
  label("    unitId", admitted.unitId);
  label("    status", admitted.status);
  label("    appliedGrades", admitted.appliedGrades);
  label("    reasonCode", admitted.evaluationResults[0].reasonCode);

  const verifiedCtx = gate.render(result);
  const block = verifiedCtx.admittedBlocks[0];

  console.log();
  console.log("  VerifiedContext block (render output):");
  label("    sourceId", block.sourceId);
  label("    content", block.content);
  label("    grade", block.grade);
  label("    unsupportedAttributes", block.unsupportedAttributes);
  console.log();
  explain("The downstream LLM receives this block. It sees 'Coca-Cola' as the content, but grade=derived and unsupportedAttributes=[\"brand\"] as caveats. The LLM can decide to say 'there appears to be a soft drink' rather than asserting the brand.");
  console.log();
  explain("This is precision calibration: jingu-trust-gate tells the LLM exactly where its confidence boundary is.");

  assert.equal(result.admittedUnits.length, 1);
  assert.equal(admitted.status, "downgraded");
  assert.ok(admitted.appliedGrades.includes("derived"));
  assert.equal(admitted.evaluationResults[0].reasonCode, "OVER_SPECIFIC_BRAND");
  assert.deepEqual(block.unsupportedAttributes, ["brand"]);
  assert.equal(block.grade, "derived");

  console.log();
  pass("unit admitted (downgrade ≠ reject)");
  pass("status === 'downgraded'");
  pass("appliedGrades includes 'derived'");
  pass("reasonCode === 'OVER_SPECIFIC_BRAND'");
  pass("VerifiedContext block.unsupportedAttributes === ['brand']");
  pass("VerifiedContext block.grade === 'derived'");
}

// ===========================================================================
// Scenario 4: Conflict Detection (Truth Surfaced, Not Hidden)
// ===========================================================================

async function scenario4(): Promise<void> {
  sep("Scenario 4: Conflict Detection — Truth Surfaced, Not Hidden");
  console.log();
  explain("Two contradictory claims: 'You have milk' (obs-1, Jan 1) and 'You have no milk' (obs-2, Jan 2). Both have evidence. Both pass individual evaluation.");
  console.log();
  explain("ANTI-PATTERN jingu-trust-gate prevents: silently picking one claim as 'winner'. That would hide information from the LLM and produce incorrect responses.");
  console.log();
  explain("jingu-trust-gate response: BOTH claims are admitted with status=approved_with_conflict. The conflict is annotated. The downstream LLM receives both facts and can surface the contradiction to the user.");

  subsep("INPUT — What the LLM proposed");
  console.log();
  console.log("  Proposal:");
  console.log('    claim-1: "You have milk"     grade=proven  evidenceRefs=["obs-1"]');
  console.log('    claim-2: "You have no milk"  grade=proven  evidenceRefs=["obs-2"]');
  console.log();
  console.log("  Support pool:");
  console.log('    obs-1: 2024-01-01  attributes={item:"milk", present:true}');
  console.log('    obs-2: 2024-01-02  attributes={item:"milk", present:false}');
  console.log();
  console.log("  Injected conflict: ITEM_CONFLICT  severity=informational");

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
      severity: "informational",
      description: "claim-1 and claim-2 contradict each other: obs-1 says milk present=true, obs-2 says present=false",
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

  const gate = createTrustGate({
    policy: createMemoryPolicy(injectedConflicts),
    auditWriter: noopAuditWriter(),
  });

  subsep("GATE EXECUTION — gate.admit()");
  console.log();
  console.log("  Step 1 — validateStructure(): 2 units  → valid");
  console.log("  Step 2 — bindSupport():");
  console.log("            claim-1 → matched sup-1");
  console.log("            claim-2 → matched sup-2");
  console.log("  Step 3 — evaluateUnit():");
  console.log("            claim-1: grade=proven, has support  → approve (OK)");
  console.log("            claim-2: grade=proven, has support  → approve (OK)");
  console.log("  Step 4 — detectConflicts():");
  console.log("            ITEM_CONFLICT detected: claim-1 ↔ claim-2");
  console.log("            severity=informational (both kept, annotated)");
  console.log("            if severity=blocking → both would be rejected");

  const result = await gate.admit(proposal, support);

  subsep("OUTPUT — AdmissionResult");
  console.log();
  label("admittedUnits.length", result.admittedUnits.length);
  label("rejectedUnits.length", result.rejectedUnits.length);
  label("hasConflicts", result.hasConflicts);
  console.log();
  for (const u of result.admittedUnits) {
    console.log(`  Unit: ${u.unitId}`);
    label("    status", u.status);
    label("    conflictAnnotations[0].conflictCode", u.conflictAnnotations?.[0]?.conflictCode);
    label("    conflictAnnotations[0].severity", u.conflictAnnotations?.[0]?.severity);
  }

  subsep("RENDER — VerifiedContext with conflict notes");
  console.log();
  const verifiedCtx = gate.render(result);
  for (const block of verifiedCtx.admittedBlocks) {
    console.log(`  Block: ${block.sourceId}`);
    label("    content", block.content);
    label("    conflictNote", block.conflictNote);
  }
  label("  summary.conflicts", verifiedCtx.summary.conflicts);
  console.log();
  explain("The downstream LLM receives BOTH claims, each with a conflictNote. It can say: 'My records are inconsistent — obs-1 from Jan 1 shows milk was present, but obs-2 from Jan 2 says it was not. Please check your fridge.' This is truthful.");
  console.log();
  explain("severity='informational' means: annotate and pass through. severity='blocking' would mean: reject both, do not surface either until conflict is resolved.");

  assert.equal(result.hasConflicts, true);
  assert.equal(result.admittedUnits.length, 2);
  assert.equal(result.rejectedUnits.length, 0);
  for (const u of result.admittedUnits) {
    assert.equal(u.status, "approved_with_conflict");
    assert.ok(u.conflictAnnotations && u.conflictAnnotations.length > 0);
    assert.equal(u.conflictAnnotations?.[0]?.conflictCode, "ITEM_CONFLICT");
    assert.equal(u.conflictAnnotations?.[0]?.severity, "informational");
  }
  assert.ok(verifiedCtx.admittedBlocks.every((b) => b.conflictNote !== undefined));

  console.log();
  pass("hasConflicts === true");
  pass("both units in admittedUnits (not rejected)");
  pass("both status === 'approved_with_conflict'");
  pass("conflictAnnotations[0].conflictCode === 'ITEM_CONFLICT'");
  pass("conflictAnnotations[0].severity === 'informational'");
  pass("VerifiedContext: both blocks have conflictNote");

  // ── Part B: blocking conflict ─────────────────────────────────────────────
  // severity=blocking is a different outcome: both claims are force-rejected.
  // admittedBlocks is empty. The downstream LLM receives nothing — it can only
  // tell the user the data is inconsistent.

  subsep("Part B — severity=blocking: both claims force-rejected");
  console.log();
  explain("Same two claims. Same evidence. But now the conflict is severity=blocking — the claims are mutually exclusive in a way that makes it unsafe to surface either one. Example: two inventory records for the same product disagree on whether it is in stock.");
  console.log();
  console.log("  Injected conflict: ITEM_CONFLICT  severity=blocking");

  const blockingConflicts: ConflictAnnotation[] = [
    {
      unitIds: ["claim-1", "claim-2"],
      conflictCode: "ITEM_CONFLICT",
      sources: ["obs-1", "obs-2"],
      severity: "blocking",
      description: "claim-1 and claim-2 are mutually exclusive — cannot surface either",
    },
  ];

  const gateBlocking = createTrustGate({
    policy: createMemoryPolicy(blockingConflicts),
    auditWriter: noopAuditWriter(),
  });

  const resultBlocking = await gateBlocking.admit(proposal, support);
  const ctxBlocking = gateBlocking.render(resultBlocking);

  console.log();
  console.log("  Step 4 — detectConflicts():");
  console.log("            ITEM_CONFLICT detected: claim-1 ↔ claim-2");
  console.log("            severity=blocking → both force-rejected as BLOCKING_CONFLICT");
  console.log();

  subsep("OUTPUT — blocking conflict result");
  console.log();
  label("admittedUnits.length", resultBlocking.admittedUnits.length);
  label("rejectedUnits.length", resultBlocking.rejectedUnits.length);
  label("hasConflicts", resultBlocking.hasConflicts);
  console.log();
  for (const u of resultBlocking.rejectedUnits) {
    console.log(`  Unit: ${u.unitId}`);
    label("    status", u.status);
    label("    reasonCode", u.evaluationResults[0]?.reasonCode);
  }
  console.log();
  label("admittedBlocks.length", ctxBlocking.admittedBlocks.length);
  console.log();
  explain("admittedBlocks is empty. The downstream LLM receives no claims — only the instructions field. It can tell the user: 'Stock status is inconsistent across records. Please check the product page directly.' It does not guess.");
  console.log();
  explain("LIMITATION: jingu-trust-gate cannot resolve the conflict. It surfaces the problem and stops. A human or a dedicated reconciliation step must decide which record is authoritative.");

  assert.equal(resultBlocking.admittedUnits.length, 0);
  assert.equal(resultBlocking.rejectedUnits.length, 2);
  assert.equal(resultBlocking.hasConflicts, true);
  for (const u of resultBlocking.rejectedUnits) {
    assert.equal(u.status, "rejected");
    assert.equal(u.evaluationResults[0]?.reasonCode, "BLOCKING_CONFLICT");
  }
  assert.equal(ctxBlocking.admittedBlocks.length, 0);

  console.log();
  pass("admittedUnits.length === 0 (nothing admitted past the gate)");
  pass("rejectedUnits.length === 2 (both force-rejected)");
  pass("reasonCode === 'BLOCKING_CONFLICT' on both");
  pass("admittedBlocks.length === 0 (LLM receives empty context)");
}

// ===========================================================================
// Scenario 5: Semantic Retry Loop
// ===========================================================================

async function scenario5(): Promise<void> {
  sep("Scenario 5: Semantic Retry Loop — Evidence-Driven Correction");
  console.log();
  explain("ANTI-PATTERN: LLM provides a 'proven' claim with no evidence. When told to retry, LLM just softens the language to 'derived' — without supplying evidence. This is wrong.");
  console.log();
  explain("jingu-trust-gate response: RetryFeedback is a TYPED STRUCT, not a string. It carries unitId, reasonCode, and structured details. The fix the LLM must make is explicit: supply evidence. Softening language is not the fix.");
  console.log();
  explain("The LLMInvoker is responsible for serializing RetryFeedback as tool_result + is_error:true for Claude's built-in retry understanding. jingu-trust-gate controls WHETHER to retry. Invoker controls HOW.");

  subsep("RETRY FEEDBACK TYPE (load-bearing contract)");
  console.log();
  console.log("  type RetryFeedback = {");
  console.log("    summary: string;                    // human-readable, for logging");
  console.log("    errors: Array<{");
  console.log("      unitId?: string;                  // which unit failed");
  console.log("      reasonCode: string;               // MISSING_EVIDENCE | OVER_SPECIFIC_BRAND ...");
  console.log("      details?: Record<string, unknown>; // e.g. { suggestedGrade: 'derived' }");
  console.log("    }>;");
  console.log("  }");
  console.log();
  explain("The LLMInvoker receives this struct. For Claude: serialize as tool_result with is_error:true. The is_error flag activates Claude's built-in retry understanding.");

  subsep("SCENARIO — Two LLM Invocations");
  console.log();
  console.log("  Attempt 1 (LLM invocation 1):");
  console.log('    claim: "You have 5 cans of soup"  grade=proven  evidenceRefs=[]');
  console.log("    → gate verdict: MISSING_EVIDENCE → reject");
  console.log("    → jingu-trust-gate builds RetryFeedback");
  console.log("    → sends to LLMInvoker");
  console.log();
  console.log("  Attempt 2 (LLM invocation 2):");
  console.log('    LLM receives RetryFeedback.errors[0].reasonCode = "MISSING_EVIDENCE"');
  console.log('    LLM understands: the fix is supplying evidence, not softening language');
  console.log('    claim: "You have canned goods in the pantry"  grade=proven  evidenceRefs=["obs-pantry"]');
  console.log("    → gate verdict: OK → approve");

  const support: SupportRef[] = [
    {
      id: "sup-pantry",
      sourceType: "observation",
      sourceId: "obs-pantry",
      confidence: 0.7,
      attributes: { item: "canned-goods", location: "pantry" },
      retrievedAt: "2024-01-10T12:00:00Z",
    },
  ];

  let capturedFeedback: RetryFeedback | undefined;
  let invokerCallCount = 0;

  const invoker = async (
    _prompt: string,
    feedback?: RetryFeedback
  ): Promise<Proposal<MemoryClaim>> => {
    invokerCallCount++;

    if (feedback) {
      capturedFeedback = feedback;
    }

    if (invokerCallCount === 1) {
      return makeProposal([
        {
          id: "claim-1",
          text: "You have 5 cans of soup",
          grade: "proven",
          attributes: { hasQuantity: true },
          evidenceRefs: [],
        },
      ]);
    }

    return makeProposal([
      {
        id: "claim-1",
        text: "You have canned goods in the pantry",
        grade: "proven",
        attributes: {},
        evidenceRefs: ["obs-pantry"],
      },
    ]);
  };

  const gate = createTrustGate({
    policy: createMemoryPolicy(),
    auditWriter: noopAuditWriter(),
    retry: { maxRetries: 3, retryOnDecisions: ["reject"] },
  });

  const result = await gate.admitWithRetry(invoker, support, "What food do I have?");

  subsep("RetryFeedback that was sent to LLMInvoker");
  console.log();
  if (capturedFeedback) {
    label("summary", capturedFeedback.summary);
    console.log("  errors:");
    for (const err of capturedFeedback.errors) {
      label("    unitId", err.unitId);
      label("    reasonCode", err.reasonCode);
      if (err.details) label("    details", err.details);
    }
  }

  subsep("FINAL AdmissionResult");
  console.log();
  label("retryAttempts", result.retryAttempts);
  label("admittedUnits.length", result.admittedUnits.length);
  label("final unit status", result.admittedUnits[0]?.status);
  label("final unit text", result.admittedUnits[0]?.unit.text);
  console.log();
  explain("KEY POINT: The fix was supplying evidence, not softening language. If the LLM had just changed grade from 'proven' to 'derived' without supplying evidence, the retry would have failed again (MISSING_EVIDENCE only triggers on grade=proven, so that softening would have passed — but with wrong semantics). The correct fix is always: ground the claim.");
  console.log();
  explain("LIMITATION: retry is locally effective, not globally convergent. It works when the LLM cited wrong evidence refs. It does NOT work when the support pool itself is missing the data — jingu-trust-gate cannot distinguish between these two cases. The support pool is fixed for the entire retry loop. If the evidence was never retrieved, no number of retries will fix it.");

  assert.equal(result.retryAttempts, 2);
  assert.equal(result.admittedUnits.length, 1);
  assert.equal(result.admittedUnits[0].status, "approved");
  assert.ok(capturedFeedback, "RetryFeedback must have been sent");
  assert.ok(capturedFeedback!.errors.some((e) => e.reasonCode === "MISSING_EVIDENCE"));

  console.log();
  pass("retryAttempts === 2  (attempt 1 failed, attempt 2 succeeded)");
  pass("admittedUnits.length === 1");
  pass("final status === 'approved'");
  pass("RetryFeedback.errors[0].reasonCode === 'MISSING_EVIDENCE'");
  pass("Feedback is a typed struct, not a raw error string");
}

// ===========================================================================
// Scenario 6: All Three Adapters — Same VerifiedContext, Different Wire Formats
// ===========================================================================

async function scenario6(): Promise<void> {
  sep("Scenario 6: All Three Adapters — One VerifiedContext, Three Wire Formats");
  console.log();
  explain("The SAME VerifiedContext is fed to all three adapters. Each adapter produces the wire format its target LLM API expects. jingu-trust-gate is LLM-agnostic by design.");
  console.log();
  explain("This is the correct separation of concerns: jingu-trust-gate produces semantic structure, adapters translate it. You can swap target LLMs without changing your admission logic.");

  // Use the same VerifiedContext for all adapters
  const verifiedCtx: VerifiedContext = {
    admittedBlocks: [
      {
        sourceId: "claim-1",
        content: "You have milk in the fridge",
      },
      {
        sourceId: "claim-2",
        content: "You have a drink",
        grade: "derived",
        unsupportedAttributes: ["brand"],
      },
      {
        sourceId: "claim-3",
        content: "You have milk",
        conflictNote: "ITEM_CONFLICT: claim-1 and claim-4 contradict each other about milk presence",
      },
    ],
    summary: { admitted: 3, rejected: 0, conflicts: 1 },
  };

  subsep("INPUT — VerifiedContext (shared by all adapters)");
  console.log();
  console.log("  admittedBlocks:");
  console.log('    [claim-1]  content="You have milk in the fridge"                 (clean)');
  console.log('    [claim-2]  content="You have a drink"  grade=derived             (downgraded)');
  console.log('               unsupportedAttributes=["brand"]');
  console.log('    [claim-3]  content="You have milk"  conflictNote=ITEM_CONFLICT   (conflict)');

  // --- Claude Adapter ---
  subsep("ADAPTER 1 — ClaudeContextAdapter → search_result blocks");
  console.log();
  explain("Claude API supports native search_result blocks with citations. jingu-trust-gate maps each VerifiedBlock to one search_result block. Claude can cite specific blocks in its response.");
  console.log();

  const claudeAdapter = new ClaudeContextAdapter({ citations: true });
  const claudeBlocks = claudeAdapter.adapt(verifiedCtx);

  console.log("  Output: ClaudeSearchResultBlock[]");
  console.log();
  for (const block of claudeBlocks) {
    console.log(`    { type: "${block.type}", source: "${block.source}", title: "${block.title}" }`);
    console.log(`      content[0].text: ${JSON.stringify(block.content[0].text)}`);
    console.log(`      citations.enabled: ${block.citations?.enabled}`);
    console.log();
  }

  assert.equal(claudeBlocks.length, 3);
  assert.ok(claudeBlocks.every((b) => b.type === "search_result"));
  assert.ok(claudeBlocks[0].citations?.enabled === true);
  assert.ok(claudeBlocks[1].content[0].text.includes("[Evidence grade: derived]"));
  assert.ok(claudeBlocks[1].content[0].text.includes("[Not supported by evidence: brand]"));
  assert.ok(claudeBlocks[2].content[0].text.includes("[Conflict:"));

  pass("all 3 blocks are type='search_result'");
  pass("citations enabled on all blocks");
  pass("downgraded block has [Evidence grade: derived] caveat");
  pass("downgraded block has [Not supported by evidence: brand]");
  pass("conflict block has [Conflict: ...] annotation");

  // --- OpenAI Adapter (user mode) ---
  subsep("ADAPTER 2a — OpenAIContextAdapter (mode='user') → plain text user message");
  console.log();
  explain("OpenAI does not have a native search_result type. Verified content is serialized as plain text with semantic caveats inline. In 'user' mode, the message role is 'user' and is injected before the actual user query.");
  console.log();

  const openaiUserAdapter = new OpenAIContextAdapter({ mode: "user" });
  const openaiUserMsg = openaiUserAdapter.adapt(verifiedCtx);

  console.log("  Output: OpenAIChatMessage (role='user')");
  console.log();
  label("  role", openaiUserMsg.role);
  console.log("  content:");
  for (const line of openaiUserMsg.content.split("\n")) {
    console.log(`    ${line}`);
  }

  assert.equal(openaiUserMsg.role, "user");
  assert.ok(openaiUserMsg.content.includes("Evidence grade: derived"));
  assert.ok(openaiUserMsg.content.includes("Not supported by evidence: brand"));
  assert.ok(openaiUserMsg.content.includes("Conflict:"));

  console.log();
  pass("role === 'user'");
  pass("content includes Evidence grade caveat");
  pass("content includes conflict note");

  // --- OpenAI Adapter (tool mode) ---
  subsep("ADAPTER 2b — OpenAIContextAdapter (mode='tool') → tool result message");
  console.log();
  explain("In 'tool' mode, the message role is 'tool' and requires a tool_call_id. Use this when your RAG lookup is modeled as a tool call in the OpenAI function-calling loop.");
  console.log();

  const openaiToolAdapter = new OpenAIContextAdapter({
    mode: "tool",
    toolCallId: "call_abc123",
  });
  const openaiToolMsg = openaiToolAdapter.adapt(verifiedCtx);

  console.log("  Output: OpenAIChatMessage (role='tool')");
  console.log();
  label("  role", openaiToolMsg.role);
  label("  tool_call_id", openaiToolMsg.tool_call_id);
  console.log("  content (first 120 chars):");
  console.log(`    ${openaiToolMsg.content.slice(0, 120)}...`);

  assert.equal(openaiToolMsg.role, "tool");
  assert.equal(openaiToolMsg.tool_call_id, "call_abc123");

  console.log();
  pass("role === 'tool'");
  pass("tool_call_id === 'call_abc123'");

  // --- Gemini Adapter ---
  subsep("ADAPTER 3 — GeminiContextAdapter → Content with parts array");
  console.log();
  explain("Gemini uses Content[] for conversation history. Each VerifiedBlock becomes one part in the Content object. This keeps Gemini's grounding granular — it can attribute individual facts to individual parts.");
  console.log();

  const geminiAdapter = new GeminiContextAdapter({ role: "user" });
  const geminiContent = geminiAdapter.adapt(verifiedCtx);

  console.log("  Output: GeminiContent");
  console.log();
  label("  role", geminiContent.role);
  label("  parts.length", geminiContent.parts.length);
  console.log("  parts:");
  for (let i = 0; i < geminiContent.parts.length; i++) {
    console.log(`    parts[${i}].text: ${JSON.stringify(geminiContent.parts[i].text)}`);
  }

  assert.equal(geminiContent.role, "user");
  assert.equal(geminiContent.parts.length, 3);
  assert.ok(geminiContent.parts[1].text.includes("Evidence grade: derived"));
  assert.ok(geminiContent.parts[2].text.includes("Conflict:"));

  console.log();
  pass("role === 'user'");
  pass("parts.length === 3  (one part per VerifiedBlock)");
  pass("downgraded block part has Evidence grade caveat");
  pass("conflict block part has Conflict annotation");

  console.log();
  subsep("SUMMARY — Adapter Matrix");
  console.log();
  console.log("  Target    | Format                      | Mode");
  console.log("  ----------|-----------------------------|--------------------------");
  console.log("  Claude    | search_result blocks        | search_result + citations");
  console.log("  OpenAI    | ChatMessage (role=user)     | user turn before query");
  console.log("  OpenAI    | ChatMessage (role=tool)     | tool result in tool loop");
  console.log("  Gemini    | Content { role, parts[] }   | user turn in contents[]");
  console.log();
  explain("Same VerifiedContext. Same semantic content. Four different wire formats. jingu-trust-gate is adapter-agnostic. Add a new adapter for any LLM API without changing the gate or policy.");
}

// ===========================================================================
// Scenario 7: Agent Action Gate — Gate What the Agent Is Allowed to Do
// ===========================================================================

/**
 * AgentActionPolicy — policy for gating agent action proposals.
 *
 * This is a different GatePolicy than MemoryPolicy: instead of claims about
 * the world, the units are ACTIONS the agent wants to take.
 *
 * Gate rules:
 *   R1  no "explicit_request" evidence                                 → INTENT_NOT_ESTABLISHED → reject
 *   R2  riskLevel=high + isReversible=false + no "user_confirmation"   → CONFIRM_REQUIRED       → reject
 *   R3  everything else                                                 → approve
 *
 * source_type values used here:
 *   "explicit_request"  — something the user directly asked for
 *   "user_confirmation" — explicit user yes/ok for a high-risk action
 */
type ActionProposal = {
  id: string;
  actionName: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  isReversible: boolean;
  evidenceRefs: string[];
};

type AuthEvidence = {
  type: "explicit_request" | "user_confirmation" | "prior_context";
  content: string;
};

class AgentActionPolicy implements GatePolicy<ActionProposal> {
  validateStructure(proposal: Proposal<ActionProposal>): StructureValidationResult {
    if (proposal.units.length === 0) {
      return { kind: "structure", valid: false, errors: [{ field: "units", reasonCode: "EMPTY_UNITS" }] };
    }
    return { kind: "structure", valid: true, errors: [] };
  }

  bindSupport(unit: ActionProposal, pool: SupportRef[]): UnitWithSupport<ActionProposal> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  }

  evaluateUnit(
    uws: UnitWithSupport<ActionProposal>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    const { unit, supportRefs } = uws;

    // R1: every action needs an explicit user request
    const hasRequest = supportRefs.some(s => (s.attributes as AuthEvidence)?.type === "explicit_request");
    if (!hasRequest) {
      return reject(unit.id, "INTENT_NOT_ESTABLISHED", {
        note: `No explicit_request evidence for "${unit.actionName}" — agent cannot act without user authorization`,
      });
    }

    // R2: high-risk irreversible actions need user_confirmation on top of the request
    if (unit.riskLevel === "high" && !unit.isReversible) {
      const hasConfirmation = supportRefs.some(s => (s.attributes as AuthEvidence)?.type === "user_confirmation");
      if (!hasConfirmation) {
        return reject(unit.id, "CONFIRM_REQUIRED", {
          note: `riskLevel=high + isReversible=false requires user_confirmation (a request alone is not enough)`,
        });
      }
    }

    return approve(unit.id);
  }

  detectConflicts(_u: UnitWithSupport<ActionProposal>[], _p: SupportRef[]): ConflictAnnotation[] {
    return [];
  }

  render(admittedUnits: AdmittedUnit<ActionProposal>[], _pool: SupportRef[], _ctx: RenderContext): VerifiedContext {
    return {
      admittedBlocks: admittedUnits.map(u => ({
        sourceId: u.unitId,
        content: `[${(u.unit as ActionProposal).riskLevel.toUpperCase()}] ${(u.unit as ActionProposal).actionName}: ${(u.unit as ActionProposal).description}`,
        grade: (u.unit as ActionProposal).riskLevel,
      })),
      summary: { admitted: admittedUnits.length, rejected: 0, conflicts: 0 },
      instructions:
        "Execute only the verified actions below. " +
        "Do not re-ask for confirmation — admitted actions are already authorized. " +
        "Do not execute any action that was rejected.",
    };
  }

  buildRetryFeedback(unitResults: UnitEvaluationResult[], ctx: RetryContext): RetryFeedback {
    const failed = unitResults.filter(r => r.decision === "reject");
    return {
      summary: `${failed.length} action(s) rejected on attempt ${ctx.attempt}/${ctx.maxRetries}.`,
      errors: failed.map(r => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: {
          hint: r.reasonCode === "INTENT_NOT_ESTABLISHED"
            ? "Add an explicit_request SupportRef — the user must have asked for this action"
            : "Add a user_confirmation SupportRef before proposing high-risk irreversible actions",
        },
      })),
    };
  }
}

async function scenario7(): Promise<void> {
  sep("Scenario 7: Agent Action Gate — Gate What the Agent Is Allowed to Do");
  console.log();
  explain("This is the ACTIONS pattern: the gate is not checking claims about the world — it is checking whether the agent is AUTHORIZED to take specific actions. The LLM output is a list of proposed actions. Only authorized ones execute.");
  console.log();
  explain("Domain: household assistant. User says 'Please order more milk.' The agent proposes 3 actions: order_milk (low risk), delete_old_shopping_list (medium risk, reversible), send_notification_email (low risk). But only order_milk was actually requested.");
  console.log();
  explain("WHY THIS MATTERS FOR AGENTS: without a gate, the agent executes everything it proposes. With jingu-trust-gate, each action must be traced back to explicit user authorization before it can run. The agent cannot act beyond its mandate.");

  subsep("INPUT — Authorization evidence pool");
  console.log();
  console.log("  User said: 'Please order more milk'");
  console.log();
  console.log("  Support pool:");
  console.log('    req-001: type=explicit_request  content="Please order more milk"');
  console.log('    (no user_confirmation — user never said yes to a high-risk action)');

  const authPool: SupportRef[] = [
    {
      id: "ref-req-1",
      sourceId: "req-001",
      sourceType: "observation",
      attributes: {
        type: "explicit_request",
        content: "Please order more milk — we are running low",
      } satisfies AuthEvidence,
    },
  ];

  subsep("INPUT — Agent's proposed actions");
  console.log();
  console.log('  action-1: order_milk          risk=low   reversible=true  evidenceRefs=["req-001"]');
  console.log('  action-2: delete_old_list     risk=medium reversible=false evidenceRefs=[]');
  console.log('             → no evidence — agent decided on its own');
  console.log('  action-3: send_notification   risk=low   reversible=false evidenceRefs=["req-001"]');
  console.log('             → user asked to order milk, not to send emails');

  const proposal: Proposal<ActionProposal> = {
    id: "prop-agent-001",
    kind: "plan",
    units: [
      // action-1: user explicitly asked for this → APPROVE
      {
        id: "action-1",
        actionName: "order_milk",
        description: "Place online order for 2L whole milk via grocery app",
        riskLevel: "low",
        isReversible: true,
        evidenceRefs: ["req-001"],
      },
      // action-2: agent decided on its own, no user request → REJECT (INTENT_NOT_ESTABLISHED)
      {
        id: "action-2",
        actionName: "delete_old_shopping_list",
        description: "Delete the shopping list from 2 weeks ago",
        riskLevel: "medium",
        isReversible: false,
        evidenceRefs: [],
      },
      // action-3: req-001 is about ordering milk, not sending emails → REJECT (INTENT_NOT_ESTABLISHED)
      {
        id: "action-3",
        actionName: "send_notification_email",
        description: "Send email to household members that milk was ordered",
        riskLevel: "low",
        isReversible: false,
        evidenceRefs: [],  // user never asked to send emails
      },
    ],
  };

  const gate = createTrustGate({
    policy: new AgentActionPolicy(),
    auditWriter: noopAuditWriter(),
  });

  subsep("GATE EXECUTION — gate.admit()");
  console.log();
  console.log("  Step 1 — validateStructure(): 3 units  → valid");
  console.log("  Step 2 — bindSupport():");
  console.log("            action-1 evidenceRefs=[req-001]  → matched ref-req-1");
  console.log("            action-2 evidenceRefs=[]         → no support");
  console.log("            action-3 evidenceRefs=[]         → no support");
  console.log("  Step 3 — evaluateUnit():");
  console.log("            action-1: has explicit_request  → approve");
  console.log("            action-2: no explicit_request   → INTENT_NOT_ESTABLISHED → reject");
  console.log("            action-3: no explicit_request   → INTENT_NOT_ESTABLISHED → reject");
  console.log("  Step 4 — detectConflicts(): none");

  const result = await gate.admit(proposal, authPool);
  const context = gate.render(result);
  const expl = gate.explain(result);

  subsep("OUTPUT — Gate decision");
  console.log();
  console.log("  Admitted (authorized to execute):");
  for (const u of result.admittedUnits) {
    label(`    ${u.unitId} [${u.status}]`, (u.unit as ActionProposal).actionName);
  }
  console.log();
  console.log("  Rejected (blocked):");
  for (const u of result.rejectedUnits) {
    const ann = u.evaluationResults[0]?.annotations as any;
    label(`    ${u.unitId} [${u.evaluationResults[0]?.reasonCode}]`, (u.unit as ActionProposal).actionName);
    if (ann?.note) label("      note", ann.note);
  }
  console.log();
  label("  approved", expl.approved);
  label("  rejected", expl.rejected);

  console.log();
  console.log("  VerifiedContext.instructions (sent to LLM before it executes):");
  console.log(`    "${context.instructions}"`);
  console.log();
  console.log("  Admitted action blocks:");
  for (const block of context.admittedBlocks) {
    label(`    ${block.sourceId}`, block.content);
  }

  console.log();
  explain("The agent receives VerifiedContext with 1 admitted action and the instructions. It executes order_milk. It does NOT execute delete_old_shopping_list or send_notification_email — those were never admitted through the gate.");
  console.log();
  explain("KEY POINT: the gate did not need to 'understand' the user request. It checked a deterministic rule: does this action have explicit_request evidence in its support pool? No evidence → no execution. This is why the gate is deterministic even in complex agentic flows.");

  // ── Part B: High-risk action with confirmation ────────────────────────────

  subsep("Part B — High-risk action: request alone is not enough");
  console.log();
  explain("User says 'Clear my entire order history.' Agent proposes delete_order_history (riskLevel=high, isReversible=false). The request is present — but R2 fires: high-risk irreversible actions need user_confirmation too.");
  console.log();
  console.log("  First attempt — only request present:");
  console.log('    req-002: type=explicit_request  content="Clear my entire order history"');
  console.log("    → R2: riskLevel=high + isReversible=false → CONFIRM_REQUIRED → reject");

  const highRiskPool: SupportRef[] = [
    {
      id: "ref-req-2",
      sourceId: "req-002",
      sourceType: "observation",
      attributes: {
        type: "explicit_request",
        content: "Clear my entire order history — I want a fresh start",
      } satisfies AuthEvidence,
    },
  ];

  const highRiskProposal: Proposal<ActionProposal> = {
    id: "prop-agent-002",
    kind: "plan",
    units: [
      {
        id: "action-4",
        actionName: "delete_order_history",
        description: "Permanently delete all past orders",
        riskLevel: "high",
        isReversible: false,
        evidenceRefs: ["req-002"],
      },
    ],
  };

  const highRiskGate = createTrustGate({
    policy: new AgentActionPolicy(),
    auditWriter: noopAuditWriter(),
  });

  const result2 = await highRiskGate.admit(highRiskProposal, highRiskPool);
  const act4Rejected = result2.rejectedUnits.find(u => u.unitId === "action-4");
  const ann = act4Rejected?.evaluationResults[0]?.annotations as any;

  label("  action-4 decision", act4Rejected?.evaluationResults[0]?.reasonCode);
  if (ann?.note) label("  note", ann.note);

  console.log();
  console.log("  Second attempt — user confirms:");
  console.log('    confirm-001: type=user_confirmation  content="Yes, delete everything"');
  console.log("    → R1: has explicit_request ✓   R2: has user_confirmation ✓ → approve");

  const confirmedPool: SupportRef[] = [
    ...highRiskPool,
    {
      id: "ref-confirm-1",
      sourceId: "confirm-001",
      sourceType: "observation",
      attributes: {
        type: "user_confirmation",
        content: "Yes, go ahead — delete everything",
      } satisfies AuthEvidence,
    },
  ];

  const confirmedProposal: Proposal<ActionProposal> = {
    id: "prop-agent-002-confirmed",
    kind: "plan",
    units: [
      {
        id: "action-4",
        actionName: "delete_order_history",
        description: "Permanently delete all past orders",
        riskLevel: "high",
        isReversible: false,
        evidenceRefs: ["req-002", "confirm-001"],
      },
    ],
  };

  const result3 = await highRiskGate.admit(confirmedProposal, confirmedPool);
  const act4Confirmed = result3.admittedUnits.find(u => u.unitId === "action-4");

  label("  action-4 decision (with confirmation)", act4Confirmed?.status);

  assert.equal(expl.approved, 1);
  assert.equal(expl.rejected, 2);
  assert.ok(result.admittedUnits.find(u => u.unitId === "action-1"));
  assert.ok(result.rejectedUnits.find(u => u.unitId === "action-2"));
  assert.ok(result.rejectedUnits.find(u => u.unitId === "action-3"));
  assert.equal(result.rejectedUnits.find(u => u.unitId === "action-2")?.evaluationResults[0]?.reasonCode, "INTENT_NOT_ESTABLISHED");
  assert.equal(act4Rejected?.evaluationResults[0]?.reasonCode, "CONFIRM_REQUIRED");
  assert.equal(act4Confirmed?.status, "approved");

  console.log();
  pass("action-1 (order_milk) approved — user explicitly requested it");
  pass("action-2 (delete_old_list) rejected — INTENT_NOT_ESTABLISHED (agent decided on its own)");
  pass("action-3 (send_notification_email) rejected — INTENT_NOT_ESTABLISHED (no email request)");
  pass("action-4 (delete_order_history) rejected first attempt — CONFIRM_REQUIRED");
  pass("action-4 approved after user_confirmation added");
  pass("VerifiedContext.instructions tells agent which actions to execute");
}

// ===========================================================================
// Scenario 8: Preventing Memory Corruption — State Drift
// ===========================================================================
//
// This is the hero scenario.
//
// Every other scenario shows the gate catching a bad response or blocking
// an unauthorized action — errors that affect one turn. This scenario shows
// the deeper failure mode: incorrect inferences written into persistent
// state, where they become "facts" that corrupt every future interaction.
//
// The gate is the last line before system state. Nothing wrong gets in.

type MemoryWrite = {
  id: string;
  key: string;     // memory key, e.g. "milk_stock", "user_prefers_brand"
  value: string;   // proposed value
  grade: "stated" | "inferred";
  evidenceRefs: string[];
};

class StateDriftPolicy implements GatePolicy<MemoryWrite> {
  validateStructure(proposal: Proposal<MemoryWrite>): StructureValidationResult {
    if (proposal.units.length === 0) {
      return { kind: "structure", valid: false, errors: [{ field: "units", reasonCode: "EMPTY_UNITS" }] };
    }
    return { kind: "structure", valid: true, errors: [] };
  }

  bindSupport(unit: MemoryWrite, pool: SupportRef[]): UnitWithSupport<MemoryWrite> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  }

  evaluateUnit(
    uws: UnitWithSupport<MemoryWrite>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    const { unit, supportRefs } = uws;

    // R1: must have at least one user_statement in evidence pool
    const hasUserStatement = supportRefs.some(s => s.sourceType === "user_statement");
    if (!hasUserStatement) {
      return reject(unit.id, "INFERRED_NOT_STATED", {
        note: `"${unit.key}" was not stated by the user — it was inferred by the model`,
      });
    }

    // R2: value must appear verbatim in a user statement; otherwise downgrade to "inferred"
    const verbatimMatch = supportRefs.some(s =>
      s.sourceType === "user_statement" &&
      typeof s.attributes?.content === "string" &&
      (s.attributes?.content as string).toLowerCase().includes(unit.value.toLowerCase())
    );
    if (!verbatimMatch) {
      return downgrade(unit.id, "VALUE_NOT_VERBATIM", "inferred", {
        note: `"${unit.value}" is not verbatim in the user statement — stored as inferred, not stated`,
      });
    }

    return approve(unit.id);
  }

  detectConflicts(_u: UnitWithSupport<MemoryWrite>[], _p: SupportRef[]): ConflictAnnotation[] {
    return [];
  }

  render(admittedUnits: AdmittedUnit<MemoryWrite>[], _pool: SupportRef[], _ctx: RenderContext): VerifiedContext {
    return {
      admittedBlocks: admittedUnits.map(u => ({
        sourceId: u.unitId,
        content: `${(u.unit as MemoryWrite).key} = "${(u.unit as MemoryWrite).value}"  [${u.status}]`,
        grade: (u.unit as MemoryWrite).grade,
      })),
      summary: { admitted: admittedUnits.length, rejected: 0, conflicts: 0 },
      instructions: "Write only the verified facts below to system state. Rejected writes must not be stored.",
    };
  }

  buildRetryFeedback(unitResults: UnitEvaluationResult[], ctx: RetryContext): RetryFeedback {
    const failed = unitResults.filter(r => r.decision === "reject");
    return {
      summary: `${failed.length} write(s) blocked — not grounded in user statements`,
      errors: failed.map(r => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: { hint: "Only write facts the user explicitly stated, not what you inferred" },
      })),
    };
  }
}

async function scenario8(): Promise<void> {
  sep("Scenario 8: Preventing Memory Corruption — State Drift");
  console.log();
  explain("This is the state gating pattern. The gate does not check a response or an action — it controls what is allowed to enter persistent system state. Once incorrect information is written to state, it becomes a permanent 'fact' that poisons every future retrieval, recommendation, and decision.");
  console.log();

  // ── The problem ─────────────────────────────────────────────────────────────

  subsep("THE PROBLEM — What happens without a gate");
  console.log();
  console.log("  User says: \"We're running low on milk\"");
  console.log();
  console.log("  LLM proposes 3 memory writes:");
  console.log("    write-1: milk_stock        = \"low\"     grade=stated    (grounded ✓)");
  console.log("    write-2: user_prefers_brand = \"Oatly\"  grade=inferred  (hallucinated ✗)");
  console.log("    write-3: weekly_budget      = \"$50\"    grade=inferred  (hallucinated ✗)");
  console.log();
  console.log("  ❌  Without a gate, all 3 writes reach the database.");
  console.log();
  console.log("  Now the system 'knows':");
  console.log("    — user prefers Oatly (never said)");
  console.log("    — weekly budget is $50 (never said)");
  console.log();
  console.log("  These become the ground truth for:");
  console.log("    — future shopping recommendations  (wrong brand every time)");
  console.log("    — auto-generated shopping lists    (filtered by wrong budget)");
  console.log("    — every RAG retrieval that follows");
  console.log();
  console.log("  The model made two guesses. Both became permanent system facts.");
  console.log("  The system is now drifting away from reality.");
  console.log("  There is no automatic correction. Every future interaction inherits the error.");

  // ── Support pool ────────────────────────────────────────────────────────────

  subsep("WITH THE GATE — Evidence pool");
  console.log();
  console.log("  One user statement in pool:");
  console.log("    stmt-1: source_type=user_statement  content=\"We're running low on milk\"");
  console.log("    (nothing about brand, nothing about budget)");

  const evidencePool: SupportRef[] = [
    {
      id: "ref-stmt-1",
      sourceId: "stmt-1",
      sourceType: "user_statement",
      attributes: { content: "We're running low on milk" },
    },
  ];

  // ── Proposal ────────────────────────────────────────────────────────────────

  const proposal: Proposal<MemoryWrite> = {
    id: "prop-memory-001",
    kind: "mutation",
    units: [
      // write-1: grounded — "low" appears in the user statement → approve
      {
        id: "write-1",
        key: "milk_stock",
        value: "low",
        grade: "stated",
        evidenceRefs: ["stmt-1"],
      },
      // write-2: no user statement mentions "Oatly" → INFERRED_NOT_STATED → reject
      {
        id: "write-2",
        key: "user_prefers_brand",
        value: "Oatly",
        grade: "inferred",
        evidenceRefs: [],
      },
      // write-3: no user statement mentions "$50" → INFERRED_NOT_STATED → reject
      {
        id: "write-3",
        key: "weekly_budget",
        value: "$50",
        grade: "inferred",
        evidenceRefs: [],
      },
    ],
  };

  // ── Gate execution ───────────────────────────────────────────────────────────

  subsep("GATE EXECUTION");
  console.log();
  console.log("  Step 1 — validateStructure(): 3 writes  → valid");
  console.log("  Step 2 — bindSupport():");
  console.log("            write-1 evidenceRefs=[stmt-1]  → matched ref-stmt-1");
  console.log("            write-2 evidenceRefs=[]        → no support");
  console.log("            write-3 evidenceRefs=[]        → no support");
  console.log("  Step 3 — evaluateUnit():");
  console.log("            write-1: has user_statement, value 'low' in content  → approve");
  console.log("            write-2: no user_statement                           → INFERRED_NOT_STATED → reject");
  console.log("            write-3: no user_statement                           → INFERRED_NOT_STATED → reject");

  const gate = createTrustGate({
    policy: new StateDriftPolicy(),
    auditWriter: noopAuditWriter(),
  });

  const result = await gate.admit(proposal, evidencePool);
  const context = gate.render(result);
  const expl = gate.explain(result);

  // ── Output ──────────────────────────────────────────────────────────────────

  subsep("OUTPUT — What reaches system state");
  console.log();
  console.log("  ✅  Admitted (written to memory store):");
  for (const b of context.admittedBlocks) {
    label(`    ${b.sourceId}`, b.content);
  }
  console.log();
  console.log("  ❌  Rejected (never reach storage):");
  for (const u of result.rejectedUnits) {
    const ann = u.evaluationResults[0]?.annotations as any;
    label(`    ${u.unitId}  [${u.evaluationResults[0]?.reasonCode}]`, (u.unit as MemoryWrite).key);
    if (ann?.note) label("      note", ann.note);
  }
  console.log();
  label("  approved", expl.approved);
  label("  rejected", expl.rejected);
  console.log();
  console.log(`  VerifiedContext.instructions:`);
  console.log(`    "${context.instructions}"`);

  // ── The point ────────────────────────────────────────────────────────────────

  console.log();
  subsep("WHY THIS MATTERS");
  console.log();
  explain("Without a gate: incorrect inferences become permanent system facts. Every future interaction that retrieves this state inherits the error. The model made two guesses in one turn — and both would have been stored as ground truth forever.");
  console.log();
  explain("With the gate: only milk_stock = \"low\" reaches the database. The two hallucinated facts never exist in state. The system cannot drift from the user's actual reality.");
  console.log();
  console.log("  The structural difference:");
  console.log();
  console.log("    Without gate:  LLM output → system state");
  console.log("    With gate:     LLM output → gate (deterministic check) → system state");
  console.log();
  console.log("  The gate does not make the LLM smarter.");
  console.log("  It makes the system's memory honest.");

  // ── Assertions ──────────────────────────────────────────────────────────────

  assert.equal(expl.approved, 1);
  assert.equal(expl.rejected, 2);
  assert.ok(result.admittedUnits.find(u => u.unitId === "write-1"));
  assert.ok(result.rejectedUnits.find(u => u.unitId === "write-2"));
  assert.ok(result.rejectedUnits.find(u => u.unitId === "write-3"));
  assert.equal(
    result.rejectedUnits.find(u => u.unitId === "write-2")?.evaluationResults[0]?.reasonCode,
    "INFERRED_NOT_STATED"
  );
  assert.equal(
    result.rejectedUnits.find(u => u.unitId === "write-3")?.evaluationResults[0]?.reasonCode,
    "INFERRED_NOT_STATED"
  );

  console.log();
  pass("write-1 (milk_stock = \"low\") approved — verbatim in user statement");
  pass("write-2 (user_prefers_brand = \"Oatly\") rejected — INFERRED_NOT_STATED");
  pass("write-3 (weekly_budget = \"$50\") rejected — INFERRED_NOT_STATED");
  pass("system state contains only what the user actually said");
  pass("two hallucinated facts blocked before reaching the database");
}

// ===========================================================================
// Patterns and Anti-Patterns summary
// ===========================================================================

function printPatternsAndAntiPatterns(): void {
  sep("PATTERNS AND ANTI-PATTERNS");
  console.log();
  console.log("  PATTERNS (what jingu-trust-gate enables):");
  console.log();
  console.log("  Pattern 1: Evidence-backed admission");
  explain("Only proven claims with evidence refs pass. Grade=proven with no evidence is deterministically rejected. Calibrates confidence to what the system actually knows.");
  console.log();
  console.log("  Pattern 2: Precision calibration");
  explain("Over-specific claims are downgraded, not rejected. The claim is admitted with reduced grade and unsupportedAttributes marked. The downstream LLM adjusts its language accordingly.");
  console.log();
  console.log("  Pattern 3: Conflict surfacing");
  explain("Contradictions between claims are annotated and passed through (informational) or blocked (blocking). jingu-trust-gate never silently picks a winner. LLM receives all facts and can surface the contradiction to the user.");
  console.log();
  console.log("  Pattern 4: Structured retry");
  explain("RetryFeedback is a typed struct with unitId, reasonCode, and details. The invoker serializes it as tool_result + is_error:true for Claude's built-in retry. The LLM understands exactly what to fix.");
  console.log();
  console.log("  Pattern 5: LLM-agnostic output");
  explain("VerifiedContext is an abstract semantic structure. Adapters translate it to wire format. Swap Claude for OpenAI without changing your gate or policy.");
  console.log();
  console.log("  ANTI-PATTERNS (what jingu-trust-gate prevents):");
  console.log();
  console.log("  Anti-pattern 1: Hallucinated certainty");
  explain("grade=proven with no evidence reference. The LLM stated something as fact with no backing. Gate rejects with MISSING_EVIDENCE. Prevented: LLM telling user false facts with high confidence.");
  console.log();
  console.log("  Anti-pattern 2: Specificity hallucination");
  explain("Brand assertion ('Coca-Cola') without brand evidence. Claim is more specific than what the evidence supports. Gate downgrades with OVER_SPECIFIC_BRAND. unsupportedAttributes marked.");
  console.log();
  console.log("  Anti-pattern 3: Silent conflict resolution");
  explain("Picking one of two contradictory claims as the 'true' one. jingu-trust-gate rejects this by design. Both claims are admitted with conflict annotations. Information is never silently discarded.");
  console.log();
  console.log("  Anti-pattern 4: String-based retry");
  explain("Passing raw error string to LLM as retry feedback. Loses structure, loses traceability, LLM cannot extract specific unit IDs or reason codes. RetryFeedback is always a typed struct.");
  console.log();
  console.log("  Anti-pattern 5: Bypassing the gate");
  explain("Passing LLM output directly as trusted context without running gate.admit(). This defeats the entire system. Every Proposal must flow through the gate before reaching the LLM context.");
  console.log();
  console.log("  KNOWN LIMITATIONS:");
  console.log();
  console.log("  Limitation 1: jingu-trust-gate is a judge, not an editor");
  explain("It flags problems and annotates precision boundaries. It does not rewrite claims, fill in missing evidence, or auto-resolve conflicts. Downstream LLM receives the annotations and decides how to express them.");
  console.log();
  console.log("  Limitation 2: support pool is fixed per admission");
  explain("Retry works when the LLM cited wrong evidence refs. It does not work when the evidence simply does not exist in your system. jingu-trust-gate cannot distinguish between these two cases — MISSING_EVIDENCE looks identical in both.");
  console.log();
  console.log("  Limitation 3: no cross-session state");
  explain("jingu-trust-gate is stateless per call. It does not remember previous admissions or detect patterns across sessions. Cross-session governance must be implemented outside the gate.");
  console.log();
  console.log("  Limitation 4: no domain constraint on TUnit");
  explain("jingu-trust-gate does not enforce that TUnit has an id field. If your policy's evaluateUnit returns a mismatched unitId, the audit log will have orphan entries. Your policy is responsible for ID consistency.");
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  printIronLaws();

  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();
  await scenario8();

  printPatternsAndAntiPatterns();

  sep("ALL 8 SCENARIOS PASSED");
  console.log();
  console.log("  Scenarios:");
  console.log("    1. Happy Path               — zero friction, full pipeline printed");
  console.log("    2. Missing Evidence         — hallucination caught at gate");
  console.log("    3. Over-Specificity         — precision calibrated, not rejected");
  console.log("    4. Conflict Detection       — informational: both surfaced with notes; blocking: both force-rejected, LLM gets empty context");
  console.log("    5. Semantic Retry Loop      — evidence-driven correction, typed feedback");
  console.log("    6. All Three Adapters       — same VerifiedContext, Claude + OpenAI + Gemini");
  console.log("    7. Agent Action Gate        — gate what the agent is allowed to do");
  console.log("    8. Preventing Memory Corruption — state drift blocked before it reaches storage");
  console.log();
  console.log("  Iron Laws verified:");
  console.log("    Law 1 — Gate Engine: zero LLM calls in all gate steps");
  console.log("    Law 2 — Policy is injected: MemoryPolicy carries all domain semantics");
  console.log("    Law 3 — Audit log: every admit() writes an AuditEntry");
  console.log();
  console.log("  Best for:");
  console.log("    — RAG pipelines where LLM output must be grounded in retrieved evidence");
  console.log("    — Multi-LLM systems needing a trusted handoff point between models");
  console.log("    — Any domain requiring audit trails and explainable admission decisions");
  console.log();
  console.log("  Not for:");
  console.log("    — Pure creative tasks (no support pool = jingu-trust-gate has nothing to verify against)");
  console.log("    — Sub-100ms latency requirements");
  console.log("    — Systems that expect jingu-trust-gate to rewrite or auto-fix LLM output");
  console.log();
}

main().catch((err) => {
  console.error("\nDemo failed:", err);
  process.exit(1);
});
