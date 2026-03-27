# jingu-trust-gate

**LLM output is untrusted input. jingu-trust-gate decides what is allowed to become trusted system state.**

It inserts a deterministic, auditable gate between LLM output and your trusted context. Only claims that are provably supported by evidence are allowed through. Everything else is rejected, downgraded, or annotated — and every decision is written to an audit log.

## Install

```bash
# Node.js
npm install jingu-trust-gate

# Python
pip install jingu-trust-gate
```


## The problem

LLMs do not distinguish between what is known and what is guessed. They generate confident answers either way.

In a RAG pipeline, this creates a critical failure mode:

```
retrieve docs → LLM reads docs → LLM generates answer → user sees answer
```

At the last step there is no constraint. The LLM can assert facts not present in your data, over-specify beyond what evidence supports, or silently resolve conflicting sources. Once this happens, the incorrect answer becomes indistinguishable from a correct one — and there is no deterministic way to debug or reproduce the failure.

This is not a prompt problem. This is a system boundary problem.

**Without jingu-trust-gate:**
```
LLM: "You have exactly 3 apples"     ← grade=proven, evidenceRefs=[]
→ passes through
→ user believes it
→ no audit trail, no way to debug
```

**With jingu-trust-gate:**
```
LLM: "You have exactly 3 apples"     ← grade=proven, evidenceRefs=[]
→ gate: MISSING_EVIDENCE → rejected
→ never reaches user context
→ audit log records the rejection
```

## This is not a guardrails framework

Guardrails frameworks (NeMo Guardrails, Guardrails AI) check whether LLM output is **safe or well-formed**. They block toxic content, enforce schemas, detect PII. That is a different problem.

jingu-trust-gate checks whether each **claim is actually supported by your evidence**. It does not care whether output is polite or syntactically valid. It cares whether what the LLM asserts can be proven from the data you have.

| System | What it checks | Mechanism | Grain |
|--------|---------------|-----------|-------|
| Guardrails AI | Is the output safe / valid? | validators, LLM critics | response-level |
| NeMo Guardrails | Does the bot stay on-topic? | policy rules | turn-level |
| RAG / grounding | Did retrieval find relevant docs? | vector similarity | document-level |
| DeepEval | How often does the model hallucinate? | offline scoring | benchmark-level |
| **jingu-trust-gate** | **Is each claim supported by your evidence?** | **deterministic gate, zero LLM** | **claim-level** |

To our knowledge, existing systems validate outputs, evaluate models, or retrieve evidence — but do not provide a deterministic admission boundary that enforces what claims are allowed to be treated as true at runtime.

## The mental model

Think of it like a fact-checker that sits between your retrieval system and your LLM. The LLM proposes claims. The gate decides which claims are trustworthy enough to use.

Two roles, cleanly separated:

- **LLM** = proposer (untrusted) — generates candidate claims referencing your evidence
- **trust gate** = judge (deterministic, zero LLM) — checks each claim against the evidence pool

The gate does NOT generate or rewrite content. It is a judge, not an editor.

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
  gate.admit()      ← the gate — pure code, zero LLM
    Step 1: validateStructure()   is the proposal well-formed? (required fields, non-empty, etc.)
    Step 2: bindSupport()         which evidence from the pool applies to each claim?
    Step 3: evaluateUnit()        does each claim stay within what the evidence actually supports?
    Step 4: detectConflicts()     do any claims contradict each other?
        ↓
  AdmissionResult      ← every claim is now labeled: approved / downgraded / rejected / approved_with_conflict
        ↓
  gate.render()     ← policy renders admitted claims into structured context
        ↓
  VerifiedContext       ← structured context input (not user-facing text)
        ↓
  Adapter.adapt()      ← converts to wire format for your target LLM
        ↓
  LLM API call         ← LLM generates the final user-facing response
```

## Unit status — what each outcome means

| Status | What it means | What the gate does |
|--------|--------------|-------------------|
| `approved` | Claim has evidence, nothing over-asserted | Passes through as-is |
| `downgraded` | Claim is more specific than evidence supports | Admitted with reduced grade + `unsupportedAttributes` flagged |
| `rejected` | No evidence, or structure invalid | Blocked — never reaches LLM context |
| `approved_with_conflict` | Claim has evidence but contradicts another claim | Admitted with conflict annotation |

`approved_with_conflict` only occurs when conflict severity is `"informational"`. When severity is `"blocking"`, both claims are force-rejected — `admittedBlocks` is empty and the downstream LLM receives no claims, only the `instructions` field.

```
informational conflict:  both claims admitted → LLM receives both with conflictNote → LLM surfaces contradiction to user
blocking conflict:       both claims rejected → LLM receives empty context → LLM tells user data is inconsistent
```

Which severity to use is a policy decision. Use `informational` when both sides of a conflict are useful to the downstream LLM (e.g. two timestamps that disagree — show both). Use `blocking` when the claims are mutually exclusive and surfacing either one unchecked would be unsafe (e.g. "in stock" vs "out of stock" for the same product).

## Evidence support vs truth correctness

The gate does not determine whether a claim is true or false.

It determines whether a claim is **supported by the available evidence**.

The distinction matters:

- A claim can be factually wrong but still only "over-specific relative to evidence" — both `approved` with full confidence and `downgraded` are valid outcomes depending on your policy
- Whether a contradiction between a claim and its evidence is a `reject` or a `downgrade` is a policy decision, not a core gate decision
- The gate executes policy deterministically — it does not embed domain-specific truth semantics

This design is intentional. The same gate instance works across domains because the semantics of "what counts as supported" live in your `GatePolicy`, not in the gate engine.

## Three iron laws

1. **Gate Engine: zero LLM calls** — all four steps are deterministic code, not prompts. The gate is auditable and reproducible. No AI judging AI.

2. **Policy is injected** — the gate core contains zero business logic. Your domain rules live entirely in `GatePolicy`. The same gate instance works for product search, medical records, or financial data — the policy changes, the gate does not.

3. **Every admission decision is written to audit log** — append-only JSONL at `.jingu-trust-gate/audit.jsonl`. Every claim's fate is on record, linkable by `auditId`.

## When to use / when NOT to use

**Use jingu-trust-gate when:**
- You have a retrieval system (RAG, vector DB, knowledge base) and LLM output must be grounded in it
- You need to prevent hallucinated certainty from reaching users
- You run multi-LLM pipelines and need a trusted handoff point between models
- You need audit trails for compliance or debugging
- You want to swap between Claude / OpenAI / Gemini without rewriting your admission logic

**Do NOT use jingu-trust-gate when:**
- Your task is purely creative (writing, brainstorming) — no support pool exists, grounding doesn't apply
- You need sub-100ms latency and cannot afford a synchronous gate step
- You expect the gate to rewrite or fix LLM output — it labels problems, it does not solve them
- You have no concept of "evidence" in your domain — the gate becomes pointless overhead

## Patterns and anti-patterns

### Patterns (what jingu-trust-gate enables)

**Pattern 1: Evidence-backed admission**
Only claims with bound evidence refs pass. Claims with `grade=proven` and zero evidence are rejected with `MISSING_EVIDENCE`. The gate calibrates confidence to what the system actually knows.

**Pattern 2: Precision calibration**
Over-specific claims (asserting a brand or quantity beyond what the evidence states) are downgraded, not rejected. The claim is admitted with a reduced grade and `unsupportedAttributes` marked. The downstream LLM adjusts its language accordingly.

**Pattern 3: Conflict surfacing**
Contradictory claims are both admitted with `approved_with_conflict`. The gate never silently picks a winner. The downstream LLM receives both facts and can surface the contradiction to the user.

**Pattern 4: Structured retry**
`RetryFeedback` is a typed struct (`unitId + reasonCode + details`), not a raw string. The LLM knows exactly which claim to fix and why. Serialize it as `tool_result + is_error: true` for Claude's built-in retry mechanism.

**Pattern 5: LLM-agnostic context**
`VerifiedContext` is abstract. Adapters translate it to each LLM's wire format. Swap Claude for OpenAI without touching your gate or policy.

### Anti-patterns (what jingu-trust-gate prevents)

**Anti-pattern 1: Hallucinated certainty** — `grade=proven` with zero bound evidence → `MISSING_EVIDENCE` → rejected before it reaches any LLM.

**Anti-pattern 2: Specificity hallucination** — claiming a brand name or specific quantity that the evidence does not mention → `OVER_SPECIFIC_BRAND` → downgraded with `unsupportedAttributes` flagged.

**Anti-pattern 3: Silent conflict resolution** — picking one of two contradictory claims without surfacing it → the gate annotates both as `approved_with_conflict` so the downstream model handles it explicitly.

**Anti-pattern 4: String-based retry** — passing a raw error string back to the LLM loses structure. Always use typed `RetryFeedback` so the LLM knows which unit to fix.

**Anti-pattern 5: Bypassing the gate** — never pass raw LLM output directly as trusted context. All LLM proposals must go through `gate.admit()`.

## Real-world examples

The `examples/` directory contains five runnable domain policies. Each one shows how to write a `GatePolicy` for a real scenario and what the gate catches that a plain RAG pipeline would not.

### E-commerce catalog chatbot (`ecommerce-catalog-policy.ts`)

Customer asks: "Does this headphone support noise cancellation? How many are left in stock?"

Without jingu-trust-gate: LLM asserts "active noise cancellation" when the spec only lists "passive noise isolation". Invents stock counts. Silently picks one side when two seller listings disagree on availability.

With jingu-trust-gate:
- Feature not in `evidence.features` → `UNSUPPORTED_FEATURE` → downgraded
- Exact count outside inventory range → `OVER_SPECIFIC_STOCK` → downgraded
- Two listings contradict on in-stock status → `STOCK_CONFLICT` (blocking) → both rejected, LLM receives empty context and tells the customer to check the product page

### HPC GPU cluster diagnostics (`hpc-diagnostic-policy.ts`)

SRE agent investigates a failed training job across 8 A100 nodes.

Without jingu-trust-gate: incident report says "GPU permanently damaged, must be replaced" and "all other nodes healthy" — both unsupported by logs. SRE triggers procurement and skips checking other nodes.

With jingu-trust-gate:
- "Must be replaced" without nvml/dmesg confirmed-loss signal → `UNSUPPORTED_SEVERITY` → downgraded
- "All other nodes healthy" when pool only covers one node → `UNSUPPORTED_SCOPE` → downgraded
- Two DCGM readings for the same metric disagree → `TEMPORAL_METRIC_CONFLICT` (informational) → both surfaced

### Medical symptom assessment (`medical-symptom-policy.ts`)

Health assistant responds to a patient describing fatigue and excessive thirst.

Without jingu-trust-gate: LLM asserts "You have diabetes" and "You should start metformin" — neither is supportable from symptom records alone.

With jingu-trust-gate:
- Confirmed diagnosis without lab results → `DIAGNOSIS_UNCONFIRMED` → rejected
- Treatment recommendation from symptom evidence → `TREATMENT_NOT_ADVISED` → rejected (hard rule, regardless of evidence count)
- "Symptoms may be consistent with diabetes" at grade=proven → `OVER_CERTAIN` → downgraded to suspected

### Legal contract analysis (`legal-contract-policy.ts`)

Contract review tool answers: "Does this contract have a termination clause?"

Without jingu-trust-gate: LLM says "Yes, the contract includes a termination clause" when the retrieved clause only mentions "cancellation conditions". Different legal concept, different legal effect.

With jingu-trust-gate:
- Legal term not verbatim in clause text → `TERM_NOT_IN_EVIDENCE` → rejected
- Specific penalty percentage not in clause figures → `OVER_SPECIFIC_FIGURE` → downgraded
- Claimed right not explicitly granted by clause → `SCOPE_EXCEEDED` → downgraded

### BI analytics assistant (`bi-analytics-policy.ts`)

Analyst asks: "How much did revenue grow last month?"

Without jingu-trust-gate: LLM says "Revenue grew 15%" when the actual figure from the evidence is 10%. Also asserts "total revenue" when the February record is marked incomplete.

With jingu-trust-gate:
- Growth percentage computed from evidence does not match claim → `INCORRECT_CALCULATION` → rejected (policy does the math: `(110k−100k)/100k = 10%`)
- Trend claim ("grew") with only one period in evidence → `MISSING_BASELINE` → downgraded
- Completeness claim ("total") against incomplete record → `INCOMPLETE_DATA` → downgraded
- Two ETL pipelines report different revenue for same period → `METRIC_CONFLICT` (blocking) → both rejected, analyst is told to fix the data pipeline first

## Known limitations

- **The gate is a judge, not an editor.** It flags problems and annotates boundaries. It does not rewrite claims, fill in missing evidence, or auto-resolve conflicts.
- **Support pool is fixed per admission.** If your retrieval missed the relevant evidence, retry will not help — the gate cannot distinguish "LLM cited wrong evidence" from "evidence does not exist in your system."
- **No cross-session state.** The gate is stateless per call. It does not remember previous admissions or detect patterns across sessions.
- **Performance is O(units × support_pool) per admission.** For large-scale use, optimize `bindSupport` in your policy (e.g., index by `sourceId` before the call).
- **`TUnit` has no id constraint.** The gate does not enforce that your unit type has an `id` field — that is your policy's responsibility.

## Quick start

```ts
import { createTrustGate } from "jingu-trust-gate";
import type { GatePolicy, Proposal, SupportRef, UnitWithSupport,
              UnitEvaluationResult, AdmittedUnit, VerifiedContext,
              StructureValidationResult, RetryFeedback, ConflictAnnotation,
              RenderContext, RetryContext } from "jingu-trust-gate";

type Item = { id: string; text: string; grade: "proven" | "derived" };

// Policy = your domain rules. The gate core has none.
const policy: GatePolicy<Item> = {
  validateStructure: (proposal): StructureValidationResult => ({
    valid: proposal.units.length > 0,
    errors: proposal.units.length === 0
      ? [{ field: "units", reasonCode: "EMPTY_PROPOSAL" }]
      : [],
  }),

  bindSupport: (unit: Item, pool: SupportRef[]): UnitWithSupport<Item> => {
    const matched = pool.filter(s => s.sourceId === unit.id);
    // supportIds: for audit traceability; supportRefs: for attribute inspection in evaluateUnit
    return { unit, supportIds: matched.map(s => s.id), supportRefs: matched };
  },

  evaluateUnit: ({ unit, supportIds }: UnitWithSupport<Item>): UnitEvaluationResult => ({
    unitId: unit.id,
    decision: unit.grade === "proven" && supportIds.length === 0 ? "reject" : "approve",
    reasonCode: unit.grade === "proven" && supportIds.length === 0 ? "MISSING_EVIDENCE" : "OK",
  }),

  // detectConflicts receives UnitWithSupport[] so you can inspect bound evidence per unit
  detectConflicts: (_units: UnitWithSupport<Item>[], _pool: SupportRef[]): ConflictAnnotation[] => [],

  render: (admittedUnits: AdmittedUnit<Item>[], _pool: SupportRef[], _ctx: RenderContext): VerifiedContext => ({
    admittedBlocks: admittedUnits.map(u => ({
      sourceId: u.unitId,
      content: (u.unit as Item).text,
      grade: u.appliedGrades[u.appliedGrades.length - 1],
    })),
    summary: { admitted: admittedUnits.length, rejected: 0, conflicts: 0 },
  }),

  buildRetryFeedback: (results: UnitEvaluationResult[], _ctx: RetryContext): RetryFeedback => ({
    summary: `${results.length} unit(s) failed`,
    errors: results.map(r => ({ unitId: r.unitId, reasonCode: r.reasonCode })),
  }),
};

const gate = createTrustGate({ policy });

const result  = await gate.admit(proposal, supportPool);
const context = gate.render(result);   // VerifiedContext → pass to LLM API
const summary = gate.explain(result);  // { approved, rejected, conflicts, ... }
```

## GatePolicy interface

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
interface GatePolicy<TUnit> {
  validateStructure(proposal: Proposal<TUnit>): StructureValidationResult;
  bindSupport(unit: TUnit, supportPool: SupportRef[]): UnitWithSupport<TUnit>;
  evaluateUnit(unitWithSupport: UnitWithSupport<TUnit>, context: { proposalId: string; proposalKind: string }): UnitEvaluationResult;
  detectConflicts(units: UnitWithSupport<TUnit>[], supportPool: SupportRef[]): ConflictAnnotation[];
  render(admittedUnits: AdmittedUnit<TUnit>[], supportPool: SupportRef[], context: RenderContext): VerifiedContext;
  buildRetryFeedback(unitResults: UnitEvaluationResult[], context: RetryContext): RetryFeedback;
}
```

## Adapters

`VerifiedContext` is abstract. Implement `ContextAdapter<TOutput>` to convert it to the wire format expected by your LLM API. Grade caveats, unsupported attributes, and conflict notes are inlined so the downstream model sees them as contextual constraints.

```ts
import type { ContextAdapter } from "jingu-trust-gate";
import type { VerifiedContext } from "jingu-trust-gate";

class MyAdapter implements ContextAdapter<MyWireFormat> {
  adapt(context: VerifiedContext): MyWireFormat {
    // serialize context.admittedBlocks into your API's expected shape
  }
}
```

Reference implementations for Claude, OpenAI, and Gemini are in [`examples/adapter-examples.ts`](examples/adapter-examples.ts). Copy and adapt as needed — they are not part of the published package.

## SupportRef — not just evidence

`SupportRef` is the unit of context that a proposal unit can be bound to. The name "evidence" is the most common usage, but `sourceType` is a free string — you define the semantics for your domain.

The same mechanism works for any context that needs to constrain what an LLM or agent is allowed to assert or do:

| `sourceType` value | What it represents | Typical domain |
|---|---|---|
| `"document"` / `"observation"` | Retrieved RAG evidence | Knowledge base Q&A |
| `"prerequisite"` | A condition that must be true before a step can run | Agent planning |
| `"system_state"` | Current runtime state (queue depth, error count, flag value) | SRE / ops agents |
| `"user_intent"` / `"explicit_request"` | A statement the user actually made | Tool call / action gate |
| `"user_confirmation"` | Explicit user approval for a risky action | High-risk action gate |
| `"prior_result"` / `"tool_output"` | Output from a previous tool call | Multi-step agents |
| `"permission"` / `"authorization"` | A capability or role grant | Authority enforcement |
| `"finding"` | A concluded fact from earlier reasoning | Research agents |

Your `bindSupport()` and `evaluateUnit()` filter and check by `sourceType`. For example:

```ts
// Tool call gate: reject if no "explicit_request" in support
evaluateUnit(uws) {
  const hasIntent = uws.supportRefs.some(s => s.sourceType === "explicit_request");
  if (!hasIntent) return { decision: "reject", reasonCode: "INTENT_NOT_ESTABLISHED" };
  ...
}

// Action gate: require "user_confirmation" for high-risk irreversible actions
evaluateUnit(uws) {
  if (uws.unit.riskLevel === "high" && !uws.unit.isReversible) {
    const confirmed = uws.supportRefs.some(s => s.sourceType === "user_confirmation");
    if (!confirmed) return { decision: "reject", reasonCode: "CONFIRM_REQUIRED" };
  }
  ...
}

// Agent step gate: reject if required context IDs are not in support pool
evaluateUnit(uws) {
  if (uws.unit.grade === "required" && uws.supportIds.length === 0)
    return { decision: "reject", reasonCode: "MISSING_CONTEXT" };
  ...
}
```

See `examples/tool-call-policy.ts`, `examples/action-gate-policy.ts`, and `examples/agent-step-policy.ts` for complete working implementations of each pattern.

## SupportRef ID clarification

`SupportRef` has two IDs that serve different purposes:

- `id` — system-internal, written to `supportIds` in audit entries for traceability back to the exact record
- `sourceId` — business identity, used in `bindSupport` to match claims against the evidence pool

When writing `bindSupport`, match on `sourceId` (business key). The `id` fields flow automatically into the audit log.

## Module structure

```
src/types/        — core type definitions (Proposal, SupportRef, AdmissionResult, ...)
src/gate/         — GateRunner (4-step pipeline, zero LLM)
src/audit/        — FileAuditWriter, audit entry builder
src/retry/        — runWithRetry, RetryFeedback utils
src/conflict/     — ConflictAnnotation surfacing helpers
src/renderer/     — BaseRenderer → VerifiedContext
src/adapters/     — ContextAdapter interface (implementations in examples/)
src/trust-gate.ts — createTrustGate() public API

examples/
  adapter-examples.ts        — Claude, OpenAI, Gemini adapter reference implementations
  medical-symptom-policy.ts  — health assistant, diagnosis/treatment gate
  legal-contract-policy.ts   — contract review, term/figure/right grounding
  hpc-diagnostic-policy.ts   — GPU cluster SRE, severity/scope/metric gate
  ecommerce-catalog-policy.ts — product chatbot, feature/stock/conflict gate
  bi-analytics-policy.ts     — BI assistant, value/period/dimension gate
```

## Install and run

```bash
npm install
npm test     # 85 tests
npm run demo # narrative demo with 6 scenarios

# Run examples
node dist/examples/medical-symptom-policy.js
node dist/examples/legal-contract-policy.js
node dist/examples/hpc-diagnostic-policy.js
node dist/examples/ecommerce-catalog-policy.js
node dist/examples/bi-analytics-policy.js
```

## FAQ

**Q: Why does policy exist as code instead of a prompt?**
LLM judgement is probabilistic and not reproducible. Policy as code is deterministic — the same input always produces the same admission decision, which can be audited and tested. `evaluateUnit` is a pure function.

**Q: Is jingu-trust-gate judging whether a claim is true or false?**
No. The gate judges whether a claim is *supported by the available evidence*. A claim can be factually correct but still be rejected if no evidence in the pool supports it. A claim can be factually wrong but pass if the evidence is misleading. Truth-checking is the retrieval system's job. The gate enforces the boundary between what the evidence allows and what the LLM asserted.

**Q: Should I pass the policy to the LLM as part of the prompt?**
You can, as soft guidance. A policy summary in the prompt helps the LLM propose claims that are more likely to pass the gate, reducing unnecessary retry cycles. But prompt guidance is not enforcement — the LLM can ignore it, partially comply, or comply on surface while violating intent. The gate is the only enforcement. Use the policy in two roles:
- `policy-as-instruction` → simplified summary in the LLM prompt to improve proposal quality
- `policy-as-enforcement` → full code executed by the gate to admit or reject

**Q: When should a conflict be `blocking` vs `informational`?**
Use `blocking` when the claims are mutually exclusive and surfacing either one unchecked would be unsafe — e.g. "in stock" vs "out of stock" for the same product, or two ETL pipelines reporting different revenue for the same period. The gate force-rejects both and the LLM receives an empty context. Use `informational` when both sides of the conflict are useful to the downstream LLM — e.g. two timestamps that disagree, or two conditions that are both weakly suggested by symptoms. The LLM receives both with `conflictNote` and can surface the discrepancy to the user.

**Q: Why downgrade instead of reject when a claim is over-specific?**
Reject discards information. Downgrade preserves the claim with a reduced grade and `unsupportedAttributes` flagged. The downstream LLM receives the reduced claim and hedges its language accordingly — "evidence suggests" rather than "confirmed". Use reject only when the claim has no grounding at all (`MISSING_EVIDENCE`) or when the assertion is categorically unsafe regardless of evidence (e.g. treatment recommendations from symptom records).

**Q: What happens when the support pool is empty?**
Every `proven` claim fails with `MISSING_EVIDENCE`. `derived` claims also fail. Only `suspected` claims (already hedged) pass. This is intentional — an empty pool means retrieval found nothing, and the gate cannot distinguish "LLM cited wrong evidence" from "evidence does not exist". The retry mechanism will not help; fix the retrieval layer.

## Policy design guide

### Principles

**Claim strength must match evidence strength.** An `observation` (single log line) cannot support a `root_cause` assertion. Build a strength ladder in your policy and enforce it in `evaluateUnit`.

**Separate generation from verification.** The LLM proposes. The gate verifies. Never let the LLM self-certify — a claim with `grade=proven` and `evidenceRefs=[]` is the canonical failure mode jingu-trust-gate exists to catch.

**Evidence is a first-class object.** A claim cannot be its own evidence. Every `proven` or `derived` claim must cite at least one `SupportRef` by `sourceId`. The `id` flows to the audit log; the `sourceId` is what `bindSupport` matches against.

**Downgrade before you reject.** If a claim is partially supportable, admit it with a reduced grade and `unsupportedAttributes` flagged. Reject is for claims with zero grounding or categorically unsafe assertions. Information lost at the gate cannot be recovered downstream.

**Surface conflicts, never resolve them.** The gate does not pick a winner between contradictory claims. `informational` conflicts annotate both and pass them through. `blocking` conflicts reject both. The downstream LLM or a human decides what to do with the ambiguity.

**retrieval ≠ admission.** Retrieval finds candidate evidence. Admission decides which claims are grounded in that evidence. They are separate steps with separate failure modes. A retrieval miss is not the same as a gate rejection.

### Patterns

| Pattern | Description |
|---------|-------------|
| Claim ladder | Define `observation < symptom < hypothesis < root_cause`. Raise the evidence bar at each level. |
| Evidence composition | Require multiple independent evidence types for high-strength claims (e.g. root cause needs log + metric + k8s event). |
| Attribute-level gating | Evaluate each asserted attribute separately — presence may be approved while brand and quantity are downgraded. |
| Safe-action policy | For agentic systems, only admit action claims that are non-destructive (check / inspect / run diagnostics). Reject claims that assert delete / restart / replace without explicit confirmation evidence. |
| Conflict-first rendering | In `render()`, place `approved_with_conflict` blocks first so the downstream LLM sees the ambiguity before the facts. |

### Anti-patterns

| Anti-pattern | What goes wrong |
|-------------|-----------------|
| LLM self-certification | `grade=proven, evidenceRefs=[]` — the LLM asserts facts it invented. Caught by `MISSING_EVIDENCE`. |
| Policy only in prompt | Prompt guidance is suggestion, not enforcement. The gate must exist in code. |
| Retrieved = true | Retrieval returning a document does not mean the document supports the claim. `bindSupport` + `evaluateUnit` enforce the connection. |
| Root cause from single signal | One log line is not enough to assert root cause. Require cross-domain evidence composition. |
| Discarding downgraded information | Rejecting over-specific claims instead of downgrading loses the valid core. Prefer `OVER_SPECIFIC_*` → downgrade. |
| Confusing observation with inference | "Log says X" (observation) ≠ "Root cause is Y" (inference). The claim grade and policy rules must reflect the inference step. |
| gate as reasoner | The gate executes policy — it does not reason, interpret, or fill in gaps. If the policy cannot decide, it should downgrade or reject, not guess. |

## Changelog

### 0.1.7
- Code quality audit across all source files: fixed stale comments, removed dead code, eliminated LLM-specific language from generic infrastructure
- `AuditEntry.downgradeCount` renamed to `downgradedCount` for naming consistency; JSONL key updated to `"downgradedCount"` (aligns with Python SDK)
- Removed unused imports and consolidated adapter imports in demo

### 0.1.6
- Adapter implementations (Claude, OpenAI, Gemini) moved from core to `examples/adapter-examples.ts`; only `ContextAdapter` interface remains in the public API
- Removed unused dependencies (`@anthropic-ai/sdk`, `ajv`) — zero runtime dependencies
- Fixed test glob pattern to correctly pick up all test files
- README rewritten with full quick start, GatePolicy interface table, examples table

### 0.1.5
- Initial public release
- Six example domain policies: medical, legal, HPC, e-commerce, BI analytics
- Full retry loop with typed `RetryFeedback`
- File audit writer (append-only JSONL)

## License

MIT
