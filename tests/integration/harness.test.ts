import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, explainResult } from "../../src/harness.js";
import type { HarnessPolicy } from "../../src/types/policy.js";
import type { ConflictAnnotation } from "../../src/types/gate.js";
import type { Proposal } from "../../src/types/proposal.js";
import type { SupportRef } from "../../src/types/support.js";
import type { AuditEntry, AuditWriter } from "../../src/types/audit.js";

// ---------------------------------------------------------------------------
// Test unit type
// ---------------------------------------------------------------------------

type TestUnit = { id: string; content: string; grade: string };

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeProposal(units: TestUnit[]): Proposal<TestUnit> {
  return { id: `prop-${Date.now()}`, kind: "response", units };
}

const noSupport: SupportRef[] = [];

function makeNoopAuditWriter(): AuditWriter {
  return { append: async (_entry: AuditEntry) => {} };
}

function createMockPolicy(opts: {
  structureValid?: boolean;
  unitDecision?: "approve" | "downgrade" | "reject";
  newGrade?: string;
  conflicts?: ConflictAnnotation[];
  perUnitDecisions?: Array<"approve" | "downgrade" | "reject">;
}): HarnessPolicy<TestUnit> {
  let callCount = 0;
  return {
    validateStructure: () => ({
      kind: "structure",
      valid: opts.structureValid ?? true,
      errors:
        opts.structureValid === false
          ? [{ field: "units", reasonCode: "EMPTY_UNITS" }]
          : [],
    }),
    bindSupport: (unit, pool) => ({ unit, supportIds: pool.map((s) => s.id), supportRefs: pool }),
    evaluateUnit: ({ unit }) => {
      const decision =
        opts.perUnitDecisions !== undefined
          ? (opts.perUnitDecisions[callCount++] ?? "approve")
          : (opts.unitDecision ?? "approve");
      return {
        kind: "unit",
        unitId: unit.id,
        decision,
        reasonCode: decision === "reject" ? "TEST_REJECT" : decision === "downgrade" ? "TEST_DOWNGRADE" : "OK",
        newGrade: decision === "downgrade" ? opts.newGrade : undefined,
      };
    },
    detectConflicts: () => opts.conflicts ?? [],
    render: (units, _pool, _ctx) => ({
      admittedBlocks: units.map((u) => ({
        sourceId: u.unitId,
        content: (u.unit as TestUnit).content,
      })),
      summary: { admitted: units.length, rejected: 0, conflicts: 0 },
    }),
    buildRetryFeedback: (_results, _ctx) => ({
      summary: "retry needed",
      errors: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHarness integration", () => {
  // Test 1: admit() — all approve → admittedUnits non-empty, rejectedUnits empty
  it("Test 1: admit all approve → admittedUnits non-empty, rejectedUnits empty", async () => {
    const harness = createHarness({
      policy: createMockPolicy({ unitDecision: "approve" }),
      auditWriter: makeNoopAuditWriter(),
    });

    const result = await harness.admit(
      makeProposal([
        { id: "u1", content: "hello", grade: "HIGH" },
        { id: "u2", content: "world", grade: "HIGH" },
      ]),
      noSupport
    );

    assert.equal(result.admittedUnits.length, 2);
    assert.equal(result.rejectedUnits.length, 0);
    for (const u of result.admittedUnits) {
      assert.equal(u.status, "approved");
    }
  });

  // Test 2: admit() with reject → rejectedUnits non-empty
  it("Test 2: admit with reject → rejectedUnits non-empty", async () => {
    const harness = createHarness({
      policy: createMockPolicy({ unitDecision: "reject" }),
      auditWriter: makeNoopAuditWriter(),
    });

    const result = await harness.admit(
      makeProposal([{ id: "u1", content: "bad", grade: "LOW" }]),
      noSupport
    );

    assert.equal(result.admittedUnits.length, 0);
    assert.equal(result.rejectedUnits.length, 1);
    assert.equal(result.rejectedUnits[0].status, "rejected");
  });

  // Test 3: admit() with downgrade → status=downgraded, appliedGrades includes newGrade
  it("Test 3: admit with downgrade → status=downgraded, appliedGrades contains newGrade", async () => {
    const harness = createHarness({
      policy: createMockPolicy({ unitDecision: "downgrade", newGrade: "LOW" }),
      auditWriter: makeNoopAuditWriter(),
    });

    const result = await harness.admit(
      makeProposal([{ id: "u1", content: "maybe", grade: "MEDIUM" }]),
      noSupport
    );

    assert.equal(result.admittedUnits.length, 1);
    assert.equal(result.admittedUnits[0].status, "downgraded");
    assert.ok(result.admittedUnits[0].appliedGrades.includes("LOW"));
  });

  // Test 4: admit() with conflict → hasConflicts=true, status=approved_with_conflict
  it("Test 4: admit with conflict → hasConflicts=true, approved_with_conflict", async () => {
    const conflicts: ConflictAnnotation[] = [
      {
        unitIds: ["u1"],
        conflictCode: "TEMPORAL_CONFLICT",
        sources: ["s1"],
        severity: "informational",
        description: "timestamp mismatch",
      },
    ];
    const harness = createHarness({
      policy: createMockPolicy({ conflicts }),
      auditWriter: makeNoopAuditWriter(),
    });

    const result = await harness.admit(
      makeProposal([{ id: "u1", content: "conflict unit", grade: "HIGH" }]),
      noSupport
    );

    assert.equal(result.hasConflicts, true);
    assert.equal(result.admittedUnits.length, 1);
    assert.equal(result.admittedUnits[0].status, "approved_with_conflict");
  });

  // Test 5: render() → VerifiedContext, admittedBlocks count equals admittedUnits count
  it("Test 5: render() → VerifiedContext blocks count matches admittedUnits count", async () => {
    const harness = createHarness({
      policy: createMockPolicy({ unitDecision: "approve" }),
      auditWriter: makeNoopAuditWriter(),
      extractContent: (unit) => unit.content,
    });

    const result = await harness.admit(
      makeProposal([
        { id: "u1", content: "foo", grade: "HIGH" },
        { id: "u2", content: "bar", grade: "HIGH" },
      ]),
      noSupport
    );

    const ctx = harness.render(result);
    assert.equal(ctx.admittedBlocks.length, result.admittedUnits.length);
    assert.equal(ctx.admittedBlocks.length, 2);
  });

  // Test 6: render() on conflict unit → block has conflictNote
  it("Test 6: render() conflict unit → block has conflictNote", async () => {
    const conflicts: ConflictAnnotation[] = [
      {
        unitIds: ["u1"],
        conflictCode: "ATTR_CONFLICT",
        sources: ["s1"],
        severity: "informational",
        description: "attribute mismatch",
      },
    ];
    // Use BaseRenderer by not setting render on policy
    const policy = createMockPolicy({ conflicts });
    // Override render to be undefined so BaseRenderer is used
    const policyWithoutRender = {
      ...policy,
      render: undefined as unknown as HarnessPolicy<TestUnit>["render"],
    };

    const harness = createHarness({
      policy: policyWithoutRender,
      auditWriter: makeNoopAuditWriter(),
      extractContent: (unit) => unit.content,
    });

    const result = await harness.admit(
      makeProposal([{ id: "u1", content: "conflict content", grade: "HIGH" }]),
      noSupport
    );

    const ctx = harness.render(result);
    assert.equal(ctx.admittedBlocks.length, 1);
    assert.ok(ctx.admittedBlocks[0].conflictNote, "conflictNote should be present");
  });

  // Test 7: render() on downgraded unit → block has grade
  it("Test 7: render() downgraded unit → block has grade", async () => {
    const policy = createMockPolicy({ unitDecision: "downgrade", newGrade: "LOW" });
    const policyWithoutRender = {
      ...policy,
      render: undefined as unknown as HarnessPolicy<TestUnit>["render"],
    };

    const harness = createHarness({
      policy: policyWithoutRender,
      auditWriter: makeNoopAuditWriter(),
      extractContent: (unit) => unit.content,
    });

    const result = await harness.admit(
      makeProposal([{ id: "u1", content: "downgraded", grade: "MEDIUM" }]),
      noSupport
    );

    const ctx = harness.render(result);
    assert.equal(ctx.admittedBlocks.length, 1);
    assert.equal(ctx.admittedBlocks[0].grade, "LOW");
  });

  // Test 8: explain() → correct counts (approved/downgraded/rejected/conflicts)
  it("Test 8: explain() → correct counts", async () => {
    // 3 units: u1=approve, u2=downgrade, u3=reject
    const policy = createMockPolicy({
      perUnitDecisions: ["approve", "downgrade", "reject"],
      newGrade: "LOW",
    });

    const harness = createHarness({
      policy,
      auditWriter: makeNoopAuditWriter(),
    });

    const result = await harness.admit(
      makeProposal([
        { id: "u1", content: "a", grade: "HIGH" },
        { id: "u2", content: "b", grade: "MEDIUM" },
        { id: "u3", content: "c", grade: "LOW" },
      ]),
      noSupport
    );

    const explanation = harness.explain(result);
    assert.equal(explanation.totalUnits, 3);
    assert.equal(explanation.approved, 1);
    assert.equal(explanation.downgraded, 1);
    assert.equal(explanation.rejected, 1);
    assert.equal(explanation.conflicts, 0);
  });

  // Test 9: explain() → gateReasonCodes contains all reasonCodes
  it("Test 9: explain() → gateReasonCodes includes all reasonCodes", async () => {
    const policy = createMockPolicy({
      perUnitDecisions: ["approve", "reject"],
    });

    const harness = createHarness({
      policy,
      auditWriter: makeNoopAuditWriter(),
    });

    const result = await harness.admit(
      makeProposal([
        { id: "u1", content: "ok", grade: "HIGH" },
        { id: "u2", content: "bad", grade: "LOW" },
      ]),
      noSupport
    );

    const explanation = harness.explain(result);
    assert.ok(explanation.gateReasonCodes.includes("OK"));
    assert.ok(explanation.gateReasonCodes.includes("TEST_REJECT"));
  });

  // Test 10: admitWithRetry() — mock invoker rejects first, approves second → attempts=2
  it("Test 10: admitWithRetry() first reject, second approve → retryAttempts=2", async () => {
    const policy = createMockPolicy({ unitDecision: "approve" });
    // Policy that rejects first call, approves second
    let invokerCallCount = 0;
    const invoker = async (_prompt: string) => {
      invokerCallCount++;
      if (invokerCallCount === 1) {
        // First call: return a unit that will be rejected
        // We need a policy that rejects first, approves second
        return makeProposal([{ id: "u1", content: "bad-first", grade: "LOW" }]);
      }
      return makeProposal([{ id: "u1", content: "good-second", grade: "HIGH" }]);
    };

    // Policy that rejects on content "bad-first", approves otherwise
    let evalCount = 0;
    const smartPolicy: HarnessPolicy<TestUnit> = {
      ...createMockPolicy({}),
      evaluateUnit: ({ unit }) => {
        const u = unit as TestUnit;
        const decision: "approve" | "reject" =
          u.content === "bad-first" ? "reject" : "approve";
        evalCount++;
        return {
          kind: "unit",
          unitId: u.id,
          decision,
          reasonCode: decision === "reject" ? "BAD_CONTENT" : "OK",
        };
      },
    };

    const harness = createHarness({
      policy: smartPolicy,
      auditWriter: makeNoopAuditWriter(),
      retry: { maxRetries: 3, retryOnDecisions: ["reject"] },
    });

    const result = await harness.admitWithRetry(invoker, noSupport, "test prompt");
    assert.equal(invokerCallCount, 2, "invoker should be called twice");
    assert.equal(result.retryAttempts, 2);
    assert.equal(result.admittedUnits.length, 1);
  });

  // Test 11: admitWithRetry() — maxRetries=0 → invoker called exactly once
  it("Test 11: admitWithRetry() maxRetries=0 → invoker called once", async () => {
    let invokerCallCount = 0;
    const invoker = async (_prompt: string) => {
      invokerCallCount++;
      // Always return rejected unit
      return makeProposal([{ id: "u1", content: "bad", grade: "LOW" }]);
    };

    const harness = createHarness({
      policy: createMockPolicy({ unitDecision: "reject" }),
      auditWriter: makeNoopAuditWriter(),
      retry: { maxRetries: 0, retryOnDecisions: ["reject"] },
    });

    await harness.admitWithRetry(invoker, noSupport, "test prompt");
    assert.equal(invokerCallCount, 1, "invoker should be called exactly once when maxRetries=0");
  });

  // Test 13: render() summary.rejected reflects actual rejectedUnits count
  it("Test 13: render() summary.rejected equals actual rejectedUnits count", async () => {
    // 2 units: u1=approve, u2=reject — policy.render() hardcodes rejected:0, harness must patch it
    const policy = createMockPolicy({
      perUnitDecisions: ["approve", "reject"],
    });

    const harness = createHarness({
      policy,
      auditWriter: makeNoopAuditWriter(),
    });

    const result = await harness.admit(
      makeProposal([
        { id: "u1", content: "good", grade: "HIGH" },
        { id: "u2", content: "bad", grade: "LOW" },
      ]),
      noSupport
    );

    assert.equal(result.admittedUnits.length, 1);
    assert.equal(result.rejectedUnits.length, 1);

    const ctx = harness.render(result);
    assert.equal(ctx.summary.rejected, 1, "summary.rejected must reflect actual rejectedUnits count");
  });

  // Test 12: render() returns VerifiedContext (object with admittedBlocks), not a string
  it("Test 12: render() returns VerifiedContext (non-string, Claude API input)", async () => {
    const harness = createHarness({
      policy: createMockPolicy({ unitDecision: "approve" }),
      auditWriter: makeNoopAuditWriter(),
      extractContent: (unit) => `Verified: ${unit.content}`,
    });

    const result = await harness.admit(
      makeProposal([{ id: "u1", content: "test content", grade: "HIGH" }]),
      noSupport
    );

    const ctx = harness.render(result);

    // Must be an object, not a string
    assert.equal(typeof ctx, "object");
    assert.ok(Array.isArray(ctx.admittedBlocks));
    assert.ok(typeof ctx.summary === "object");
    assert.ok(typeof ctx.summary.admitted === "number");
    // Not a string — confirms it is Claude API input, not user-facing text
    assert.notEqual(typeof ctx, "string");
  });
});
