// Public API — implemented in later phases
// Types are re-exported here for consumer convenience
export type {
  Proposal,
  ProposalKind,
  SupportRef,
  UnitWithSupport,
  StructureValidationResult,
  UnitEvaluationResult,
  ConflictDetectionResult,
  ConflictAnnotation,
  GateResultLog,
  UnitStatus,
  AdmittedUnit,
  AdmissionResult,
  GatePolicy,
  RetryFeedback,
  RetryConfig,
  RetryContext,
  LLMInvoker,
  AuditEntry,
  AuditWriter,
  VerifiedBlock,
  VerifiedContext,
  RenderContext,
  GateExplanation,
} from "./types/index.js";

export { FileAuditWriter, createDefaultAuditWriter } from "./audit/audit-log.js";
export { buildAuditEntry } from "./audit/audit-entry.js";

export {
  surfaceConflicts,
  groupConflictsByCode,
  hasConflicts,
} from "./conflict/conflict-annotator.js";
export type { ConflictSurface } from "./conflict/conflict-annotator.js";

// Gate Engine
export { GateRunner } from "./gate/gate-runner.js";

// Renderer
export { BaseRenderer } from "./renderer/base-renderer.js";

// Public API
export { createTrustGate, explainResult } from "./trust-gate.js";
export type { TrustGateConfig, TrustGate } from "./trust-gate.js";

// Retry Loop
export { runWithRetry } from "./retry/retry-loop.js";
export type { RetryLoopResult } from "./retry/retry-loop.js";
export {
  collectRetryableResults,
  needsRetry,
  buildDefaultRetryFeedback,
} from "./retry/retry-feedback.js";

// Adapters — convert VerifiedContext to LLM API wire format
export type { ContextAdapter } from "./adapters/context-adapter.js";

export { ClaudeContextAdapter } from "./adapters/claude-adapter.js";
export type { ClaudeSearchResultBlock, ClaudeAdapterOptions } from "./adapters/claude-adapter.js";

export { OpenAIContextAdapter } from "./adapters/openai-adapter.js";
export type { OpenAIChatMessage, OpenAIAdapterOptions } from "./adapters/openai-adapter.js";

export { GeminiContextAdapter } from "./adapters/gemini-adapter.js";
export type { GeminiContent, GeminiTextPart, GeminiAdapterOptions } from "./adapters/gemini-adapter.js";
