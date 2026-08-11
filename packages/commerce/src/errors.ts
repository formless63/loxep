/**
 * @loxep/commerce error types.
 *
 * Mirrors the @loxep/domain and @loxep/market precedent: a small hierarchy
 * rooted at one base class so callers can discriminate without string
 * matching. Messages may reference ids, SKUs, and structural facts — never
 * buyer personal data and never credential material.
 */

/** Base class for all @loxep/commerce errors. */
export class CommerceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input failed its Zod schema or a domain invariant. */
export class CommerceValidationError extends CommerceError {}

/** A referenced order, line, catalog item, listing, or connection is absent. */
export class CommerceNotFoundError extends CommerceError {}

/**
 * A uniqueness rule was violated: a duplicate installation-wide catalog SKU,
 * or a channel listing that already exists for the same
 * (connection, provider, listing, variation).
 */
export class CommerceConflictError extends CommerceError {}
