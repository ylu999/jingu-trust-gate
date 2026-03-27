import type { Proposal } from "./proposal.js";

// Structured retry feedback — NOT a string.
// LLMInvoker implementer is responsible for serializing this
// into tool_result + is_error: true for Claude API.
export type RetryFeedback = {
  summary: string;
  errors: Array<{
    unitId?: string;
    reasonCode: string;
    details?: Record<string, unknown>;
  }>;
};

export type RetryConfig = {
  maxRetries: number; // default: 3
  // which decisions trigger a retry; default: ["reject"]
  retryOnDecisions: Array<"reject" | "downgrade">;
};

export type RetryContext = {
  attempt: number;
  maxRetries: number;
  proposalId: string;
};

// LLMInvoker encapsulates ONE complete LLM interaction
// (which may internally contain multiple tool_use/tool_result turns).
// It is NOT a single API call.
// The implementer is responsible for:
//   - Using output_config.format / strict: true to get schema-valid Proposal
//   - Serializing RetryFeedback as tool_result + is_error: true for Claude's built-in retry
export type LLMInvoker<TUnit> = (
  prompt: string,
  feedback?: RetryFeedback
) => Promise<Proposal<TUnit>>;
