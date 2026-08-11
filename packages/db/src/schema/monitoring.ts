/**
 * Monitoring: user/configuration intent (`monitor_targets`), the canonical
 * external objects being observed (`marketplace_items`), and the many-to-many
 * discovery relation (`monitor_items`).
 *
 * `next_poll_at` is authoritative for due-work discovery; Graphile Worker
 * dispatches due monitors rather than one cron entry per item.
 */
import { sql } from "drizzle-orm";
import {
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
import { connections } from "./connections.ts";
import { emptyJsonObject } from "./settings.ts";

export const monitorTargets = pgTable(
  "monitor_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").references(() => connections.id),
    targetType: text("target_type").notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    intervalSeconds: integer("interval_seconds").notNull(),
    priority: integer("priority").notNull().default(0),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    backoffUntil: timestamp("backoff_until", { withTimezone: true }),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
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
  },
  (table) => [
    // Partial index for due-work discovery among enabled targets.
    index("monitor_targets_enabled_next_poll_at_idx")
      .on(table.enabled, table.nextPollAt)
      .where(sql`${table.enabled} = true`),
    index("monitor_targets_connection_id_target_type_idx").on(
      table.connectionId,
      table.targetType,
    ),
  ],
);

/** Initial monitor target types; later phases extend without schema change. */
export const MONITOR_TARGET_TYPES = ["ebay_watchlist", "ebay_item"] as const;
export type MonitorTargetType = (typeof MONITOR_TARGET_TYPES)[number];

export const marketplaceItems = pgTable(
  "marketplace_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    marketplace: text("marketplace").notNull(),
    externalItemId: text("external_item_id").notNull(),
    sellerExternalId: text("seller_external_id"),
    canonicalUrl: text("canonical_url"),
    title: text("title"),
    conditionCode: text("condition_code"),
    categoryExternalId: text("category_external_id"),
    listingType: text("listing_type"),
    listingStartedAt: timestamp("listing_started_at", { withTimezone: true }),
    listingEndsAt: timestamp("listing_ends_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    currentState: text("current_state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("marketplace_items_provider_marketplace_external_item_uq").on(
      table.provider,
      table.marketplace,
      table.externalItemId,
    ),
    index("marketplace_items_provider_marketplace_seller_idx").on(
      table.provider,
      table.marketplace,
      table.sellerExternalId,
    ),
    index("marketplace_items_last_seen_at_idx").on(table.lastSeenAt.desc()),
  ],
);

export const monitorItems = pgTable(
  "monitor_items",
  {
    monitorTargetId: uuid("monitor_target_id")
      .notNull()
      .references(() => monitorTargets.id),
    marketplaceItemId: uuid("marketplace_item_id")
      .notNull()
      .references(() => marketplaceItems.id),
    firstDiscoveredAt: timestamp("first_discovered_at", {
      withTimezone: true,
    }).notNull(),
    lastMatchedAt: timestamp("last_matched_at", {
      withTimezone: true,
    }).notNull(),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").notNull().default(emptyJsonObject),
  },
  (table) => [
    primaryKey({ columns: [table.monitorTargetId, table.marketplaceItemId] }),
  ],
);
