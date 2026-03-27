import { GateRunner } from "./gate/gate-runner.js";
import { runWithRetry } from "./retry/retry-loop.js";
import { BaseRenderer } from "./renderer/base-renderer.js";
import { createDefaultAuditWriter } from "./audit/audit-log.js";
import type { Proposal } from "./types/proposal.js";
import type { SupportRef } from "./types/support.js";
import type { GatePolicy } from "./types/policy.js";
import type { AdmissionResult } from "./types/admission.js";
import type { AuditWriter } from "./types/audit.js";
import type {
  VerifiedContext,
  RenderContext,
  GateExplanation,
} from "./types/renderer.js";
import type { LLMInvoker, RetryConfig } from "./types/retry.js";

export type TrustGateConfig<TUnit> = {
  policy: GatePolicy<TUnit>;
  auditWriter?: AuditWriter; // default: FileAuditWriter at .jingu-trust-gate/audit.jsonl
  retry?: RetryConfig;
  // content extractor for BaseRenderer — how to turn TUnit into text for Claude
  extractContent?: (unit: TUnit, support: SupportRef[]) => string;
};

export type TrustGate<TUnit> = {
  /**
   * Synchronous admission — runs Gate only, no LLM.
   * Proposal must already be schema-valid (obtained via output_config.format or strict:true).
   */
  admit(
    proposal: Proposal<TUnit>,
    support: SupportRef[]
  ): Promise<AdmissionResult<TUnit>>;

  /**
   * Async admission with semantic retry.
   * LLMInvoker encapsulates one complete LLM interaction (may contain tool_use loop).
   * RetryFeedback is passed to invoker as structured type — invoker serializes it
   * as tool_result + is_error:true for Claude's built-in retry understanding.
   */
  admitWithRetry(
    invoker: LLMInvoker<TUnit>,
    support: SupportRef[],
    prompt: string
  ): Promise<AdmissionResult<TUnit>>;

  /**
   * Render admitted units → VerifiedContext (input for Claude API).
   * NOT the final user-facing text — pass VerifiedContext to Claude for language generation.
   *
   * Pass the same support pool used in admit() so the renderer can access
   * SupportRef attributes (source URLs, confidence, etc.).
   */
  render(
    result: AdmissionResult<TUnit>,
    support?: SupportRef[],
    context?: RenderContext
  ): VerifiedContext;

  /**
   * Read-only summary of admission result — for orchestrators that don't need render.
   */
  explain(result: AdmissionResult<TUnit>): GateExplanation;
};

export function createTrustGate<TUnit>(config: TrustGateConfig<TUnit>): TrustGate<TUnit> {
  const auditWriter = config.auditWriter ?? createDefaultAuditWriter();
  const runner = new GateRunner(config.policy, auditWriter);
  const renderer = new BaseRenderer();
  const extractContent = config.extractContent ?? (() => "");

  return {
    async admit(proposal, support) {
      return runner.run(proposal, support);
    },

    async admitWithRetry(invoker, support, prompt) {
      const { result } = await runWithRetry(
        invoker,
        support,
        config.policy,
        prompt,
        config.retry,
        auditWriter
      );
      return result;
    },

    render(result, support = [], context = {}) {
      const ctx = config.policy.render
        ? config.policy.render(result.admittedUnits, support, context)
        : renderer.render(
            result.admittedUnits,
            support,
            context,
            extractContent
          );
      // policy.render() doesn't receive rejectedUnits — patch the count here
      ctx.summary.rejected = result.rejectedUnits.length;
      return ctx;
    },

    explain(result) {
      return explainResult(result);
    },
  };
}

export function explainResult<TUnit>(
  result: AdmissionResult<TUnit>
): GateExplanation {
  const allUnits = [...result.admittedUnits, ...result.rejectedUnits];
  const reasonCodes = new Set<string>();

  for (const unit of allUnits) {
    for (const ev of unit.evaluationResults) {
      reasonCodes.add(ev.reasonCode);
    }
  }

  return {
    totalUnits: allUnits.length,
    approved: result.admittedUnits.filter((u) => u.status === "approved").length,
    downgraded: result.admittedUnits.filter((u) => u.status === "downgraded").length,
    conflicts: result.admittedUnits.filter(
      (u) => u.status === "approved_with_conflict"
    ).length,
    rejected: result.rejectedUnits.length,
    retryAttempts: result.retryAttempts,
    gateReasonCodes: [...reasonCodes],
  };
}
