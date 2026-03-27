/**
 * Personal memory write gate — state mutation policy for jingu-trust-gate.
 *
 * Use case: a personal assistant proposes updates to a user's memory store
 * (preferences, facts the user has stated, contact info, recurring tasks).
 * Before any write reaches system state, the gate verifies that every proposed
 * fact was actually stated by the user — not inferred, hallucinated, or carried
 * over from a different user's session.
 *
 * This is the "state" gating pattern: the gate controls what is allowed to be
 * written into persistent state, not just what is included in an LLM response.
 *
 * Domain types
 *   MemoryWrite       — one proposed write to the memory store
 *   MemoryEvidence    — shape of SupportRef.attributes for user statements
 *
 * Gate rules (evaluateUnit)
 *   R1  no "user_statement" evidence at all                   → SOURCE_UNVERIFIED   → reject
 *   R2  value was inferred, not stated directly               → INFERRED_NOT_STATED → downgrade to "inferred"
 *   R3  write targets a different userId than evidence source → SCOPE_VIOLATION     → reject
 *   R4  everything else                                       → approve
 *
 * Key idea:
 *   source_type = "user_statement" represents something the user explicitly said.
 *   An LLM may propose writes that "seem reasonable" but were never actually stated.
 *   The gate blocks those writes at the boundary — they never reach the memory store.
 *
 * Run:
 *   npm run build && node dist/examples/state/memory-update-policy.js
 */

import assert from "node:assert/strict";
import { createTrustGate } from "../../src/trust-gate.js";
import type { GatePolicy } from "../../src/types/policy.js";
import type { Proposal } from "../../src/types/proposal.js";
import type { SupportRef, UnitWithSupport } from "../../src/types/support.js";
import type {
  StructureValidationResult,
  UnitEvaluationResult,
  ConflictAnnotation,
} from "../../src/types/gate.js";
import type { AdmittedUnit } from "../../src/types/admission.js";
import type { VerifiedContext, RenderContext } from "../../src/types/renderer.js";
import type { RetryFeedback, RetryContext } from "../../src/types/retry.js";
import type { AuditEntry, AuditWriter } from "../../src/types/audit.js";
import { approve, reject, downgrade, firstFailing } from "../../src/helpers/index.js";

// ── Domain types ──────────────────────────────────────────────────────────────

type WriteGrade = "stated" | "inferred" | "system";

type MemoryWrite = {
  id: string;
  userId: string;           // which user's memory store this targets
  key: string;              // memory key, e.g. "preferred_language", "dietary_restriction"
  value: string;            // proposed value to write
  grade: WriteGrade;        // "stated" = user said it directly; "inferred" = agent derived it
  justification: string;    // why the agent proposes this write
  evidenceRefs: string[];   // sourceIds of user_statement refs supporting this write
};

// Shape of SupportRef.attributes for user statements
type MemoryEvidence = {
  userId: string;
  type: "user_statement" | "prior_memory" | "session_context";
  content: string;          // what the user actually said
  sessionId: string;
};

// ── Policy ────────────────────────────────────────────────────────────────────

class MemoryUpdatePolicy implements GatePolicy<MemoryWrite> {

  validateStructure(proposal: Proposal<MemoryWrite>): StructureValidationResult {
    const errors: StructureValidationResult["errors"] = [];

    if (proposal.units.length === 0) {
      errors.push({ field: "units", reasonCode: "EMPTY_PROPOSAL" });
      return { kind: "structure", valid: false, errors };
    }

    for (const unit of proposal.units) {
      if (!unit.id?.trim()) {
        errors.push({ field: "id", reasonCode: "MISSING_UNIT_ID" });
      }
      if (!unit.key?.trim()) {
        errors.push({ field: "key", reasonCode: "MISSING_KEY", message: `unit ${unit.id}` });
      }
      if (!unit.userId?.trim()) {
        errors.push({ field: "userId", reasonCode: "MISSING_USER_ID", message: `unit ${unit.id}` });
      }
      if (!Array.isArray(unit.evidenceRefs)) {
        errors.push({ field: "evidenceRefs", reasonCode: "MISSING_EVIDENCE_REFS", message: `unit ${unit.id}` });
      }
    }

    return { kind: "structure", valid: errors.length === 0, errors };
  }

  bindSupport(unit: MemoryWrite, pool: SupportRef[]): UnitWithSupport<MemoryWrite> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return {
      unit,
      supportIds: matched.map(s => s.id),
      supportRefs: matched,
    };
  }

  evaluateUnit(
    uws: UnitWithSupport<MemoryWrite>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    return firstFailing([
      this.#checkSource(uws),
      this.#checkScope(uws),
      this.#checkInferred(uws),
    ]) ?? approve(uws.unit.id);
  }

  // R1: at least one piece of evidence must be a direct user_statement.
  // prior_memory or session_context alone does not justify a new write.
  #checkSource({ unit, supportRefs }: UnitWithSupport<MemoryWrite>) {
    const hasUserStatement = supportRefs.some(s => {
      const attrs = s.attributes as MemoryEvidence | undefined;
      return attrs?.type === "user_statement";
    });
    if (!hasUserStatement) {
      return reject(unit.id, "SOURCE_UNVERIFIED", {
        key: unit.key,
        note: `No user_statement evidence for "${unit.key}=${unit.value}". ` +
              `Memory writes require the user to have explicitly stated the value.`,
      });
    }
    return undefined;
  }

  // R3: the evidence must belong to the same user as the write target.
  // Guards against cross-user contamination when sessions share a pool.
  #checkScope({ unit, supportRefs }: UnitWithSupport<MemoryWrite>) {
    const wrongUser = supportRefs.find(s => {
      const attrs = s.attributes as MemoryEvidence | undefined;
      return attrs?.userId !== undefined && attrs.userId !== unit.userId;
    });
    if (wrongUser) {
      const attrs = wrongUser.attributes as MemoryEvidence;
      return reject(unit.id, "SCOPE_VIOLATION", {
        targetUserId: unit.userId,
        evidenceUserId: attrs.userId,
        note: `Evidence userId "${attrs.userId}" does not match write target userId "${unit.userId}"`,
      });
    }
    return undefined;
  }

  // R2: grade=stated but the evidence only supports an inference, not a direct quote.
  // Downgrade to "inferred" so the memory store can track provenance.
  #checkInferred({ unit, supportRefs }: UnitWithSupport<MemoryWrite>) {
    if (unit.grade === "stated") {
      // All user_statement refs must contain the value or a close variant.
      // Heuristic: if the value string doesn't appear in any statement content, it was inferred.
      const statedRefs = supportRefs.filter(s => {
        const attrs = s.attributes as MemoryEvidence | undefined;
        return attrs?.type === "user_statement";
      });
      const valueAppearsInStatement = statedRefs.some(s => {
        const attrs = s.attributes as MemoryEvidence;
        return attrs.content.toLowerCase().includes(unit.value.toLowerCase());
      });
      if (!valueAppearsInStatement) {
        return downgrade(unit.id, "INFERRED_NOT_STATED", "inferred", {
          key: unit.key,
          proposedValue: unit.value,
          note: `Value "${unit.value}" does not appear verbatim in user statements. ` +
                `Downgraded to grade="inferred" — memory store should mark provenance accordingly.`,
        });
      }
    }
    return undefined;
  }

  detectConflicts(
    _units: UnitWithSupport<MemoryWrite>[],
    _pool: SupportRef[]
  ): ConflictAnnotation[] {
    return [];
  }

  render(
    admittedUnits: AdmittedUnit<MemoryWrite>[],
    _pool: SupportRef[],
    _ctx: RenderContext
  ): VerifiedContext {
    const admittedBlocks = admittedUnits.map(u => {
      const write = u.unit as MemoryWrite;
      const currentGrade = u.appliedGrades[u.appliedGrades.length - 1] ?? write.grade;
      return {
        sourceId: u.unitId,
        content: `SET ${write.userId}::${write.key} = "${write.value}"`,
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
        rejected: 0,
        conflicts: 0,
      },
      instructions:
        "Apply only the verified memory writes below. " +
        "Writes with grade=\"inferred\" should be stored with a provenance flag " +
        "indicating the value was derived, not directly stated by the user. " +
        "Never write a rejected entry — it was not verified as user-stated.",
    };
  }

  buildRetryFeedback(
    unitResults: UnitEvaluationResult[],
    ctx: RetryContext
  ): RetryFeedback {
    const failed = unitResults.filter(r => r.decision === "reject");
    return {
      summary:
        `${failed.length} memory write(s) rejected on attempt ${ctx.attempt}/${ctx.maxRetries}. ` +
        `Each write must be traceable to a direct user statement.`,
      errors: failed.map(r => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: {
          hint: r.reasonCode === "SOURCE_UNVERIFIED"
            ? "Add a user_statement SupportRef containing the user's direct quote"
            : r.reasonCode === "SCOPE_VIOLATION"
            ? "Ensure evidence userId matches the write target userId"
            : "Review gate policy requirements",
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
  console.log(`    ${key.padEnd(30)}: ${JSON.stringify(value)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const gate = createTrustGate({
    policy: new MemoryUpdatePolicy(),
    auditWriter: noopAuditWriter(),
  });

  // ── Scenario A: A user says "I'm vegetarian" and "I prefer dark mode" ───────
  //
  // The assistant proposes 3 memory writes:
  //   - dietary_restriction=vegetarian  (user stated it directly → approve)
  //   - ui_theme=dark                   (user stated "dark mode" → approve)
  //   - notification_pref=email         (never stated — agent inferred it → SOURCE_UNVERIFIED → reject)

  sep("Scenario A — User: 'I'm vegetarian and I prefer dark mode'");
  subsep("INPUT: user statement evidence pool");

  const userId = "user-42";

  const poolA: SupportRef[] = [
    {
      id: "ref-stmt-1",
      sourceId: "stmt-001",
      sourceType: "observation",
      attributes: {
        userId,
        type: "user_statement",
        content: "I'm vegetarian, so please keep that in mind for meal suggestions.",
        sessionId: "session-abc",
      } satisfies MemoryEvidence,
    },
    {
      id: "ref-stmt-2",
      sourceId: "stmt-002",
      sourceType: "observation",
      attributes: {
        userId,
        type: "user_statement",
        content: "By the way, I always use dark mode on all my apps.",
        sessionId: "session-abc",
      } satisfies MemoryEvidence,
    },
  ];

  console.log("\n  User statements:");
  for (const ref of poolA) {
    const attrs = ref.attributes as MemoryEvidence;
    label(`  ${ref.sourceId}`, attrs.content);
  }

  const proposalA: Proposal<MemoryWrite> = {
    id: "prop-mem-001",
    kind: "response",
    units: [
      // write-1: dietary_restriction — user stated "I'm vegetarian" directly → APPROVE
      {
        id: "write-1",
        userId,
        key: "dietary_restriction",
        value: "vegetarian",
        grade: "stated",
        justification: "User explicitly stated they are vegetarian in this session",
        evidenceRefs: ["stmt-001"],
      },
      // write-2: ui_theme — user stated "I always use dark mode" → APPROVE
      {
        id: "write-2",
        userId,
        key: "ui_theme",
        value: "dark",
        grade: "stated",
        justification: "User explicitly stated they prefer dark mode on all apps",
        evidenceRefs: ["stmt-002"],
      },
      // write-3: notification_pref — never stated, agent assumed email preference → REJECT (SOURCE_UNVERIFIED)
      {
        id: "write-3",
        userId,
        key: "notification_pref",
        value: "email",
        grade: "stated",
        justification: "User seems to prefer email-based communication based on context",
        evidenceRefs: [],   // no evidence — inference only
      },
    ],
  };

  subsep("GATE EXECUTION");

  const resultA = await gate.admit(proposalA, poolA);
  const contextA = gate.render(resultA, poolA);
  const explA = gate.explain(resultA);

  subsep("OUTPUT: gate results");

  console.log("\n  Admitted writes:");
  for (const u of resultA.admittedUnits) {
    const write = u.unit as MemoryWrite;
    label(`  ${u.unitId} [${u.status}]`, `${write.key} = "${write.value}"`);
  }

  console.log("\n  Rejected writes:");
  for (const u of resultA.rejectedUnits) {
    const write = u.unit as MemoryWrite;
    label(`  ${u.unitId} [${u.evaluationResults[0]?.reasonCode}]`, `${write.key} = "${write.value}"`);
    const ann = u.evaluationResults[0]?.annotations as any;
    if (ann?.note) label("    note", ann.note);
  }

  console.log();
  label("approved", explA.approved);
  label("downgraded", explA.downgraded);
  label("rejected", explA.rejected);

  console.log("\n  Verified writes for memory store:");
  for (const block of contextA.admittedBlocks) {
    label(`  ${block.sourceId}`, block.content);
  }

  subsep("ASSERTIONS");

  const w1 = resultA.admittedUnits.find(u => u.unitId === "write-1");
  assert.ok(w1, "write-1 should be admitted");
  assert.equal(w1.status, "approved");
  pass("write-1 (dietary_restriction=vegetarian) approved — user explicitly stated it");

  const w2 = resultA.admittedUnits.find(u => u.unitId === "write-2");
  assert.ok(w2, "write-2 should be admitted");
  assert.equal(w2.status, "approved");
  pass("write-2 (ui_theme=dark) approved — user explicitly stated dark mode preference");

  const w3 = resultA.rejectedUnits.find(u => u.unitId === "write-3");
  assert.ok(w3, "write-3 should be rejected");
  assert.equal(w3.evaluationResults[0]?.reasonCode, "SOURCE_UNVERIFIED");
  pass("write-3 (notification_pref=email) rejected (SOURCE_UNVERIFIED — never stated by user)");

  assert.equal(explA.approved, 2);
  assert.equal(explA.rejected, 1);
  pass("summary: 2 approved, 1 rejected");

  // ── Scenario B: Agent infers a value not literally stated ───────────────────
  //
  // User says "I work best in the morning" — the agent proposes writing
  // preferred_work_hours=06:00-10:00. The value is inferred, not stated.
  // Gate downgrades grade from "stated" → "inferred".

  sep("Scenario B — Agent infers work hours from 'I work best in the morning'");

  const poolB: SupportRef[] = [
    {
      id: "ref-stmt-3",
      sourceId: "stmt-003",
      sourceType: "observation",
      attributes: {
        userId,
        type: "user_statement",
        content: "I work best in the morning when I have a clear head.",
        sessionId: "session-abc",
      } satisfies MemoryEvidence,
    },
  ];

  const proposalB: Proposal<MemoryWrite> = {
    id: "prop-mem-002",
    kind: "response",
    units: [
      // write-4: preferred_work_hours — "06:00-10:00" was never said verbatim → DOWNGRADE to inferred
      {
        id: "write-4",
        userId,
        key: "preferred_work_hours",
        value: "06:00-10:00",
        grade: "stated",    // agent claims this was stated, but it's an inference
        justification: "User said they work best in the morning; 06:00-10:00 is a reasonable morning window",
        evidenceRefs: ["stmt-003"],
      },
    ],
  };

  const resultB = await gate.admit(proposalB, poolB);
  const explB = gate.explain(resultB);

  const w4 = resultB.admittedUnits.find(u => u.unitId === "write-4");

  label("write-4 status", w4?.status);
  label("write-4 applied grade", w4?.appliedGrades.at(-1));
  const w4Ann = w4?.evaluationResults[0]?.annotations as any;
  if (w4Ann?.note) label("note", w4Ann.note);

  subsep("ASSERTIONS");

  assert.ok(w4, "write-4 should be admitted (downgraded, not rejected)");
  assert.equal(w4.status, "downgraded");
  assert.equal(w4.appliedGrades.at(-1), "inferred");
  assert.equal(w4.evaluationResults[0]?.reasonCode, "INFERRED_NOT_STATED");
  pass("write-4 downgraded to grade=inferred (INFERRED_NOT_STATED — value not verbatim in user statement)");

  assert.equal(explB.downgraded, 1);
  assert.equal(explB.approved, 0);
  pass("summary: 0 approved, 1 downgraded — memory store will mark this as inferred provenance");

  // ── Scenario C: Cross-user scope violation ───────────────────────────────────
  //
  // Evidence belongs to user-99 but the write targets user-42.
  // Gate rejects with SCOPE_VIOLATION.

  sep("Scenario C — Cross-user scope violation");

  const poolC: SupportRef[] = [
    {
      id: "ref-stmt-4",
      sourceId: "stmt-004",
      sourceType: "observation",
      attributes: {
        userId: "user-99",   // different user!
        type: "user_statement",
        content: "I'm vegan actually, not vegetarian.",
        sessionId: "session-xyz",
      } satisfies MemoryEvidence,
    },
  ];

  const proposalC: Proposal<MemoryWrite> = {
    id: "prop-mem-003",
    kind: "response",
    units: [
      // write-5: targeting user-42 but evidence is from user-99 → SCOPE_VIOLATION → reject
      {
        id: "write-5",
        userId: "user-42",
        key: "dietary_restriction",
        value: "vegan",
        grade: "stated",
        justification: "User stated they are vegan",
        evidenceRefs: ["stmt-004"],
      },
    ],
  };

  const resultC = await gate.admit(proposalC, poolC);

  const w5 = resultC.rejectedUnits.find(u => u.unitId === "write-5");
  label("write-5 reason", w5?.evaluationResults[0]?.reasonCode);
  const w5Ann = w5?.evaluationResults[0]?.annotations as any;
  if (w5Ann?.note) label("note", w5Ann.note);

  subsep("ASSERTIONS");

  assert.ok(w5, "write-5 should be rejected");
  assert.equal(w5.evaluationResults[0]?.reasonCode, "SCOPE_VIOLATION");
  pass("write-5 rejected (SCOPE_VIOLATION — evidence userId=user-99, write target userId=user-42)");

  console.log("\n  Done.\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
