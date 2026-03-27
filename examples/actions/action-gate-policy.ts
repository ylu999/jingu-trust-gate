/**
 * Irreversible-action gate — action proposal policy for jingu-trust-gate.
 *
 * Use case: an AI assistant can take write-side actions that change the world:
 * send_email, delete_file, publish_post, transfer_funds, archive_thread.
 * Because these are irreversible or high-risk, the gate is stricter than for
 * read-only tool calls: every action needs explicit user authorization, high-risk
 * irreversible actions require user confirmation, and destructive operations
 * require an explicit deletion request.
 *
 * Domain types
 *   ActionProposal    — one proposed irreversible action
 *   ActionContextAttrs — shape of SupportRef.attributes for authorization evidence
 *
 * Gate rules (evaluateUnit)
 *   R1  no evidence of type "explicit_user_request"                           → INTENT_NOT_ESTABLISHED      → reject
 *   R2  riskLevel=high + isReversible=false + no "user_confirmation" evidence → CONFIRM_REQUIRED             → reject
 *   R3  justification is empty or < 20 chars                                  → WEAK_JUSTIFICATION           → reject (not downgrade — actions need strong justification)
 *   R4  actionName contains "delete"|"remove"|"drop" + no explicit deletion request → DESTRUCTIVE_WITHOUT_AUTHORIZATION → reject
 *   R5  everything else                                                        → approve
 *
 * Conflict patterns (detectConflicts)
 *   CONTRADICTORY_ACTIONS  blocking — e.g. send email to user AND delete user's account
 *
 * Run:
 *   npm run build && node dist/examples/action-gate-policy.js
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
import { approve, reject, firstFailing } from "../src/helpers/index.js";

// ── Domain types ──────────────────────────────────────────────────────────────

type RiskLevel = "low" | "medium" | "high";

type ActionProposal = {
  id: string;
  actionName: string;
  parameters: Record<string, unknown>;
  justification: string;
  riskLevel: RiskLevel;
  isReversible: boolean;
  userIntent: string;       // explicit user statement that authorizes this action
  evidenceRefs: string[];
};

// Shape of SupportRef.attributes for authorization evidence
type ActionContextAttrs = {
  contextId: string;
  type: "explicit_user_request" | "user_confirmation" | "prior_context";
  content: string;           // the actual user text
  actionScope?: string;      // what action/resource the user mentioned
};

// Destructive action name patterns.
// Use (?:^|[_\W]) boundaries so "delete_draft" and "remove_user" are matched
// even though underscore is a word character (\b would not split there).
const DESTRUCTIVE_PATTERNS = /(?:^|[_\W])(delete|remove|drop|purge|erase|wipe)(?:[_\W]|$)/i;

// ── Policy ────────────────────────────────────────────────────────────────────

class ActionGatePolicy implements GatePolicy<ActionProposal> {

  validateStructure(proposal: Proposal<ActionProposal>): StructureValidationResult {
    const errors: StructureValidationResult["errors"] = [];

    if (proposal.units.length === 0) {
      errors.push({ field: "units", reasonCode: "EMPTY_PROPOSAL" });
      return { kind: "structure", valid: false, errors };
    }

    for (const unit of proposal.units) {
      if (!unit.id?.trim()) {
        errors.push({ field: "id", reasonCode: "MISSING_UNIT_ID" });
      }
      if (!unit.actionName?.trim()) {
        errors.push({ field: "actionName", reasonCode: "MISSING_ACTION_NAME", message: `unit ${unit.id}` });
      }
      if (!unit.riskLevel) {
        errors.push({ field: "riskLevel", reasonCode: "MISSING_RISK_LEVEL", message: `unit ${unit.id}` });
      }
      if (typeof unit.isReversible !== "boolean") {
        errors.push({ field: "isReversible", reasonCode: "MISSING_REVERSIBILITY", message: `unit ${unit.id}` });
      }
      if (!Array.isArray(unit.evidenceRefs)) {
        errors.push({ field: "evidenceRefs", reasonCode: "MISSING_EVIDENCE_REFS", message: `unit ${unit.id}` });
      }
    }

    return { kind: "structure", valid: errors.length === 0, errors };
  }

  bindSupport(unit: ActionProposal, pool: SupportRef[]): UnitWithSupport<ActionProposal> {
    const matched = pool.filter(s => unit.evidenceRefs.includes(s.sourceId));
    return {
      unit,
      supportIds: matched.map(s => s.id),
      supportRefs: matched,
    };
  }

  evaluateUnit(
    uws: UnitWithSupport<ActionProposal>,
    _ctx: { proposalId: string; proposalKind: string }
  ): UnitEvaluationResult {
    // R3 is checked first: a weak justification is always a hard reject, regardless of other evidence.
    return firstFailing([
      this.#checkJustification(uws),
      this.#checkDestructive(uws),
      this.#checkIntent(uws),
      this.#checkConfirmation(uws),
    ]) ?? approve(uws.unit.id);
  }

  // R3: weak justification is always a hard reject for actions (checked before intent/confirmation).
  // An action with < 20 chars justification cannot be trusted regardless of other evidence.
  #checkJustification({ unit }: UnitWithSupport<ActionProposal>) {
    if (!unit.justification || unit.justification.trim().length < 20) {
      return reject(unit.id, "WEAK_JUSTIFICATION", {
        justificationLength: unit.justification?.trim().length ?? 0,
        note: "Actions require justification of at least 20 characters; this action was not approved",
      });
    }
    return undefined;
  }

  // R4: destructive action names require an explicit_user_request that explicitly mentions
  // deletion/removal — checked BEFORE the generic intent check (R1) so that the more specific
  // error code DESTRUCTIVE_WITHOUT_AUTHORIZATION is surfaced instead of INTENT_NOT_ESTABLISHED.
  #checkDestructive({ unit, supportRefs }: UnitWithSupport<ActionProposal>) {
    if (DESTRUCTIVE_PATTERNS.test(unit.actionName)) {
      const hasDeleteRequest = supportRefs.some(s => {
        const attrs = s.attributes as ActionContextAttrs | undefined;
        if (attrs?.type !== "explicit_user_request") return false;
        return DESTRUCTIVE_PATTERNS.test(attrs.content) ||
               (attrs.actionScope != null && DESTRUCTIVE_PATTERNS.test(attrs.actionScope));
      });
      if (!hasDeleteRequest) {
        return reject(unit.id, "DESTRUCTIVE_WITHOUT_AUTHORIZATION", {
          actionName: unit.actionName,
          note: `"${unit.actionName}" is a destructive operation — explicit user request for deletion/removal is required`,
        });
      }
    }
    return undefined;
  }

  // R1: every action must have at least one explicit_user_request in evidence.
  // Prior context alone is not sufficient authorization.
  #checkIntent({ unit, supportRefs }: UnitWithSupport<ActionProposal>) {
    const hasExplicitRequest = supportRefs.some(s => {
      const attrs = s.attributes as ActionContextAttrs | undefined;
      return attrs?.type === "explicit_user_request";
    });
    if (!hasExplicitRequest) {
      return reject(unit.id, "INTENT_NOT_ESTABLISHED", {
        note: "No explicit_user_request evidence found; actions require direct user authorization",
      });
    }
    return undefined;
  }

  // R2: high-risk irreversible actions require user confirmation (not just a request).
  // riskLevel=high + isReversible=false → must have user_confirmation.
  #checkConfirmation({ unit, supportRefs }: UnitWithSupport<ActionProposal>) {
    if (unit.riskLevel === "high" && !unit.isReversible) {
      const hasConfirmation = supportRefs.some(s => {
        const attrs = s.attributes as ActionContextAttrs | undefined;
        return attrs?.type === "user_confirmation";
      });
      if (!hasConfirmation) {
        return reject(unit.id, "CONFIRM_REQUIRED", {
          riskLevel: unit.riskLevel,
          isReversible: unit.isReversible,
          note: `riskLevel=${unit.riskLevel} + isReversible=false requires user_confirmation evidence (a request alone is not sufficient)`,
        });
      }
    }
    return undefined;
  }

  detectConflicts(
    units: UnitWithSupport<ActionProposal>[],
    _pool: SupportRef[]
  ): ConflictAnnotation[] {
    const conflicts: ConflictAnnotation[] = [];

    // CONTRADICTORY_ACTIONS (blocking):
    // Detect cases where one action targets a resource that another action destroys/removes.
    // e.g. send_email to alice@example.com while also deleting alice's account.
    // Both actions are force-rejected — neither can proceed safely.
    //
    // Strategy: find pairs where:
    //   - one action is destructive (actionName matches DESTRUCTIVE_PATTERNS)
    //   - another action targets the same resource (detected by comparing parameter values)

    const destructiveUnits = units.filter(u => DESTRUCTIVE_PATTERNS.test(u.unit.actionName));
    const nonDestructiveUnits = units.filter(u => !DESTRUCTIVE_PATTERNS.test(u.unit.actionName));

    for (const destructive of destructiveUnits) {
      // Extract all string parameter values from the destructive action
      const destroyedResources = new Set(
        Object.values(destructive.unit.parameters)
          .filter((v): v is string => typeof v === "string")
      );

      for (const active of nonDestructiveUnits) {
        // Check if any parameter of the active action overlaps with destroyed resources
        const activeResources = Object.values(active.unit.parameters)
          .filter((v): v is string => typeof v === "string");
        const overlapping = activeResources.filter(r => destroyedResources.has(r));

        if (overlapping.length > 0) {
          conflicts.push({
            unitIds: [active.unit.id, destructive.unit.id],
            conflictCode: "CONTRADICTORY_ACTIONS",
            sources: [...active.supportIds, ...destructive.supportIds],
            severity: "blocking",
            description:
              `"${active.unit.actionName}" targets resource(s) [${overlapping.join(", ")}] ` +
              `that "${destructive.unit.actionName}" also targets for destruction — both are unsafe to execute`,
          });
        }
      }
    }

    return conflicts;
  }

  render(
    admittedUnits: AdmittedUnit<ActionProposal>[],
    _pool: SupportRef[],
    _ctx: RenderContext
  ): VerifiedContext {
    const admittedBlocks = admittedUnits.map(u => {
      const action = u.unit as ActionProposal;
      const conflict = u.conflictAnnotations?.[0];
      return {
        sourceId: u.unitId,
        content:
          `[${action.riskLevel.toUpperCase()} risk, reversible=${action.isReversible}] ` +
          `${action.actionName}(${JSON.stringify(action.parameters)})`,
        grade: action.riskLevel,
        ...(conflict && {
          conflictNote: `${conflict.conflictCode}: ${conflict.description ?? ""}`,
        }),
      };
    });

    return {
      admittedBlocks,
      summary: {
        admitted: admittedUnits.length,
        rejected: 0, // patched by gate.render()
        conflicts: admittedUnits.filter(u => u.status === "approved_with_conflict").length,
      },
      instructions:
        "Execute only the verified actions below. " +
        "High-risk irreversible actions have already been confirmed by the user. " +
        "Do not re-ask for confirmation for admitted actions. " +
        "NEVER execute actions that were rejected by the gate — they lack proper user authorization. " +
        "If contradictory actions were detected, inform the user and ask for clarification before proceeding.",
    };
  }

  buildRetryFeedback(
    unitResults: UnitEvaluationResult[],
    ctx: RetryContext
  ): RetryFeedback {
    const failed = unitResults.filter(r => r.decision === "reject");
    return {
      summary:
        `${failed.length} action(s) rejected on attempt ${ctx.attempt}/${ctx.maxRetries}. ` +
        `Each action requires explicit user authorization before execution.`,
      errors: failed.map(r => ({
        unitId: r.unitId,
        reasonCode: r.reasonCode,
        details: {
          hint: (() => {
            switch (r.reasonCode) {
              case "INTENT_NOT_ESTABLISHED":
                return "Add an explicit_user_request SupportRef containing the user's direct instruction";
              case "CONFIRM_REQUIRED":
                return "Add a user_confirmation SupportRef before proposing high-risk irreversible actions";
              case "DESTRUCTIVE_WITHOUT_AUTHORIZATION":
                return "Add an explicit_user_request whose content includes a delete/remove/drop instruction";
              case "WEAK_JUSTIFICATION":
                return "Provide a justification of at least 20 characters explaining why this action is necessary";
              default:
                return "Review gate policy requirements for this action type";
            }
          })(),
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
    policy: new ActionGatePolicy(),
    auditWriter: noopAuditWriter(),
  });

  // ── Scenario A: Standard email send + unauthorized delete + archive ─────────
  //
  // User says: "Please send the report to alice@example.com"
  // Agent proposes 3 actions:
  //   - send_email (explicit user request → approved)
  //   - delete_draft (no explicit delete request → DESTRUCTIVE_WITHOUT_AUTHORIZATION → reject)
  //   - archive_thread (medium risk, prior_context present, explicit request → approved)

  sep("Scenario A — Email send, unauthorized delete, archive");
  subsep("User: 'Please send the report to alice@example.com'");

  const poolA: SupportRef[] = [
    {
      id: "ref-a1",
      sourceId: "req-send-001",
      sourceType: "observation",
      attributes: {
        contextId: "req-send-001",
        type: "explicit_user_request",
        content: "Please send the report to alice@example.com",
        actionScope: "send_email",
      } satisfies ActionContextAttrs,
    },
    {
      id: "ref-a2",
      sourceId: "ctx-thread-001",
      sourceType: "observation",
      attributes: {
        contextId: "ctx-thread-001",
        type: "prior_context",
        content: "User has been composing a report draft in thread TH-42 for the past hour",
        actionScope: "archive_thread",
      } satisfies ActionContextAttrs,
    },
    // NOTE: no explicit_user_request for deletion — action-2 will be rejected
  ];

  console.log("\n  Authorization evidence:");
  for (const ref of poolA) {
    const attrs = ref.attributes as ActionContextAttrs;
    label(`  ${ref.sourceId} [${attrs.type}]`, attrs.content);
  }

  const proposalA: Proposal<ActionProposal> = {
    id: "prop-action-001",
    kind: "plan",
    units: [
      // action-1: send_email — explicit user request, low risk → APPROVE
      {
        id: "action-1",
        actionName: "send_email",
        parameters: { to: "alice@example.com", subject: "Q3 Report", attachmentId: "report-q3.pdf" },
        justification: "User explicitly asked to send the Q3 report to alice@example.com; authorization is clear",
        riskLevel: "low",
        isReversible: false,
        userIntent: "Please send the report to alice@example.com",
        evidenceRefs: ["req-send-001"],
      },
      // action-2: delete_draft — no explicit delete request → REJECT (R4 DESTRUCTIVE_WITHOUT_AUTHORIZATION)
      {
        id: "action-2",
        actionName: "delete_draft",
        parameters: { draftId: "draft-q3-v2" },
        justification: "Draft is no longer needed after the report has been sent to the recipient",
        riskLevel: "medium",
        isReversible: false,
        userIntent: "",
        evidenceRefs: ["ctx-thread-001"],   // only prior_context, no explicit delete request
      },
      // action-3: archive_thread — medium risk, explicit request present, good justification → APPROVE
      {
        id: "action-3",
        actionName: "archive_thread",
        parameters: { threadId: "TH-42", reason: "report_sent" },
        justification: "Thread TH-42 is the email chain for this report; archiving it after sending keeps inbox clean",
        riskLevel: "medium",
        isReversible: true,
        userIntent: "Please send the report to alice@example.com",
        evidenceRefs: ["req-send-001", "ctx-thread-001"],
      },
    ],
  };

  subsep("INPUT: proposed actions");
  for (const u of proposalA.units) {
    label(`  ${u.id} [${u.actionName}, risk=${u.riskLevel}, reversible=${u.isReversible}]`, u.justification.slice(0, 60) + "…");
  }

  // ── GATE EXECUTION ─────────────────────────────────────────────────────────

  subsep("GATE EXECUTION");

  const resultA = await gate.admit(proposalA, poolA);
  const contextA = gate.render(resultA, poolA);
  const explA = gate.explain(resultA);

  // ── OUTPUT ─────────────────────────────────────────────────────────────────

  subsep("OUTPUT: gate results");

  console.log("\n  Admitted:");
  for (const u of resultA.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.actionName);
    if (u.conflictAnnotations?.length) {
      label("    conflict", u.conflictAnnotations[0]?.conflictCode);
    }
  }

  console.log("\n  Rejected:");
  for (const u of resultA.rejectedUnits) {
    label(`  ${u.unitId} [${u.evaluationResults[0]?.reasonCode}]`, u.unit.actionName);
    const ann = u.evaluationResults[0]?.annotations as any;
    if (ann?.note) label("    note", ann.note);
  }

  console.log();
  label("totalUnits", explA.totalUnits);
  label("approved", explA.approved);
  label("downgraded", explA.downgraded);
  label("rejected", explA.rejected);
  label("reasonCodes", explA.gateReasonCodes);

  console.log("\n  Verified action blocks:");
  for (const block of contextA.admittedBlocks) {
    label(`  ${block.sourceId}`, block.content);
  }

  // ── ASSERTIONS ─────────────────────────────────────────────────────────────

  subsep("ASSERTIONS");

  // action-1: send_email — explicit request → approved
  const act1 = resultA.admittedUnits.find(u => u.unitId === "action-1");
  assert.ok(act1, "action-1 should be admitted");
  assert.equal(act1.status, "approved");
  pass("action-1 (send_email) approved — explicit_user_request present");

  // action-2: delete_draft — no explicit delete request → rejected DESTRUCTIVE_WITHOUT_AUTHORIZATION
  const act2 = resultA.rejectedUnits.find(u => u.unitId === "action-2");
  assert.ok(act2, "action-2 should be rejected");
  assert.equal(act2.evaluationResults[0]?.reasonCode, "DESTRUCTIVE_WITHOUT_AUTHORIZATION");
  pass("action-2 (delete_draft) rejected (DESTRUCTIVE_WITHOUT_AUTHORIZATION)");

  // action-3: archive_thread — explicit request for send, reversible → approved
  const act3 = resultA.admittedUnits.find(u => u.unitId === "action-3");
  assert.ok(act3, "action-3 should be admitted");
  assert.equal(act3.status, "approved");
  pass("action-3 (archive_thread) approved — explicit request covers intent, medium risk reversible");

  assert.equal(explA.approved, 2);
  assert.equal(explA.rejected, 1);
  pass("summary: 2 approved, 1 rejected");

  // ── Scenario B: High-risk irreversible action without confirmation ──────────
  //
  // User requests a fund transfer — high risk, irreversible.
  // Without a user_confirmation, R2 fires.

  sep("Scenario B — High-risk fund transfer without confirmation");
  subsep("User: 'Transfer $5000 to vendor account V-99'");

  const poolB: SupportRef[] = [
    {
      id: "ref-b1",
      sourceId: "req-transfer-001",
      sourceType: "observation",
      attributes: {
        contextId: "req-transfer-001",
        type: "explicit_user_request",
        content: "Transfer $5000 to vendor account V-99",
        actionScope: "transfer_funds",
      } satisfies ActionContextAttrs,
    },
    // No user_confirmation — R2 will fire for high-risk irreversible
  ];

  const proposalB: Proposal<ActionProposal> = {
    id: "prop-action-002",
    kind: "plan",
    units: [
      {
        id: "action-4",
        actionName: "transfer_funds",
        parameters: { amount: 5000, currency: "USD", destinationAccount: "V-99" },
        justification: "User explicitly requested transfer of $5000 to vendor account V-99 for invoice settlement",
        riskLevel: "high",
        isReversible: false,   // wire transfers cannot be recalled
        userIntent: "Transfer $5000 to vendor account V-99",
        evidenceRefs: ["req-transfer-001"],  // on first attempt: no confirmation ref
      },
    ],
  };

  // Retry proposal that adds confirmation to evidenceRefs
  const proposalBConfirmed: Proposal<ActionProposal> = {
    id: "prop-action-002-retry",
    kind: "plan",
    units: [
      {
        id: "action-4",
        actionName: "transfer_funds",
        parameters: { amount: 5000, currency: "USD", destinationAccount: "V-99" },
        justification: "User explicitly requested transfer of $5000 to vendor account V-99 for invoice settlement",
        riskLevel: "high",
        isReversible: false,
        userIntent: "Transfer $5000 to vendor account V-99",
        evidenceRefs: ["req-transfer-001", "confirm-transfer-001"],  // confirmation added
      },
    ],
  };

  const resultB = await gate.admit(proposalB, poolB);
  const explB = gate.explain(resultB);

  subsep("OUTPUT");
  for (const u of resultB.rejectedUnits) {
    label(`  ${u.unitId} [${u.evaluationResults[0]?.reasonCode}]`, u.unit.actionName);
    const ann = u.evaluationResults[0]?.annotations as any;
    if (ann?.note) label("    note", ann.note);
  }
  label("rejected", explB.rejected);

  subsep("ASSERTIONS");

  const act4 = resultB.rejectedUnits.find(u => u.unitId === "action-4");
  assert.ok(act4, "action-4 should be rejected");
  assert.equal(act4.evaluationResults[0]?.reasonCode, "CONFIRM_REQUIRED");
  pass("action-4 (transfer_funds) rejected (CONFIRM_REQUIRED — high-risk irreversible needs user_confirmation)");

  // Now provide confirmation — same action passes
  const poolBWithConfirm: SupportRef[] = [
    ...poolB,
    {
      id: "ref-b2",
      sourceId: "confirm-transfer-001",
      sourceType: "observation",
      attributes: {
        contextId: "confirm-transfer-001",
        type: "user_confirmation",
        content: "Yes, confirmed. Please proceed with the $5000 transfer to V-99.",
        actionScope: "transfer_funds",
      } satisfies ActionContextAttrs,
    },
  ];

  const resultBConfirmed = await gate.admit(proposalBConfirmed, poolBWithConfirm);
  const explBConfirmed = gate.explain(resultBConfirmed);

  label("approved (with confirmation)", explBConfirmed.approved);

  const act4Confirmed = resultBConfirmed.admittedUnits.find(u => u.unitId === "action-4");
  assert.ok(act4Confirmed, "action-4 should be admitted after confirmation");
  assert.equal(act4Confirmed.status, "approved");
  pass("action-4 (transfer_funds) approved after user_confirmation added");

  // ── Scenario C: Contradictory actions — blocking conflict ───────────────────
  //
  // Agent proposes to send an email to alice@example.com AND delete alice's account.
  // The conflict detector fires and force-rejects both.

  sep("Scenario C — Contradictory actions: send email AND delete account");
  subsep("Same target: alice@example.com appears in both actions");

  const poolC: SupportRef[] = [
    {
      id: "ref-c1",
      sourceId: "req-email-002",
      sourceType: "observation",
      attributes: {
        contextId: "req-email-002",
        type: "explicit_user_request",
        content: "Send Alice a goodbye message and remove her account from the system",
        actionScope: "send_email",
      } satisfies ActionContextAttrs,
    },
    {
      id: "ref-c2",
      sourceId: "req-delete-002",
      sourceType: "observation",
      attributes: {
        contextId: "req-delete-002",
        type: "explicit_user_request",
        content: "Remove Alice's account from the system — she has left the company",
        actionScope: "delete_account",
      } satisfies ActionContextAttrs,
    },
  ];

  const proposalC: Proposal<ActionProposal> = {
    id: "prop-action-003",
    kind: "plan",
    units: [
      // action-5: send_email to alice — explicit request, passes R1-R4
      {
        id: "action-5",
        actionName: "send_email",
        parameters: { to: "alice@example.com", subject: "Farewell", body: "Wishing you all the best." },
        justification: "User asked to send Alice a goodbye message before removing her account from the system",
        riskLevel: "low",
        isReversible: false,
        userIntent: "Send Alice a goodbye message and remove her account",
        evidenceRefs: ["req-email-002"],
      },
      // action-6: delete_account for alice — explicit delete request, passes R1-R4,
      //           but CONTRADICTORY_ACTIONS conflict with action-5 will block both
      {
        id: "action-6",
        actionName: "delete_account",
        parameters: { accountEmail: "alice@example.com", reason: "employee_offboarding" },
        justification: "User explicitly requested removal of Alice's account as she has left the company",
        riskLevel: "high",
        isReversible: false,
        userIntent: "Remove Alice's account from the system — she has left the company",
        evidenceRefs: ["req-delete-002"],
      },
    ],
  };

  // action-6 is high-risk irreversible — needs user_confirmation.
  // Add confirmation so R2 doesn't fire; the test is about the contradictory-action conflict.
  const poolCWithConfirm: SupportRef[] = [
    ...poolC,
    {
      id: "ref-c3",
      sourceId: "confirm-delete-002",
      sourceType: "observation",
      attributes: {
        contextId: "confirm-delete-002",
        type: "user_confirmation",
        content: "Yes, confirmed. Delete Alice's account as part of offboarding.",
        actionScope: "delete_account",
      } satisfies ActionContextAttrs,
    },
  ];

  const resultC = await gate.admit(proposalC, poolCWithConfirm);
  const contextC = gate.render(resultC, poolCWithConfirm);
  const explC = gate.explain(resultC);

  subsep("OUTPUT");

  // CONTRADICTORY_ACTIONS is blocking — both units that pass per-unit evaluation
  // are force-rejected because they target the same resource contradictorily.
  console.log("\n  Admitted:");
  if (resultC.admittedUnits.length === 0) {
    console.log("    (none — all blocked by CONTRADICTORY_ACTIONS conflict)");
  }
  for (const u of resultC.admittedUnits) {
    label(`  ${u.unitId} [${u.status}]`, u.unit.actionName);
  }

  console.log("\n  Rejected:");
  for (const u of resultC.rejectedUnits) {
    label(`  ${u.unitId} [${u.evaluationResults[0]?.reasonCode}]`, u.unit.actionName);
  }

  label("hasConflicts", resultC.hasConflicts);
  label("approved", explC.approved);
  label("rejected", explC.rejected);
  label("conflicts", explC.conflicts);

  console.log(`\n  Instructions: "${contextC.instructions}"`);

  subsep("ASSERTIONS");

  // Both action-5 and action-6 should be rejected due to CONTRADICTORY_ACTIONS
  assert.ok(resultC.hasConflicts, "result should have conflicts");
  pass("CONTRADICTORY_ACTIONS conflict detected");

  // Both force-rejected — contradictory actions cannot proceed
  assert.equal(resultC.rejectedUnits.length, 2, "both actions should be force-rejected");
  pass("both action-5 and action-6 force-rejected (blocking conflict)");

  // No admitted units — gate blocks all
  assert.equal(resultC.admittedUnits.length, 0, "no actions should be admitted");
  pass("no actions admitted — gate blocked all (CONTRADICTORY_ACTIONS is blocking)");

  // VerifiedContext is empty — LLM told to ask for clarification
  assert.equal(contextC.admittedBlocks.length, 0);
  assert.ok(contextC.instructions?.includes("contradictory actions"));
  pass("VerifiedContext empty, instructions tell LLM to surface contradiction to user");

  console.log("\n  Done.\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
