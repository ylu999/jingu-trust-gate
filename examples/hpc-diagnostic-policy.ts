/**
 * HPC GPU cluster — SRE incident investigation policy for jingu-harness.
 *
 * Use case: an agent collects kernel logs, DCGM metrics, k8s events, and
 * PyTorch logs from a failed training job, packages them as a SupportRef pool,
 * then asks an LLM to propose structured DiagnosticClaims. jingu-harness
 * admits only claims that stay within what the evidence actually supports.
 *
 * Domain types
 *   DiagnosticClaim  — one LLM-proposed assertion about the incident
 *   ObsAttributes    — shape of SupportRef.attributes for HPC observations
 *
 * Gate rules (evaluateUnit)
 *   R1/R2  grade=proven|derived + no bound evidence  → MISSING_EVIDENCE  → reject
 *   R3     "permanently damaged / must be replaced"  → UNSUPPORTED_SEVERITY → downgrade
 *          without a confirmed-loss signal (nvml/dmesg "GPU lost")
 *   R4     "all nodes / all other nodes / entire cluster" but pool covers  → UNSUPPORTED_SCOPE → downgrade
 *          fewer than 2 distinct nodes
 *   R5     specific numeric value in claim does not match evidence.value   → OVER_SPECIFIC_METRIC → downgrade
 *   R6     everything else                                                 → approve
 *
 * Conflict patterns (detectConflicts)
 *   NODE_HEALTH_CONFLICT      blocking     — same node claimed both healthy and failed
 *   TEMPORAL_METRIC_CONFLICT  informational — same node+metric has two different values in pool
 *
 * Run:
 *   npm run build && node dist/examples/hpc-diagnostic-policy.js
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

type ClaimGrade = "proven" | "derived" | "suspected";

type DiagnosticClaim = {
  id: string;
  claim: string;
  grade: ClaimGrade;
  evidenceRefs: string[]; // SupportRef.sourceId values cited by the LLM
};

type ObsAttributes = {
  sourceType: "kernel_log" | "dcgm_metric" | "k8s_event" | "pytorch_log" | "nvml" | "dmesg";
  message?: string;
  metric?: string;
  value?: number;
  threshold?: number;
  nodeId?: string;
};

// ── Policy ────────────────────────────────────────────────────────────────────

class HpcDiagnosticPolicy implements HarnessPolicy<DiagnosticClaim> {

  // Step 1: structural validation
  // Reject proposals missing required fields before any evidence binding occurs.
  validateStructure(proposal: Proposal<DiagnosticClaim>): StructureValidationResult {
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
  // Match SupportRefs whose sourceId appears in the LLM's cited evidenceRefs.
  bindSupport(unit: DiagnosticClaim, pool: SupportRef[]): UnitWithSupport<DiagnosticClaim> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return {
      unit,
      supportIds: matched.map(s => s.id),
      supportRefs: matched,
    };
  }

  // Step 3: per-unit semantic evaluation
  evaluateUnit(
    { unit, supportIds, supportRefs }: UnitWithSupport<DiagnosticClaim>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    const claimLower = unit.claim.toLowerCase();

    // R1/R2: proven or derived with no bound evidence — reject.
    // "suspected" is already a hedged grade; rejecting it would push the LLM
    // toward using "proven" instead, which is worse.
    if (supportIds.length === 0 && unit.grade !== "suspected") {
      return { kind: "unit", unitId: unit.id, decision: "reject", reasonCode: "MISSING_EVIDENCE" };
    }

    if (unit.grade === "proven" || unit.grade === "derived") {

      // R3: permanence / replacement assertions need a confirmed-loss signal.
      // An ECC threshold breach or Xid event indicates a problem but does not
      // confirm permanent damage — that requires nvml or dmesg "GPU lost".
      const permanencePhrases = [
        "permanently damaged", "must be replaced", "needs replacement",
        "needs rma", "rma required", "hardware failure confirmed", "replace the gpu",
      ];
      if (permanencePhrases.some(p => claimLower.includes(p))) {
        const hasConfirmedLoss = supportRefs.some(s => {
          const attrs = s.attributes as ObsAttributes | undefined;
          if (!attrs) return false;
          return (
            (attrs.sourceType === "nvml" && attrs.message?.toLowerCase().includes("lost")) ||
            (attrs.sourceType === "dmesg" && attrs.message?.toLowerCase().includes("gpu lost"))
          );
        });
        if (!hasConfirmedLoss) {
          return {
            kind: "unit",
            unitId: unit.id,
            decision: "downgrade",
            reasonCode: "UNSUPPORTED_SEVERITY",
            newGrade: "derived",
            annotations: {
              unsupportedAttributes: ["permanently damaged / must be replaced"],
              note: "ECC threshold breach or Xid requires hardware diagnostics to confirm permanent damage",
            },
          };
        }
      }

      // R4: cluster-wide scope claims require multi-node coverage in the pool.
      // If the pool only contains observations for one node, "all nodes" is unsupported.
      const scopePhrases = ["all nodes", "all other nodes", "entire cluster", "every node", "cluster-wide"];
      if (scopePhrases.some(p => claimLower.includes(p))) {
        const coveredNodes = new Set(supportRefs.map(s => s.sourceId));
        if (coveredNodes.size < 2) {
          return {
            kind: "unit",
            unitId: unit.id,
            decision: "downgrade",
            reasonCode: "UNSUPPORTED_SCOPE",
            newGrade: "derived",
            annotations: {
              unsupportedAttributes: ["all nodes / all other nodes / entire cluster"],
              coveredNodes: Array.from(coveredNodes),
              note: "Scope claim exceeds evidence coverage in support pool",
            },
          };
        }
      }

      // R5: specific numeric value in the claim must match evidence.
      // e.g. "847 ECC errors" when evidence shows value=2 → over-specific.
      const numericMatch = unit.claim.match(/\b(\d+)\s*(ecc errors?|errors?|gpus?|nodes?|ranks?)/i);
      if (numericMatch) {
        const claimedValue = parseInt(numericMatch[1], 10);
        const evidenceValues = supportRefs
          .map(s => (s.attributes as ObsAttributes | undefined)?.value)
          .filter((v): v is number => v !== undefined);
        if (evidenceValues.length > 0 && !evidenceValues.includes(claimedValue)) {
          return {
            kind: "unit",
            unitId: unit.id,
            decision: "downgrade",
            reasonCode: "OVER_SPECIFIC_METRIC",
            newGrade: "derived",
            annotations: { claimedValue, evidenceValues },
          };
        }
      }
    }

    // R6: approved
    return { kind: "unit", unitId: unit.id, decision: "approve", reasonCode: "OK" };
  }

  // Step 4: cross-unit conflict detection
  detectConflicts(
    units: UnitWithSupport<DiagnosticClaim>[],
    pool: SupportRef[]
  ): ConflictAnnotation[] {
    const conflicts: ConflictAnnotation[] = [];

    // NODE_HEALTH_CONFLICT (blocking):
    // A claim that a node is healthy directly contradicts a claim that it
    // has a hardware failure. The downstream LLM cannot use both.
    const healthyByNode = new Map<string, string[]>();
    const failedByNode  = new Map<string, string[]>();

    for (const { unit, supportRefs } of units) {
      const c = unit.claim.toLowerCase();
      const isHealthy = c.includes("healthy") || c.includes("no errors") || c.includes("no issues");
      const isFailed  = c.includes("hardware failure") || c.includes("fallen off the bus") ||
                        c.includes("xid") || c.includes("ecc error");

      for (const ref of supportRefs) {
        const node = ref.sourceId;
        if (isHealthy) {
          if (!healthyByNode.has(node)) healthyByNode.set(node, []);
          healthyByNode.get(node)!.push(unit.id);
        }
        if (isFailed) {
          if (!failedByNode.has(node)) failedByNode.set(node, []);
          failedByNode.get(node)!.push(unit.id);
        }
      }
    }

    for (const [node, healthyIds] of healthyByNode) {
      const failedIds = failedByNode.get(node);
      if (failedIds?.length) {
        conflicts.push({
          unitIds: [...healthyIds, ...failedIds],
          conflictCode: "NODE_HEALTH_CONFLICT",
          sources: pool.filter(s => s.sourceId === node).map(s => s.id),
          severity: "blocking",
          description: `Conflicting health assertions for ${node}: both healthy and failed claimed`,
        });
      }
    }

    // TEMPORAL_METRIC_CONFLICT (informational):
    // The same metric on the same node has two different values in the pool.
    // Both are real observations (different timestamps or sampling windows);
    // surface both so the downstream LLM can report the discrepancy.
    type MetricKey = string; // `${sourceId}::${metric}`
    const metricMap = new Map<MetricKey, { values: Set<number>; refIds: string[] }>();

    for (const ref of pool) {
      const attrs = ref.attributes as ObsAttributes | undefined;
      if (!attrs?.metric || attrs.value === undefined) continue;
      const key: MetricKey = `${ref.sourceId}::${attrs.metric}`;
      if (!metricMap.has(key)) metricMap.set(key, { values: new Set(), refIds: [] });
      metricMap.get(key)!.values.add(attrs.value);
      metricMap.get(key)!.refIds.push(ref.id);
    }

    for (const [key, { values, refIds }] of metricMap) {
      if (values.size <= 1) continue;
      const affectedUnitIds = units
        .filter(({ supportIds }) => refIds.some(id => supportIds.includes(id)))
        .map(({ unit }) => unit.id);
      if (!affectedUnitIds.length) continue;
      const [nodeId, metric] = key.split("::");
      conflicts.push({
        unitIds: affectedUnitIds,
        conflictCode: "TEMPORAL_METRIC_CONFLICT",
        sources: refIds,
        severity: "informational",
        description: `${metric} on ${nodeId} has conflicting values in pool: [${Array.from(values).join(", ")}]`,
      });
    }

    return conflicts;
  }

  // Step 5: render admitted units → VerifiedContext
  // Each block maps to one admitted claim. Downgrade annotations and conflict
  // notes are inlined so the downstream LLM knows what it can and cannot assert.
  render(
    admittedUnits: AdmittedUnit<DiagnosticClaim>[],
    _pool: SupportRef[],
    _ctx: RenderContext
  ): VerifiedContext {
    const admittedBlocks = admittedUnits.map(u => {
      const claim = u.unit as DiagnosticClaim;
      const currentGrade = u.appliedGrades[u.appliedGrades.length - 1];
      const conflict = u.conflictAnnotations?.[0];

      return {
        sourceId: u.unitId,
        content: claim.claim,
        grade: currentGrade ?? claim.grade,
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
        "Generate an incident report. " +
        "For downgraded claims (grade=derived), hedge your language: say 'evidence suggests' not 'confirmed'. " +
        "For conflicting claims, surface the conflict explicitly — do not silently pick one side. " +
        "Do not assert permanent hardware damage unless grade=proven.",
    };
  }

  // Step 6: structured retry feedback
  // Tells the LLM exactly which claims were rejected and how to fix them.
  buildRetryFeedback(
    unitResults: UnitEvaluationResult[],
    ctx: RetryContext
  ): RetryFeedback {
    const failed = unitResults.filter(r => r.decision === "reject");
    return {
      summary:
        `${failed.length} claim(s) rejected on attempt ${ctx.attempt}/${ctx.maxRetries}. ` +
        `Re-propose with corrected evidenceRefs or a lower grade (derived/suspected).`,
      errors: failed.map(r => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: {
          hint: r.reasonCode === "MISSING_EVIDENCE"
            ? "Add at least one SupportRef sourceId to evidenceRefs, or lower grade to 'suspected'"
            : "Claim asserts more than evidence supports — lower grade or remove unsupported attributes",
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
  console.log(`    ${key.padEnd(24)}: ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const harness = createHarness({
    policy: new HpcDiagnosticPolicy(),
    auditWriter: noopAuditWriter(),
  });

  // Support pool: evidence collected by the SRE agent from node logs and metrics
  const supportPool: SupportRef[] = [
    {
      id: "ref-001", sourceId: "node-gpu-07", sourceType: "observation",
      attributes: { sourceType: "kernel_log", message: "Xid 79: GPU has fallen off the bus" },
    },
    {
      id: "ref-002", sourceId: "node-gpu-07", sourceType: "observation",
      attributes: { sourceType: "dcgm_metric", metric: "GPU_MEMORY_ECC_ERRORS", value: 847, threshold: 100 },
    },
    {
      id: "ref-003", sourceId: "job-447", sourceType: "observation",
      attributes: { sourceType: "pytorch_log", message: "NCCL error: unhandled system error", rank: 3 },
    },
    {
      id: "ref-004", sourceId: "job-447", sourceType: "observation",
      attributes: { sourceType: "pytorch_log", message: "Watchdog caught collective operation timeout" },
    },
    {
      id: "ref-005", sourceId: "node-gpu-05", sourceType: "observation",
      attributes: { sourceType: "dcgm_metric", metric: "GPU_MEMORY_ECC_ERRORS", value: 2, threshold: 100 },
    },
  ];

  // Proposal: LLM-proposed claims about the failed training job
  const proposal: Proposal<DiagnosticClaim> = {
    id: "prop-hpc-001",
    kind: "response",
    units: [
      // u1: proven + direct evidence → approved
      {
        id: "u1",
        claim: "node-gpu-07 experienced a hardware GPU failure (Xid 79)",
        grade: "proven",
        evidenceRefs: ["node-gpu-07"],
      },
      // u2: derived causal chain → approved (grade=derived is appropriate for inference)
      {
        id: "u2",
        claim: "NCCL rank 3 dropped due to GPU failure on node-gpu-07, triggering collective timeout",
        grade: "derived",
        evidenceRefs: ["node-gpu-07", "job-447"],
      },
      // u3: UNSUPPORTED_SEVERITY → downgraded
      // ECC errors show a problem but do not confirm permanent damage
      {
        id: "u3",
        claim: "node-gpu-07 GPU is permanently damaged and must be replaced",
        grade: "proven",
        evidenceRefs: ["node-gpu-07"],
      },
      // u4: UNSUPPORTED_SCOPE → downgraded
      // Pool only has node-gpu-05 data; other 6 nodes have no observations
      {
        id: "u4",
        claim: "All other nodes in the job are healthy",
        grade: "proven",
        evidenceRefs: ["node-gpu-05"],
      },
      // u5: MISSING_EVIDENCE → rejected
      // grade=proven but evidenceRefs is empty
      {
        id: "u5",
        claim: "The training job had been running stably for 2 hours before failure",
        grade: "proven",
        evidenceRefs: [],
      },
    ],
  };

  const result = await harness.admit(proposal, supportPool);
  const context = harness.render(result);
  const explanation = harness.explain(result);

  sep("HPC Diagnostic Policy — Admission Result");

  console.log("\n  Admitted units:");
  for (const u of result.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.claim.slice(0, 60) + "...");
    if (u.status === "downgraded") {
      const attrs = (u.evaluationResults[0]?.annotations as any)?.unsupportedAttributes;
      label("    unsupportedAttributes", attrs);
    }
  }

  console.log("\n  Rejected units:");
  for (const u of result.rejectedUnits) {
    label(`  ${u.unitId} [rejected]`, u.evaluationResults[0]?.reasonCode);
  }

  sep("Explanation");
  label("approved", explanation.approved);
  label("downgraded", explanation.downgraded);
  label("rejected", explanation.rejected);
  label("conflicts", explanation.conflicts);
  label("retryAttempts", explanation.retryAttempts);

  sep("VerifiedContext (input to incident report LLM)");
  for (const block of context.admittedBlocks) {
    label(`${block.sourceId} [${block.grade}]`, block.content.slice(0, 55) + "...");
    if (block.unsupportedAttributes?.length) {
      label("  unsupported", block.unsupportedAttributes);
    }
  }
  console.log(`\n  instructions: ${context.instructions}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
