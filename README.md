# Jingu Harness

A governed acceptance layer for LLM-powered systems.

## What it does

```
LLM Output
    |
    v
Jingu Harness
  [ verify + invariants ]
    |          |
    v          v
 accept      reject / retry
    |
    v
system state
```

Jingu Harness sits between your LLM and your system state. Every output from the LLM must pass through the harness before it can affect the system. The harness runs verification checks and invariant assertions — if they pass, the output is accepted; if not, it is rejected or sent back for repair.

## What Jingu Harness does

- Runs structured verifiers against LLM outputs
- Enforces invariants that must always hold
- Produces typed evidence for every accept/reject decision
- Supports retry loops with repair hints
- Keeps a decision log for auditability

## What Jingu Harness does NOT do

- Does NOT call LLMs itself (bring your own LLM client)
- Does NOT manage prompts or conversation history
- Does NOT persist state (bring your own storage)
- Does NOT enforce business logic (define your own invariants)

## Modules

| Module | Purpose |
|--------|---------|
| `src/adapter/claude/` | Claude-specific output adapter |
| `src/verify/` | Verifier registry and runner |
| `src/invariant/` | Invariant definitions and checker |
| `src/decision/` | Accept / reject / retry decision logic |
| `src/evidence/` | Evidence schema and builder |
| `src/runtime/` | Execution loop: verify → decide → apply |
| `src/loader/` | Load and validate harness config |
| `src/policy/` | Policy rules for governance |

## Usage

```typescript
import { runHarness } from "jingu-harness";

const result = await runHarness({
  output: llmOutput,
  verifiers: [...],
  invariants: [...],
});

if (result.decision === "accept") {
  applyToSystem(result.output);
} else {
  handleRejection(result.evidence);
}
```

## License

MIT
