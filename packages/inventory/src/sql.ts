/**
 * Internal helpers for the raw-SQL statements this package needs.
 *
 * Following the @loxep/domain, @loxep/storage, @loxep/market, and
 * @loxep/commerce precedent, @loxep/inventory takes no direct `drizzle-orm`
 * dependency: reads use the Drizzle relational query API, plain inserts and
 * upserts use the Drizzle insert builder, and the statements that genuinely
 * need first-class SQL (grouped `numeric` aggregation, the ledger recompute
 * that maintains `quantity_on_hand`, the reconciliation comparison) go through
 * `db.execute(<string>)` with strictly validated/escaped literals built here.
 *
 * These are re-declared rather than imported from `@loxep/commerce`, whose
 * equivalents are module-internal and unexported. The duplication is four small
 * functions; the alternative is reaching into another domain package's private
 * surface.
 *
 * NEVER interpolate a value into SQL except through these helpers.
 */
import { z } from "zod";
import { InventoryValidationError } from "./errors.ts";

const uuidSchema = z.uuid();

/** Quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryValidationError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/**
 * Standard single-quoted SQL text literal with embedded quotes doubled.
 * Rejects NUL bytes (PostgreSQL cannot store them in text anyway).
 */
export function textLiteral(value: string): string {
  if (/\u0000/.test(value)) {
    throw new InventoryValidationError("text values must not contain NUL bytes");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** `timestamptz` literal for a valid Date. */
export function timestamptzLiteral(value: Date): string {
  const millis = value.getTime();
  if (Number.isNaN(millis)) {
    throw new InventoryValidationError("expected a valid Date");
  }
  return `'${value.toISOString()}'::timestamptz`;
}

/**
 * `numeric(20,6)` literal for a plain decimal string.
 *
 * Money and quantities never cross into SQL as a JavaScript `number`
 * (implementation contract), and this is the only door they go through.
 */
export function numericLiteral(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new InventoryValidationError(
      "expected a plain decimal string (no exponent notation)",
    );
  }
  return `${value}::numeric(20, 6)`;
}

/** Comma-joined UUID literal list for an `in (...)` predicate. */
export function uuidList(values: readonly string[]): string {
  return values.map(uuidLiteral).join(", ");
}
