---
title: Inventory & Acquisition Schema Design (Phase 4)
---

This document is the physical schema design for [Phase 4 — Inventory, acquisition, and fulfillment](../../product/roadmap/#phase-4--inventory-acquisition-and-fulfillment). It stands in the same relationship to Phase 4 that [Commerce Schema Design (Phase 3)](../commerce-schema-design/) stands in to Phase 3: a concrete migration target with table sketches, constraints, and the reasoning behind them, written before any migration exists.

It **extends** the foundation and the Phase 3 design. Where an existing table, convention, or ADR already answers a question, that answer is reused rather than restated differently. Nothing here changes an already-implemented table, and nothing here alters a table Phase 3 has already designed — every Phase 3 reference is an outbound foreign key added by Phase 4.

Design work only. No migration, Drizzle schema, or inventory service code is authorized by this page; the exact column types and constraints must be re-verified against the current PostgreSQL/Drizzle behavior immediately before implementation, per the [dependency policy](../../development/dependency-policy/).

**Phase 4's migration cannot run before Phase 3's.** `inventory_allocations`, `inventory_movements`, `shipments`, and `shipment_items` all carry foreign keys into `order_lines`, `order_fulfillments`, and `order_fees`. This is a hard ordering dependency, not a preference — see [Migration plan sketch](#migration-plan-sketch).

## Scope

Loxep is a reseller's tool before it is anything else. The shape of this schema follows from one fact about resale sourcing: **goods arrive in lots, the lot's cost is often the only cost that was ever quoted, and the contents of the lot are discovered over the following days or weeks.** A schema that assumes a purchase order with priced lines, or that assumes cost is known per unit at the moment of purchase, describes a wholesale business Loxep is not built for.

Phase 4 adds the physical tables required to follow a physical good from acquisition through sale:

- `acquisitions` — one purchase, lot, haul, or intake event;
- `acquisition_costs` — every money component of that acquisition, at lot or item scope;
- `inventory_locations` — a simple tree of physical places;
- `inventory_items` — a held stock unit with its own specific-identification cost basis;
- `inventory_allocations` — reservations of stock against Phase 3 `order_lines` and other holds;
- `inventory_movements` — the append-only ledger of what physically happened;
- `shipments` — outbound carrier reality, including actual postage;
- `shipment_items` — what was in the box;
- `acquisition_opportunity_links` — the lightweight bridge from a scored market opportunity to the acquisition it caused and the outcome it produced.

Nine new tables. No existing table gains a column — see [Which existing tables gain columns: none](#which-existing-tables-gain-columns-none).

The domains involved are **Inventory and Acquisition** (acquisitions, items, locations, movements, allocations, cost basis) and **Shipping and Fulfillment** (shipments, packages, actual postage), which remain distinct ownership boundaries per [Domain Boundaries](../domain-boundaries/#inventory-and-acquisition) even though both land in the same phase. The opportunity link is a Market-Intelligence-adjacent record that Inventory owns, for the same reason `channel_listings` is owned by Catalog rather than Market: it is a fact about our decision, not about the world.

## What Phase 4 does not create

Phase 4 stops at operational goods facts and their realized outcomes. It deliberately does not create:

```text
inventory valuation / revaluation / LCM        Phase 5 — a balance-sheet number needs a book to sit on
inventory aging / turnover / carrying cost     Phase 5 (Reporting) — derived from these tables, not stored
write-down and impairment policy               Phase 5 — a valuation judgement, not a movement
vendors as records / purchase orders / bills   Later (Purchasing) — acquisitions carry a vendor NAME only
AP, vendor credits, payment terms              Later — the obligation half of buying
receiving against an expected PO               Later — Phase 4 receiving is "a lot showed up"
multi-warehouse logistics / wave picking       Later — the location tree is a tree, not a WMS
bin capacity, slotting, cycle-count programs   Later — counts exist as adjustment movements only
serial-number lifecycle / warranty registry    Later — a serial is a text column, not a subsystem
grading submissions and turnaround workflow    Later — the grade is a fact; submitting for it is a workflow
landed-cost automation from carrier documents  Later — Phase 4 allocates costs an operator entered
assemblies, kits, bundles, BOM consumption     Later — Phase 3 already deferred the commercial definition
payout-level and processor-level fees          Phase 5 — unchanged from the Phase 3 split
accounting_books / COGS journal entries        Phase 5 (ADR-0017) — the ledger is downstream
counterparties / consignor accounts            Phase 6 — a consignor is a counterparty
opportunity ROI analytics / predictive models  Later (Reporting) — Phase 4 stores the link, not the study
per-item/per-location ACLs                     Still none (ADR-0017); membership remains installation-wide
```

Two of these deserve emphasis because they are the most likely to be smuggled in during implementation:

- **Valuation is not cost basis.** Cost basis is what was paid for a specific unit — a historical fact that never changes once it is established. Valuation is a judgement about what stock is worth now, which requires a reporting date, a policy, and a book to post the adjustment to. Phase 4 stores the fact. Phase 5 forms the judgement. `inventory_items.estimated_value_amount` exists in this design and is explicitly **not** a valuation: it is the operator's target resale price, recorded because it is the input to lot cost allocation, and it must never be summed into a balance-sheet figure.
- **Purchasing is not acquisition.** Purchasing owns intent and obligation to a vendor before goods exist ([Domain Boundaries](../domain-boundaries/#purchasing)). Acquisition owns the moment goods became ours. A reseller buying a box at an estate auction has no purchase order, no vendor master record, and no payable — the money left at the same instant the goods arrived. Phase 4 models that, and a real Purchasing domain later attaches to `acquisitions` rather than replacing it.

## Conventions inherited from the foundation

Nothing below invents a convention. From the [Foundational Data Model](../foundational-data-model/), the [Foundation Schema Draft](../foundation-schema/), and the [Implementation Contract](../../development/implementation-contract/):

- UUID primary keys with `defaultRandom()`; provider and external identifiers are stored separately as text and never become Loxep keys;
- all instants are `timestamptz` with semantic names (`acquired_at`, `occurred_at`, `shipped_at`, `depleted_at`);
- money is `numeric(20,6)` plus an ISO currency code; no persisted arithmetic in JavaScript `number`;
- quantities are `numeric(20,6)`, matching `order_lines.quantity`, because Phase 4 is exactly the phase the Phase 3 design predicted would handle goods sold by weight or length;
- state columns are `text` with application-owned TypeScript unions, never PostgreSQL enums;
- `CHECK` constraints only for genuinely closed sets. Every closed set in this design is **Loxep-owned** — there is no provider inventing inventory states — so Phase 4 uses more `CHECK`s than Phase 3 did, and that difference is deliberate rather than inconsistent;
- no `payload` or free-form attribute `jsonb` column on any table below. Raw provider JSON stays at the provenance boundary;
- user-reference columns follow ADR-0020: nullable FK to the Better Auth user id with `ON DELETE SET NULL`;
- no credentials, tokens, or secret material appear in any of these tables (ADR-0019);
- movement idempotency uses `deduplication_key text not null unique`, reusing the exact mechanism `market_events` already uses for at-least-once worker retries.

Inventory is ordinary transactional relational data. **No table in this design is a Timescale hypertable.** A movement ledger looks temporal and is not: it is a small set of discrete business facts with foreign keys pointing at it, and hypertable partitioning would buy nothing while costing referential integrity. Inventory KPI *snapshots* over time are a genuinely temporal series and are Phase 5 Reporting work.

## Economic-entity attribution on inventory and acquisition facts

The roadmap's requirement is "economic-entity ownership/context for stock and acquisition workflows where needed", and [Domain Boundaries](../domain-boundaries/#inventory-and-acquisition) sharpens it: "Inventory ownership/location design must allow entity attribution where required rather than assuming all stock in an installation belongs to one business."

Phase 4 applies the ADR-0017 pattern Phase 3 established, with one deliberate divergence.

### Attribution is a stored column on `acquisitions` and again on `inventory_items`

Both tables carry a nullable `economic_entity_id` plus `entity_attribution_source`, `entity_attributed_at`, and `entity_attributed_by_user_id`. The item does not read its entity through its acquisition.

Duplicating the column is justified where Phase 3 declined to duplicate it onto `order_lines`, and the difference is real:

1. **An inventory item can exist without an acquisition.** Opening balances, found stock, goods converted from personal property, and units restocked from a customer return all produce items with a null `acquisition_id`. A derived-through-acquisition attribution would leave exactly the cases a small operator cares most about unattributed.
2. **One lot can legitimately split across entities.** An estate-auction haul bought on a personal card may be partly kept personally and partly contributed to an LLC's resale stock. That is a single acquisition and two ownerships.
3. **Stock is a held asset, and held assets change hands.** An order is a completed past event, so Phase 3 could make attribution immutable and be done. An inventory item is a thing you still own, and transferring it between operating identities is a real, tax-significant event. Attribution must be *recorded per item* for the transfer to be expressible at all.
4. **Phase 5 must read attribution, not recompute it.** Unchanged from Phase 3's reasoning: an attribution that changes when configuration changes is not a fact.

### Attribution precedence

At acquisition creation:

```text
1. explicit value chosen by the operator            entity_attribution_source = 'manual'
2. the installation's default entity setting        entity_attribution_source = 'installation_default'
3. snapshot of connections.economic_entity_id       entity_attribution_source = 'connection_default'
   (reserved: for a future ingested-purchase path)
4. no attribution available                         entity_attribution_source = 'unattributed'
                                                    economic_entity_id is null
```

An inventory item created from an acquisition snapshots the acquisition's entity with source `acquisition_default`; an item created any other way follows the same ladder as an acquisition.

`installation_default` earns its place because Phase 4's dominant reality is a single-entity installation whose operator should not retype the same entity four hundred times, and because an entity that arrived by default must remain distinguishable from one a human chose — the same eligibility-marker argument that motivated `connection_default` in Phase 3. `connection_default` is included in the `CHECK` now, unused, because the ingested-purchase path (eBay purchase history becoming acquisitions) is a foreseeable near-term addition and widening a `CHECK` on a table that already has rows is a migration nobody should have to write for one string.

### Entity attribution on an item is immutable; a change of owner is a transfer, not an `UPDATE`

This is the rule that keeps Phase 4 consistent with Phase 3 while still supporting a genuine change of ownership.

Moving stock from personal ownership to an LLC does **not** update `inventory_items.economic_entity_id`. It creates a paired transfer: a `transfer_out` movement against the original item and a `transfer_in` movement against a **new** `inventory_items` row owned by the receiving entity, linked by `origin_item_id` and sharing a `transfer_group_id`. The original row remains, depleted, with its history and its basis intact.

Why the harder thing is the right thing:

- the pre-transfer holding period, cost basis, and realized/unrealized history of the original entity survive verbatim, which is exactly what a change of tax ownership needs;
- the movement ledger contains the transfer as an event, so "when did this leave personal ownership" is answerable by query rather than by audit-log archaeology;
- it forces the open and correct question — is the receiving entity's basis the carried-over cost or fair market value? — to be answered explicitly on the new row instead of silently inheriting;
- and it preserves the Phase 3 invariant that entity attribution, once written, is never rewritten. One rule, two phases.

Re-attribution of rows whose source is `installation_default`, `acquisition_default`, or `unattributed` remains an explicit, audited bulk operator action that must never rewrite `manual` rows, and every run writes `audit_events` — identical to Phase 3.

### What does not carry an entity

`inventory_locations` carries no `economic_entity_id`. A shelf does not belong to an LLC; the stock on it does, and two entities' goods routinely share one bin in a spare bedroom. Attributing the location would either force duplicate location trees per entity or silently imply an ownership the physical world does not have.

`inventory_movements`, `inventory_allocations`, `shipment_items`, and `acquisition_costs` do not duplicate the entity column either. They inherit it from their item or acquisition, which is the Phase 3 rule applied unchanged.

Nothing here approaches accounting books. There is no `accounting_book_id` in Phase 4, and no assumption that one entity equals one book.

## Cost basis: specific identification

This is the load-bearing decision of Phase 4, and the roadmap and [Master Domain Map](../../product/master-domain-map/#4-inventory-acquisition-purchasing-and-vendors) leave it open — the map lists "FIFO, weighted-average, and specific-identification policies where appropriate" as DESIGN-FOR. Phase 4 picks one for NOW and argues it.

### The recommendation

**Specific identification, as a column on the stock row, with no cost-layer table.**

`inventory_items` carries `acquisition_cost_amount` and `landed_cost_amount` directly. There is no `inventory_cost_layers`, no `cost_layer_consumptions`, and no running average maintained anywhere.

### Why specific identification for one-of-a-kind resale goods

1. **The goods are not fungible, and cost-flow assumptions exist only for fungible goods.** A vintage Pyrex bowl bought for $2 at a thrift store and a near-identical one bought for $40 at auction are different assets with different bases. FIFO would assign the $2 basis to whichever sold first, report a fictitious margin on it, and strand a $40 basis on a $2 item. Both numbers are wrong, and they are wrong in a way that averages out only if the goods really are interchangeable — which is precisely the assumption resale violates.
2. **The information FIFO exists to approximate is already present.** FIFO is a convention for when you cannot tell which unit left. Resale fulfillment is physical and individual: the operator picks *that* item off *that* shelf, and very often photographed that exact unit for the listing. Adopting an assumption to replace knowledge you already have is a loss, not a simplification.
3. **"Per-item realized profitability" is the phase's headline deliverable, and it is self-contradictory under an assumed cost flow.** A per-item margin computed from a cost the item never had is a number with a decimal point and no meaning.
4. **It is the most information-preserving choice, and this is decisive.** A dataset that records which unit cost what can always be re-reported under FIFO or weighted average afterwards — the ordering and the averages are both computable from the specific facts. A dataset that only ever recorded layers and consumptions can never be re-reported specifically, because the link between the unit and its cost was never written down. When one option is reversible and the other is not, and both cost the same today, the reversible one wins.
5. **It matches how the operator already thinks and how unique goods are legitimately reported for tax.** "What did I pay for this thing" is the question a reseller asks. The schema should answer that question directly rather than reconstruct it.

### Why this does not close the door on FIFO

The important structural point: **specific identification and FIFO are not different schemas here. They are different selection policies over the same rows.**

An `inventory_items` row is already a cost layer in every respect that matters — a quantity, acquired at one moment, from one lot, at one unit cost, in one condition, at one location. Commodity stock (a case of 100 identical phone cases, shipping supplies, blank media) is naturally represented as a single row with `quantity = 100`. Buying another case next month creates a second row. That is a layer stack, expressed in the table that already exists.

So the costing method is decided at **allocation time, by what the allocation identifies**, and needs no schema at all:

```text
the allocation names a specific inventory_items row   -> specific identification
   (the operator picked this unit; the dominant case)

the allocation names only a catalog_item + quantity   -> the picker chooses rows,
   (commodity stock, no unit distinguishable)            oldest acquired_at first = FIFO
```

The picker is a function in `@loxep/inventory`, not a table. Weighted average, if a commodity SKU ever genuinely needs it, is a reporting-time computation over the same rows. The exit path from specific identification to any other method is therefore *no migration* — which is the strongest possible form of "not closing the door".

Where a per-SKU costing policy eventually becomes necessary, it is an additive `costing_method` column on `catalog_items` or a small `inventory_costing_policies` table. Phase 4 does neither, because [`catalog_items`](../commerce-schema-design/#catalog-and-channel-listings) is a Phase 3 design surface this document declines to modify — see [open questions](#open-questions).

### Cost basis freezes at first depletion

`inventory_items.cost_basis_locked_at` is set the moment the item's first `depletion_sale` movement is written.

Until then, basis is provisional and re-allocation across an open lot is allowed and expected — you cannot allocate a $250 lot across forty items until you have found the fortieth. After the first sale, the basis has fed a realized-profitability figure and will feed a Phase 5 posting, and rewriting it would retroactively change reported margin on a closed sale. Re-allocating a lot that contains locked items redistributes only the unlocked remainder:

```text
allocatable pool = lot landed cost − sum(basis of locked items)
```

If that pool is negative, the re-allocation is refused and the operator is shown the conflict. It is not silently clamped.

## Acquisitions

### Source shapes this table must survive

The `source_kind` closed set is not decoration; each value names a genuinely different combination of where cost is known, what ancillary costs attach, and when contents are discovered.

```text
source_kind          cost is known at    typical ancillary costs        contents discovered
-------------------- ------------------- ------------------------------ --------------------
auction_lot          lot only            buyer's premium, lot fee,      after pickup, over
                                         sales tax, pickup fuel          days or weeks
estate_sale          lot, or per tag     sales tax, hauling              at unpack
thrift_retail        per item (tagged)   sales tax                       at purchase
retail_arbitrage     per item (receipt)  sales tax, less coupons and     at purchase
                                         cashback
liquidation_pallet   lot only            inbound freight, pallet fee,    at unpack; a manifest
                                         disposal of unsellable          may or may not exist
wholesale_purchase   per item (invoice)  inbound freight, duty           at receipt
online_marketplace   per item            platform fee, inbound postage   at receipt
trade_in             lot, or per item    —                               at intake
consignment_intake   not owned; no cost  —                               at intake
personal_conversion  no cash cost        —                               at intake
customer_return      restored basis      return postage                  on receipt
found_stock          no cost; opening    —                               at count
                     balance
```

Two of these are the reason `inventory_items.acquisition_cost_amount` defaults to zero rather than being `not null` with no default: `consignment_intake` goods are held but not owned, and `personal_conversion` goods have a basis that is a tax determination (generally the lower of original cost or fair market value at conversion), not a purchase price. Both are recorded as items with zero or operator-entered basis and a `source_kind` that makes the zero legible. See [open questions](#open-questions) on consignment.

`retail_arbitrage` is the case that proves the lot model is not over-general in the wrong direction: cost *is* known per item there, and the schema must not force an artificial allocation. It handles this with `acquisition_costs.cost_scope = 'item'` and `inventory_items.cost_allocation_basis = 'direct'` — the same tables, a different basis value.

### `acquisitions`

```text
acquisitions
id                            uuid primary key
economic_entity_id            uuid null references economic_entities(id)
entity_attribution_source     text not null
entity_attributed_at          timestamptz null
entity_attributed_by_user_id  text null references user(id) on delete set null
source_kind                   text not null
status                        text not null
reference_code                text not null
title                         text not null
vendor_name                   text null
vendor_location               text null
external_reference            text null
connection_id                 uuid null references connections(id)
currency                      char(3) not null
cost_allocation_basis         text not null
cost_allocation_status        text not null
acquired_at                   timestamptz not null
received_at                   timestamptz null
closed_at                     timestamptz null
expected_item_count           integer null
notes                         text null
created_by_user_id            text null references user(id) on delete set null
created_at                    timestamptz not null
updated_at                    timestamptz not null
unique(reference_code)
check(entity_attribution_source in
      ('manual','installation_default','connection_default','unattributed'))
check(source_kind in ('auction_lot','estate_sale','thrift_retail','retail_arbitrage',
                      'liquidation_pallet','wholesale_purchase','online_marketplace',
                      'trade_in','consignment_intake','personal_conversion',
                      'customer_return','found_stock','other'))
check(cost_allocation_basis in ('equal','relative_value','weight','manual','direct'))
check(cost_allocation_status in ('pending','provisional','final'))
```

Notes:

- **`acquisitions` carries no money columns except `currency`.** This is the deliberate inverse of the Phase 3 rule, and the inversion has a reason. On `orders`, amounts are *provider-reported facts* that must be stored verbatim because an external authority asserted them and a mismatch against the lines is evidence, not an error. On an acquisition, Loxep is the only authority: every number came from an operator typing components into `acquisition_costs`. Storing a total alongside them would create two sources for one number with no external arbiter, and the only possible outcome of a disagreement is that one of them is a bug. Landed cost is a `sum()` over a handful of rows, on a table with hundreds of rows per year.
- `status`: `draft | open | receiving | costed | closed | cancelled`. TypeScript union, no `CHECK` — this is a workflow label likely to grow, and unlike `source_kind` nothing downstream branches on unknown members. `cost_allocation_status` *does* get a `CHECK` because the cost engine branches on it.
- `reference_code` is a short human/scannable identifier (`ACQ-2026-0184`) generated by the domain service. Resellers label boxes; a UUID is not a label. Unique installation-wide for the same reason `catalog_items.sku` is.
- `vendor_name` and `vendor_location` are **denormalized text, deliberately**. A vendor record is a Purchasing/Counterparty concept, and creating a party master row for "Goodwill on Route 9" is a data-hygiene liability, not an asset. When Purchasing arrives it adds a nullable `vendor_id` and backfills by matching — the identical treatment Phase 3 gave `buyer_external_id`.
- `connection_id` is nullable and normally null. It exists for the foreseeable path where a marketplace purchase is ingested from a connection rather than typed. An acquisition is valid with no connection, forever.
- `expected_item_count` is the operator's estimate at intake ("about 40 things in this box"), used to surface a lot that was opened and never finished unpacking. It is not a constraint on anything.
- One currency per acquisition. Costs carry their own because a lot bought in GBP can incur a USD freight charge.

### `acquisition_costs`

Every money component of an acquisition, at lot or item scope. This table mirrors `order_fees` deliberately, including the scope constraint, because the shape of the problem is the same: amounts arrive at the granularity the world produced them, and allocation to a finer grain is a derived decision.

```text
acquisition_costs
id                  uuid primary key
acquisition_id      uuid not null references acquisitions(id) on delete cascade
inventory_item_id   uuid null references inventory_items(id) on delete cascade
cost_scope          text not null
cost_type           text not null
cost_class          text not null
capitalize          boolean not null default true
description         text null
vendor_name         text null
external_reference  text null
currency            char(3) not null
amount              numeric(20,6) not null
incurred_at         timestamptz null
created_by_user_id  text null references user(id) on delete set null
created_at          timestamptz not null
updated_at          timestamptz not null
check(cost_scope in ('lot','item'))
check((cost_scope = 'item') = (inventory_item_id is not null))
check(cost_class in ('goods','ancillary'))
```

- `cost_scope` and its consistency `CHECK` are the `order_fees.fee_scope` pattern, unchanged, for the same reason: allocation queries filter on scope constantly and should not depend on a null test.
- `cost_class` separates the price of the goods from everything spent getting them saleable. Landed cost is the sum of both where `capitalize = true`; `acquisition_cost_amount` on an item is its share of `goods` only. Keeping the two separately visible is what makes "the lot cost $250 and I spent another $91 on it" answerable, which is the number that actually decides whether a sourcing channel is worth repeating.
- `capitalize = false` records a cost that was genuinely incurred but that the operator does not want in basis — mileage tracked for a different deduction, storage rent, a tool bought once. It stays attached to the acquisition as operational evidence and is excluded from landed cost. Phase 5's expense model will consume these rows; Phase 4 does not decide their accounting treatment, it only refuses to silently capitalize them.
- Initial `cost_type` values (TypeScript union, **no** `CHECK` — unlike the other closed sets here, this one will grow with real sourcing practice and nothing branches on unknown members):

```text
goods                    buyers_premium           sales_tax
lot_fee                  inbound_freight          duty_tariff
fuel_mileage             pickup_hauling           platform_purchase_fee
refurbishment_parts      cleaning_supplies        testing_certification
grading_fee              listing_prep             storage
disposal                 other
```

- **Sign convention:** positive is money spent. Credits — a coupon, cashback, a partial refund from the seller, proceeds from scrapping the unsellable third of a pallet — are negative rows of the appropriate type. This is the same polarity as `order_fees` and the opposite of `order_refunds`, and it is not merged into a signed universal adjustments table for the same reason Phase 3 gave.

### Allocating a lot cost across its items

The allocation basis lives on the acquisition and drives a function in `@loxep/inventory`; nothing about it is stored per allocation run except its outputs on the item rows.

```text
equal            landed cost ÷ unit count. Honest for genuinely uniform lots,
                 actively misleading for the heterogeneous ones Phase 4 exists for.

relative_value   each item's share ∝ inventory_items.estimated_value_amount.
                 The recommended default for auction lots, pallets, and estate hauls,
                 and the standard treatment of a common cost across dissimilar goods.
                 Requires the operator to estimate resale value at intake — which they
                 do anyway, because it is why they bought the lot.

weight           share ∝ cost_allocation_weight. For bulk, scrap, and by-the-pound goods.

manual           the operator enters each basis; the engine only checks the total.

direct           cost_scope = 'item' rows only; no allocation happened.
                 Retail arbitrage, tagged thrift, wholesale invoices.
```

The invariant, enforced by the domain service and **not** by a database constraint:

```text
sum(inventory_items.landed_cost_amount for the lot)
  = sum(capitalized acquisition_costs for the lot)
```

It is not a constraint because it is legitimately false for most of a lot's life. A lot in `cost_allocation_status = 'pending'` has costs and no items yet; a lot in `provisional` is partly unpacked. A `CHECK` or trigger here would make normal operation impossible, which is the same reasoning that kept Phase 3 from constraining `orders.total_amount` against its lines — different cause, identical conclusion. The invariant is a reconciliation report over lots in `final`, plus a unit test.

Rounding uses a largest-remainder distribution so that the allocated shares sum to the landed cost exactly, with no residual cent left over or invented.

## Locations

A simple tree. Not a warehouse management system.

```text
inventory_locations
id                    uuid primary key
parent_location_id    uuid null references inventory_locations(id)
code                  text not null
name                  text not null
kind                  text not null
path                  text not null
depth                 integer not null default 0
is_default            boolean not null default false
active                boolean not null default true
notes                 text null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(code)
unique nulls not distinct (parent_location_id, name)
check(kind in ('site','room','area','shelf','bin','container','vehicle','in_transit'))
check(parent_location_id is distinct from id)
check(depth >= 0 and depth <= 6)
```

- `unique nulls not distinct (parent_location_id, name)` requires PostgreSQL 15+, which the `timescale/timescaledb:2.29.1-pg18` target provides. Without it every root-level location could be created twice, since PostgreSQL treats each null parent as distinct — the identical trap `channel_listings` documented for `external_variation_id`. The same portable fallback applies: a unique expression index over `coalesce(parent_location_id::text, '')`.
- `path` is a slash-joined string of ancestor codes (`HOME/GARAGE/SHELF-3/BIN-12`) maintained by the domain service on insert and on re-parent. It exists so "everything under the garage" is a prefix scan instead of a recursive CTE in every read path. It is a cache; the tree is the truth, and a mismatch is a reconciliation finding.
- **Cycles are not preventable by a `CHECK`.** The self-reference constraint stops only the one-node case. A parent-of-my-ancestor cycle needs either a trigger with a recursive walk or a service-level check, and Phase 4 recommends the service-level check plus an integrity test that runs a recursive CTE and asserts termination — the depth cap makes an accidental cycle self-limiting in the meantime. A trigger is available if a real incident argues for it.
- The depth cap of 6 is a guardrail against a location tree becoming a filing system, not a modeling claim. Site → room → area → shelf → bin → container is already deeper than most installations will use.
- `in_transit` is the only virtual `kind`, and it is the only one that earns its place: goods genuinely are somewhere-not-here between a transfer_out and a transfer_in, and having nowhere to put them forces the ledger to lie for a day.
- **Disposition is not a location.** "Sold", "discarded", "returned to vendor" are movement kinds and item statuses, never locations. Making them locations is the classic error that turns every on-hand query into an exercise in remembering which locations are real, and it silently double-counts the moment someone adds a seventh pseudo-location.

## Inventory items

The stock row. For the one-of-a-kind goods that dominate resale, one row is one physical thing.

```text
inventory_items
id                            uuid primary key
item_code                     text not null
acquisition_id                uuid null references acquisitions(id)
catalog_item_id               uuid null references catalog_items(id)
economic_entity_id            uuid null references economic_entities(id)
entity_attribution_source     text not null
entity_attributed_at          timestamptz null
entity_attributed_by_user_id  text null references user(id) on delete set null
location_id                   uuid null references inventory_locations(id)
origin_item_id                uuid null references inventory_items(id)
label                         text not null
lot_reference                 text null
serial_number                 text null
status                        text not null
condition_code                text not null
condition_notes               text null
grading_authority             text null
grade_label                   text null
grade_numeric                 numeric(4,1) null
certificate_number            text null
quantity                      numeric(20,6) not null default 1
quantity_on_hand              numeric(20,6) not null default 0
currency                      char(3) not null
acquisition_cost_amount       numeric(20,6) not null default 0
landed_cost_amount            numeric(20,6) not null default 0
cost_allocation_basis         text not null default 'unallocated'
cost_allocation_weight        numeric(20,6) null
cost_basis_locked_at          timestamptz null
estimated_value_amount        numeric(20,6) null
acquired_at                   timestamptz not null
received_at                   timestamptz null
listed_at                     timestamptz null
depleted_at                   timestamptz null
created_by_user_id            text null references user(id) on delete set null
created_at                    timestamptz not null
updated_at                    timestamptz not null
unique(item_code)
check(quantity > 0)
check(entity_attribution_source in
      ('manual','acquisition_default','installation_default','connection_default','unattributed'))
check(cost_allocation_basis in
      ('unallocated','equal','relative_value','weight','manual','direct'))
check(condition_code in ('new_sealed','new_open_box','like_new','very_good','good',
                         'acceptable','for_parts','damaged','unknown'))
check((grade_label is null) or (grading_authority is not null))
```

Notes:

- `item_code` is the scannable label (`ITM-8F2K4`). It exists for the same reason `reference_code` does on acquisitions, and it is the thing that gets printed on a sticker and stuck to a bin.
- `label` is `not null` and `catalog_item_id` is nullable, in that order deliberately. Resale intake is "a brass lamp, no idea what it is yet" long before it is a SKU. Requiring a catalog item at intake would push operators into creating junk SKUs, which is exactly the failure Phase 3's installation-wide `unique(sku)` rule is trying to prevent. A catalog item is resolved later, opportunistically, and the free-text `label` remains as the intake evidence.
- **`quantity` versus `quantity_on_hand`.** `quantity` is how much this row was created holding and never changes; it is what makes the row a cost layer. `quantity_on_hand` is the current balance, maintained as a cache in the same transaction as every movement, and it is the column every availability query reads. The truth is `sum(inventory_movements.quantity)` for the item; the cache exists because that sum is on the hot path of every listing and allocation check while the ledger only grows. A nightly reconciliation job compares them and reports drift.
- **No `CHECK (quantity_on_hand >= 0)`.** Negative on-hand is a real event for a reseller: the same one-of-a-kind item sells on eBay and on the Woo store within the same minute. Blocking the second depletion at the database would fail an ingestion job over a business problem the operator must resolve in the physical world anyway. Negative on-hand is surfaced as an oversell exception, loudly. Operational facts before accounting.
- **No `quantity_reserved` cache**, deliberately asymmetric with `quantity_on_hand`. Reservations are few, short-lived, and live in a small indexed table that shrinks; movements are many and accumulate forever. Available-to-sell is `quantity_on_hand − (indexed sum over open allocations)`, which is cheap, and one cache is one thing that can drift instead of two.
- `status`: `intake | available | listed | reserved | partially_depleted | depleted | written_off | archived`. TypeScript union, no `CHECK` (a workflow label). It is a convenience index target, not an authority — quantities and movements are the authority, and any disagreement is a reconciliation finding rather than a constraint violation.
- `origin_item_id` covers splits, partial transfers, and entity transfers with one column. Every row that came from another row points at it, and lineage is a recursive walk when anyone needs it.
- `estimated_value_amount` is the operator's target resale price. It is the input to `relative_value` cost allocation and it is **not a valuation** — see [What Phase 4 does not create](#what-phase-4-does-not-create). Any read model that sums it must be named in a way that cannot be mistaken for a balance-sheet figure.
- One currency per item, snapshotted from its acquisition. An item bought in GBP and sold in USD is a real case and is handled at reporting time, not by storing a converted amount here — the Phase 3 no-conversion rule, applied to costs.

### Condition and grading

`condition_code` is a **Loxep-owned closed set with a `CHECK`**, and that is the whole point of it: channel condition vocabularies (eBay's numeric condition IDs, Woo's absence of one, a Medusa store's free text) are adapter mapping concerns and must not become the storage vocabulary. Condition drives resale value more than almost anything else about a used good, so a stable internal ladder that reports can group by is worth the constraint.

Grading is deliberately shallow — four columns, no tables:

```text
grading_authority   PSA, CGC, BGS, WATA, NGC, PCGS, ...    text, no CHECK
grade_label         'PSA 9', 'CGC 9.8', 'VG+'              the authority's own string
grade_numeric       9.0, 9.8                               numeric(4,1), for sorting
certificate_number  the slab/cert id                       text
```

`grade_label` is retained verbatim alongside `grade_numeric` because half-grades, qualifiers, and authority-specific scales do not survive a lossy numeric conversion, and the label is what a buyer searches for. Submitting an item for grading is a workflow with turnaround times, costs, and outcomes — that is a later table, not this one. The grading *fee* already has a home as an `acquisition_costs` row with `cost_scope = 'item'`.

## Movements

The append-only ledger. Everything that ever happened to stock is a row here, and nothing that happened to stock is anywhere else.

```text
inventory_movements
id                       uuid primary key
inventory_item_id        uuid not null references inventory_items(id)
movement_kind            text not null
quantity                 numeric(20,6) not null
location_id              uuid null references inventory_locations(id)
transfer_group_id        uuid null
acquisition_id           uuid null references acquisitions(id)
inventory_allocation_id  uuid null references inventory_allocations(id)
order_line_id            uuid null references order_lines(id)
order_fulfillment_id     uuid null references order_fulfillments(id)
shipment_id              uuid null references shipments(id)
reverses_movement_id     uuid null references inventory_movements(id)
reason_code              text null
note                     text null
deduplication_key        text not null
occurred_at              timestamptz not null
recorded_at              timestamptz not null
actor_user_id            text null references user(id) on delete set null
created_at               timestamptz not null
unique(deduplication_key)
check(quantity <> 0)
check(movement_kind in ('receipt','transfer_in','return_in','adjustment_in','found',
                        'transfer_out','depletion_sale','adjustment_out','shrinkage',
                        'disposal','consumption','reversal'))
check(movement_kind = 'reversal' or
      ((movement_kind in ('receipt','transfer_in','return_in','adjustment_in','found'))
       = (quantity > 0)))
check((transfer_group_id is not null) = (movement_kind in ('transfer_in','transfer_out')))
check((reverses_movement_id is not null) = (movement_kind = 'reversal'))
```

### Signed quantity, one location per row

`quantity` is **signed**: positive increases on-hand, negative decreases it. The alternative — a positive magnitude plus a kind that implies direction — requires a `CASE` over `movement_kind` in every balance query, which is exactly the bug factory a ledger exists to eliminate. On-hand is `sum(quantity)`. Nothing else.

The `CHECK` ties sign to kind so an inward movement can never be recorded negative, with `reversal` excluded from the partition because a reversal's sign follows whatever it reverses.

There is one `location_id`, not `from_location_id` and `to_location_id`, and this follows directly from the signed-sum rule: with a from/to pair, the balance *at a location* is no longer a sum — it is a sum of one column minus a sum of another, conditioned on kind, and it breaks the moment a movement has one side null. **A transfer is therefore two rows**, `transfer_out` (negative, at the source location) and `transfer_in` (positive, at the destination), sharing a `transfer_group_id`. Balance per location stays a `sum()` with a `where`, partial transfers fall out naturally by pointing the two halves at two item rows, and the cost basis carried by a split is visible on the new row instead of implied.

### Kinds

```text
+  receipt         goods received into stock against an acquisition
+  transfer_in     the receiving half of a transfer_group
+  return_in       a sold unit came back and was restocked
+  adjustment_in   a count correction upward
+  found           stock discovered with no acquisition (opening balance, mis-shelved)
-  transfer_out    the sending half of a transfer_group
-  depletion_sale  fulfilled against an order line
-  adjustment_out  a count correction downward
-  shrinkage       loss, theft, or damage discovered
-  disposal        discarded, donated, recycled, or scrapped
-  consumption     used internally or by a project (a cheap Phase 6 hook)
±  reversal        an explicit correction of one identified prior movement
```

`shrinkage` and `disposal` are separate from `adjustment_out` because they mean different things to a business — an adjustment says the count was wrong, shrinkage says goods were lost, disposal says a decision was made to get rid of them. Collapsing them saves one string and destroys the only signal that a sourcing channel is producing unsellable junk.

A disposed item keeps its allocated basis. That is not an error to be netted away; it is the real cost of the third of the pallet that was garbage, and hiding it would make every pallet look more profitable than it was.

### Append-only means append-only

No `UPDATE`. No `DELETE`. No `updated_at` column — its absence is the design statement. Corrections are `reversal` rows naming the movement they reverse.

Recommended enforcement is a `BEFORE UPDATE OR DELETE` trigger that raises an exception, because an invariant that lives only in TypeScript is a convention, not an invariant, and every other domain in the installation can reach this table. A migration that genuinely must repair data drops the trigger, repairs, and recreates it in the same migration — visible in review, which is the point. See [open questions](#open-questions).

### Idempotency

`deduplication_key text not null unique` reuses the `market_events` mechanism verbatim, for the identical reason: Graphile Worker is at-least-once, and a fulfillment handler that runs twice must not deplete twice. Keys are deterministic and computed from the causing fact, never from a timestamp or a random value:

```text
receipt          acq:<acquisition_id>:item:<inventory_item_id>
depletion_sale   ffl:<order_fulfillment_id>:<order_line_id>:alloc:<allocation_id>
return_in        rfl:<order_refund_line_id>:item:<inventory_item_id>
transfer_*       xfer:<transfer_group_id>:<in|out>
adjustment_*     adj:<count_session_or_ulid>:item:<inventory_item_id>
reversal         rev:<reverses_movement_id>
```

`occurred_at` is when the physical thing happened (which an operator may backdate); `recorded_at` is when Loxep learned of it and is never backdated. Both are needed because a count done on Saturday and entered on Monday is two different facts, and only one of them is what a report of "stock on hand as of Sunday" should use.

## Allocation and depletion

### `inventory_allocations`

```text
inventory_allocations
id                  uuid primary key
inventory_item_id   uuid not null references inventory_items(id)
allocation_kind     text not null
order_line_id       uuid null references order_lines(id)
quantity            numeric(20,6) not null
status              text not null
allocated_at        timestamptz not null
expires_at          timestamptz null
fulfilled_at        timestamptz null
released_at         timestamptz null
release_reason      text null
created_by_user_id  text null references user(id) on delete set null
created_at          timestamptz not null
updated_at          timestamptz not null
unique(order_line_id, inventory_item_id)
  where status in ('reserved','fulfilled')
check(quantity > 0)
check(allocation_kind in ('order_line','manual_hold','transfer','project'))
check((allocation_kind = 'order_line') = (order_line_id is not null))
check(status in ('reserved','fulfilled','released','cancelled','expired'))
```

- The kind/reference consistency `CHECK` is the `order_fees.fee_scope` pattern for the third time in this design. It is the right shape whenever a nullable reference and a discriminator must agree.
- The partial unique makes the reservation path idempotent: a retried allocation job cannot reserve the same item for the same line twice, while a released reservation does not block a later legitimate one.
- `expires_at` exists because a `manual_hold` that nobody ever releases is how available-to-sell quietly becomes wrong. A sweeper job expires stale holds; order-line allocations do not expire.

### Allocation is not a movement

A reservation does not move stock and writes nothing to `inventory_movements`. This is a rule, not an implementation detail: the movement ledger records what happened, and a reservation is an *intention* that may be released, expired, or cancelled without anything ever having physically occurred. Putting reservations in the ledger would fill an append-only record of facts with events that turned out not to be events, and would make on-hand and available-to-sell the same number when their whole purpose is to differ.

```text
quantity_on_hand          sum(inventory_movements.quantity)   — cached on the item
quantity_reserved         sum(open inventory_allocations)     — computed, never cached
available_to_sell         on_hand − reserved
```

### Depletion on fulfillment

The trigger is a Phase 3 `order_fulfillment_lines` row appearing or increasing — the channel said it shipped. Not order placement, and not payment: a reseller's stock leaves when it leaves.

```text
order_fulfillment_lines (order_fulfillment_id, order_line_id, quantity)
        |
        v
resolve allocations reserved against that order_line, oldest first
        |
        +-- allocation found  -> write depletion_sale movement(s), signed negative,
        |                        keyed ffl:<fulfillment>:<line>:alloc:<allocation>,
        |                        set allocation.status = 'fulfilled',
        |                        set inventory_items.cost_basis_locked_at if null,
        |                        set depleted_at when quantity_on_hand reaches 0
        |
        +-- no allocation     -> no movement; the line enters the unmatched-depletion
                                 backlog for an operator to resolve
```

The no-allocation branch is not a failure mode, it is the **common** case early in Phase 4 and it must never raise. A reseller lists items before Loxep knows about them, sells goods that were never entered, and imports order history from before inventory existed. An order whose stock cannot be found is a visible backlog to resolve, exactly as an unattributed order is in Phase 3 — the same principle, applied to goods instead of ownership.

Refunds that restock produce `return_in` movements against the original item when it can be identified (via the depletion movement's `order_line_id`) and against a new item row when it cannot. The returned unit's basis is its original basis; return postage becomes an `acquisition_costs` row only if the operator chooses to capitalize it, and is otherwise a Phase 5 expense.

All of it — the movement, the allocation status change, the cache update, the lock — happens in one transaction with the fulfillment write.

## Shipments

The [Phase 3 design](../commerce-schema-design/#orders) made an explicit promise: `order_fulfillments` records **what the channel said was shipped**, and Phase 4 adds `shipments` — packages, labels, dimensions, and actual postage — which *reference* fulfillments rather than replace them. This section honors that literally.

```text
order_fulfillments                       shipments
------------------------------------     ------------------------------------
what the CHANNEL reported                what the CARRIER and we actually did
Commerce-owned, ingested                 Shipping-owned, entered or fetched
no money                                 actual postage, insurance, surcharges
exists only for channel sales            exists for transfers and vendor returns too
one row per provider fulfillment         zero or more per fulfillment (split packages)
```

```text
shipments
id                      uuid primary key
shipment_kind           text not null
order_id                uuid null references orders(id)
order_fulfillment_id    uuid null references order_fulfillments(id)
order_fee_id            uuid null references order_fees(id)
status                  text not null
carrier_code            text null
carrier_name            text null
service_code            text null
tracking_number         text null
tracking_url            text null
label_external_id       text null
package_count           integer not null default 1
weight_grams            numeric(20,6) null
length_mm               numeric(20,6) null
width_mm                numeric(20,6) null
height_mm               numeric(20,6) null
origin_location_id      uuid null references inventory_locations(id)
destination_country     char(2) null
destination_region      text null
currency                char(3) null
postage_amount          numeric(20,6) not null default 0
insurance_amount        numeric(20,6) not null default 0
surcharge_amount        numeric(20,6) not null default 0
adjustment_amount       numeric(20,6) not null default 0
refund_amount           numeric(20,6) not null default 0
cost_source             text not null
shipped_at              timestamptz null
delivered_at            timestamptz null
created_by_user_id      text null references user(id) on delete set null
created_at              timestamptz not null
updated_at              timestamptz not null
unique(order_id, carrier_code, tracking_number) where tracking_number is not null
check(shipment_kind in ('outbound_sale','return_to_vendor','transfer','replacement','other'))
check(cost_source in ('manual','channel_reported','carrier_api','fee_derived','unknown'))
check((cost_source = 'fee_derived') = (order_fee_id is not null))
check((shipment_kind = 'outbound_sale') = (order_id is not null))
```

- **`adjustment_amount` is not an afterthought.** Carrier post-audit reweigh charges arriving four days after the label was bought are one of the most reliably underestimated costs in resale, and a schema with no home for them produces margins that are quietly optimistic forever. It accumulates; positive is an additional charge.
- `refund_amount` is positive for money returned (an unused label refunded). Net outbound cost is `postage + insurance + surcharge + adjustment − refund`.
- **`order_fee_id` is the double-counting guard, and it is load-bearing.** When a label is bought through the marketplace, the same money appears twice in Loxep: once as an `order_fees` row with `fee_type = 'shipping_label_charge'` (a Phase 3 fee type that already exists) and once as `shipments.postage_amount`. Without an explicit link, every per-item profitability figure subtracts postage twice. The rule: the profitability read model counts outbound shipping **from `shipments` only**, and excludes any `order_fees` row that is referenced by a shipment's `order_fee_id`. The `CHECK` ties `cost_source = 'fee_derived'` to the link so the case cannot be half-recorded.
- Tracking uniqueness is scoped to the order because carriers reuse tracking numbers after roughly a year, and a global unique on a recycled string would reject a legitimate shipment eighteen months later.
- `destination_country` and `destination_region` only — the same "no address normalization before Phase 6" line Phase 3 drew, and the same two fields, so shipping-cost analysis can group by destination without Phase 4 owning an address model.
- A shipment with no order is normal: `transfer` moves stock between the operator's own locations, `return_to_vendor` sends a bad lot back.

### `shipment_items`

```text
shipment_items
id                  uuid primary key
shipment_id         uuid not null references shipments(id) on delete cascade
inventory_item_id   uuid null references inventory_items(id)
order_line_id       uuid null references order_lines(id)
quantity            numeric(20,6) not null
created_at          timestamptz not null
unique(shipment_id, inventory_item_id, order_line_id)
check(quantity > 0)
check(num_nonnulls(inventory_item_id, order_line_id) >= 1)
```

A surrogate primary key rather than a composite, because both references are nullable and one shipment can legitimately contain the same item twice under different lines. This is the table that makes per-item shipping cost allocation possible at all: without it, a two-item package has one postage figure and no defensible way to split it.

## Realized profitability

Per the Phase 3 precedent, these are **read models in `@loxep/domain`, not database views** — the volumes are small, the shapes will change again in Phase 5, and view definitions in migrations hide business logic from the type system and the test suite.

### Composition, per item

```text
  order revenue          order_lines.line_total, for the line this unit was depleted against
− refunds                order_refund_lines.amount attributable to that line
− line-scoped fees       order_fees where fee_scope = 'line'
                           and fee_direction = 'seller_charge'
− allocated order fees   order_fees where fee_scope = 'order'
                           and fee_direction = 'seller_charge', pro rata (see below),
                         EXCLUDING any fee referenced by a shipment's order_fee_id
− outbound shipping      shipments: postage + insurance + surcharge + adjustment − refund,
                         allocated across shipment_items
+ customer-paid shipping already inside order_lines/orders as a Commerce fact; never added twice
− cost basis             inventory_items.landed_cost_amount × depleted share
= realized contribution  per item, per sale
```

`fee_direction` is load-bearing in that composition and is easy to miss. The implemented Phase 3 `order_fees` distinguishes `seller_charge` from `buyer_surcharge` — a resolution of the WooCommerce finding that Woo's `fee_lines` are buyer-facing surcharges already inside `orders.total`, not platform fees charged to the seller. Only `seller_charge` rows are deductions from proceeds. Subtracting a buyer surcharge would understate contribution by exactly the amount the buyer already paid us.

Explicitly **not** in this number: overhead, storage, labor, mileage not capitalized into a lot, subscription and software costs, and anything at payout or processor level. Those are Phase 5. Every surface that displays this figure must say "contribution after goods, fees, and shipping", never "profit" — the same labeling discipline Phase 3 imposed on its pre-COGS figure, one step further along.

### Allocating order-scoped amounts to lines

Phase 3 deferred this decision to Phase 4 explicitly ([commerce open question 1](../commerce-schema-design/#open-questions)). Phase 4 answers it:

**Pro rata by `order_lines.line_total`, net of line-level discounts, with largest-remainder rounding so the allocated shares sum to the original amount exactly.** The same basis is used for order-scoped fees and for shipping across `shipment_items`. Nothing is stored: the allocation is computed in the read model, so changing the basis later is a code change and not a data migration — which is precisely why Phase 3 refused to bake it into `order_fees` at ingest.

Where a line has no `line_total` to weight by (a zero-value promotional line), it receives no share rather than an equal share, and the shortfall stays with the paying lines.

### Initial read models

```text
item realized contribution   per depleted inventory_item, as composed above
acquisition ROI              per acquisition: landed cost vs. realized contribution of
                             its depleted items, plus units still on hand at basis
sourcing channel performance acquisition ROI grouped by source_kind and period
inventory on hand at cost    sum(landed_cost_amount × on-hand share), by entity and
                             location — a COST total, explicitly not a valuation
aging                        on-hand items by days since acquired_at, bucketed
unmatched depletions         fulfilled order lines with no allocation and no movement
oversells                    items with quantity_on_hand < 0
open lots                    acquisitions in 'provisional' past a staleness threshold
cost reconciliation          final lots where allocated basis ≠ capitalized landed cost
```

Every money figure is grouped by currency and never summed across currencies, unchanged from Phase 3. An item whose cost currency differs from its sale currency cannot produce a single-currency contribution figure and is reported as such rather than converted — see [open questions](#open-questions).

## Opportunity-to-outcome linkage

The roadmap's Phase 4 line is "begin connecting market opportunities to historical realized resale outcomes", and half of the machinery already exists. `market_events` carries a `rule_id` stamp and a scored `payload.opportunity` key from Phase 2; `order_lines.marketplace_item_id` was added in the Phase 3 design precisely as "the join between Commerce and Market Intelligence — when a sold listing happens to be one Loxep already observes, that link is what eventually connects a market opportunity to a realized outcome in Phase 4."

What is missing is the middle: the record that *this observation is why we bought that box*.

```text
acquisition_opportunity_links
id                    uuid primary key
link_kind             text not null
acquisition_id        uuid null references acquisitions(id)
inventory_item_id     uuid null references inventory_items(id)
market_event_id       uuid null references market_events(id)
marketplace_item_id   uuid null references marketplace_items(id)
opportunity_rule_id   uuid null
score_at_link         numeric(10,4) null
target_currency       char(3) null
target_price_amount   numeric(20,6) null
linked_at             timestamptz not null
linked_by_user_id     text null references user(id) on delete set null
note                  text null
created_at            timestamptz not null
check(link_kind in ('sourced_from','evaluated_against','comparable'))
check(num_nonnulls(acquisition_id, inventory_item_id) >= 1)
check(num_nonnulls(market_event_id, marketplace_item_id) >= 1)
unique(acquisition_id, market_event_id) where both are not null
unique(inventory_item_id, market_event_id) where both are not null
```

The design decisions that matter here are all about restraint:

- **The score is snapshotted, not joined.** `score_at_link` and `target_price_amount` freeze what we believed at the moment of the decision. Opportunity rules are mutable configuration; editing a rule's `score_weight` next month must not retroactively rewrite how good last month's decision looked. This is the same argument that made entity attribution a stored column rather than a read-time join, applied to a different mutable input.
- **`opportunity_rule_id` is a plain `uuid` with no foreign key**, exactly matching the `market_events.rule_id` precedent and for the identical stated reason: it is a historical attribution stamp, and deleting a rule must never block, cascade into, or rewrite recorded history.
- **`link_kind` distinguishes causation from context.** `sourced_from` means the observation drove the purchase. `evaluated_against` means we priced our decision using it. `comparable` means it is a reference point found later. Collapsing these would make the eventual "did our opportunity scoring actually work" study meaningless, because two thirds of the links would not be claims about causation at all.
- **This is a linkage table, not analytics.** There are no aggregates, no predicted-versus-actual columns, no model state, and no scores recomputed here. The study is a Reporting concern that joins this table to the realized-contribution read model, and it is not scheduled in any phase — see [contradictions and tensions](#contradictions-and-tensions-found-in-existing-documentation).
- Both `check(num_nonnulls(...) >= 1)` constraints use `>=` rather than `=`, unlike `order_source_links`, because naming both the acquisition and the specific item, or both the event and the item it was about, is additional information rather than ambiguity.

## Relationship overview

```text
economic_entities
    |
    |  attribution snapshot, written once (never a read-time join)
    |  present on BOTH acquisitions and inventory_items
    v
acquisitions ──> acquisition_costs ──(cost_scope='item')──> inventory_items
    |                                                            ^
    |  receipt movements                                         |
    +------------------------------------------------------------+
                                                                 |
inventory_locations ──(tree; path cache)──> inventory_items.location_id
                                                                 |
                              +----------------------------------+
                              |
                              v
                       inventory_items
                              |
   +--> catalog_items                 (opportunistic; Phase 3)
   +--> inventory_items.origin_item_id (splits, transfers, entity transfers)
   |
   +--> inventory_allocations ──> order_lines           (Phase 3; reservation only)
   |
   +--> inventory_movements   ──> order_lines           (append-only; the truth)
   |          |                    order_fulfillments
   |          +--> transfer_group_id (paired out/in rows)
   |          +--> reverses_movement_id (corrections)
   |
   +--> shipment_items ──> shipments ──> order_fulfillments   (Phase 3)
                                    └──> order_fees           (double-count guard)

market_events / marketplace_items
    |
    v
acquisition_opportunity_links ──> acquisitions / inventory_items
    (score snapshot; rule id is an unenforced stamp)

media_links (resource_type = 'acquisition' | 'inventory_item' | 'shipment')

Phase 5:  inventory_items + movements --> valuation, COGS postings, accounting books
Phase 5:  acquisition_costs where capitalize = false --> expense model
Later:    acquisitions --> vendor_id (Purchasing); consignor --> counterparties (Phase 6)
```

Every arrow into a future phase is a *reference added later*, not a rewrite of these tables. Same test as Phase 3.

## Migration plan sketch

### Ordering

Foreign keys dictate most of it. The circular-looking references — movements point at allocations and shipments, shipments point at fulfillments — resolve cleanly once allocations and shipments are created before movements.

```text
0. (prerequisite) the Phase 3 commerce migration must already be applied
1. inventory_locations                 (self-ref)
2. acquisitions                        (economic_entities, connections, user)
3. inventory_items                     (acquisitions, catalog_items, economic_entities,
                                        inventory_locations, self-ref, user)
4. acquisition_costs                   (acquisitions, inventory_items, user)
5. inventory_allocations               (inventory_items, order_lines, user)
6. shipments                           (orders, order_fulfillments, order_fees,
                                        inventory_locations, user)
7. shipment_items                      (shipments, inventory_items, order_lines)
8. inventory_movements                 (inventory_items, inventory_locations,
                                        acquisitions, inventory_allocations,
                                        order_lines, order_fulfillments, shipments,
                                        self-ref, user)
9. inventory_movements append-only trigger
10. acquisition_opportunity_links      (acquisitions, inventory_items, market_events,
                                        marketplace_items, user)
11. reporting-only indexes (optional split; see below)
```

Steps 3 and 4 are mutually referential in the design — `acquisition_costs.inventory_item_id` points forward, `inventory_items.acquisition_id` points back — so `inventory_items` is created first and `acquisition_costs` carries the forward FK. Nothing needs a deferred constraint.

All migrations run through `loxep migrate` under the existing advisory lock (ADR-0018). Hand-written SQL is required in at least two places: `UNIQUE NULLS NOT DISTINCT` on `inventory_locations`, and the append-only trigger. Partial unique indexes with `IN` predicates (`inventory_allocations`) may need it too. Verify current Drizzle Kit capability at implementation time and drop to SQL rather than weakening any constraint.

**If Phase 3 has not shipped when Phase 4 implementation begins, the correct answer is to ship Phase 3 first**, not to make the order-facing foreign keys nullable-and-unenforced with a plan to add them later. Inventory whose depletion cannot reference a sale is a stock-counting app, and the phase's stated deliverable — realized profitability — is unreachable without it.

### Which existing tables gain columns: none

- **`catalog_items`, `channel_listings`** — no new columns. The tempting one is a per-SKU `costing_method`, and Phase 4 refuses it because the costing policy is determined by what an allocation identifies, not by the SKU (see [Cost basis](#cost-basis-specific-identification)). If a real commodity-SKU need appears, that column is additive.
- **`orders`, `order_lines`, `order_fees`, `order_fulfillments`** — no new columns. Every Phase 3 → Phase 4 relationship is an inbound foreign key from a Phase 4 table. In particular there is no `order_lines.inventory_item_id`: one line can deplete several units, so the relationship lives on `inventory_allocations` and `inventory_movements` where it can carry a quantity.
- **`marketplace_items`, `market_events`** — no new columns, emphatically. An "we bought because of this" flag would contaminate entity-neutral public-fact tables with our own decisions. The link points inward, from `acquisition_opportunity_links`.
- **`economic_entities`** — no new columns. No `accounting_book_id`, no default location, no inventory settings. ADR-0017 holds.
- **`connections`** — no new columns. Phase 4 creates no scheduled polling of its own, so it does not touch the `monitor_targets` ownership question Phase 3 raised.
- **`media_objects` / `media_links`** — no new columns. Three new `resource_type` values (`acquisition`, `inventory_item`, `shipment`) carry lot photos, receipts, condition evidence, and packing slips, which is exactly what those columns are for.
- **`application_settings`** — new keys only (the default economic entity, the default location, the default cost allocation basis), under a namespaced `inventory.*` prefix. No DDL.
- **Better Auth tables** — untouched, per ADR-0020.

If implementation discovers a genuine need to alter an existing table, that is a signal to revisit this design, not to quietly add the column.

### Index strategy

Volumes are modest — a self-hosted reseller holds hundreds to low thousands of items and writes a few thousand movements a year. One index per named query, not defensive indexing.

Write and hot paths:

```text
inventory_items        unique(item_code)                     scan/lookup by label
inventory_items        index(acquisition_id)                 lot unpack and cost allocation
inventory_items        index(catalog_item_id) where not null SKU availability
inventory_items        index(location_id, status)            "what is on this shelf"
inventory_movements    unique(deduplication_key)             the retry probe; constraint IS the index
inventory_movements    index(inventory_item_id, occurred_at) balance and item history
inventory_movements    index(order_line_id) where not null   depletion lookback
inventory_movements    index(transfer_group_id) where not null
inventory_allocations  unique(order_line_id, inventory_item_id)
                         where status in ('reserved','fulfilled')
inventory_allocations  index(inventory_item_id) where status = 'reserved'
                                                             the available-to-sell probe (partial, tiny)
acquisition_costs      index(acquisition_id)                 landed-cost sum
shipment_items         index(shipment_id)
shipments              index(order_fulfillment_id) where not null
```

Reporting and resolution:

```text
acquisitions           index(economic_entity_id, acquired_at desc)
acquisitions           index(source_kind, acquired_at desc)   sourcing channel performance
acquisitions           index(cost_allocation_status)
                         where cost_allocation_status <> 'final'    open-lot backlog (partial)
inventory_items        index(economic_entity_id, status)
inventory_items        index(acquired_at) where depleted_at is null aging (partial)
inventory_items        index(economic_entity_id)
                         where economic_entity_id is null            attribution backlog (partial, tiny)
inventory_movements    index(movement_kind, occurred_at desc)
inventory_locations    index(parent_location_id) where not null
inventory_locations    index(path text_pattern_ops)                  subtree prefix scans
shipments              index(order_id) where not null
shipments              index(tracking_number) where not null         support lookups
shipments              index(carrier_code, shipped_at desc)          shipping cost analysis
acquisition_opportunity_links  index(market_event_id) where not null
acquisition_opportunity_links  index(marketplace_item_id) where not null
```

Partial indexes wherever a column is mostly null or a status is mostly one value; these stay small precisely because of the predicate.

Not indexed on purpose: `inventory_items.condition_code` and `status` (low cardinality, always filtered alongside something selective), `inventory_movements.acquisition_id` (reachable through the item), `acquisition_costs.cost_type` (tiny table).

`index(path text_pattern_ops)` is the one non-obvious entry: `LIKE 'HOME/GARAGE/%'` will not use a default B-tree index under a non-C collation, and subtree queries are the main reason `path` exists. Verify the operator class against current PostgreSQL behavior at implementation time.

## Open questions

Each item is a genuinely unresolved decision with a recommendation, not a placeholder.

1. **Where does a per-SKU costing policy live, if one is ever needed?** Phase 4 determines the costing method from what an allocation identifies and stores no policy anywhere. A commodity SKU that must always deplete FIFO has no declarative home. *Recommendation: ship with no policy column, and if a real need appears add `catalog_items.costing_method` as an additive Phase 3 amendment rather than an Inventory-owned side table.* The reason to prefer the catalog column is that costing is a property of the goods, not of the stock rows; the reason to defer it is that adding a column to a table Phase 3 designed but has not yet migrated requires a decision by whoever owns that document, and this one should not make it unilaterally.

2. **How is append-only enforced on `inventory_movements`?** *Recommendation: a `BEFORE UPDATE OR DELETE` trigger that raises.* A rule that lives only in a TypeScript service is a convention, and every other package in the monolith can reach the table. The cost is that a legitimate data repair must drop and recreate the trigger inside a migration — which is a feature, since it makes the exception visible in review. The alternative, `REVOKE UPDATE, DELETE` on the application role, does not work while the application connects as the owner. If a human judges a trigger too heavy for the Phase 4 codebase, the fallback is the service rule plus an integrity test, accepting that the invariant is then only as strong as code review.

3. **Cache `quantity_on_hand` on the item, or always derive it from movements?** *Recommendation: cache it, maintained in the same transaction as every movement, with a nightly reconciliation job.* Deriving is unambiguously correct and unambiguously on the hot path of every availability check and every listing render. The cache is safe here because there is exactly one writer (the movement service) and the reconciliation is cheap at these volumes. Revisit if the reconciliation ever finds drift in normal operation — that is a concrete trigger, not a vague "later".

4. **Location on the item row, or a per-location balance table?** Phase 4 puts a single `location_id` on `inventory_items` and models a partial transfer as a row split. That is exactly right for quantity-1 goods and slightly awkward for a case of 100 phone cases split across two shelves. *Recommendation: keep the single column.* The split-on-transfer rule is honest — the two halves genuinely have different locations and can diverge in condition and basis — and an `inventory_item_locations` balance table is purely additive if commodity stock ever becomes a real part of the workload.

5. **When does cost basis freeze?** This design locks it at first `depletion_sale`. The alternatives are locking at sale settlement (later, and only knowable in Phase 5) or never locking and always recomputing. *Recommendation: lock at first depletion.* It is the earliest moment the basis has been reported as a realized figure, it is knowable without any Phase 5 concept, and never-locking would mean a lot re-allocated in March silently rewrites February's reported margin. The visible cost is that a lot discovered to be mis-costed after a sale cannot be cleanly re-allocated — that case gets an explicit, audited basis correction on the individual item, not a silent lot re-run.

6. **Which record is authoritative for marketplace-purchased postage?** The same money is an `order_fees` row with `fee_type = 'shipping_label_charge'` and a `shipments.postage_amount`. *Recommendation: `shipments` is authoritative for shipping cost, `order_fees` remains the ingested evidence, and `shipments.order_fee_id` links them so the read model can exclude the fee.* Deleting or suppressing the fee row is wrong — it is a provider-reported fact and Phase 3 owns it. The residual risk is a shipment whose operator forgot to set the link, which double-counts silently; a reconciliation report should flag `shipping_label_charge` fees with no referencing shipment.

7. **Allocation of order-scoped fees and shipping to lines — pro rata by what?** Phase 3 deferred this here. *Recommendation: pro rata by `line_total` net of line discounts, largest-remainder rounding, computed in the read model and never stored.* The considered alternatives were by quantity (wrong whenever a $400 item ships alongside a $6 one) and by weight (right for shipping, unavailable for fees, and Phase 4 does not capture per-item weight reliably). Using one basis for both keeps the composed contribution figure internally consistent, which matters more than either basis being individually optimal.

8. **Mixed currency between cost basis and sale.** An item bought in GBP and sold in USD has no single-currency contribution figure without an FX rate, a rate date, and a policy. *Recommendation: no conversion in Phase 4, consistent with Phase 3.* Report such items as "contribution not computable in one currency" with both figures shown, and let Phase 5's reporting-currency and rate-source decisions resolve it. Storing a rate now is not reversible; showing an honest gap is.

9. **Consignment goods — inventory items, or out of scope?** `source_kind = 'consignment_intake'` produces items that are physically held and not owned, whose "profit" is a commission rather than a margin, and whose consignor is a counterparty Phase 6 has not built. *Recommendation: record them as ordinary `inventory_items` with zero basis and the consignment `source_kind`, and exclude zero-basis consignment items from every profitability and inventory-at-cost read model by an explicit predicate rather than by the accident of a zero.* The alternative — an `ownership` column with values `owned | consigned | on_memo` — is probably where this ends up, and should be added the moment the first consignment settlement needs to be split. Flagging rather than deciding: the schema cost is one column, the workflow cost is a whole domain.

10. **Do non-capitalized acquisition costs need a home before Phase 5 exists?** `acquisition_costs.capitalize = false` rows are recorded, attached to the acquisition, and excluded from basis — and then nothing consumes them until the expense model arrives. *Recommendation: keep them.* They are cheap, they are evidence the operator already typed, and the alternative is asking someone to re-enter a year of mileage and storage costs when Phase 5 lands. The risk to watch is that a surface shows the acquisition's "total spend" including them and a different surface shows landed cost excluding them, and nobody labels which is which — that is a UI discipline problem, and it should be called out in the Phase 4 implementation notes rather than solved with a column.

## Contradictions and tensions found in existing documentation

Recorded here for a human to resolve; this document does not attempt to fix them.

1. **"Marketplace/payment fees" appears in roadmap Phase 4, but nothing is left for it there.** The [Phase 3 design](../commerce-schema-design/#what-phase-3-does-not-create) took order-attached fees for Phase 3 (`order_fees`) and assigned payout- and processor-level fees to Phase 5. Phase 4's remaining fee scope is therefore empty except for the shipping-label double-count question above. The Phase 4 bullet should be deleted or narrowed to "reconcile shipping-label fees against actual postage". This is the other half of the tension Phase 3 already recorded as its own contradiction 1, seen from the Phase 4 side.

2. **"Purchasing/vendors/receiving foundation" is in roadmap Phase 4, but Purchasing is a separate domain and the domain map has vendors under DESIGN-FOR.** This design declares vendor records, purchase orders, and receiving-against-a-PO explicit non-goals and keeps only denormalized `vendor_name` text. If the roadmap bullet is meant literally, Phase 4 roughly doubles in size and acquires an AP surface; if it is meant as "enough vendor context to record an acquisition", the wording should say that.

3. **Three condition vocabularies now exist, and one of them is arguably in the wrong place.** `marketplace_items.condition_code` is a provider-derived observation of someone else's listing; `catalog_items.condition_code` was added by the Phase 3 design; `inventory_items.condition_code` is added here as a Loxep-owned closed set with a `CHECK`. Condition is a property of a physical unit, not of a SKU identity — a `catalog_item` describing "Nintendo Game Boy, DMG-01" cannot have one condition, and the Phase 3 column will either go unused or invite operators to create a separate SKU per condition. The Phase 3 migration has since landed `catalog_items.condition_code` as a nullable `text` with no `CHECK`, so this is now a live column rather than a design question: the choice is to leave it unused (and say so), to document it as a *default* condition for newly created stock, or to drop it in a later migration before it accumulates data.

4. **Shipping ownership versus phase packaging is undecided.** [Domain Boundaries](../domain-boundaries/#shipping-and-fulfillment) defines Shipping and Fulfillment as its own domain owning shipments, labels, and actual postage; the roadmap folds shipments into Phase 4 alongside inventory; [Workspaces](../../product/workspaces/) puts "shipping workflow entry points" in the Commerce workspace and receiving in Inventory. These are consistent under the "workspace UX is not domain ownership" rule, but the *package* question is open: does `shipments` live in `@loxep/inventory` or a new `@loxep/shipping`? This has the same shape as Phase 3's open question 6 about `monitor_targets`, and like that one it should be decided before implementation because it determines package boundaries rather than table shapes.

5. **Inventory valuation is unscheduled.** The domain map lists "Inventory valuation/aging/turnover" under Reporting DESIGN-FOR; roadmap Phase 4 says "Cost basis" and Phase 5 says nothing about inventory at all. This design places cost basis in Phase 4 and valuation/revaluation in Phase 5, and no existing document says that. Phase 5's bullet list should gain inventory valuation and COGS posting explicitly, or the assignment should be corrected here.

6. **The costing-method question is open in the domain map and closed in this document.** The map lists "FIFO, weighted-average, and specific-identification policies where appropriate" as DESIGN-FOR, which reads as "support all three eventually". This design argues that specific identification is the correct NOW default, that FIFO is a picker policy rather than a schema, and that weighted average is a reporting computation. The map bullet should either be narrowed to reflect that or explicitly kept open as a future requirement, because an implementer reading it today would reasonably build a cost-layer table this design says not to build.

7. **The opportunity-to-outcome *study* is not scheduled anywhere.** Roadmap Phase 4 says "begin connecting market opportunities to historical realized resale outcomes" and the domain map lists "Correlation of acquisition opportunities with actual resale performance" under Market Intelligence DESIGN-FOR. Phase 4 delivers the linkage table and the realized-contribution read model — the raw material — but the correlation analysis itself has no phase. That is probably correct, and it should be said, so nobody builds an analytics subsystem under a bullet that only asked for a foreign key.

## Before implementing this schema

1. re-read the applied Phase 3 migration rather than the Phase 3 design before writing any foreign key here; implementation has already diverged from the draft in at least one way that changes a Phase 4 read model (`order_fees.fee_direction`), and column names must come from the migration, not the document;
2. resolve the shipping-ownership package question (tension 4 above) before writing code — it determines whether `shipments` lives in `@loxep/inventory` or a new `@loxep/shipping`, and it has the same "decide before implementation" character as [Phase 3's open question 6](../commerce-schema-design/#open-questions) about scheduling ownership;
3. confirm the specific-identification recommendation and the cost-basis freeze rule with a human; they are the hardest things to change after a single sale has been reported;
4. confirm the entity-transfer-as-paired-movement rule, and get a decision on whether a transferred item's basis carries over or is restated at fair market value — the schema supports both and the answer is a tax question, not a modeling one;
5. verify current Drizzle Kit support for `UNIQUE NULLS NOT DISTINCT`, partial unique indexes with `IN` predicates, `num_nonnulls` checks, and trigger creation, and fall back to hand-written SQL rather than weakening any constraint;
6. verify `text_pattern_ops` behavior for the location `path` prefix index against the deployment's collation before relying on it;
7. write the idempotency and invariant tests before the inventory services: double-fired fulfillment, out-of-order receipt and depletion, re-allocation of a lot containing locked items, oversell, transfer split, and reversal must all be covered against real PostgreSQL;
8. write the append-only test first — an attempted `UPDATE` and an attempted `DELETE` on `inventory_movements` must both fail — because it is the invariant everything else in this design assumes;
9. keep provider SDK types at the integration boundary (ADR-0009); nothing here may be typed from a carrier or marketplace library;
10. update this document, the roadmap, and Domain Boundaries when implementation reality diverges, rather than letting the documentation drift.
