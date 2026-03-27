/**
 * Rule combinators for evaluateUnit() implementations.
 *
 * These combinators operate on already-evaluated check results, not on callables.
 * Each check function in your policy should return:
 *   - undefined  if the unit passes the check or the check does not apply
 *   - UnitEvaluationResult with decision !== "approve" if evaluation should stop
 *
 * A check must NOT return an approve() result. That is the caller's responsibility.
 * Returning approve() from a check is a contract violation and will throw.
 *
 * Typical usage:
 *
 *   import { approve, reject, downgrade } from "../src/helpers/outcomes.js";
 *   import { firstFailing } from "../src/helpers/rules.js";
 *
 *   evaluateUnit({ unit, supportRefs, ... }, _ctx) {
 *     return firstFailing([
 *       checkIntent(unit, supportRefs),
 *       checkConfirmation(unit, supportRefs),
 *       checkAuthorization(unit, supportRefs),
 *     ]) ?? approve(unit.id);
 *   }
 */

import type { UnitEvaluationResult } from "../types/gate.js";

/**
 * Return the first result with decision !== "approve", or undefined if all pass.
 *
 * @param results A sequence of check outcomes. Each element is either:
 *                - undefined: the check passed or did not apply
 *                - UnitEvaluationResult with decision "reject" or "downgrade"
 *
 * @returns The first non-undefined result, or undefined if all checks passed.
 *
 * @throws If any non-undefined result has decision === "approve".
 *         Check functions must return undefined to signal pass, not approve().
 */
export function firstFailing(
  results: Array<UnitEvaluationResult | undefined>,
): UnitEvaluationResult | undefined {
  for (const result of results) {
    if (result === undefined) continue;
    if (result.decision === "approve") {
      throw new Error(
        `check returned an approve result for unit '${result.unitId}' ` +
        `(reasonCode='${result.reasonCode}'). ` +
        "Check functions must return undefined to signal pass, not approve(). " +
        "Only the caller (evaluateUnit) should produce the final approve.",
      );
    }
    return result;
  }
  return undefined;
}
