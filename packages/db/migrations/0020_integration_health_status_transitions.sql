-- Weave audit 2026-08 finding 5, health half (loxep-oii, "cheap now, impossible
-- to backfill later"): today upsertHealth overwrites integration_health in
-- place with no prior value, so a degradation can never be noticed after the
-- fact once the next probe runs. This migration adds the minimal transition
-- columns to make a status change observable; wiring a notification off it
-- is deliberately deferred (the notification-rules half of the same bead).
--
-- This is NOT the health-history table the design refuses ("What Phase 8
-- does not create": "a health history table — deferred, and it must stay a
-- deliberate decision"). It is one prior value per subject, kept only until
-- the next transition — same one-row-per-subject shape as the rest of the
-- table, not an append-only series.
--
--   previous_status     the status immediately before the most recent
--                        transition; null until the first transition
--   status_changed_at   when that transition was observed (the probe's
--                        checked_at, not a DB-side now()); null until the
--                        first transition
--
-- Both are written together, only by @loxep/domain's upsertHealth, and only
-- when the incoming status differs from the stored one — an unchanged status
-- upsert leaves both alone (they record the last transition, not the last
-- write).
--
-- Three CHECKs extend the table's existing biconditional-CHECK discipline
-- (the `(status = 'ok') = (consecutive_failures = 0)` precedent) to this new
-- pair, so a nonsensical row is refused at the database level rather than
-- trusted to the one call site:
--   previous_status is one of the same closed statuses, when present;
--   previous_status and status_changed_at are null together, never one
--     without the other (a transition with no timestamp, or a timestamp for
--     no transition, is a bug);
--   previous_status, when present, differs from the current status (a
--     "transition" that didn't change anything is a bug).
--
-- Verified at implementation time: drizzle-kit 0.31.10 emits two ADD COLUMN
-- statements and three ADD CONSTRAINT statements for this change — nothing
-- had to be hand-written.
ALTER TABLE "integration_health" ADD COLUMN "previous_status" text;--> statement-breakpoint
ALTER TABLE "integration_health" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_health" ADD CONSTRAINT "integration_health_previous_status_check" CHECK ("integration_health"."previous_status" is null or "integration_health"."previous_status" in ('ok', 'degraded', 'failing', 'unknown'));--> statement-breakpoint
ALTER TABLE "integration_health" ADD CONSTRAINT "integration_health_status_change_pairing_check" CHECK (("integration_health"."previous_status" is null) = ("integration_health"."status_changed_at" is null));--> statement-breakpoint
ALTER TABLE "integration_health" ADD CONSTRAINT "integration_health_status_change_distinct_check" CHECK ("integration_health"."previous_status" is null or "integration_health"."previous_status" <> "integration_health"."status");
