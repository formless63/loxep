/**
 * `integration_health` — the ONE new table in Phase 8 milestone 1
 * (loxep-ovj.1), designed in full at
 * apps/docs/src/content/docs/architecture/fleet-observability-design.md
 * ("`integration_health`: the only new table").
 *
 * Ownership: **shared foundation, not Infrastructure** (design open question
 * 6, resolved). Four of the six subject types are foundation records with
 * nothing to do with the fleet, and two other phases (6 and 7) already assume
 * this table exists. It lives in `@loxep/domain` alongside connections,
 * settings, and secrets — this schema file only defines the table shape.
 *
 * One row per subject, overwritten in place — the phase's enforceable
 * boundary marker against becoming a metrics/history product (see the design
 * doc's "self-monitoring trap" and "the only new table" sections):
 *
 * - **No surrogate key.** `(subject_type, subject_id)` is total and stable;
 *   a uuid on this row would exist only to be ignored (same reasoning as
 *   `resource_links`).
 * - **`subject_id` is deliberately NOT a foreign key** — it is polymorphic
 *   across six tables (the same trade `reconcile_runs.subject_id` and
 *   `journal_entry_source_links` already make). Nothing stops an orphan row
 *   when a subject is deleted; the owning service must clear its own health
 *   row in the same transaction as the delete (`@loxep/domain`'s health
 *   service ships `clearHealthForSubject` for exactly that).
 * - **`integration_health` never drives retry or backoff.** `connections`'
 *   `last_success_at`/`last_error_at`/`last_error_code`,
 *   `monitor_targets.backoff_until`/`consecutive_errors`, and
 *   `managed_domains`' own error columns stay authoritative for their own
 *   subject's retry behavior. This table is a **derived rollup** for display
 *   and for deciding whether anything needs attention — nothing is dropped
 *   from any owning table by this migration.
 * - **There is no `stale` status.** `source` records HOW the row was learned
 *   (`probe` = Loxep checked; `adapter` = Loxep read a tool's API; `ingest` =
 *   a webhook told us; `report` = an out-of-band push); staleness is always
 *   DERIVED from `checked_at` by a reader, never asserted as a status value.
 * - **`detail` is small, Loxep-owned, and redacted** — counts, a short
 *   message, an error-taxonomy kind. Never a provider response body, a
 *   header, or credential material (per-adapter discipline, tested).
 * - **The cross-column CHECK** `(status = 'ok') = (consecutive_failures = 0)`
 *   is the same discipline as `order_fees`' scope check and the mailboxes'
 *   `kind`/`forward_to` biconditional: a green row with a failure streak is a
 *   bug that would otherwise render as a green dashboard.
 *
 * ## Transition tracking (loxep-oii, "cheap half")
 *
 * `previous_status`/`status_changed_at` (migration `0020`) are the minimal
 * fix for weave-audit finding 5's health half: before this, `upsertHealth`
 * overwrote the row in place with no prior value, so a degradation could
 * never be noticed after the fact once the next probe ran — "cheap to fix
 * now, impossible to backfill later." This is NOT the health-history table
 * the design explicitly refuses (see "What Phase 8 does not create" in the
 * design doc) — it is one prior value, kept only until the next transition,
 * same one-row-per-subject shape as everything else here. Notification
 * wiring off this transition (the audit's other half) is deferred.
 *
 * Both columns are nullable and set together, never independently: null on
 * first insert (there is no "previous" yet), and only written when
 * `upsertHealth` sees the incoming status differ from the stored one. An
 * unchanged status leaves both alone — they hold the most recent transition,
 * not the most recent write. `integration_health_status_change_pairing_check`
 * and `integration_health_status_change_distinct_check` extend the table's
 * existing biconditional-CHECK discipline to this pair: a row where exactly
 * one of the two is null, or where `previous_status = status`, is exactly
 * the same shape of bug the `ok`/`consecutive_failures` CHECK already
 * guards against (a claimed transition that did not happen, or a status the
 * app "forgot" was new), so it is refused at the database level rather than
 * trusted to `upsertHealth` alone.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./settings.ts";

/**
 * Closed subject-type set from the design's CHECK. This milestone probes
 * only `connection`, `notification_endpoint`, and `storage_backend`
 * (`@loxep/domain`'s health subject registry) — `external_resource`,
 * `hosting_target`, and `managed_domain` are reserved for later phases
 * (Phase 7/8 milestones) per open question 6's resolution, and are in the
 * CHECK from day one so a later phase's migration never has to widen it.
 */
export const HEALTH_SUBJECT_TYPES = [
  "connection",
  "notification_endpoint",
  "storage_backend",
  "external_resource",
  "hosting_target",
  "managed_domain",
] as const;
export type HealthSubjectType = (typeof HEALTH_SUBJECT_TYPES)[number];

/** No `stale` value — see the module doc. */
export const HEALTH_STATUSES = ["ok", "degraded", "failing", "unknown"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const HEALTH_SOURCES = ["probe", "adapter", "ingest", "report"] as const;
export type HealthSource = (typeof HEALTH_SOURCES)[number];

export const integrationHealth = pgTable(
  "integration_health",
  {
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    status: text("status").notNull(),
    source: text("source").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    detail: jsonb("detail").notNull().default(emptyJsonObject),
    // Transition tracking (loxep-oii, migration 0020) — see the module doc's
    // "Transition tracking" section. Both null until the first status
    // change; then hold the status/time of the most recent transition only.
    previousStatus: text("previous_status"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.subjectType, table.subjectId] }),
    check(
      "integration_health_subject_type_check",
      sql`${table.subjectType} in ('connection', 'notification_endpoint', 'storage_backend', 'external_resource', 'hosting_target', 'managed_domain')`,
    ),
    check(
      "integration_health_status_check",
      sql`${table.status} in ('ok', 'degraded', 'failing', 'unknown')`,
    ),
    check(
      "integration_health_source_check",
      sql`${table.source} in ('probe', 'adapter', 'ingest', 'report')`,
    ),
    // A green row with a failure streak is a bug, not a display choice.
    check(
      "integration_health_ok_zero_failures_check",
      sql`(${table.status} = 'ok') = (${table.consecutiveFailures} = 0)`,
    ),
    // previous_status, when present, is one of the same closed statuses.
    check(
      "integration_health_previous_status_check",
      sql`${table.previousStatus} is null or ${table.previousStatus} in ('ok', 'degraded', 'failing', 'unknown')`,
    ),
    // The pair is set together — a row with exactly one of the two null
    // claims a transition that has no timestamp, or a timestamp for no
    // transition.
    check(
      "integration_health_status_change_pairing_check",
      sql`(${table.previousStatus} is null) = (${table.statusChangedAt} is null)`,
    ),
    // A recorded "previous" status must actually differ from the current
    // one, or it is not a transition.
    check(
      "integration_health_status_change_distinct_check",
      sql`${table.previousStatus} is null or ${table.previousStatus} <> ${table.status}`,
    ),
    // "What needs attention" — deliberately excludes the common `ok` case.
    index("integration_health_status_idx")
      .on(table.status)
      .where(sql`${table.status} <> 'ok'`),
    // The sweep's due-work scan.
    index("integration_health_checked_at_idx").on(table.checkedAt),
  ],
);
