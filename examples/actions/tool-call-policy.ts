/**
 * Tool-calling assistant — tool call proposal policy for jingu-trust-gate.
 *
 * Use case: an assistant proposes tool calls to retrieve real-world data.
 * Before any tool is executed, the gate validates that the call is grounded in
 * actual user intent, that the expected value is stated, and that the call
 * does not duplicate a result already present in the context.
 *
 * Domain types
 *   ToolCallProposal — one proposed tool invocation
 *   CallContextAttrs — shape of SupportRef.attributes for conversation context items
 *
 * Gate rules (evaluateUnit)
 *   R1  justification is empty or generic ("to help the user")               → WEAK_JUSTIFICATION      → downgrade to "optional"
 *   R2  grade=necessary but no evidence that user actually requested this     → INTENT_NOT_ESTABLISHED  → reject
 *   R3  tool call duplicates a prior_result already in evidence               → REDUNDANT_CALL          → reject
 *   R4  expectedValue is empty                                                → MISSING_EXPECTED_VALUE  → downgrade to "optional"
 *   R5  everything else                                                       → approve
 *
 * No conflict detection in this example — tool calls don't conflict with each other.
 *
 * Run:
 *   npm run build && node dist/examples/tool-call-policy.js
 */

import assert from "node:assert/strict";
import { createTrustGate } from "../src/trust-gate.js";
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
import { approve, reject, downgrade, firstFailing } from "../src/helpers/index.js";

// ── Domain types ──────────────────────────────────────────────────────────────

type CallGrade = "necessary" | "optional";

type ToolCallProposal = {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  justification: string;     // why this call is needed NOW
  expectedValue: string;     // what the agent expects to get back
  evidenceRefs: string[];    // context IDs (SupportRef.sourceId) supporting this call
  grade: CallGrade;
};

// Shape of SupportRef.attributes for conversation / context items
type CallContextAttrs = {
  contextId: string;
  type: "user_message" | "conversation_turn" | "prior_result";
  content: string;            // excerpt of the context item
  toolName?: string;          // for prior_result: which tool produced it
};

// Patterns that indicate a generic, unhelpful justification
const GENERIC_JUSTIFICATION_PATTERNS = [
  /^to help the user$/i,
  /^to assist$/i,
  /^required$/i,
  /^needed$/i,
  /^for the user$/i,
];

function isGenericJustification(text: string): boolean {
  if (!text || text.trim().length < 10) return true;
  return GENERIC_JUSTIFICATION_PATTERNS.some(p => p.test(text.trim()));
}

// ── Policy ────────────────────────────────────────────────────────────────────

class ToolCallPolicy implements GatePolicy<ToolCallProposal> {

  validateStructure(proposal: Proposal<ToolCallProposal>): StructureValidationResult {
    const errors: StructureValidationResult["errors"] = [];

    if (proposal.units.length === 0) {
      errors.push({ field: "units", reasonCode: "EMPTY_PROPOSAL" });
      return { kind: "structure", valid: false, errors };
    }

    for (const unit of proposal.units) {
      if (!unit.id?.trim()) {
        errors.push({ field: "id", reasonCode: "MISSING_UNIT_ID" });
      }
      if (!unit.toolName?.trim()) {
        errors.push({ field: "toolName", reasonCode: "MISSING_TOOL_NAME", message: `unit ${unit.id}` });
      }
      if (!unit.grade) {
        errors.push({ field: "grade", reasonCode: "MISSING_GRADE", message: `unit ${unit.id}: missing grade` });
      }
      if (!Array.isArray(unit.evidenceRefs)) {
        errors.push({ field: "evidenceRefs", reasonCode: "MISSING_EVIDENCE_REFS", message: `unit ${unit.id}` });
      }
    }

    return { kind: "structure", valid: errors.length === 0, errors };
  }

  bindSupport(unit: ToolCallProposal, pool: SupportRef[]): UnitWithSupport<ToolCallProposal> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return {
      unit,
      supportIds: matched.map(s => s.id),
      supportRefs: matched,
    };
  }

  evaluateUnit(
    uws: UnitWithSupport<ToolCallProposal>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    return firstFailing([
      this.#checkJustification(uws),
      this.#checkRedundant(uws),
      this.#checkIntent(uws),
      this.#checkExpectedValue(uws),
    ]) ?? approve(uws.unit.id);
  }

  // R1: generic or missing justification — downgrade, don't reject.
  // The call may still be valid; we just can't treat it as necessary.
  #checkJustification({ unit }: UnitWithSupport<ToolCallProposal>) {
    if (isGenericJustification(unit.justification)) {
      return downgrade(unit.id, "WEAK_JUSTIFICATION", "optional", {
        note: `Justification "${unit.justification}" is absent or too generic to treat call as necessary`,
      });
    }
    return undefined;
  }

  // R2 (checked before intent): a prior_result for the same tool is already in the evidence pool.
  // Redundancy is independent of intent — even an intentional call is redundant if the result exists.
  #checkRedundant({ unit, supportRefs }: UnitWithSupport<ToolCallProposal>) {
    const duplicateResult = supportRefs.find(s => {
      const attrs = s.attributes as CallContextAttrs | undefined;
      return attrs?.type === "prior_result" && attrs.toolName === unit.toolName;
    });
    if (duplicateResult) {
      const attrs = duplicateResult.attributes as CallContextAttrs;
      return reject(unit.id, "REDUNDANT_CALL", {
        existingResultId: duplicateResult.sourceId,
        note: `A prior_result for "${unit.toolName}" already exists (${duplicateResult.sourceId}); call is redundant`,
        existingContent: attrs.content,
      });
    }
    return undefined;
  }

  // R3: grade=necessary but no evidence that the user actually asked for this.
  // There must be at least one user_message or conversation_turn that establishes intent.
  #checkIntent({ unit, supportRefs }: UnitWithSupport<ToolCallProposal>) {
    if (unit.grade === "necessary") {
      const hasUserIntent = supportRefs.some(s => {
        const attrs = s.attributes as CallContextAttrs | undefined;
        return attrs?.type === "user_message" || attrs?.type === "conversation_turn";
      });
      if (!hasUserIntent) {
        return reject(unit.id, "INTENT_NOT_ESTABLISHED", {
          note: `grade=necessary but no user_message or conversation_turn in evidence establishes user intent`,
        });
      }
    }
    return undefined;
  }

  // R4: expectedValue not stated — downgrade (call can still run, but agent can't validate result).
  #checkExpectedValue({ unit }: UnitWithSupport<ToolCallProposal>) {
    if (!unit.expectedValue?.trim()) {
      return downgrade(unit.id, "MISSING_EXPECTED_VALUE", "optional", {
        note: "expectedValue is empty; cannot validate tool result against expectation",
      });
    }
    return undefined;
  }

  // No cross-call conflicts for tool calls
  detectConflicts(
    _units: UnitWithSupport<ToolCallProposal>[],
    _pool: SupportRef[]
  ): ConflictAnnotation[] {
    return [];
  }

  render(
    admittedUnits: AdmittedUnit<ToolCallProposal>[],
    _pool: SupportRef[],
    _ctx: RenderContext
  ): VerifiedContext {
    const admittedBlocks = admittedUnits.map(u => {
      const call = u.unit as ToolCallProposal;
      const currentGrade = u.appliedGrades[u.appliedGrades.length - 1] ?? call.grade;
      return {
        sourceId: u.unitId,
        content: `call ${call.toolName}(${JSON.stringify(call.arguments)}) — expects: ${call.expectedValue}`,
        grade: currentGrade,
        ...(u.status === "downgraded" && {
          unsupportedAttributes: [u.evaluationResults[0]?.reasonCode ?? ""],
        }),
      };
    });

    return {
      admittedBlocks,
      summary: {
        admitted: admittedUnits.length,
        rejected: 0, // patched by gate.render()
        conflicts: 0,
      },
      instructions:
        "Execute only the approved and necessary tool calls below. " +
        "Optional calls (downgraded) may be skipped if the answer is already sufficient. " +
        "Rejected calls must NOT be executed — they are either redundant or lack user authorization.",
    };
  }

  buildRetryFeedback(
    unitResults: UnitEvaluationResult[],
    ctx: RetryContext
  ): RetryFeedback {
    const failed = unitResults.filter(r => r.decision === "reject");
    return {
      summary:
        `${failed.length} tool call(s) rejected on attempt ${ctx.attempt}/${ctx.maxRetries}. ` +
        `Add user_message evidence or remove redundant calls.`,
      errors: failed.map(r => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: {
          hint: r.reasonCode === "INTENT_NOT_ESTABLISHED"
            ? "Add a user_message SupportRef that explicitly requests this information"
            : "A prior_result for this tool already exists — use it instead of calling again",
          existingResultId: (r.annotations as any)?.existingResultId,
        },
      })),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function noopAuditWriter(): AuditWriter {
  return { append: async (_e: AuditEntry) => {} };
}

function pass(msg: string): void {
  console.log(`    [PASS] ${msg}`);
}

function sep(title: string): void {
  console.log("\n" + "═".repeat(70));
  console.log(`  ${title}`);
  console.log("═".repeat(70));
}

function subsep(title: string): void {
  console.log(`\n  ── ${title}`);
}

function label(key: string, value: unknown): void {
  console.log(`    ${key.padEnd(28)}: ${JSON.stringify(value)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const gate = createTrustGate({
    policy: new ToolCallPolicy(),
    auditWriter: noopAuditWriter(),
  });

  // ── INPUT: conversation context ─────────────────────────────────────────────
  //
  // User says: "What's the weather in NYC?"
  // A prior fetch_user_profile call has already been executed (prior_result in pool).
  // The agent now proposes 3 tool calls: get_weather, fetch_user_profile (redundant), search_docs.

  sep("Scenario — User asks: 'What's the weather in NYC?'");
  subsep("INPUT: conversation context pool");

  const supportPool: SupportRef[] = [
    // The user's message — establishes intent for weather query
    {
      id: "ref-msg-1",
      sourceId: "msg-001",
      sourceType: "observation",
      attributes: {
        contextId: "msg-001",
        type: "user_message",
        content: "What's the weather in NYC?",
      } satisfies CallContextAttrs,
    },
    // A prior_result for fetch_user_profile already in context — any new fetch is redundant
    {
      id: "ref-prior-1",
      sourceId: "prior-profile-001",
      sourceType: "observation",
      attributes: {
        contextId: "prior-profile-001",
        type: "prior_result",
        toolName: "fetch_user_profile",
        content: "{ userId: 'u42', name: 'Alice', location: 'New York, NY' }",
      } satisfies CallContextAttrs,
    },
  ];

  console.log("\n  Conversation context:");
  for (const ref of supportPool) {
    const attrs = ref.attributes as CallContextAttrs;
    label(`  ${ref.sourceId} [${attrs.type}]`, attrs.content);
  }

  // ── INPUT: proposed tool calls ─────────────────────────────────────────────

  subsep("INPUT: proposed tool calls");

  const proposal: Proposal<ToolCallProposal> = {
    id: "prop-tool-001",
    kind: "plan",
    units: [
      // call-1: get_weather — user explicitly asked for it, good justification → APPROVE
      {
        id: "call-1",
        toolName: "get_weather",
        arguments: { location: "New York City, NY", units: "fahrenheit" },
        justification: "User explicitly asked for the current weather in NYC; need real-time data",
        expectedValue: "Current temperature, conditions, and forecast for NYC",
        evidenceRefs: ["msg-001"],
        grade: "necessary",
      },
      // call-2: fetch_user_profile — prior_result already in pool → REJECT (R3 REDUNDANT_CALL)
      {
        id: "call-2",
        toolName: "fetch_user_profile",
        arguments: { userId: "u42" },
        justification: "Need user location to personalize the weather response",
        expectedValue: "User's home location and preferences",
        evidenceRefs: ["prior-profile-001"],
        grade: "necessary",
      },
      // call-3: search_docs — no user_message establishes intent for a docs search → REJECT (R2)
      {
        id: "call-3",
        toolName: "search_docs",
        arguments: { query: "NYC weather patterns historical data" },
        justification: "Historical weather data would provide useful context for the user",
        expectedValue: "Historical weather records for New York City",
        evidenceRefs: [],    // no evidence that user wanted docs
        grade: "necessary",
      },
    ],
  };

  for (const u of proposal.units) {
    label(`  ${u.id} [${u.toolName}, ${u.grade}]`, u.justification);
  }

  // ── GATE EXECUTION ─────────────────────────────────────────────────────────

  subsep("GATE EXECUTION");

  const result = await gate.admit(proposal, supportPool);
  const context = gate.render(result, supportPool);
  const expl = gate.explain(result);

  // ── OUTPUT ─────────────────────────────────────────────────────────────────

  subsep("OUTPUT: gate results");

  console.log("\n  Admitted:");
  for (const u of result.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.toolName);
    if (u.status === "downgraded") {
      const ann = u.evaluationResults[0]?.annotations as any;
      label("    note", ann?.note);
    }
  }

  console.log("\n  Rejected:");
  for (const u of result.rejectedUnits) {
    const ann = u.evaluationResults[0]?.annotations as any;
    label(`  ${u.unitId} [${u.evaluationResults[0]?.reasonCode}]`, u.unit.toolName);
    if (ann?.note) label("    note", ann.note);
    if (ann?.existingResultId) label("    existing result", ann.existingResultId);
  }

  console.log();
  label("totalUnits", expl.totalUnits);
  label("approved", expl.approved);
  label("downgraded", expl.downgraded);
  label("rejected", expl.rejected);
  label("reasonCodes", expl.gateReasonCodes);

  console.log("\n  Admitted blocks for LLM:");
  for (const block of context.admittedBlocks) {
    label(`  ${block.sourceId}`, block.content);
  }

  // ── ASSERTIONS ─────────────────────────────────────────────────────────────

  subsep("ASSERTIONS");

  // call-1: get_weather — user asked for it explicitly → approved
  const call1 = result.admittedUnits.find(u => u.unitId === "call-1");
  assert.ok(call1, "call-1 should be admitted");
  assert.equal(call1.status, "approved");
  pass("call-1 (get_weather) approved — user_message establishes intent");

  // call-2: fetch_user_profile — prior_result already exists → rejected REDUNDANT_CALL
  const call2 = result.rejectedUnits.find(u => u.unitId === "call-2");
  assert.ok(call2, "call-2 should be rejected");
  assert.equal(call2.evaluationResults[0]?.reasonCode, "REDUNDANT_CALL");
  const call2Ann = call2.evaluationResults[0]?.annotations as any;
  assert.equal(call2Ann?.existingResultId, "prior-profile-001");
  pass("call-2 (fetch_user_profile) rejected (REDUNDANT_CALL — prior_result already in pool)");

  // call-3: search_docs — no user_message evidence → rejected INTENT_NOT_ESTABLISHED
  const call3 = result.rejectedUnits.find(u => u.unitId === "call-3");
  assert.ok(call3, "call-3 should be rejected");
  assert.equal(call3.evaluationResults[0]?.reasonCode, "INTENT_NOT_ESTABLISHED");
  pass("call-3 (search_docs) rejected (INTENT_NOT_ESTABLISHED — no user_message in evidence)");

  assert.equal(expl.approved, 1);
  assert.equal(expl.rejected, 2);
  assert.equal(expl.downgraded, 0);
  pass("summary: 1 approved, 2 rejected, 0 downgraded");

  // Only 1 block in verified context (call-1)
  assert.equal(context.admittedBlocks.length, 1);
  assert.ok(context.admittedBlocks[0].content.includes("get_weather"));
  pass("VerifiedContext contains exactly 1 admitted block (get_weather)");

  // Instructions guide LLM to not execute rejected calls
  assert.ok(context.instructions?.includes("must NOT be executed"));
  pass("VerifiedContext.instructions forbids executing rejected calls");

  // ── WEAK JUSTIFICATION SCENARIO ────────────────────────────────────────────
  //
  // An assistant proposes a tool call with a generic justification.
  // Even if the user_message is present, the call should be downgraded.

  sep("Scenario — Tool call with generic justification");

  const weakJustPool: SupportRef[] = [
    {
      id: "ref-wj-1",
      sourceId: "msg-002",
      sourceType: "observation",
      attributes: {
        contextId: "msg-002",
        type: "user_message",
        content: "Can you check my order status?",
      } satisfies CallContextAttrs,
    },
  ];

  const weakJustProposal: Proposal<ToolCallProposal> = {
    id: "prop-tool-002",
    kind: "plan",
    units: [
      // No expectedValue stated — MISSING_EXPECTED_VALUE → downgrade
      {
        id: "call-4",
        toolName: "retrieve_inventory",
        arguments: { productId: "PROD-123" },
        justification: "User asked about order status, check inventory for fulfillment context",
        expectedValue: "",   // empty
        evidenceRefs: ["msg-002"],
        grade: "necessary",
      },
      // Generic justification — WEAK_JUSTIFICATION → downgrade
      {
        id: "call-5",
        toolName: "get_weather",
        arguments: { location: "user_location" },
        justification: "to help the user",  // generic
        expectedValue: "Current weather",
        evidenceRefs: ["msg-002"],
        grade: "necessary",
      },
    ],
  };

  const weakResult = await gate.admit(weakJustProposal, weakJustPool);
  const weakExpl = gate.explain(weakResult);

  subsep("OUTPUT: weak-justification gate results");
  for (const u of weakResult.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.evaluationResults[0]?.reasonCode);
    const ann = u.evaluationResults[0]?.annotations as any;
    if (ann?.note) label("    note", ann.note);
  }
  label("approved", weakExpl.approved);
  label("downgraded", weakExpl.downgraded);
  label("rejected", weakExpl.rejected);

  subsep("ASSERTIONS");

  const call4 = weakResult.admittedUnits.find(u => u.unitId === "call-4");
  assert.ok(call4, "call-4 should be admitted");
  assert.equal(call4.status, "downgraded");
  assert.equal(call4.evaluationResults[0]?.reasonCode, "MISSING_EXPECTED_VALUE");
  pass("call-4 downgraded (MISSING_EXPECTED_VALUE)");

  const call5 = weakResult.admittedUnits.find(u => u.unitId === "call-5");
  assert.ok(call5, "call-5 should be admitted");
  assert.equal(call5.status, "downgraded");
  assert.equal(call5.evaluationResults[0]?.reasonCode, "WEAK_JUSTIFICATION");
  pass("call-5 downgraded (WEAK_JUSTIFICATION — 'to help the user' is generic)");

  assert.equal(weakExpl.downgraded, 2);
  assert.equal(weakExpl.rejected, 0);
  pass("all 2 calls downgraded, none rejected");

  console.log("\n  Done.\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
