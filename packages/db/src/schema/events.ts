/**
 * Derived market events: interpretations of changes between observations.
 * `deduplication_key` prevents at-least-once worker retries from producing
 * duplicate user-visible events.
 */
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { marketplaceItems, monitorTargets } from "./monitoring.ts";
import { emptyJsonObject } from "./settings.ts";

export const marketEvents = pgTable("market_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketplaceItemId: uuid("marketplace_item_id")
    .notNull()
    .references(() => marketplaceItems.id),
  monitorTargetId: uuid("monitor_target_id").references(
    () => monitorTargets.id,
  ),
  eventType: text("event_type").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  fromObservedAt: timestamp("from_observed_at", { withTimezone: true }),
  toObservedAt: timestamp("to_observed_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull().default(emptyJsonObject),
  ruleId: uuid("rule_id"),
  deduplicationKey: text("deduplication_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Initial derived event types. */
export const MARKET_EVENT_TYPES = [
  "price_changed",
  "price_dropped",
  "restocked",
  "sold_out",
  "quantity_changed",
  "listing_ended",
] as const;
export type MarketEventType = (typeof MARKET_EVENT_TYPES)[number];
