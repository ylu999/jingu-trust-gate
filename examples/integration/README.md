# integration/

Connect jingu-trust-gate to your system.

These examples cover the operational and integration concerns that apply across
all use cases: audit logging, retry loops, LLM API adapters, and the
`extractContent` configuration.

| File | What it shows |
|------|--------------|
| `audit-writer-example.ts` | `FileAuditWriter` — writes JSONL to `.jingu-trust-gate/audit.jsonl` (Law 3) |
| `downgrade-retry-example.ts` | `retryOnDecisions: ["downgrade"]` — retry loop when claims are downgraded |
| `adapter-examples.ts` | `ContextAdapter` for Claude, OpenAI, and Gemini wire formats |

**Audit logging (Law 3):**
Replace `NoopAuditWriter()` with `new FileAuditWriter()` in production. Every
`gate.admit()` call appends one JSONL line: proposalId, timestamp, approved/
rejected counts, and reason codes. The log is append-only.

**Downgrade retry:**
Default behavior admits downgraded units. Set `retryOnDecisions: ["downgrade"]`
to trigger `buildRetryFeedback()` on downgrades — the LLM receives structured
feedback and is asked to revise. Use this when precision matters more than
throughput.

**Adapters:**
`VerifiedContext` is abstract. Implement `ContextAdapter<T>` to convert it to
your LLM API's wire format. Reference adapters for Claude, OpenAI, and Gemini
are in `adapter-examples.ts`.
