/**
 * Phase 4 inventory and acquisition schema (Inventory and Acquisition domain)
 * plus outbound shipments (Shipping and Fulfillment domain).
 *
 * Physical realization of
 * `apps/docs/src/content/docs/architecture/inventory-schema-design.md`. Nine
 * tables; no existing table gains a column, exactly as that design targets.
 *
 * Conventions are inherited, not reinvented: uuid PKs with `defaultRandom()`,
 * `timestamptz` instants with semantic names, `numeric(20,6)` money AND
 * quantities, state columns as `text` with application-owned TypeScript unions
 * (never PG enums), ADR-0020 user references as nullable `SET NULL` FKs, and no
 * `payload` or free-form attribute `jsonb` column anywhere — raw provider JSON
 * stays at the provenance boundary.
 *
 * Phase 4 uses MORE `CHECK` constraints than Phase 3 did, and the difference is
 * deliberate rather than inconsistent: every closed set here is Loxep-owned.
 * There is no provider inventing inventory states, so a `CHECK` can never fail
 * an ingestion job over a marketplace's Tuesday afternoon.
 *
 * None of these tables is a Timescale hypertable. A movement ledger LOOKS
 * temporal and is not: it is a small set of discrete business facts with
 * foreign keys pointing at it, and hypertable partitioning would buy nothing
 * while costing referential integrity.
 *
 * ## PROVISIONAL DECISIONS
 *
 * This schema was implemented under an explicit owner directive to resolve
 * every open question in the design document per that document's own
 * recommendation, implement it, and mark it PROVISIONAL for review. Each such
 * decision is tagged `PROVISIONAL` at the column or table it affects. The full
 * list lives in the design doc's "Provisional implementation decisions"
 * section. Summary:
 *
 * ```text
 *  1  no per-SKU costing policy column anywhere        (absence)
 *  2  append-only enforced by a BEFORE UPDATE OR       migration 0005 trigger
 *     DELETE trigger that RAISES
 *  3  quantity_on_hand is CACHED on the item,          inventoryItems
 *     single-writer + reconciliation
 *  4  one location_id on the item; a partial move      inventoryItems
 *     is a row split, not a balance table
 *  5  cost basis freezes at first depletion_sale       cost_basis_locked_at
 *  6  shipments are authoritative for postage;         shipments.order_fee_id
 *     order_fees stays the ingested evidence
 *  7  order-scoped fees and shipping pro-rated in      (absence — read model)
 *     the READ MODEL, never stored
 *  8  no FX; mixed-currency contribution is reported   (absence)
 *     as not computable, never converted
 *  9  consignment is an ordinary item with zero basis  source_kind
 *     and an explicit read-model predicate; no
 *     `ownership` column yet
 * 10  non-capitalized acquisition costs are KEPT       acquisitionCosts
 * ```
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { catalogItems, orderFees, orderFulfillments, orderLines, orders } from "./commerce.ts";
import { connections } from "./connections.ts";
import { economicEntities } from "./entities.ts";
import { marketEvents } from "./events.ts";
import { marketplaceItems } from "./monitoring.ts";

/* ------------------------------------------------------------------ unions */

/**
 * `acquisitions.source_kind` — a Loxep-owned CLOSED set, so it gets a `CHECK`.
 *
 * Each value names a genuinely different combination of where cost is known,
 * what ancillary costs attach, and when contents are discovered. It is not
 * decoration: `consignment_intake` and `personal_conversion` are why
 * `inventory_items.acquisition_cost_amount` defaults to zero instead of being
 * `not null` with no default, and `retail_arbitrage` is why `cost_scope`
 * exists at all.
 */
export const ACQUISITION_SOURCE_KINDS = [
  "auction_lot",
  "estate_sale",
  "thrift_retail",
  "retail_arbitrage",
  "liquidation_pallet",
  "wholesale_purchase",
  "online_marketplace",
  "trade_in",
  "consignment_intake",
  "personal_conversion",
  "customer_return",
  "found_stock",
  "other",
] as const;
export type AcquisitionSourceKind = (typeof ACQUISITION_SOURCE_KINDS)[number];

/**
 * `acquisitions.status`. TypeScript union with NO `CHECK`: this is a workflow
 * label likely to grow, and nothing downstream branches on unknown members.
 * `cost_allocation_status` DOES get a `CHECK`, because the cost engine branches
 * on it — that asymmetry is the whole rule.
 */
export const ACQUISITION_STATUSES = [
  "draft",
  "open",
  "receiving",
  "costed",
  "closed",
  "cancelled",
] as const;
export type AcquisitionStatus = (typeof ACQUISITION_STATUSES)[number];

/** `acquisitions.cost_allocation_status` — closed, `CHECK`ed; branched on. */
export const COST_ALLOCATION_STATUSES = [
  "pending",
  "provisional",
  "final",
] as const;
export type CostAllocationStatus = (typeof COST_ALLOCATION_STATUSES)[number];

/** `acquisitions.cost_allocation_basis` — closed, `CHECK`ed. */
export const COST_ALLOCATION_BASES = [
  "equal",
  "relative_value",
  "weight",
  "manual",
  "direct",
] as const;
export type CostAllocationBasis = (typeof COST_ALLOCATION_BASES)[number];

/**
 * `inventory_items.cost_allocation_basis` — the acquisition's five values plus
 * `unallocated`, which is the state of a freshly received item whose lot cost
 * has not been spread yet.
 */
export const ITEM_COST_ALLOCATION_BASES = [
  "unallocated",
  ...COST_ALLOCATION_BASES,
] as const;
export type ItemCostAllocationBasis =
  (typeof ITEM_COST_ALLOCATION_BASES)[number];

/**
 * `acquisitions.entity_attribution_source` — Loxep-owned closed set, `CHECK`ed.
 *
 * Phase 3's three values plus `installation_default`, which earns its place
 * because Phase 4's dominant reality is a single-entity installation whose
 * operator should not retype the same entity four hundred times — and because
 * an entity that arrived by default must stay distinguishable from one a human
 * chose. That distinction is the whole purpose of this column: it is the
 * eligibility marker for bulk re-attribution, which may never rewrite `manual`.
 *
 * `connection_default` is included and currently UNUSED. The ingested-purchase
 * path (eBay purchase history becoming acquisitions) is a foreseeable near-term
 * addition, and widening a `CHECK` on a table that already has rows is a
 * migration nobody should have to write for one string.
 */
export const ACQUISITION_ENTITY_ATTRIBUTION_SOURCES = [
  "manual",
  "installation_default",
  "connection_default",
  "unattributed",
] as const;
export type AcquisitionEntityAttributionSource =
  (typeof ACQUISITION_ENTITY_ATTRIBUTION_SOURCES)[number];

/**
 * `inventory_items.entity_attribution_source` — the acquisition's four values
 * plus `acquisition_default`, the source recorded when an item snapshots the
 * entity of the lot it came out of.
 */
export const ITEM_ENTITY_ATTRIBUTION_SOURCES = [
  "manual",
  "acquisition_default",
  "installation_default",
  "connection_default",
  "unattributed",
] as const;
export type ItemEntityAttributionSource =
  (typeof ITEM_ENTITY_ATTRIBUTION_SOURCES)[number];

/** `acquisition_costs.cost_scope` — closed, `CHECK`ed. The `order_fees` pattern. */
export const COST_SCOPES = ["lot", "item"] as const;
export type CostScope = (typeof COST_SCOPES)[number];

/**
 * `acquisition_costs.cost_class` — closed, `CHECK`ed.
 *
 * Separates the price of the goods from everything spent getting them
 * saleable. Landed cost is the sum of both where `capitalize = true`;
 * `inventory_items.acquisition_cost_amount` is an item's share of `goods`
 * ONLY. Keeping the two separately visible is what makes "the lot cost $250 and
 * I spent another $91 on it" answerable — the number that actually decides
 * whether a sourcing channel is worth repeating.
 */
export const COST_CLASSES = ["goods", "ancillary"] as const;
export type CostClass = (typeof COST_CLASSES)[number];

/**
 * Initial `acquisition_costs.cost_type` values. TypeScript union, **no**
 * `CHECK` — unlike the other closed sets here this one will grow with real
 * sourcing practice, and nothing branches on unknown members.
 */
export const ACQUISITION_COST_TYPES = [
  "goods",
  "buyers_premium",
  "sales_tax",
  "lot_fee",
  "inbound_freight",
  "duty_tariff",
  "fuel_mileage",
  "pickup_hauling",
  "platform_purchase_fee",
  "refurbishment_parts",
  "cleaning_supplies",
  "testing_certification",
  "grading_fee",
  "listing_prep",
  "storage",
  "disposal",
  "other",
] as const;
export type AcquisitionCostType = (typeof ACQUISITION_COST_TYPES)[number];

/**
 * `inventory_items.sale_mode` — Loxep-owned closed set, `CHECK`ed.
 *
 * The declaration the pre-M3 model was missing: the operator saying what a
 * unit IS GOING TO BE before doing it, which listing authoring, pricing, and
 * parted-out reporting all need. `parted_out` is the one member the operator
 * never picks directly — it is written by {@link ItemsService.partOut}, not
 * chosen at intake, and its presence on a row is what makes "which lots did
 * we actually part out, and did it beat listing them whole" answerable.
 *
 * See the design's `sale_mode: how it's sold` section
 * (`flipping-lifecycle-design.md`) for the full argument, including open
 * question 4 (on the item, not the listing) and why a lot with
 * `quantity = 100` and `sale_mode = 'lot'` are two different, compatible
 * facts rather than a duplication.
 */
export const ITEM_SALE_MODES = [
  "unit",
  "lot",
  "set",
  "parts_donor",
  "parted_out",
  "bundle_component",
] as const;
export type ItemSaleMode = (typeof ITEM_SALE_MODES)[number];

/**
 * `media_links.resource_type` value for media attached to an inventory item,
 * and the `purpose` values M3 adds — the M3 sibling of `EXPENSE_RESOURCE_TYPE`/
 * `EXPENSE_MEDIA_PURPOSES` (`expenses.ts`). No new table: migration 0004's
 * `media_links` already attaches an object to any resource by
 * `(resource_type, resource_id, purpose)`.
 *
 * **`purpose` never gains a `'primary'` value.** Primary is
 * `sort_order = 0` — see {@link inventoryItems}'s sibling doc on
 * `inventory_item_specifics` and the design's "Images" section for why: with
 * `purpose` in migration 0004's unique key and `sort_order` deliberately NOT
 * in it, a `primary` purpose would let one photo be both primary and gallery
 * as two rows for one fact, and re-ordering would become a purpose rewrite
 * instead of a `sort_order` update.
 */
export const INVENTORY_ITEM_MEDIA_RESOURCE_TYPE = "inventory_item";
export const INVENTORY_ITEM_MEDIA_PURPOSES = [
  "gallery",
  "condition_evidence",
  "supporting_document",
] as const;
export type InventoryItemMediaPurpose =
  (typeof INVENTORY_ITEM_MEDIA_PURPOSES)[number];

/**
 * `inventory_item_specifics.source` — closed, `CHECK`ed.
 *
 * Distinguishes what a human asserted (`manual`) from what a machine
 * proposed (`parsed`, from a receipt/document parser; `channel_suggested`,
 * from a marketplace's own aspect metadata fetched at authoring time) from a
 * SKU-level default (`catalog_default`) that could one day populate a
 * `catalog_item_specifics` sibling — pre-widened now for the identical reason
 * `connection_default` was pre-widened on `acquisitions.entity_attribution_source`.
 */
export const ITEM_SPECIFIC_SOURCES = [
  "manual",
  "parsed",
  "channel_suggested",
  "catalog_default",
] as const;
export type ItemSpecificSource = (typeof ITEM_SPECIFIC_SOURCES)[number];

/** `inventory_locations.kind` — closed, `CHECK`ed. */
export const LOCATION_KINDS = [
  "site",
  "room",
  "area",
  "shelf",
  "bin",
  "container",
  "vehicle",
  "in_transit",
] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** Maximum `inventory_locations.depth`; a guardrail, not a modeling claim. */
export const MAX_LOCATION_DEPTH = 6;

/**
 * `inventory_items.condition_code` — a Loxep-owned closed set WITH a `CHECK`,
 * and that is the whole point of it.
 *
 * Channel condition vocabularies (eBay's numeric condition ids, Woo's absence
 * of one, a Medusa store's free text) are adapter mapping concerns and must not
 * become the storage vocabulary. Condition drives resale value more than almost
 * anything else about a used good, so a stable internal ladder that reports can
 * group by is worth the constraint.
 */
export const ITEM_CONDITION_CODES = [
  "new_sealed",
  "new_open_box",
  "like_new",
  "very_good",
  "good",
  "acceptable",
  "for_parts",
  "damaged",
  "unknown",
] as const;
export type ItemConditionCode = (typeof ITEM_CONDITION_CODES)[number];

/**
 * `inventory_items.status`. TypeScript union, no `CHECK` (a workflow label).
 *
 * It is a convenience index target, NOT an authority: quantities and movements
 * are the authority, and any disagreement is a reconciliation finding rather
 * than a constraint violation.
 */
export const ITEM_STATUSES = [
  "intake",
  "available",
  "listed",
  "reserved",
  "partially_depleted",
  "depleted",
  "written_off",
  "archived",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Movement kinds that INCREASE on-hand (positive `quantity`). */
export const INBOUND_MOVEMENT_KINDS = [
  "receipt",
  "transfer_in",
  "return_in",
  "adjustment_in",
  "found",
] as const;

/** Movement kinds that DECREASE on-hand (negative `quantity`). */
export const OUTBOUND_MOVEMENT_KINDS = [
  "transfer_out",
  "depletion_sale",
  "adjustment_out",
  "shrinkage",
  "disposal",
  "consumption",
] as const;

/**
 * `inventory_movements.movement_kind` — closed, `CHECK`ed.
 *
 * `reversal` sits outside the sign partition because a reversal's sign follows
 * whatever it reverses. `shrinkage` and `disposal` are separate from
 * `adjustment_out` because they mean different things to a business — an
 * adjustment says the count was wrong, shrinkage says goods were lost, disposal
 * says a decision was made to get rid of them. Collapsing them saves one string
 * and destroys the only signal that a sourcing channel produces unsellable junk.
 */
export const MOVEMENT_KINDS = [
  ...INBOUND_MOVEMENT_KINDS,
  ...OUTBOUND_MOVEMENT_KINDS,
  "reversal",
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** `inventory_allocations.allocation_kind` — closed, `CHECK`ed. */
export const ALLOCATION_KINDS = [
  "order_line",
  "manual_hold",
  "transfer",
  "project",
] as const;
export type AllocationKind = (typeof ALLOCATION_KINDS)[number];

/** `inventory_allocations.status` — closed, `CHECK`ed. */
export const ALLOCATION_STATUSES = [
  "reserved",
  "fulfilled",
  "released",
  "cancelled",
  "expired",
] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

/** Allocation statuses that hold stock; the partial unique's predicate. */
export const OPEN_ALLOCATION_STATUSES = ["reserved", "fulfilled"] as const;

/** `shipments.shipment_kind` — closed, `CHECK`ed. */
export const SHIPMENT_KINDS = [
  "outbound_sale",
  "return_to_vendor",
  "transfer",
  "replacement",
  "other",
] as const;
export type ShipmentKind = (typeof SHIPMENT_KINDS)[number];

/**
 * `shipments.cost_source` — closed, `CHECK`ed, and load-bearing: the
 * `fee_derived` member is tied by a `CHECK` to `order_fee_id` so the
 * double-count guard cannot be half-recorded.
 */
export const SHIPMENT_COST_SOURCES = [
  "manual",
  "channel_reported",
  "carrier_api",
  "fee_derived",
  "unknown",
] as const;
export type ShipmentCostSource = (typeof SHIPMENT_COST_SOURCES)[number];

/** `shipments.status`. TypeScript union, no `CHECK` (a workflow label). */
export const SHIPMENT_STATUSES = [
  "draft",
  "label_purchased",
  "shipped",
  "in_transit",
  "delivered",
  "cancelled",
  "unknown",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/**
 * `acquisition_opportunity_links.link_kind` — closed, `CHECK`ed.
 *
 * `sourced_from` means the observation drove the purchase; `evaluated_against`
 * means we priced our decision using it; `comparable` means it is a reference
 * point found later. Collapsing them would make the eventual "did our
 * opportunity scoring actually work" study meaningless, because two thirds of
 * the links would not be claims about causation at all.
 */
export const OPPORTUNITY_LINK_KINDS = [
  "sourced_from",
  "evaluated_against",
  "comparable",
] as const;
export type OpportunityLinkKind = (typeof OPPORTUNITY_LINK_KINDS)[number];

/* ------------------------------------------------------------ acquisitions */

/**
 * One purchase, lot, haul, or intake event — the moment goods became ours.
 *
 * Acquisition is not Purchasing. Purchasing owns intent and obligation to a
 * vendor before goods exist; a reseller buying a box at an estate auction has
 * no purchase order, no vendor master record, and no payable, because the money
 * left at the same instant the goods arrived. A real Purchasing domain later
 * ATTACHES to this table (a nullable `vendor_id`, backfilled by matching)
 * rather than replacing it — the identical treatment Phase 3 gave
 * `buyer_external_id`.
 *
 * ## No money columns except `currency`, and that is deliberate
 *
 * This is the exact inverse of the Phase 3 rule on `orders`, and the inversion
 * has a reason. On `orders`, amounts are PROVIDER-REPORTED facts that must be
 * stored verbatim because an external authority asserted them, and a mismatch
 * against the lines is evidence. On an acquisition Loxep is the ONLY authority:
 * every number came from an operator typing components into
 * `acquisition_costs`. Storing a total alongside them would create two sources
 * for one number with no external arbiter, and the only possible outcome of a
 * disagreement is that one of them is a bug. Landed cost is a `sum()` over a
 * handful of rows on a table with hundreds of rows per year.
 *
 * ## Attribution
 *
 * `economic_entity_id` is a STORED snapshot, resolved once at creation through
 * the documented precedence ladder (manual → installation default → connection
 * default → unattributed) and never a read-time join. ADR-0017 holds: this adds
 * no authorization semantics, and there is no `accounting_book_id` in Phase 4.
 */
export const acquisitions = pgTable(
  "acquisitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),
    entityAttributionSource: text("entity_attribution_source").notNull(),
    entityAttributedAt: timestamp("entity_attributed_at", {
      withTimezone: true,
    }),
    // ADR-0020: nullable SET NULL FK to the Better Auth user id.
    entityAttributedByUserId: text("entity_attributed_by_user_id").references(
      () => user.id,
      { onDelete: "set null" },
    ),
    sourceKind: text("source_kind").notNull(),
    status: text("status").notNull(),
    /**
     * A short human/scannable identifier (`ACQ-2026-0184`) generated by the
     * domain service. Resellers label boxes; a UUID is not a label. Unique
     * installation-wide for the same reason `catalog_items.sku` is.
     */
    referenceCode: text("reference_code").notNull(),
    title: text("title").notNull(),
    /**
     * Denormalized text, DELIBERATELY. A vendor record is a
     * Purchasing/Counterparty concept, and creating a party master row for
     * "Goodwill on Route 9" is a data-hygiene liability, not an asset.
     */
    vendorName: text("vendor_name"),
    vendorLocation: text("vendor_location"),
    externalReference: text("external_reference"),
    /**
     * Nullable and normally null. It exists for the foreseeable path where a
     * marketplace purchase is INGESTED from a connection rather than typed. An
     * acquisition is valid with no connection, forever.
     */
    connectionId: uuid("connection_id").references(() => connections.id),
    /** One currency per acquisition; costs carry their own (GBP lot, USD freight). */
    currency: char("currency", { length: 3 }).notNull(),
    costAllocationBasis: text("cost_allocation_basis").notNull(),
    costAllocationStatus: text("cost_allocation_status").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /**
     * The operator's estimate at intake ("about 40 things in this box"), used
     * to surface a lot that was opened and never finished unpacking. It is not
     * a constraint on anything.
     */
    expectedItemCount: integer("expected_item_count"),
    notes: text("notes"),
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
    unique("acquisitions_reference_code_uq").on(table.referenceCode),
    check(
      "acquisitions_entity_attribution_source_check",
      sql`${table.entityAttributionSource} in ('manual', 'installation_default', 'connection_default', 'unattributed')`,
    ),
    check(
      "acquisitions_source_kind_check",
      sql`${table.sourceKind} in ('auction_lot', 'estate_sale', 'thrift_retail', 'retail_arbitrage', 'liquidation_pallet', 'wholesale_purchase', 'online_marketplace', 'trade_in', 'consignment_intake', 'personal_conversion', 'customer_return', 'found_stock', 'other')`,
    ),
    check(
      "acquisitions_cost_allocation_basis_check",
      sql`${table.costAllocationBasis} in ('equal', 'relative_value', 'weight', 'manual', 'direct')`,
    ),
    check(
      "acquisitions_cost_allocation_status_check",
      sql`${table.costAllocationStatus} in ('pending', 'provisional', 'final')`,
    ),
    index("acquisitions_economic_entity_id_acquired_at_idx").on(
      table.economicEntityId,
      table.acquiredAt.desc(),
    ),
    // Sourcing channel performance.
    index("acquisitions_source_kind_acquired_at_idx").on(
      table.sourceKind,
      table.acquiredAt.desc(),
    ),
    // Open-lot backlog: partial, and small precisely because of the predicate.
    index("acquisitions_open_cost_allocation_idx")
      .on(table.costAllocationStatus)
      .where(sql`${table.costAllocationStatus} <> 'final'`),
    /**
     * Purchase-ingestion idempotency (flipping-lifecycle-design.md section
     * 2a, loxep-k5p). Partial so the many hand-entered acquisitions with
     * neither column are unaffected; unique because unlike a cross-connection
     * order duplicate, this key is not adapter-guessed — it is the connection
     * Loxep chose and the id the provider assigned, always available
     * together for a connector-sourced purchase. Lets
     * `@loxep/inventory`'s `ingestEbayPurchase` rely on `ON CONFLICT` instead
     * of a look-then-insert race against concurrent syncs of the same
     * connection.
     */
    uniqueIndex("acquisitions_connection_external_ref_uq")
      .on(table.connectionId, table.externalReference)
      .where(
        sql`${table.connectionId} is not null and ${table.externalReference} is not null`,
      ),
  ],
);

/**
 * Every money component of an acquisition, at lot or item scope.
 *
 * Mirrors `order_fees` deliberately, including the scope constraint, because
 * the shape of the problem is the same: amounts arrive at the granularity the
 * world produced them, and allocation to a finer grain is a derived decision.
 *
 * PROVISIONAL (design open question 10): `capitalize = false` rows are KEPT.
 * They record a cost genuinely incurred that the operator does not want in
 * basis — mileage tracked for a different deduction, storage rent, a tool
 * bought once. They stay attached as operational evidence and are excluded from
 * landed cost. Phase 5's expense model will consume them; Phase 4 does not
 * decide their accounting treatment, it only refuses to silently capitalize
 * them. The risk to watch is a UI showing "total spend" including them next to
 * a "landed cost" excluding them with neither labelled — that is a UI
 * discipline problem, called out here rather than solved with a column.
 *
 * **Sign convention: positive is money spent.** Credits — a coupon, cashback, a
 * partial refund from the seller, proceeds from scrapping the unsellable third
 * of a pallet — are NEGATIVE rows of the appropriate type. Same polarity as
 * `order_fees`, opposite to `order_refunds`.
 */
export const acquisitionCosts = pgTable(
  "acquisition_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    acquisitionId: uuid("acquisition_id")
      .notNull()
      .references(() => acquisitions.id, { onDelete: "cascade" }),
    inventoryItemId: uuid("inventory_item_id").references(
      (): AnyPgColumn => inventoryItems.id,
      { onDelete: "cascade" },
    ),
    costScope: text("cost_scope").notNull(),
    costType: text("cost_type").notNull(),
    costClass: text("cost_class").notNull(),
    capitalize: boolean("capitalize").notNull().default(true),
    description: text("description"),
    vendorName: text("vendor_name"),
    externalReference: text("external_reference"),
    currency: char("currency", { length: 3 }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    incurredAt: timestamp("incurred_at", { withTimezone: true }),
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
      "acquisition_costs_cost_scope_check",
      sql`${table.costScope} in ('lot', 'item')`,
    ),
    // The order_fees.fee_scope consistency pattern: allocation queries filter
    // on scope constantly and should not depend on a null test.
    check(
      "acquisition_costs_scope_item_check",
      sql`(${table.costScope} = 'item') = (${table.inventoryItemId} is not null)`,
    ),
    check(
      "acquisition_costs_cost_class_check",
      sql`${table.costClass} in ('goods', 'ancillary')`,
    ),
    index("acquisition_costs_acquisition_id_idx").on(table.acquisitionId),
    index("acquisition_costs_inventory_item_id_idx")
      .on(table.inventoryItemId)
      .where(sql`${table.inventoryItemId} is not null`),
  ],
);

/* --------------------------------------------------------------- locations */

/**
 * A simple tree of physical places. NOT a warehouse management system.
 *
 * `unique nulls not distinct (parent_location_id, name)` requires PostgreSQL
 * 15+, which the `timescale/timescaledb-ha:pg18.4-ts2.29.2-all` target provides. Without
 * it every root-level location could be created twice, since PostgreSQL treats
 * each null parent as distinct — the identical trap `channel_listings`
 * documented for `external_variation_id`.
 *
 * **Cycles are not preventable by a `CHECK`.** The self-reference constraint
 * stops only the one-node case; a parent-of-my-ancestor cycle needs a recursive
 * walk. Per the design's recommendation that is a SERVICE-level check plus an
 * integrity test, with the depth cap making an accidental cycle self-limiting
 * in the meantime.
 *
 * **Disposition is not a location.** "Sold", "discarded", "returned to vendor"
 * are movement kinds and item statuses, never locations. Making them locations
 * is the classic error that turns every on-hand query into an exercise in
 * remembering which locations are real. `in_transit` is the one virtual kind
 * that earns its place: goods genuinely are somewhere-not-here between a
 * transfer_out and a transfer_in.
 *
 * No `economic_entity_id`. A shelf does not belong to an LLC; the stock on it
 * does, and two entities' goods routinely share one bin in a spare bedroom.
 */
export const inventoryLocations = pgTable(
  "inventory_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentLocationId: uuid("parent_location_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /**
     * Slash-joined ancestor codes (`HOME/GARAGE/SHELF-3/BIN-12`), maintained by
     * the domain service on insert and re-parent, so "everything under the
     * garage" is a prefix scan instead of a recursive CTE in every read path.
     * It is a CACHE; the tree is the truth and a mismatch is a reconciliation
     * finding.
     */
    path: text("path").notNull(),
    depth: integer("depth").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Named explicitly: the derived name would exceed PostgreSQL's 63-byte
    // identifier limit and be silently truncated.
    foreignKey({
      name: "inventory_locations_parent_fk",
      columns: [table.parentLocationId],
      foreignColumns: [table.id],
    }),
    unique("inventory_locations_code_uq").on(table.code),
    unique("inventory_locations_parent_name_uq")
      .on(table.parentLocationId, table.name)
      .nullsNotDistinct(),
    check(
      "inventory_locations_kind_check",
      sql`${table.kind} in ('site', 'room', 'area', 'shelf', 'bin', 'container', 'vehicle', 'in_transit')`,
    ),
    check(
      "inventory_locations_self_parent_check",
      sql`${table.parentLocationId} is distinct from ${table.id}`,
    ),
    check(
      "inventory_locations_depth_check",
      sql`${table.depth} >= 0 and ${table.depth} <= 6`,
    ),
    index("inventory_locations_parent_location_id_idx")
      .on(table.parentLocationId)
      .where(sql`${table.parentLocationId} is not null`),
    // `LIKE 'HOME/GARAGE/%'` will not use a default B-tree index under a
    // non-C collation, and subtree queries are the main reason `path` exists.
    index("inventory_locations_path_idx").using(
      "btree",
      sql`${table.path} text_pattern_ops`,
    ),
  ],
);

/* ---------------------------------------------------------- inventory items */

/**
 * The stock row. For the one-of-a-kind goods that dominate resale, one row is
 * one physical thing.
 *
 * ## Cost basis: specific identification, with no cost-layer table
 *
 * `acquisition_cost_amount` and `landed_cost_amount` live directly here. There
 * is no `inventory_cost_layers`, no `cost_layer_consumptions`, and no running
 * average maintained anywhere — because an item row ALREADY IS a cost layer in
 * every respect that matters: a quantity, acquired at one moment, from one lot,
 * at one unit cost, in one condition, at one location. Commodity stock is a
 * single row with `quantity = 100`; next month's case is a second row. That is
 * a layer stack expressed in the table that already exists.
 *
 * The costing METHOD is therefore decided at allocation time by what the
 * allocation identifies (a specific row → specific identification; a catalog
 * item + quantity → the picker takes oldest `acquired_at` first = FIFO), and it
 * needs no schema at all. The exit path from specific identification to any
 * other method is NO MIGRATION, which is the strongest possible form of "not
 * closing the door".
 *
 * PROVISIONAL (design open question 1): no `costing_method` column exists here
 * or on `catalog_items`.
 *
 * ## `quantity` versus `quantity_on_hand`
 *
 * `quantity` is how much this row was created holding and NEVER changes; it is
 * what makes the row a cost layer. `quantity_on_hand` is the current balance.
 *
 * PROVISIONAL (design open question 3): `quantity_on_hand` is a CACHE,
 * maintained in the same transaction as every movement by a SINGLE writer
 * (`@loxep/inventory`'s movement service), with a reconciliation function that
 * compares it against `sum(inventory_movements.quantity)` and reports drift.
 * The truth is the ledger; the cache exists because that sum is on the hot path
 * of every listing and allocation check while the ledger only grows. Revisit if
 * reconciliation ever finds drift in normal operation — that is a concrete
 * trigger, not a vague "later".
 *
 * **No `CHECK (quantity_on_hand >= 0)`.** Negative on-hand is a real event: the
 * same one-of-a-kind item sells on eBay and on the Woo store within the same
 * minute. Blocking the second depletion at the database would fail an ingestion
 * job over a business problem the operator must resolve in the physical world
 * anyway. Oversell is surfaced loudly as an exception. Operational facts before
 * accounting.
 *
 * **No `quantity_reserved` cache**, deliberately asymmetric. Reservations are
 * few, short-lived, and live in a small indexed table that shrinks; movements
 * accumulate forever. Available-to-sell is `quantity_on_hand − (indexed sum
 * over open allocations)`, and one cache is one thing that can drift instead of
 * two.
 *
 * ## Attribution is duplicated here on purpose
 *
 * Phase 3 declined to duplicate the entity column onto `order_lines`; Phase 4
 * duplicates it onto items, because an item can exist with no acquisition
 * (opening balances, found stock, personal conversions, restocked returns), one
 * lot can legitimately split across entities, and stock is a HELD asset that
 * changes hands. Attribution is IMMUTABLE: moving stock from personal ownership
 * to an LLC does not `UPDATE` this column, it writes a paired transfer against
 * a NEW row (see {@link inventoryMovements}).
 *
 * PROVISIONAL (design open question 4): one `location_id` column, and a partial
 * move is a row split. An `inventory_item_locations` balance table is purely
 * additive if commodity stock ever becomes a real part of the workload.
 *
 * PROVISIONAL (design open question 9): consignment goods are ordinary rows
 * with zero basis and `source_kind = 'consignment_intake'` on their
 * acquisition. There is no `ownership` column yet; the read models exclude them
 * by an EXPLICIT predicate rather than by the accident of a zero.
 *
 * ## M3: six nullable/defaulted enrichment columns (loxep-dgf.3)
 *
 * `description`, `sale_mode`, `package_weight_grams`, and
 * `package_{length,width,height}_mm` — the ONE deliberate exception to Phase
 * 4's "no existing table gains a column" rule. The justification, verbatim
 * from the design: that rule's forward-looking test is "every arrow into a
 * future phase is a reference added later, not a rewrite of these tables",
 * and six nullable/defaulted columns rewrite nothing — every existing row
 * stays valid, every existing query stays correct, every existing constraint
 * is unchanged. A 1:1 `inventory_item_details` side table was considered and
 * rejected: a table whose parent is always joined is a table only in the
 * sense that it has a name, and dimensions/weight are Inventory facts about a
 * physical thing exactly as `shipments` already speaks grams and
 * millimetres.
 *
 * `package_*` is named for the PACKED PARCEL, not the bare item — an operator
 * weighing something for a listing weighs it on a shipping scale, which is
 * the number a channel asks for and a rate quote needs. `shipments` continues
 * to record what the actual outbound package weighed, a different fact about
 * a different object.
 *
 * `num_nonnulls(length, width, height) in (0, 3)` refuses a half-entered box:
 * two of three dimensions is not partial information, it is an error that
 * would silently produce a wrong rate quote.
 */
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The scannable label (`ITM-8F2K4`) that gets printed and stuck to a bin. */
    itemCode: text("item_code").notNull(),
    acquisitionId: uuid("acquisition_id").references(() => acquisitions.id),
    catalogItemId: uuid("catalog_item_id").references(() => catalogItems.id),
    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),
    entityAttributionSource: text("entity_attribution_source").notNull(),
    entityAttributedAt: timestamp("entity_attributed_at", {
      withTimezone: true,
    }),
    entityAttributedByUserId: text("entity_attributed_by_user_id").references(
      () => user.id,
      { onDelete: "set null" },
    ),
    locationId: uuid("location_id").references(() => inventoryLocations.id),
    /** Splits, partial transfers, and entity transfers, with one column. */
    originItemId: uuid("origin_item_id"),
    /**
     * `not null` while `catalog_item_id` is nullable, in that order
     * deliberately: resale intake is "a brass lamp, no idea what it is yet"
     * long before it is a SKU, and requiring a catalog item at intake would
     * push operators into creating junk SKUs.
     */
    label: text("label").notNull(),
    lotReference: text("lot_reference"),
    serialNumber: text("serial_number"),
    status: text("status").notNull(),
    conditionCode: text("condition_code").notNull(),
    conditionNotes: text("condition_notes"),
    /** PSA, CGC, BGS, WATA, NGC, PCGS, … free text, no `CHECK`. */
    gradingAuthority: text("grading_authority"),
    /**
     * The authority's own string (`PSA 9`, `CGC 9.8`, `VG+`), retained verbatim
     * alongside {@link grade_numeric} because half-grades, qualifiers, and
     * authority-specific scales do not survive a lossy numeric conversion — and
     * the label is what a buyer searches for.
     */
    gradeLabel: text("grade_label"),
    gradeNumeric: numeric("grade_numeric", { precision: 4, scale: 1 }),
    certificateNumber: text("certificate_number"),
    quantity: numeric("quantity", { precision: 20, scale: 6 })
      .notNull()
      .default("1"),
    quantityOnHand: numeric("quantity_on_hand", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    /** One currency per item, snapshotted from its acquisition. No FX. */
    currency: char("currency", { length: 3 }).notNull(),
    /** This item's share of the lot's `goods`-class capitalized costs. */
    acquisitionCostAmount: numeric("acquisition_cost_amount", {
      precision: 20,
      scale: 6,
    })
      .notNull()
      .default("0"),
    /** Goods plus ancillary: the full capitalized basis. */
    landedCostAmount: numeric("landed_cost_amount", {
      precision: 20,
      scale: 6,
    })
      .notNull()
      .default("0"),
    costAllocationBasis: text("cost_allocation_basis")
      .notNull()
      .default("unallocated"),
    costAllocationWeight: numeric("cost_allocation_weight", {
      precision: 20,
      scale: 6,
    }),
    /**
     * PROVISIONAL (design open question 5): basis FREEZES at the first
     * `depletion_sale` movement. Until then, re-allocation across an open lot
     * is allowed and expected — you cannot allocate a $250 lot across forty
     * items until you have found the fortieth. After the first sale the basis
     * has fed a realized-profitability figure and will feed a Phase 5 posting,
     * and rewriting it would retroactively change reported margin on a closed
     * sale. A lot discovered mis-costed after a sale gets an explicit, audited
     * per-item basis correction, never a silent lot re-run.
     */
    costBasisLockedAt: timestamp("cost_basis_locked_at", {
      withTimezone: true,
    }),
    /**
     * The operator's TARGET RESALE PRICE. It is the input to `relative_value`
     * cost allocation and it is **not a valuation** — it must never be summed
     * into a balance-sheet figure, and any read model that sums it must be
     * named so it cannot be mistaken for one.
     */
    estimatedValueAmount: numeric("estimated_value_amount", {
      precision: 20,
      scale: 6,
    }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    listedAt: timestamp("listed_at", { withTimezone: true }),
    depletedAt: timestamp("depleted_at", { withTimezone: true }),
    /** Plain text or Markdown, the internal authoring source of truth. NOT listing HTML — see the design's "Description" section. */
    description: text("description"),
    /** How the unit is going to be sold. Closed, Loxep-owned; see {@link ITEM_SALE_MODES}. */
    saleMode: text("sale_mode").notNull().default("unit"),
    /** The PACKED PARCEL's weight, in grams — same units `shipments` already uses. */
    packageWeightGrams: numeric("package_weight_grams", {
      precision: 20,
      scale: 6,
    }),
    packageLengthMm: numeric("package_length_mm", { precision: 20, scale: 6 }),
    packageWidthMm: numeric("package_width_mm", { precision: 20, scale: 6 }),
    packageHeightMm: numeric("package_height_mm", { precision: 20, scale: 6 }),
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
    foreignKey({
      name: "inventory_items_origin_item_fk",
      columns: [table.originItemId],
      foreignColumns: [table.id],
    }),
    unique("inventory_items_item_code_uq").on(table.itemCode),
    check("inventory_items_quantity_check", sql`${table.quantity} > 0`),
    check(
      "inventory_items_entity_attribution_source_check",
      sql`${table.entityAttributionSource} in ('manual', 'acquisition_default', 'installation_default', 'connection_default', 'unattributed')`,
    ),
    check(
      "inventory_items_cost_allocation_basis_check",
      sql`${table.costAllocationBasis} in ('unallocated', 'equal', 'relative_value', 'weight', 'manual', 'direct')`,
    ),
    check(
      "inventory_items_condition_code_check",
      sql`${table.conditionCode} in ('new_sealed', 'new_open_box', 'like_new', 'very_good', 'good', 'acceptable', 'for_parts', 'damaged', 'unknown')`,
    ),
    check(
      "inventory_items_grade_authority_check",
      sql`(${table.gradeLabel} is null) or (${table.gradingAuthority} is not null)`,
    ),
    check(
      "inventory_items_sale_mode_check",
      sql`${table.saleMode} in ('unit', 'lot', 'set', 'parts_donor', 'parted_out', 'bundle_component')`,
    ),
    check(
      "inventory_items_package_weight_check",
      sql`${table.packageWeightGrams} is null or ${table.packageWeightGrams} > 0`,
    ),
    // A half-entered box is an error, not partial information.
    check(
      "inventory_items_package_dimensions_check",
      sql`num_nonnulls(${table.packageLengthMm}, ${table.packageWidthMm}, ${table.packageHeightMm}) in (0, 3)`,
    ),
    // Lot unpack and cost allocation.
    index("inventory_items_acquisition_id_idx").on(table.acquisitionId),
    index("inventory_items_catalog_item_id_idx")
      .on(table.catalogItemId)
      .where(sql`${table.catalogItemId} is not null`),
    // "What is on this shelf".
    index("inventory_items_location_id_status_idx").on(
      table.locationId,
      table.status,
    ),
    index("inventory_items_economic_entity_id_status_idx").on(
      table.economicEntityId,
      table.status,
    ),
    // Aging: partial, because only on-hand stock ages.
    index("inventory_items_aging_idx")
      .on(table.acquiredAt)
      .where(sql`${table.depletedAt} is null`),
    // Attribution backlog: partial, tiny.
    index("inventory_items_unattributed_idx")
      .on(table.economicEntityId)
      .where(sql`${table.economicEntityId} is null`),
  ],
);

/* ---------------------------------------------------------------- specifics */

/**
 * Typed key/value product specifics attached to a physical unit (M3,
 * loxep-dgf.3) — eBay-style aspects (`Brand: Nikon`, `Shutter Count: 4,200`),
 * captured without Loxep ever owning a category/aspect taxonomy.
 *
 * ## Why typed values and not category templates
 *
 * A Loxep-owned taxonomy (which aspect names apply to "Film Cameras", which
 * values are allowed, per marketplace) was rejected: eBay publishes that
 * metadata itself and it is fetchable at authoring time
 * (`sell.metadata.getItemAspectsForCategory`), a mirrored copy would go stale
 * silently, and eBay aspects / Woo attributes / Facebook Marketplace's fixed
 * fields are three genuinely different systems that a universal template
 * would paper over. The adapter fetches the channel's own metadata when the
 * operator is authoring for that channel and category; this table stores
 * only what the operator (or a parser, or a channel suggestion) actually
 * asserted about THIS unit.
 *
 * ## Multi-value falls out of the key, not a `text[]` column
 *
 * eBay aspects are `name -> string[]`; a two-value aspect is two rows sharing
 * a `name`, ordered by `sort_order`. A `text[]` column was considered and
 * rejected: "every item where Brand = Nikon" would become a containment query
 * against an unindexed array where the relational form is a plain index
 * lookup, and it edges toward the free-form attribute bag this documentation
 * refuses everywhere else.
 *
 * `unique(inventory_item_id, name, value)` — asserting the identical fact
 * twice adds nothing, and this is also the `ON CONFLICT` target an
 * at-least-once writer needs (the `media_links` precedent, migration 0004).
 *
 * ## `value` is the truth; `value_numeric` is a shadow
 *
 * `value_numeric` is populated ONLY when `value` parses cleanly as a number,
 * and nothing is derived from it — it exists purely so "shutter count under
 * 5,000" is an indexed range scan instead of a cast in every `WHERE` clause.
 * The verbatim string survives alongside it because "9.8", "PSA 9.8", and
 * "9.8 (qualified)" are three different claims — the same argument that kept
 * `inventory_items.grade_label` alongside `grade_numeric`. Exactly one
 * service (`@loxep/inventory/specifics.ts`) writes this table, which is what
 * keeps the shadow from drifting — the same single-writer argument that makes
 * `quantity_on_hand` safe.
 *
 * ## Attaches to the ITEM, not the catalog item
 *
 * `inventory_items.catalog_item_id` is nullable and usually unresolved at
 * intake (Phase 4 argued at length against requiring a SKU there). Attaching
 * specifics to the physical unit means an unidentified brass lamp can
 * accumulate "Material: Brass", "Height: 14 in" before anyone decides what it
 * is. `source = 'catalog_default'` is pre-widened into the `CHECK` now for a
 * possible future `catalog_item_specifics` sibling, the same pre-widening
 * `acquisitions.entity_attribution_source` did for `connection_default`.
 */
export const inventoryItemSpecifics = pgTable(
  "inventory_item_specifics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    name: text("name").notNull(),
    value: text("value").notNull(),
    /** Shadow of `value`, populated only on a clean numeric parse. Nothing derives from it. */
    valueNumeric: numeric("value_numeric", { precision: 20, scale: 6 }),
    unit: text("unit"),
    sortOrder: integer("sort_order").notNull().default(0),
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Named explicitly: the derived FK name
    // (`inventory_item_specifics_inventory_item_id_inventory_items_id_fk`,
    // 64 bytes) exceeds PostgreSQL's 63-byte identifier limit and would be
    // silently truncated.
    foreignKey({
      name: "inventory_item_specifics_item_fk",
      columns: [table.inventoryItemId],
      foreignColumns: [inventoryItems.id],
    }).onDelete("cascade"),
    unique("inventory_item_specifics_item_name_value_uq").on(
      table.inventoryItemId,
      table.name,
      table.value,
    ),
    check(
      "inventory_item_specifics_source_check",
      sql`${table.source} in ('manual', 'parsed', 'channel_suggested', 'catalog_default')`,
    ),
    index("inventory_item_specifics_item_id_idx").on(table.inventoryItemId),
    // "every item where Brand = Nikon" — the relational form the design
    // rejected a `text[]` column to keep.
    index("inventory_item_specifics_name_value_idx").on(
      table.name,
      table.value,
    ),
  ],
);

/* ------------------------------------------------------------- allocations */

/**
 * Reservations of stock against Phase 3 `order_lines` and other holds.
 *
 * ## Allocation is NOT a movement
 *
 * A reservation does not move stock and writes NOTHING to
 * `inventory_movements`. This is a rule, not an implementation detail: the
 * ledger records what happened, and a reservation is an INTENTION that may be
 * released, expired, or cancelled without anything ever having physically
 * occurred. Putting reservations in the ledger would fill an append-only record
 * of facts with events that turned out not to be events, and would make on-hand
 * and available-to-sell the same number when their whole purpose is to differ.
 *
 * ```text
 * quantity_on_hand    sum(inventory_movements.quantity)   — cached on the item
 * quantity_reserved   sum(open inventory_allocations)     — computed, never cached
 * available_to_sell   on_hand − reserved
 * ```
 *
 * The partial unique makes the reservation path idempotent: a retried
 * allocation job cannot reserve the same item for the same line twice, while a
 * RELEASED reservation does not block a later legitimate one.
 */
export const inventoryAllocations = pgTable(
  "inventory_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inventoryItemId: uuid("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id),
    allocationKind: text("allocation_kind").notNull(),
    orderLineId: uuid("order_line_id").references(() => orderLines.id),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    status: text("status").notNull(),
    allocatedAt: timestamp("allocated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * A `manual_hold` nobody ever releases is how available-to-sell quietly
     * becomes wrong. A sweeper expires stale holds; order-line allocations do
     * not expire.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
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
    uniqueIndex("inventory_allocations_line_item_open_uq")
      .on(table.orderLineId, table.inventoryItemId)
      .where(sql`${table.status} in ('reserved', 'fulfilled')`),
    check("inventory_allocations_quantity_check", sql`${table.quantity} > 0`),
    check(
      "inventory_allocations_kind_check",
      sql`${table.allocationKind} in ('order_line', 'manual_hold', 'transfer', 'project')`,
    ),
    // The order_fees.fee_scope pattern for the third time in this design: the
    // right shape whenever a nullable reference and a discriminator must agree.
    check(
      "inventory_allocations_kind_reference_check",
      sql`(${table.allocationKind} = 'order_line') = (${table.orderLineId} is not null)`,
    ),
    check(
      "inventory_allocations_status_check",
      sql`${table.status} in ('reserved', 'fulfilled', 'released', 'cancelled', 'expired')`,
    ),
    // The available-to-sell probe: partial, tiny.
    index("inventory_allocations_reserved_item_idx")
      .on(table.inventoryItemId)
      .where(sql`${table.status} = 'reserved'`),
  ],
);

/* ---------------------------------------------------------------- shipments */

/**
 * Outbound carrier reality: packages, labels, dimensions, and ACTUAL postage.
 *
 * The Phase 3 design made an explicit promise that this table honors literally:
 *
 * ```text
 * order_fulfillments                    shipments
 * ----------------------------------    ----------------------------------
 * what the CHANNEL reported             what the CARRIER and we actually did
 * Commerce-owned, ingested              Shipping-owned, entered or fetched
 * no money                              actual postage, insurance, surcharges
 * exists only for channel sales         exists for transfers and vendor returns
 * one row per provider fulfillment      zero or more per fulfillment
 * ```
 *
 * PROVISIONAL (design open question 6): **`order_fee_id` is the double-counting
 * guard, and it is load-bearing.** When a label is bought through the
 * marketplace the same money appears twice in Loxep — once as an `order_fees`
 * row with `fee_type = 'shipping_label_charge'` and once as `postage_amount`.
 * The rule: the profitability read model counts outbound shipping from
 * `shipments` ONLY, and excludes any `order_fees` row referenced by a
 * shipment's `order_fee_id`. Deleting or suppressing the fee row would be
 * wrong — it is a provider-reported fact and Phase 3 owns it. The `CHECK` ties
 * `cost_source = 'fee_derived'` to the link so the case cannot be
 * half-recorded, and a reconciliation report flags `shipping_label_charge` fees
 * with no referencing shipment (the residual risk: an operator who forgot the
 * link double-counts silently).
 *
 * `adjustment_amount` is not an afterthought: carrier post-audit reweigh
 * charges arriving four days after the label was bought are one of the most
 * reliably underestimated costs in resale, and a schema with no home for them
 * produces margins that are quietly optimistic forever. Net outbound cost is
 * `postage + insurance + surcharge + adjustment − refund`.
 *
 * Tracking uniqueness is scoped to the ORDER because carriers reuse tracking
 * numbers after roughly a year, and a global unique on a recycled string would
 * reject a legitimate shipment eighteen months later.
 */
export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentKind: text("shipment_kind").notNull(),
    orderId: uuid("order_id").references(() => orders.id),
    orderFulfillmentId: uuid("order_fulfillment_id").references(
      () => orderFulfillments.id,
    ),
    /** The double-count guard. See the table doc. */
    orderFeeId: uuid("order_fee_id").references(() => orderFees.id),
    status: text("status").notNull(),
    carrierCode: text("carrier_code"),
    carrierName: text("carrier_name"),
    serviceCode: text("service_code"),
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),
    labelExternalId: text("label_external_id"),
    packageCount: integer("package_count").notNull().default(1),
    weightGrams: numeric("weight_grams", { precision: 20, scale: 6 }),
    lengthMm: numeric("length_mm", { precision: 20, scale: 6 }),
    widthMm: numeric("width_mm", { precision: 20, scale: 6 }),
    heightMm: numeric("height_mm", { precision: 20, scale: 6 }),
    originLocationId: uuid("origin_location_id").references(
      () => inventoryLocations.id,
    ),
    /** The same "no address normalization before Phase 6" line Phase 3 drew. */
    destinationCountry: char("destination_country", { length: 2 }),
    destinationRegion: text("destination_region"),
    currency: char("currency", { length: 3 }),
    postageAmount: numeric("postage_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    insuranceAmount: numeric("insurance_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    surchargeAmount: numeric("surcharge_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    /** Accumulates; positive is an additional charge (carrier reweigh). */
    adjustmentAmount: numeric("adjustment_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    /** Positive for money returned (an unused label refunded). */
    refundAmount: numeric("refund_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    costSource: text("cost_source").notNull(),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
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
    uniqueIndex("shipments_order_carrier_tracking_uq")
      .on(table.orderId, table.carrierCode, table.trackingNumber)
      .where(sql`${table.trackingNumber} is not null`),
    check(
      "shipments_shipment_kind_check",
      sql`${table.shipmentKind} in ('outbound_sale', 'return_to_vendor', 'transfer', 'replacement', 'other')`,
    ),
    check(
      "shipments_cost_source_check",
      sql`${table.costSource} in ('manual', 'channel_reported', 'carrier_api', 'fee_derived', 'unknown')`,
    ),
    check(
      "shipments_fee_derived_link_check",
      sql`(${table.costSource} = 'fee_derived') = (${table.orderFeeId} is not null)`,
    ),
    check(
      "shipments_outbound_sale_order_check",
      sql`(${table.shipmentKind} = 'outbound_sale') = (${table.orderId} is not null)`,
    ),
    index("shipments_order_fulfillment_id_idx")
      .on(table.orderFulfillmentId)
      .where(sql`${table.orderFulfillmentId} is not null`),
    index("shipments_order_id_idx")
      .on(table.orderId)
      .where(sql`${table.orderId} is not null`),
    index("shipments_tracking_number_idx")
      .on(table.trackingNumber)
      .where(sql`${table.trackingNumber} is not null`),
    index("shipments_carrier_code_shipped_at_idx").on(
      table.carrierCode,
      table.shippedAt.desc(),
    ),
  ],
);

/**
 * What was in the box.
 *
 * A surrogate primary key rather than a composite, because both references are
 * nullable and one shipment can legitimately contain the same item twice under
 * different lines. This is the table that makes per-item shipping cost
 * allocation possible at all: without it, a two-item package has one postage
 * figure and no defensible way to split it.
 *
 * PROVISIONAL sharpening of the draft's `unique(shipment_id,
 * inventory_item_id, order_line_id)`: it is declared `NULLS NOT DISTINCT`. Both
 * references are nullable, and under PostgreSQL's default null handling the
 * constraint would silently permit the same (shipment, item, no line) row
 * twice — which is exactly the duplicate it exists to prevent. The design's
 * "same item twice under different lines" case is unaffected, because those
 * rows differ in `order_line_id`.
 */
export const shipmentItems = pgTable(
  "shipment_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    inventoryItemId: uuid("inventory_item_id").references(
      () => inventoryItems.id,
    ),
    orderLineId: uuid("order_line_id").references(() => orderLines.id),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("shipment_items_shipment_item_line_uq")
      .on(table.shipmentId, table.inventoryItemId, table.orderLineId)
      .nullsNotDistinct(),
    check("shipment_items_quantity_check", sql`${table.quantity} > 0`),
    check(
      "shipment_items_one_reference_check",
      sql`num_nonnulls(${table.inventoryItemId}, ${table.orderLineId}) >= 1`,
    ),
    index("shipment_items_shipment_id_idx").on(table.shipmentId),
    index("shipment_items_inventory_item_id_idx")
      .on(table.inventoryItemId)
      .where(sql`${table.inventoryItemId} is not null`),
  ],
);

/* --------------------------------------------------------------- movements */

/**
 * The append-only ledger. Everything that ever happened to stock is a row here,
 * and nothing that happened to stock is anywhere else.
 *
 * ## Append-only means append-only
 *
 * No `UPDATE`. No `DELETE`. **No `updated_at` column — its absence is the
 * design statement.** Corrections are `reversal` rows naming the movement they
 * reverse.
 *
 * PROVISIONAL (design open question 2): enforcement is a real
 * `BEFORE UPDATE OR DELETE` trigger that RAISES, created in migration 0005,
 * because an invariant that lives only in TypeScript is a convention and every
 * other package in this monolith can reach this table. The cost is that a
 * legitimate data repair must drop and recreate the trigger inside a
 * migration — which is a FEATURE, since it makes the exception visible in
 * review. `REVOKE UPDATE, DELETE` was the alternative and does not work while
 * the application connects as the table owner.
 *
 * ## Signed quantity, one location per row
 *
 * `quantity` is SIGNED: positive increases on-hand, negative decreases it. The
 * alternative — a positive magnitude plus a kind that implies direction —
 * requires a `CASE` over `movement_kind` in every balance query, which is
 * exactly the bug factory a ledger exists to eliminate. On-hand is
 * `sum(quantity)`. Nothing else.
 *
 * There is ONE `location_id`, not a from/to pair, and that follows directly:
 * with from/to, the balance AT a location stops being a sum and becomes a sum
 * minus a sum conditioned on kind, which breaks the moment one side is null.
 * **A transfer is therefore two rows** — `transfer_out` (negative, at the
 * source) and `transfer_in` (positive, at the destination) — sharing a
 * `transfer_group_id`. Partial transfers fall out naturally by pointing the two
 * halves at two item rows, and the basis carried by a split is visible on the
 * new row instead of implied. An ENTITY transfer is the same mechanism: the
 * receiving half lands on a new item row owned by the receiving entity, so
 * `inventory_items.economic_entity_id` is never rewritten.
 *
 * ## Idempotency
 *
 * `deduplication_key text not null unique` reuses the `market_events`
 * mechanism verbatim, for the identical reason: Graphile Worker is
 * at-least-once and a fulfillment handler that runs twice must not deplete
 * twice. Keys are deterministic and computed from the CAUSING FACT, never from
 * a timestamp or a random value:
 *
 * ```text
 * receipt          acq:<acquisition_id>:item:<inventory_item_id>
 * depletion_sale   ffl:<order_fulfillment_id>:<order_line_id>:alloc:<allocation_id>
 * return_in        rfl:<order_refund_line_id>:item:<inventory_item_id>
 * transfer_*       xfer:<transfer_group_id>:<in|out>
 * adjustment_*     adj:<count_session_or_ulid>:item:<inventory_item_id>
 * reversal         rev:<reverses_movement_id>
 * ```
 *
 * `occurred_at` is when the physical thing happened (an operator may backdate
 * it); `recorded_at` is when Loxep learned of it and is never backdated. Both
 * are needed because a count done on Saturday and entered on Monday is two
 * different facts, and only one of them is what "stock on hand as of Sunday"
 * should use.
 */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inventoryItemId: uuid("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id),
    movementKind: text("movement_kind").notNull(),
    /** SIGNED. On-hand is `sum(quantity)`; nothing else. */
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    locationId: uuid("location_id").references(() => inventoryLocations.id),
    transferGroupId: uuid("transfer_group_id"),
    acquisitionId: uuid("acquisition_id").references(() => acquisitions.id),
    inventoryAllocationId: uuid("inventory_allocation_id"),
    orderLineId: uuid("order_line_id").references(() => orderLines.id),
    orderFulfillmentId: uuid("order_fulfillment_id"),
    shipmentId: uuid("shipment_id").references(() => shipments.id),
    reversesMovementId: uuid("reverses_movement_id"),
    reasonCode: text("reason_code"),
    note: text("note"),
    deduplicationKey: text("deduplication_key").notNull(),
    /** When the physical thing happened; an operator may backdate this. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** When Loxep learned of it. Never backdated. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // NO updated_at. Its absence is the design statement.
  },
  (table) => [
    // Named explicitly: every derived name below would exceed PostgreSQL's
    // 63-byte identifier limit and be silently truncated.
    foreignKey({
      name: "inventory_movements_allocation_fk",
      columns: [table.inventoryAllocationId],
      foreignColumns: [inventoryAllocations.id],
    }),
    foreignKey({
      name: "inventory_movements_fulfillment_fk",
      columns: [table.orderFulfillmentId],
      foreignColumns: [orderFulfillments.id],
    }),
    foreignKey({
      name: "inventory_movements_reverses_fk",
      columns: [table.reversesMovementId],
      foreignColumns: [table.id],
    }),
    // The retry probe; the constraint IS the index.
    unique("inventory_movements_deduplication_key_uq").on(
      table.deduplicationKey,
    ),
    check("inventory_movements_quantity_check", sql`${table.quantity} <> 0`),
    check(
      "inventory_movements_kind_check",
      sql`${table.movementKind} in ('receipt', 'transfer_in', 'return_in', 'adjustment_in', 'found', 'transfer_out', 'depletion_sale', 'adjustment_out', 'shrinkage', 'disposal', 'consumption', 'reversal')`,
    ),
    // Sign tied to kind, with `reversal` excluded from the partition because a
    // reversal's sign follows whatever it reverses.
    check(
      "inventory_movements_sign_check",
      sql`${table.movementKind} = 'reversal' or ((${table.movementKind} in ('receipt', 'transfer_in', 'return_in', 'adjustment_in', 'found')) = (${table.quantity} > 0))`,
    ),
    check(
      "inventory_movements_transfer_group_check",
      sql`(${table.transferGroupId} is not null) = (${table.movementKind} in ('transfer_in', 'transfer_out'))`,
    ),
    check(
      "inventory_movements_reversal_check",
      sql`(${table.reversesMovementId} is not null) = (${table.movementKind} = 'reversal')`,
    ),
    // Balance and item history.
    index("inventory_movements_item_occurred_at_idx").on(
      table.inventoryItemId,
      table.occurredAt,
    ),
    index("inventory_movements_order_line_id_idx")
      .on(table.orderLineId)
      .where(sql`${table.orderLineId} is not null`),
    index("inventory_movements_transfer_group_id_idx")
      .on(table.transferGroupId)
      .where(sql`${table.transferGroupId} is not null`),
    index("inventory_movements_kind_occurred_at_idx").on(
      table.movementKind,
      table.occurredAt.desc(),
    ),
  ],
);

/* ---------------------------------------------- opportunity-to-outcome link */

/**
 * The lightweight bridge from a scored market opportunity to the acquisition it
 * caused and the outcome it produced — the record that "this observation is why
 * we bought that box".
 *
 * The design decisions that matter here are all about RESTRAINT:
 *
 * - **The score is snapshotted, not joined.** `score_at_link` and
 *   `target_price_amount` freeze what we believed at the moment of the
 *   decision. Opportunity rules are mutable configuration; editing a rule's
 *   weight next month must not retroactively rewrite how good last month's
 *   decision looked. Same argument as stored entity attribution, different
 *   mutable input.
 * - **`opportunity_rule_id` is a plain `uuid` with NO foreign key**, exactly
 *   matching the `market_events.rule_id` precedent and for the identical stated
 *   reason: it is a historical attribution stamp, and deleting a rule must
 *   never block, cascade into, or rewrite recorded history.
 * - **This is a linkage table, not analytics.** No aggregates, no
 *   predicted-versus-actual columns, no model state, no recomputed scores. The
 *   correlation study is a Reporting concern that joins this table to the
 *   realized-contribution read model, and it is not scheduled in any phase.
 *
 * Both `num_nonnulls` constraints use `>=` rather than `=`, unlike
 * `order_source_links`, because naming both the acquisition and the specific
 * item — or both the event and the item it was about — is ADDITIONAL
 * INFORMATION rather than ambiguity.
 */
export const acquisitionOpportunityLinks = pgTable(
  "acquisition_opportunity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    linkKind: text("link_kind").notNull(),
    acquisitionId: uuid("acquisition_id"),
    inventoryItemId: uuid("inventory_item_id"),
    marketEventId: uuid("market_event_id"),
    marketplaceItemId: uuid("marketplace_item_id"),
    /** An unenforced historical stamp; see the table doc. */
    opportunityRuleId: uuid("opportunity_rule_id"),
    scoreAtLink: numeric("score_at_link", { precision: 10, scale: 4 }),
    targetCurrency: char("target_currency", { length: 3 }),
    targetPriceAmount: numeric("target_price_amount", {
      precision: 20,
      scale: 6,
    }),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    linkedByUserId: text("linked_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // All four named explicitly: the derived names would exceed PostgreSQL's
    // 63-byte identifier limit and be silently truncated.
    foreignKey({
      name: "acq_opportunity_links_acquisition_fk",
      columns: [table.acquisitionId],
      foreignColumns: [acquisitions.id],
    }),
    foreignKey({
      name: "acq_opportunity_links_inventory_item_fk",
      columns: [table.inventoryItemId],
      foreignColumns: [inventoryItems.id],
    }),
    foreignKey({
      name: "acq_opportunity_links_market_event_fk",
      columns: [table.marketEventId],
      foreignColumns: [marketEvents.id],
    }),
    foreignKey({
      name: "acq_opportunity_links_marketplace_item_fk",
      columns: [table.marketplaceItemId],
      foreignColumns: [marketplaceItems.id],
    }),
    check(
      "acq_opportunity_links_kind_check",
      sql`${table.linkKind} in ('sourced_from', 'evaluated_against', 'comparable')`,
    ),
    check(
      "acq_opportunity_links_subject_check",
      sql`num_nonnulls(${table.acquisitionId}, ${table.inventoryItemId}) >= 1`,
    ),
    check(
      "acq_opportunity_links_evidence_check",
      sql`num_nonnulls(${table.marketEventId}, ${table.marketplaceItemId}) >= 1`,
    ),
    uniqueIndex("acq_opportunity_links_acq_event_uq")
      .on(table.acquisitionId, table.marketEventId)
      .where(
        sql`${table.acquisitionId} is not null and ${table.marketEventId} is not null`,
      ),
    uniqueIndex("acq_opportunity_links_item_event_uq")
      .on(table.inventoryItemId, table.marketEventId)
      .where(
        sql`${table.inventoryItemId} is not null and ${table.marketEventId} is not null`,
      ),
    index("acq_opportunity_links_market_event_id_idx")
      .on(table.marketEventId)
      .where(sql`${table.marketEventId} is not null`),
    index("acq_opportunity_links_marketplace_item_id_idx")
      .on(table.marketplaceItemId)
      .where(sql`${table.marketplaceItemId} is not null`),
  ],
);
