/**
 * Notifications: endpoints (transports), rules (what triggers delivery), and
 * delivery attempts with (market_event_id, endpoint_id) deduplication.
 * Event detection and delivery are separate concepts; ntfy is the first
 * transport, not the model.
 */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { marketEvents } from "./events.ts";
import { monitorTargets } from "./monitoring.ts";
import { applicationSecrets, emptyJsonObject } from "./settings.ts";

export const notificationEndpoints = pgTable("notification_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config").notNull().default(emptyJsonObject),
  // Application-level secret (ADR-0019): a notification endpoint is not
  // necessarily a provider connection.
  secretId: uuid("secret_id").references(() => applicationSecrets.id),
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
});

export const notificationRules = pgTable("notification_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  marketEventType: text("market_event_type"),
  monitorTargetId: uuid("monitor_target_id").references(
    () => monitorTargets.id,
  ),
  endpointId: uuid("endpoint_id")
    .notNull()
    .references(() => notificationEndpoints.id),
  conditions: jsonb("conditions").notNull().default(emptyJsonObject),
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
});

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketEventId: uuid("market_event_id")
      .notNull()
      .references(() => marketEvents.id),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => notificationEndpoints.id),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("notification_deliveries_market_event_id_endpoint_id_uq").on(
      table.marketEventId,
      table.endpointId,
    ),
  ],
);
