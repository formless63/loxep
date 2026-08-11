/**
 * Media/object storage: configured storage backends, stable media identity,
 * attachment links, and resumable storage-migration state (ADR-0012,
 * ADR-0014).
 */
import {
  bigint,
  boolean,
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
import { applicationSecrets, emptyJsonObject } from "./settings.ts";

export const storageBackends = pgTable("storage_backends", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  driver: text("driver").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  config: jsonb("config").notNull().default(emptyJsonObject),
  // Logical secret reference (ADR-0019) — never a version row.
  secretId: uuid("secret_id").references(() => applicationSecrets.id),
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

/** Initial storage driver families. */
export const STORAGE_DRIVERS = ["local", "s3"] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export const mediaObjects = pgTable(
  "media_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storageBackendId: uuid("storage_backend_id")
      .notNull()
      .references(() => storageBackends.id),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").notNull().default(emptyJsonObject),
  },
  (table) => [
    unique("media_objects_storage_backend_id_storage_key_uq").on(
      table.storageBackendId,
      table.storageKey,
    ),
    index("media_objects_sha256_idx").on(table.sha256),
  ],
);

/**
 * Media attachment links. Deliberately no universal uniqueness rule: actual
 * attachment semantics decide uniqueness per resource type
 * (foundation-schema.md).
 */
export const mediaLinks = pgTable("media_links", {
  mediaObjectId: uuid("media_object_id")
    .notNull()
    .references(() => mediaObjects.id),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  purpose: text("purpose").notNull(),
  sortOrder: integer("sort_order"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const storageMigrations = pgTable("storage_migrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceBackendId: uuid("source_backend_id")
    .notNull()
    .references(() => storageBackends.id),
  destinationBackendId: uuid("destination_backend_id")
    .notNull()
    .references(() => storageBackends.id),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // ADR-0020 refinement: nullable SET NULL FK (draft sketched `not null`).
  createdByUserId: text("created_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  summary: jsonb("summary").notNull().default(emptyJsonObject),
});

export const storageMigrationObjects = pgTable(
  "storage_migration_objects",
  {
    migrationId: uuid("migration_id")
      .notNull()
      .references(() => storageMigrations.id),
    mediaObjectId: uuid("media_object_id")
      .notNull()
      .references(() => mediaObjects.id),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.migrationId, table.mediaObjectId] }),
  ],
);
