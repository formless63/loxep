/**
 * Internal helpers for the few raw-SQL statements this package needs.
 *
 * Following the @loxep/domain precedent, @loxep/storage takes no direct
 * `drizzle-orm` dependency (bun's isolated installs would not resolve it
 * anyway): reads use the Drizzle relational query API and updates use
 * primary-key upserts. DELETEs have no upsert equivalent, so they go through
 * `db.execute(<string>)` with strictly validated/escaped literals built
 * here. Never interpolate a value into SQL except through these helpers.
 */
import { z } from "zod";
import { StorageError } from "./errors.ts";

const uuidSchema = z.uuid();

/** Returns a quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new StorageError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/**
 * Returns a standard single-quoted SQL text literal with embedded quotes
 * doubled. Rejects NUL bytes (PostgreSQL cannot store them in text anyway).
 */
export function textLiteral(value: string): string {
  if (value.includes("\u0000")) {
    throw new StorageError("text values must not contain NUL bytes");
  }
  return `'${value.replaceAll("'", "''")}'`;
}
