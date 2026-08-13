/**
 * Human/scannable identifier generation for counterparties.
 *
 * `counterparties.reference_code` (`CP-2026-0117`) exists for the same reason
 * `acquisitions.reference_code`, `inventory_items.item_code`, and
 * `expenses.reference_code` do: people label things, and a UUID is not a label.
 *
 * The sequence is derived per YEAR from the rows that already exist, so a fresh
 * installation starts at `CP-<year>-0001`. Uniqueness is enforced by the
 * database (`unique(reference_code)`); the generator retries on collision
 * rather than assuming it won.
 *
 * The code is **not** an identity and nothing resolves through it. In
 * particular a merged counterparty keeps its own code forever — that is the
 * survivor-pointer posture applied to the label, and reusing a loser's code on
 * the survivor would destroy the one string a human might have written down.
 */
import { CounterpartyConflictError } from "./errors.ts";

/** `CP-2026-0117`. */
export function counterpartyReferenceCode(
  year: number,
  sequence: number,
): string {
  return `CP-${year}-${String(sequence).padStart(4, "0")}`;
}

/** `ST-2026-0042`. Same shape as {@link counterpartyReferenceCode}, for sites. */
export function counterpartySiteCode(year: number, sequence: number): string {
  return `ST-${year}-${String(sequence).padStart(4, "0")}`;
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
  throw new CounterpartyConflictError(
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
