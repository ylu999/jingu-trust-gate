# Architecture

## Mental model

```
AI  →  propose
           ↓
        verify
           ↓
    accept / reject
```

LLMs are proposal generators. They produce confident output whether or not it is correct. This repo is the layer that decides which proposals are allowed to become system state.

The core rule: **nothing is accepted unless it can be proven against evidence.**

This applies to any LLM output: a RAG claim, an agent step, a tool call, an irreversible action. The domain changes; the admission model does not.

## What this repo is

A **generic admission engine** for LLM proposals.

```
Proposal<TUnit> + SupportRef[] → GatePolicy<TUnit> → AdmissionResult<TUnit>
```

`TUnit` is whatever your domain needs: a RAG claim, an agent step, a tool call, an action request, a mutation plan. The engine does not care. The policy does.

## Three-layer model

```
Layer 1: Core engine          src/
Layer 2: Ergonomic helpers    src/helpers/
Layer 3: Reference policies   examples/
```

### Layer 1 — Core engine

The engine owns:
- The admission pipeline: `validateStructure → bindSupport → evaluateUnit → detectConflicts → render`
- The decision model: `approve | downgrade | reject`
- The evidence model: `SupportRef`, `UnitWithSupport`, `AdmittedUnit`, `VerifiedContext`
- The operational model: audit, explanation, retry loop

The engine does **not** know:
- What a "tool call" is
- What a "research step" is
- What "high risk" means
- What fields a unit must have
- How many supports count as sufficient

**Every domain concept lives in GatePolicy, not in the engine.**

### Layer 2 — Ergonomic helpers (`src/helpers/`)

Thin functions that eliminate repetitive boilerplate across policy implementations. Three modules:

| Module | What it covers |
|--------|---------------|
| `helpers/support` | `sourceType` and `attributes` queries on `SupportRef[]` |
| `helpers/structure` | Common `validateStructure` checks: empty proposal, missing id, empty field |
| `helpers/feedback` | `hintsFeedback()` — the hints-dict → `RetryFeedback` pattern |

**Helpers stop at the mechanism boundary.** A helper may filter refs by `sourceType`, but it does not know what `"user_confirmation"` means. A helper may check whether a text field is empty, but it does not declare which fields are required. A helper may build a `RetryFeedback` from a hints map, but it does not define what the hints should say.

### Layer 3 — Reference policies (`examples/`)

Complete, runnable `GatePolicy` implementations for real domains. These are templates for users to read and adapt, not components to import.

| File | Domain |
|------|--------|
| `medical-symptom-policy` | Health assistant — diagnosis/treatment gate |
| `legal-contract-policy` | Contract review — term/figure/right grounding |
| `hpc-diagnostic-policy` | GPU cluster SRE — severity/scope/metric gate |
| `ecommerce-catalog-policy` | Product chatbot — feature/stock/conflict gate |
| `bi-analytics-policy` | BI assistant — value/period/dimension gate |
| `agent-step-policy` | Research agent — context/findings/redundancy gate |
| `tool-call-policy` | LLM tool calls — intent/redundancy/justification gate |
| `action-gate-policy` | Irreversible actions — authorization/confirmation/conflict gate |

## The boundary principle

**Mechanism belongs in the engine. Semantics belong in the policy.**

| Mechanism (engine) | Semantics (policy) |
|---|---|
| A unit can be downgraded | What triggers a downgrade |
| Support can be bound to a unit | Which source types count as evidence |
| Conflicts can be annotated | What constitutes a conflict |
| Retry feedback can be structured | What the feedback should say |
| A proposal has a structure | What fields are required |

The test: **if a rule needs to know `grade`, `risk`, `stepType`, or `sourceType` semantics, it belongs in the policy, not in the engine or helpers.**

## What helpers must not become

A helper that starts doing any of the following has crossed the line:

- Knows what `grade` values mean
- Decides approve / downgrade / reject
- Enforces a justification schema
- Defines a risk taxonomy
- Checks whether a count of supports is "sufficient"
- Requires a specific `sourceType` to exist

Once a helper crosses this line, it becomes an opinionated policy layer — useful for one domain, wrong for another.

## `SupportRef.sourceType` is a free string

`sourceType` is defined by the policy, not by the engine. The engine never inspects it.

Common values used in the reference policies:

| Value | What it represents |
|---|---|
| `"document"` / `"observation"` | Retrieved RAG evidence |
| `"prerequisite"` | A condition that must be true before a step runs |
| `"system_state"` | Current runtime state |
| `"user_intent"` / `"explicit_request"` | A statement the user actually made |
| `"user_confirmation"` | Explicit user approval for a risky action |
| `"prior_result"` / `"tool_output"` | Output from a previous tool call |
| `"permission"` / `"authorization"` | A capability or role grant |
| `"finding"` | A concluded fact from earlier reasoning |

These are conventions, not constants. Your policy defines its own vocabulary.

## What to add vs. what to resist

### Add to the engine when:
- The capability is needed by every possible `GatePolicy`
- It has no domain assumptions
- Without it, every implementer would write the same boilerplate differently

### Add to helpers when:
- The pattern appears in 2+ example policies
- It introduces no domain semantics
- The inline version is more noise than the helper call

### Add to examples when:
- It's a domain-specific rule or convention
- It demonstrates a new use case for the engine
- It's something users will want to copy and adapt

### Resist adding to the engine or helpers when:
- It requires knowing what `grade` values mean
- It enforces a specific justification schema
- It defines a risk taxonomy
- It encodes step ordering rules
- It decides what count of supports is "sufficient"

## Three iron laws

1. **Zero LLM calls in the gate** — all four pipeline steps are deterministic code.
2. **Policy is injected** — the gate core has zero business logic.
3. **Every admission is audited** — append-only JSONL.
