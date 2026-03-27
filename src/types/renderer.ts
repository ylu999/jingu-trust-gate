// VerifiedContext is what harness produces — it is INPUT to Claude API,
// NOT the final user-facing text. Claude generates the final text.
// This maps to Claude API's search_result blocks or tool_result content.
export type VerifiedBlock = {
  sourceId: string; // maps to SupportRef.sourceId
  content: string; // verified content — policy-determined, not LLM raw text
  grade?: string; // downgraded grade (Claude uses this as context)
  conflictNote?: string; // present when status === "approved_with_conflict"
  unsupportedAttributes?: string[]; // attributes the claim made but evidence does not support
};

export type VerifiedContext = {
  admittedBlocks: VerifiedBlock[];
  summary: {
    admitted: number;
    rejected: number;
    conflicts: number;
  };
  // Optional instructions to inject into system prompt
  instructions?: string;
};

export type RenderContext = {
  userLocale?: string;
  channelType?: "chat" | "api" | "notification";
  metadata?: Record<string, unknown>;
};

export type GateExplanation = {
  totalUnits: number;
  approved: number;
  downgraded: number;
  conflicts: number;
  rejected: number;
  retryAttempts: number;
  gateReasonCodes: string[];
};
