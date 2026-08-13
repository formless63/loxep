/**
 * @loxep/documents error types.
 *
 * Mirrors the @loxep/domain, @loxep/accounting, and @loxep/inventory
 * precedent: a small hierarchy rooted at one base class so callers can
 * discriminate without string matching. Messages may reference ids, document
 * kinds, dispositions, and structural facts — never the bytes of an uploaded
 * document and never credential material.
 */

/** Base class for all @loxep/documents errors. */
export class DocumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input failed its Zod schema or a domain invariant. */
export class DocumentsValidationError extends DocumentsError {}

/** A referenced document or candidate is absent. */
export class DocumentsNotFoundError extends DocumentsError {}

/** A uniqueness or structural rule was violated. */
export class DocumentsConflictError extends DocumentsError {}

/**
 * An attempt to edit a candidate line, or a document's staged lines, past the
 * point editing is allowed — a candidate that has already been confirmed (or
 * a document that has already been discarded) is evidence of what the
 * operator decided, not a draft.
 */
export class DocumentNotEditableError extends DocumentsError {}
