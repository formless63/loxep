-- Phase 3 commerce schema (commerce-schema-design.md): ten tables covering
-- orders and their attachments (Commerce) plus catalog items and channel
-- listings (Catalog and Listings). No existing table gains a column.
--
-- PROVISIONAL: this migration implements every open question in the design
-- document per that document's own recommendation, pending owner review. The
-- decisions visible in the DDL below are:
--   * order_fees.fee_direction ('seller_charge' | 'buyer_surcharge') — NOT in
--     the draft; forced by the WooCommerce finding that Woo `fee_lines` are
--     buyer surcharges inside orders.total, not seller-side platform fees;
--   * cross-connection duplicates are DETECTED, not constrained: the
--     orders_provider_source_account_external_order_idx index is deliberately
--     NON-unique and pairs with orders.duplicate_of_order_id;
--   * catalog_items.sku is unique INSTALLATION-WIDE, not per economic entity;
--   * no FX/base-currency columns and no order_status_events table;
--   * buyer identity is buyer_external_id + buyer_display_name only.
-- The fulfillment-state 'unknown' member and the order-sync target type
-- 'woo_orders' are application-level text values and appear in no DDL here.
--
-- channel_listings' UNIQUE ... NULLS NOT DISTINCT requires PostgreSQL 15+;
-- the deployment target is timescale/timescaledb:2.29.1-pg18. Without it every
-- re-sync of a non-variant listing would insert a duplicate row.
--
-- None of these tables is a Timescale hypertable: a sale is a record, not a
-- sample.
CREATE TABLE "catalog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"economic_entity_id" uuid,
	"parent_catalog_item_id" uuid,
	"variant_label" text,
	"description" text,
	"condition_code" text,
	"default_currency" char(3),
	"default_price" numeric(20, 6),
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_sku_uq" UNIQUE("sku"),
	CONSTRAINT "catalog_items_kind_check" CHECK ("catalog_items"."kind" in ('simple', 'variant_group', 'variant')),
	CONSTRAINT "catalog_items_variant_parent_check" CHECK (("catalog_items"."kind" = 'variant') = ("catalog_items"."parent_catalog_item_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "channel_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_item_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"channel" text NOT NULL,
	"marketplace" text,
	"external_listing_id" text NOT NULL,
	"external_variation_id" text,
	"marketplace_item_id" uuid,
	"status" text NOT NULL,
	"listing_url" text,
	"listing_title" text,
	"currency" char(3),
	"price" numeric(20, 6),
	"quantity_available" integer,
	"listed_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"first_ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_listings_connection_listing_variation_uq" UNIQUE NULLS NOT DISTINCT("connection_id","provider","external_listing_id","external_variation_id")
);
--> statement-breakpoint
CREATE TABLE "order_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid,
	"fee_scope" text NOT NULL,
	"fee_direction" text NOT NULL,
	"fee_type" text NOT NULL,
	"provider_fee_code" text,
	"external_fee_id" text,
	"description" text,
	"currency" char(3) NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"charged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_fees_fee_scope_check" CHECK ("order_fees"."fee_scope" in ('order', 'line')),
	CONSTRAINT "order_fees_fee_scope_line_check" CHECK (("order_fees"."fee_scope" = 'line') = ("order_fees"."order_line_id" is not null)),
	CONSTRAINT "order_fees_fee_direction_check" CHECK ("order_fees"."fee_direction" in ('seller_charge', 'buyer_surcharge'))
);
--> statement-breakpoint
CREATE TABLE "order_fulfillment_lines" (
	"order_fulfillment_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	CONSTRAINT "order_fulfillment_lines_order_fulfillment_id_order_line_id_pk" PRIMARY KEY("order_fulfillment_id","order_line_id"),
	CONSTRAINT "order_fulfillment_lines_quantity_check" CHECK ("order_fulfillment_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"external_fulfillment_id" text,
	"status" text NOT NULL,
	"carrier_code" text,
	"carrier_name" text,
	"service_code" text,
	"tracking_number" text,
	"tracking_url" text,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"destination_country" char(2),
	"destination_region" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"external_line_id" text,
	"catalog_item_id" uuid,
	"channel_listing_id" uuid,
	"marketplace_item_id" uuid,
	"external_item_id" text,
	"external_variation_id" text,
	"channel_sku" text,
	"title" text,
	"quantity" numeric(20, 6) NOT NULL,
	"unit_price" numeric(20, 6) NOT NULL,
	"line_subtotal" numeric(20, 6) NOT NULL,
	"discount_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"shipping_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"refunded_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"line_total" numeric(20, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_order_id_line_number_uq" UNIQUE("order_id","line_number"),
	CONSTRAINT "order_lines_quantity_check" CHECK ("order_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_refund_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_refund_id" uuid NOT NULL,
	"order_line_id" uuid,
	"quantity" numeric(20, 6),
	"amount" numeric(20, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"external_refund_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"reason_code" text,
	"currency" char(3) NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_source_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"source_event_id" uuid,
	"provider_object_id" uuid,
	"effect" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_source_links_effect_check" CHECK ("order_source_links"."effect" in ('created', 'updated', 'unchanged')),
	CONSTRAINT "order_source_links_one_reference_check" CHECK (num_nonnulls("order_source_links"."source_event_id", "order_source_links"."provider_object_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"channel" text NOT NULL,
	"marketplace" text,
	"source_account_key" text NOT NULL,
	"external_order_id" text NOT NULL,
	"external_order_number" text,
	"economic_entity_id" uuid,
	"entity_attribution_source" text NOT NULL,
	"entity_attributed_at" timestamp with time zone,
	"entity_attributed_by_user_id" text,
	"status" text NOT NULL,
	"payment_status" text NOT NULL,
	"fulfillment_status" text NOT NULL,
	"provider_status_raw" text,
	"currency" char(3) NOT NULL,
	"subtotal_amount" numeric(20, 6) NOT NULL,
	"shipping_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"fee_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"refunded_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"total_amount" numeric(20, 6) NOT NULL,
	"buyer_external_id" text,
	"buyer_display_name" text,
	"placed_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"duplicate_of_order_id" uuid,
	"first_ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_connection_provider_external_order_uq" UNIQUE("connection_id","provider","external_order_id"),
	CONSTRAINT "orders_entity_attribution_source_check" CHECK ("orders"."entity_attribution_source" in ('manual', 'connection_default', 'unattributed'))
);
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_parent_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("parent_catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_marketplace_item_id_marketplace_items_id_fk" FOREIGN KEY ("marketplace_item_id") REFERENCES "public"."marketplace_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fees" ADD CONSTRAINT "order_fees_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fees" ADD CONSTRAINT "order_fees_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfillment_lines" ADD CONSTRAINT "order_fulfillment_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfillment_lines" ADD CONSTRAINT "order_fulfillment_lines_fulfillment_id_fk" FOREIGN KEY ("order_fulfillment_id") REFERENCES "public"."order_fulfillments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_channel_listing_id_channel_listings_id_fk" FOREIGN KEY ("channel_listing_id") REFERENCES "public"."channel_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_marketplace_item_id_marketplace_items_id_fk" FOREIGN KEY ("marketplace_item_id") REFERENCES "public"."marketplace_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refund_lines" ADD CONSTRAINT "order_refund_lines_order_refund_id_order_refunds_id_fk" FOREIGN KEY ("order_refund_id") REFERENCES "public"."order_refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refund_lines" ADD CONSTRAINT "order_refund_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_source_links" ADD CONSTRAINT "order_source_links_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_source_links" ADD CONSTRAINT "order_source_links_source_event_id_source_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."source_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_source_links" ADD CONSTRAINT "order_source_links_provider_object_id_provider_objects_id_fk" FOREIGN KEY ("provider_object_id") REFERENCES "public"."provider_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_entity_attributed_by_user_id_user_id_fk" FOREIGN KEY ("entity_attributed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_duplicate_of_order_id_orders_id_fk" FOREIGN KEY ("duplicate_of_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_items_parent_catalog_item_id_idx" ON "catalog_items" USING btree ("parent_catalog_item_id") WHERE "catalog_items"."parent_catalog_item_id" is not null;--> statement-breakpoint
CREATE INDEX "channel_listings_catalog_item_id_idx" ON "channel_listings" USING btree ("catalog_item_id");--> statement-breakpoint
CREATE INDEX "channel_listings_connection_id_status_idx" ON "channel_listings" USING btree ("connection_id","status");--> statement-breakpoint
CREATE INDEX "channel_listings_marketplace_item_id_idx" ON "channel_listings" USING btree ("marketplace_item_id") WHERE "channel_listings"."marketplace_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "order_fees_order_id_external_fee_id_uq" ON "order_fees" USING btree ("order_id","external_fee_id") WHERE "order_fees"."external_fee_id" is not null;--> statement-breakpoint
CREATE INDEX "order_fees_order_id_idx" ON "order_fees" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_fees_fee_type_charged_at_idx" ON "order_fees" USING btree ("fee_type","charged_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "order_fulfillments_order_id_external_id_uq" ON "order_fulfillments" USING btree ("order_id","external_fulfillment_id") WHERE "order_fulfillments"."external_fulfillment_id" is not null;--> statement-breakpoint
CREATE INDEX "order_fulfillments_order_id_idx" ON "order_fulfillments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_fulfillments_tracking_number_idx" ON "order_fulfillments" USING btree ("tracking_number") WHERE "order_fulfillments"."tracking_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_order_id_external_line_id_uq" ON "order_lines" USING btree ("order_id","external_line_id") WHERE "order_lines"."external_line_id" is not null;--> statement-breakpoint
CREATE INDEX "order_lines_catalog_item_id_idx" ON "order_lines" USING btree ("catalog_item_id") WHERE "order_lines"."catalog_item_id" is not null;--> statement-breakpoint
CREATE INDEX "order_lines_channel_listing_id_idx" ON "order_lines" USING btree ("channel_listing_id") WHERE "order_lines"."channel_listing_id" is not null;--> statement-breakpoint
CREATE INDEX "order_lines_marketplace_item_id_idx" ON "order_lines" USING btree ("marketplace_item_id") WHERE "order_lines"."marketplace_item_id" is not null;--> statement-breakpoint
CREATE INDEX "order_refund_lines_order_refund_id_idx" ON "order_refund_lines" USING btree ("order_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_refunds_order_id_external_refund_id_uq" ON "order_refunds" USING btree ("order_id","external_refund_id") WHERE "order_refunds"."external_refund_id" is not null;--> statement-breakpoint
CREATE INDEX "order_refunds_order_id_idx" ON "order_refunds" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_source_links_order_id_source_event_id_uq" ON "order_source_links" USING btree ("order_id","source_event_id") WHERE "order_source_links"."source_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "order_source_links_order_id_provider_object_id_uq" ON "order_source_links" USING btree ("order_id","provider_object_id") WHERE "order_source_links"."provider_object_id" is not null;--> statement-breakpoint
CREATE INDEX "order_source_links_order_id_linked_at_idx" ON "order_source_links" USING btree ("order_id","linked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_connection_id_provider_updated_at_idx" ON "orders" USING btree ("connection_id","provider_updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_economic_entity_id_placed_at_idx" ON "orders" USING btree ("economic_entity_id","placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_channel_placed_at_idx" ON "orders" USING btree ("channel","placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_placed_at_idx" ON "orders" USING btree ("placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_unattributed_idx" ON "orders" USING btree ("economic_entity_id") WHERE "orders"."economic_entity_id" is null;--> statement-breakpoint
CREATE INDEX "orders_provider_source_account_external_order_idx" ON "orders" USING btree ("provider","source_account_key","external_order_id");