import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { GateRunner } from "../../../src/gate/gate-runner.js";
import type { GatePolicy } from "../../../src/types/policy.js";
import type { ConflictAnnotation } from "../../../src/types/gate.js";
import type { Proposal } from "../../../src/types/proposal.js";
import type { SupportRef } from "../../../src/types/support.js";
import type { AuditWriter, AuditEntry } from "../../../src/types/audit.js";

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

type TestUnit = { id: string; content: string };

function makeProposal(units: TestUnit[]): Proposal<TestUnit> {
  return { id: "prop-1", kind: "response", units };
}

const emptySupportPool: SupportRef[] = [];
const someSupportPool: SupportRef[] = [
  { id: "s1", sourceType: "db", sourceId: "doc-1" },
];

function makeMockPolicy(opts: {
  structureValid?: boolean;
  unitDecision?: "approve" | "downgrade" | "reject";
  newGrade?: string;
  conflicts?: ConflictAnnotation[];
}): GatePolicy<TestUnit> {
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
    evaluateUnit: ({ unit }) => ({
      kind: "unit",
      unitId: unit.id,
      decision: opts.unitDecision ?? "approve",
      reasonCode: opts.unitDecision === "reject" ? "TEST_REJECT" : "OK",
      newGrade: opts.newGrade,
    }),
    detectConflicts: () => opts.conflicts ?? [],
    render: (units, _pool, _ctx) => ({
      admittedBlocks: units.map((u) => ({
        sourceId: (u.unit as TestUnit).id,
        content: "",
      })),
      summary: { admitted: units.length, rejected: 0, conflicts: 0 },
    }),
    buildRetryFeedback: () => ({ summary: "test", errors: [] }),
  };
}

function makeMockAuditWriter(): { writer: AuditWriter; calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  const writer: AuditWriter = {
    append: async (entry) => {
      calls.push(entry);
    },
  };
  return { writer, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GateRunner", () => {
  it("Test 1: structure validation failure → admittedUnits empty, units appear in rejectedUnits", async () => {
    const policy = makeMockPolicy({ structureValid: false });
    const runner = new GateRunner(policy);
    const result = await runner.run(makeProposal([{ id: "u1", content: "x" }]), emptySupportPool);

    assert.equal(result.proposalId, "prop-1");
    assert.equal(result.admittedUnits.length, 0);
    // units are NOT silently lost — they appear in rejectedUnits with STRUCTURE_INVALID
    assert.equal(result.rejectedUnits.length, 1);
    assert.equal(result.rejectedUnits[0].evaluationResults[0].reasonCode, "STRUCTURE_INVALID");
    assert.equal(result.hasConflicts, false);
    assert.ok(result.auditId);
    assert.equal(result.retryAttempts, 1);
  });

  it("Test 2: all units approved → admittedUnits all status=approved", async () => {
    const policy = makeMockPolicy({ unitDecision: "approve" });
    const runner = new GateRunner(policy);
    const result = await runner.run(
      makeProposal([
        { id: "u1", content: "a" },
        { id: "u2", content: "b" },
      ]),
      emptySupportPool
    );

    assert.equal(result.admittedUnits.length, 2);
    assert.equal(result.rejectedUnits.length, 0);
    for (const u of result.admittedUnits) {
      assert.equal(u.status, "approved");
    }
    assert.equal(result.retryAttempts, 1);
  });

  it("Test 3: one unit rejected → in rejectedUnits", async () => {
    const policy = makeMockPolicy({ unitDecision: "reject" });
    const runner = new GateRunner(policy);
    const result = await runner.run(
      makeProposal([{ id: "u1", content: "bad" }]),
      emptySupportPool
    );

    assert.equal(result.admittedUnits.length, 0);
    assert.equal(result.rejectedUnits.length, 1);
    assert.equal(result.rejectedUnits[0].status, "rejected");
  });

  it("Test 4: one unit downgraded → status=downgraded, appliedGrades contains newGrade", async () => {
    const policy = makeMockPolicy({ unitDecision: "downgrade", newGrade: "LOW" });
    const runner = new GateRunner(policy);
    const result = await runner.run(
      makeProposal([{ id: "u1", content: "maybe" }]),
      emptySupportPool
    );

    assert.equal(result.admittedUnits.length, 1);
    assert.equal(result.admittedUnits[0].status, "downgraded");
    assert.ok(result.admittedUnits[0].appliedGrades.includes("LOW"));
  });

  it("Test 5: conflict detected → status=approved_with_conflict, conflictAnnotation present", async () => {
    const conflicts: ConflictAnnotation[] = [
      {
        unitIds: ["u1"],
        conflictCode: "TEMPORAL_CONFLICT",
        sources: ["s1"],
        severity: "informational",
        description: "test conflict",
      },
    ];
    const policy = makeMockPolicy({ conflicts });
    const runner = new GateRunner(policy);
    const result = await runner.run(
      makeProposal([{ id: "u1", content: "conflict" }]),
      someSupportPool
    );

    assert.equal(result.admittedUnits.length, 1);
    assert.equal(result.admittedUnits[0].status, "approved_with_conflict");
    assert.ok(result.admittedUnits[0].conflictAnnotations?.[0]);
    assert.equal(
      result.admittedUnits[0].conflictAnnotations?.[0]?.conflictCode,
      "TEMPORAL_CONFLICT"
    );
    assert.equal(result.hasConflicts, true);
  });

  it("Test 6: mixed — some approved, some rejected, some conflict", async () => {
    // Use per-unit policy: first unit approved, second rejected
    // We use two separate GateRunner calls to simulate mixing, but here
    // we test a realistic scenario: conflict on u1, reject on u2, approve on u3
    const conflicts: ConflictAnnotation[] = [
      { unitIds: ["u1"], conflictCode: "ATTR_CONFLICT", sources: [], severity: "informational" },
    ];
    // We need a policy that returns different decisions per unit
    let callCount = 0;
    const decisions: Array<"approve" | "downgrade" | "reject"> = [
      "approve", // u1 — will become approved_with_conflict due to conflict
      "reject",  // u2
      "approve", // u3
    ];
    const mixedPolicy: GatePolicy<TestUnit> = {
      validateStructure: () => ({ kind: "structure", valid: true, errors: [] }),
      bindSupport: (unit, pool) => ({ unit, supportIds: pool.map((s) => s.id), supportRefs: pool }),
      evaluateUnit: ({ unit }) => {
        const decision = decisions[callCount++] ?? "approve";
        return {
          kind: "unit",
          unitId: unit.id,
          decision,
          reasonCode: decision === "reject" ? "REJECT" : "OK",
        };
      },
      detectConflicts: () => conflicts,
      render: (units, _pool, _ctx) => ({
        admittedBlocks: units.map((u) => ({ sourceId: u.unitId, content: "" })),
        summary: { admitted: units.length, rejected: 0, conflicts: 0 },
      }),
      buildRetryFeedback: () => ({ summary: "test", errors: [] }),
    };

    const runner = new GateRunner(mixedPolicy);
    const result = await runner.run(
      makeProposal([
        { id: "u1", content: "conflict" },
        { id: "u2", content: "bad" },
        { id: "u3", content: "good" },
      ]),
      emptySupportPool
    );

    // u1: approved_with_conflict → in admittedUnits
    // u2: rejected → in rejectedUnits
    // u3: approved → in admittedUnits
    assert.equal(result.admittedUnits.length, 2);
    assert.equal(result.rejectedUnits.length, 1);
    assert.equal(result.hasConflicts, true);

    const u1 = result.admittedUnits.find((u) => u.unitId === "u1");
    assert.ok(u1);
    assert.equal(u1.status, "approved_with_conflict");

    const u3 = result.admittedUnits.find((u) => u.unitId === "u3");
    assert.ok(u3);
    assert.equal(u3.status, "approved");

    assert.equal(result.rejectedUnits[0].unitId, "u2");
  });

  it("Test 7: structure failure → evaluateUnit never called", async () => {
    let evaluateCalled = 0;
    const policy: GatePolicy<TestUnit> = {
      validateStructure: () => ({
        kind: "structure",
        valid: false,
        errors: [{ field: "units", reasonCode: "EMPTY_UNITS" }],
      }),
      bindSupport: (unit, pool) => ({ unit, supportIds: pool.map((s) => s.id), supportRefs: pool }),
      evaluateUnit: ({ unit }) => {
        evaluateCalled++;
        return { kind: "unit", unitId: unit.id, decision: "approve", reasonCode: "OK" };
      },
      detectConflicts: () => [],
      render: (units, _pool, _ctx) => ({
        admittedBlocks: [],
        summary: { admitted: 0, rejected: 0, conflicts: 0 },
      }),
      buildRetryFeedback: () => ({ summary: "test", errors: [] }),
    };

    const runner = new GateRunner(policy);
    await runner.run(makeProposal([{ id: "u1", content: "x" }]), emptySupportPool);

    assert.equal(evaluateCalled, 0, "evaluateUnit must not be called when structure fails");
  });

  it("Test 9: unit in 2 conflicts → conflictAnnotations.length === 2", async () => {
    const conflicts: ConflictAnnotation[] = [
      {
        unitIds: ["u1"],
        conflictCode: "TEMPORAL_CONFLICT",
        sources: ["s1"],
        severity: "informational",
        description: "first conflict",
      },
      {
        unitIds: ["u1"],
        conflictCode: "ATTR_CONFLICT",
        sources: ["s2"],
        severity: "informational",
        description: "second conflict",
      },
    ];
    const policy = makeMockPolicy({ conflicts });
    const runner = new GateRunner(policy);
    const result = await runner.run(
      makeProposal([{ id: "u1", content: "multi-conflict" }]),
      someSupportPool
    );

    assert.equal(result.admittedUnits.length, 1);
    assert.equal(result.admittedUnits[0].status, "approved_with_conflict");
    assert.equal(result.admittedUnits[0].conflictAnnotations?.length, 2);
    const codes = result.admittedUnits[0].conflictAnnotations?.map((c) => c.conflictCode);
    assert.ok(codes?.includes("TEMPORAL_CONFLICT"));
    assert.ok(codes?.includes("ATTR_CONFLICT"));
  });

  it("Test 8: auditWriter.append called exactly once regardless of outcome", async () => {
    // Case A: structure failure
    {
      const { writer, calls } = makeMockAuditWriter();
      const policy = makeMockPolicy({ structureValid: false });
      const runner = new GateRunner(policy, writer);
      await runner.run(makeProposal([{ id: "u1", content: "x" }]), emptySupportPool);
      assert.equal(calls.length, 1, "auditWriter.append must be called once on structure failure");
    }

    // Case B: normal run
    {
      const { writer, calls } = makeMockAuditWriter();
      const policy = makeMockPolicy({ unitDecision: "approve" });
      const runner = new GateRunner(policy, writer);
      await runner.run(makeProposal([{ id: "u1", content: "x" }]), emptySupportPool);
      assert.equal(calls.length, 1, "auditWriter.append must be called once on normal run");
    }
  });
});
