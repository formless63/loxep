/**
 * Human/scannable identifier generation for acquisitions and inventory items.
 *
 * `acquisitions.reference_code` (`ACQ-2026-0184`) and
 * `inventory_items.item_code` (`ITM-8F2K4`) exist for one reason: **resellers
 * label boxes, and a UUID is not a label.** These are the strings that get
 * printed on a sticker, written on a bin in marker, and read back over a
 * warehouse shelf, so they are short, unambiguous when handwritten, and unique
 * installation-wide.
 *
 * Both alphabets exclude `I`, `L`, `O`, `U`, `0`, and `1` (Crockford base32's
 * reasoning, plus `U`): a `0`/`O` confusion on a label is a support ticket, and
 * dropping `U` keeps the generator from spelling anything unfortunate.
 *
 * Uniqueness is enforced by the database (`unique(reference_code)`,
 * `unique(item_code)`); these helpers retry on collision rather than assuming
 * they won. The sequence for acquisitions is derived per YEAR, so a fresh
 * installation starts at `ACQ-<year>-0001` and the number means something to a
 * human scanning a shelf of boxes.
 */
import { randomInt } from "node:crypto";
import { InventoryConflictError } from "./errors.ts";

/** Crockford-style alphabet minus `U`; no character reads as another. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A random suffix of `length` unambiguous characters. */
export function randomCode(length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/** `ITM-8F2K4`. */
export function itemCode(): string {
  return `ITM-${randomCode(5)}`;
}

/** `ACQ-2026-0184`. */
export function acquisitionReferenceCode(year: number, sequence: number): string {
  return `ACQ-${year}-${String(sequence).padStart(4, "0")}`;
}

/**
 * Run `attempt` until it succeeds or the retry budget is exhausted.
 *
 * A unique-violation on a generated code is expected occasionally and is not an
 * error to surface: it means two operators created stock in the same
 * millisecond. Anything else propagates immediately, because swallowing a real
 * failure inside a retry loop is how a bug becomes a mystery.
 */
export async function withCodeRetry<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  options: { attempts?: number; label: string } = { label: "code" },
): Promise<T> {
  const attempts = options.attempts ?? 5;
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await attempt(index);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  throw new InventoryConflictError(
    `could not generate a unique ${options.label} after ${attempts} attempts: ` +
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
