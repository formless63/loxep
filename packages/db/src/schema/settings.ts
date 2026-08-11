/**
 * Database-backed application settings and encrypted runtime secrets
 * (ADR-0016, ADR-0019).
 *
 * `application_secrets` is the stable logical secret; immutable ciphertext
 * lives in `application_secret_versions` with `current_version` as the
 * explicit active pointer. Consumers reference the logical secret id, never a
 * version row.
 */
import {
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";

/** PostgreSQL bytea mapped to Node Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const applicationSettings = pgTable("application_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  // ADR-0020: nullable provenance FK, never cascades history.
  updatedByUserId: text("updated_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const applicationSecrets = pgTable("application_secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  secretKey: text("secret_key").notNull().unique(),
  purpose: text("purpose").notNull(),
  currentVersion: integer("current_version").notNull(),
  createdByUserId: text("created_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const applicationSecretVersions = pgTable(
  "application_secret_versions",
  {
    secretId: uuid("secret_id")
      .notNull()
      .references(() => applicationSecrets.id),
    version: integer("version").notNull(),
    keyVersion: integer("key_version").notNull(),
    nonce: bytea("nonce").notNull(),
    authTag: bytea("auth_tag").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.secretId, table.version] })],
);

/** Convenience default for jsonb '{}' columns elsewhere in the schema. */
export const emptyJsonObject = sql`'{}'::jsonb`;
