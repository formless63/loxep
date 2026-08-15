/**
 * Notifications: notifiable events (what happened), endpoints (transports),
 * rules (what triggers delivery), and delivery attempts with
 * (notification_event_id, endpoint_id) deduplication. Event detection and
 * delivery are separate concepts; ntfy is the first transport, not the model.
 *
 * Migration `0022` (ADR-0023, weave audit 2026-08 finding 5) replaced the
 * ledger's market-event identity with a subject-neutral one. Before it,
 * `notification_deliveries.market_event_id` was `NOT NULL` against
 * `market_events`, so a delivery could structurally only ever be about a
 * marketplace item — every event class shipped since Phase 2 (purchase
 * ingested, document confirmed, manual sale, health degraded, DNS drift) was
 * detected and un-notifiable. See
 * apps/docs/src/content/docs/architecture/notifications-design.md.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { monitorTargets } from "./monitoring.ts";
import { applicationSecrets, emptyJsonObject } from "./settings.ts";

/**
 * Notifiable event classes — the dimension a routing rule filters on, and the
 * one `CHECK`ed set on both `notification_events` and `notification_rules`.
 *
 * `infrastructure` is seeded but unwired (DNS drift found/disappeared,
 * reconciler failures), following `HEALTH_SUBJECT_TYPES`' precedent of putting
 * a later phase's values in the CHECK from day one so that phase never has to
 * widen it.
 */
export const NOTIFICATION_EVENT_CLASSES = [
  "market",
  "purchase",
  "document",
  "sale",
  "health",
  "infrastructure",
] as const;
export type NotificationEventClass =
  (typeof NOTIFICATION_EVENT_CLASSES)[number];

/**
 * What `notification_events.subject_id` points at. Deliberately a superset of
 * `HEALTH_SUBJECT_TYPES` so any health subject is representable, plus the
 * domain records the wired classes name. Seeded ahead for the same reason as
 * the class list.
 */
export const NOTIFICATION_SUBJECT_TYPES = [
  "market_event",
  "acquisition",
  "document",
  "order",
  "connection",
  "notification_endpoint",
  "storage_backend",
  "external_resource",
  "hosting_target",
  "managed_domain",
  "monitor_target",
  "reconcile_run",
] as const;
export type NotificationSubjectType =
  (typeof NOTIFICATION_SUBJECT_TYPES)[number];

/**
 * The detection-side ledger: one row per fact worth telling a human about.
 *
 * - **`subject_id` is deliberately NOT a foreign key** — it is polymorphic
 *   across every table in {@link NOTIFICATION_SUBJECT_TYPES}, the same trade
 *   `integration_health.subject_id`, `reconcile_runs.subject_id`, and
 *   `journal_entry_source_links` already make. A notification about a thing
 *   that was later deleted is still a true record of what Loxep said.
 * - **`deduplication_key` is UNIQUE and mandatory.** Emission is `ON CONFLICT
 *   DO NOTHING`, so an at-least-once handler that re-runs records nothing and
 *   routes nothing — it cannot notify twice. Market events reuse their own
 *   `market_events.deduplication_key` discipline through the key
 *   `market_event:<id>`.
 * - **`payload` is the render input**, not stamped message text: renderers are
 *   pure functions over `(event_class, event_type, payload)`, so improving a
 *   renderer improves already-recorded events. Small, Loxep-owned, and
 *   redacted by construction — never a provider response, header, or
 *   credential material (`integration_health.detail`'s discipline).
 * - **`event_type` is not CHECKed.** Valid `(class, type)` pairs live in
 *   `@loxep/domain`'s event-class registry (closed-union-plus-config, the
 *   monitor-target registration shape) so adding a type to a shipped class is
 *   a registry entry, not a migration, while the coarse dimension rules filter
 *   on stays database-enforced.
 */
export const notificationEvents = pgTable(
  "notification_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventClass: text("event_class").notNull(),
    eventType: text("event_type").notNull(),
    subjectType: text("subject_type").notNull(),
    /** Deliberately NOT an FK. See the table note. */
    subjectId: uuid("subject_id").notNull(),
    /** The one narrowing dimension rules filter on; null outside `market`. */
    monitorTargetId: uuid("monitor_target_id").references(
      () => monitorTargets.id,
    ),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull().default(emptyJsonObject),
    deduplicationKey: text("deduplication_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "notification_events_event_class_check",
      sql`${table.eventClass} in ('market', 'purchase', 'document', 'sale', 'health', 'infrastructure')`,
    ),
    check(
      "notification_events_subject_type_check",
      sql`${table.subjectType} in ('market_event', 'acquisition', 'document', 'order', 'connection', 'notification_endpoint', 'storage_backend', 'external_resource', 'hosting_target', 'managed_domain', 'monitor_target', 'reconcile_run')`,
    ),
    // The feed, newest first.
    index("notification_events_occurred_at_idx").on(table.occurredAt.desc()),
    // The per-class feed.
    index("notification_events_class_occurred_at_idx").on(
      table.eventClass,
      table.occurredAt.desc(),
    ),
    // "What has Loxep told me about this thing?"
    index("notification_events_subject_idx").on(
      table.subjectType,
      table.subjectId,
      table.occurredAt.desc(),
    ),
  ],
);

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

/**
 * Routing rules: the same two-dimensional filter they always were — **what**
 * (`event_class` + `event_type`, a null type meaning any type in the class)
 * × **which subject** (`monitor_target_id`, null meaning any) — with the
 * class dimension added by migration `0022` and `market_event_type` renamed
 * to `event_type`.
 *
 * `event_class` is NOT NULL on purpose: there is no "any class" wildcard.
 * Existing rows were stamped `'market'` by the migration, so no shipped rule
 * silently widened to cover health transitions or purchases.
 *
 * `conditions` remains unused. This is not a rules engine — no thresholds, no
 * quiet hours, no per-class predicates (ADR-0023's rejected alternatives).
 */
export const notificationRules = pgTable(
  "notification_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    eventClass: text("event_class").notNull(),
    /** Null = any event type within {@link notificationRules.eventClass}. */
    eventType: text("event_type"),
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
  },
  (table) => [
    check(
      "notification_rules_event_class_check",
      sql`${table.eventClass} in ('market', 'purchase', 'document', 'sale', 'health', 'infrastructure')`,
    ),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Migration 0022: was `market_event_id NOT NULL REFERENCES market_events`.
    // Same shape — one NOT NULL FK to the subject, one UNIQUE (subject,
    // endpoint) pair — against a subject-neutral ledger (ADR-0023). The FK is
    // declared in the table extras with an explicit name: the derived name
    // (`notification_deliveries_notification_event_id_notification_events_id_fk`)
    // is 71 bytes and PostgreSQL truncates at 63.
    notificationEventId: uuid("notification_event_id").notNull(),
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
    // Both named explicitly: the derived names for this column pair run past
    // PostgreSQL's 63-byte identifier limit.
    foreignKey({
      name: "notification_deliveries_event_fk",
      columns: [table.notificationEventId],
      foreignColumns: [notificationEvents.id],
    }),
    unique("notification_deliveries_event_endpoint_uq").on(
      table.notificationEventId,
      table.endpointId,
    ),
  ],
);
