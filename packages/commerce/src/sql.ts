/**
 * Internal helpers for the raw-SQL statements this package needs.
 *
 * Following the @loxep/domain, @loxep/storage, and @loxep/market precedent,
 * @loxep/commerce takes no direct `drizzle-orm` dependency (bun's isolated
 * installs would not resolve it anyway): reads use the Drizzle relational
 * query API, plain inserts/upserts use the Drizzle insert builder, and the
 * statements that genuinely need first-class SQL (grouped `numeric`
 * aggregation, jsonb cursor merges, delete-and-replace attachment rewrites)
 * go through `db.execute(<string>)` with strictly validated/escaped literals
 * built here.
 *
 * NEVER interpolate a value into SQL except through these helpers.
 */
import { z } from "zod";
import { CommerceValidationError } from "./errors.ts";

const uuidSchema = z.uuid();

/** Quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new CommerceValidationError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/**
 * Standard single-quoted SQL text literal with embedded quotes doubled.
 * Rejects NUL bytes (PostgreSQL cannot store them in text anyway).
 */
export function textLiteral(value: string): string {
  if (value.includes("\u0000")) {
    throw new CommerceValidationError("text values must not contain NUL bytes");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** `timestamptz` literal for a valid Date. */
export function timestamptzLiteral(value: Date): string {
  const millis = value.getTime();
  if (Number.isNaN(millis)) {
    throw new CommerceValidationError("expected a valid Date");
  }
  return `'${value.toISOString()}'::timestamptz`;
}

/**
 * `numeric(20,6)` literal for a plain decimal string. Money and quantities
 * never cross into SQL as a JavaScript `number` (implementation contract),
 * and this is the only door they go through.
 */
export function numericLiteral(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new CommerceValidationError(
      "expected a plain decimal string (no exponent notation)",
    );
  }
  return `${value}::numeric(20, 6)`;
}

/** `null`, or the wrapped literal for a present value — for building an optional-column INSERT/UPDATE assignment list. */
export function nullable<T>(
  value: T | null | undefined,
  literal: (value: T) => string,
): string {
  return value === null || value === undefined ? "null" : literal(value);
}

/**
 * `jsonb` literal for a JSON-serializable value. Serialization goes through
 * {@link textLiteral}, so quotes and backslashes inside the JSON are escaped
 * by the same single rule as any other text literal.
 */
export function jsonbLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new CommerceValidationError("value is not JSON-serializable");
  }
  return `${textLiteral(json)}::jsonb`;
}
