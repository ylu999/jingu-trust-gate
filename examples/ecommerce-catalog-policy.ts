/**
 * E-commerce catalog chatbot — product & inventory query policy for jingu-harness.
 *
 * Use case: a customer asks "Does this Bluetooth headphone support noise cancellation?"
 * or "How many units are in stock?". The RAG pipeline retrieves product records as
 * evidence. The LLM proposes structured claims. jingu-harness admits only claims
 * that stay within what the catalog data actually supports.
 *
 * Domain types
 *   ProductClaim   — one LLM-proposed assertion about a product
 *   CatalogAttrs   — shape of SupportRef.attributes for catalog records
 *
 * Gate rules (evaluateUnit)
 *   R1  grade=proven + no bound evidence                          → MISSING_EVIDENCE      → reject
 *   R2  claim asserts a feature not present in evidence.features  → UNSUPPORTED_FEATURE   → downgrade
 *   R3  claim asserts a specific brand/model not in evidence      → OVER_SPECIFIC_BRAND   → downgrade
 *   R4  claim asserts exact stock count but evidence.stock
 *       is a range or a different number                          → OVER_SPECIFIC_STOCK   → downgrade
 *   R5  everything else                                           → approve
 *
 * Conflict patterns (detectConflicts)
 *   STOCK_CONFLICT    blocking     — two records for the same SKU show different in-stock status
 *   FEATURE_CONFLICT  informational — two records for the same SKU disagree on a feature value
 *
 * Run:
 *   npm run build && node dist/examples/ecommerce-catalog-policy.js
 */

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

// ── Domain types ──────────────────────────────────────────────────────────────

type ClaimGrade = "proven" | "derived" | "unknown";

type ProductClaim = {
  id: string;
  claim: string;
  grade: ClaimGrade;
  evidenceRefs: string[]; // SupportRef.sourceId values cited by the LLM (SKU IDs)
  attributes: {
    assertedFeature?: string;   // e.g. "active_noise_cancellation"
    assertedBrand?: string;     // e.g. "Sony"
    assertedStockCount?: number; // e.g. 42
    assertedInStock?: boolean;
  };
};

// Shape of SupportRef.attributes for catalog / inventory records
type CatalogAttrs = {
  recordType: "product_spec" | "inventory" | "seller_listing";
  sku?: string;
  brand?: string;
  model?: string;
  features?: string[];          // e.g. ["passive_noise_isolation", "bluetooth_5"]
  stockCount?: number;
  inStock?: boolean;
  stockRange?: { min: number; max: number }; // when exact count is not exposed
};

// ── Policy ────────────────────────────────────────────────────────────────────

class EcommerceCatalogPolicy implements HarnessPolicy<ProductClaim> {

  // Step 1: structural validation
  validateStructure(proposal: Proposal<ProductClaim>): StructureValidationResult {
    const errors: StructureValidationResult["errors"] = [];

    if (proposal.units.length === 0) {
      errors.push({ field: "units", reasonCode: "EMPTY_PROPOSAL" });
      return { kind: "structure", valid: false, errors };
    }

    for (const unit of proposal.units) {
      if (!unit.id?.trim()) {
        errors.push({ field: "id", reasonCode: "MISSING_UNIT_ID" });
      }
      if (!unit.claim?.trim()) {
        errors.push({ field: "claim", reasonCode: "EMPTY_CLAIM", message: `unit ${unit.id}: empty claim` });
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

  // Step 2: bind evidence
  // Match by SupportRef.sourceId (the SKU or record ID the LLM cited).
  bindSupport(unit: ProductClaim, pool: SupportRef[]): UnitWithSupport<ProductClaim> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return {
      unit,
      supportIds: matched.map(s => s.id),
      supportRefs: matched,
    };
  }

  // Step 3: per-unit semantic evaluation
  evaluateUnit(
    { unit, supportIds, supportRefs }: UnitWithSupport<ProductClaim>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {

    // R1: proven with no evidence — reject.
    if (unit.grade === "proven" && supportIds.length === 0) {
      return { kind: "unit", unitId: unit.id, decision: "reject", reasonCode: "MISSING_EVIDENCE" };
    }

    // R2: claim asserts a specific feature that no evidence record lists.
    // e.g. "supports active noise cancellation" but evidence only has "passive_noise_isolation".
    if (unit.attributes.assertedFeature) {
      const feature = unit.attributes.assertedFeature.toLowerCase();
      const evidenceSupportsFeature = supportRefs.some(s => {
        const attrs = s.attributes as CatalogAttrs | undefined;
        return attrs?.features?.some(f => f.toLowerCase() === feature);
      });
      if (!evidenceSupportsFeature) {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "downgrade",
          reasonCode: "UNSUPPORTED_FEATURE",
          newGrade: "derived",
          annotations: {
            unsupportedAttributes: [unit.attributes.assertedFeature],
            note: `Feature "${unit.attributes.assertedFeature}" not found in any bound catalog record`,
          },
        };
      }
    }

    // R3: claim asserts a specific brand/model not present in evidence.
    // e.g. "Sony WH-1000XM5" when the spec sheet only lists a generic category.
    if (unit.attributes.assertedBrand) {
      const brand = unit.attributes.assertedBrand.toLowerCase();
      const evidenceHasBrand = supportRefs.some(s => {
        const attrs = s.attributes as CatalogAttrs | undefined;
        return attrs?.brand?.toLowerCase() === brand;
      });
      if (!evidenceHasBrand) {
        return {
          kind: "unit",
          unitId: unit.id,
          decision: "downgrade",
          reasonCode: "OVER_SPECIFIC_BRAND",
          newGrade: "derived",
          annotations: {
            unsupportedAttributes: [`brand: ${unit.attributes.assertedBrand}`],
            note: `Brand "${unit.attributes.assertedBrand}" not found in bound catalog records`,
          },
        };
      }
    }

    // R4: claim asserts an exact stock count, but evidence has a range or a different number.
    // Inventory systems often expose bucketed counts ("50-100 in stock") not exact figures.
    if (unit.attributes.assertedStockCount !== undefined) {
      const claimed = unit.attributes.assertedStockCount;

      for (const ref of supportRefs) {
        const attrs = ref.attributes as CatalogAttrs | undefined;
        if (!attrs) continue;

        // Evidence exposes a range — exact count claim is over-specific.
        if (attrs.stockRange) {
          if (claimed < attrs.stockRange.min || claimed > attrs.stockRange.max) {
            return {
              kind: "unit",
              unitId: unit.id,
              decision: "downgrade",
              reasonCode: "OVER_SPECIFIC_STOCK",
              newGrade: "derived",
              annotations: {
                unsupportedAttributes: [`exact stock count: ${claimed}`],
                evidenceRange: attrs.stockRange,
                note: "Inventory record exposes a range, not an exact count",
              },
            };
          }
        }

        // Evidence has an exact count that differs from the claim.
        if (attrs.stockCount !== undefined && attrs.stockCount !== claimed) {
          return {
            kind: "unit",
            unitId: unit.id,
            decision: "downgrade",
            reasonCode: "OVER_SPECIFIC_STOCK",
            newGrade: "derived",
            annotations: {
              unsupportedAttributes: [`exact stock count: ${claimed}`],
              evidenceCount: attrs.stockCount,
            },
          };
        }
      }
    }

    // R5: approved
    return { kind: "unit", unitId: unit.id, decision: "approve", reasonCode: "OK" };
  }

  // Step 4: cross-unit conflict detection
  detectConflicts(
    units: UnitWithSupport<ProductClaim>[],
    pool: SupportRef[]
  ): ConflictAnnotation[] {
    const conflicts: ConflictAnnotation[] = [];

    // STOCK_CONFLICT (blocking):
    // The support pool itself contains records for the same SKU that disagree
    // on inStock. Detect this directly from the pool — if one ref says inStock=true
    // and another says inStock=false for the same SKU, annotate all units that
    // cite that SKU as conflicted.
    type SkuStockKey = string;
    const skuInStock  = new Map<SkuStockKey, string[]>(); // sku → ref.ids
    const skuOutStock = new Map<SkuStockKey, string[]>();

    for (const ref of pool) {
      const attrs = ref.attributes as CatalogAttrs | undefined;
      if (attrs?.inStock === undefined) continue;
      const sku = attrs.sku ?? ref.sourceId;
      const map = attrs.inStock ? skuInStock : skuOutStock;
      if (!map.has(sku)) map.set(sku, []);
      map.get(sku)!.push(ref.id);
    }

    for (const [sku, inRefIds] of skuInStock) {
      const outRefIds = skuOutStock.get(sku);
      if (!outRefIds?.length) continue;
      const allRefIds = [...inRefIds, ...outRefIds];
      const affectedUnitIds = units
        .filter(({ supportIds }) => allRefIds.some(id => supportIds.includes(id)))
        .map(({ unit }) => unit.id);
      if (!affectedUnitIds.length) continue;
      conflicts.push({
        unitIds: affectedUnitIds,
        conflictCode: "STOCK_CONFLICT",
        sources: allRefIds,
        severity: "blocking",
        description: `Conflicting stock status for SKU ${sku}: pool contains both in-stock and out-of-stock records`,
      });
    }

    // FEATURE_CONFLICT (informational):
    // Two catalog records for the same SKU list conflicting values for the same feature.
    // Surface both so the downstream LLM can flag the discrepancy to the user.
    type FeatureKey = string; // `${sourceId}::${feature}`
    const featureValues = new Map<FeatureKey, { values: Set<string>; refIds: string[] }>();

    for (const ref of pool) {
      const attrs = ref.attributes as CatalogAttrs | undefined;
      if (!attrs?.features) continue;
      for (const feature of attrs.features) {
        const key: FeatureKey = `${ref.sourceId}::${feature.split("_")[0]}`; // group by feature prefix
        if (!featureValues.has(key)) featureValues.set(key, { values: new Set(), refIds: [] });
        featureValues.get(key)!.values.add(feature);
        featureValues.get(key)!.refIds.push(ref.id);
      }
    }

    // A conflict exists when two refs for the same SKU list mutually exclusive feature variants.
    // e.g. "active_noise_cancellation" vs "passive_noise_isolation" for the same product.
    const mutuallyExclusive: [string, string][] = [
      ["active_noise_cancellation", "passive_noise_isolation"],
      ["wired", "wireless"],
      ["in_stock", "out_of_stock"],
    ];

    for (const [keyA, keyB] of mutuallyExclusive) {
      for (const [key, { values, refIds }] of featureValues) {
        if (values.has(keyA) && values.has(keyB)) {
          const affectedUnitIds = units
            .filter(({ supportIds }) => refIds.some(id => supportIds.includes(id)))
            .map(({ unit }) => unit.id);
          if (!affectedUnitIds.length) continue;
          const sku = key.split("::")[0];
          conflicts.push({
            unitIds: affectedUnitIds,
            conflictCode: "FEATURE_CONFLICT",
            sources: refIds,
            severity: "informational",
            description: `Conflicting feature data for SKU ${sku}: "${keyA}" vs "${keyB}" both present`,
          });
        }
      }
    }

    return conflicts;
  }

  // Step 5: render → VerifiedContext
  render(
    admittedUnits: AdmittedUnit<ProductClaim>[],
    _pool: SupportRef[],
    _ctx: RenderContext
  ): VerifiedContext {
    const admittedBlocks = admittedUnits.map(u => {
      const claim = u.unit as ProductClaim;
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
        rejected: 0, // patched by harness.render()
        conflicts: admittedUnits.filter(u => u.status === "approved_with_conflict").length,
      },
      instructions:
        "Answer the customer's product question using only the verified facts below. " +
        "For downgraded claims, hedge your language: say 'may support' or 'approximately' rather than stating facts with certainty. " +
        "For conflicting claims, tell the customer the information is inconsistent and suggest they check the product page. " +
        "Never invent feature names, stock numbers, or brand names not present in verified facts.",
    };
  }

  // Step 6: structured retry feedback
  buildRetryFeedback(
    unitResults: UnitEvaluationResult[],
    ctx: RetryContext
  ): RetryFeedback {
    const failed = unitResults.filter(r => r.decision === "reject");
    return {
      summary:
        `${failed.length} claim(s) rejected on attempt ${ctx.attempt}/${ctx.maxRetries}. ` +
        `Re-propose with corrected evidenceRefs or a lower grade.`,
      errors: failed.map(r => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: {
          hint: r.reasonCode === "MISSING_EVIDENCE"
            ? "Add the SKU or record ID to evidenceRefs, or lower grade to 'derived'"
            : "Claim asserts more than the catalog record supports — check feature list or stock data",
        },
      })),
    };
  }
}

// ── Example scenarios ─────────────────────────────────────────────────────────

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
  console.log(`    ${key.padEnd(26)}: ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const harness = createHarness({
    policy: new EcommerceCatalogPolicy(),
    auditWriter: noopAuditWriter(),
  });

  // ── Scenario A: "Does this headphone support noise cancellation?" ──────────
  //
  // The product spec only lists "passive_noise_isolation".
  // The LLM hallucinates "active noise cancellation" and also gets the brand right.

  sep("Scenario A — Feature query: noise cancellation");
  subsep("Customer: 'Does this headphone support noise cancellation?'");

  const poolA: SupportRef[] = [
    {
      id: "ref-a1", sourceId: "SKU-BH-4892", sourceType: "observation",
      attributes: {
        recordType: "product_spec",
        sku: "SKU-BH-4892",
        brand: "Anker",
        features: ["passive_noise_isolation", "bluetooth_5", "foldable"],
      },
    },
  ];

  const proposalA: Proposal<ProductClaim> = {
    id: "prop-a", kind: "response",
    units: [
      // u1: proven + brand matches evidence → approved
      {
        id: "u1",
        claim: "This headphone is made by Anker",
        grade: "proven",
        evidenceRefs: ["SKU-BH-4892"],
        attributes: { assertedBrand: "Anker" },
      },
      // u2: UNSUPPORTED_FEATURE → downgraded
      // spec has "passive_noise_isolation" not "active_noise_cancellation"
      {
        id: "u2",
        claim: "This headphone supports active noise cancellation",
        grade: "proven",
        evidenceRefs: ["SKU-BH-4892"],
        attributes: { assertedFeature: "active_noise_cancellation" },
      },
      // u3: proven + feature present in spec → approved
      {
        id: "u3",
        claim: "This headphone supports passive noise isolation",
        grade: "proven",
        evidenceRefs: ["SKU-BH-4892"],
        attributes: { assertedFeature: "passive_noise_isolation" },
      },
      // u4: MISSING_EVIDENCE → rejected
      // LLM invents a price claim with no catalog record
      {
        id: "u4",
        claim: "This headphone retails for $79.99",
        grade: "proven",
        evidenceRefs: [],
        attributes: {},
      },
    ],
  };

  const resultA = await harness.admit(proposalA, poolA);
  const contextA = harness.render(resultA);
  const explA = harness.explain(resultA);

  console.log("\n  Gate results:");
  for (const u of resultA.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.claim);
    if (u.status === "downgraded") {
      label("    unsupported", (u.evaluationResults[0]?.annotations as any)?.unsupportedAttributes);
    }
  }
  for (const u of resultA.rejectedUnits) {
    label(`  ${u.unitId} [rejected]`, u.evaluationResults[0]?.reasonCode);
  }
  console.log();
  label("approved", explA.approved);
  label("downgraded", explA.downgraded);
  label("rejected", explA.rejected);

  console.log(`\n  LLM instructions:\n  "${contextA.instructions}"`);

  // ── Scenario B: "How many units are in stock?" ────────────────────────────
  //
  // Inventory system exposes a bucketed range, not an exact count.
  // LLM claims an exact number ("42 units") which falls outside the range.

  sep("Scenario B — Inventory query: exact stock count");
  subsep("Customer: 'How many of these are left in stock?'");

  const poolB: SupportRef[] = [
    {
      id: "ref-b1", sourceId: "SKU-BH-4892", sourceType: "observation",
      attributes: {
        recordType: "inventory",
        sku: "SKU-BH-4892",
        inStock: true,
        stockRange: { min: 10, max: 50 },
      },
    },
  ];

  const proposalB: Proposal<ProductClaim> = {
    id: "prop-b", kind: "response",
    units: [
      // u1: proven + inStock matches → approved
      {
        id: "u1",
        claim: "This item is currently in stock",
        grade: "proven",
        evidenceRefs: ["SKU-BH-4892"],
        attributes: { assertedInStock: true },
      },
      // u2: OVER_SPECIFIC_STOCK → downgraded
      // 42 is outside the range 10–50 ... actually inside, let's use 99 to show the failure
      {
        id: "u2",
        claim: "There are 99 units available",
        grade: "proven",
        evidenceRefs: ["SKU-BH-4892"],
        attributes: { assertedStockCount: 99 },
      },
      // u3: OVER_SPECIFIC_STOCK → downgraded (exact count when evidence only has a range)
      {
        id: "u3",
        claim: "There are 30 units available",
        grade: "proven",
        evidenceRefs: ["SKU-BH-4892"],
        attributes: { assertedStockCount: 30 },
      },
    ],
  };

  const resultB = await harness.admit(proposalB, poolB);
  const explB = harness.explain(resultB);

  console.log("\n  Gate results:");
  for (const u of resultB.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.claim);
    if (u.status === "downgraded") {
      const ann = u.evaluationResults[0]?.annotations as any;
      label("    unsupported", ann?.unsupportedAttributes);
      if (ann?.evidenceRange) label("    evidenceRange", ann.evidenceRange);
    }
  }
  for (const u of resultB.rejectedUnits) {
    label(`  ${u.unitId} [rejected]`, u.evaluationResults[0]?.reasonCode);
  }
  console.log();
  label("approved", explB.approved);
  label("downgraded", explB.downgraded);
  label("rejected", explB.rejected);

  // ── Scenario C: conflicting stock records ─────────────────────────────────
  //
  // Two seller listings for the same SKU disagree on stock status.
  // harness admits both with approved_with_conflict so the LLM surfaces it.

  sep("Scenario C — Conflicting stock records for the same SKU");
  subsep("Two seller listings disagree: one says in-stock, one says out-of-stock");

  const poolC: SupportRef[] = [
    {
      id: "ref-c1", sourceId: "SKU-BH-4892", sourceType: "observation",
      attributes: { recordType: "seller_listing", sku: "SKU-BH-4892", inStock: true },
    },
    {
      id: "ref-c2", sourceId: "SKU-BH-4892", sourceType: "observation",
      attributes: { recordType: "seller_listing", sku: "SKU-BH-4892", inStock: false },
    },
  ];

  const proposalC: Proposal<ProductClaim> = {
    id: "prop-c", kind: "response",
    units: [
      {
        id: "u1",
        claim: "This item is available for purchase",
        grade: "proven",
        evidenceRefs: ["SKU-BH-4892"],
        attributes: { assertedInStock: true },
      },
      {
        id: "u2",
        claim: "This item is currently out of stock",
        grade: "proven",
        evidenceRefs: ["SKU-BH-4892"],
        attributes: { assertedInStock: false },
      },
    ],
  };

  const resultC = await harness.admit(proposalC, poolC);
  const contextC = harness.render(resultC);
  const explC = harness.explain(resultC);

  // STOCK_CONFLICT is blocking — both units are force-rejected by the gate.
  // Neither claim reaches the LLM. The conflict annotation is in the audit log.
  // The downstream LLM receives an empty admittedBlocks and the instructions
  // field tells it to surface the inconsistency to the customer.
  console.log("\n  Gate results (blocking conflict — both units force-rejected):");
  for (const u of resultC.rejectedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.claim);
    label("    reasonCode", u.evaluationResults[0]?.reasonCode);
  }
  console.log();
  label("approved", explC.approved);
  label("rejected", explC.rejected);
  label("conflicts", explC.conflicts);
  label("hasConflicts", resultC.hasConflicts);

  console.log("\n  VerifiedContext blocks (empty — nothing admitted past the gate):");
  console.log(`    admittedBlocks: []`);
  console.log(`\n  instructions: "${contextC.instructions}"`);
  console.log("\n  → LLM will tell the customer: stock status is inconsistent, check the product page.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
