-- marketplace_item_observations: TimescaleDB hypertable (hand-written
-- migration; foundation-schema.md "Timescale observations" + ADR-0002).
--
-- Verified against TimescaleDB 2.29.1 (current docs, 2026-08):
--   * hypertable creation via CREATE TABLE ... WITH (tsdb.hypertable, ...);
--   * columnstore via ALTER TABLE ... SET (timescaledb.enable_columnstore,
--     timescaledb.segmentby, timescaledb.orderby);
--   * automatic conversion via CALL add_columnstore_policy(..., after => ...).
-- The removed Hypercore TAM APIs (ALTER TABLE ... SET ACCESS METHOD
-- hypercore, hypercore_use_access_method, ...) are deliberately NOT used.
--
-- tsdb.columnstore=false at creation so segmentby/orderby are configured
-- explicitly before the policy is added; create_default_indexes=false because
-- the two indexes below replace the default observed_at index.
--
-- No foreign keys: marketplace_item_id / connection_id are provenance
-- references per the draft's logical column list.
CREATE TABLE "marketplace_item_observations" (
	"marketplace_item_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"observation_batch_id" uuid NOT NULL,
	"connection_id" uuid,
	"source" text NOT NULL,
	"currency" char(3),
	"price" numeric(20, 6),
	"shipping_price" numeric(20, 6),
	"quantity_available" integer,
	"quantity_sold" integer,
	"availability" text,
	"listing_state" text,
	"watch_count" integer,
	"seller_feedback_score" bigint,
	"seller_feedback_pct" numeric(10, 6),
	"listing_ends_at" timestamp with time zone,
	"raw_state_hash" text
) WITH (
	tsdb.hypertable,
	tsdb.partition_column = 'observed_at',
	tsdb.chunk_interval = '7 days',
	tsdb.columnstore = false,
	tsdb.create_default_indexes = false
);--> statement-breakpoint
-- Retry identity under at-least-once job execution: a retried handler
-- re-inserting the same batch conflicts instead of duplicating. Includes the
-- partition column as Timescale requires for hypertable unique indexes.
CREATE UNIQUE INDEX "marketplace_item_observations_batch_item_observed_at_uq"
	ON "marketplace_item_observations" ("observation_batch_id", "marketplace_item_id", "observed_at");--> statement-breakpoint
-- Primary read path: per-item history, newest first.
CREATE INDEX "marketplace_item_observations_item_observed_at_idx"
	ON "marketplace_item_observations" ("marketplace_item_id", "observed_at" DESC);--> statement-breakpoint
-- Columnstore layout: segment by item; orderby includes observation_batch_id
-- so every unique-index column participates in segmentby/orderby, which
-- TimescaleDB requires to keep enforcing uniqueness on columnstore chunks.
ALTER TABLE "marketplace_item_observations" SET (
	timescaledb.enable_columnstore,
	timescaledb.segmentby = 'marketplace_item_id',
	timescaledb.orderby = 'observed_at DESC, observation_batch_id'
);--> statement-breakpoint
-- Convert chunks to columnstore after ~30 days. NO retention policy: history
-- is retained indefinitely by default (ADR-0002).
CALL add_columnstore_policy('marketplace_item_observations', after => INTERVAL '30 days');
