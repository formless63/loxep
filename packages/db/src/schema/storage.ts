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
 * Media attachment links: one stored object attached to one Loxep row for one
 * purpose.
 *
 * ## The key, and why this one (loxep-dyx)
 *
 * `unique(media_object_id, resource_type, resource_id, purpose)`.
 *
 * The foundation draft asked for "uniqueness based on actual attachment
 * semantics rather than one universal relationship rule". The semantics that
 * actually hold across every resource type are:
 *
 * ```text
 * one object may attach to many resources    a receipt photo covers a lot AND
 *                                            each item unpacked from it
 * one resource may hold many objects         an inventory item has twelve
 *                                            condition photos
 * one object, one resource, one purpose      is ONE fact, and asserting it
 *                                            twice adds nothing
 * ```
 *
 * So the key is the full natural tuple, and `sort_order` is deliberately NOT
 * in it: sort order is presentation, and putting it in the key would let the
 * same photo attach to the same item twice by being dragged to a different
 * position — which is the duplicate this constraint exists to prevent.
 * `purpose` IS in the key, because the same photo legitimately serves as both
 * `gallery` and `condition_evidence` for one item, and those are two facts.
 *
 * The bug this closes (loxep-dyx): with no unique constraint there was no
 * `ON CONFLICT` target, so an at-least-once worker that attaches media twice
 * silently doubled the row and every gallery rendered the same photo twice.
 *
 * No surrogate `uuid` primary key: the natural key is complete, and a
 * synthetic id on a junction row would exist only to be ignored. Deletion is
 * by the natural key, which is what an "unlink this photo from this item"
 * action already has in hand.
 *
 * Indexes: the unique index serves object → resources on its leading column,
 * and `(resource_type, resource_id)` serves resource → objects, which is the
 * hot direction (every item, acquisition, and shipment detail view). A third
 * index on `media_object_id` alone would only duplicate the unique's prefix.
 */
export const mediaLinks = pgTable(
  "media_links",
  {
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
  },
  (table) => [
    unique("media_links_object_resource_purpose_uq").on(
      table.mediaObjectId,
      table.resourceType,
      table.resourceId,
      table.purpose,
    ),
    index("media_links_resource_idx").on(table.resourceType, table.resourceId),
  ],
);

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
