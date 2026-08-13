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

/* ------------------------------------------------------------ the ledger */

/**
 * A fact could not be routed to a book: it carries no entity, its entity (and
 * every ancestor) has no `posting_primary` book covering the date, and no
 * installation default was supplied.
 *
 * **This is not a failure mode, it is the design.** A fact with no entity and
 * no default book is a fact whose accounting ownership nobody has stated, and
 * inventing one silently is how a ledger becomes untrustworthy. The caller's
 * correct response is to leave the fact in the unpostable backlog — the same
 * principle as Phase 3's unattributed-order backlog and Phase 4's unmatched-
 * depletion backlog, one layer up.
 */
export class BookRoutingError extends AccountingError {}

/**
 * A posting was refused by the period model: the resolved period is `closed` or
 * `locked`, or it is `soft_closed` and the caller did not take the explicit
 * authorized backdating path, or the entry's date falls in no period at all.
 *
 * The last case is deliberately an error rather than an implicit `INSERT`:
 * periods are generated, and auto-creating one silently reopens a year the
 * operator believed was finished.
 */
export class FiscalPeriodClosedError extends AccountingError {}

/**
 * An entry's lines do not sum to zero — per transaction currency, or in the
 * book's functional currency.
 *
 * The database enforces this too, at COMMIT, through a deferred constraint
 * trigger. This error exists so the overwhelmingly common case fails at the
 * call site with the offending currency and total in the message, rather than
 * as a plpgsql exception surfacing from a commit several statements later.
 */
export class UnbalancedEntryError extends AccountingError {}

/**
 * An attempt to change something the ledger does not permit changing: editing
 * or deleting a posted entry, reversing a reversal, reversing a draft, or
 * reopening a `locked` period.
 *
 * Posted entries are immutable and corrections are entries, never edits. The
 * database enforces the entry and line cases with `BEFORE` triggers; this error
 * is the service saying the same thing first, with a sentence about what to do
 * instead.
 */
export class LedgerImmutableError extends AccountingError {}

/**
 * A currency other than the one this build supports crossed the boundary.
 *
 * The owner's answer is **USD-only for the initial build, with the
 * multi-currency seam kept**: `journal_lines` carries `currency`/`amount`
 * alongside `functional_currency`/`functional_amount`/`fx_rate`/
 * `fx_rate_source`, the conversion is frozen per line at posting, and no
 * period-end revaluation exists. Wiring a second currency later is therefore
 * additive and restates nothing — which is exactly why this refusal lives in
 * the service and not in a `CHECK` that would have to be dropped to use the
 * columns it guards.
 */
export class UnsupportedCurrencyError extends AccountingError {}
