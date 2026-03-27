# state/

Gate what an LLM is allowed to write into persistent state.

The core idea: while `answers/` controls what appears in a single response,
`state/` controls what becomes part of your system's durable data. Writes that
fail the gate never reach storage — they don't accumulate and don't corrupt
future queries.

**When to use this pattern:**
- Personal assistants that maintain a memory store of user facts
- Knowledge bases where an agent proposes new entries from retrieved sources
- Profile or preference systems where writes must trace back to user statements
- Any system where LLM-proposed mutations need to be verified before persisting

| File | Domain | Key reason codes |
|------|--------|-----------------|
| `memory-update-policy.ts` | Personal memory assistant | `SOURCE_UNVERIFIED`, `INFERRED_NOT_STATED`, `SCOPE_VIOLATION` |
| `fact-write-policy.ts` | Knowledge base write gate | `UNSOURCED`, `OVER_SPECIFIC`, `LOW_CONFIDENCE_SOURCE`, `CONFLICTING_VALUES` |

```
user statement or retrieved source  →  LLM proposes writes  →  gate  →  memory / KB store
```

**Why this matters more than `answers/`:**
A hallucinated claim in a response affects one reply. A hallucinated write to
persistent state affects every future query that retrieves it. The gate is the
last line of defense before bad data becomes part of your ground truth.
