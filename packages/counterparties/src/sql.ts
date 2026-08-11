/**
 * Internal helpers for the raw-SQL statements this package needs.
 *
 * Following the @loxep/domain, @loxep/storage, @loxep/market, @loxep/commerce,
 * @loxep/inventory, and @loxep/accounting precedent, @loxep/counterparties
 * takes no direct `drizzle-orm` dependency: reads use the Drizzle relational
 * query API, inserts use the insert builder, and the statements that genuinely
 * need first-class SQL (the merge resolver, the compression update, the dedupe
 * grouping) go through `db.execute(<string>)` with strictly validated/escaped
 * literals built here.
 *
 * NEVER interpolate a value into SQL except through these helpers.
 */
import { z } from "zod";
import { CounterpartyValidationError } from "./errors.ts";

const uuidSchema = z.uuid();

/** Quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new CounterpartyValidationError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/**
 * Standard single-quoted SQL text literal with embedded quotes doubled.
 * Rejects NUL bytes (PostgreSQL cannot store them in text anyway).
 */
export function textLiteral(value: string): string {
  if (/\u0000/.test(value)) {
    throw new CounterpartyValidationError(
      "text values must not contain NUL bytes",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** `date` literal for an ISO `YYYY-MM-DD` calendar date. */
export function dateLiteral(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CounterpartyValidationError(
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
  throw new CounterpartyValidationError(
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

/** Comma-joined text literal list for an `in (...)` predicate. */
export function textList(values: readonly string[]): string {
  return values.map(textLiteral).join(", ");
}
