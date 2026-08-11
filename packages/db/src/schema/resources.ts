/**
 * External companion resources: generic links to objects owned by external
 * specialist platforms (documents, tasks, issues, billing records) without
 * provider-specific columns in every domain table.
 */
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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

export const resourceLinks = pgTable("resource_links", {
  externalResourceId: uuid("external_resource_id")
    .notNull()
    .references(() => externalResources.id),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  purpose: text("purpose").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
