# answers/

Gate what an LLM is allowed to claim in a response.

The core idea: the LLM retrieves evidence, then proposes claims. The gate checks
each claim against its cited evidence before the response is assembled. Claims
that over-assert beyond what the evidence supports are downgraded or blocked.

**When to use this pattern:**
- RAG / Q&A systems where retrieved documents are the evidence
- Any response that cites sources and must not assert beyond them
- Downstream systems that need to trust the content they receive

| File | Domain | Key reason codes |
|------|--------|-----------------|
| `medical-symptom-policy.ts` | Health assistant | `DIAGNOSIS_UNCONFIRMED`, `TREATMENT_NOT_ADVISED`, `OVER_CERTAIN` |
| `legal-contract-policy.ts` | Contract review | `TERM_NOT_IN_EVIDENCE`, `OVER_SPECIFIC_FIGURE`, `SCOPE_EXCEEDED` |

```
evidence pool  →  LLM proposes claims  →  gate  →  VerifiedContext  →  LLM response
```
