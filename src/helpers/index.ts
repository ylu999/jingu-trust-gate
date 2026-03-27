/**
 * Ergonomic helpers for common policy boilerplate.
 *
 * These helpers eliminate repetitive patterns that appear across GatePolicy
 * implementations. They are optional — every helper can be replaced with
 * equivalent inline code.
 *
 * Design constraints (see ARCHITECTURE.md):
 * - No domain semantics (no risk levels, no justification schemas, no grade rules)
 * - No approve/downgrade/reject logic
 * - No required fields or mandatory schemas
 * - Thin functions only, no base classes or mixins
 *
 * Import from submodule for tree-shaking:
 *   import { hasSupportType } from "jingu-trust-gate/helpers/support"
 *
 * Or import everything:
 *   import { hasSupportType, hintsFeedback, emptyProposalErrors } from "jingu-trust-gate/helpers"
 */

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
