-- Phase 9 milestone 4 (loxep-dgf.4): the Documents domain's first two tables.
--
-- From `flipping-lifecycle-design.md` section 2b, exactly: `documents` and
-- `document_line_candidates`. The Documents domain has been specified since
-- the foundation (`domain-boundaries.md`'s "Documents" section) and no prior
-- phase claimed it; this is its first physical realization.
--
-- The load-bearing rule this schema enforces structurally, not by
-- convention: a parse is never a fact. `document_line_candidates.target_kind`
-- / `target_id` is a STAMP a consuming domain writes AFTER it independently
-- creates its own record (an expense, an acquisition, an acquisition cost, or
-- an inventory item) — it is deliberately NOT a foreign key, the same
-- treatment `journal_entry_source_links` and `media_links.resource_id`
-- already get, and for the same reason: an orphan-detection report is owed
-- alongside it, not a constraint that would need a `num_nonnulls` dance
-- across four nullable target tables for a row whose only purpose is an
-- audit crumb.
--
-- ## What this migration deliberately does NOT create
--
--   parsed_text column           no backend produces text yet (OQ3: manual-
--                                 assisted only ships this milestone)
--   a uniqueness constraint on   detect, do not constrain — `orders` already
--   row_fingerprint              answered this shape of question; the CSV
--                                 importer WARNS on a repeat, never blocks
--   any change to acquisitions,  the confirm functions that consume these
--   inventory_items, or expenses candidates write to those tables from their
--                                 OWN packages (@loxep/accounting,
--                                 @loxep/inventory); this migration adds no
--                                 column and no FK on any of the three
--
-- Verified against PostgreSQL 18 / drizzle-orm 0.45.2 / drizzle-kit 0.31.10
-- (the versions already pinned in this workspace) at implementation time —
-- every CHECK, partial index, and the kind/reference pair below is expressed
-- natively; nothing here needed hand-written SQL.

CREATE TABLE "document_line_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"row_fingerprint" text,
	"description" text,
	"quantity" numeric(20, 6),
	"unit_amount" numeric(20, 6),
	"line_amount" numeric(20, 6),
	"currency" char(3),
	"line_date" date,
	"confidence" numeric(4, 3),
	"source_region" text,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"target_kind" text,
	"target_id" uuid,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_line_candidates_document_id_line_number_uq" UNIQUE("document_id","line_number"),
	CONSTRAINT "document_line_candidates_disposition_check" CHECK ("document_line_candidates"."disposition" in ('pending', 'expense', 'acquisition_cost', 'inventory_intake', 'supplies', 'personal', 'not_mine', 'duplicate', 'discarded')),
	CONSTRAINT "document_line_candidates_target_kind_check" CHECK ("document_line_candidates"."target_kind" is null or "document_line_candidates"."target_kind" in ('expense', 'acquisition', 'acquisition_cost', 'inventory_item')),
	CONSTRAINT "document_line_candidates_target_pair_check" CHECK (("document_line_candidates"."target_id" is not null) = ("document_line_candidates"."target_kind" is not null)),
	CONSTRAINT "document_line_candidates_confidence_check" CHECK ("document_line_candidates"."confidence" is null or ("document_line_candidates"."confidence" >= 0 and "document_line_candidates"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_kind" text NOT NULL,
	"source_kind" text NOT NULL,
	"media_object_id" uuid,
	"original_filename" text,
	"economic_entity_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"parser_id" text,
	"parsed_at" timestamp with time zone,
	"currency" char(3),
	"document_total" numeric(20, 6),
	"document_date" date,
	"counterparty_name" text,
	"line_count" integer DEFAULT 0 NOT NULL,
	"confirmed_count" integer DEFAULT 0 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" text,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_document_kind_check" CHECK ("documents"."document_kind" in ('receipt', 'invoice', 'packing_slip', 'statement', 'csv_import')),
	CONSTRAINT "documents_source_kind_check" CHECK ("documents"."source_kind" in ('upload', 'csv', 'connector')),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('pending', 'parsing', 'review', 'partially_confirmed', 'confirmed', 'discarded', 'failed')),
	CONSTRAINT "documents_source_kind_media_object_check" CHECK (("documents"."source_kind" = 'upload') = ("documents"."media_object_id" is not null)),
	CONSTRAINT "documents_confirmed_count_check" CHECK ("documents"."confirmed_count" >= 0 and "documents"."confirmed_count" <= "documents"."line_count")
);
--> statement-breakpoint
ALTER TABLE "document_line_candidates" ADD CONSTRAINT "document_line_candidates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_line_candidates" ADD CONSTRAINT "document_line_candidates_confirmed_by_user_id_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_media_object_id_media_objects_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_confirmed_by_user_id_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_line_candidates_row_fingerprint_idx" ON "document_line_candidates" USING btree ("row_fingerprint") WHERE "document_line_candidates"."row_fingerprint" is not null;--> statement-breakpoint
CREATE INDEX "document_line_candidates_disposition_idx" ON "document_line_candidates" USING btree ("document_id","disposition") WHERE "document_line_candidates"."disposition" = 'pending';--> statement-breakpoint
CREATE INDEX "documents_status_created_at_idx" ON "documents" USING btree ("status","created_at" DESC NULLS LAST) WHERE "documents"."status" <> 'confirmed';--> statement-breakpoint
CREATE INDEX "documents_economic_entity_id_idx" ON "documents" USING btree ("economic_entity_id") WHERE "documents"."economic_entity_id" is not null;