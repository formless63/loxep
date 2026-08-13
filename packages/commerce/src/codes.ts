/**
 * Human/scannable identifier generation for channel listings (design 4a,
 * loxep-dgf.6). `channel_listings.listing_code` (`LST-2026-0042`) exists for
 * the same reason `acquisitions.reference_code`, `inventory_items.item_code`,
 * and `expenses.reference_code` do — people label things, and a UUID is not
 * a label. This is the fourth package to carry its own copy of this exact
 * pattern rather than a shared one (`packages/inventory/src/codes.ts`,
 * `packages/accounting/src/codes.ts`, `packages/counterparties/src/codes.ts`
 * are the other three) — each domain package owns its own identifier
 * machinery so a future addition to one's alphabet or format never touches
 * another's.
 *
 * The sequence is derived per YEAR from the rows that already exist, so a
 * fresh installation starts at `LST-<year>-0001`. Uniqueness is enforced by
 * the database (`unique(listing_code)`); the generator retries on collision
 * rather than assuming it won, because two operators listing stock in the
 * same second is an ordinary event and not an error to surface.
 *
 * `listing_code` is required on EVERY `channel_listings` row, not only
 * manual ones — it is also what a Loxep-authored draft listing (any
 * provider) is identified by before a channel has assigned anything.
 */
import { CommerceConflictError } from "./errors.ts";

/** `LST-2026-0042`. */
export function listingCode(year: number, sequence: number): string {
  return `LST-${year}-${String(sequence).padStart(4, "0")}`;
}

/**
 * Run `attempt` until it succeeds or the retry budget is exhausted.
 *
 * A unique violation on a generated code is expected occasionally and is not
 * an error to surface. Anything else propagates immediately, because
 * swallowing a real failure inside a retry loop is how a bug becomes a
 * mystery.
 */
export async function withCodeRetry<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  options: { attempts?: number; label?: string } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const label = options.label ?? "listing code";
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await attempt(index);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  throw new CommerceConflictError(
    `could not generate a unique ${label} after ${attempts} attempts: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** PostgreSQL `23505 unique_violation`, however the driver wrapped it. */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isUniqueViolation(cause);
}
