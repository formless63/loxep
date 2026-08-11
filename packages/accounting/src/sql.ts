/**
 * Internal helpers for the raw-SQL statements this package needs.
 *
 * Following the @loxep/domain, @loxep/storage, @loxep/market, @loxep/commerce,
 * and @loxep/inventory precedent, @loxep/accounting takes no direct
 * `drizzle-orm` dependency: reads use the Drizzle relational query API, plain
 * inserts use the Drizzle insert builder, and the statements that genuinely
 * need first-class SQL (grouped `numeric` aggregation, the unallocated-expense
 * anti-join, the period roll-up) go through `db.execute(<string>)` with
 * strictly validated/escaped literals built here.
 *
 * NEVER interpolate a value into SQL except through these helpers.
 */
import { z } from "zod";
import { AccountingValidationError } from "./errors.ts";

const uuidSchema = z.uuid();

/** Quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new AccountingValidationError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/**
 * Standard single-quoted SQL text literal with embedded quotes doubled.
 * Rejects NUL bytes (PostgreSQL cannot store them in text anyway).
 */
export function textLiteral(value: string): string {
  if (/\u0000/.test(value)) {
    throw new AccountingValidationError(
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
    throw new AccountingValidationError(
      "expected a plain decimal string (no exponent notation)",
    );
  }
  return `${value}::numeric(20, 6)`;
}

/**
 * `date` literal for an ISO `YYYY-MM-DD` calendar date.
 *
 * Accounting dates are `date`, not `timestamptz` — Phase 5's deliberate
 * divergence from foundation convention — so they must never be built from a
 * `Date` here, which would silently reintroduce the timezone decision the
 * column type exists to avoid.
 */
export function dateLiteral(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AccountingValidationError(
      `expected a calendar date as YYYY-MM-DD, got "${value}"`,
    );
  }
  return `'${value}'::date`;
}

/**
 * Coerce a driver value into a `Date`.
 *
 * `db.execute(<string>)` returns rows straight from the driver under Drizzle's
 * own type-parser overrides, and a `timestamptz` arrives as a **string**
 * (`2026-08-11 08:44:15.900965+00`) rather than the `Date` the relational query
 * API would produce. Row mappers built over `execute` must therefore convert
 * rather than cast — a cast compiles and then hands a string to a caller whose
 * type says `Date`, which is exactly the class of bug a `$inferSelect` return
 * type is supposed to prevent.
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value);
  }
  throw new AccountingValidationError(
    "expected a timestamp value from the database",
  );
}

/** {@link toDate}, passing null through. */
export function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

/**
 * Coerce a `date` column into the `YYYY-MM-DD` string the schema declares.
 *
 * `expenses.expense_date` is `date({ mode: "string" })` because Phase 5's
 * divergence makes it a calendar date rather than an instant. Whether the
 * driver hands back a string or a `Date` must not change what a caller sees,
 * and a `Date` here would reintroduce the timezone decision the column type
 * exists to avoid.
 */
export function toCalendarDate(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new AccountingValidationError(
    "expected a calendar date value from the database",
  );
}

/** Comma-joined text literal list for an `in (...)` predicate. */
export function textList(values: readonly string[]): string {
  return values.map(textLiteral).join(", ");
}
