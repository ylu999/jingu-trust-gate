/**
 * Ergonomic helpers for common policy boilerplate.
 *
 * These helpers eliminate repetitive patterns that appear across GatePolicy
 * implementations. They are optional — every helper can be replaced with
 * equivalent inline code.
 *
 * Design constraints (see ARCHITECTURE.md):
 * - No domain semantics (no risk levels, no justification schemas, no grade rules)
 * - No required fields or mandatory schemas
 * - Thin functions only, no base classes or mixins
 *
 * Modules:
 *   outcomes — approve(), reject(), downgrade() outcome builders
 *   rules    — firstFailing() combinator for evaluateUnit()
 *   support  — sourceType and attributes queries on SupportRef arrays
 *   structure — common validateStructure checks
 *   feedback — hintsFeedback() for buildRetryFeedback()
 */

export { approve, reject, downgrade } from "./outcomes.js";

export { firstFailing } from "./rules.js";

export {
  hasSupportType,
  findSupportByType,
  filterSupportByType,
  hasSupportAttr,
  findSupportByAttr,
  filterSupport,
} from "./support.js";

export {
  emptyProposalErrors,
  missingIdErrors,
  missingTextField,
} from "./structure.js";

export { hintsFeedback } from "./feedback.js";
