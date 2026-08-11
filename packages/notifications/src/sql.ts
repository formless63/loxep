/**
 * Internal helpers for the few raw-SQL statements this package needs.
 *
 * Following the @loxep/domain and @loxep/storage precedent,
 * @loxep/notifications takes no direct `drizzle-orm` dependency: reads use
 * the Drizzle relational query API, updates use primary-key upserts, and
 * DELETEs/arithmetic UPDATEs go through `db.execute(<string>)` with strictly
 * validated/escaped literals built here. Never interpolate a value into SQL
 * except through these helpers.
 */
import { z } from "zod";
import { NotificationValidationError } from "./errors.ts";

const uuidSchema = z.uuid();

/** Returns a quoted SQL literal for a value that must be a UUID. */
export function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new NotificationValidationError("expected a UUID value");
  }
  return `'${parsed.data}'`;
}

/**
 * Returns a standard single-quoted SQL text literal with embedded quotes
 * doubled. Rejects NUL bytes (PostgreSQL cannot store them in text anyway).
 */
export function textLiteral(value: string): string {
  if (value.includes("\u0000")) {
    throw new NotificationValidationError(
      "text values must not contain NUL bytes",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
}
