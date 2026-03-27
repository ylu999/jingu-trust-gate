# actions/

Gate what an LLM agent is allowed to do.

The core idea: before any tool is called or action executed, the gate checks that
the action is grounded in user intent, not redundant, and (for high-risk actions)
explicitly confirmed. Actions that fail these checks are blocked before execution.

**When to use this pattern:**
- Tool-calling agents (function calls, API calls, search queries)
- Agentic systems that take write-side or irreversible actions
- Any case where you need to enforce "user said this" before acting

| File | Domain | Key reason codes |
|------|--------|-----------------|
| `tool-call-policy.ts` | LLM tool call gate | `REDUNDANT_CALL`, `INTENT_NOT_ESTABLISHED`, `WEAK_JUSTIFICATION`, `MISSING_EXPECTED_VALUE` |
| `action-gate-policy.ts` | Irreversible action gate | `CONFIRM_REQUIRED`, `DESTRUCTIVE_WITHOUT_AUTHORIZATION`, `SCOPE_EXCEEDED`, `CONTRADICTORY_ACTIONS` |

```
user intent (SupportRef)  →  LLM proposes actions  →  gate  →  admitted actions  →  execute
```

The key `source_type` values for this pattern:
- `"user_message"` / `"explicit_user_request"` — establishes intent
- `"prior_result"` — proves a tool was already called (REDUNDANT_CALL check)
- `"user_confirmation"` — required for high-risk irreversible actions
