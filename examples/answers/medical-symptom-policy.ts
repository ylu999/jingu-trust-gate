/**
 * Medical symptom assessment — health assistant policy for jingu-trust-gate.
 *
 * Use case: a patient describes symptoms. A RAG pipeline retrieves matching
 * medical knowledge records. The LLM proposes structured claims about possible
 * conditions. jingu-trust-gate admits only claims that stay within what the
 * symptom evidence actually supports — preventing over-certain diagnosis
 * assertions from reaching the user.
 *
 * The core failure mode this prevents:
 *   LLM sees "fatigue + thirst" → asserts "You have diabetes" (grade=proven)
 *   No lab results, no confirmed diagnosis → this must never reach the user
 *
 * Domain types
 *   SymptomClaim  — one LLM-proposed assertion about a possible condition
 *   EvidenceAttrs — shape of SupportRef.attributes for symptom/test records
 *
 * Gate rules (evaluateUnit)
 *   R1  grade=proven + no bound evidence                          → MISSING_EVIDENCE       → reject
 *   R2  claim asserts a confirmed diagnosis but evidence has
 *       only symptoms, no confirmed lab/test results              → DIAGNOSIS_UNCONFIRMED  → reject
 *   R3  claim asserts a specific condition but evidence only
 *       shows "consistent with" or "may suggest"                  → OVER_CERTAIN           → downgrade
 *   R4  claim asserts a treatment/medication recommendation        → TREATMENT_NOT_ADVISED  → reject
 *       (symptom evidence never supports treatment claims)
 *   R5  everything else                                           → approve
 *
 * Conflict patterns (detectConflicts)
 *   CONDITION_CONFLICT  informational — two conditions are mutually exclusive
 *                                       but both are weakly suggested by evidence
 *
 * Run:
 *   npm run build && node dist/examples/medical-symptom-policy.js
 */

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

// ── Domain types ──────────────────────────────────────────────────────────────

type ClaimGrade = "proven" | "derived" | "suspected";

type SymptomClaim = {
  id: string;
  claim: string;
  grade: ClaimGrade;
  evidenceRefs: string[];
  attributes: {
    assertedCondition?: string;   // e.g. "diabetes", "hypertension"
    isDiagnosis?: boolean;        // true = asserting confirmed diagnosis
    isTreatment?: boolean;        // true = recommending action/medication
  };
};

type EvidenceAttrs = {
  recordType: "symptom" | "lab_result" | "medical_history" | "knowledge_base";
  symptom?: string;
  confirmed?: boolean;            // true only for lab-confirmed results
  suggestsConditions?: string[];  // conditions this symptom may suggest
  severity?: "mild" | "moderate" | "severe";
};

// ── Policy ────────────────────────────────────────────────────────────────────

class MedicalSymptomPolicy implements GatePolicy<SymptomClaim> {

  validateStructure(proposal: Proposal<SymptomClaim>): StructureValidationResult {
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

  bindSupport(unit: SymptomClaim, pool: SupportRef[]): UnitWithSupport<SymptomClaim> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  }

  evaluateUnit(
    { unit, supportIds, supportRefs }: UnitWithSupport<SymptomClaim>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {

    // R1: proven with no evidence
    if (unit.grade === "proven" && supportIds.length === 0) {
      return { kind: "unit", unitId: unit.id, decision: "reject", reasonCode: "MISSING_EVIDENCE" };
    }

    // R4: treatment/medication claims are always rejected.
    // Symptom records never constitute sufficient evidence for a treatment recommendation.
    if (unit.attributes.isTreatment) {
      return {
        kind: "unit",
        unitId: unit.id,
        decision: "reject",
        reasonCode: "TREATMENT_NOT_ADVISED",
        annotations: {
          note: "Treatment recommendations require clinical evaluation — symptom evidence is insufficient",
        },
      };
    }

    // R2: confirmed diagnosis claims require at least one lab-confirmed record.
    // "You have diabetes" (isDiagnosis=true) is only supportable with confirmed=true evidence.
    if (unit.attributes.isDiagnosis) {
      const hasConfirmedEvidence = supportRefs.some(s => {
        const attrs = s.attributes as EvidenceAttrs | undefined;
        return attrs?.confirmed === true;
      });
      if (!hasConfirmedEvidence) {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "reject",
          reasonCode: "DIAGNOSIS_UNCONFIRMED",
          annotations: {
            note: "A confirmed diagnosis requires lab results or clinical confirmation, not symptom records alone",
          },
        };
      }
    }

    // R3: condition assertion is over-certain if evidence only "suggests" the condition.
    // knowledge_base records list suggestsConditions but do not confirm them.
    if (unit.attributes.assertedCondition && !unit.attributes.isDiagnosis) {
      const condition = unit.attributes.assertedCondition.toLowerCase();
      const evidenceDirectlySupports = supportRefs.some(s => {
        const attrs = s.attributes as EvidenceAttrs | undefined;
        return attrs?.confirmed === true &&
          attrs?.suggestsConditions?.map(c => c.toLowerCase()).includes(condition);
      });
      const evidenceWeaklySupports = supportRefs.some(s => {
        const attrs = s.attributes as EvidenceAttrs | undefined;
        return attrs?.suggestsConditions?.map(c => c.toLowerCase()).includes(condition);
      });

      if (!evidenceDirectlySupports && evidenceWeaklySupports && unit.grade === "proven") {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "downgrade",
          reasonCode: "OVER_CERTAIN",
          newGrade: "suspected",
          annotations: {
            unsupportedAttributes: [`confirmed condition: ${unit.attributes.assertedCondition}`],
            note: "Evidence suggests this condition but does not confirm it",
          },
        };
      }
    }

    // R5: approved
    return { kind: "unit", unitId: unit.id, decision: "approve", reasonCode: "OK" };
  }

  detectConflicts(
    units: UnitWithSupport<SymptomClaim>[],
    _pool: SupportRef[]
  ): ConflictAnnotation[] {
    const conflicts: ConflictAnnotation[] = [];

    // CONDITION_CONFLICT (informational):
    // Two suspected conditions are mutually exclusive (e.g. Type 1 vs Type 2 diabetes).
    // Surface both so the downstream LLM presents them as differential diagnosis,
    // not as a single conclusion.
    const mutuallyExclusive: [string, string][] = [
      ["type 1 diabetes", "type 2 diabetes"],
      ["hypothyroidism", "hyperthyroidism"],
      ["viral infection", "bacterial infection"],
    ];

    const conditionsByUnitId = new Map<string, string>();
    for (const { unit } of units) {
      if (unit.attributes.assertedCondition) {
        conditionsByUnitId.set(unit.id, unit.attributes.assertedCondition.toLowerCase());
      }
    }

    for (const [condA, condB] of mutuallyExclusive) {
      const idsA = [...conditionsByUnitId.entries()]
        .filter(([, c]) => c.includes(condA)).map(([id]) => id);
      const idsB = [...conditionsByUnitId.entries()]
        .filter(([, c]) => c.includes(condB)).map(([id]) => id);
      if (idsA.length && idsB.length) {
        conflicts.push({
          unitIds: [...idsA, ...idsB],
          conflictCode: "CONDITION_CONFLICT",
          sources: [],
          severity: "informational",
          description: `Mutually exclusive conditions both suggested: "${condA}" vs "${condB}"`,
        });
      }
    }

    return conflicts;
  }

  render(
    admittedUnits: AdmittedUnit<SymptomClaim>[],
    _pool: SupportRef[],
    _ctx: RenderContext
  ): VerifiedContext {
    const admittedBlocks = admittedUnits.map(u => {
      const claim = u.unit as SymptomClaim;
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
        "You are a health information assistant, not a doctor. " +
        "Use only the verified facts below. " +
        "For suspected conditions, use language like 'your symptoms may be consistent with' — never assert a diagnosis. " +
        "Never recommend treatments or medications. " +
        "Always end with: 'Please consult a qualified healthcare professional for a proper evaluation.'",
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
          hint: r.reasonCode === "DIAGNOSIS_UNCONFIRMED"
            ? "Remove isDiagnosis=true or supply a lab-confirmed evidence ref. Use grade='suspected' and hedge the claim."
            : r.reasonCode === "TREATMENT_NOT_ADVISED"
            ? "Remove treatment/medication recommendations entirely — they are outside the scope of this system."
            : "Add evidence refs or lower the grade.",
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
    policy: new MedicalSymptomPolicy(),
    auditWriter: noopAuditWriter(),
  });

  // Support pool: symptom records and knowledge base entries
  const supportPool: SupportRef[] = [
    {
      id: "ref-001", sourceId: "symptom-fatigue", sourceType: "observation",
      attributes: {
        recordType: "symptom", symptom: "fatigue", severity: "moderate",
        suggestsConditions: ["diabetes", "hypothyroidism", "anemia"],
      },
    },
    {
      id: "ref-002", sourceId: "symptom-thirst", sourceType: "observation",
      attributes: {
        recordType: "symptom", symptom: "excessive thirst", severity: "moderate",
        suggestsConditions: ["diabetes", "dehydration"],
      },
    },
    {
      id: "ref-003", sourceId: "kb-diabetes", sourceType: "observation",
      attributes: {
        recordType: "knowledge_base",
        suggestsConditions: ["diabetes"],
        confirmed: false,
      },
    },
  ];

  // Proposal: LLM proposes claims after seeing fatigue + thirst symptoms
  const proposal: Proposal<SymptomClaim> = {
    id: "prop-med-001",
    kind: "response",
    units: [
      // u1: symptoms are present in evidence → approved
      {
        id: "u1",
        claim: "The patient reports fatigue and excessive thirst",
        grade: "proven",
        evidenceRefs: ["symptom-fatigue", "symptom-thirst"],
        attributes: {},
      },
      // u2: OVER_CERTAIN → downgraded to suspected
      // knowledge base suggests diabetes but does not confirm it
      {
        id: "u2",
        claim: "These symptoms may be consistent with diabetes",
        grade: "proven",
        evidenceRefs: ["symptom-fatigue", "symptom-thirst", "kb-diabetes"],
        attributes: { assertedCondition: "diabetes" },
      },
      // u3: DIAGNOSIS_UNCONFIRMED → rejected
      // no lab results in pool — cannot assert confirmed diagnosis
      {
        id: "u3",
        claim: "The patient has diabetes",
        grade: "proven",
        evidenceRefs: ["symptom-fatigue", "symptom-thirst"],
        attributes: { assertedCondition: "diabetes", isDiagnosis: true },
      },
      // u4: TREATMENT_NOT_ADVISED → rejected
      // symptom records never support medication recommendations
      {
        id: "u4",
        claim: "The patient should start metformin",
        grade: "derived",
        evidenceRefs: ["symptom-fatigue"],
        attributes: { isTreatment: true },
      },
      // u5: MISSING_EVIDENCE → rejected
      {
        id: "u5",
        claim: "The patient has had these symptoms for 3 months",
        grade: "proven",
        evidenceRefs: [],
        attributes: {},
      },
    ],
  };

  const result = await gate.admit(proposal, supportPool);
  const context = gate.render(result);
  const explanation = gate.explain(result);

  sep("Medical Symptom Policy — Admission Result");

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
