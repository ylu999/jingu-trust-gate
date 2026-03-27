/**
 * BI analytics assistant — business intelligence query policy for jingu-trust-gate.
 *
 * Use case: a business analyst asks "How much did revenue grow last month?" or
 * "Which region performed best in Q3?". The pipeline retrieves metric records
 * from a data warehouse. The LLM proposes structured claims. jingu-trust-gate
 * admits only claims where the math and comparisons are grounded in the actual
 * retrieved numbers — preventing the LLM from inventing percentages, cherry-
 * picking periods, or asserting trends that the data does not support.
 *
 * The core failure mode this prevents:
 *   evidence: Jan=100k, Feb=110k, some transactions missing
 *   LLM asserts "Revenue grew 15%" → wrong calculation, no caveat about missing data
 *
 * Domain types
 *   MetricClaim   — one LLM-proposed assertion about a business metric
 *   MetricAttrs   — shape of SupportRef.attributes for data warehouse records
 *
 * Gate rules (evaluateUnit)
 *   R1  grade=proven + no bound evidence                              → MISSING_EVIDENCE      → reject
 *   R2  claim asserts a specific percentage/ratio computed from
 *       evidence values, but the math does not check out              → INCORRECT_CALCULATION → reject
 *   R3  claim asserts a trend ("grew", "declined") but evidence
 *       only covers one period (no prior period to compare)           → MISSING_BASELINE      → downgrade
 *   R4  claim asserts completeness ("total revenue", "all regions")
 *       but evidence records are marked as partial/incomplete         → INCOMPLETE_DATA       → downgrade
 *   R5  everything else                                               → approve
 *
 * Conflict patterns (detectConflicts)
 *   METRIC_CONFLICT  blocking — two records report the same metric for
 *                               the same period with different values
 *
 * Run:
 *   npm run build && node dist/examples/bi-analytics-policy.js
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

type MetricClaim = {
  id: string;
  claim: string;
  grade: ClaimGrade;
  evidenceRefs: string[];
  attributes: {
    assertedGrowthPct?: number;   // e.g. 15 (for "grew 15%")
    assertedTrend?: "growth" | "decline" | "flat";
    assertsCompleteness?: boolean; // true = claim says "total" / "all"
    metric?: string;               // e.g. "revenue", "orders"
    period?: string;               // e.g. "2026-02"
  };
};

type MetricAttrs = {
  metricName: string;            // e.g. "revenue", "orders"
  period: string;                // e.g. "2026-01", "2026-02"
  value: number;
  currency?: string;
  complete: boolean;             // false = late transactions / partial data
  region?: string;
};

// ── Policy ────────────────────────────────────────────────────────────────────

class BiAnalyticsPolicy implements GatePolicy<MetricClaim> {

  validateStructure(proposal: Proposal<MetricClaim>): StructureValidationResult {
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

  bindSupport(unit: MetricClaim, pool: SupportRef[]): UnitWithSupport<MetricClaim> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  }

  evaluateUnit(
    { unit, supportIds, supportRefs }: UnitWithSupport<MetricClaim>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {

    // R1: proven with no evidence
    if (unit.grade === "proven" && supportIds.length === 0) {
      return { kind: "unit", unitId: unit.id, decision: "reject", reasonCode: "MISSING_EVIDENCE" };
    }

    const metricRecords = supportRefs
      .map(s => s.attributes as MetricAttrs | undefined)
      .filter((a): a is MetricAttrs => a !== undefined);

    // R2: computed percentage must match the evidence values.
    // Find the two periods in the evidence, compute the actual growth, compare.
    if (unit.attributes.assertedGrowthPct !== undefined) {
      const claimed = unit.attributes.assertedGrowthPct;
      const metricName = unit.attributes.metric?.toLowerCase();

      const relevant = metricName
        ? metricRecords.filter(r => r.metricName.toLowerCase() === metricName)
        : metricRecords;

      if (relevant.length >= 2) {
        // Sort by period to get current and prior
        const sorted = [...relevant].sort((a, b) => a.period.localeCompare(b.period));
        const prior   = sorted[sorted.length - 2];
        const current = sorted[sorted.length - 1];

        if (prior.value > 0) {
          const actualGrowth = ((current.value - prior.value) / prior.value) * 100;
          // Allow ±1% rounding tolerance
          if (Math.abs(actualGrowth - claimed) > 1) {
            return {
              kind: "unit",
              unitId: unit.id,
              decision: "reject",
              reasonCode: "INCORRECT_CALCULATION",
              annotations: {
                claimedGrowthPct: claimed,
                actualGrowthPct: Math.round(actualGrowth * 10) / 10,
                priorPeriod: prior.period,
                priorValue: prior.value,
                currentPeriod: current.period,
                currentValue: current.value,
              },
            };
          }
        }
      }
    }

    // R3: trend claim requires a prior period for comparison.
    // If only one period is in the evidence, "grew" or "declined" is unsupported.
    if (unit.attributes.assertedTrend) {
      const metricName = unit.attributes.metric?.toLowerCase();
      const relevant = metricName
        ? metricRecords.filter(r => r.metricName.toLowerCase() === metricName)
        : metricRecords;
      const distinctPeriods = new Set(relevant.map(r => r.period));

      if (distinctPeriods.size < 2) {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "downgrade",
          reasonCode: "MISSING_BASELINE",
          newGrade: "derived",
          annotations: {
            unsupportedAttributes: [`trend: ${unit.attributes.assertedTrend}`],
            availablePeriods: Array.from(distinctPeriods),
            note: "Trend assertion requires at least two periods in evidence",
          },
        };
      }
    }

    // R4: completeness claim is unsupported if any evidence record is marked incomplete.
    if (unit.attributes.assertsCompleteness) {
      const hasIncompleteData = metricRecords.some(r => r.complete === false);
      if (hasIncompleteData) {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "downgrade",
          reasonCode: "INCOMPLETE_DATA",
          newGrade: "derived",
          annotations: {
            unsupportedAttributes: ["total / all / complete"],
            note: "Evidence contains records marked as incomplete — completeness claim is not supportable",
          },
        };
      }
    }

    // R5: approved
    return { kind: "unit", unitId: unit.id, decision: "approve", reasonCode: "OK" };
  }

  detectConflicts(
    units: UnitWithSupport<MetricClaim>[],
    pool: SupportRef[]
  ): ConflictAnnotation[] {
    const conflicts: ConflictAnnotation[] = [];

    // METRIC_CONFLICT (blocking):
    // Two pool records report the same metric + period with different values.
    // This is a data pipeline issue — neither value is trustworthy until resolved.
    type MetricPeriodKey = string; // `${metricName}::${period}`
    const recordsByKey = new Map<MetricPeriodKey, { values: Set<number>; refIds: string[] }>();

    for (const ref of pool) {
      const attrs = ref.attributes as MetricAttrs | undefined;
      if (!attrs?.metricName || !attrs?.period || attrs?.value === undefined) continue;
      const key: MetricPeriodKey = `${attrs.metricName}::${attrs.period}`;
      if (!recordsByKey.has(key)) recordsByKey.set(key, { values: new Set(), refIds: [] });
      recordsByKey.get(key)!.values.add(attrs.value);
      recordsByKey.get(key)!.refIds.push(ref.id);
    }

    for (const [key, { values, refIds }] of recordsByKey) {
      if (values.size <= 1) continue;
      const affectedUnitIds = units
        .filter(({ supportIds }) => refIds.some(id => supportIds.includes(id)))
        .map(({ unit }) => unit.id);
      if (!affectedUnitIds.length) continue;
      const [metricName, period] = key.split("::");
      conflicts.push({
        unitIds: affectedUnitIds,
        conflictCode: "METRIC_CONFLICT",
        sources: refIds,
        severity: "blocking",
        description: `${metricName} for ${period} has conflicting values: [${Array.from(values).join(", ")}] — data pipeline issue`,
      });
    }

    return conflicts;
  }

  render(
    admittedUnits: AdmittedUnit<MetricClaim>[],
    _pool: SupportRef[],
    _ctx: RenderContext
  ): VerifiedContext {
    const admittedBlocks = admittedUnits.map(u => {
      const claim = u.unit as MetricClaim;
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
        "Answer the analyst's question using only the verified metrics below. " +
        "For downgraded claims, note the data limitation explicitly: e.g. 'based on available data' or 'exact total unavailable due to incomplete records'. " +
        "Never state a percentage or figure that is not in the verified facts. " +
        "If data is incomplete, say so — do not present partial data as complete.",
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
          hint: r.reasonCode === "INCORRECT_CALCULATION"
            ? `Your growth percentage does not match the evidence values. Check annotations for the correct figure.`
            : r.reasonCode === "MISSING_EVIDENCE"
            ? "Cite the metric record IDs in evidenceRefs."
            : "Adjust claim to match what the evidence records support.",
          ...(r.annotations as object | undefined),
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

function subsep(title: string): void {
  console.log(`\n  ── ${title}`);
}

function label(key: string, value: unknown): void {
  console.log(`    ${key.padEnd(28)}: ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const harness = createTrustGate({
    policy: new BiAnalyticsPolicy(),
    auditWriter: noopAuditWriter(),
  });

  // ── Scenario A: revenue growth query ─────────────────────────────────────
  // evidence: Jan=100k (complete), Feb=110k (incomplete — late transactions)
  // LLM claims 15% growth and asserts "total revenue" — both wrong

  sep("Scenario A — Revenue growth query");
  subsep("Analyst: 'How much did revenue grow last month?'");

  const poolA: SupportRef[] = [
    {
      id: "ref-a1", sourceId: "revenue-2026-01", sourceType: "observation",
      attributes: { metricName: "revenue", period: "2026-01", value: 100000, complete: true },
    },
    {
      id: "ref-a2", sourceId: "revenue-2026-02", sourceType: "observation",
      attributes: { metricName: "revenue", period: "2026-02", value: 110000, complete: false },
    },
  ];

  const proposalA: Proposal<MetricClaim> = {
    id: "prop-bi-a",
    kind: "response",
    units: [
      // u1: INCORRECT_CALCULATION → rejected
      // actual growth = (110k-100k)/100k = 10%, not 15%
      {
        id: "u1",
        claim: "Revenue grew by 15% compared to January",
        grade: "proven",
        evidenceRefs: ["revenue-2026-01", "revenue-2026-02"],
        attributes: { assertedGrowthPct: 15, assertedTrend: "growth", metric: "revenue" },
      },
      // u2: approved — 10% is correct
      {
        id: "u2",
        claim: "Revenue grew by 10% compared to January",
        grade: "proven",
        evidenceRefs: ["revenue-2026-01", "revenue-2026-02"],
        attributes: { assertedGrowthPct: 10, assertedTrend: "growth", metric: "revenue" },
      },
      // u3: INCOMPLETE_DATA → downgraded
      // Feb record is marked complete=false
      {
        id: "u3",
        claim: "Total February revenue was $110,000",
        grade: "proven",
        evidenceRefs: ["revenue-2026-02"],
        attributes: { assertsCompleteness: true, metric: "revenue", period: "2026-02" },
      },
    ],
  };

  const resultA = await harness.admit(proposalA, poolA);
  const explA = harness.explain(resultA);

  console.log("\n  Gate results:");
  for (const u of resultA.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.claim);
    if (u.status === "downgraded") {
      label("    reasonCode", u.evaluationResults[0]?.reasonCode);
      label("    unsupported", (u.evaluationResults[0]?.annotations as any)?.unsupportedAttributes);
    }
  }
  for (const u of resultA.rejectedUnits) {
    label(`  ${u.unitId} [rejected]`, u.evaluationResults[0]?.reasonCode);
    const ann = u.evaluationResults[0]?.annotations as any;
    if (ann?.actualGrowthPct !== undefined) {
      label("    actual growth %", ann.actualGrowthPct);
      label("    claimed growth %", ann.claimedGrowthPct);
    }
  }
  console.log();
  label("approved", explA.approved);
  label("downgraded", explA.downgraded);
  label("rejected", explA.rejected);

  // ── Scenario B: trend claim with no prior period ──────────────────────────
  // Only one month in the evidence — "grew" is unsupported

  sep("Scenario B — Trend claim without prior period");
  subsep("Analyst: 'Did orders increase this month?'");

  const poolB: SupportRef[] = [
    {
      id: "ref-b1", sourceId: "orders-2026-02", sourceType: "observation",
      attributes: { metricName: "orders", period: "2026-02", value: 4200, complete: true },
    },
  ];

  const proposalB: Proposal<MetricClaim> = {
    id: "prop-bi-b",
    kind: "response",
    units: [
      // u1: MISSING_BASELINE → downgraded — only one period available
      {
        id: "u1",
        claim: "Order volume increased in February",
        grade: "proven",
        evidenceRefs: ["orders-2026-02"],
        attributes: { assertedTrend: "growth", metric: "orders" },
      },
      // u2: approved — stating the value itself is fine
      {
        id: "u2",
        claim: "February order volume was 4,200",
        grade: "proven",
        evidenceRefs: ["orders-2026-02"],
        attributes: { metric: "orders", period: "2026-02" },
      },
    ],
  };

  const resultB = await harness.admit(proposalB, poolB);
  const explB = harness.explain(resultB);

  console.log("\n  Gate results:");
  for (const u of resultB.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.claim);
    if (u.status === "downgraded") {
      label("    reasonCode", u.evaluationResults[0]?.reasonCode);
      const ann = u.evaluationResults[0]?.annotations as any;
      if (ann?.availablePeriods) label("    availablePeriods", ann.availablePeriods);
    }
  }
  console.log();
  label("approved", explB.approved);
  label("downgraded", explB.downgraded);

  // ── Scenario C: conflicting metric records ────────────────────────────────
  // Two ETL pipelines report different revenue for the same period — blocking conflict

  sep("Scenario C — Conflicting metric records (data pipeline issue)");
  subsep("Two warehouse sources disagree on February revenue");

  const poolC: SupportRef[] = [
    {
      id: "ref-c1", sourceId: "revenue-2026-02-etl-a", sourceType: "observation",
      attributes: { metricName: "revenue", period: "2026-02", value: 110000, complete: true },
    },
    {
      id: "ref-c2", sourceId: "revenue-2026-02-etl-b", sourceType: "observation",
      attributes: { metricName: "revenue", period: "2026-02", value: 113500, complete: true },
    },
  ];

  const proposalC: Proposal<MetricClaim> = {
    id: "prop-bi-c",
    kind: "response",
    units: [
      {
        id: "u1",
        claim: "February revenue was $110,000",
        grade: "proven",
        evidenceRefs: ["revenue-2026-02-etl-a"],
        attributes: { metric: "revenue", period: "2026-02" },
      },
      {
        id: "u2",
        claim: "February revenue was $113,500",
        grade: "proven",
        evidenceRefs: ["revenue-2026-02-etl-b"],
        attributes: { metric: "revenue", period: "2026-02" },
      },
    ],
  };

  const resultC = await harness.admit(proposalC, poolC);
  const explC = harness.explain(resultC);

  console.log("\n  Gate results (METRIC_CONFLICT blocking — both force-rejected):");
  for (const u of resultC.rejectedUnits) {
    label(`  ${u.unitId} [rejected]`, u.evaluationResults[0]?.reasonCode);
    label("    claim", u.unit.claim);
  }
  console.log();
  label("approved", explC.approved);
  label("rejected", explC.rejected);
  label("hasConflicts", resultC.hasConflicts);
  console.log("\n  → LLM will tell the analyst: revenue figures are inconsistent across sources.");
  console.log("    Data engineering review required before this metric can be reported.");
}

main().catch(err => { console.error(err); process.exit(1); });
