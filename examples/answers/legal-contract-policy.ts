/**
 * Legal contract analysis — contract review assistant policy for jingu-trust-gate.
 *
 * Use case: a lawyer or business user asks "Does this contract have a termination
 * clause?" or "What are the penalty terms?". The RAG pipeline retrieves relevant
 * contract clauses as evidence. The LLM proposes structured claims. jingu-trust-gate
 * admits only claims that match actual clause text — preventing the LLM from
 * inventing clause names, inventing specific figures, or asserting the presence
 * of terms that do not appear in the retrieved text.
 *
 * The core failure mode this prevents:
 *   Contract has "cancellation conditions" but no explicit "termination clause"
 *   LLM asserts "The contract includes a termination clause" → legal hallucination
 *
 * Domain types
 *   ContractClaim  — one LLM-proposed assertion about contract content
 *   ClauseAttrs    — shape of SupportRef.attributes for contract clause records
 *
 * Gate rules (evaluateUnit)
 *   R1  grade=proven + no bound evidence                              → MISSING_EVIDENCE      → reject
 *   R2  claim uses a specific legal term (e.g. "termination clause")
 *       not present verbatim in evidence clause text                  → TERM_NOT_IN_EVIDENCE  → reject
 *   R3  claim asserts a specific figure (penalty %, dollar amount,
 *       notice period days) not present in evidence                   → OVER_SPECIFIC_FIGURE  → downgrade
 *   R4  claim asserts obligation or right that the clause text
 *       does not explicitly grant                                     → SCOPE_EXCEEDED        → downgrade
 *   R5  everything else                                               → approve
 *
 * Conflict patterns (detectConflicts)
 *   CLAUSE_CONFLICT  blocking — two clauses in evidence directly contradict
 *                               each other on the same right or obligation
 *
 * Run:
 *   npm run build && node dist/examples/legal-contract-policy.js
 */

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

// ── Domain types ──────────────────────────────────────────────────────────────

type ClaimGrade = "proven" | "derived" | "suspected";

type ContractClaim = {
  id: string;
  claim: string;
  grade: ClaimGrade;
  evidenceRefs: string[];     // clause IDs cited by the LLM
  attributes: {
    assertedTerm?: string;    // legal term the claim hinges on, e.g. "termination clause"
    assertedFigure?: {        // specific number the claim asserts
      type: "percentage" | "days" | "amount";
      value: number;
    };
    assertedRight?: string;   // e.g. "either party may terminate"
  };
};

type ClauseAttrs = {
  clauseType: "termination" | "penalty" | "cancellation" | "liability" | "general";
  clauseText: string;         // verbatim or summarized clause text
  explicitTerms?: string[];   // exact legal terms that appear in this clause
  figures?: Array<{           // numeric figures mentioned in the clause
    type: "percentage" | "days" | "amount";
    value: number;
  }>;
  grants?: string[];          // rights/obligations this clause explicitly grants
};

// ── Policy ────────────────────────────────────────────────────────────────────

class LegalContractPolicy implements GatePolicy<ContractClaim> {

  validateStructure(proposal: Proposal<ContractClaim>): StructureValidationResult {
    const errors: StructureValidationResult["errors"] = [];
    if (proposal.units.length === 0) {
      errors.push({ field: "units", reasonCode: "EMPTY_PROPOSAL" });
      return { kind: "structure", valid: false, errors };
    }
    for (const unit of proposal.units) {
      if (!unit.id?.trim())
        errors.push({ field: "id", reasonCode: "MISSING_UNIT_ID" });
      if (!unit.claim?.trim())
        errors.push({ field: "claim", reasonCode: "EMPTY_CLAIM", message: `unit ${unit.id}` });
      if (!unit.grade)
        errors.push({ field: "grade", reasonCode: "MISSING_GRADE", message: `unit ${unit.id}` });
      if (!Array.isArray(unit.evidenceRefs))
        errors.push({ field: "evidenceRefs", reasonCode: "MISSING_EVIDENCE_REFS", message: `unit ${unit.id}` });
    }
    return { kind: "structure", valid: errors.length === 0, errors };
  }

  bindSupport(unit: ContractClaim, pool: SupportRef[]): UnitWithSupport<ContractClaim> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  }

  evaluateUnit(
    { unit, supportIds, supportRefs }: UnitWithSupport<ContractClaim>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {

    // R1: proven with no evidence
    if (unit.grade === "proven" && supportIds.length === 0) {
      return { kind: "unit", unitId: unit.id, decision: "reject", reasonCode: "MISSING_EVIDENCE" };
    }

    // R2: claim uses a specific legal term — must appear verbatim in evidence.
    // "termination clause" is a precise legal concept; "cancellation conditions"
    // is not the same thing. If the term is not in explicitTerms, reject.
    if (unit.attributes.assertedTerm) {
      const term = unit.attributes.assertedTerm.toLowerCase();
      const termPresentInEvidence = supportRefs.some(s => {
        const attrs = s.attributes as ClauseAttrs | undefined;
        return attrs?.explicitTerms?.some(t => t.toLowerCase().includes(term)) ||
               attrs?.clauseText?.toLowerCase().includes(term);
      });
      if (!termPresentInEvidence) {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "reject",
          reasonCode: "TERM_NOT_IN_EVIDENCE",
          annotations: {
            assertedTerm: unit.attributes.assertedTerm,
            note: `Term "${unit.attributes.assertedTerm}" does not appear in any bound clause`,
          },
        };
      }
    }

    // R3: specific figure claim must match evidence exactly.
    // e.g. "20% penalty" when clause text only specifies "reasonable compensation"
    if (unit.attributes.assertedFigure) {
      const { type, value } = unit.attributes.assertedFigure;
      const figureInEvidence = supportRefs.some(s => {
        const attrs = s.attributes as ClauseAttrs | undefined;
        return attrs?.figures?.some(f => f.type === type && f.value === value);
      });
      const anyFigureOfType = supportRefs.some(s => {
        const attrs = s.attributes as ClauseAttrs | undefined;
        return attrs?.figures?.some(f => f.type === type);
      });

      if (!figureInEvidence) {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "downgrade",
          reasonCode: "OVER_SPECIFIC_FIGURE",
          newGrade: "derived",
          annotations: {
            unsupportedAttributes: [`${type}: ${value}`],
            hasRelatedFigures: anyFigureOfType,
            note: `Specific ${type} value ${value} not found in bound clauses`,
          },
        };
      }
    }

    // R4: asserted right or obligation must be explicitly granted by the clause.
    // "either party may terminate" is only supportable if the clause grants that right.
    if (unit.attributes.assertedRight) {
      const right = unit.attributes.assertedRight.toLowerCase();
      const rightGrantedByEvidence = supportRefs.some(s => {
        const attrs = s.attributes as ClauseAttrs | undefined;
        return attrs?.grants?.some(g => g.toLowerCase().includes(right));
      });
      if (!rightGrantedByEvidence) {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "downgrade",
          reasonCode: "SCOPE_EXCEEDED",
          newGrade: "derived",
          annotations: {
            unsupportedAttributes: [`right: ${unit.attributes.assertedRight}`],
            note: `Claimed right "${unit.attributes.assertedRight}" is not explicitly granted in bound clauses`,
          },
        };
      }
    }

    // R5: approved
    return { kind: "unit", unitId: unit.id, decision: "approve", reasonCode: "OK" };
  }

  detectConflicts(
    units: UnitWithSupport<ContractClaim>[],
    pool: SupportRef[]
  ): ConflictAnnotation[] {
    const conflicts: ConflictAnnotation[] = [];

    // CLAUSE_CONFLICT (blocking):
    // Two clauses in evidence grant conflicting rights on the same topic.
    // e.g. one clause says "either party may terminate with 30 days notice"
    // another says "contract is irrevocable for the initial term".
    // This is a legal ambiguity — neither claim is safe to surface as settled fact.
    type TopicKey = string;
    const grantsByTopic = new Map<TopicKey, { refIds: string[]; grants: string[] }>();

    for (const ref of pool) {
      const attrs = ref.attributes as ClauseAttrs | undefined;
      if (!attrs?.grants) continue;
      for (const grant of attrs.grants) {
        // Group by first meaningful word as topic proxy
        const topic = grant.split(" ").slice(0, 2).join(" ").toLowerCase();
        if (!grantsByTopic.has(topic)) grantsByTopic.set(topic, { refIds: [], grants: [] });
        grantsByTopic.get(topic)!.refIds.push(ref.id);
        grantsByTopic.get(topic)!.grants.push(grant);
      }
    }

    // Detect irrevocable vs revocable conflict
    const irrevocableRefs = pool.filter(s => {
      const attrs = s.attributes as ClauseAttrs | undefined;
      return attrs?.clauseText?.toLowerCase().includes("irrevocable") ||
             attrs?.grants?.some(g => g.toLowerCase().includes("irrevocable"));
    });
    const revocableRefs = pool.filter(s => {
      const attrs = s.attributes as ClauseAttrs | undefined;
      return attrs?.grants?.some(g =>
        g.toLowerCase().includes("terminate") || g.toLowerCase().includes("cancel")
      );
    });

    if (irrevocableRefs.length > 0 && revocableRefs.length > 0) {
      const allRefIds = [...irrevocableRefs, ...revocableRefs].map(r => r.id);
      const affectedUnitIds = units
        .filter(({ supportIds }) => allRefIds.some(id => supportIds.includes(id)))
        .map(({ unit }) => unit.id);
      if (affectedUnitIds.length > 0) {
        conflicts.push({
          unitIds: affectedUnitIds,
          conflictCode: "CLAUSE_CONFLICT",
          sources: allRefIds,
          severity: "blocking",
          description: "Contract contains both irrevocability language and termination rights — legal review required",
        });
      }
    }

    return conflicts;
  }

  render(
    admittedUnits: AdmittedUnit<ContractClaim>[],
    _pool: SupportRef[],
    _ctx: RenderContext
  ): VerifiedContext {
    const admittedBlocks = admittedUnits.map(u => {
      const claim = u.unit as ContractClaim;
      const currentGrade = u.appliedGrades[u.appliedGrades.length - 1] ?? claim.grade;
      const conflict = u.conflictAnnotations?.[0];
      return {
        sourceId: u.unitId,
        content: claim.claim,
        grade: currentGrade,
        ...(u.status === "downgraded" && {
          unsupportedAttributes:
            (u.evaluationResults[0]?.annotations as any)?.unsupportedAttributes ?? [],
        }),
        ...(conflict && {
          conflictNote: `${conflict.conflictCode}: ${conflict.description ?? ""}`,
        }),
      };
    });

    return {
      admittedBlocks,
      summary: {
        admitted: admittedUnits.length,
        rejected: 0,
        conflicts: admittedUnits.filter(u => u.status === "approved_with_conflict").length,
      },
      instructions:
        "You are a contract analysis assistant. Use only the verified clause facts below. " +
        "Do not invent legal terms, figures, or rights not present in the verified facts. " +
        "For downgraded claims, use hedged language: 'the contract may include' rather than 'the contract includes'. " +
        "If conflicting clauses are present, flag them explicitly and recommend legal review. " +
        "This output is not legal advice.",
    };
  }

  buildRetryFeedback(unitResults: UnitEvaluationResult[], ctx: RetryContext): RetryFeedback {
    const failed = unitResults.filter(r => r.decision === "reject");
    return {
      summary: `${failed.length} claim(s) rejected on attempt ${ctx.attempt}/${ctx.maxRetries}.`,
      errors: failed.map(r => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: {
          hint: r.reasonCode === "TERM_NOT_IN_EVIDENCE"
            ? "The legal term you used does not appear in the cited clauses. Use the exact language from the clause text."
            : r.reasonCode === "MISSING_EVIDENCE"
            ? "Cite the clause ID in evidenceRefs."
            : "Adjust the claim to match what the cited clause text explicitly states.",
        },
      })),
    };
  }
}

// ── Example run ───────────────────────────────────────────────────────────────

function noopAuditWriter(): AuditWriter {
  return { append: async (_e: AuditEntry) => {} };
}

function sep(title: string): void {
  console.log("\n" + "═".repeat(70));
  console.log(`  ${title}`);
  console.log("═".repeat(70));
}

function label(key: string, value: unknown): void {
  console.log(`    ${key.padEnd(26)}: ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const gate = createTrustGate({
    policy: new LegalContractPolicy(),
    auditWriter: noopAuditWriter(),
  });

  // Support pool: contract clauses retrieved for the query "termination and penalty terms"
  const supportPool: SupportRef[] = [
    {
      id: "ref-001", sourceId: "clause-7b", sourceType: "observation",
      attributes: {
        clauseType: "cancellation",
        clauseText: "Either party may cancel this agreement under the cancellation conditions set forth in Schedule A.",
        explicitTerms: ["cancellation conditions", "schedule a"],
        grants: ["either party may cancel"],
      },
    },
    {
      id: "ref-002", sourceId: "clause-12a", sourceType: "observation",
      attributes: {
        clauseType: "penalty",
        clauseText: "In the event of early cancellation, the cancelling party shall pay reasonable compensation to the other party.",
        explicitTerms: ["early cancellation", "reasonable compensation"],
        figures: [],   // no specific figure — "reasonable compensation" is not a number
        grants: [],
      },
    },
  ];

  const proposal: Proposal<ContractClaim> = {
    id: "prop-legal-001",
    kind: "response",
    units: [
      // u1: approved — "cancellation conditions" appears verbatim in clause-7b
      {
        id: "u1",
        claim: "The contract includes cancellation conditions",
        grade: "proven",
        evidenceRefs: ["clause-7b"],
        attributes: { assertedTerm: "cancellation conditions" },
      },
      // u2: TERM_NOT_IN_EVIDENCE → rejected
      // "termination clause" does not appear in any retrieved clause
      {
        id: "u2",
        claim: "The contract includes a termination clause",
        grade: "proven",
        evidenceRefs: ["clause-7b"],
        attributes: { assertedTerm: "termination clause" },
      },
      // u3: OVER_SPECIFIC_FIGURE → downgraded
      // clause says "reasonable compensation" — no 20% figure exists
      {
        id: "u3",
        claim: "Early cancellation incurs a 20% penalty fee",
        grade: "proven",
        evidenceRefs: ["clause-12a"],
        attributes: { assertedFigure: { type: "percentage", value: 20 } },
      },
      // u4: SCOPE_EXCEEDED → downgraded
      // clause-7b grants "cancel", not "terminate with 30 days notice"
      {
        id: "u4",
        claim: "Either party may terminate the contract with 30 days notice",
        grade: "proven",
        evidenceRefs: ["clause-7b"],
        attributes: { assertedRight: "terminate with 30 days notice" },
      },
      // u5: approved — directly supported by clause-12a text
      {
        id: "u5",
        claim: "Early cancellation requires payment of reasonable compensation",
        grade: "proven",
        evidenceRefs: ["clause-12a"],
        attributes: {},
      },
    ],
  };

  const result = await gate.admit(proposal, supportPool);
  const context = gate.render(result);
  const explanation = gate.explain(result);

  sep("Legal Contract Policy — Admission Result");

  console.log("\n  Admitted units:");
  for (const u of result.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.claim);
    if (u.status === "downgraded") {
      label("    reasonCode", u.evaluationResults[0]?.reasonCode);
      label("    unsupported", (u.evaluationResults[0]?.annotations as any)?.unsupportedAttributes);
    }
  }

  console.log("\n  Rejected units:");
  for (const u of result.rejectedUnits) {
    label(`  ${u.unitId} [rejected]`, u.evaluationResults[0]?.reasonCode);
    label("    claim", u.unit.claim);
  }

  sep("Explanation");
  label("approved", explanation.approved);
  label("downgraded", explanation.downgraded);
  label("rejected", explanation.rejected);

  sep("Instructions injected into final LLM call");
  console.log(`\n  ${context.instructions}`);
}

main().catch(err => { console.error(err); process.exit(1); });
