/**
 * Provider connections and encrypted connection credentials
 * (ADR-0016, ADR-0017, ADR-0019).
 *
 * `created_by_user_id` is provenance, not ownership/ACL. There is deliberately
 * no `connection_users` table in Phase 0.
 */
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { economicEntities } from "./entities.ts";
import { bytea, emptyJsonObject } from "./settings.ts";

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),
    externalAccountId: text("external_account_id"),
    externalAccountName: text("external_account_name"),
    config: jsonb("config").notNull().default(emptyJsonObject),
    // ADR-0020 refinement: nullable SET NULL FK (draft sketched `not null`).
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    index("connections_provider_status_idx").on(table.provider, table.status),
    index("connections_economic_entity_id_idx").on(table.economicEntityId),
    index("connections_created_by_user_id_idx").on(table.createdByUserId),
  ],
);

export const connectionCredentials = pgTable(
  "connection_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    credentialType: text("credential_type").notNull(),
    currentVersion: integer("current_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("connection_credentials_connection_id_credential_type_uq").on(
      table.connectionId,
      table.credentialType,
    ),
  ],
);

export const connectionCredentialVersions = pgTable(
  "connection_credential_versions",
  {
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => connectionCredentials.id),
    version: integer("version").notNull(),
    keyVersion: integer("key_version").notNull(),
    nonce: bytea("nonce").notNull(),
    authTag: bytea("auth_tag").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    // Expiry/refresh metadata describes one issued token, so it lives on the
    // version row (ADR-0019).
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    refreshAfter: timestamp("refresh_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.credentialId, table.version] })],
);
