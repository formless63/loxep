/**
 * @loxep/accounting error types.
 *
 * Mirrors the @loxep/domain, @loxep/market, @loxep/commerce, and
 * @loxep/inventory precedent: a small hierarchy rooted at one base class so
 * callers can discriminate without string matching. Messages may reference ids,
 * reference codes, amounts, currencies, and structural facts — never credential
 * material and never a payee's personal data beyond what the caller supplied.
 */

/** Base class for all @loxep/accounting errors. */
export class AccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input failed its Zod schema or a domain invariant. */
export class AccountingValidationError extends AccountingError {}

/** A referenced expense, allocation, media object, or entity is absent. */
export class AccountingNotFoundError extends AccountingError {}

/** A uniqueness or structural rule was violated — a duplicate reference code. */
export class AccountingConflictError extends AccountingError {}

/**
 * An attempt to edit an expense that is no longer editable.
 *
 * The lifecycle is deliberately small: `draft` is mutable, everything after it
 * is not. `submit` moves draft → recorded, `void` retires a row without
 * deleting it, and `posted` is set only by a posting engine that does not exist
 * yet. Loosening this later is trivial; tightening it after a year of edits is
 * not.
 */
export class ExpenseNotEditableError extends AccountingError {}

/**
 * The allocation arithmetic would not hold: the allocations of one expense
 * would sum to MORE than the expense itself.
 *
 * Under-allocation is not an error — a draft expense is legitimately partly
 * allocated, and the design is explicit that the equality is a service rule and
 * a report rather than a database constraint. Over-allocation is different in
 * kind: it is arithmetic that no later edit can make true.
 */
export class ExpenseOverAllocatedError extends AccountingError {}
