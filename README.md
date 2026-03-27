# jingu-harness

**jingu-harness is a deterministic admission control layer for LLM-generated content.**

LLMs produce confident outputs that may be unsupported by evidence. Standard RAG pipelines trust this output directly. jingu-harness enforces that only evidence-backed, scope-safe, and conflict-annotated content enters your trusted context.

## Pipeline

```
LLM output (Proposal)
        ↓
  Gate Engine          ← 4 steps, zero LLM, pure code
  1. validateStructure
  2. bindSupport
  3. evaluateUnit
  4. detectConflicts
        ↓
  AdmissionResult      ← approved / downgraded / rejected / approved_with_conflict
        ↓
  harness.render()
        ↓
  VerifiedContext       ← semantic structure, not user text
        ↓
  Adapter              ← ClaudeAdapter / OpenAIAdapter / GeminiAdapter
        ↓
  LLM API call         ← Claude / OpenAI / Gemini generates final response
```

## Claude API boundary

| Layer | Guarantees |
|-------|-----------|
| Claude `output_config.format + strict:true` | **Syntactic** correctness — schema-valid output |
| jingu-harness | **Semantic** correctness — evidence-grounded, scope-safe, conflict-annotated |

- `harness.render()` outputs `VerifiedContext` — this is input to the Claude API, **not** final user text
- Claude does the language generation; harness controls what Claude is allowed to say
- `RetryFeedback` flows back as `tool_result + is_error:true` using Claude's built-in retry mechanism

## Quick start

```ts
import { createHarness, ClaudeContextAdapter } from "jingu-harness";
import type { HarnessPolicy } from "jingu-harness";

type Item = { id: string; text: string; grade: "proven" | "derived" };

const policy: HarnessPolicy<Item> = {
  validateStructure: (proposal) => ({
    kind: "structure",
    valid: proposal.units.length > 0,
    errors: proposal.units.length === 0
      ? [{ field: "units", reasonCode: "EMPTY_PROPOSAL" }]
      : [],
  }),
  bindSupport: (unit, pool) => {
    const matched = pool.filter(s => s.sourceId === unit.id);
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  },
  evaluateUnit: ({ unit, supportIds }) => ({
    kind: "unit",
    unitId: unit.id,
    decision: unit.grade === "proven" && supportIds.length === 0 ? "reject" : "approve",
    reasonCode: unit.grade === "proven" && supportIds.length === 0 ? "MISSING_EVIDENCE" : "OK",
  }),
  detectConflicts: () => [],
  render: (admittedUnits, _support, _ctx) => ({
    admittedBlocks: admittedUnits.map(u => ({
      sourceId: u.unitId,
      content: (u.unit as Item).text,
      grade: u.appliedGrades[u.appliedGrades.length - 1],
    })),
    summary: { admitted: admittedUnits.length, rejected: 0, conflicts: 0 },
  }),
  buildRetryFeedback: (results, _ctx) => ({
    summary: `${results.length} unit(s) failed`,
    errors: results.map(r => ({ unitId: r.unitId, reasonCode: r.reasonCode })),
  }),
};

const harness = createHarness({ policy });

const result  = await harness.admit(proposal, supportPool);
const context = harness.render(result);             // VerifiedContext → pass to Claude API
const summary = harness.explain(result);            // { approved, rejected, conflicts, ... }

// Convert to Claude API wire format
const blocks  = new ClaudeContextAdapter().adapt(context);
```

## HarnessPolicy interface

Implement all six methods. None may call an LLM.

| Method | Input | Output | Zero LLM? |
|--------|-------|--------|-----------|
| `validateStructure` | `Proposal<TUnit>` | `StructureValidationResult` | yes |
| `bindSupport` | `unit + SupportRef[]` | `UnitWithSupport<TUnit>` | yes |
| `evaluateUnit` | `UnitWithSupport<TUnit>` | `UnitEvaluationResult` | yes |
| `detectConflicts` | `UnitWithSupport<TUnit>[] + SupportRef[]` | `ConflictAnnotation[]` | yes |
| `render` | `AdmittedUnit<TUnit>[] + SupportRef[]` | `VerifiedContext` | yes |
| `buildRetryFeedback` | `UnitEvaluationResult[]` | `RetryFeedback` | yes |

## Adapters

Each adapter converts `VerifiedContext` to the wire format expected by a specific LLM API.

```ts
// Claude API — search_result blocks with optional citations
const blocks = new ClaudeContextAdapter({ citations: true }).adapt(verifiedCtx);
// blocks: ClaudeSearchResultBlock[]  (type: "search_result")

// OpenAI — tool result or user message
const msg = new OpenAIContextAdapter({ mode: "tool", toolCallId: call.id }).adapt(verifiedCtx);
// msg: OpenAIChatMessage  (role: "tool" | "user")

// Gemini — Content with parts array
const content = new GeminiContextAdapter({ role: "user" }).adapt(verifiedCtx);
// content: GeminiContent  (role: "user" | "function", parts: GeminiTextPart[])
```

All three adapters inline grade caveats, unsupported attributes, and conflict notes into the
content text so the downstream model sees them as contextual constraints.

## UnitStatus

| Status | Meaning |
|--------|---------|
| `approved` | Claim backed by evidence, passes all gates |
| `downgraded` | Admitted but with reduced grade (e.g. `proven` → `derived`) |
| `rejected` | Not admitted — missing evidence or structure invalid |
| `approved_with_conflict` | Admitted but conflicts with another unit |

## Three iron laws

1. **Gate Engine: zero LLM calls** — all gates are code, not prompts; deterministic and auditable
2. **Policy is injected** — harness core carries no business semantics; all domain logic lives in `HarnessPolicy`
3. **Every admission decision is written to audit log** — append-only JSONL at `.jingu-harness/audit.jsonl`

## Module structure

```
src/types/       — core type definitions (Proposal, SupportRef, AdmissionResult, ...)
src/gate/        — GateRunner (4-step pipeline, zero LLM)
src/audit/       — FileAuditWriter, audit entry builder
src/retry/       — runWithRetry, RetryFeedback utils
src/conflict/    — ConflictAnnotation surfacing helpers
src/renderer/    — BaseRenderer → VerifiedContext
src/adapters/    — ClaudeContextAdapter, OpenAIContextAdapter, GeminiContextAdapter
src/harness.ts   — createHarness() public API
```

## Install and run

```bash
npm install
npm test     # 72 tests
npm run demo # narrative demo with 6 scenarios
```
