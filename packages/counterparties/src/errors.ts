/**
 * @loxep/counterparties error types.
 *
 * Mirrors the @loxep/domain, @loxep/commerce, @loxep/inventory, and
 * @loxep/accounting precedent: a small hierarchy rooted at one base class so
 * callers can discriminate without string matching.
 *
 * Messages may reference ids, reference codes, display names, and structural
 * facts. They must not quote a contact channel's value: an error string that
 * embeds an email address ends up in a log, and Phase 3's data-minimization
 * posture — which the WooCommerce findings confirmed is a real concern — does
 * not stop at the table boundary.
 */

/** Base class for all @loxep/counterparties errors. */
export class CounterpartyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input failed its Zod schema or a domain invariant. */
export class CounterpartyValidationError extends CounterpartyError {}

/** A referenced counterparty, contact, channel, or role row is absent. */
export class CounterpartyNotFoundError extends CounterpartyError {}

/** A uniqueness or structural rule was violated — a duplicate reference code. */
export class CounterpartyConflictError extends CounterpartyError {}

/**
 * The counterparty/economic-entity boundary was crossed the wrong way.
 *
 * Raised where the schema alone cannot speak: declaring a mirror of an entity
 * that does not exist, or attempting to give a person a tax identifier through
 * a path that would otherwise reach the database and fail with a constraint
 * name instead of a reason.
 */
export class CounterpartyBoundaryError extends CounterpartyError {}

/**
 * A merge was refused.
 *
 * The survivor-pointer model is only correct while the pointer graph stays
 * shallow and acyclic, so merging an already-merged row, merging INTO an
 * already-merged row, or merging a row into itself are all refused rather than
 * quietly producing a chain that `coalesce(merged_into_counterparty_id, id)`
 * would resolve wrongly. See `merge.ts`.
 */
export class CounterpartyMergeError extends CounterpartyError {}
