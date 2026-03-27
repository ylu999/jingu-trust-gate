/**
 * FileAuditWriter — audit logging integration for jingu-trust-gate.
 *
 * Every gate admission is written to an append-only JSONL audit log.
 * This is Law 3 of jingu-trust-gate: "Every admission is audited."
 *
 * This example shows how to wire FileAuditWriter (the built-in production
 * audit writer) into the gate, and how to read the resulting JSONL log.
 *
 * In contrast to examples that use NoopAuditWriter, this example writes to
 * a real file. Each AuditEntry records: proposalId, timestamp, unit counts,
 * reason codes, and the full list of admitted/rejected unit IDs — giving you
 * a reproducible record of every gate decision.
 *
 * Run:
 *   npm run build && node dist/examples/integration/audit-writer-example.js
 *
 * Output:
 *   .jingu-trust-gate/audit.jsonl  (append-only, created in cwd)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTrustGate, FileAuditWriter } from "../../src/trust-gate.js";
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
import type { AuditEntry } from "../../src/types/audit.js";
import { approve, reject, firstFailing } from "../../src/helpers/index.js";

// ── Minimal domain type for this example ──────────────────────────────────────

type SimpleClaim = {
  id: string;
  text: string;
  grade: "proven" | "speculative";
  evidenceRefs: string[];
};

// ── Minimal policy ─────────────────────────────────────────────────────────────

class SimplePolicy implements GatePolicy<SimpleClaim> {

  validateStructure(proposal: Proposal<SimpleClaim>): StructureValidationResult {
    return {
      kind: "structure",
      valid: proposal.units.length > 0,
      errors: proposal.units.length === 0
        ? [{ field: "units", reasonCode: "EMPTY_PROPOSAL" }]
        : [],
    };
  }

  bindSupport(unit: SimpleClaim, pool: SupportRef[]): UnitWithSupport<SimpleClaim> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  }

  evaluateUnit(
    uws: UnitWithSupport<SimpleClaim>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    return firstFailing([
      uws.unit.grade === "proven" && uws.supportIds.length === 0
        ? reject(uws.unit.id, "MISSING_EVIDENCE")
        : undefined,
    ]) ?? approve(uws.unit.id);
  }

  detectConflicts(_u: UnitWithSupport<SimpleClaim>[], _p: SupportRef[]): ConflictAnnotation[] {
    return [];
  }

  render(admittedUnits: AdmittedUnit<SimpleClaim>[], _pool: SupportRef[], _ctx: RenderContext): VerifiedContext {
    return {
      admittedBlocks: admittedUnits.map(u => ({
        sourceId: u.unitId,
        content: (u.unit as SimpleClaim).text,
        grade: (u.unit as SimpleClaim).grade,
      })),
      summary: { admitted: admittedUnits.length, rejected: 0, conflicts: 0 },
    };
  }

  buildRetryFeedback(unitResults: UnitEvaluationResult[], _ctx: RetryContext): RetryFeedback {
    return {
      summary: `${unitResults.filter(r => r.decision === "reject").length} rejected`,
      errors: [],
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // FileAuditWriter writes to .jingu-trust-gate/audit.jsonl in cwd.
  // The directory is created automatically on first write.
  const auditWriter = new FileAuditWriter();

  const gate = createTrustGate({
    policy: new SimplePolicy(),
    auditWriter,
  });

  const supportPool: SupportRef[] = [
    { id: "ref-1", sourceId: "doc-1", sourceType: "observation", attributes: {} },
  ];

  // Admission 1: 1 approved, 1 rejected
  const proposal1: Proposal<SimpleClaim> = {
    id: "prop-audit-001",
    kind: "response",
    units: [
      { id: "c1", text: "Fact with evidence", grade: "proven", evidenceRefs: ["doc-1"] },
      { id: "c2", text: "Hallucinated fact",  grade: "proven", evidenceRefs: [] },
    ],
  };

  const result1 = await gate.admit(proposal1, supportPool);
  const expl1 = gate.explain(result1);

  console.log(`Admission 1: approved=${expl1.approved}, rejected=${expl1.rejected}`);
  assert.equal(expl1.approved, 1);
  assert.equal(expl1.rejected, 1);

  // Admission 2: 2 approved
  const proposal2: Proposal<SimpleClaim> = {
    id: "prop-audit-002",
    kind: "response",
    units: [
      { id: "c3", text: "Another fact", grade: "proven", evidenceRefs: ["doc-1"] },
      { id: "c4", text: "Speculative note", grade: "speculative", evidenceRefs: [] },
    ],
  };

  const result2 = await gate.admit(proposal2, supportPool);
  const expl2 = gate.explain(result2);

  console.log(`Admission 2: approved=${expl2.approved}, rejected=${expl2.rejected}`);
  assert.equal(expl2.approved, 2);
  assert.equal(expl2.rejected, 0);

  // ── Read and verify the audit log ───────────────────────────────────────────

  const auditPath = path.join(process.cwd(), ".jingu-trust-gate", "audit.jsonl");

  // Give the writer a moment to flush (it's async append)
  await new Promise(r => setTimeout(r, 50));

  assert.ok(fs.existsSync(auditPath), `Audit log should exist at ${auditPath}`);

  const lines = fs.readFileSync(auditPath, "utf8")
    .split("\n")
    .filter(l => l.trim() !== "");

  // At minimum the two new entries should be there (file may have prior runs)
  assert.ok(lines.length >= 2, "Audit log should have at least 2 entries");

  // Parse the last two entries (most recent run)
  const entries: AuditEntry[] = lines.slice(-2).map(l => JSON.parse(l));

  const entry1 = entries.find(e => e.proposalId === "prop-audit-001");
  const entry2 = entries.find(e => e.proposalId === "prop-audit-002");

  assert.ok(entry1, "Entry for prop-audit-001 should be in audit log");
  assert.equal(entry1.approvedCount, 1, "entry1 should record 1 approved");
  assert.equal(entry1.rejectedCount, 1, "entry1 should record 1 rejected");
  assert.ok(entry1.gateReasonCodes.includes("MISSING_EVIDENCE"), "entry1 should record reason code");

  assert.ok(entry2, "Entry for prop-audit-002 should be in audit log");
  assert.equal(entry2.approvedCount, 2, "entry2 should record 2 approved");
  assert.equal(entry2.rejectedCount, 0, "entry2 should record 0 rejected");

  console.log(`\nAudit log: ${auditPath}`);
  console.log(`Total entries in log: ${lines.length}`);
  console.log("\nLast 2 entries:");
  for (const entry of entries) {
    console.log(
      `  ${entry.proposalId}  approved=${entry.approvedCount}  rejected=${entry.rejectedCount}` +
      `  codes=${JSON.stringify(entry.gateReasonCodes)}  ts=${entry.timestamp}`
    );
  }

  console.log("\n  [PASS] FileAuditWriter writes JSONL entries to .jingu-trust-gate/audit.jsonl");
  console.log("  [PASS] Each entry records proposalId, counts, reason codes, and timestamp");
  console.log("  [PASS] Log is append-only — entries accumulate across runs\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
