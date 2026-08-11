-- Phase 4 inventory and acquisition schema (inventory-schema-design.md): nine
-- tables covering acquisitions and lot costs, the location tree, inventory
-- items with specific-identification cost basis, allocations, the append-only
-- movement ledger, outbound shipments and their contents, and the
-- opportunity-to-outcome link. No existing table gains a column.
--
-- Ordering note: every CREATE TABLE below is emitted before any FOREIGN KEY, so
-- the design's mutual reference (inventory_items.acquisition_id back,
-- acquisition_costs.inventory_item_id forward) resolves without a deferred
-- constraint. Migration 0003 (commerce) is a hard prerequisite: allocations,
-- movements, shipments, and shipment_items all carry foreign keys into
-- order_lines, order_fulfillments, order_fees, and orders.
--
-- PROVISIONAL: this migration implements every open question in the design
-- document per that document's own recommendation, pending owner review. The
-- decisions visible in the DDL below are:
--   * append-only on inventory_movements is enforced by a REAL trigger (OQ2) —
--     see the bottom of this file. There is deliberately no updated_at column
--     on that table;
--   * inventory_items.quantity_on_hand is a CACHE with a single writer (OQ3),
--     and there is deliberately NO check(quantity_on_hand >= 0): oversell is a
--     real event to surface, not a constraint violation that fails a job;
--   * location lives as one column on the item, not a per-location balance
--     table (OQ4); a partial move is a row split;
--   * inventory_items.cost_basis_locked_at freezes basis at first depletion
--     (OQ5);
--   * shipments.order_fee_id is the shipping double-count guard (OQ6), tied to
--     cost_source = 'fee_derived' by a CHECK so it cannot be half-recorded;
--   * pro-rata allocation of order-scoped fees and shipping is computed in the
--     read model and NEVER stored (OQ7) — hence no allocation columns anywhere;
--   * no FX: no base-currency amount and no stored rate exists (OQ8);
--   * consignment is an ordinary item with zero basis and
--     source_kind = 'consignment_intake' (OQ9); no `ownership` column yet;
--   * acquisition_costs.capitalize = false rows are kept (OQ10).
-- No per-SKU costing_method column is created anywhere (OQ1).
--
-- Hand-written SQL beyond what drizzle-kit generates: the append-only trigger.
-- UNIQUE ... NULLS NOT DISTINCT (inventory_locations, shipment_items),
-- partial unique indexes with IN predicates (inventory_allocations),
-- num_nonnulls CHECKs, and the text_pattern_ops path index were all verified to
-- generate correctly from the Drizzle schema against drizzle-kit 0.31.10, so
-- none of them was weakened.
--
-- None of these tables is a Timescale hypertable: a movement ledger looks
-- temporal and is not.
CREATE TABLE "acquisition_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"acquisition_id" uuid NOT NULL,
	"inventory_item_id" uuid,
	"cost_scope" text NOT NULL,
	"cost_type" text NOT NULL,
	"cost_class" text NOT NULL,
	"capitalize" boolean DEFAULT true NOT NULL,
	"description" text,
	"vendor_name" text,
	"external_reference" text,
	"currency" char(3) NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"incurred_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acquisition_costs_cost_scope_check" CHECK ("acquisition_costs"."cost_scope" in ('lot', 'item')),
	CONSTRAINT "acquisition_costs_scope_item_check" CHECK (("acquisition_costs"."cost_scope" = 'item') = ("acquisition_costs"."inventory_item_id" is not null)),
	CONSTRAINT "acquisition_costs_cost_class_check" CHECK ("acquisition_costs"."cost_class" in ('goods', 'ancillary'))
);
--> statement-breakpoint
CREATE TABLE "acquisition_opportunity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_kind" text NOT NULL,
	"acquisition_id" uuid,
	"inventory_item_id" uuid,
	"market_event_id" uuid,
	"marketplace_item_id" uuid,
	"opportunity_rule_id" uuid,
	"score_at_link" numeric(10, 4),
	"target_currency" char(3),
	"target_price_amount" numeric(20, 6),
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"linked_by_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acq_opportunity_links_kind_check" CHECK ("acquisition_opportunity_links"."link_kind" in ('sourced_from', 'evaluated_against', 'comparable')),
	CONSTRAINT "acq_opportunity_links_subject_check" CHECK (num_nonnulls("acquisition_opportunity_links"."acquisition_id", "acquisition_opportunity_links"."inventory_item_id") >= 1),
	CONSTRAINT "acq_opportunity_links_evidence_check" CHECK (num_nonnulls("acquisition_opportunity_links"."market_event_id", "acquisition_opportunity_links"."marketplace_item_id") >= 1)
);
--> statement-breakpoint
CREATE TABLE "acquisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"economic_entity_id" uuid,
	"entity_attribution_source" text NOT NULL,
	"entity_attributed_at" timestamp with time zone,
	"entity_attributed_by_user_id" text,
	"source_kind" text NOT NULL,
	"status" text NOT NULL,
	"reference_code" text NOT NULL,
	"title" text NOT NULL,
	"vendor_name" text,
	"vendor_location" text,
	"external_reference" text,
	"connection_id" uuid,
	"currency" char(3) NOT NULL,
	"cost_allocation_basis" text NOT NULL,
	"cost_allocation_status" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"expected_item_count" integer,
	"notes" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acquisitions_reference_code_uq" UNIQUE("reference_code"),
	CONSTRAINT "acquisitions_entity_attribution_source_check" CHECK ("acquisitions"."entity_attribution_source" in ('manual', 'installation_default', 'connection_default', 'unattributed')),
	CONSTRAINT "acquisitions_source_kind_check" CHECK ("acquisitions"."source_kind" in ('auction_lot', 'estate_sale', 'thrift_retail', 'retail_arbitrage', 'liquidation_pallet', 'wholesale_purchase', 'online_marketplace', 'trade_in', 'consignment_intake', 'personal_conversion', 'customer_return', 'found_stock', 'other')),
	CONSTRAINT "acquisitions_cost_allocation_basis_check" CHECK ("acquisitions"."cost_allocation_basis" in ('equal', 'relative_value', 'weight', 'manual', 'direct')),
	CONSTRAINT "acquisitions_cost_allocation_status_check" CHECK ("acquisitions"."cost_allocation_status" in ('pending', 'provisional', 'final'))
);
--> statement-breakpoint
CREATE TABLE "inventory_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"allocation_kind" text NOT NULL,
	"order_line_id" uuid,
	"quantity" numeric(20, 6) NOT NULL,
	"status" text NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_allocations_quantity_check" CHECK ("inventory_allocations"."quantity" > 0),
	CONSTRAINT "inventory_allocations_kind_check" CHECK ("inventory_allocations"."allocation_kind" in ('order_line', 'manual_hold', 'transfer', 'project')),
	CONSTRAINT "inventory_allocations_kind_reference_check" CHECK (("inventory_allocations"."allocation_kind" = 'order_line') = ("inventory_allocations"."order_line_id" is not null)),
	CONSTRAINT "inventory_allocations_status_check" CHECK ("inventory_allocations"."status" in ('reserved', 'fulfilled', 'released', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_code" text NOT NULL,
	"acquisition_id" uuid,
	"catalog_item_id" uuid,
	"economic_entity_id" uuid,
	"entity_attribution_source" text NOT NULL,
	"entity_attributed_at" timestamp with time zone,
	"entity_attributed_by_user_id" text,
	"location_id" uuid,
	"origin_item_id" uuid,
	"label" text NOT NULL,
	"lot_reference" text,
	"serial_number" text,
	"status" text NOT NULL,
	"condition_code" text NOT NULL,
	"condition_notes" text,
	"grading_authority" text,
	"grade_label" text,
	"grade_numeric" numeric(4, 1),
	"certificate_number" text,
	"quantity" numeric(20, 6) DEFAULT '1' NOT NULL,
	"quantity_on_hand" numeric(20, 6) DEFAULT '0' NOT NULL,
	"currency" char(3) NOT NULL,
	"acquisition_cost_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"landed_cost_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"cost_allocation_basis" text DEFAULT 'unallocated' NOT NULL,
	"cost_allocation_weight" numeric(20, 6),
	"cost_basis_locked_at" timestamp with time zone,
	"estimated_value_amount" numeric(20, 6),
	"acquired_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone,
	"listed_at" timestamp with time zone,
	"depleted_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_item_code_uq" UNIQUE("item_code"),
	CONSTRAINT "inventory_items_quantity_check" CHECK ("inventory_items"."quantity" > 0),
	CONSTRAINT "inventory_items_entity_attribution_source_check" CHECK ("inventory_items"."entity_attribution_source" in ('manual', 'acquisition_default', 'installation_default', 'connection_default', 'unattributed')),
	CONSTRAINT "inventory_items_cost_allocation_basis_check" CHECK ("inventory_items"."cost_allocation_basis" in ('unallocated', 'equal', 'relative_value', 'weight', 'manual', 'direct')),
	CONSTRAINT "inventory_items_condition_code_check" CHECK ("inventory_items"."condition_code" in ('new_sealed', 'new_open_box', 'like_new', 'very_good', 'good', 'acceptable', 'for_parts', 'damaged', 'unknown')),
	CONSTRAINT "inventory_items_grade_authority_check" CHECK (("inventory_items"."grade_label" is null) or ("inventory_items"."grading_authority" is not null))
);
--> statement-breakpoint
CREATE TABLE "inventory_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_location_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_locations_code_uq" UNIQUE("code"),
	CONSTRAINT "inventory_locations_parent_name_uq" UNIQUE NULLS NOT DISTINCT("parent_location_id","name"),
	CONSTRAINT "inventory_locations_kind_check" CHECK ("inventory_locations"."kind" in ('site', 'room', 'area', 'shelf', 'bin', 'container', 'vehicle', 'in_transit')),
	CONSTRAINT "inventory_locations_self_parent_check" CHECK ("inventory_locations"."parent_location_id" is distinct from "inventory_locations"."id"),
	CONSTRAINT "inventory_locations_depth_check" CHECK ("inventory_locations"."depth" >= 0 and "inventory_locations"."depth" <= 6)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"movement_kind" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"location_id" uuid,
	"transfer_group_id" uuid,
	"acquisition_id" uuid,
	"inventory_allocation_id" uuid,
	"order_line_id" uuid,
	"order_fulfillment_id" uuid,
	"shipment_id" uuid,
	"reverses_movement_id" uuid,
	"reason_code" text,
	"note" text,
	"deduplication_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_deduplication_key_uq" UNIQUE("deduplication_key"),
	CONSTRAINT "inventory_movements_quantity_check" CHECK ("inventory_movements"."quantity" <> 0),
	CONSTRAINT "inventory_movements_kind_check" CHECK ("inventory_movements"."movement_kind" in ('receipt', 'transfer_in', 'return_in', 'adjustment_in', 'found', 'transfer_out', 'depletion_sale', 'adjustment_out', 'shrinkage', 'disposal', 'consumption', 'reversal')),
	CONSTRAINT "inventory_movements_sign_check" CHECK ("inventory_movements"."movement_kind" = 'reversal' or (("inventory_movements"."movement_kind" in ('receipt', 'transfer_in', 'return_in', 'adjustment_in', 'found')) = ("inventory_movements"."quantity" > 0))),
	CONSTRAINT "inventory_movements_transfer_group_check" CHECK (("inventory_movements"."transfer_group_id" is not null) = ("inventory_movements"."movement_kind" in ('transfer_in', 'transfer_out'))),
	CONSTRAINT "inventory_movements_reversal_check" CHECK (("inventory_movements"."reverses_movement_id" is not null) = ("inventory_movements"."movement_kind" = 'reversal'))
);
--> statement-breakpoint
CREATE TABLE "shipment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"inventory_item_id" uuid,
	"order_line_id" uuid,
	"quantity" numeric(20, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_items_shipment_item_line_uq" UNIQUE NULLS NOT DISTINCT("shipment_id","inventory_item_id","order_line_id"),
	CONSTRAINT "shipment_items_quantity_check" CHECK ("shipment_items"."quantity" > 0),
	CONSTRAINT "shipment_items_one_reference_check" CHECK (num_nonnulls("shipment_items"."inventory_item_id", "shipment_items"."order_line_id") >= 1)
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_kind" text NOT NULL,
	"order_id" uuid,
	"order_fulfillment_id" uuid,
	"order_fee_id" uuid,
	"status" text NOT NULL,
	"carrier_code" text,
	"carrier_name" text,
	"service_code" text,
	"tracking_number" text,
	"tracking_url" text,
	"label_external_id" text,
	"package_count" integer DEFAULT 1 NOT NULL,
	"weight_grams" numeric(20, 6),
	"length_mm" numeric(20, 6),
	"width_mm" numeric(20, 6),
	"height_mm" numeric(20, 6),
	"origin_location_id" uuid,
	"destination_country" char(2),
	"destination_region" text,
	"currency" char(3),
	"postage_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"insurance_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"surcharge_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"adjustment_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"refund_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"cost_source" text NOT NULL,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_shipment_kind_check" CHECK ("shipments"."shipment_kind" in ('outbound_sale', 'return_to_vendor', 'transfer', 'replacement', 'other')),
	CONSTRAINT "shipments_cost_source_check" CHECK ("shipments"."cost_source" in ('manual', 'channel_reported', 'carrier_api', 'fee_derived', 'unknown')),
	CONSTRAINT "shipments_fee_derived_link_check" CHECK (("shipments"."cost_source" = 'fee_derived') = ("shipments"."order_fee_id" is not null)),
	CONSTRAINT "shipments_outbound_sale_order_check" CHECK (("shipments"."shipment_kind" = 'outbound_sale') = ("shipments"."order_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "acquisition_costs" ADD CONSTRAINT "acquisition_costs_acquisition_id_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_costs" ADD CONSTRAINT "acquisition_costs_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_costs" ADD CONSTRAINT "acquisition_costs_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_opportunity_links" ADD CONSTRAINT "acquisition_opportunity_links_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_opportunity_links" ADD CONSTRAINT "acq_opportunity_links_acquisition_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_opportunity_links" ADD CONSTRAINT "acq_opportunity_links_inventory_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_opportunity_links" ADD CONSTRAINT "acq_opportunity_links_market_event_fk" FOREIGN KEY ("market_event_id") REFERENCES "public"."market_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_opportunity_links" ADD CONSTRAINT "acq_opportunity_links_marketplace_item_fk" FOREIGN KEY ("marketplace_item_id") REFERENCES "public"."marketplace_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisitions" ADD CONSTRAINT "acquisitions_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisitions" ADD CONSTRAINT "acquisitions_entity_attributed_by_user_id_user_id_fk" FOREIGN KEY ("entity_attributed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisitions" ADD CONSTRAINT "acquisitions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisitions" ADD CONSTRAINT "acquisitions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_acquisition_id_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_entity_attributed_by_user_id_user_id_fk" FOREIGN KEY ("entity_attributed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_origin_item_fk" FOREIGN KEY ("origin_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_parent_fk" FOREIGN KEY ("parent_location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_acquisition_id_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_allocation_fk" FOREIGN KEY ("inventory_allocation_id") REFERENCES "public"."inventory_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_fulfillment_fk" FOREIGN KEY ("order_fulfillment_id") REFERENCES "public"."order_fulfillments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reverses_fk" FOREIGN KEY ("reverses_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_fulfillment_id_order_fulfillments_id_fk" FOREIGN KEY ("order_fulfillment_id") REFERENCES "public"."order_fulfillments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_fee_id_order_fees_id_fk" FOREIGN KEY ("order_fee_id") REFERENCES "public"."order_fees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_origin_location_id_inventory_locations_id_fk" FOREIGN KEY ("origin_location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acquisition_costs_acquisition_id_idx" ON "acquisition_costs" USING btree ("acquisition_id");--> statement-breakpoint
CREATE INDEX "acquisition_costs_inventory_item_id_idx" ON "acquisition_costs" USING btree ("inventory_item_id") WHERE "acquisition_costs"."inventory_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "acq_opportunity_links_acq_event_uq" ON "acquisition_opportunity_links" USING btree ("acquisition_id","market_event_id") WHERE "acquisition_opportunity_links"."acquisition_id" is not null and "acquisition_opportunity_links"."market_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "acq_opportunity_links_item_event_uq" ON "acquisition_opportunity_links" USING btree ("inventory_item_id","market_event_id") WHERE "acquisition_opportunity_links"."inventory_item_id" is not null and "acquisition_opportunity_links"."market_event_id" is not null;--> statement-breakpoint
CREATE INDEX "acq_opportunity_links_market_event_id_idx" ON "acquisition_opportunity_links" USING btree ("market_event_id") WHERE "acquisition_opportunity_links"."market_event_id" is not null;--> statement-breakpoint
CREATE INDEX "acq_opportunity_links_marketplace_item_id_idx" ON "acquisition_opportunity_links" USING btree ("marketplace_item_id") WHERE "acquisition_opportunity_links"."marketplace_item_id" is not null;--> statement-breakpoint
CREATE INDEX "acquisitions_economic_entity_id_acquired_at_idx" ON "acquisitions" USING btree ("economic_entity_id","acquired_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "acquisitions_source_kind_acquired_at_idx" ON "acquisitions" USING btree ("source_kind","acquired_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "acquisitions_open_cost_allocation_idx" ON "acquisitions" USING btree ("cost_allocation_status") WHERE "acquisitions"."cost_allocation_status" <> 'final';--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_allocations_line_item_open_uq" ON "inventory_allocations" USING btree ("order_line_id","inventory_item_id") WHERE "inventory_allocations"."status" in ('reserved', 'fulfilled');--> statement-breakpoint
CREATE INDEX "inventory_allocations_reserved_item_idx" ON "inventory_allocations" USING btree ("inventory_item_id") WHERE "inventory_allocations"."status" = 'reserved';--> statement-breakpoint
CREATE INDEX "inventory_items_acquisition_id_idx" ON "inventory_items" USING btree ("acquisition_id");--> statement-breakpoint
CREATE INDEX "inventory_items_catalog_item_id_idx" ON "inventory_items" USING btree ("catalog_item_id") WHERE "inventory_items"."catalog_item_id" is not null;--> statement-breakpoint
CREATE INDEX "inventory_items_location_id_status_idx" ON "inventory_items" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "inventory_items_economic_entity_id_status_idx" ON "inventory_items" USING btree ("economic_entity_id","status");--> statement-breakpoint
CREATE INDEX "inventory_items_aging_idx" ON "inventory_items" USING btree ("acquired_at") WHERE "inventory_items"."depleted_at" is null;--> statement-breakpoint
CREATE INDEX "inventory_items_unattributed_idx" ON "inventory_items" USING btree ("economic_entity_id") WHERE "inventory_items"."economic_entity_id" is null;--> statement-breakpoint
CREATE INDEX "inventory_locations_parent_location_id_idx" ON "inventory_locations" USING btree ("parent_location_id") WHERE "inventory_locations"."parent_location_id" is not null;--> statement-breakpoint
CREATE INDEX "inventory_locations_path_idx" ON "inventory_locations" USING btree ("path" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "inventory_movements_item_occurred_at_idx" ON "inventory_movements" USING btree ("inventory_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_order_line_id_idx" ON "inventory_movements" USING btree ("order_line_id") WHERE "inventory_movements"."order_line_id" is not null;--> statement-breakpoint
CREATE INDEX "inventory_movements_transfer_group_id_idx" ON "inventory_movements" USING btree ("transfer_group_id") WHERE "inventory_movements"."transfer_group_id" is not null;--> statement-breakpoint
CREATE INDEX "inventory_movements_kind_occurred_at_idx" ON "inventory_movements" USING btree ("movement_kind","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shipment_items_shipment_id_idx" ON "shipment_items" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_items_inventory_item_id_idx" ON "shipment_items" USING btree ("inventory_item_id") WHERE "shipment_items"."inventory_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_order_carrier_tracking_uq" ON "shipments" USING btree ("order_id","carrier_code","tracking_number") WHERE "shipments"."tracking_number" is not null;--> statement-breakpoint
CREATE INDEX "shipments_order_fulfillment_id_idx" ON "shipments" USING btree ("order_fulfillment_id") WHERE "shipments"."order_fulfillment_id" is not null;--> statement-breakpoint
CREATE INDEX "shipments_order_id_idx" ON "shipments" USING btree ("order_id") WHERE "shipments"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "shipments_tracking_number_idx" ON "shipments" USING btree ("tracking_number") WHERE "shipments"."tracking_number" is not null;--> statement-breakpoint
CREATE INDEX "shipments_carrier_code_shipped_at_idx" ON "shipments" USING btree ("carrier_code","shipped_at" DESC NULLS LAST);--> statement-breakpoint
-- PROVISIONAL (design open question 2): append-only enforcement.
--
-- `inventory_movements` is the ledger every other number in Phase 4 is derived
-- from. A rule that lives only in a TypeScript service is a CONVENTION, not an
-- invariant, and every package in this modular monolith can reach this table
-- through the same connection. `REVOKE UPDATE, DELETE` was the alternative and
-- does not work while the application connects as the table owner, so this is a
-- trigger.
--
-- The accepted cost: a migration that genuinely must repair movement data has
-- to DROP this trigger, repair, and RECREATE it in the same migration. That is
-- a feature, not friction — it puts the exception in the diff where a reviewer
-- sees it.
--
-- Corrections are `reversal` rows naming the movement they reverse. There is no
-- other correction path, which is also why this table has no `updated_at`.
CREATE FUNCTION "loxep_inventory_movements_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $loxep_append_only$
BEGIN
	RAISE EXCEPTION
		'inventory_movements is append-only: % is not permitted (record a reversal movement instead)',
		TG_OP
		USING ERRCODE = 'P0001',
		      HINT = 'A migration that must repair ledger data drops this trigger, repairs, and recreates it in the same migration.';
END;
$loxep_append_only$;--> statement-breakpoint
CREATE TRIGGER "inventory_movements_append_only"
BEFORE UPDATE OR DELETE ON "inventory_movements"
FOR EACH ROW EXECUTE FUNCTION "loxep_inventory_movements_append_only"();
