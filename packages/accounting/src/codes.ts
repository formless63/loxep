/**
 * Human/scannable identifier generation for expenses.
 *
 * `expenses.reference_code` (`EXP-2026-0231`) exists for the same reason
 * `acquisitions.reference_code` and `inventory_items.item_code` do: people
 * label things, and a UUID is not a label. This is the string an operator
 * writes on the back of a paper receipt before it goes in the shoebox, and the
 * one they search for when the shoebox and the ledger disagree.
 *
 * The sequence is derived per YEAR from the rows that already exist, so a fresh
 * installation starts at `EXP-<year>-0001`. Uniqueness is enforced by the
 * database (`unique(reference_code)`); the generator retries on collision
 * rather than assuming it won, because two operators typing an expense in the
 * same second is an ordinary event and not an error to surface.
 */
import { AccountingConflictError } from "./errors.ts";

/** `EXP-2026-0231`. */
export function expenseReferenceCode(year: number, sequence: number): string {
  return `EXP-${year}-${String(sequence).padStart(4, "0")}`;
}

/**
 * Run `attempt` until it succeeds or the retry budget is exhausted.
 *
 * A unique violation on a generated code is expected occasionally and is not an
 * error to surface. Anything else propagates immediately, because swallowing a
 * real failure inside a retry loop is how a bug becomes a mystery.
 */
export async function withCodeRetry<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  options: { attempts?: number; label?: string } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const label = options.label ?? "reference code";
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await attempt(index);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  throw new AccountingConflictError(
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
