import type { SupportRef } from "../types/support.js";
import type { GatePolicy } from "../types/policy.js";
import type { AdmissionResult } from "../types/admission.js";
import type { LLMInvoker, RetryConfig, RetryContext } from "../types/retry.js";
import type { AuditWriter } from "../types/audit.js";
import { GateRunner } from "../gate/gate-runner.js";
import { needsRetry, collectRetryableResults } from "./retry-feedback.js";

export type RetryLoopResult<TUnit> = {
  result: AdmissionResult<TUnit>;
  attempts: number; // total LLM invocations (1 = no retry needed)
};

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryOnDecisions: ["reject"],
};

/**
 * runWithRetry — semantic-level retry loop.
 *
 * Key design:
 * - LLMInvoker encapsulates ONE complete LLM interaction (may contain multiple tool_use turns).
 * - RetryFeedback is structured (not a string). The LLMInvoker implementer is responsible
 *   for serializing it as tool_result + is_error: true to leverage Claude's built-in retry.
 * - harness decides WHETHER to retry (gate semantic rejection).
 * - LLMInvoker decides HOW to pass feedback to the LLM.
 */
export async function runWithRetry<TUnit>(
  invoker: LLMInvoker<TUnit>,
  support: SupportRef[],
  policy: GatePolicy<TUnit>,
  prompt: string,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  auditWriter?: AuditWriter
): Promise<RetryLoopResult<TUnit>> {
  const runner = new GateRunner(policy, auditWriter);
  let lastResult: AdmissionResult<TUnit> | undefined;
  let attempts = 0;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    attempts = attempt + 1;

    // Get feedback from previous attempt (undefined on first attempt)
    const feedback =
      attempt > 0 && lastResult
        ? buildFeedbackFromResult(lastResult, policy, attempt, config)
        : undefined;

    // Invoke LLM (complete interaction, may contain tool loop internally)
    const proposal = await invoker(prompt, feedback);

    // Run gate engine
    lastResult = await runner.run(proposal, support);

    // Collect unit evaluation results for retry check
    const allUnitResults = [
      ...lastResult.admittedUnits.flatMap((u) => u.evaluationResults),
      ...lastResult.rejectedUnits.flatMap((u) => u.evaluationResults),
    ];

    // Check if retry is needed
    if (!needsRetry(allUnitResults, config.retryOnDecisions)) {
      break; // converged
    }

    // Last attempt reached, stop regardless
    if (attempt >= config.maxRetries) {
      break;
    }
  }

  // Attach retry count to result
  const finalResult: AdmissionResult<TUnit> = {
    ...lastResult!,
    retryAttempts: attempts,
  };

  return { result: finalResult, attempts };
}

function buildFeedbackFromResult<TUnit>(
  result: AdmissionResult<TUnit>,
  policy: GatePolicy<TUnit>,
  attempt: number,
  config: RetryConfig
) {
  const allUnitResults = [
    ...result.admittedUnits.flatMap((u) => u.evaluationResults),
    ...result.rejectedUnits.flatMap((u) => u.evaluationResults),
  ];
  const retryableResults = collectRetryableResults(
    allUnitResults,
    config.retryOnDecisions
  );

  const context: RetryContext = {
    attempt,
    maxRetries: config.maxRetries,
    proposalId: result.proposalId,
  };

  return policy.buildRetryFeedback(retryableResults, context);
}
