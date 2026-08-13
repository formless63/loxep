/**
 * Internal helpers for the raw-SQL statements this package needs.
 *
 * Following the @loxep/domain, @loxep/storage, @loxep/market, @loxep/commerce,
 * @loxep/inventory, and @loxep/accounting precedent, @loxep/documents takes no
 * direct `drizzle-orm` dependency: reads use the Drizzle relational query API,
 * inserts use the Drizzle insert builder, and the partial-column updates that
 * genuinely need first-class SQL go through `db.execute(<string>)` with
 * strictly validated/escaped literals built here.
 *
 * NEVER interpolate a value into SQL except through these helpers.
 */
import { z } from "zod";
import { DocumentsValidationError } from "./errors.ts";

const uuidSchema = z.uuid();

/** Quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new DocumentsValidationError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/**
 * Standard single-quoted SQL text literal with embedded quotes doubled.
 * Rejects NUL bytes (PostgreSQL cannot store them in text anyway).
 */
export function textLiteral(value: string): string {
  if (/\u0000/.test(value)) {
    throw new DocumentsValidationError(
      "text values must not contain NUL bytes",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * `numeric(20,6)` literal for a plain decimal string.
 *
 * Money never crosses into SQL as a JavaScript `number` (implementation
 * contract), and this is the only door it goes through.
 */
export function numericLiteral(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new DocumentsValidationError(
      "expected a plain decimal string (no exponent notation)",
    );
  }
  return `${value}::numeric(20, 6)`;
}

/** `date` literal for an ISO `YYYY-MM-DD` calendar date. */
export function dateLiteral(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DocumentsValidationError(
      `expected a calendar date as YYYY-MM-DD, got "${value}"`,
    );
  }
  return `'${value}'::date`;
}

/** `timestamptz` literal for a valid Date. */
export function timestamptzLiteral(value: Date): string {
  const millis = value.getTime();
  if (Number.isNaN(millis)) {
    throw new DocumentsValidationError("expected a valid Date");
  }
  return `'${value.toISOString()}'::timestamptz`;
}

/**
 * Coerce a driver value into a `Date`. `db.execute(<string>)` returns rows
 * straight from the driver, and a `timestamptz` arrives as a **string**
 * rather than the `Date` the relational query API would produce.
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value);
  }
  throw new DocumentsValidationError(
    "expected a timestamp value from the database",
  );
}

/** {@link toDate}, passing null through. */
export function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

/** Comma-joined UUID literal list for an `in (...)` predicate. */
export function uuidList(values: readonly string[]): string {
  return values.map(uuidLiteral).join(", ");
}
