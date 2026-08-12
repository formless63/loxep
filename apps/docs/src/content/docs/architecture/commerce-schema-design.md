---
title: Commerce Schema Design (Phase 3)
---

This document is the physical schema design for [Phase 3 — Commerce ingestion](../../product/roadmap/#phase-3--commerce-ingestion). It stands in the same relationship to Phase 3 that the [Foundation Schema Draft](../foundation-schema/) stands in to Phase 0: a concrete migration target with table sketches, constraints, and the reasoning behind them, written before any migration exists.

It **extends** the foundation. Where an existing table, convention, or ADR already answers a question, that answer is reused rather than restated differently. Nothing here changes an already-implemented table.

**Implementation status: this design is now implemented, PROVISIONALLY.** Migration `0003_commerce_orders_and_catalog.sql`, `packages/db/src/schema/commerce.ts`, and `packages/commerce` exist. They were built under an explicit owner directive to resolve every [open question](#open-questions) below per that question's own documented recommendation and mark the result PROVISIONAL for review — not because the questions were answered. See [Provisional implementation decisions](#provisional-implementation-decisions) for what shipped, what diverged from the draft below, and why. The sections between here and there describe the design as drafted; where implementation diverged, the divergence is recorded in that section rather than silently edited into the draft.

## Scope

Phase 3 adds the physical tables required to turn provider sales activity into normalized, entity-attributed commerce facts:

- `orders` — one normalized sale per provider order, per connection;
- `order_lines` — what was sold;
- `order_fees` — marketplace/payment fees the provider reports against the order;
- `order_refunds` and `order_refund_lines` — money returned to the buyer;
- `order_fulfillments` and `order_fulfillment_lines` — what the channel reported as shipped;
- `order_source_links` — which retained source facts produced or updated an order;
- `catalog_items` — Loxep's internal SKU identity;
- `channel_listings` — an owned publication of a catalog item to one channel through one connection.

Nine new tables. No existing table gains a column — see [Migration plan sketch](#migration-plan-sketch) for the argument.

The domains involved are **Commerce** (orders and their attachments) and **Catalog and Listings** (catalog items, channel listings), which remain distinct ownership boundaries per [Domain Boundaries](../domain-boundaries/) even though both land in the same phase and surface in the same `/commerce` workspace. Workspace UX is not domain ownership.

## What Phase 3 does not create

Phase 3 stops at commercial facts. It deliberately does not create:

```text
inventory items / stock quantities / locations   Phase 4 — stock state has no meaning before acquisitions exist
inventory movements / allocations / depletion    Phase 4 — a sale can only deplete stock that was first received
cost basis / cost layers / landed cost           Phase 4 — COGS requires acquisition facts Phase 3 has not ingested
acquisitions / purchasing / vendors              Phase 4 — the inbound half of the goods lifecycle
shipments / packages / labels / actual postage   Phase 4 (Shipping domain) — carrier reality is not channel-reported fulfillment
returns as physical goods movement               Phase 4 — Phase 3 records the money fact, not the item coming back
payouts / clearing accounts / bank transactions  Phase 5 — settlement is downstream of the sale
processor fees not attached to one order         Phase 5 — payout-level fees need a payout model to attach to
sales-tax jurisdiction / facilitator model       Phase 5 — Phase 3 stores provider-reported tax amounts as facts only
accounting_books / chart of accounts / journal   Phase 5 (ADR-0017) — the ledger is downstream of operational truth
counterparties / customers / addresses           Phase 6 — the buyer stays a channel-native reference
listing templates / writing listings to channels Later — Phase 3 ingestion is read-only against providers
variant option/axis model, kits, bundles         Later — see the deliberate simplification below
per-connection/per-entity ACLs                   Still none (ADR-0017); membership remains installation-wide
```

Phase 3 profitability is therefore explicitly **revenue minus provider-reported fees, refunds, and discounts** — not margin. Margin arrives with cost basis in Phase 4. Any view or label shipped in Phase 3 must say so.

## Conventions inherited from the foundation

Nothing below invents a convention. From the [Foundational Data Model](../foundational-data-model/) and [Implementation Contract](../../development/implementation-contract/):

- UUID primary keys with `defaultRandom()`; provider identifiers are stored separately as text and never become Loxep keys;
- all instants are `timestamptz` with semantic names (`placed_at`, `shipped_at`, `last_synced_at`);
- money is `numeric(20,6)` plus an ISO currency code; no persisted arithmetic in JavaScript `number`;
- state columns are `text` with application-owned TypeScript unions, never PostgreSQL enums;
- `CHECK` constraints only for genuinely closed sets. Order/payment/fulfillment statuses are provider-extensible and get TypeScript unions with **no** database `CHECK`; `entity_attribution_source` and `fee_scope` are Loxep-owned closed sets and do get one;
- raw provider JSON lives only at the provenance boundary (`source_events`, `provider_objects`). None of the tables below carries a `payload` or free-form attribute `jsonb` column. Where Phase 3 declines to normalize something (a full shipping address, a provider's option list), the answer is "it is recoverable from retained provenance", not "put it in jsonb";
- user-reference columns follow ADR-0020: nullable FK to the Better Auth user id with `ON DELETE SET NULL`. Only `orders.entity_attributed_by_user_id` and `catalog_items.created_by_user_id` need one;
- no credentials, tokens, or secret material appear in any of these tables (ADR-0019). Provider access continues through the connection credential service.

Orders are ordinary transactional relational data. **No table in this design is a Timescale hypertable.** Timescale is for genuinely temporal observation streams; a sale is a record, not a sample.

## Economic-entity attribution on commerce facts

This is the load-bearing decision of Phase 3, and the roadmap states the requirement precisely: attribute owned commerce activity to the appropriate economic entity *rather than inferring ownership from the user, workspace, or connection alone*.

### Attribution is a stored column on `orders`, not a join

`orders` carries its own nullable `economic_entity_id` referencing `economic_entities(id)`. It is not derived at read time from `connections.economic_entity_id`. Four reasons, in order of weight:

1. **Connections are mutable configuration; orders are history.** A connection can be re-attributed at any time — an eBay account moves from personal activity to a newly formed LLC, or an entity record is corrected. If order attribution were a join through `connections`, that single edit would silently rewrite the economic ownership of every historical sale, including periods that have already been reported on. ADR-0017 makes connection attribution *context*; it must not become a retroactive rewrite lever over financial history.
2. **One provider account can carry more than one operating identity.** A single eBay account may be used for both personal liquidation and an LLC's resale inventory. Connection-level attribution cannot express that; a per-order value can.
3. **Phase 5 must read attribution, not recompute it.** The ledger is downstream of operational truth. Posting rules that consume orders need a stable attribution fact on the source record. An attribution that changes when configuration changes is not a fact.
4. **ADR-0017 forbids entity-as-permission, not entity-as-fact.** Copying the entity onto the order adds no authorization semantics — access remains installation-wide. It records who the activity belonged to, which is exactly what economic entities are for.

Nullable, because ingestion must never fail or block on an unattributed connection. An unattributed order is a visible backlog to resolve, not a rejected fact. Operational facts before accounting.

### Precedence

At first normalization of an order, attribution resolves in this order:

```text
1. explicit per-order value set by an operator      entity_attribution_source = 'manual'
2. snapshot of connections.economic_entity_id       entity_attribution_source = 'connection_default'
3. no attribution available                         entity_attribution_source = 'unattributed'
                                                    economic_entity_id is null
```

`entity_attribution_source` is a Loxep-owned closed set and carries a `CHECK`. Its purpose is not description — it is the eligibility marker for bulk re-attribution.

Rules:

- attribution is written **once**, at first normalization. Subsequent syncs of the same order never touch it. Re-fetching an order must not change what it belonged to;
- changing a connection's `economic_entity_id` does not retroactively alter any existing order;
- re-attribution is an **explicit, audited operator action** ("re-attribute orders from connection X placed before date Y"), which may rewrite rows whose source is `connection_default` or `unattributed`, and must never rewrite `manual` rows. Every such run writes `audit_events`;
- setting a per-order override records `entity_attributed_at` and `entity_attributed_by_user_id` and flips the source to `manual`.

Downstream tables (`order_lines`, `order_fees`, `order_refunds`, `order_fulfillments`) do **not** duplicate the entity column. They inherit attribution through their order. `catalog_items` and `channel_listings` carry their own nullable `economic_entity_id` because a catalog item can exist before it has ever been sold, but a line's attribution always comes from its order, never from its catalog item — the same SKU may be sold by two operating identities.

Nothing here approaches accounting books. There is no `accounting_book_id` in Phase 3, and no assumption that one entity equals one book.

## Ingestion identity and idempotency

Jobs are at-least-once. Every write path below must be an upsert keyed on a value the adapter can always recompute from the provider payload alone.

### The order upsert key

```text
unique(connection_id, provider, external_order_id)
```

The alternatives were considered and rejected:

- **`unique(provider, external_order_id)` (global).** Wrong for two of the three Phase 3 providers. eBay order IDs are globally unique, but a WooCommerce order ID is a per-store integer — order `1042` exists in every Woo installation — and Medusa display IDs are per-store as well. A global key would collide across stores on the first day a second Woo connection is added.
- **An account-scoped key derived from `connections.external_account_id`.** The [Foundation Schema Draft](../foundation-schema/#connection-foundation) explicitly refuses to enforce uniqueness on `external_account_id` because provider semantics differ. Building the order primary identity on a field the foundation declines to trust would be a contradiction, and a wrong or absent account id would then break ingestion rather than degrade a report.

So the physical key is connection-scoped, matching the existing `source_events` precedent (`unique(connection_id, provider, external_event_id)`).

### The multi-connection duplication problem, and why it is not solved by the key

This is where orders differ from `marketplace_items` and the contrast is worth stating explicitly.

`marketplace_items` is keyed `unique(provider, marketplace, external_item_id)` with **no** connection in the key, deliberately: a public eBay listing seen through two connections is *one* object, because it is a public fact about the world that exists independently of who is looking.

An order is the opposite kind of thing. It is a private, account-scoped record. Two connections authorized against the same seller account will each legitimately fetch the same order, and under a connection-scoped key that produces two `orders` rows and double-counted revenue. Realistic causes: a re-authorized replacement connection created before the old one is deleted, or a second read-only connection used for a different scope.

The design does not weaken the key to fix this, because a key that ingestion cannot always compute reliably is worse than a duplicate it can detect. Instead:

- every order carries `source_account_key text not null` — an adapter-computed provider-specific account scope string (`ebay:<sellerId>`, `woocommerce:<siteUrl>`, `medusa:<storeId>`), stored as an ordinary fact, not as a constraint;
- a non-unique index on `(provider, source_account_key, external_order_id)` makes cross-connection duplicates **detectable** by a diagnostic query and an integration-health surface;
- `orders.duplicate_of_order_id uuid null references orders(id)` lets an operator (or an adapter that is certain) mark a row as a known duplicate of the canonical order. Reporting excludes rows where it is non-null. The ingested evidence is never deleted.

Whether that detection should ever become a hard constraint is an [open question](#open-questions).

### Other identity rules

- `order_lines`: `unique(order_id, line_number)` always, plus `unique(order_id, external_line_id) where external_line_id is not null`. Providers that expose stable line ids get real idempotency; providers that do not get positional identity, and a re-sync that reorders lines is a normalization bug to surface, not to absorb.
- `order_fees`, `order_refunds`, `order_fulfillments`: `unique(order_id, external_*_id) where ... is not null`. Where a provider gives no stable id, the adapter must derive a deterministic natural key (for fees: `(order_id, fee_type, charged_at)`) and the re-sync strategy is delete-and-replace of that order's attachments **inside one transaction with the order update**, never a blind insert.
- `channel_listings`: see below; requires `NULLS NOT DISTINCT`.
- Provider timestamps drive incremental sync: `provider_updated_at` on orders is the watermark column, and the adapter's cursor lives with the sync scheduling record, not on `connections`.

## Orders

```text
orders
id                            uuid primary key
connection_id                 uuid not null references connections(id)
provider                      text not null
channel                       text not null
marketplace                   text null
source_account_key            text not null
external_order_id             text not null
external_order_number         text null
economic_entity_id            uuid null references economic_entities(id)
entity_attribution_source     text not null
entity_attributed_at          timestamptz null
entity_attributed_by_user_id  text null references user(id) on delete set null
status                        text not null
payment_status                text not null
fulfillment_status            text not null
provider_status_raw           text null
currency                      char(3) not null
subtotal_amount               numeric(20,6) not null
shipping_amount               numeric(20,6) not null default 0
discount_amount               numeric(20,6) not null default 0
tax_amount                    numeric(20,6) not null default 0
fee_amount                    numeric(20,6) not null default 0
refunded_amount               numeric(20,6) not null default 0
total_amount                  numeric(20,6) not null
buyer_external_id             text null
buyer_display_name            text null
placed_at                     timestamptz not null
provider_updated_at           timestamptz null
cancelled_at                  timestamptz null
duplicate_of_order_id         uuid null references orders(id)
first_ingested_at             timestamptz not null
last_synced_at                timestamptz not null
created_at                    timestamptz not null
updated_at                    timestamptz not null
unique(connection_id, provider, external_order_id)
check(entity_attribution_source in ('manual','connection_default','unattributed'))
```

Notes:

- `provider` is the adapter family (`ebay`, `woocommerce`, `medusa`); `channel` is the selling surface as Loxep names it for cross-channel reporting; `marketplace` is the provider's sub-market where one exists (`EBAY_US`), null for single-market stores. Three columns because collapsing them forces string parsing in every report.
- **Status is three independent lifecycles**, because providers move them independently and a single collapsed status loses information:

```text
status              pending | open | completed | cancelled
payment_status      unpaid | partially_paid | paid | partially_refunded | refunded | failed
fulfillment_status  unfulfilled | partially_fulfilled | fulfilled | cancelled
```

  These are TypeScript unions with no database `CHECK` — providers add states, and an ingestion job must never fail a constraint because eBay invented a status on a Tuesday. `provider_status_raw` preserves the provider's own string verbatim so a normalization mistake is diagnosable without re-reading payloads; it is one narrow text column of evidence, not a JSON store.
- **Amounts are provider-reported facts, not computed.** There is deliberately no `CHECK` that `total_amount` equals the sum of lines plus shipping and tax minus discounts. Providers round and aggregate differently, and a constraint here would convert a rounding difference into a failed ingestion. A reconciliation report flags mismatches beyond a tolerance; ingestion always succeeds.
- **Sign convention:** every amount on `orders` is stored positive as reported. `fee_amount` and `refunded_amount` are magnitudes of deductions, not negatives. Net proceeds are computed, never stored.
- One currency per order. Lines inherit it and do not repeat it; fees and refunds carry their own, because providers can charge or settle those in a different currency than the sale.
- **Buyer identity is a channel-native reference, not a counterparty.** `buyer_external_id` plus an optional display name, and nothing else — no email, no phone, no address columns. Phase 6 adds the counterparty model and a nullable `counterparty_id`, backfilled by matching, without rewriting these columns. The full buyer payload remains recoverable from `provider_objects` for as long as retention policy keeps it, which is also the right place for it from a data-minimization standpoint.
- `connection_id` is `not null` because Phase 3 ingestion is the only way an order can arrive. If manual order entry is ever added, it needs either a synthetic connection or a nullable column with `unique nulls not distinct` — Phase 3 does not create that path and should not pretend to.
- Orders are never hard-deleted in normal operation. Attachment tables below use `on delete cascade` purely to express composition (a fee has no existence apart from its order); this is intra-aggregate and unrelated to ADR-0020's prohibition on cascades *from auth tables into* domain data.

### `order_lines`

```text
order_lines
id                      uuid primary key
order_id                uuid not null references orders(id) on delete cascade
line_number             integer not null
external_line_id        text null
catalog_item_id         uuid null references catalog_items(id)
channel_listing_id      uuid null references channel_listings(id)
marketplace_item_id     uuid null references marketplace_items(id)
external_item_id        text null
external_variation_id   text null
channel_sku             text null
title                   text null
quantity                numeric(20,6) not null
unit_price              numeric(20,6) not null
line_subtotal           numeric(20,6) not null
discount_amount         numeric(20,6) not null default 0
tax_amount              numeric(20,6) not null default 0
shipping_amount         numeric(20,6) not null default 0
refunded_amount         numeric(20,6) not null default 0
line_total              numeric(20,6) not null
created_at              timestamptz not null
updated_at              timestamptz not null
unique(order_id, line_number)
unique(order_id, external_line_id) where external_line_id is not null
check(quantity > 0)
```

- **All three item references are nullable and opportunistic.** A line is a complete, valid fact with none of them resolved. `catalog_item_id` and `channel_listing_id` are resolved by a matcher (channel SKU, then listing identity); `marketplace_item_id` is the join between Commerce and Market Intelligence — when a sold listing happens to be one Loxep already observes, that link is what eventually connects a market opportunity to a realized outcome in Phase 4. None of them may ever be a precondition for ingesting the line.
- `channel_sku` is the SKU string the channel reported, kept as a fact even after `catalog_item_id` resolves. It is the evidence for the match and the input to re-matching.
- `quantity` is `numeric(20,6)`, not `integer`. Marketplace orders are discrete today, but WooCommerce supports fractional quantities via extensions and Phase 4 inventory will handle goods sold by weight or length. The type costs nothing now and avoids migrating a large table later. This intentionally diverges from `marketplace_item_observations.quantity_available`, which is `integer` because it records a provider's own integer field about a public listing.
- No `fee_amount` column. Fees live in `order_fees` at the granularity the provider reports; a per-line fee allocation is a *derived* number and does not belong in a source-fact table.

### `order_fees`

Marketplace and payment fees the provider reports **against a specific order**. Fees that arrive only at payout or statement level — processor monthly charges, ad spend not attributable to one sale — are Phase 5 and have no home here.

```text
order_fees
id                  uuid primary key
order_id            uuid not null references orders(id) on delete cascade
order_line_id       uuid null references order_lines(id) on delete cascade
fee_scope           text not null
fee_type            text not null
provider_fee_code   text null
external_fee_id     text null
description         text null
currency            char(3) not null
amount              numeric(20,6) not null
charged_at          timestamptz null
created_at          timestamptz not null
updated_at          timestamptz not null
unique(order_id, external_fee_id) where external_fee_id is not null
check(fee_scope in ('order','line'))
check((fee_scope = 'line') = (order_line_id is not null))
```

- `fee_scope` is a Loxep-owned closed set with a `CHECK` that keeps it consistent with `order_line_id`. This is the one place a redundant column earns its keep: reporting queries filter on scope constantly and should not depend on a null test.
- **Fees are stored at the granularity the provider reports them and are never synthesized.** If eBay reports one order-level final value fee, one row with `fee_scope = 'order'` is written. Loxep does not spread it across lines at ingest. Allocation to lines is a reporting decision that belongs with cost basis in Phase 4, where it can be done consistently with COGS. See [open questions](#open-questions).
- **Sign convention:** positive means an amount charged to the seller (a deduction from proceeds). Credits, rebates, and fee refunds are negative. This is the opposite polarity from `order_refunds.amount`, which is positive for money returned to the buyer — two different flows, deliberately not merged into one signed `order_adjustments` table, because merging them would make every query filter on a kind column and would obscure that a fee is charged *by the platform to the seller* while a refund is paid *by the seller to the buyer*.
- Initial `fee_type` values (TypeScript union, no `CHECK` — providers invent fee categories):

```text
marketplace_final_value
marketplace_insertion
marketplace_regulatory_operating
payment_processing
promoted_listing_ad
international
shipping_label_charge
other
```

`provider_fee_code` retains the provider's own code so a fee mapped to `other` is still analyzable.

### `order_refunds` and `order_refund_lines`

The money fact only. Goods physically coming back is inventory movement, which is Phase 4.

```text
order_refunds
id                  uuid primary key
order_id            uuid not null references orders(id) on delete cascade
external_refund_id  text null
kind                text not null
status              text not null
reason_code         text null
currency            char(3) not null
amount              numeric(20,6) not null
refunded_at         timestamptz null
created_at          timestamptz not null
updated_at          timestamptz not null
unique(order_id, external_refund_id) where external_refund_id is not null

order_refund_lines
id                  uuid primary key
order_refund_id     uuid not null references order_refunds(id) on delete cascade
order_line_id       uuid null references order_lines(id) on delete cascade
quantity            numeric(20,6) null
amount              numeric(20,6) not null
created_at          timestamptz not null
```

- `kind`: `refund | partial_refund | cancellation | adjustment`. `status`: `pending | completed | failed`.
- `amount` is positive for money returned to the buyer.
- `order_refund_lines` uses a surrogate primary key rather than `(refund_id, line_id)` because a single refund can legitimately touch the same line twice (a price adjustment plus a shipping refund), and `order_line_id` is nullable for order-level refunds that name no line.
- `orders.refunded_amount` and `order_lines.refunded_amount` are provider-reported rollups, not derived sums. Where a provider reports both, a mismatch is a reconciliation finding, not a constraint violation.

### `order_fulfillments` and `order_fulfillment_lines`

Phase 3 minimal, and the boundary is precise: these tables record **what the channel said was shipped**. They are Commerce-owned channel facts. Phase 4's Shipping domain adds `shipments` — packages, labels, dimensions, insurance, and actual postage cost — which will *reference* fulfillments rather than replace them. Customer-paid shipping is a Commerce fact (`orders.shipping_amount`); actual carrier cost is a Shipping fact and does not exist in Phase 3.

```text
order_fulfillments
id                      uuid primary key
order_id                uuid not null references orders(id) on delete cascade
external_fulfillment_id text null
status                  text not null
carrier_code            text null
carrier_name            text null
service_code            text null
tracking_number         text null
tracking_url            text null
shipped_at              timestamptz null
delivered_at            timestamptz null
destination_country     char(2) null
destination_region      text null
created_at              timestamptz not null
updated_at              timestamptz not null
unique(order_id, external_fulfillment_id) where external_fulfillment_id is not null

order_fulfillment_lines
order_fulfillment_id    uuid not null references order_fulfillments(id) on delete cascade
order_line_id           uuid not null references order_lines(id) on delete cascade
quantity                numeric(20,6) not null
primary key(order_fulfillment_id, order_line_id)
check(quantity > 0)
```

- Partial fulfillment is representable from day one: many fulfillments per order, each with per-line quantities. That is the minimum depth at which `orders.fulfillment_status = 'partially_fulfilled'` means anything checkable.
- **No address normalization.** `destination_country` and `destination_region` only, because they are the two fields Phase 4 shipping-cost analysis and Phase 5 tax context will need to group by, and they are not meaningfully personal data. The full destination address stays in the retained provider payload until Phase 6 owns an address model. This is the "recoverable from provenance, not stuffed into jsonb" rule applied.
- A fulfillment with no tracking number is normal (digital goods, local pickup, providers that report shipment without carrier detail).

### `order_source_links`

Cross-domain rule 4 — derived state identifies the source facts it was computed from. An order is not ingested once; it is created by one fetch and updated by many, so a single `source_event_id` column on `orders` would be a lie by the second sync.

```text
order_source_links
id                  uuid primary key
order_id            uuid not null references orders(id) on delete cascade
source_event_id     uuid null references source_events(id)
provider_object_id  uuid null references provider_objects(id)
effect              text not null
linked_at           timestamptz not null
unique(order_id, source_event_id) where source_event_id is not null
unique(order_id, provider_object_id) where provider_object_id is not null
check(effect in ('created','updated','unchanged'))
check(num_nonnulls(source_event_id, provider_object_id) = 1)
```

- Exactly one of the two references is set: a link points at either the event envelope or the object snapshot that carried the data.
- The partial uniques give the replay path idempotency — reprocessing the same source event links once.
- **Provenance is tracked at the order only.** Fees, refunds, fulfillments, and lines inherit their order's provenance chain. Per-attachment links would multiply rows for no additional diagnostic value, since attachments are rewritten as part of the order's transaction.
- `effect = 'unchanged'` is worth recording: it distinguishes "we re-fetched and nothing moved" from "we never looked", which is the same reasoning behind retaining unchanged marketplace observations.

## Catalog and channel listings

### `catalog_items`

Loxep's internal SKU identity, independent of any provider listing. A catalog item can exist before it is ever listed or sold.

```text
catalog_items
id                      uuid primary key
sku                     text not null
name                    text not null
kind                    text not null
status                  text not null
economic_entity_id      uuid null references economic_entities(id)
parent_catalog_item_id  uuid null references catalog_items(id)
variant_label           text null
description             text null
condition_code          text null
default_currency        char(3) null
default_price           numeric(20,6) null
created_by_user_id      text null references user(id) on delete set null
created_at              timestamptz not null
updated_at              timestamptz not null
unique(sku)
check(kind in ('simple','variant_group','variant'))
check((kind = 'variant') = (parent_catalog_item_id is not null))
```

- `kind`: `simple | variant_group | variant`. `status`: `draft | active | archived`.
- **No cost column.** `default_price` is a reference sale price, which is a catalog attribute. Cost basis is Phase 4 and belongs with acquisitions and cost layers, not on the item record. This is a deliberate reading of the domain map's "product costs/sale prices" bullet — see [contradictions](#open-questions).
- `unique(sku)` is installation-wide, not per-entity. An internal SKU is an internal identifier and duplicates across operating identities are a data hazard that produces silently wrong profitability. If a real need arises, widening to `(economic_entity_id, sku)` is additive — but it drags in the null-entity case, so the narrow rule ships first.
- No `jsonb` attribute bag. If a structured attribute is needed, it gets a column or a table.

#### Variants: the deliberate simplification

Variants are modeled as `catalog_items` rows pointing at a parent `variant_group` row via `parent_catalog_item_id`, with a free-text `variant_label` ("Blue / Large"). There is **no** option/axis model — no `catalog_options`, no `catalog_option_values`, no option-to-variant matrix.

The rejected alternative was a separate `catalog_products` table with `catalog_items` as its variants. It was rejected because the overwhelming majority of resale inventory is single-variant, and that shape forces an otherwise-empty parent row for every one of them.

The exit path is deliberately kept open and is additive:

1. `order_lines` reference the **leaf** item (`kind` of `simple` or `variant`), never the group. Adding a structured option model never touches order history.
2. Parent group rows already exist and already have identity, so `catalog_options` / `catalog_option_values` / a variant-to-value join table can be introduced as new tables referencing the existing group and variant rows.
3. `variant_label` becomes a display cache derived from option values, or is dropped, without data loss — the label was never the identity.

What this simplification cannot do today: query "all Blue items across products", or drive channel-specific variant matrices. Neither is a Phase 3 requirement.

### `channel_listings`

An **owned publication** of a catalog item to one channel through one connection.

```text
channel_listings
id                      uuid primary key
catalog_item_id         uuid not null references catalog_items(id)
connection_id           uuid not null references connections(id)
provider                text not null
channel                 text not null
marketplace             text null
external_listing_id     text not null
external_variation_id   text null
marketplace_item_id     uuid null references marketplace_items(id)
status                  text not null
listing_url             text null
listing_title           text null
currency                char(3) null
price                   numeric(20,6) null
quantity_available      integer null
listed_at               timestamptz null
ended_at                timestamptz null
first_ingested_at       timestamptz not null
last_synced_at          timestamptz not null
created_at              timestamptz not null
updated_at              timestamptz not null
unique nulls not distinct
  (connection_id, provider, external_listing_id, external_variation_id)
```

`status`: `draft | active | ended | sold_out | unknown`.

The unique constraint requires `NULLS NOT DISTINCT` (PostgreSQL 15+; the deployment target is `timescale/timescaledb-ha:pg18.4-ts2.29.1-all`, so it is available). Without it, PostgreSQL treats each null `external_variation_id` as distinct and every re-sync of a non-variant listing inserts a duplicate. The portable fallback, if that clause is ever unavailable, is a unique expression index over `coalesce(external_variation_id, '')`. Verify the clause against current PostgreSQL behavior at implementation time.

`quantity_available` is `integer` here — matching `marketplace_item_observations.quantity_available`, because it mirrors the same provider-reported integer field.

#### `channel_listings` versus `marketplace_items` — two different concepts

This distinction is the one most likely to be collapsed by a well-meaning implementation, so it is stated flatly.

```text
marketplace_items                        channel_listings
------------------------------------     ------------------------------------
an observed PUBLIC listing               an OWNED publication
possibly someone else's                  definitely ours
discovered by monitoring                 created by us or ingested from our account
entity-neutral public fact               connection-scoped, entity-attributable
one canonical row across all             one row per connection that publishes it
  connections that observe it
key: (provider, marketplace,             key: (connection_id, provider,
       external_item_id)                        external_listing_id, variation)
no connection in the key, by design      connection is IN the key, by design
```

They may reference each other, and that reference is `channel_listings.marketplace_item_id` — **nullable and opportunistic**.

Why a nullable link and not a subtype relationship:

- **Not every channel has a marketplace item.** A WooCommerce or Medusa product page is not a marketplace listing in the intelligence sense. There is no public listing object to observe and no `marketplace_items` row will ever exist. A subtype model would force a fake one.
- **The two lifecycles are independent.** Un-monitoring a listing, or a monitor target being deleted, must have no effect on the record that we sell this item there. Conversely, our listing ending does not delete a public fact that other Loxep features may still reference.
- **The keys are structurally incompatible.** `marketplace_items` deliberately has *no* connection in its key so that two connections observing one public listing converge on one row. `channel_listings` deliberately *does*, so that two connections publishing the same catalog item stay distinct. These cannot be the same table.
- **The link is a discovery, not an identity.** When we list our own item on eBay, a public listing genuinely does exist and may later be monitored — at which point the `marketplace_items` row appears and a background matcher resolves the link by `(provider, marketplace, external_item_id)`. The channel listing was complete and correct before that happened.

The practical payoff: with the link resolved, Loxep can compare our own listing's observed price and watch count against the same public data it collects for competitors, using machinery that already exists.

### Product and listing media

The roadmap's "begin using media storage for product/listing assets" needs **no new tables**. `media_links` already attaches a `media_object` to any resource by `(resource_type, resource_id, purpose)`. Phase 3 adds two `resource_type` values, `catalog_item` and `channel_listing`, which are text values in application code, not DDL.

`media_links` deliberately has no universal uniqueness rule; the sensible semantics here are one primary image plus ordered gallery images per resource, expressed through `purpose` and `sort_order` and enforced in the domain service.

## Relationship overview

```text
economic_entities
    |
    |  attribution snapshot, written once at first normalization
    |  (never a read-time join)
    v
connections ──────> source_events / provider_objects
    |                          |
    |                          v
    |                  order_source_links
    |                          |
    v                          v
  orders <────────────────────-+
    |
    +--> order_lines ──+--> catalog_items          (opportunistic)
    |                  +--> channel_listings       (opportunistic)
    |                  +--> marketplace_items      (opportunistic; Commerce <-> Market join)
    |
    +--> order_fees            (order- or line-scoped, as reported)
    +--> order_refunds --> order_refund_lines
    +--> order_fulfillments --> order_fulfillment_lines

catalog_items
    |
    +--> catalog_items.parent_catalog_item_id      (variant group -> variant)
    +--> channel_listings ──> marketplace_items    (nullable link: owned -> observed)
    +--> media_links (resource_type = 'catalog_item')

Phase 4:  order_lines --> inventory movements, cost layers; order_fulfillments --> shipments
Phase 5:  orders + fees + refunds --> posting rules --> accounting books
Phase 6:  orders.buyer_external_id --> counterparties
```

Every arrow into a future phase is a *reference added later*, not a rewrite of these tables. That is the test this design has to pass.

## Cross-channel and profitability read models

Phase 3's "initial cross-channel order and profitability views" should be implemented as **queries and read models in `@loxep/domain`**, not as database views, at least initially. Reasons: view definitions in migrations are awkward to evolve, they hide business logic from the type system and the test suite, and the shape of a profitability view will change materially when cost basis arrives in Phase 4.

If a database view is later justified by query complexity, it is a plain (non-materialized) view added in its own late migration, and it must be droppable and recreatable without touching base tables. No Timescale continuous aggregate: these are transactional tables.

The initial read models:

```text
cross-channel orders     orders + lines, filtered by entity/channel/date, excluding
                         duplicate_of_order_id is not null

order contribution       total_amount - fee_amount - refunded_amount, grouped by
                         currency; labeled "before cost of goods" until Phase 4

channel comparison       contribution by channel and period
sku performance          contribution by catalog_item, via order_lines
attribution backlog      orders where economic_entity_id is null
reconciliation findings  provider totals vs. sum of lines beyond tolerance;
                         cross-connection duplicate candidates
```

Every money figure is grouped by currency and never summed across currencies — see [open questions](#open-questions).

## Migration plan sketch

### Ordering

Foreign keys dictate most of it. One migration per group keeps review tractable; a single migration is acceptable if the review burden is manageable.

```text
1. catalog_items                                  (self-ref, economic_entities, user)
2. channel_listings                               (catalog_items, connections, marketplace_items)
3. orders                                         (connections, economic_entities, user, self-ref)
4. order_lines                                    (orders, catalog_items, channel_listings,
                                                   marketplace_items)
5. order_fees                                     (orders, order_lines)
6. order_refunds, order_refund_lines              (orders, order_lines)
7. order_fulfillments, order_fulfillment_lines    (orders, order_lines)
8. order_source_links                             (orders, source_events, provider_objects)
9. reporting-only indexes (optional split; see below)
```

Steps 1–2 are independent of 3–8 and could ship as a separate earlier migration if catalog work lands before order ingestion. Step 4's FK to `channel_listings` is the only coupling.

All migrations run through `loxep migrate` under the existing advisory lock (ADR-0018). Nothing here needs hand-written SQL the way the Timescale hypertable did, with one exception: `UNIQUE NULLS NOT DISTINCT` and the partial unique indexes may need raw SQL if the current Drizzle Kit version cannot express them — verify at implementation time and drop to SQL rather than weakening the constraint.

### Which existing tables gain columns: none

This is a deliberate target, and it holds:

- **`connections`** — no new columns. The obvious candidate is an order-sync cursor/watermark, and it must not go in `connections.config`, which is *configuration*, not runtime state. The better home is the existing scheduling model: `monitor_targets` already owns interval, `next_poll_at`, backoff, consecutive errors, and a `config` jsonb that already carries transient namespaced state, and the foundation explicitly anticipates new target types without changing the scheduling model. Phase 3 order polling becomes target types `ebay_orders`, `woocommerce_orders`, `medusa_orders`, with the sync cursor under a namespaced `config` key. This reuses claim semantics, adaptive cadence, and rate budgets instead of building a second scheduler. **There is an ownership tension here** — `monitor_targets` is listed under Market Intelligence in [Domain Boundaries](../domain-boundaries/#market-intelligence) — and it is an [open question](#open-questions) requiring a documentation decision before implementation. The fallback that also adds zero columns is a small new `commerce_sync_cursors` table.
- **`marketplace_items`** — no new columns, emphatically. An "we own this listing" flag would contaminate an entity-neutral public-fact table with ownership semantics. Ownership lives on `channel_listings`, pointing inward.
- **`economic_entities`** — no new columns. No `accounting_book_id`, no commerce settings. ADR-0017 holds.
- **`source_events` / `provider_objects`** — no new columns. New `event_type` and `object_type` values (`ebay.order`, `woocommerce.order`, `medusa.order`) are text, not DDL. This is precisely what those columns are for.
- **`media_objects` / `media_links`** — no new columns. New `resource_type` values only.
- **Better Auth tables** — untouched, per ADR-0020.

If implementation discovers a genuine need to alter an existing table, that is a signal to revisit this design, not to quietly add the column.

### Index strategy

Ingestion is write-heavy in bursts and read-heavy in reporting, but the absolute volumes are modest — a self-hosted reseller's order flow is hundreds to thousands of rows per month, not millions. The discipline is therefore *one index per named query*, not defensive indexing.

Ingestion path (every one of these is on the hot upsert path):

```text
orders     unique(connection_id, provider, external_order_id)
             the upsert probe itself; the constraint IS the index, no duplicate
orders     index(connection_id, provider_updated_at desc)
             incremental sync watermark: "what changed since"
order_lines        unique(order_id, line_number)
order_lines        unique(order_id, external_line_id) where not null
order_fees         index(order_id)
order_refunds      index(order_id)
order_fulfillments index(order_id)
order_source_links index(order_id, linked_at desc)
channel_listings   unique nulls not distinct
                     (connection_id, provider, external_listing_id, external_variation_id)
```

Attachment rewrites delete and re-insert by `order_id` inside the order's transaction, which is exactly what those single-column indexes serve.

Reporting and resolution path:

```text
orders     index(economic_entity_id, placed_at desc)      entity-scoped reporting
orders     index(channel, placed_at desc)                 cross-channel views
orders     index(placed_at desc)                          recency across everything
orders     index(economic_entity_id) where economic_entity_id is null
                                                          attribution backlog (partial, tiny)
orders     index(provider, source_account_key, external_order_id)
                                                          cross-connection duplicate detection
order_lines        index(catalog_item_id) where not null   SKU performance
order_lines        index(channel_listing_id) where not null
order_lines        index(marketplace_item_id) where not null  Commerce <-> Market join
order_fees         index(fee_type, charged_at desc)        fee analysis
order_fulfillments index(tracking_number) where not null   support lookups
channel_listings   index(catalog_item_id)
channel_listings   index(connection_id, status)
channel_listings   index(marketplace_item_id) where not null
catalog_items      index(parent_catalog_item_id) where not null
```

Partial indexes wherever the column is mostly null — these are small and cheap, and the `where ... is not null` form keeps them that way.

Not indexed on purpose: `orders.status`, `payment_status`, `fulfillment_status` (low cardinality; a filter that always accompanies a date range is served by the date index), `order_fees.order_line_id` (small per-order fan-out), `catalog_items.status`.

Bulk backfill: the first historical import may insert tens of thousands of rows. At that scale index maintenance is not a real cost, so no split-and-rebuild dance is warranted; step 9 above stays optional. If a provider backfill ever exceeds ~10⁵ rows, create the reporting-only indexes after the backfill in a follow-up migration.

## Provisional implementation decisions

Every decision in this section is **PROVISIONAL**: implemented per this document's own recommendation under an owner directive, pending review. Each is marked `PROVISIONAL` at the code that implements it, so nothing here can drift out of sight. Reversing any of them is a normal change, not an emergency — that is the point of writing them down before the review.

### What shipped

```text
migration      packages/db/migrations/0003_commerce_orders_and_catalog.sql
schema         packages/db/src/schema/commerce.ts        (10 tables, 0 altered)
services       packages/commerce/src/                    (@loxep/commerce)
  orders.ts      idempotent ingestion, attribution, duplicate detection
  woo.ts         WooOrderFact -> the provider-neutral CommerceOrderFact
  ebay.ts        EbayOrderFact -> the same shape (second provider)
  catalog.ts     catalog items, channel listings, link suggestions
  reports.ts     currency-grouped order summary, entity attribution report
  sync.ts        incremental sync + monitor_targets cursor (shared helpers)
  ebay-sync.ts   the same, for target type `ebay_orders`
  tasks.ts       commerce.sync-woo-orders, commerce.sync-ebay-orders
adapter        packages/integrations/ebay/src/orders.ts  (Sell Fulfillment v1)
               packages/integrations/ebay/src/money.ts   (decimal discipline)
executor       packages/app/src/commerce.ts              (woo_orders)
               packages/app/src/commerce-ebay.ts         (ebay_orders)
```

**The second provider cost a translator and a status table, and nothing else.** Adding eBay touched `orders.ts` only to add a four-line `ingestEbayOrder` entry point — idempotency, attachment rewriting, attribution, provenance, and duplicate detection are still written and tested exactly once. That was the design's central claim for `CommerceOrderFact`, and it held.

### The eight open questions, as implemented

1. **Per-line versus per-order fee attribution — no allocation at ingest.** Fees are written at exactly the granularity the provider reports (`fee_scope` + nullable `order_line_id`), never synthesized or spread across lines. Allocation stays a Phase 4 reporting concern that can share a basis with COGS.

   **Divergence from the draft, forced by the WooCommerce findings:** `order_fees` gains a column the draft does not have — `fee_direction text not null check (fee_direction in ('seller_charge','buyer_surcharge'))`. The draft's `order_fees` means "an amount the platform charges the SELLER", but a Woo `fee_line` is a surcharge the merchant adds to the BUYER's cart, already inside `orders.total`, and Woo core reports no seller-side fees at all. The three candidate resolutions were: invert the sign (silently corrupts every fee report), drop the rows (loses a real fact), or make the semantic explicit. The third shipped. Woo `fee_lines` ingest as `buyer_surcharge`; `orders.fee_amount` remains a seller-side magnitude and is therefore `0` for Woo; every profitability figure subtracts only `seller_charge`.

   **The eBay leg vindicates the column.** eBay reports both polarities on the same order: `Order.totalMarketplaceFee` is charged to the seller (`seller_charge`, and the first non-zero `orders.fee_amount` in the system) while `pricingSummary.fee` is charged to the buyer and is already inside `pricingSummary.total` (`buyer_surcharge`). Had the sign been inverted or the rows dropped, one of the two would have been wrong on every eBay order. Neither fee has a provider id, so both get the deterministic natural keys the draft prescribes for that case (`ebay:total-marketplace-fee`, `ebay:pricing-summary-fee`), and both are written at `fee_scope = 'order'` — nothing is allocated to lines at ingest.

2. **Cross-connection duplicate orders — detect, do not constrain.** `orders.source_account_key` is an ordinary fact, the detection index `(provider, source_account_key, external_order_id)` is deliberately **non-unique**, and `duplicate_of_order_id` links the later row to the canonical one. Ingestion marks duplicates automatically (canonical = earliest `first_ingested_at` that is not itself a duplicate); pass `markDuplicates: false` to record the fact without acting on it. Every read model excludes marked rows. No evidence is ever deleted.

3. **Partial fulfillment — kept as designed, plus `unknown`.** `order_fulfillments` with `order_fulfillment_lines` per-line quantities. The `fulfillment_status` union gains a fifth member, `unknown`, because Woo's `refunded` status REPLACES the previous status and a fully refunded order no longer says whether it shipped — reporting that as `unfulfilled` asserts a fact nobody observed. Unrecognized plugin statuses map to `unknown` for the same reason. A Woo `completed` order yields one synthesized fulfillment covering every line, with no carrier and no tracking; any other status yields none.

   **eBay makes the depth pay for itself.** `partially_fulfilled` — unreachable from WooCommerce — is exactly eBay's `orderFulfillmentStatus = IN_PROGRESS`, and eBay exposes real `ShippingFulfillment` objects with per-line quantities, a carrier code, a tracking number, and a shipped date. Nothing is synthesized for eBay: a shipment is read through `getShippingFulfillments` (one extra call per shipped order, skipped for `NOT_STARTED`) or it is not recorded. The adapter distinguishes "this fetch did not ask" (`null`) from "eBay reported none" (`[]`); both write zero rows, but only the second is a fact.

   For eBay the `unknown` projection lives in the **adapter**, not in `@loxep/commerce`'s translator — the placement loxep-xh9.7.3 prescribes for new code. An eBay status the adapter does not recognize degrades to `unknown` and sets `statusRecognized: false`, and the sync result carries the offending `provider_status_raw` strings so a vocabulary change is a visible finding rather than a silent floor.

4. **Multi-currency — no FX, at all.** No `base_currency_amount`, no stored rate, no reporting currency. Every read model groups by currency and never sums across them. A fee or refund settled in a different currency than its order is excluded from that order's currency group and counted in `foreignCurrencyFeeCount` / `foreignCurrencyRefundCount`, so the omission is visible rather than silent.

5. **Order status history — deferred.** No `order_status_events` table. Current-state columns only; transitions are reconstructable from `order_source_links` plus retained snapshots. The revisit trigger stands: if reconstruction proves lossy in practice, the table earns its place.

6. **Sync scheduling — `monitor_targets`, target types `woo_orders` and `ebay_orders`.** No second scheduler and no `commerce_sync_cursors` table. Both cursors live under the same namespaced `config.commerceSync` key, exactly as the scheduler's own `config.adaptive` state does, because the cursor's fields are provider-neutral facts; only the `target_type` differs. The ownership question is answered in documentation: [Domain Boundaries](../domain-boundaries/#scheduling-is-shared-foundation-infrastructure) now describes the scheduling model as shared foundation infrastructure domains register target types against — also marked PROVISIONAL.

   **Registration gap, recorded rather than hidden:** `woo_orders` is in `@loxep/market`'s closed `MONITOR_TARGET_TYPES` enum and its `monitorTargetConfigSchemas` record; **`ebay_orders` is not yet**, because `packages/market` was outside the eBay change's write fence. The consequence is narrow: `claimDueTargets`, `recordPollSuccess`, and `recordPollFailure` read `target_type` as text, so claim → route → sync → cursor advance all work, and `@loxep/commerce`'s `ensureEbayOrderSyncTarget` inserts the row directly. What does not work is creating or editing such a row through `createMonitorService`, whose `targetType` is a closed `z.enum`. A test in `packages/app` asserts the gap explicitly so it cannot be forgotten, and closing it is a two-line edit to `@loxep/market`.

   Two implementation notes a reviewer needs:

   - the target type is **`woo_orders`**, not the draft's `woocommerce_orders`, per the implementing directive. `orders.provider` remains `woocommerce`; only the scheduling target type is abbreviated. Renaming later is a data update on one column of a handful of rows;
   - `@loxep/market`'s `createMonitorService` validates `target_type` against a closed enum and looks the config schema up in a closed record, so registration is an edit to those two lists rather than a runtime `registerTargetType()` seam. `woo_orders` is now in both, and `@loxep/app` routes the type to `@loxep/commerce`'s sync service from `market.poll-target`, so the dispatcher, adaptive cadence, and `backoff_until` own scheduled cadence exactly as for every other target type. Everything else already worked untouched, because `claimDueTargets` / `recordPollSuccess` / `recordPollFailure` are target-type-agnostic.

     Two consequences a reviewer should weigh. First, `@loxep/market` now carries a **structural re-declaration** of Commerce's `config.commerceSync` shape — the same discipline it already applies to the eBay search-filter shape, and for the same reason: the scheduler must not depend on a domain that registers against it. Commerce's schema remains the authority for its own service; a test in `packages/app` round-trips a config through both so the duplication cannot drift silently. Second, `@loxep/commerce` keeps its direct insert in `ensureWooOrderSyncTarget` rather than calling `createMonitorService`, because taking a `@loxep/market` dependency is exactly what the registration model exists to avoid. A runtime registration seam would remove the duplication and is the obvious next iteration if a third domain registers a type.

7. **Catalog SKU uniqueness — installation-wide.** `unique(sku)`, not `(economic_entity_id, sku)`. Widening later is additive.

8. **Buyer data — columns hold an identifier and a channel handle, nothing else.** `buyer_external_id` plus an optional `buyer_display_name`, where "display name" means a channel-native handle (an eBay username), **not** a legal name from a billing address. The Woo translator therefore leaves it null: Woo exposes no handle, and copying a customer's real name into a domain column would defeat the line this question draws. The full payload stays in `provider_objects`.

   **The eBay leg is the case the rule was written for**, and it populates the column with `buyer.username` — a handle, not a name. Everything else eBay sends about the buyer stays in the retained payload, and there is considerably more of it than WooCommerce sends: `buyer.buyerRegistrationAddress` (full name, email, phone, street address), `buyer.taxAddress`, `buyer.taxIdentifier.taxpayerId`, `fulfillmentStartInstructions[].shippingStep.shipTo` (full name, email, phone, street address), `lineItems[].giftDetails` (recipient email, sender name, free-text message), and `buyerCheckoutNotes`. Only the ship-to country and region are normalized, exactly as `order_fulfillments` specifies. Per [ADR-0021](../../decisions/0021-order-payload-retention/) the eBay adapter ships `redactEbayOrderFact` alongside `redactWooOrderFact`; the live sandbox leg asserts only on redacted facts, so a failing expectation cannot print a buyer's address.

   **Retention is now decided (PROVISIONAL) by [ADR-0021](../../decisions/0021-order-payload-retention/): order-class payloads are redacted in place after a configurable 180-day default window; provenance rows and `order_source_links` are never automatically deleted.** No retention logic ships with Phase 3 ingestion itself — the sweep is a separate implementation issue. Ingestion retains one `provider_objects` row per distinct payload hash per order — an unchanged re-sync reuses the existing row rather than storing a second copy — which bounds growth but is not itself a retention policy.

### Also implemented from the WooCommerce reality findings

- **`subtotal_amount` stays `not null` and is DERIVED**, not nullable. WooCommerce reports no order-level subtotal; the adapter computes the exact scaled-integer sum of `line_items[].subtotal`, and the derivation is documented on `WooOrderTotals.subtotal`, on the `orders` table, and here. Nullable was rejected because every reader would then re-derive the same sum. Verified live: on a ten-order slice, `subtotal + shipping + tax` reconciled to `total` exactly.
- **`*_gmt` Z-suffix handling stays the adapter's job** (`isoFromWooGmt`), already shipped in Phase 3's WooCommerce child issue. Nothing downstream re-parses provider timestamps.
- **`line_items[].price` is the payload's only float money field.** Where the adapter cannot represent it exactly it returns null, and the translator falls back to the exact quotient of line subtotal by quantity, then to that quotient rounded to `numeric(20,6)`. That rounded value is the only rounded number anywhere in the pipeline and nothing is derived from it — every order and line total comes from the provider.

### Also implemented from the eBay reality findings

- **eBay reports a subtotal.** `pricingSummary.priceSubtotal` is used directly; the exact-summation derivation is kept only as a fallback. The `subtotal_amount not null` decision costs nothing here.
- **eBay reports no unit price.** `order_lines.unit_price` is derived as the EXACT `lineItemCost / quantity`; the adapter returns null rather than rounding a non-terminating quotient, and the translator then falls back to that quotient rounded to `numeric(20,6)` — the same single-rounded-value discipline the Woo leg uses, and nothing is derived from it.
- **eBay apportions delivery cost per line** (`lineItems[].deliveryCost.shippingCost`), so `order_lines.shipping_amount` is a provider fact rather than the `0` the Woo leg writes.
- **Per-line refunds are real.** `lineItems[].refunds[]` are matched onto `paymentSummary.refunds[]` by `refundId`, so `order_refund_lines` is populated for eBay where Woo's embedded summary names no lines. A refund line naming an unknown line id becomes an order-level refund line (the column is nullable for exactly that), while a *fulfillment* line naming an unknown line id is dropped, because `order_fulfillment_lines.order_line_id` is `not null` and fabricating a line to satisfy it would invent a fact.
- **`source_account_key` is `ebay:<sellerId>`**, computed from the order payload itself, confirming the design's guess and the detect-don't-constrain recommendation for a second provider.
- **eBay's timestamps need no repair** — ISO-8601 with an explicit `Z`, unlike WooCommerce's `*_gmt` fields.
- **eBay's watermark filter bracket is INCLUSIVE** (`lastmodifieddate:[<from>..]`), the opposite of WordPress's exclusive `modified_after`. Handing back the last watermark seen therefore re-reads the boundary order rather than skipping it, which is the safe direction; the one-second rewind is kept anyway.

### Other divergences from the draft

- `order_fulfillments.status` gets its own documented union (`pending | shipped | delivered | cancelled | unknown`); the draft named the column without listing values.
- `fee_type` gains a `buyer_surcharge` member, pairing with `fee_direction`.
- eBay's aggregate seller fee is written as `fee_type = 'marketplace_final_value'` with `provider_fee_code = 'totalMarketplaceFee'`. It is the closest member of the draft's union, but the value is an **aggregate**, not strictly a final value fee — see the reviewer list below.
- `@loxep/commerce` re-declares the eBay adapter's fact types structurally rather than importing them, so the domain package takes no dependency on `@loxep/integration-ebay`. This is the discipline `@loxep/market` already applies to eBay's search-filter shape and that `decimal.ts` applies to Woo's money helpers; the Woo translator's direct import predates it. The duplication is guarded by `packages/app`'s eBay sync test, which passes a REAL adapter fact through the translator — if the two shapes drift, that file stops compiling.
- The Woo `refunded`/unrecognized-status re-mapping to `unknown` lives in `@loxep/commerce`'s translator rather than in the adapter's `WOO_STATUS_MAP`, only because `packages/integrations/woo` was outside the implementing change's write fence. Its correct long-term home is the adapter; a follow-up moves it.
- Profitability read models expose both `feeAmount` (the provider's own seller-fee rollup on `orders`) and `sellerChargeFeeAmount` (the sum of `seller_charge` fee rows in the order's currency). The draft's contribution formula uses the rollup; a persistent gap between the two is a reconciliation finding, which is exactly the treatment the draft prescribes for provider-reported rollups.

### What a reviewer should push back on first

In rough order of how expensive each is to reverse after data exists:

1. **`fee_direction`** — a new column and a new semantic, invented during implementation rather than during design. If buyer surcharges should instead be absent for Woo, or modelled as a separate concept entirely, that decision is cheapest now. (The eBay leg, which reports both polarities on one order, is evidence for keeping it.)
2. **eBay's aggregate fee typed as `marketplace_final_value`.** The Sell Fulfillment API reports only `totalMarketplaceFee` — the total eBay charges the seller, predominantly but not exclusively the final value fee — and offers no breakdown; itemization needs the **Finances** API (`getTransactions`), which is Phase 5 payout territory. The alternatives were `other` (unhelpful for the largest fee in the system) or a new `marketplace_aggregate` union member. `fee_type` is `text` with no `CHECK`, so adding that member later is free, and `provider_fee_code` already carries the evidence — but the name that ships is a claim, and this is the cheapest moment to change it.
3. **Automatic duplicate marking.** Detection is uncontroversial; automatically writing `duplicate_of_order_id` at ingest is a judgement call about how much an adapter-computed `source_account_key` is trusted.
4. **`fulfillment_status = 'unknown'`** — widening a union is easy; narrowing it after rows carry the value is not.
5. **Synthesizing a fulfillment for a Woo `completed` order.** It is a faithful reading of "what the channel said", but it is a reading. (The eBay leg synthesizes nothing, because eBay has real shipment objects — the asymmetry is deliberate but worth confirming.)
6. **Reading eBay shipments by default.** `includeFulfillments` defaults to true, which costs one extra provider call per shipped order in a page. The alternative is an order marked `fulfilled` with no shipment rows behind it.
7. **The `woo_orders` / `ebay_orders` target type names**, the missing `ebay_orders` registration in `@loxep/market`, and the scheduling-ownership documentation edit.
8. **Line tax when eBay reports it twice.** `lineItems[].taxes[]` is preferred and `ebayCollectAndRemitTaxes[]` is a fallback used only when the first is empty, because summing both would double-count in jurisdictions that populate both. This is design-derived and is the mapping most likely to be corrected by the live leg.

## Open questions

Each item is a genuinely unresolved decision with a recommendation, not a placeholder. **All eight are now implemented per their recommendation and marked PROVISIONAL** — see [Provisional implementation decisions](#provisional-implementation-decisions). They are retained verbatim below because the recommendation is not the same thing as the answer, and the review needs the original reasoning.

1. **Per-line versus per-order fee attribution.** Providers report some fees per order and some per line, and profitability by SKU wants all of them per line. Should ingestion allocate order-level fees down to lines? *Recommendation: no.* Store fees exactly at the granularity reported (`fee_scope` + nullable `order_line_id`) and treat allocation as a derived reporting concern introduced in Phase 4 alongside cost basis, where it can use the same allocation basis as COGS. Allocating at ingest bakes a reversible choice into a source-fact table.

2. **Cross-connection duplicate orders — detect or constrain?** The order key is connection-scoped, so two connections against the same seller account produce two rows for one sale. *Recommendation: detect, do not constrain.* Ship `source_account_key`, a detection index, and `duplicate_of_order_id`, and revisit a partial unique on `(provider, source_account_key, external_order_id)` only after real adapters prove `source_account_key` is reliable per provider. A wrong constraint fails ingestion; a wrong report is fixable.

3. **Partial-fulfillment modeling depth.** Phase 3 proposes fulfillments plus per-line quantities, and stops before packages, labels, dimensions, and postage. Is per-line quantity already too much, or not enough? *Recommendation: keep it as designed.* Per-line quantity is the minimum at which `partially_fulfilled` is a checkable claim rather than a label, and it is the join point Phase 4 shipments need. Anything more is Shipping-domain work.

4. **Multi-currency handling.** Orders in USD, GBP, and EUR cannot be summed. Should Phase 3 store converted base-currency amounts and an FX rate on each order? *Recommendation: no conversion in Phase 3.* Store the provider currency only, and have every view group by currency. Conversion requires an installation reporting currency, a rate source, a rate-date policy, and a decision about whether to freeze the rate at sale or revalue — all of which are Phase 5 financial concerns. Adding `base_currency_amount` columns later is additive; storing wrong rates now is not reversible.

5. **Order status history — table or derived?** The domain map lists "status history" under Commerce. Phase 3 keeps current-state columns only. *Recommendation: defer.* Status transitions are reconstructable from `order_source_links` plus retained snapshots, and an explicit `order_status_events` table earns its place in Phase 4 when fulfillment workflows actually branch on transitions. Revisit if reconstruction proves too lossy in practice — that is a concrete trigger, not a vague "later".

6. **Where does order-sync scheduling state live?** Reusing `monitor_targets` with new target types (`ebay_orders`, etc.) avoids building a second scheduler, but `monitor_targets` is documented as Market Intelligence-owned. *Recommendation: reuse it, and make the ownership explicit in documentation first* — reclassify the scheduling model as shared foundation infrastructure that domains register target types against, via a small edit to Domain Boundaries and, if the reviewer judges it a rule change, an ADR. The fallback if that is rejected is a `commerce_sync_cursors` table. This needs a human decision **before** Phase 3 implementation starts, because it changes which package owns the sync job.

7. **Catalog SKU uniqueness scope.** `unique(sku)` installation-wide, or `(economic_entity_id, sku)`? *Recommendation: installation-wide.* Two operating identities using the same SKU string for different goods produces silently wrong profitability, and the per-entity variant has a nasty null-entity case. Widening later is additive if a real conflict appears.

8. **Buyer data retention before Phase 6.** Phase 3 normalizes only `buyer_external_id` and an optional display name, leaving names, emails, and addresses in retained provider payloads. Is that the right line for support workflows — and does it imply a retention policy on `provider_objects` for order payloads? *Recommendation: hold the line on columns, and treat provenance retention as a separate policy decision.* Order payloads contain personal data that marketplace observation payloads do not, so "no automatic retention deletion by default" may need revisiting for this object class specifically. Flagging rather than deciding: this is a policy question, not a schema one.

### Provider reality findings (WooCommerce, live-verified)

The Woo adapter was implemented against a live production store before this design's review; its findings bear directly on the open questions above:

- WooCommerce exposes **no order-level subtotal** — the draft's `subtotal_amount not null` must be derived (exact scaled-integer summation of line subtotals) and should be marked as derived or made nullable.
- **Woo `fee_lines` are buyer-facing surcharges inside `orders.total`, not platform fees charged to the seller** — WooCommerce core reports no seller-side fees at all (gateway charges live outside the API). The `order_fees` concept needs a per-provider semantic decision: inverted-sign rows, a separate buyer-charge concept, or absence for Woo.
- Woo's single status lifecycle maps lossily onto the draft's three: `partially_fulfilled` is unreachable, `refunded` erases prior fulfillment knowledge (a fulfillment-state `unknown` member is a candidate addition), and `partially_refunded` must be derived from the refunds array.
- `source_account_key` is confirmed cheaply computable for Woo (`woocommerce:<normalizedSiteUrl>`) — supporting the detect-don't-constrain recommendation.
- Payload traps recorded in the adapter: `number` is a string, `line_items[].price` is the lone float money field, `*_gmt` timestamps carry no zone designator (must append `Z`), and plugin-injected top-level keys mean mapping must be key-driven.
- Order payloads carry substantial buyer PII (addresses, email, phone, IP, UA) — open question 8's provenance-retention concern is confirmed real; the adapter ships a `redactWooOrderFact` helper pending the policy decision.

### Provider reality findings (eBay, fixture-verified — NOT yet live-verified)

The eBay adapter reads the **Sell Fulfillment API v1** (`GET /sell/fulfillment/v1/order`) through hendt/`ebay-api` v10, per [ADR-0009](../../decisions/0009-integration-boundaries/). Every container and field name below was read out of the installed client's bundled OpenAPI types (`ebay-api@10.0.0`, `lib/types/restful/specs/sell_fulfillment_v1_oas3.d.ts`: `Order`, `LineItem`, `PricingSummary`, `PaymentSummary`, `OrderRefund`, `LineItemRefund`, `Amount`, `CancelStatus`, `Buyer`, `FulfillmentStartInstruction`, `ShippingFulfillment`).

**What is not yet verified, and why it matters.** That schema types every status field as a plain `string` and enumerates nothing, so the status VOCABULARIES (`PAID`, `FULLY_REFUNDED`, `NOT_STARTED`, `IN_PROGRESS`, `FULFILLED`, `CANCELED`, `REFUNDED`, …) and the `filter` range/set grammar come from eBay's published documentation rather than from an observed payload. They are **design-derived**. The adapter is built so that being wrong about them degrades rather than breaks: an unrecognized status maps to the documented floor, sets `statusRecognized: false`, and leaves the provider's own strings in `provider_status_raw`. A live sandbox leg (`packages/integrations/ebay/test/live-orders.test.ts`) exists to close this out and **skips cleanly today**, because it needs a user token consented for the Sell Fulfillment scope and no such artifact exists yet.

The findings themselves:

- **eBay has no single order status.** It reports payment, fulfillment, and cancellation as three independent axes and nothing that means "the order overall". `orders.status` is therefore DERIVED (`cancelState = CANCELED` → `cancelled`; `orderFulfillmentStatus = FULFILLED` → `completed`; paid or refunded → `open`; otherwise `pending`), and `provider_status_raw` holds a COMPOSITE of the strings eBay actually sent (`"<payment>/<fulfillment>"`, plus `"/<cancelState>"` when a cancellation is in play) because there is no single provider field to quote. This is the opposite failure mode from WooCommerce, which has one status where the design wants three.
- **`orders.fee_amount` is finally non-zero.** `Order.totalMarketplaceFee` is a genuine seller-side deduction, so eBay is the first provider for which the contribution formula subtracts anything. It is an aggregate, not itemized — see the reviewer list.
- **Both fee polarities appear on one order**, confirming `fee_direction`: `totalMarketplaceFee` is a `seller_charge`, `pricingSummary.fee` is a `buyer_surcharge` already inside the order total.
- **`partially_fulfilled` is reachable** (`orderFulfillmentStatus = IN_PROGRESS`), and real `ShippingFulfillment` objects carry per-line quantities, a carrier code, a tracking number, and a shipped date — the depth open question 3 defended.
- **`source_account_key = 'ebay:<sellerId>'`** is computable from the payload alone, as the draft guessed.
- **`buyer_display_name` has its intended occupant**, the eBay username; nothing else about the buyer leaves the retained payload.
- **The order payload carries more PII than WooCommerce's**, including a taxpayer id and gift-recipient details — see open question 8 as implemented.
- **Scope, not just consent.** Unlike the traditional Trading calls the watchlist vertical uses, the RESTful Sell APIs enforce OAuth scopes: order ingestion needs `.../sell.fulfillment.readonly`, which the base consent set deliberately does not request (asking for a scope a keyset lacks makes eBay reject the entire consent with `invalid_scope`). An existing eBay connection must be re-consented with `EBAY_ORDER_CONSENT_SCOPES` before it can sync orders; until then the poll fails `auth`, records `ebay_auth` on the connection, and drops the cached adapter so a re-consent is picked up on the next poll.

## Contradictions and tensions found in existing documentation

Recorded here for a human to resolve; this document does not attempt to fix them.

1. **Fee and fulfillment facts are claimed by two phases.** The roadmap's Phase 3 includes "related fee/fulfillment facts", while Phase 4 separately lists "Marketplace/payment fees", "Shipments and tracking", and "Actual outbound shipping costs". This design resolves the overlap by splitting on *what the fact is about*: Phase 3 owns fees and fulfillment as **order-attached channel facts**, Phase 4 owns payout/processor-level fees, carrier shipments, and actual postage cost. The roadmap wording should be tightened to match whichever split is accepted.

2. **`monitor_targets` ownership versus its role as the only scheduler.** Domain Boundaries assigns monitor targets to Market Intelligence, while the Foundational Data Model presents the scheduling model as the general mechanism for due-work discovery and explicitly anticipates new target types. Phase 3 needs scheduled order polling. Either the scheduling model is shared foundation infrastructure, or Commerce needs its own scheduling table. See open question 6.

3. **"Product costs/sale prices" sits under Commerce/NEXT in the domain map**, which reads as Phase 3 scope, while cost basis is unambiguously Phase 4 in the roadmap and Inventory-owned in Domain Boundaries. This design takes the narrow reading — `catalog_items.default_price` is a catalog attribute, cost is excluded entirely — but the domain map bullet invites the wrong interpretation and should be split into "sale prices (Catalog)" and "cost basis (Inventory, Phase 4)".

4. **Catalog appears in three places with three groupings.** Domain Boundaries defines a distinct "Catalog and Listings" domain; the roadmap folds catalog/SKU work into Phase 3 commerce ingestion; Workspaces lists catalog/SKUs under the Commerce workspace. These are consistent under the "workspace UX is not domain ownership" rule, but nothing says so at the point of confusion. A one-line note in the roadmap's Phase 3 section would prevent an implementer from merging the two domains into one package.

## Before implementing this schema

Retained as the original pre-implementation checklist. Items 1, 3, 5, 6, and 7 were satisfied during the provisional implementation; item 2 (human confirmation of attribution precedence and immutability) is still outstanding; item 4 is satisfied for WooCommerce (live) and **partially** for eBay (verified against the installed client's bundled OpenAPI types, with the status vocabularies and filter grammar still design-derived — see the [eBay findings](#provider-reality-findings-ebay-fixture-verified--not-yet-live-verified)) and still outstanding for Medusa; item 5 is now confirmed for eBay as well; and item 8 is what the [provisional decisions](#provisional-implementation-decisions) section discharges.

1. resolve open question 6 (sync scheduling ownership) — it determines package boundaries, not just table shapes;
2. confirm the attribution precedence and its immutability rule with a human; it is the hardest thing to change after data exists;
3. verify current Drizzle Kit support for `UNIQUE NULLS NOT DISTINCT`, partial unique indexes, and `num_nonnulls` checks, and fall back to hand-written SQL rather than weakening any constraint;
4. verify current eBay Sell/Fulfillment, WooCommerce, and Medusa order payload shapes against upstream documentation before fixing the status unions and fee types — the values listed here are starting points from design, not from observed payloads;
5. confirm that each provider adapter can compute `source_account_key` deterministically; if one cannot, that provider's duplicate detection degrades and open question 2 changes shape;
6. write the ingestion idempotency tests before the ingestion code: same payload twice, out-of-order updates, attachment rewrite, and re-attribution must all be covered against real PostgreSQL;
7. keep provider SDK types at the integration boundary (ADR-0009) — none of the columns above may be typed from a provider library;
8. update this document, the roadmap, and Domain Boundaries when implementation reality diverges, rather than letting the documentation drift.
