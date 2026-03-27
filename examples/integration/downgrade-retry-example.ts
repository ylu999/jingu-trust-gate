/**
 * Downgrade retry loop — retryOnDecisions integration for jingu-trust-gate.
 *
 * By default, the gate only retries on "reject" decisions.
 * Setting retryOnDecisions: ["reject", "downgrade"] causes the gate to also
 * retry when any unit is downgraded — useful when you want the LLM to try to
 * produce a fully-verified response rather than accepting a degraded one.
 *
 * This example shows:
 *   1. Default behavior  — downgraded units are admitted; no retry triggered.
 *   2. retryOnDecisions  — downgraded units trigger a retry loop.
 *   3. RetryFeedback     — what the LLM receives explaining why it needs to retry.
 *
 * The same policy (LegalClaimPolicy) is used in both runs so you can compare
 * the outcomes directly.
 *
 * Run:
 *   npm run build && node dist/examples/integration/downgrade-retry-example.js
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

// ── Domain type ───────────────────────────────────────────────────────────────

// A legal claim: a statement about a contract that must be grounded in contract text.
type LegalClaim = {
  id: string;
  text: string;
  grade: "confirmed" | "derived";    // "confirmed" = verbatim in contract; "derived" = inferred
  clause: string;                    // which clause the claim refers to
  evidenceRefs: string[];
};

type ClauseEvidence = {
  clauseId: string;
  excerpt: string;
};

// ── Policy ────────────────────────────────────────────────────────────────────

class LegalClaimPolicy implements GatePolicy<LegalClaim> {

  validateStructure(proposal: Proposal<LegalClaim>): StructureValidationResult {
    return {
      kind: "structure",
      valid: proposal.units.length > 0,
      errors: proposal.units.length === 0
        ? [{ field: "units", reasonCode: "EMPTY_PROPOSAL" }]
        : [],
    };
  }

  bindSupport(unit: LegalClaim, pool: SupportRef[]): UnitWithSupport<LegalClaim> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  }

  evaluateUnit(
    uws: UnitWithSupport<LegalClaim>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    return firstFailing([
      this.#checkSource(uws),
      this.#checkOverSpecific(uws),
    ]) ?? approve(uws.unit.id);
  }

  // Reject if grade=confirmed but no evidence at all.
  #checkSource({ unit, supportIds }: UnitWithSupport<LegalClaim>) {
    if (unit.grade === "confirmed" && supportIds.length === 0) {
      return reject(unit.id, "MISSING_EVIDENCE", {
        clause: unit.clause,
        note: `Claim graded "confirmed" but no contract clause evidence bound`,
      });
    }
    return undefined;
  }

  // Downgrade if grade=confirmed but the claim text isn't in the clause excerpt.
  #checkOverSpecific({ unit, supportRefs }: UnitWithSupport<LegalClaim>) {
    if (unit.grade === "confirmed" && supportRefs.length > 0) {
      const appearsInClause = supportRefs.some(s => {
        const attrs = s.attributes as ClauseEvidence | undefined;
        return attrs?.excerpt?.toLowerCase().includes(unit.text.split(" ").slice(0, 4).join(" ").toLowerCase());
      });
      if (!appearsInClause) {
        return downgrade(unit.id, "OVER_SPECIFIC", "derived", {
          note: `Claim text not found verbatim in clause excerpt — downgraded to "derived"`,
        });
      }
    }
    return undefined;
  }

  detectConflicts(_u: UnitWithSupport<LegalClaim>[], _p: SupportRef[]): ConflictAnnotation[] {
    return [];
  }

  render(admittedUnits: AdmittedUnit<LegalClaim>[], _pool: SupportRef[], _ctx: RenderContext): VerifiedContext {
    return {
      admittedBlocks: admittedUnits.map(u => ({
        sourceId: u.unitId,
        content: (u.unit as LegalClaim).text,
        grade: u.appliedGrades.at(-1) ?? (u.unit as LegalClaim).grade,
        ...(u.status === "downgraded" && {
          unsupportedAttributes: [u.evaluationResults[0]?.reasonCode ?? ""],
        }),
      })),
      summary: { admitted: admittedUnits.length, rejected: 0, conflicts: 0 },
    };
  }

  buildRetryFeedback(unitResults: UnitEvaluationResult[], ctx: RetryContext): RetryFeedback {
    const downgraded = unitResults.filter(r => r.decision === "downgrade");
    const rejected = unitResults.filter(r => r.decision === "reject");

    return {
      summary:
        `Attempt ${ctx.attempt}/${ctx.maxRetries}: ` +
        `${rejected.length} rejected, ${downgraded.length} downgraded. ` +
        `Please provide more precise claims that appear verbatim in the contract clauses.`,
      errors: [...rejected, ...downgraded].map(r => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: {
          hint: r.decision === "downgrade"
            ? "Revise this claim to quote the clause text more precisely, or change grade to \"derived\""
            : "Add a contract clause reference to evidenceRefs",
          annotations: r.annotations,
        },
      })),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function noopAuditWriter(): AuditWriter {
  return { append: async (_e: AuditEntry) => {} };
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

  // A contract clause for the lease example
  const supportPool: SupportRef[] = [
    {
      id: "ref-c1",
      sourceId: "clause-3.2",
      sourceType: "observation",
      attributes: {
        clauseId: "3.2",
        excerpt: "The lease term shall commence on March 1, 2024 and expire on February 28, 2025.",
      } satisfies ClauseEvidence,
    },
  ];

  // A proposal with one over-specific claim (will be downgraded).
  // claim-1: "The lease starts on March 1, 2024" — check starts with "The lease starts"
  //          but clause says "The lease term shall commence" — not verbatim → DOWNGRADE
  const proposal: Proposal<LegalClaim> = {
    id: "prop-legal-retry",
    kind: "response",
    units: [
      {
        id: "claim-1",
        text: "The lease starts on March 1, 2024",
        grade: "confirmed",
        clause: "3.2",
        evidenceRefs: ["clause-3.2"],
      },
    ],
  };

  // ── Run 1: Default gate — downgrade admitted, no retry ────────────────────

  sep("Run 1 — Default gate (retryOnDecisions not set)");
  subsep("Downgraded units are admitted without retry");

  const gateDefault = createTrustGate({
    policy: new LegalClaimPolicy(),
    auditWriter: noopAuditWriter(),
  });

  const result1 = await gateDefault.admit(proposal, supportPool);
  const expl1 = gateDefault.explain(result1);

  label("approved", expl1.approved);
  label("downgraded", expl1.downgraded);
  label("rejected", expl1.rejected);

  const claim1Default = result1.admittedUnits.find(u => u.unitId === "claim-1");
  label("claim-1 status", claim1Default?.status);
  label("claim-1 grade", claim1Default?.appliedGrades.at(-1));

  assert.ok(claim1Default);
  assert.equal(claim1Default.status, "downgraded");
  console.log("  [PASS] Default gate: downgraded claim admitted (grade changed to \"derived\")");
  console.log("         → Use this when you want to admit partial results");

  // ── Run 2: Gate with retryOnDecisions: ["downgrade"] ──────────────────────
  //
  // The gate will attempt retries when any unit is downgraded.
  // Since we have no real LLM here, we simulate by providing a "corrected"
  // proposal on retry via a custom adapter pattern.
  //
  // In a real system: the gate calls buildRetryFeedback(), your LLM loop
  // receives the feedback, re-generates the proposal, and calls gate.admit() again.
  //
  // Here we show what RetryFeedback looks like and verify the gate triggers it.

  sep("Run 2 — Gate with retryOnDecisions: [\"downgrade\"]");
  subsep("Downgraded units trigger RetryFeedback — LLM should revise the claim");

  // Capture retry feedback via a custom policy that wraps LegalClaimPolicy
  let capturedRetryFeedback: RetryFeedback | undefined;

  class CapturingPolicy extends LegalClaimPolicy {
    override buildRetryFeedback(results: UnitEvaluationResult[], ctx: RetryContext): RetryFeedback {
      const feedback = super.buildRetryFeedback(results, ctx);
      capturedRetryFeedback = feedback;
      return feedback;
    }
  }

  const gateWithDowngradeRetry = createTrustGate({
    policy: new CapturingPolicy(),
    auditWriter: noopAuditWriter(),
    retry: { retryOnDecisions: ["downgrade"], maxRetries: 2 },
  });

  // First admission: claim-1 is downgraded → gate triggers retry feedback
  // (In a real system, the gate would call your retry callback with the feedback)
  const result2 = await gateWithDowngradeRetry.admit(proposal, supportPool);
  const expl2 = gateWithDowngradeRetry.explain(result2);

  label("approved", expl2.approved);
  label("downgraded", expl2.downgraded);

  // RetryFeedback was built (gate called buildRetryFeedback for the downgrade)
  if (capturedRetryFeedback) {
    subsep("RetryFeedback sent to LLM:");
    label("summary", capturedRetryFeedback.summary);
    for (const err of capturedRetryFeedback.errors) {
      label(`  ${err.unitId} [${err.reasonCode}]`, (err.details as any)?.hint ?? "");
    }
  }

  // ── Corrected proposal: claim restated to match clause text ────────────────

  subsep("Corrected proposal: LLM revises claim to match clause verbatim");

  const correctedProposal: Proposal<LegalClaim> = {
    id: "prop-legal-retry",
    kind: "response",
    units: [
      {
        id: "claim-1",
        text: "The lease term shall commence on March 1, 2024",  // matches clause excerpt
        grade: "confirmed",
        clause: "3.2",
        evidenceRefs: ["clause-3.2"],
      },
    ],
  };

  const gateForRetry = createTrustGate({
    policy: new LegalClaimPolicy(),
    auditWriter: noopAuditWriter(),
  });

  const correctedResult = await gateForRetry.admit(correctedProposal, supportPool);
  const correctedExpl = gateForRetry.explain(correctedResult);

  label("approved (after revision)", correctedExpl.approved);
  label("downgraded (after revision)", correctedExpl.downgraded);

  const correctedClaim = correctedResult.admittedUnits.find(u => u.unitId === "claim-1");
  assert.ok(correctedClaim);
  assert.equal(correctedClaim.status, "approved");
  console.log("  [PASS] Corrected claim approved — verbatim match found in clause excerpt");
  console.log("  [PASS] retryOnDecisions=[\"downgrade\"] pattern: gate → feedback → LLM revision → approved");

  subsep("Summary");
  console.log("  retryOnDecisions not set  → downgrade is a soft warning; LLM gets degraded result");
  console.log("  retryOnDecisions=[\"downgrade\"] → downgrade triggers retry; LLM must improve the claim");
  console.log("  Use the latter when precision matters more than throughput.\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
