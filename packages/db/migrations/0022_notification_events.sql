-- Weave audit 2026-08 finding 5, notification half (loxep-oii); the ruling is
-- ADR-0023 and the mechanism is
-- apps/docs/src/content/docs/architecture/notifications-design.md.
--
-- Before this migration `notification_deliveries.market_event_id` was NOT NULL
-- with a foreign key to `market_events`, and the UNIQUE (market_event_id,
-- endpoint_id) pair that makes at-least-once delivery safe was therefore a
-- market fact. A delivery row for anything else could not exist, so every
-- event class shipped since Phase 2 — purchase ingested, document confirmed,
-- manual sale recorded, DNS drift, integration health degraded (observable
-- since 0020, still not notifiable) — was detected and un-notifiable.
--
-- What ships:
--
--   notification_events   the detection-side ledger of notifiable facts:
--                         event_class + event_type (what happened),
--                         subject_type + subject_id (what it happened to),
--                         occurred_at, a small Loxep-owned render payload, and
--                         a UNIQUE deduplication_key so an at-least-once
--                         emitter cannot notify twice. subject_id is
--                         deliberately NOT a foreign key — polymorphic across
--                         a dozen tables, the same trade
--                         integration_health.subject_id, reconcile_runs.
--                         subject_id and journal_entry_source_links make.
--
--   notification_deliveries  keeps its exact shape — one NOT NULL FK to the
--                         subject, one UNIQUE (subject, endpoint) pair — with
--                         market_event_id renamed to notification_event_id and
--                         repointed. Existing market deliveries are PRESERVED
--                         by backfill below, not discarded.
--
--   notification_rules    gains the event_class dimension and renames
--                         market_event_type to event_type. Existing rows are
--                         stamped 'market', so no shipped rule silently widens
--                         to cover health transitions or purchases. NOT NULL
--                         with no wildcard is the point.
--
-- What this deliberately does NOT create: a rules engine (no thresholds, quiet
-- hours, per-class predicates, rate limits, or a generalized (subject_type,
-- subject_id) narrowing on rules — `conditions` stays the unused column it
-- has always been); a per-user read/inbox table (the ledger is a feed of
-- facts, and Loxep has installation-wide roles, not per-user notification
-- preferences); per-class delivery tables; and any retention policy, matching
-- market_events and the observation schema.
--
-- event_class and subject_type are closed CHECKed sets seeded with values
-- later phases will need ('infrastructure' for DNS drift and reconciler
-- failures; the three fleet subject types), following HEALTH_SUBJECT_TYPES'
-- precedent so a later phase never has to widen the CHECK. event_type is
-- deliberately NOT CHECKed: valid (class, type) pairs live in @loxep/domain's
-- event-class registry, so adding a type to a shipped class is a registry
-- entry rather than a migration.
--
-- The delivery foreign key is named explicitly: the derived name
-- (notification_deliveries_notification_event_id_notification_events_id_fk) is
-- 71 bytes and PostgreSQL truncates identifiers at 63.
--
-- Generated with drizzle-kit 0.31.10, then hand-edited for the two things it
-- cannot express: adding a NOT NULL column to a populated table (backfill
-- between ADD COLUMN and SET NOT NULL) and the market-delivery backfill.
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_class" text NOT NULL,
	"event_type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"monitor_target_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deduplication_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_deduplication_key_unique" UNIQUE("deduplication_key"),
	CONSTRAINT "notification_events_event_class_check" CHECK ("notification_events"."event_class" in ('market', 'purchase', 'document', 'sale', 'health', 'infrastructure')),
	CONSTRAINT "notification_events_subject_type_check" CHECK ("notification_events"."subject_type" in ('market_event', 'acquisition', 'document', 'order', 'connection', 'notification_endpoint', 'storage_backend', 'external_resource', 'hosting_target', 'managed_domain', 'monitor_target', 'reconcile_run'))
);
--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_monitor_target_id_monitor_targets_id_fk" FOREIGN KEY ("monitor_target_id") REFERENCES "public"."monitor_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_events_occurred_at_idx" ON "notification_events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_events_class_occurred_at_idx" ON "notification_events" USING btree ("event_class","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_events_subject_idx" ON "notification_events" USING btree ("subject_type","subject_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "notification_rules" RENAME COLUMN "market_event_type" TO "event_type";--> statement-breakpoint
ALTER TABLE "notification_rules" ADD COLUMN "event_class" text;--> statement-breakpoint
UPDATE "notification_rules" SET "event_class" = 'market' WHERE "event_class" IS NULL;--> statement-breakpoint
ALTER TABLE "notification_rules" ALTER COLUMN "event_class" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_event_class_check" CHECK ("notification_rules"."event_class" in ('market', 'purchase', 'document', 'sale', 'health', 'infrastructure'));--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_market_event_id_endpoint_id_uq";--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_market_event_id_market_events_id_fk";--> statement-breakpoint
ALTER TABLE "notification_deliveries" RENAME COLUMN "market_event_id" TO "notification_event_id";--> statement-breakpoint
INSERT INTO "notification_events" (
	"event_class", "event_type", "subject_type", "subject_id",
	"monitor_target_id", "occurred_at", "payload", "deduplication_key",
	"created_at"
)
SELECT 'market',
       me."event_type",
       'market_event',
       me."id",
       me."monitor_target_id",
       me."to_observed_at",
       CASE WHEN jsonb_typeof(me."payload") = 'object'
              THEN me."payload" || jsonb_build_object('marketplaceItemId', me."marketplace_item_id")
              ELSE jsonb_build_object('marketplaceItemId', me."marketplace_item_id")
       END,
       'market_event:' || me."id"::text,
       me."created_at"
  FROM "market_events" me
 WHERE EXISTS (
         SELECT 1 FROM "notification_deliveries" d
          WHERE d."notification_event_id" = me."id"
       )
    ON CONFLICT ("deduplication_key") DO NOTHING;--> statement-breakpoint
UPDATE "notification_deliveries" d
   SET "notification_event_id" = ne."id"
  FROM "notification_events" ne
 WHERE ne."subject_type" = 'market_event'
   AND ne."subject_id" = d."notification_event_id";--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_fk" FOREIGN KEY ("notification_event_id") REFERENCES "public"."notification_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_endpoint_uq" UNIQUE("notification_event_id","endpoint_id");
