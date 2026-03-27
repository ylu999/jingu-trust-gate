/**
 * aha-moment-demo
 *
 * This is not an API demo.
 * It is an argument.
 *
 * Run: npm run demo:aha
 *
 * Two scenarios. Two failure modes.
 *
 *   A — Agent does things you never asked for
 *   B — System remembers things you never said
 *
 * Each scenario shows what happens without a gate first.
 * Then shows what the gate does about it.
 * The point lands in the gap between those two.
 */

import assert from "node:assert/strict";
import { createTrustGate } from "../src/trust-gate.js";
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
// Helpers
// ---------------------------------------------------------------------------

function noopAudit(): AuditWriter {
  return { append: async (_: AuditEntry) => {} };
}

const FAST = process.env.AHA_FAST === "1"; // set AHA_FAST=1 to skip delays in tests

function pause(ms: number): Promise<void> {
  if (FAST) return Promise.resolve();
  return new Promise(r => setTimeout(r, ms));
}

function ln(s = "")       { console.log(s); }
function eq()             { ln("  " + "─".repeat(58)); }
function section(s: string) {
  ln();
  ln("  " + "═".repeat(58));
  ln(`  ${s}`);
  ln("  " + "═".repeat(58));
  ln();
}
function sub(s: string)   { ln(); eq(); ln(`  ${s}`); eq(); ln(); }
function ok(s: string)    { ln(`  ✓  ${s}`); }
function no(s: string)    { ln(`  ✗  ${s}`); }
function arrow(s: string) { ln(`  →  ${s}`); }
function warn(s: string)  { ln(`  ❗ ${s}`); }

// ---------------------------------------------------------------------------
// Scenario A — Agent does things you never asked for
// ---------------------------------------------------------------------------

type ActionUnit = {
  id: string;
  name: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  isReversible: boolean;
  evidenceRefs: string[];
};

class ActionGatePolicy implements GatePolicy<ActionUnit> {
  validateStructure(p: Proposal<ActionUnit>): StructureValidationResult {
    return { kind: "structure", valid: p.units.length > 0, errors: [] };
  }
  bindSupport(unit: ActionUnit, pool: SupportRef[]): UnitWithSupport<ActionUnit> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  }
  evaluateUnit({ unit, supportRefs }: UnitWithSupport<ActionUnit>): UnitEvaluationResult {
    const hasRequest = supportRefs.some(
      s => (s.attributes as { type: string })?.type === "explicit_request"
    );
    if (!hasRequest) return reject(unit.id, "INTENT_NOT_ESTABLISHED");
    if (unit.riskLevel === "high" && !unit.isReversible) {
      const hasConfirm = supportRefs.some(
        s => (s.attributes as { type: string })?.type === "user_confirmation"
      );
      if (!hasConfirm) return reject(unit.id, "CONFIRM_REQUIRED");
    }
    return approve(unit.id);
  }
  detectConflicts(): ConflictAnnotation[] { return []; }
  render(admitted: AdmittedUnit<ActionUnit>[]): VerifiedContext {
    return {
      admittedBlocks: admitted.map(u => ({
        sourceId: u.unitId,
        content: (u.unit as ActionUnit).name,
      })),
      summary: { admitted: admitted.length, rejected: 0, conflicts: 0 },
      instructions: "Execute only the admitted actions.",
    };
  }
  buildRetryFeedback(results: UnitEvaluationResult[], ctx: RetryContext): RetryFeedback {
    return {
      summary: `${results.filter(r => r.decision === "reject").length} blocked`,
      errors: results.filter(r => r.decision === "reject")
        .map(r => ({ unitId: r.unitId, reasonCode: r.reasonCode })),
    };
  }
}

async function scenarioA(): Promise<void> {
  section("Scenario A — Agent does things you never asked for");

  ln('  User says:  "Order more milk."');
  await pause(600);
  ln();
  ln("  Agent proposes 3 actions:");
  await pause(400);
  ln('    order_milk              — the user asked for this');
  await pause(300);
  ln('    delete_old_list         — the agent decided on its own');
  await pause(300);
  ln('    send_notification_email — the agent decided on its own');

  await pause(1000);
  sub("Without a gate");

  ln("  The system executes all three.");
  await pause(500);
  ln();
  no("delete_old_list executed         ← no one asked for this");
  no("send_notification_email executed ← no one asked for this");
  await pause(700);
  ln();
  ln('  The user asked to order milk.');
  ln('  They also deleted a list and triggered an email.');
  ln('  They have no idea why.');

  await pause(1400);
  sub("With jingu-trust-gate");

  ln("  Evidence pool — what the user actually said:");
  ln('    req-001: explicit_request — "Order more milk"');
  ln("    (nothing about lists, nothing about emails)");
  await pause(700);

  const pool: SupportRef[] = [
    {
      id: "ref-1",
      sourceId: "req-001",
      sourceType: "observation",
      attributes: { type: "explicit_request", content: "Order more milk" },
    },
  ];

  const proposal: Proposal<ActionUnit> = {
    id: "prop-a",
    kind: "plan",
    units: [
      { id: "a1", name: "order_milk",              description: "Place grocery order",        riskLevel: "low",    isReversible: true,  evidenceRefs: ["req-001"] },
      { id: "a2", name: "delete_old_list",          description: "Delete last week's list",    riskLevel: "medium", isReversible: false, evidenceRefs: [] },
      { id: "a3", name: "send_notification_email",  description: "Email household about order",riskLevel: "low",    isReversible: false, evidenceRefs: [] },
    ],
  };

  const gate = createTrustGate({ policy: new ActionGatePolicy(), auditWriter: noopAudit() });
  const result = await gate.admit(proposal, pool);

  ln();
  await pause(500);
  for (const u of result.admittedUnits) {
    ok(`${(u.unit as ActionUnit).name.padEnd(28)} → ACCEPT`);
    await pause(200);
  }
  for (const u of result.rejectedUnits) {
    no(`${(u.unit as ActionUnit).name.padEnd(28)} → REJECT  (${u.evaluationResults[0]?.reasonCode})`);
    await pause(200);
  }

  await pause(1000);
  ln();
  ln("  The gate checked one rule: did the user ask for this?");
  ln("  No evidence → no execution.");

  assert.equal(result.admittedUnits.length, 1);
  assert.equal(result.rejectedUnits.length, 2);
}

// ---------------------------------------------------------------------------
// Scenario B — System remembers things you never said
// ---------------------------------------------------------------------------

type MemoryWrite = {
  id: string;
  key: string;
  value: string;
  evidenceRefs: string[];
};

class MemoryGatePolicy implements GatePolicy<MemoryWrite> {
  validateStructure(p: Proposal<MemoryWrite>): StructureValidationResult {
    return { kind: "structure", valid: p.units.length > 0, errors: [] };
  }
  bindSupport(unit: MemoryWrite, pool: SupportRef[]): UnitWithSupport<MemoryWrite> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  }
  evaluateUnit({ unit, supportRefs }: UnitWithSupport<MemoryWrite>): UnitEvaluationResult {
    const hasStatement = supportRefs.some(s => s.sourceType === "user_statement");
    if (!hasStatement) return reject(unit.id, "INFERRED_NOT_STATED");
    const verbatim = supportRefs.some(
      s => s.sourceType === "user_statement" &&
           typeof s.attributes?.content === "string" &&
           (s.attributes.content as string).toLowerCase().includes(unit.value.toLowerCase())
    );
    if (!verbatim) return downgrade(unit.id, "VALUE_NOT_VERBATIM", "inferred");
    return approve(unit.id);
  }
  detectConflicts(): ConflictAnnotation[] { return []; }
  render(admitted: AdmittedUnit<MemoryWrite>[]): VerifiedContext {
    return {
      admittedBlocks: admitted.map(u => ({
        sourceId: u.unitId,
        content: `${(u.unit as MemoryWrite).key} = "${(u.unit as MemoryWrite).value}"`,
      })),
      summary: { admitted: admitted.length, rejected: 0, conflicts: 0 },
      instructions: "Write only the verified facts to system state.",
    };
  }
  buildRetryFeedback(results: UnitEvaluationResult[], ctx: RetryContext): RetryFeedback {
    return {
      summary: `${results.filter(r => r.decision === "reject").length} writes blocked`,
      errors: results.filter(r => r.decision === "reject")
        .map(r => ({ unitId: r.unitId, reasonCode: r.reasonCode })),
    };
  }
}

async function scenarioB(): Promise<void> {
  section("Scenario B — System remembers things you never said");

  ln('  User says:  "We\'re running low on milk."');
  await pause(600);
  ln();
  ln("  LLM proposes 3 memory writes:");
  await pause(500);
  ln('    milk_stock          = "low"    — the user said this');
  await pause(400);
  ln('    user_prefers_brand  = "Oatly"  — seems reasonable');
  await pause(400);
  ln('    weekly_budget       = "$50"    — seems helpful');

  await pause(1200);
  ln();
  warn('Looks reasonable... right?');
  await pause(1000);
  ln();
  ln('  But the user never mentioned Oatly.');
  ln('  The user never mentioned $50.');
  ln('  The model guessed — confidently, silently.');

  await pause(1400);
  sub("Without a gate");

  ln("  All three writes reach the database.");
  await pause(600);
  ln();
  ln("  The system now treats these as facts:");
  no('user_prefers_brand = "Oatly"   ← never said');
  no('weekly_budget = "$50"          ← never said');
  await pause(700);
  ln();
  ln("  These will affect:");
  arrow("every future shopping recommendation  → always suggests Oatly");
  arrow("auto-generated shopping lists         → filtered by $50 budget");
  arrow("every RAG retrieval that follows      → wrong facts in context");
  await pause(800);
  ln();
  warn("The model made two guesses. Both became permanent system facts.");
  warn("There is no automatic correction.");
  warn("The system is drifting away from the user's actual reality.");

  await pause(1800);
  sub("With jingu-trust-gate");

  ln("  Evidence pool — what the user actually said:");
  ln('    stmt-1: user_statement — "We\'re running low on milk"');
  ln("    (nothing about brand preferences, nothing about budget)");
  await pause(700);

  const pool: SupportRef[] = [
    {
      id: "ref-stmt-1",
      sourceId: "stmt-1",
      sourceType: "user_statement",
      attributes: { content: "We're running low on milk" },
    },
  ];

  const proposal: Proposal<MemoryWrite> = {
    id: "prop-b",
    kind: "mutation",
    units: [
      { id: "w1", key: "milk_stock",         value: "low",   evidenceRefs: ["stmt-1"] },
      { id: "w2", key: "user_prefers_brand",  value: "Oatly", evidenceRefs: [] },
      { id: "w3", key: "weekly_budget",       value: "$50",   evidenceRefs: [] },
    ],
  };

  const gate = createTrustGate({ policy: new MemoryGatePolicy(), auditWriter: noopAudit() });
  const result = await gate.admit(proposal, pool);
  const context = gate.render(result);

  ln();
  await pause(500);
  for (const b of context.admittedBlocks) {
    ok(`${(b.content as string).padEnd(38)} → written to state`);
    await pause(200);
  }
  for (const u of result.rejectedUnits) {
    const key = (u.unit as MemoryWrite).key;
    const val = (u.unit as MemoryWrite).value;
    no(`${(key + ' = "' + val + '"').padEnd(38)} → REJECT  (${u.evaluationResults[0]?.reasonCode})`);
    await pause(200);
  }

  await pause(1000);
  ln();
  ln("  State after gate:");
  ln('    { "milk_stock": "low" }');
  ln();
  ln("  The two hallucinated facts do not exist in storage.");
  ln("  They cannot corrupt future queries.");
  ln("  The system's memory reflects only what the user actually said.");

  assert.equal(result.admittedUnits.length, 1);
  assert.equal(result.rejectedUnits.length, 2);
  assert.equal(result.rejectedUnits[0].evaluationResults[0].reasonCode, "INFERRED_NOT_STATED");
  assert.equal(result.rejectedUnits[1].evaluationResults[0].reasonCode, "INFERRED_NOT_STATED");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const W = "═".repeat(60);

  ln();
  ln("  " + W);
  ln("  jingu-trust-gate — aha-moment-demo");
  ln();
  ln("  Two scenarios. Two failure modes. One fix.");
  ln();
  ln("  A — Agent does things you never asked for");
  ln("  B — System remembers things you never said");
  ln();
  ln("  B is the one that should make you uncomfortable.");
  ln("  " + W);

  await scenarioA();
  await pause(1000);
  await scenarioB();

  await pause(800);
  ln();
  ln("  " + W);
  ln("  The shift");
  ln();
  ln("  Without jingu-trust-gate:");
  ln("    LLM output  →  system state");
  ln();
  ln("  With jingu-trust-gate:");
  ln("    LLM output  →  gate (deterministic check)  →  system state");
  ln();
  ln("  The gate does not make the model smarter.");
  ln("  It makes the system honest about what it actually knows.");
  ln();
  ln("  AI can propose anything.");
  ln("  Only verified results are accepted.");
  ln("  " + W);
  ln();
}

main().catch(err => {
  console.error("\nDemo failed:", err);
  process.exit(1);
});
