# jingu-harness

A generic proposal-governance framework.
After an LLM produces a Proposal, the harness decides which units are admitted,
retries on semantic rejection, and audits every decision — without calling LLMs.

## The problem

Claude API's `output_config.format` with `strict: true` guarantees that LLM output is
syntactically valid against a schema. It does not guarantee semantic correctness: a unit
can be schema-valid yet lack evidence, exceed its permitted scope, or contradict another
unit in the same proposal. jingu-harness fills this gap with a fully programmatic gate
layer that runs after schema validation and before any downstream consumption.

## Pipeline

```
LLM (output_config.format + strict:true)
  -> Proposal<TUnit>           schema-valid, syntactically correct

GateRunner                    100% programmatic, zero LLM calls
  |-- validateStructure()     proposal-level structural check
  |-- bindSupport()           bind SupportRef[] to each unit
  |-- evaluateUnit() x N      semantic gate per unit
  +-- detectConflicts()       cross-unit conflict detection

AdmissionResult<TUnit>
  |-- approved
  |-- downgraded              grade adjusted, still admitted
  |-- approved_with_conflict  admitted but conflict surfaced
  +-- rejected

render() -> VerifiedContext    input for next Claude API call
                               NOT final user text -- Claude generates that
```

## Boundary with Claude API

```
Claude API guarantees:  syntactic correctness
                        (output_config.format, strict:true)

jingu-harness guarantees:  semantic correctness
  - evidence-grounded   does this unit have a SupportRef?
  - scope-safe          is this a response unit or a mutation sneaking in?
  - conflict-annotated  do two units contradict each other?

harness render() -> VerifiedContext -> next Claude API call -> user text

harness does NOT generate user-facing text.
Claude does the language generation. harness controls what Claude is allowed to say.
```

## Quick start

```ts
import { createHarness } from "jingu-harness";
import type { HarnessPolicy } from "jingu-harness";

type Item = { id: string; text: string; grade: "proven" | "derived" | "unknown" };

const policy: HarnessPolicy<Item> = {
  validateStructure: (proposal) => ({
    kind: "structure",
    valid: proposal.units.length > 0,
    errors: proposal.units.length === 0
      ? [{ field: "units", reasonCode: "EMPTY_PROPOSAL" }]
      : [],
  }),

  bindSupport: (unit, pool) => ({
    unit,
    supportIds: pool.filter(s => s.sourceId === unit.id).map(s => s.id),
  }),

  evaluateUnit: ({ unit, supportIds }) => ({
    kind: "unit",
    unitId: unit.id,
    decision: unit.grade === "proven" && supportIds.length === 0 ? "reject" : "approve",
    reasonCode: unit.grade === "proven" && supportIds.length === 0
      ? "MISSING_EVIDENCE"
      : "OK",
  }),

  detectConflicts: () => [],

  render: (admittedUnits) => ({
    admittedBlocks: admittedUnits.map(u => ({
      sourceId: u.unitId,
      content: (u.unit as Item).text,
      grade: u.appliedGrades[u.appliedGrades.length - 1],
    })),
    summary: { admitted: admittedUnits.length, rejected: 0, conflicts: 0 },
  }),

  buildRetryFeedback: (results) => ({
    summary: `${results.length} unit(s) failed`,
    errors: results.map(r => ({ unitId: r.unitId, reasonCode: r.reasonCode })),
  }),
};

const harness = createHarness({ policy });

const result  = await harness.admit(proposal, supportPool);
const context = harness.render(result);   // -> VerifiedContext for Claude API
const summary = harness.explain(result);  // -> { approved, rejected, conflicts, ... }
```

## HarnessPolicy interface

Callers implement all six methods. None of them may call an LLM.

| Method | What it does | Calls LLM? |
|---|---|---|
| `validateStructure()` | Check Proposal shape | No |
| `bindSupport()` | Assign SupportRefs to each unit | No |
| `evaluateUnit()` | Per-unit semantic gate | No |
| `detectConflicts()` | Cross-unit conflict check | No |
| `render()` | Admitted units -> VerifiedContext | No |
| `buildRetryFeedback()` | Gate errors -> structured feedback for LLMInvoker | No |

## Module structure

| Path | Purpose |
|---|---|
| `src/types/` | All type definitions (Proposal, SupportRef, GateResult, AdmissionResult, ...) |
| `src/gate/` | GateRunner -- fixed 4-step pipeline, zero LLM |
| `src/audit/` | FileAuditWriter -- append-only JSONL audit log |
| `src/retry/` | runWithRetry -- semantic retry loop |
| `src/conflict/` | surfaceConflicts, groupConflictsByCode helpers |
| `src/renderer/` | BaseRenderer -- default VerifiedContext builder |
| `src/harness.ts` | createHarness() factory, explainResult() |

## Three laws

```
1. Gate Engine: zero LLM -- all gates are code, not prompts
2. Policy is injected: harness core carries no business semantics
3. Every admission decision is written to audit log
```
