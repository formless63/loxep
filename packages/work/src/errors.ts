/**
 * @loxep/work error types.
 *
 * Mirrors the @loxep/counterparties, @loxep/inventory, and @loxep/accounting
 * precedent: a small hierarchy rooted at one base class so callers can
 * discriminate without string matching.
 */

/** Base class for all @loxep/work errors. */
export class WorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input failed its Zod schema or a domain invariant. */
export class WorkValidationError extends WorkError {}

/** A referenced project, time entry, billing rate, or material use is absent. */
export class WorkNotFoundError extends WorkError {}

/** A uniqueness or structural rule was violated — a duplicate reference code, a movement already linked. */
export class WorkConflictError extends WorkError {}

/**
 * A domain rule the schema cannot express alone was crossed.
 *
 * Raised where the CHECK constraints do not reach: editing a locked time
 * entry or material use, or a rate-resolution precondition the caller did
 * not satisfy.
 */
export class WorkBoundaryError extends WorkError {}
