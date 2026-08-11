/**
 * Internal helpers for the raw-SQL statements this package needs.
 *
 * Following the @loxep/domain and @loxep/storage precedent, @loxep/market
 * takes no direct `drizzle-orm` dependency (bun's isolated installs would not
 * resolve it anyway): reads use the Drizzle relational query API, plain
 * inserts/upserts use the Drizzle insert builder, and the statements that
 * genuinely need first-class SQL (SKIP LOCKED claims, arithmetic UPDATEs,
 * GREATEST/COALESCE upserts) go through `db.execute(<string>)` with strictly
 * validated/escaped literals built here. Never interpolate a value into SQL
 * except through these helpers.
 */
import { z } from "zod";
import { MarketValidationError } from "./errors.ts";

const uuidSchema = z.uuid();

/** Returns a quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new MarketValidationError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/**
 * Returns a standard single-quoted SQL text literal with embedded quotes
 * doubled. Rejects NUL bytes (PostgreSQL cannot store them in text anyway).
 */
export function textLiteral(value: string): string {
  if (value.includes("\u0000")) {
    throw new MarketValidationError("text values must not contain NUL bytes");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** Returns a SQL literal for a finite non-negative integer. */
export function intLiteral(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MarketValidationError("expected a non-negative safe integer");
  }
  return String(value);
}

/**
 * Returns a `jsonb` literal for a JSON-serializable value. Serialization
 * goes through {@link textLiteral}, so quotes/backslashes inside the JSON are
 * escaped by the same single rule as any other text literal.
 */
export function jsonbLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new MarketValidationError("value is not JSON-serializable");
  }
  return `${textLiteral(json)}::jsonb`;
}

/** Returns a `timestamptz` literal for a valid Date. */
export function timestamptzLiteral(value: Date): string {
  const millis = value.getTime();
  if (Number.isNaN(millis)) {
    throw new MarketValidationError("expected a valid Date");
  }
  return `'${value.toISOString()}'::timestamptz`;
}
