/**
 * Internal helpers for the few statements this package genuinely needs to
 * express as first-class SQL.
 *
 * Following the `@loxep/market` precedent, `@loxep/domain` takes no direct
 * `drizzle-orm` dependency: reads go through the Drizzle relational query
 * API, writes through the insert builder, and anything else (the multi-table
 * reference count and the credential cascade a connection delete needs) goes
 * through `db.execute(<string>)` with strictly validated literals built here.
 * Never interpolate a value into SQL except through these helpers.
 */
import { z } from "zod";
import { DomainValidationError } from "./errors.ts";

const uuidSchema = z.uuid();

/** Returns a quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainValidationError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/**
 * Returns a standard single-quoted SQL text literal with embedded quotes
 * doubled. Rejects NUL bytes (PostgreSQL cannot store them in text anyway).
 * Following the `@loxep/market` precedent (`packages/market/src/sql.ts`).
 */
export function textLiteral(value: string): string {
  if (value.includes("\u0000")) {
    throw new DomainValidationError("text values must not contain NUL bytes");
  }
  return `'${value.replaceAll("'", "''")}'`;
}
