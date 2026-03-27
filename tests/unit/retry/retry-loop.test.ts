import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWithRetry } from "../../../src/retry/retry-loop.js";
import type { HarnessPolicy } from "../../../src/types/policy.js";
import type { Proposal } from "../../../src/types/proposal.js";
import type { SupportRef } from "../../../src/types/support.js";
import type { AuditEntry, AuditWriter } from "../../../src/types/audit.js";
import type { ConflictAnnotation, UnitEvaluationResult } from "../../../src/types/gate.js";
import type { LLMInvoker, RetryFeedback } from "../../../src/types/retry.js";

// ---------------------------------------------------------------------------
// Test types
// ---------------------------------------------------------------------------

type TestUnit = { id: string; value: string };

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeProposal(units: TestUnit[], id = "prop-1"): Proposal<TestUnit> {
  return { id, kind: "response", units };
}

const noSupport: SupportRef[] = [];

function makeMockPolicy(opts: {
  unitDecision?: "approve" | "downgrade" | "reject";
  decisions?: Array<"approve" | "downgrade" | "reject">; // per-call sequence
}): HarnessPolicy<TestUnit> {
  let callIndex = 0;
  return {
    validateStructure: () => ({ kind: "structure", valid: true, errors: [] }),
    bindSupport: (unit) => ({ unit, supportIds: [], supportRefs: [] }),
    evaluateUnit: ({ unit }) => {
      let decision: "approve" | "downgrade" | "reject";
      if (opts.decisions) {
        decision = opts.decisions[callIndex++] ?? "approve";
      } else {
        decision = opts.unitDecision ?? "approve";
      }
      return {
        kind: "unit",
        unitId: unit.id,
        decision,
        reasonCode: decision === "approve" ? "OK" : decision === "downgrade" ? "DOWNGRADE" : "REJECT",
      };
    },
    detectConflicts: (): ConflictAnnotation[] => [],
    render: (units, _pool, _ctx) => ({
      admittedBlocks: units.map((u) => ({ sourceId: u.unitId, content: "" })),
      summary: { admitted: units.length, rejected: 0, conflicts: 0 },
    }),
    buildRetryFeedback: (results, context) => ({
      summary: `attempt ${context.attempt}: ${results.length} failed`,
      errors: results.map((r) => ({ unitId: r.unitId, reasonCode: r.reasonCode })),
    }),
  };
}

function makeAuditWriter(): { writer: AuditWriter; calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return {
    writer: { append: async (e) => { calls.push(e); } },
    calls,
  };
}

// LLMInvoker that always returns the same proposal
function makeInvoker(
  units: TestUnit[],
  opts: { capture?: { prompts: string[]; feedbacks: Array<RetryFeedback | undefined> } } = {}
): LLMInvoker<TestUnit> {
  return async (prompt, feedback) => {
    opts.capture?.prompts.push(prompt);
    opts.capture?.feedbacks.push(feedback);
    return makeProposal(units);
  };
}

// LLMInvoker that counts invocations
function makeCountingInvoker(
  units: TestUnit[]
): { invoker: LLMInvoker<TestUnit>; count: number } {
  const state = { count: 0 };
  const invoker: LLMInvoker<TestUnit> = async (_prompt, _feedback) => {
    state.count++;
    return makeProposal(units);
  };
  return { invoker, count: 0 /* unused — read state.count via closure */ };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runWithRetry", () => {
  // Test 1: First attempt passes — attempt=1, no feedback passed to invoker
  it("Test 1: first attempt passes → attempts=1, feedback undefined on first call", async () => {
    const capture = { prompts: [] as string[], feedbacks: [] as Array<RetryFeedback | undefined> };
    const policy = makeMockPolicy({ unitDecision: "approve" });
    const invoker = makeInvoker([{ id: "u1", value: "ok" }], { capture });

    const { result, attempts } = await runWithRetry(
      invoker, noSupport, policy, "test-prompt",
      { maxRetries: 3, retryOnDecisions: ["reject"] }
    );

    assert.equal(attempts, 1);
    assert.equal(result.admittedUnits.length, 1);
    assert.equal(result.rejectedUnits.length, 0);
    assert.equal(capture.feedbacks[0], undefined, "first call must not receive feedback");
  });

  // Test 2: First attempt rejects, second attempt approves → attempts=2
  it("Test 2: first reject, second approve → attempts=2", async () => {
    // policy per-evaluateUnit call: reject first unit on attempt 1, approve on attempt 2
    // Each runWithRetry attempt calls evaluateUnit once per unit
    const policy = makeMockPolicy({ decisions: ["reject", "approve"] });
    let invokeCount = 0;
    const invoker: LLMInvoker<TestUnit> = async () => {
      invokeCount++;
      return makeProposal([{ id: "u1", value: "x" }]);
    };

    const { attempts } = await runWithRetry(
      invoker, noSupport, policy, "prompt",
      { maxRetries: 3, retryOnDecisions: ["reject"] }
    );

    assert.equal(attempts, 2);
    assert.equal(invokeCount, 2);
  });

  // Test 3: Continuous reject until maxRetries=2 → attempts=3 (maxRetries+1)
  it("Test 3: continuous reject → exhausts maxRetries=2, attempts=3", async () => {
    const policy = makeMockPolicy({ unitDecision: "reject" });
    let invokeCount = 0;
    const invoker: LLMInvoker<TestUnit> = async () => {
      invokeCount++;
      return makeProposal([{ id: "u1", value: "bad" }]);
    };

    const { result, attempts } = await runWithRetry(
      invoker, noSupport, policy, "prompt",
      { maxRetries: 2, retryOnDecisions: ["reject"] }
    );

    assert.equal(attempts, 3); // attempt 0,1,2 → 3 total
    assert.equal(invokeCount, 3);
    assert.equal(result.rejectedUnits.length, 1);
  });

  // Test 4: retryOnDecisions=["reject"] — downgrade does NOT trigger retry
  it("Test 4: downgrade does not trigger retry when retryOnDecisions=[reject]", async () => {
    const policy = makeMockPolicy({ unitDecision: "downgrade" });
    let invokeCount = 0;
    const invoker: LLMInvoker<TestUnit> = async () => {
      invokeCount++;
      return makeProposal([{ id: "u1", value: "maybe" }]);
    };

    const { attempts } = await runWithRetry(
      invoker, noSupport, policy, "prompt",
      { maxRetries: 3, retryOnDecisions: ["reject"] }
    );

    assert.equal(attempts, 1, "downgrade must not trigger retry when not in retryOnDecisions");
    assert.equal(invokeCount, 1);
  });

  // Test 5: retryOnDecisions=["reject","downgrade"] — downgrade triggers retry
  it("Test 5: downgrade triggers retry when retryOnDecisions includes downgrade", async () => {
    // First call: downgrade → triggers retry; second call: approve → done
    const policy = makeMockPolicy({ decisions: ["downgrade", "approve"] });
    let invokeCount = 0;
    const invoker: LLMInvoker<TestUnit> = async () => {
      invokeCount++;
      return makeProposal([{ id: "u1", value: "maybe" }]);
    };

    const { attempts } = await runWithRetry(
      invoker, noSupport, policy, "prompt",
      { maxRetries: 3, retryOnDecisions: ["reject", "downgrade"] }
    );

    assert.equal(attempts, 2);
    assert.equal(invokeCount, 2);
  });

  // Test 6: feedback is correctly passed to invoker on second call
  it("Test 6: feedback passed to invoker on retry attempt", async () => {
    const capturedFeedbacks: Array<RetryFeedback | undefined> = [];
    // Attempt 1: reject → attempt 2: approve
    const policy = makeMockPolicy({ decisions: ["reject", "approve"] });
    const invoker: LLMInvoker<TestUnit> = async (_prompt, feedback) => {
      capturedFeedbacks.push(feedback);
      return makeProposal([{ id: "u1", value: "x" }]);
    };

    await runWithRetry(
      invoker, noSupport, policy, "prompt",
      { maxRetries: 3, retryOnDecisions: ["reject"] }
    );

    assert.equal(capturedFeedbacks.length, 2);
    assert.equal(capturedFeedbacks[0], undefined, "first call: no feedback");
    assert.ok(capturedFeedbacks[1] !== undefined, "second call: feedback must be present");
    assert.ok(typeof capturedFeedbacks[1]!.summary === "string");
    assert.ok(Array.isArray(capturedFeedbacks[1]!.errors));
  });

  // Test 7: auditWriter.append called on every attempt
  it("Test 7: auditWriter.append called once per attempt", async () => {
    const { writer, calls } = makeAuditWriter();
    // Reject twice then approve (3 total calls)
    const policy = makeMockPolicy({ decisions: ["reject", "reject", "approve"] });
    const invoker: LLMInvoker<TestUnit> = async () => makeProposal([{ id: "u1", value: "x" }]);

    await runWithRetry(
      invoker, noSupport, policy, "prompt",
      { maxRetries: 3, retryOnDecisions: ["reject"] },
      writer
    );

    assert.equal(calls.length, 3, "auditWriter.append must be called once per GateRunner.run call");
  });

  // Test 8: converge after retry — invoker not called again after convergence
  it("Test 8: invoker not called after convergence", async () => {
    let invokeCount = 0;
    // Approve immediately
    const policy = makeMockPolicy({ unitDecision: "approve" });
    const invoker: LLMInvoker<TestUnit> = async () => {
      invokeCount++;
      return makeProposal([{ id: "u1", value: "ok" }]);
    };

    await runWithRetry(
      invoker, noSupport, policy, "prompt",
      { maxRetries: 5, retryOnDecisions: ["reject"] }
    );

    assert.equal(invokeCount, 1, "invoker must not be called again after convergence");
  });

  // Test 9: retryAttempts field set correctly in final AdmissionResult
  it("Test 9: retryAttempts field set in final AdmissionResult", async () => {
    // Reject 2 times then approve
    const policy = makeMockPolicy({ decisions: ["reject", "reject", "approve"] });
    const invoker: LLMInvoker<TestUnit> = async () => makeProposal([{ id: "u1", value: "x" }]);

    const { result, attempts } = await runWithRetry(
      invoker, noSupport, policy, "prompt",
      { maxRetries: 5, retryOnDecisions: ["reject"] }
    );

    assert.equal(attempts, 3);
    assert.equal(result.retryAttempts, 3, "retryAttempts must match total attempts");
  });

  // Test 10: maxRetries=0 → only one invoker call regardless of outcome
  it("Test 10: maxRetries=0 → exactly one invoker call, no retry", async () => {
    const policy = makeMockPolicy({ unitDecision: "reject" });
    let invokeCount = 0;
    const invoker: LLMInvoker<TestUnit> = async () => {
      invokeCount++;
      return makeProposal([{ id: "u1", value: "bad" }]);
    };

    const { attempts, result } = await runWithRetry(
      invoker, noSupport, policy, "prompt",
      { maxRetries: 0, retryOnDecisions: ["reject"] }
    );

    assert.equal(invokeCount, 1, "must invoke LLM exactly once when maxRetries=0");
    assert.equal(attempts, 1);
    assert.equal(result.rejectedUnits.length, 1);
  });
});
