/**
 * External companion resources: generic links to objects owned by external
 * specialist platforms (documents, tasks, issues, billing records) without
 * provider-specific columns in every domain table.
 */
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { connections } from "./connections.ts";
import { emptyJsonObject } from "./settings.ts";

export const externalResources = pgTable("external_resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  connectionId: uuid("connection_id").references(() => connections.id),
  externalType: text("external_type").notNull(),
  externalId: text("external_id"),
  url: text("url").notNull(),
  title: text("title"),
  metadata: jsonb("metadata").notNull().default(emptyJsonObject),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Attachment of one external companion resource to one Loxep-side resource,
 * for one purpose.
 *
 * ## The key, and why this one (loxep-dyx)
 *
 * `unique(external_resource_id, resource_type, resource_id, purpose)`.
 *
 * The foundation draft deliberately declined to pick a universal relationship
 * rule and asked for "uniqueness based on actual attachment semantics". The
 * actual semantics are: an attachment IS the statement "this external object
 * is linked to that Loxep row for this reason", and asserting it twice adds no
 * information. All four columns are `not null`, so the natural key is total —
 * there is no null case to reason about, which is exactly why this table can
 * carry a real key where `media_links` and `channel_listings` needed
 * `NULLS NOT DISTINCT` gymnastics.
 *
 * `purpose` is IN the key rather than excluded from it: the same issue tracker
 * ticket can legitimately be both the `spec` and the `discussion` for one
 * acquisition, and those are two facts, not a duplicate.
 *
 * The bug this closes: without a unique constraint there is no `ON CONFLICT`
 * target, so an at-least-once Graphile Worker job that links a resource twice
 * silently doubles the row (ADR: jobs are at-least-once and handlers must be
 * idempotent). Every writer can now use `on conflict … do nothing/update`.
 *
 * No surrogate `uuid` primary key is added. The natural key above is complete
 * and stable, and a synthetic id on a pure junction row would exist only to be
 * ignored.
 *
 * Indexes: the unique index serves the resource → Loxep direction on its
 * leading column, and `(resource_type, resource_id)` serves the Loxep →
 * resource direction ("what is linked to this acquisition?"). Two indexes
 * cover both directions; a third on `external_resource_id` alone would
 * duplicate the unique's prefix.
 */
export const resourceLinks = pgTable(
  "resource_links",
  {
    externalResourceId: uuid("external_resource_id")
      .notNull()
      .references(() => externalResources.id),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    purpose: text("purpose").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("resource_links_resource_purpose_uq").on(
      table.externalResourceId,
      table.resourceType,
      table.resourceId,
      table.purpose,
    ),
    index("resource_links_resource_idx").on(
      table.resourceType,
      table.resourceId,
    ),
  ],
);
