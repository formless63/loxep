-- Flipping lifecycle M3: inventory enrichment (loxep-dgf.3).
--
-- Physical realization of `flipping-lifecycle-design.md` section 3. Two
-- pieces:
--
--   1. inventory_items gains SIX nullable/defaulted columns: description,
--      sale_mode (+ CHECK, defaulted 'unit'), package_weight_grams, and
--      package_{length,width,height}_mm. This is the ONE deliberate
--      exception Phase 4 named for itself: "no existing table gains a
--      column" was scoped to Phase 4, and its forward-looking test —
--      "every arrow into a future phase is a reference added later, not a
--      rewrite of these tables" — is satisfied here. Every existing row
--      stays valid under the defaults; no data migration is needed.
--
--   2. inventory_item_specifics is new: typed key/value product specifics
--      (eBay-aspect-shaped) attached to the PHYSICAL UNIT, not a catalog
--      item. No Loxep-owned category/aspect taxonomy — see the design's
--      "Product specifics" section for why that was rejected. Multi-value
--      falls out of unique(inventory_item_id, name, value) rather than a
--      text[] column; value_numeric is a shadow of value, populated only on
--      a clean numeric parse, with nothing derived from it.
--
-- Images need NO schema at all: media_links (migration 0004) already
-- attaches an object to any resource by (resource_type, resource_id,
-- purpose). This migration adds no DDL for
-- resource_type = 'inventory_item' or its purpose values
-- (gallery | condition_evidence | supporting_document) — those are
-- application text, per INVENTORY_ITEM_MEDIA_PURPOSES in
-- packages/db/src/schema/inventory.ts. Per the design and the
-- implementation contract, `purpose` NEVER gains a 'primary' value: primary
-- is sort_order = 0, and sort_order is deliberately excluded from 0004's
-- unique key so reordering is a plain UPDATE rather than a purpose rewrite.
CREATE TABLE "inventory_item_specifics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"value_numeric" numeric(20, 6),
	"unit" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_item_specifics_item_name_value_uq" UNIQUE("inventory_item_id","name","value"),
	CONSTRAINT "inventory_item_specifics_source_check" CHECK ("inventory_item_specifics"."source" in ('manual', 'parsed', 'channel_suggested', 'catalog_default'))
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "sale_mode" text DEFAULT 'unit' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "package_weight_grams" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "package_length_mm" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "package_width_mm" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "package_height_mm" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "inventory_item_specifics" ADD CONSTRAINT "inventory_item_specifics_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_item_specifics_item_id_idx" ON "inventory_item_specifics" USING btree ("inventory_item_id");--> statement-breakpoint
CREATE INDEX "inventory_item_specifics_name_value_idx" ON "inventory_item_specifics" USING btree ("name","value");--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_sale_mode_check" CHECK ("inventory_items"."sale_mode" in ('unit', 'lot', 'set', 'parts_donor', 'parted_out', 'bundle_component'));--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_package_weight_check" CHECK ("inventory_items"."package_weight_grams" is null or "inventory_items"."package_weight_grams" > 0);--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_package_dimensions_check" CHECK (num_nonnulls("inventory_items"."package_length_mm", "inventory_items"."package_width_mm", "inventory_items"."package_height_mm") in (0, 3));