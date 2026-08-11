/**
 * Phase 3 commerce schema — orders and their attachments (Commerce domain)
 * plus catalog items and channel listings (Catalog and Listings domain).
 *
 * Physical realization of
 * `apps/docs/src/content/docs/architecture/commerce-schema-design.md`. Ten
 * tables; no existing table gains a column, exactly as that design targets.
 *
 * Conventions are inherited, not reinvented: uuid PKs with `defaultRandom()`,
 * `timestamptz` instants with semantic names, `numeric(20,6)` money, state
 * columns as `text` with application-owned TypeScript unions (never PG enums),
 * `CHECK` only for genuinely closed Loxep-owned sets, ADR-0020 user references
 * as nullable `SET NULL` FKs, and no `payload`/attribute `jsonb` anywhere —
 * anything Phase 3 declines to normalize stays recoverable from
 * `source_events` / `provider_objects`.
 *
 * None of these tables is a Timescale hypertable. A sale is a record, not a
 * sample.
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
 * 1. fees at reported granularity only (`fee_scope` + nullable
 *    `order_line_id`), never allocated at ingest — plus a new
 *    `fee_direction` column the WooCommerce reality findings forced;
 * 2. cross-connection duplicate orders are DETECTED, not constrained
 *    (`source_account_key` + detection index + `duplicate_of_order_id`);
 * 3. fulfillments with per-line quantities, and the fulfillment-state unions
 *    gain `unknown`;
 * 4. no FX conversion and no base-currency columns; views group by currency;
 * 5. no `order_status_events` table;
 * 6. order-sync scheduling reuses `monitor_targets` (see @loxep/commerce);
 * 7. `catalog_items.sku` is unique installation-wide;
 * 8. buyer identity is `buyer_external_id` + display name only; payload
 *    retention policy remains an open POLICY question and no retention logic
 *    exists here.
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { connections } from "./connections.ts";
import { economicEntities } from "./entities.ts";
import { marketplaceItems } from "./monitoring.ts";
import { providerObjects, sourceEvents } from "./provenance.ts";

/* ------------------------------------------------------------------ unions */

/**
 * `orders.status`. TypeScript union with NO database `CHECK`: providers are
 * free to invent states and an ingestion job must never fail a constraint
 * because a marketplace shipped a new status on a Tuesday.
 */
export const ORDER_STATUSES = [
  "pending",
  "open",
  "completed",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** `orders.payment_status`. Provider-extensible; no `CHECK`. */
export const ORDER_PAYMENT_STATUSES = [
  "unpaid",
  "partially_paid",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

/**
 * `orders.fulfillment_status`. Provider-extensible; no `CHECK`.
 *
 * PROVISIONAL (design open question 3 / WooCommerce reality finding): the
 * draft's four members gain `unknown`. WooCommerce's `refunded` status
 * REPLACES the previous status, so a fully refunded order no longer says
 * whether it shipped — the adapter previously had to degrade that to
 * `unfulfilled`, which asserts a fact nobody observed. `unknown` says "the
 * provider stopped telling us", which is the truth.
 */
export const ORDER_FULFILLMENT_STATUSES = [
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
  "cancelled",
  "unknown",
] as const;
export type OrderFulfillmentStatus =
  (typeof ORDER_FULFILLMENT_STATUSES)[number];

/**
 * `orders.entity_attribution_source` — a Loxep-owned CLOSED set, so it does
 * get a `CHECK`. Its purpose is not description: it is the eligibility marker
 * for bulk re-attribution (`manual` rows may never be rewritten).
 */
export const ENTITY_ATTRIBUTION_SOURCES = [
  "manual",
  "connection_default",
  "unattributed",
] as const;
export type EntityAttributionSource =
  (typeof ENTITY_ATTRIBUTION_SOURCES)[number];

/** `order_fees.fee_scope` — Loxep-owned closed set, `CHECK`ed. */
export const FEE_SCOPES = ["order", "line"] as const;
export type FeeScope = (typeof FEE_SCOPES)[number];

/**
 * `order_fees.fee_direction` — Loxep-owned closed set, `CHECK`ed.
 *
 * PROVISIONAL, and NOT in the design draft. The WooCommerce reality finding
 * forced it: the draft's `order_fees` means "an amount the provider charges
 * the SELLER" (positive = a deduction from proceeds), but a WooCommerce
 * `fee_line` is the opposite — a surcharge the merchant adds to the BUYER's
 * cart (handling, small-order, COD, gift wrap) that is already inside
 * `orders.total`. Woo core reports no seller-side fees at all.
 *
 * Rather than invert signs (which silently corrupts every fee report) or drop
 * the rows (which loses a real fact), the semantic is made explicit:
 *
 * ```text
 * seller_charge     charged by the platform TO the seller; a deduction from
 *                   proceeds. Positive = charged, negative = credit/rebate.
 *                   This is the draft's original meaning.
 * buyer_surcharge   charged by the seller TO the buyer, already included in
 *                   orders.total. NOT a deduction from proceeds and MUST NOT
 *                   be subtracted in a contribution calculation.
 * ```
 *
 * WooCommerce `fee_lines` ingest as `buyer_surcharge`. Every profitability
 * read model filters on `fee_direction = 'seller_charge'`.
 */
export const FEE_DIRECTIONS = ["seller_charge", "buyer_surcharge"] as const;
export type FeeDirection = (typeof FEE_DIRECTIONS)[number];

/**
 * Initial `order_fees.fee_type` values. TypeScript union, no `CHECK` —
 * providers invent fee categories, and `provider_fee_code` retains the
 * provider's own code so a fee mapped to `other` is still analyzable.
 *
 * `buyer_surcharge` is PROVISIONAL and pairs with
 * `fee_direction = 'buyer_surcharge'` (see {@link FEE_DIRECTIONS}).
 */
export const FEE_TYPES = [
  "marketplace_final_value",
  "marketplace_insertion",
  "marketplace_regulatory_operating",
  "payment_processing",
  "promoted_listing_ad",
  "international",
  "shipping_label_charge",
  "buyer_surcharge",
  "other",
] as const;
export type FeeType = (typeof FEE_TYPES)[number];

/** `order_refunds.kind`. Provider-extensible; no `CHECK`. */
export const REFUND_KINDS = [
  "refund",
  "partial_refund",
  "cancellation",
  "adjustment",
] as const;
export type RefundKind = (typeof REFUND_KINDS)[number];

/** `order_refunds.status`. Provider-extensible; no `CHECK`. */
export const REFUND_STATUSES = ["pending", "completed", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * `order_fulfillments.status` — what the CHANNEL said about one shipment.
 * Provider-extensible; no `CHECK`. `unknown` carries the same PROVISIONAL
 * meaning as in {@link ORDER_FULFILLMENT_STATUSES}: the provider reported a
 * fulfillment without a state we can read.
 */
export const FULFILLMENT_RECORD_STATUSES = [
  "pending",
  "shipped",
  "delivered",
  "cancelled",
  "unknown",
] as const;
export type FulfillmentRecordStatus =
  (typeof FULFILLMENT_RECORD_STATUSES)[number];

/** `order_source_links.effect` — Loxep-owned closed set, `CHECK`ed. */
export const ORDER_SOURCE_LINK_EFFECTS = [
  "created",
  "updated",
  "unchanged",
] as const;
export type OrderSourceLinkEffect =
  (typeof ORDER_SOURCE_LINK_EFFECTS)[number];

/** `catalog_items.kind` — Loxep-owned closed set, `CHECK`ed. */
export const CATALOG_ITEM_KINDS = [
  "simple",
  "variant_group",
  "variant",
] as const;
export type CatalogItemKind = (typeof CATALOG_ITEM_KINDS)[number];

/** `catalog_items.status`. Loxep-owned but open to workflow growth; no `CHECK`. */
export const CATALOG_ITEM_STATUSES = ["draft", "active", "archived"] as const;
export type CatalogItemStatus = (typeof CATALOG_ITEM_STATUSES)[number];

/** `channel_listings.status`. Provider-extensible; no `CHECK`. */
export const CHANNEL_LISTING_STATUSES = [
  "draft",
  "active",
  "ended",
  "sold_out",
  "unknown",
] as const;
export type ChannelListingStatus = (typeof CHANNEL_LISTING_STATUSES)[number];

/* ---------------------------------------------------------- catalog items */

/**
 * Loxep's internal SKU identity, independent of any provider listing. A
 * catalog item can exist before it is ever listed or sold.
 *
 * PROVISIONAL (design open question 7): `unique(sku)` is INSTALLATION-WIDE,
 * not `(economic_entity_id, sku)`. Two operating identities using one SKU
 * string for different goods produces silently wrong profitability, and the
 * per-entity variant drags in a nasty null-entity case. Widening later is
 * additive.
 *
 * Variants are `catalog_items` rows pointing at a `variant_group` parent with
 * a free-text `variant_label`. There is deliberately no option/axis model —
 * see the design doc for the (additive) exit path.
 *
 * No cost column. `default_price` is a reference SALE price, a catalog
 * attribute; cost basis is Phase 4 and belongs with acquisitions.
 */
export const catalogItems = pgTable(
  "catalog_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    /**
     * A catalog item may belong to an operating identity before it has ever
     * been sold. An order LINE never takes attribution from here — the same
     * SKU may be sold by two operating identities.
     */
    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),
    parentCatalogItemId: uuid("parent_catalog_item_id").references(
      (): AnyPgColumn => catalogItems.id,
    ),
    variantLabel: text("variant_label"),
    description: text("description"),
    conditionCode: text("condition_code"),
    defaultCurrency: char("default_currency", { length: 3 }),
    defaultPrice: numeric("default_price", { precision: 20, scale: 6 }),
    // ADR-0020: nullable SET NULL FK to the Better Auth user id.
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
    unique("catalog_items_sku_uq").on(table.sku),
    check(
      "catalog_items_kind_check",
      sql`${table.kind} in ('simple', 'variant_group', 'variant')`,
    ),
    check(
      "catalog_items_variant_parent_check",
      sql`(${table.kind} = 'variant') = (${table.parentCatalogItemId} is not null)`,
    ),
    index("catalog_items_parent_catalog_item_id_idx")
      .on(table.parentCatalogItemId)
      .where(sql`${table.parentCatalogItemId} is not null`),
  ],
);

/* -------------------------------------------------------- channel listings */

/**
 * An OWNED publication of a catalog item to one channel through one
 * connection.
 *
 * Not to be collapsed with `marketplace_items`, which is an OBSERVED PUBLIC
 * listing possibly belonging to someone else. The keys are structurally
 * incompatible on purpose: `marketplace_items` has no connection in its key so
 * two observers converge on one row; `channel_listings` has one so two
 * publishers stay distinct. `marketplace_item_id` is the nullable,
 * opportunistic link between them.
 *
 * The unique constraint needs `NULLS NOT DISTINCT` (PostgreSQL 15+; the
 * deployment target is `timescale/timescaledb:2.29.1-pg18`). Without it every
 * re-sync of a non-variant listing would insert a duplicate, because each null
 * `external_variation_id` counts as distinct.
 */
export const channelListings = pgTable(
  "channel_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    catalogItemId: uuid("catalog_item_id")
      .notNull()
      .references(() => catalogItems.id),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    provider: text("provider").notNull(),
    channel: text("channel").notNull(),
    marketplace: text("marketplace"),
    externalListingId: text("external_listing_id").notNull(),
    externalVariationId: text("external_variation_id"),
    /** Opportunistic link to the observed public fact; never a precondition. */
    marketplaceItemId: uuid("marketplace_item_id").references(
      () => marketplaceItems.id,
    ),
    status: text("status").notNull(),
    listingUrl: text("listing_url"),
    listingTitle: text("listing_title"),
    currency: char("currency", { length: 3 }),
    price: numeric("price", { precision: 20, scale: 6 }),
    /** `integer` here, mirroring the provider's own integer field. */
    quantityAvailable: integer("quantity_available"),
    listedAt: timestamp("listed_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    firstIngestedAt: timestamp("first_ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("channel_listings_connection_listing_variation_uq")
      .on(
        table.connectionId,
        table.provider,
        table.externalListingId,
        table.externalVariationId,
      )
      .nullsNotDistinct(),
    index("channel_listings_catalog_item_id_idx").on(table.catalogItemId),
    index("channel_listings_connection_id_status_idx").on(
      table.connectionId,
      table.status,
    ),
    index("channel_listings_marketplace_item_id_idx")
      .on(table.marketplaceItemId)
      .where(sql`${table.marketplaceItemId} is not null`),
  ],
);

/* ------------------------------------------------------------------ orders */

/**
 * One normalized sale per provider order, per connection.
 *
 * ## Attribution
 *
 * `economic_entity_id` is a STORED column, written once at first
 * normalization, never a read-time join through `connections`. Connections are
 * mutable configuration; orders are history, and re-attributing a connection
 * must not silently rewrite the economic ownership of already-reported sales.
 * `entity_attribution_source` records how the value got there and is the
 * eligibility marker for bulk re-attribution.
 *
 * ## Identity and duplicates
 *
 * The upsert key is `unique(connection_id, provider, external_order_id)` —
 * connection-scoped, because a WooCommerce order id is a per-store integer and
 * a global key would collide on the first day a second Woo store is connected.
 *
 * PROVISIONAL (design open question 2): two connections authorized against the
 * same seller account legitimately fetch the same order, and this key produces
 * two rows. That is DETECTED, not constrained: `source_account_key` is an
 * ordinary adapter-computed fact, a non-unique index makes cross-connection
 * duplicates findable, and `duplicate_of_order_id` lets an operator mark the
 * non-canonical row. Reporting excludes marked rows; the evidence is never
 * deleted. A wrong constraint fails ingestion; a wrong report is fixable.
 *
 * ## Amounts
 *
 * Provider-reported facts, deliberately unconstrained: there is no `CHECK`
 * that `total_amount` equals lines plus shipping plus tax minus discounts,
 * because providers round and aggregate differently and a constraint would
 * convert a rounding difference into a failed ingestion.
 *
 * PROVISIONAL (WooCommerce reality finding): `subtotal_amount` stays
 * `not null` and is DERIVED where a provider reports no order-level subtotal —
 * WooCommerce reports none at all. The derivation is an EXACT scaled-integer
 * sum of line subtotals (never floating point), performed at the integration
 * boundary; its provenance is documented on `WooOrderTotals.subtotal`. Nullable
 * was the alternative and was rejected because every reader would then have to
 * re-derive it anyway.
 *
 * Sign convention: every amount here is stored POSITIVE as reported.
 * `fee_amount` and `refunded_amount` are magnitudes of deductions, not
 * negatives. Net proceeds are computed, never stored.
 *
 * PROVISIONAL (design open question 4): there is no FX. One currency per
 * order, no `base_currency_amount`, no stored rate. Every read model groups by
 * currency and never sums across them.
 *
 * PROVISIONAL (design open question 8): buyer identity is a channel-native
 * reference only — `buyer_external_id` plus an optional display name. No
 * email, phone, or address column exists or may be added before Phase 6 owns a
 * counterparty model. The full buyer payload stays in `provider_objects`, and
 * whether THAT needs an order-specific retention policy is an unresolved
 * POLICY question; no retention logic is implemented anywhere in Phase 3.
 *
 * PROVISIONAL (design open question 5): there is no `order_status_events`
 * table. Current-state columns only; transitions are reconstructable from
 * `order_source_links` plus retained snapshots.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `not null`: Phase 3 ingestion is the only way an order can arrive. */
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    /** Adapter family: `ebay`, `woocommerce`, `medusa`. */
    provider: text("provider").notNull(),
    /** The selling surface as Loxep names it for cross-channel reporting. */
    channel: text("channel").notNull(),
    /** The provider's sub-market where one exists (`EBAY_US`); null otherwise. */
    marketplace: text("marketplace"),
    /**
     * Adapter-computed provider account scope (`woocommerce:<siteUrl>`,
     * `ebay:<sellerId>`). An ordinary fact, NOT a constraint — see the table
     * doc's duplicate-detection note.
     */
    sourceAccountKey: text("source_account_key").notNull(),
    externalOrderId: text("external_order_id").notNull(),
    externalOrderNumber: text("external_order_number"),
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
    status: text("status").notNull(),
    paymentStatus: text("payment_status").notNull(),
    fulfillmentStatus: text("fulfillment_status").notNull(),
    /** The provider's own status string, verbatim: diagnosable evidence. */
    providerStatusRaw: text("provider_status_raw"),
    currency: char("currency", { length: 3 }).notNull(),
    subtotalAmount: numeric("subtotal_amount", {
      precision: 20,
      scale: 6,
    }).notNull(),
    shippingAmount: numeric("shipping_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    discountAmount: numeric("discount_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    feeAmount: numeric("fee_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    refundedAmount: numeric("refunded_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    totalAmount: numeric("total_amount", {
      precision: 20,
      scale: 6,
    }).notNull(),
    buyerExternalId: text("buyer_external_id"),
    buyerDisplayName: text("buyer_display_name"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    /** Incremental-sync watermark. */
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    duplicateOfOrderId: uuid("duplicate_of_order_id").references(
      (): AnyPgColumn => orders.id,
    ),
    firstIngestedAt: timestamp("first_ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The upsert probe itself; the constraint IS the index.
    unique("orders_connection_provider_external_order_uq").on(
      table.connectionId,
      table.provider,
      table.externalOrderId,
    ),
    check(
      "orders_entity_attribution_source_check",
      sql`${table.entityAttributionSource} in ('manual', 'connection_default', 'unattributed')`,
    ),
    // Ingestion path: "what changed since" for incremental sync.
    index("orders_connection_id_provider_updated_at_idx").on(
      table.connectionId,
      table.providerUpdatedAt.desc(),
    ),
    // Reporting path.
    index("orders_economic_entity_id_placed_at_idx").on(
      table.economicEntityId,
      table.placedAt.desc(),
    ),
    index("orders_channel_placed_at_idx").on(
      table.channel,
      table.placedAt.desc(),
    ),
    index("orders_placed_at_idx").on(table.placedAt.desc()),
    // Attribution backlog: partial, tiny.
    index("orders_unattributed_idx")
      .on(table.economicEntityId)
      .where(sql`${table.economicEntityId} is null`),
    // PROVISIONAL: cross-connection duplicate detection (non-unique on purpose).
    index("orders_provider_source_account_external_order_idx").on(
      table.provider,
      table.sourceAccountKey,
      table.externalOrderId,
    ),
  ],
);

/**
 * What was sold.
 *
 * All three item references are nullable and OPPORTUNISTIC. A line is a
 * complete, valid fact with none of them resolved, and none may ever be a
 * precondition for ingesting it. `marketplace_item_id` is the Commerce ↔
 * Market Intelligence join.
 *
 * `quantity` is `numeric(20,6)`, not `integer`: WooCommerce supports
 * fractional quantities via extensions and Phase 4 inventory will handle goods
 * sold by weight or length. This deliberately diverges from
 * `marketplace_item_observations.quantity_available`, which is `integer`
 * because it records a provider's own integer field.
 *
 * No `fee_amount` column: per-line fee allocation is a DERIVED number and does
 * not belong in a source-fact table (design open question 1).
 */
export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    /** Stable provider line identity where one exists; positional otherwise. */
    externalLineId: text("external_line_id"),
    catalogItemId: uuid("catalog_item_id").references(() => catalogItems.id),
    channelListingId: uuid("channel_listing_id").references(
      () => channelListings.id,
    ),
    marketplaceItemId: uuid("marketplace_item_id").references(
      () => marketplaceItems.id,
    ),
    externalItemId: text("external_item_id"),
    externalVariationId: text("external_variation_id"),
    /** Evidence for the catalog match, and the input to re-matching. */
    channelSku: text("channel_sku"),
    title: text("title"),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 20, scale: 6 }).notNull(),
    lineSubtotal: numeric("line_subtotal", {
      precision: 20,
      scale: 6,
    }).notNull(),
    discountAmount: numeric("discount_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    shippingAmount: numeric("shipping_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    refundedAmount: numeric("refunded_amount", { precision: 20, scale: 6 })
      .notNull()
      .default("0"),
    lineTotal: numeric("line_total", { precision: 20, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("order_lines_order_id_line_number_uq").on(
      table.orderId,
      table.lineNumber,
    ),
    uniqueIndex("order_lines_order_id_external_line_id_uq")
      .on(table.orderId, table.externalLineId)
      .where(sql`${table.externalLineId} is not null`),
    check("order_lines_quantity_check", sql`${table.quantity} > 0`),
    index("order_lines_catalog_item_id_idx")
      .on(table.catalogItemId)
      .where(sql`${table.catalogItemId} is not null`),
    index("order_lines_channel_listing_id_idx")
      .on(table.channelListingId)
      .where(sql`${table.channelListingId} is not null`),
    index("order_lines_marketplace_item_id_idx")
      .on(table.marketplaceItemId)
      .where(sql`${table.marketplaceItemId} is not null`),
  ],
);

/**
 * Fees the provider reports AGAINST A SPECIFIC ORDER. Fees that arrive only at
 * payout or statement level are Phase 5 and have no home here.
 *
 * PROVISIONAL (design open question 1): fees are stored at exactly the
 * granularity the provider reports and are NEVER synthesized or allocated at
 * ingest. One order-level final value fee is one row with
 * `fee_scope = 'order'`. Allocation to lines is a reporting decision that
 * belongs with cost basis in Phase 4, where it can share an allocation basis
 * with COGS. Allocating at ingest bakes a reversible choice into a source-fact
 * table.
 *
 * PROVISIONAL: `fee_direction` — see {@link FEE_DIRECTIONS} for why it exists
 * and why WooCommerce forced it.
 *
 * Sign convention within `seller_charge`: positive means an amount charged to
 * the seller; credits, rebates, and fee refunds are negative. This is the
 * OPPOSITE polarity from `order_refunds.amount`, which is positive for money
 * returned to the buyer — two different flows, deliberately not merged.
 */
export const orderFees = pgTable(
  "order_fees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id").references(() => orderLines.id, {
      onDelete: "cascade",
    }),
    feeScope: text("fee_scope").notNull(),
    feeDirection: text("fee_direction").notNull(),
    feeType: text("fee_type").notNull(),
    /** The provider's own code, so a fee mapped to `other` stays analyzable. */
    providerFeeCode: text("provider_fee_code"),
    externalFeeId: text("external_fee_id"),
    description: text("description"),
    currency: char("currency", { length: 3 }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    chargedAt: timestamp("charged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("order_fees_order_id_external_fee_id_uq")
      .on(table.orderId, table.externalFeeId)
      .where(sql`${table.externalFeeId} is not null`),
    check(
      "order_fees_fee_scope_check",
      sql`${table.feeScope} in ('order', 'line')`,
    ),
    check(
      "order_fees_fee_scope_line_check",
      sql`(${table.feeScope} = 'line') = (${table.orderLineId} is not null)`,
    ),
    check(
      "order_fees_fee_direction_check",
      sql`${table.feeDirection} in ('seller_charge', 'buyer_surcharge')`,
    ),
    index("order_fees_order_id_idx").on(table.orderId),
    index("order_fees_fee_type_charged_at_idx").on(
      table.feeType,
      table.chargedAt.desc(),
    ),
  ],
);

/**
 * Money returned to the buyer. The MONEY fact only — goods physically coming
 * back is inventory movement, which is Phase 4.
 *
 * `amount` is positive for money returned to the buyer.
 * `orders.refunded_amount` and `order_lines.refunded_amount` are
 * provider-reported rollups, not derived sums; a mismatch is a reconciliation
 * finding, not a constraint violation.
 */
export const orderRefunds = pgTable(
  "order_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    externalRefundId: text("external_refund_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    reasonCode: text("reason_code"),
    currency: char("currency", { length: 3 }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("order_refunds_order_id_external_refund_id_uq")
      .on(table.orderId, table.externalRefundId)
      .where(sql`${table.externalRefundId} is not null`),
    index("order_refunds_order_id_idx").on(table.orderId),
  ],
);

/**
 * Which lines a refund touched.
 *
 * Surrogate primary key rather than `(refund_id, line_id)`: a single refund can
 * legitimately touch the same line twice (a price adjustment plus a shipping
 * refund), and `order_line_id` is nullable for order-level refunds naming no
 * line.
 */
export const orderRefundLines = pgTable(
  "order_refund_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderRefundId: uuid("order_refund_id")
      .notNull()
      .references(() => orderRefunds.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id").references(() => orderLines.id, {
      onDelete: "cascade",
    }),
    quantity: numeric("quantity", { precision: 20, scale: 6 }),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("order_refund_lines_order_refund_id_idx").on(table.orderRefundId),
  ],
);

/**
 * What the CHANNEL reported as shipped. Commerce-owned channel facts.
 *
 * Phase 4's Shipping domain adds `shipments` — packages, labels, dimensions,
 * insurance, actual postage — which will REFERENCE these rows rather than
 * replace them. Customer-paid shipping is a Commerce fact
 * (`orders.shipping_amount`); actual carrier cost is a Shipping fact and does
 * not exist in Phase 3.
 *
 * No address normalization: `destination_country` and `destination_region`
 * only, because those are what Phase 4 shipping-cost analysis and Phase 5 tax
 * context group by, and they are not meaningfully personal data. The full
 * destination address stays in the retained provider payload.
 */
export const orderFulfillments = pgTable(
  "order_fulfillments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    externalFulfillmentId: text("external_fulfillment_id"),
    status: text("status").notNull(),
    carrierCode: text("carrier_code"),
    carrierName: text("carrier_name"),
    serviceCode: text("service_code"),
    /** A fulfillment with no tracking number is normal. */
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    destinationCountry: char("destination_country", { length: 2 }),
    destinationRegion: text("destination_region"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("order_fulfillments_order_id_external_id_uq")
      .on(table.orderId, table.externalFulfillmentId)
      .where(sql`${table.externalFulfillmentId} is not null`),
    index("order_fulfillments_order_id_idx").on(table.orderId),
    index("order_fulfillments_tracking_number_idx")
      .on(table.trackingNumber)
      .where(sql`${table.trackingNumber} is not null`),
  ],
);

/**
 * Per-line shipped quantities.
 *
 * PROVISIONAL (design open question 3): kept exactly as designed. Per-line
 * quantity is the minimum depth at which
 * `orders.fulfillment_status = 'partially_fulfilled'` is a CHECKABLE claim
 * rather than a label, and it is the join point Phase 4 shipments need.
 * Anything more is Shipping-domain work.
 */
export const orderFulfillmentLines = pgTable(
  "order_fulfillment_lines",
  {
    orderFulfillmentId: uuid("order_fulfillment_id").notNull(),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.orderFulfillmentId, table.orderLineId],
    }),
    // Named explicitly: the derived name would exceed PostgreSQL's 63-byte
    // identifier limit and be silently truncated.
    foreignKey({
      name: "order_fulfillment_lines_fulfillment_id_fk",
      columns: [table.orderFulfillmentId],
      foreignColumns: [orderFulfillments.id],
    }).onDelete("cascade"),
    check("order_fulfillment_lines_quantity_check", sql`${table.quantity} > 0`),
  ],
);

/**
 * Which retained source facts produced or updated an order (cross-domain rule
 * 4: derived state identifies the source facts it was computed from).
 *
 * An order is not ingested once — it is created by one fetch and updated by
 * many — so a single `source_event_id` column on `orders` would be a lie by
 * the second sync.
 *
 * Provenance is tracked at the ORDER only. Fees, refunds, fulfillments, and
 * lines inherit their order's chain, because attachments are rewritten as part
 * of the order's transaction. `effect = 'unchanged'` distinguishes "we
 * re-fetched and nothing moved" from "we never looked".
 */
export const orderSourceLinks = pgTable(
  "order_source_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    sourceEventId: uuid("source_event_id").references(() => sourceEvents.id),
    providerObjectId: uuid("provider_object_id").references(
      () => providerObjects.id,
    ),
    effect: text("effect").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("order_source_links_order_id_source_event_id_uq")
      .on(table.orderId, table.sourceEventId)
      .where(sql`${table.sourceEventId} is not null`),
    uniqueIndex("order_source_links_order_id_provider_object_id_uq")
      .on(table.orderId, table.providerObjectId)
      .where(sql`${table.providerObjectId} is not null`),
    check(
      "order_source_links_effect_check",
      sql`${table.effect} in ('created', 'updated', 'unchanged')`,
    ),
    check(
      "order_source_links_one_reference_check",
      sql`num_nonnulls(${table.sourceEventId}, ${table.providerObjectId}) = 1`,
    ),
    index("order_source_links_order_id_linked_at_idx").on(
      table.orderId,
      table.linkedAt.desc(),
    ),
  ],
);
