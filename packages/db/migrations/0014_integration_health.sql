-- Phase 8 milestone 1 (loxep-ovj.1) — integration_health, the only new table
-- in Phase 8. Design: apps/docs/src/content/docs/architecture/
-- fleet-observability-design.md ("integration_health: the only new table").
--
-- Ownership: SHARED FOUNDATION, not Infrastructure (open question 6,
-- resolved) — @loxep/domain owns the service over this table, alongside
-- connections/settings/secrets. Four of the six subject types are foundation
-- records unrelated to the fleet, and Phase 6 and Phase 7 both already assume
-- this table exists ("Three designs assume a table that does not exist").
--
-- One row per subject, overwritten in place — never a hypertable, never a
-- time series of status. That is the phase's enforceable boundary marker
-- against rebuilding Beszel/Gatus (see the design's "self-monitoring trap").
--
-- ## What this migration deliberately does NOT do
--
--   no surrogate key            (subject_type, subject_id) is total and
--                                stable; a uuid here would be ignored
--   no FK on subject_id         deliberately polymorphic across six tables,
--                                same trade as reconcile_runs.subject_id and
--                                journal_entry_source_links; the owning
--                                service clears its own row on delete
--   no ALTER on any other table nothing is dropped from connections'
--                                last_success_at/last_error_at/last_error_code,
--                                monitor_targets' backoff columns, or
--                                managed_domains' own error columns — this
--                                table never drives retry/backoff, they stay
--                                authoritative for their own subject
--   no 'stale' status value     staleness is always DERIVED from checked_at
--                                by a reader, never asserted as a status
--
-- The cross-column CHECK `(status = 'ok') = (consecutive_failures = 0)` is
-- the same discipline as order_fees' scope check and mailboxes' kind/
-- forward_to biconditional: a green row with a failure streak is a bug that
-- would otherwise render as a green dashboard.
--
-- Verified at implementation time: drizzle-kit 0.31.10 emits the composite
-- primary key together with all four CHECK constraints (including the
-- multi-column biconditional) correctly — nothing had to be hand-written and
-- no invariant was weakened.
CREATE TABLE "integration_health" (
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_health_subject_type_subject_id_pk" PRIMARY KEY("subject_type","subject_id"),
	CONSTRAINT "integration_health_subject_type_check" CHECK ("integration_health"."subject_type" in ('connection', 'notification_endpoint', 'storage_backend', 'external_resource', 'hosting_target', 'managed_domain')),
	CONSTRAINT "integration_health_status_check" CHECK ("integration_health"."status" in ('ok', 'degraded', 'failing', 'unknown')),
	CONSTRAINT "integration_health_source_check" CHECK ("integration_health"."source" in ('probe', 'adapter', 'ingest', 'report')),
	CONSTRAINT "integration_health_ok_zero_failures_check" CHECK (("integration_health"."status" = 'ok') = ("integration_health"."consecutive_failures" = 0))
);
--> statement-breakpoint
CREATE INDEX "integration_health_status_idx" ON "integration_health" USING btree ("status") WHERE "integration_health"."status" <> 'ok';--> statement-breakpoint
CREATE INDEX "integration_health_checked_at_idx" ON "integration_health" USING btree ("checked_at");