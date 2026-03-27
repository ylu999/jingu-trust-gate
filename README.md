# jingu-harness

**LLM output is untrusted input. jingu-harness turns it into verified system state.**

It inserts a deterministic, auditable gate between LLM output and your trusted context. Only claims that are provably supported by evidence are allowed through. Everything else is rejected, downgraded, or annotated — and every decision is written to an audit log.

## The problem

LLMs do not distinguish between what is known and what is guessed. They generate confident answers either way.

In a RAG pipeline, this creates a critical failure mode:

```
retrieve docs → LLM reads docs → LLM generates answer → user sees answer
```

At the last step there is no constraint. The LLM can assert facts not present in your data, over-specify beyond what evidence supports, or silently resolve conflicting sources. Once this happens, the incorrect answer becomes indistinguishable from a correct one — and there is no deterministic way to debug or reproduce the failure.

This is not a prompt problem. This is a system boundary problem.

**Without harness:**
```
LLM: "You have exactly 3 apples"     ← grade=proven, evidenceRefs=[]
→ passes through
→ user believes it
→ no audit trail, no way to debug
```

**With harness:**
```
LLM: "You have exactly 3 apples"     ← grade=proven, evidenceRefs=[]
→ gate: MISSING_EVIDENCE → rejected
→ never reaches user context
→ audit log records the rejection
```

## This is not a guardrails framework

Guardrails frameworks (NeMo Guardrails, Guardrails AI) check whether LLM output is **safe or well-formed**. They block toxic content, enforce schemas, detect PII. That is a different problem.

jingu-harness checks whether each **claim is actually supported by your evidence**. It does not care whether output is polite or syntactically valid. It cares whether what the LLM asserts can be proven from the data you have.

| System | What it checks | Mechanism | Grain |
|--------|---------------|-----------|-------|
| Guardrails AI | Is the output safe / valid? | validators, LLM critics | response-level |
| NeMo Guardrails | Does the bot stay on-topic? | policy rules | turn-level |
| RAG / grounding | Did retrieval find relevant docs? | vector similarity | document-level |
| DeepEval | How often does the model hallucinate? | offline scoring | benchmark-level |
| **jingu-harness** | **Is each claim supported by your evidence?** | **deterministic gate, zero LLM** | **claim-level** |

To our knowledge, existing systems validate outputs, evaluate models, or retrieve evidence — but do not provide a deterministic admission boundary that enforces what claims are allowed to be treated as true at runtime.

## The mental model

Think of it like a fact-checker that sits between your retrieval system and your LLM. The LLM proposes claims. The gate decides which claims are trustworthy enough to use.

Two roles, cleanly separated:

- **LLM** = proposer (untrusted) — generates candidate claims referencing your evidence
- **harness** = judge (deterministic, zero LLM) — checks each claim against the evidence pool

harness does NOT generate or rewrite content. It is a judge, not an editor.

## The pipeline

```
Your retrieval system
        ↓
  support pool         ← the evidence you have (documents, observations, DB records)
        ↓
  LLM call             ← LLM proposes claims referencing that evidence
        ↓
  Proposal<TUnit>      ← typed output from LLM (schema-enforced by output_config.format)
        ↓
  harness.admit()      ← the gate — pure code, zero LLM
    Step 1: validateStructure()   is the proposal well-formed? (required fields, non-empty, etc.)
    Step 2: bindSupport()         which evidence from the pool applies to each claim?
    Step 3: evaluateUnit()        does each claim stay within what the evidence actually supports?
    Step 4: detectConflicts()     do any claims contradict each other?
        ↓
  AdmissionResult      ← every claim is now labeled: approved / downgraded / rejected / approved_with_conflict
        ↓
  harness.render()     ← policy renders admitted claims into structured context
        ↓
  VerifiedContext       ← structured context input (not user-facing text)
        ↓
  Adapter.adapt()      ← converts to wire format for your target LLM
        ↓
  LLM API call         ← LLM generates the final user-facing response
```

## Unit status — what each outcome means

| Status | What it means | What harness does |
|--------|--------------|-------------------|
| `approved` | Claim has evidence, nothing over-asserted | Passes through as-is |
| `downgraded` | Claim is more specific than evidence supports | Admitted with reduced grade + `unsupportedAttributes` flagged |
| `rejected` | No evidence, or structure invalid | Blocked — never reaches LLM context |
| `approved_with_conflict` | Claim has evidence but contradicts another claim | Admitted with conflict annotation |

## Three iron laws

1. **Gate Engine: zero LLM calls** — all four steps are deterministic code, not prompts. The gate is auditable and reproducible. No AI judging AI.

2. **Policy is injected** — harness core contains zero business logic. Your domain rules live entirely in `HarnessPolicy`. The same harness instance works for product search, medical records, or financial data — the policy changes, the gate does not.

3. **Every admission decision is written to audit log** — append-only JSONL at `.jingu-harness/audit.jsonl`. Every claim's fate is on record, linkable by `auditId`.

## When to use / when NOT to use

**Use harness when:**
- You have a retrieval system (RAG, vector DB, knowledge base) and LLM output must be grounded in it
- You need to prevent hallucinated certainty from reaching users
- You run multi-LLM pipelines and need a trusted handoff point between models
- You need audit trails for compliance or debugging
- You want to swap between Claude / OpenAI / Gemini without rewriting your admission logic

**Do NOT use harness when:**
- Your task is purely creative (writing, brainstorming) — no support pool exists, grounding doesn't apply
- You need sub-100ms latency and cannot afford a synchronous gate step
- You expect harness to rewrite or fix LLM output — it labels problems, it does not solve them
- You have no concept of "evidence" in your domain — harness becomes pointless overhead

## Patterns and anti-patterns

### Patterns (what harness enables)

**Pattern 1: Evidence-backed admission**
Only claims with bound evidence refs pass. Claims with `grade=proven` and zero evidence are rejected with `MISSING_EVIDENCE`. The gate calibrates confidence to what the system actually knows.

**Pattern 2: Precision calibration**
Over-specific claims (asserting a brand or quantity beyond what the evidence states) are downgraded, not rejected. The claim is admitted with a reduced grade and `unsupportedAttributes` marked. The downstream LLM adjusts its language accordingly.

**Pattern 3: Conflict surfacing**
Contradictory claims are both admitted with `approved_with_conflict`. harness never silently picks a winner. The downstream LLM receives both facts and can surface the contradiction to the user.

**Pattern 4: Structured retry**
`RetryFeedback` is a typed struct (`unitId + reasonCode + details`), not a raw string. The LLM knows exactly which claim to fix and why. Serialize it as `tool_result + is_error: true` for Claude's built-in retry mechanism.

**Pattern 5: LLM-agnostic context**
`VerifiedContext` is abstract. Adapters translate it to each LLM's wire format. Swap Claude for OpenAI without touching your gate or policy.

### Anti-patterns (what harness prevents)

**Anti-pattern 1: Hallucinated certainty** — `grade=proven` with zero bound evidence → `MISSING_EVIDENCE` → rejected before it reaches any LLM.

**Anti-pattern 2: Specificity hallucination** — claiming a brand name or specific quantity that the evidence does not mention → `OVER_SPECIFIC_BRAND` → downgraded with `unsupportedAttributes` flagged.

**Anti-pattern 3: Silent conflict resolution** — picking one of two contradictory claims without surfacing it → harness annotates both as `approved_with_conflict` so the downstream model handles it explicitly.

**Anti-pattern 4: String-based retry** — passing a raw error string back to the LLM loses structure. Always use typed `RetryFeedback` so the LLM knows which unit to fix.

**Anti-pattern 5: Bypassing the gate** — never pass raw LLM output directly as trusted context. All LLM proposals must go through `harness.admit()`.

## Known limitations

- **harness is a judge, not an editor.** It flags problems and annotates boundaries. It does not rewrite claims, fill in missing evidence, or auto-resolve conflicts.
- **Support pool is fixed per admission.** If your retrieval missed the relevant evidence, retry will not help — harness cannot distinguish "LLM cited wrong evidence" from "evidence does not exist in your system."
- **No cross-session state.** harness is stateless per call. It does not remember previous admissions or detect patterns across sessions.
- **Performance is O(units × support_pool) per admission.** For large-scale use, optimize `bindSupport` in your policy (e.g., index by `sourceId` before the call).
- **`TUnit` has no id constraint.** harness does not enforce that your unit type has an `id` field — that is your policy's responsibility.

## Quick start

```ts
import { createHarness, ClaudeContextAdapter } from "jingu-harness";
import type { HarnessPolicy } from "jingu-harness";

type Item = { id: string; text: string; grade: "proven" | "derived" };

// Policy = your domain rules. harness core has none.
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
    // supportIds: for audit traceability; supportRefs: for attribute inspection in evaluateUnit
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  },

  evaluateUnit: ({ unit, supportIds }) => ({
    kind: "unit",
    unitId: unit.id,
    decision: unit.grade === "proven" && supportIds.length === 0 ? "reject" : "approve",
    reasonCode: unit.grade === "proven" && supportIds.length === 0 ? "MISSING_EVIDENCE" : "OK",
  }),

  // detectConflicts receives UnitWithSupport[] so you can inspect bound evidence per unit
  detectConflicts: (_units, _pool) => [],

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
const context = harness.render(result);             // VerifiedContext → pass to LLM API
const summary = harness.explain(result);            // { approved, rejected, conflicts, ... }

// Convert to Claude API wire format
const blocks  = new ClaudeContextAdapter().adapt(context);
```

## HarnessPolicy interface

Implement all six methods. None may call an LLM.

| Method | What it does |
|--------|-------------|
| `validateStructure` | Is the proposal well-formed? (right number of units, required fields present) |
| `bindSupport` | Which evidence from the pool applies to this claim? Returns the claim + its evidence. |
| `evaluateUnit` | Should this claim be approved, downgraded, or rejected based on its evidence? |
| `detectConflicts` | Do any claims contradict each other? Receives all claims with their bound evidence. |
| `render` | Serialize admitted claims into `VerifiedContext` for the adapter. |
| `buildRetryFeedback` | When gate rejects, what structured feedback should the LLM receive? |

Full signatures:

```ts
interface HarnessPolicy<TUnit> {
  validateStructure(proposal: Proposal<TUnit>): StructureValidationResult;
  bindSupport(unit: TUnit, supportPool: SupportRef[]): UnitWithSupport<TUnit>;
  evaluateUnit(unitWithSupport: UnitWithSupport<TUnit>, context: { proposalId: string; proposalKind: string }): UnitEvaluationResult;
  detectConflicts(units: UnitWithSupport<TUnit>[], supportPool: SupportRef[]): ConflictAnnotation[];
  render(admittedUnits: AdmittedUnit<TUnit>[], supportPool: SupportRef[], context: RenderContext): VerifiedContext;
  buildRetryFeedback(unitResults: UnitEvaluationResult[], context: RetryContext): RetryFeedback;
}
```

## Adapters

Each adapter converts `VerifiedContext` to the wire format expected by a specific LLM API. Grade caveats, unsupported attributes, and conflict notes are inlined into content so the downstream model sees them as contextual constraints.

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

## SupportRef ID clarification

`SupportRef` has two IDs that serve different purposes:

- `id` — system-internal, written to `supportIds` in audit entries for traceability back to the exact record
- `sourceId` — business identity, used in `bindSupport` to match claims against the evidence pool

When writing `bindSupport`, match on `sourceId` (business key). The `id` fields flow automatically into the audit log.

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

## License

MIT
