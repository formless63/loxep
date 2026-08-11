/**
 * Internal literal helpers for the few raw-SQL statements this package needs.
 *
 * Mirrors `@loxep/market`'s `sql.ts` (same rationale: no direct `drizzle-orm`
 * dependency; reads go through the relational query API and only genuinely
 * set-based statements use `db.execute(<string>)`). Never interpolate a value
 * into SQL except through these helpers.
 */
import { z } from "zod";
import { AppError } from "./errors.ts";

const uuidSchema = z.uuid();

/** PostgreSQL `text` cannot store NUL bytes; written without an escape so the
 * byte itself never appears in this source file. */
const NUL_CHARACTER = String.fromCharCode(0);

/** Quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/** Single-quoted SQL text literal with embedded quotes doubled. */
export function textLiteral(value: string): string {
  if (value.includes(NUL_CHARACTER)) {
    throw new AppError("text values must not contain NUL bytes");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** SQL literal for a finite non-negative integer. */
export function intLiteral(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("expected a non-negative safe integer");
  }
  return String(value);
}
