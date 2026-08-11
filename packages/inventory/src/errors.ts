/**
 * @loxep/inventory error types.
 *
 * Mirrors the @loxep/domain, @loxep/market, and @loxep/commerce precedent: a
 * small hierarchy rooted at one base class so callers can discriminate without
 * string matching. Messages may reference ids, item codes, quantities, and
 * structural facts — never buyer personal data and never credential material.
 */

/** Base class for all @loxep/inventory errors. */
export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input failed its Zod schema or a domain invariant. */
export class InventoryValidationError extends InventoryError {}

/** A referenced acquisition, item, location, allocation, or order line is absent. */
export class InventoryNotFoundError extends InventoryError {}

/**
 * A uniqueness or structural rule was violated: a duplicate item code or
 * location code, a location cycle, or a re-allocation whose allocatable pool
 * went negative because locked items already consumed more than the lot cost.
 */
export class InventoryConflictError extends InventoryError {}

/**
 * An attempt to rewrite a fact Phase 4 declares immutable: the cost basis of an
 * item that has already been depleted (`cost_basis_locked_at`), or the economic
 * entity attribution of an inventory item (which changes by TRANSFER, never by
 * `UPDATE`).
 */
export class InventoryImmutableFactError extends InventoryError {}

/**
 * A reservation could not be made or consumed: over-allocation against
 * available-to-sell, or a release of an allocation that is not `reserved`.
 *
 * Deliberately NOT raised for oversell at depletion time — a channel that says
 * it shipped has shipped, and failing that write would fail an ingestion job
 * over a business problem the operator must resolve in the physical world.
 */
export class InventoryAllocationError extends InventoryError {}
