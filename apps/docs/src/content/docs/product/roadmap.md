---
title: Roadmap
---

The [Master Domain Map](../master-domain-map/) describes the territory. This roadmap deliberately does not attempt to build all of it at once.

## Phase 0 — Foundation and decisions

Goal: finish the platform foundation required for the first useful vertical slice without prematurely implementing future domains.

Already established:

- Bun workspace/monorepo with `apps/web` and `apps/docs`;
- Kiranism TanStack Start dashboard integrated as the UI donor/reference;
- `/starter/*` preserved for working UI examples;
- real `/dashboard/*` workspace;
- workspace-aware sidebar switcher and Cmd+K navigation;
- product/architecture documentation and ADR process;
- PostgreSQL + TimescaleDB, Drizzle, Graphile Worker, Better Auth, local/S3 storage, and runtime topology decisions;
- minimal economic-entity model distinct from users, provider connections, workspaces, and future accounting books;
- initial installation-wide `admin`/`member` access model with no speculative resource ACL layer.

**Phase 0 is complete.** The formal [exit criteria](../../architecture/phase-0-foundation/#exit-criteria) were validated by a fresh-clone walkthrough — see the [Phase 0 Exit Walkthrough](../../development/phase-0-exit-walkthrough/) record (16/17 on first pass; the one finding was fixed and re-verified at head). Implemented:

- the PostgreSQL + TimescaleDB development/Compose environment;
- Drizzle migrations and database conventions;
- the Graphile Worker runtime and job conventions;
- one Loxep image with `LOXEP_MODE=all|web|worker`, with `all` as the default deployment;
- Better Auth with generic OIDC, magic links, no passwords, and deployment roles;
- concrete first-admin bootstrap and shell-level recovery;
- minimal `economic_entities` plus nullable connection attribution;
- database-backed application settings plus application-encrypted runtime secrets;
- the generic connection/credential model;
- source-event/raw-provider-object conventions;
- media metadata, storage-backend records, and the `local`/generic-`s3` abstraction;
- resumable local-to-S3 migration with RustFS as the initial S3 conformance target;
- generic external-resource links;
- structured logging, health/readiness, redacted auditing, and tests (package vitest suites against real PostgreSQL/TimescaleDB plus Playwright critical-flow e2e coverage);
- generic Docker Compose deployment and optional companion profiles;
- continuous validation of both application and documentation builds, including internal docs links.

Normal runtime/provider settings should be configured in-app and stored in PostgreSQL. Environment/mounted-secret configuration is reserved for bootstrap facts required before DB-backed administration or login is possible. See [Configuration & Secrets](../../architecture/configuration-and-secrets/).

The normal minimal deployment target is:

```text
loxep                    # web + Graphile Worker capability
postgres-timescale
```

A media-heavy or expansion-ready deployment can add:

```text
rustfs                   # optional S3-compatible companion
```

The exact future product workspace split is documented separately in [Workspaces & Navigation](../workspaces/). Major areas should be peer workspace roots rather than one enormous `/dashboard/*` tree.

## Phase 1 — Useful eBay monitor

Goal: Loxep replaces manual checking and creates immediate daily value.

- Create/manage an eBay connection in-app through supported authentication — implemented: `/settings/connections` is provider-aware for `ebay` (environment/keyset admin form, "Connect eBay account" full-page-navigation consent flow per the CSRF cookie design, credential-status display, and a "Validate" action running a cheap authenticated call reported through the integration's error taxonomy).
- Optionally attribute the connection to an economic entity where the account clearly belongs to one.
- Import/synchronize watchlist membership — implemented; live-exercised against the sandbox with a consented test token: the `ebay_watchlist` poll executor authenticates, pages, syncs membership, and deactivates absent members on cadence. Caveat: the eBay sandbox returned an empty watchlist even after `AddToWatchList` acknowledged success, so live watchlist *content* still requires a bounded production-account verification; the adapter's other Trading and Browse calls succeeded.
- Monitor watched listings around a configurable 60-second baseline within API constraints — implemented: cadence is the operator's `interval_seconds` adjusted by the adaptive policy and clamped by the per-connection rate-budget interval floor the executor injects. The installation-wide defaults are registered application settings — `monitors.defaults` (the 60-second baseline), `monitors.observation_caps`, and `integration.ebay.rate_budget`, whose refill rate derives that floor — so cadence, per-poll observation cost, and the provider budget are operator-editable without a restart.
- Monitor explicit item IDs — implemented and exercised against the live eBay sandbox (application-token Browse path).
- Store listing observations in TimescaleDB — implemented: one observation batch per poll, minted once at fetch time and retry-safe.
- Detect price, availability, quantity, and listing-state changes — implemented: derived per poll from the previous observation and bridged into opportunity-rule attribution and notification delivery.
- Configure ntfy in-app — implemented and live-verified: endpoint (with write-only token), routing rule, and delivery all created/exercised through the product UI.
- Deliver useful notifications with direct listing links — implemented and live-verified end to end 2026-08-12: a real sandbox listing's price revision produced `price_dropped`/`price_changed` events on the next poll and two delivered ntfy pushes carrying the working sandbox listing URL (delivery rows recorded provider message ids on the first attempt).
- Market workspace UI for connections/monitors, watched items, current state, event history, and price/availability history where available.
- Dashboard/Settings surfaces for runtime, job, storage, and integration health.

## Phase 2 — Search, sellers, and market intelligence

Goal: move from watchlist alerts to a personal market dataset.

- Persistent eBay search rules — implemented and exercised against the live eBay sandbox: an `ebay_search` target runs Browse search through the worker's poll executor, bounded by its `maxItems` cost knob, and links every result into `monitor_items`.
- New-listing detection — implemented: a discovery poll diffs the fetched page against known items *before* upserting it and derives `new_listing` *after* linking, so exactly one event fires per marketplace item on its first global discovery, however many monitors match it.
- Seller monitoring — implemented: an `ebay_seller` target enumerates one seller through the Browse `sellers` filter and feeds the same pipeline; a page eBay returned by silently dropping the seller filter is refused outright rather than ingested as that seller's inventory.
- Adaptive scheduling/backoff — implemented: `packages/market/src/adaptive.ts`'s pure activity-to-interval policy (state in `monitor_targets.config.adaptive`) and `monitors.ts`'s `recordPollSuccess`/`recordPollFailure` capped exponential backoff, wired into the shared `packages/app/src/poll-executor.ts` every eBay/Etsy/Reverb poll executor runs through.
- Historical price and stock charts — implemented: `packages/market/src/metrics.ts`'s `priceHistory`/`availabilityHistory` (TimescaleDB `time_bucket`), served by `fetchItemPriceHistory`/`fetchItemAvailabilityHistory` and rendered by `price-history-chart.tsx` on `/market/items/$itemId`. Extended (loxep-48v) to stop discarding three of the five `marketplace_item_observations` columns that had zero readers in `apps/web/src`: `priceHistory` now also carries `lastLandedPrice` (`price + shipping_price`, computed in SQL), rendered as a second line on the price chart; `availabilityHistory` now also carries `lastWatchCount`/`lastQuantitySold`, rendered by two new item-detail cards — `watch-count-chart.tsx` (demand trend) and `sell-through-chart.tsx` (a bar chart of `deriveSellThroughDeltas`'s per-bucket delta of the cumulative `quantity_sold` counter, i.e. units moved per bucket, not the raw running total). The remaining two captured-but-unread columns, seller feedback score/percentage, render as a compact header stat on `item-state-card.tsx` next to the seller reference, alongside `sellerExternalId`/`categoryExternalId`/`listingStartedAt`, which the item detail DTO already carried but the page did not render.
- Restock and sellout metrics — implemented: `metrics.ts`'s `restockSellout`/`itemActivitySummary`, pairing `restocked`/`sold_out` `market_events` into intervals with counts/durations, served by `fetchItemRestockSellout`/`fetchItemActivitySummary` and rendered on the item detail page.
- Seller/search dashboards — implemented: `/market/searches` (per-monitor discovered-item counts and recent new-listing events for `ebay_search`/`ebay_seller` monitors) and `/market/opportunities` (recent rule-stamped events with score/rule/link-out), plus two `/market/overview` cards (new listings 24h, top opportunity). The monitor create/edit dialog and constants now cover all four `MonitorTargetType` values.
- Opportunity rules and scoring — implemented: `packages/market/src/opportunities.ts`'s declarative condition grammar, pure evaluator, and scoring formula, stamping `market_events.rule_id` via `evaluateRulesForEvent` in the same shared poll executor as adaptive scheduling; rendered in `/market/opportunities`.
- Timescale continuous aggregates where justified by measured volume and real queries. *(deliberately not built yet: `metrics.ts` documents the trigger criteria — plain `GROUP BY` queries are used until measured volume/latency crosses the documented threshold.)*

## Phase 3 — Commerce ingestion

Goal: connect market intelligence to actual selling outcomes while preserving explicit economic ownership.

- normalize eBay sales/orders and related fee/fulfillment facts — implemented PROVISIONALLY, pending the same [Commerce Schema Design](../../architecture/commerce-schema-design/#provisional-implementation-decisions) review: the eBay adapter reads the **Sell Fulfillment API** (`GET /sell/fulfillment/v1/order`) through the existing keyset/user-token/rate-budget foundation, an `ebay_orders` monitor target is claimed by the same dispatcher, and the worker's poll executor runs the incremental `lastmodifieddate` sync into orders, lines, fees, refunds, fulfillments, and retained provider payloads. Unlike WooCommerce, eBay reports a real **seller-side** fee (`totalMarketplaceFee`), so `orders.fee_amount` is populated and profitability actually subtracts something; `partially_fulfilled` is reachable; and `buyer_display_name` holds the eBay username. Order ingestion needs the `sell.fulfillment.readonly` OAuth scope, which the watchlist consent set does not include, so an existing eBay connection must be re-consented before it can sync orders. **Mapping is fixture-verified against the installed client's bundled OpenAPI types, not yet live-verified**: the Sell Fulfillment status vocabularies and the `filter` range grammar are design-derived until the sandbox live leg runs. `ebay_orders` shipped registered in `@loxep/market`'s `MONITOR_TARGET_TYPES`/`monitorTargetConfigSchemas` and labeled in the market UI's monitor table/dialog (loxep-itn, closing a narrow follow-up left by this issue — `createMonitorService` CRUD did not cover these rows at first, though claim/poll/sync always did) — like `woo_orders`, it is excluded from the monitor create dialog's type dropdown because these rows come from `@loxep/commerce`'s connection-bound sync bootstrap, not manual creation;
- add WooCommerce connection and order ingestion — implemented PROVISIONALLY, pending the [Commerce Schema Design](../../architecture/commerce-schema-design/#provisional-implementation-decisions) review: a `woo_orders` monitor target registered against the shared scheduling model is claimed by the existing dispatcher, and the worker's poll executor runs the incremental `modified_after` sync into orders, lines, fees, refunds, fulfillments, and retained provider payloads. A store's connection keeps its URL as non-secret `connections.config` and its REST key pair as an encrypted `woo_credentials` bundle. The path has bounded live-read evidence against a non-fixture store;
- add Medusa connection and order ingestion — implemented PROVISIONALLY: `medusa_orders` uses the shared monitor dispatcher and persists normalized orders, lines, refunds, fulfillments, and retained provider objects. The complete path was exercised against a throwaway Medusa 2.18.0 backend, including refund and fulfillment transitions plus idempotent inclusive-boundary re-polling;
- establish internal catalog/SKU and channel-listing relationships — implemented PROVISIONALLY in the Commerce schema and services; Phase 9 subsequently added the operator-facing catalog, listing, and inventory-item weave;
- attribute owned commerce activity to the appropriate economic entity rather than inferring ownership from the user/workspace/connection alone — implemented PROVISIONALLY on orders and catalog/listing workflows;
- preserve provider-native source data — implemented through hash-deduplicated `provider_objects`, with ADR-0021's configurable order-payload redaction sweep;
- initial cross-channel order and profitability views — implemented in `/commerce/orders`, the inventory contribution read models, and dashboard summaries;
- begin using media storage for product/listing assets where useful — inventory-item media is implemented; provider publishing and channel-specific media synchronization remain later work.

The economic-entity foundation is already decided by ADR-0017. Accounting books remain deliberately separate and are not required for Phase 3 ingestion.

The physical schema for this phase — orders, lines, fees, refunds, fulfillment, catalog items, and channel listings, plus what Phase 3 deliberately does not create — is designed in [Commerce Schema Design (Phase 3)](../../architecture/commerce-schema-design/).

## Phase 4 — Inventory, acquisition, and fulfillment

Goal: follow physical goods from acquisition through sale.

- Acquisitions and inventory movements. *(implemented provisionally: `acquisitions`, `acquisition_costs`, and the append-only `inventory_movements` ledger.)*
- Cost basis. *(implemented provisionally: specific identification, with the item row as the cost layer and basis frozen at first depletion.)*
- Inventory locations. *(implemented provisionally: a location tree with a cached `path`, not a WMS.)*
- Economic-entity ownership/context for stock and acquisition workflows where needed. *(implemented provisionally: stored attribution on both `acquisitions` and `inventory_items`, immutable on items — a change of owner is a paired transfer, never an `UPDATE`.)*
- Purchasing/vendors/receiving foundation where acquisition workflows need them. *(**not built**, deliberately: acquisitions carry a denormalized `vendor_name` only. Vendor records, purchase orders, AP, and receiving-against-a-PO are explicit non-goals — see [contradiction 2](../../architecture/inventory-schema-design/#contradictions-and-tensions-found-in-existing-documentation) in the Phase 4 design.)*
- Order allocations/depletion. *(implemented provisionally: `inventory_allocations` against Phase 3 `order_lines`, depletion on fulfillment, idempotent under re-ingestion.)*
- Shipments and tracking. *(implemented provisionally: `shipments` and `shipment_items`, referencing `order_fulfillments` rather than replacing them.)*
- Actual outbound shipping costs. *(implemented provisionally, including carrier post-audit `adjustment_amount`.)*
- Marketplace/payment fees. *(**narrowed**: Phase 3 already owns order-attached fees and Phase 5 owns payout/processor-level ones, so what remained here is reconciling shipping-label fees against actual postage — implemented as `shipments.order_fee_id` plus an unlinked-fee report. See [contradiction 1](../../architecture/inventory-schema-design/#contradictions-and-tensions-found-in-existing-documentation) in the Phase 4 design.)*
- Per-item/order realized profitability. *(implemented provisionally as read models in `@loxep/inventory`; the figure is labelled "contribution after goods, fees, and shipping", never "profit".)*
- Begin connecting market opportunities to historical realized resale outcomes. *(implemented provisionally: the `acquisition_opportunity_links` table and the realized-contribution read model — the raw material. The correlation study itself is deliberately unscheduled.)*

The physical schema for this phase — acquisitions and lot costs, inventory items and locations, append-only movements, allocation and depletion against Phase 3 order lines, outbound shipments, and the opportunity-to-outcome link — is designed in [Inventory & Acquisition Schema Design (Phase 4)](../../architecture/inventory-schema-design/), and is now implemented **provisionally**: its open questions follow the design's recorded recommendations pending review. What shipped and what diverged is recorded in that document's [Provisional implementation decisions](../../architecture/inventory-schema-design/#provisional-implementation-decisions).

Inventory **valuation** is not in this phase and is not the same thing as cost basis. Phase 4 stores what was paid for a specific unit — a historical fact; forming a judgement about what stock is worth now requires a reporting date, a policy, and a book to post the adjustment to, all of which are Phase 5.

## Phase 5 — Financial foundation

Goal: create trustworthy financial facts without making the ledger the only representation of operational reality.

- Expenses and flexible cost attribution. *(implemented provisionally: `expenses` plus `expense_allocations`, with entity attribution on the expense and orthogonal allocation targets — entity, acquisition, catalog item, channel — for the targets that exist today. Over-allocation is refused; under-allocation is a draft and a named report.)*
- Receipt/document attachments through the media layer. *(implemented provisionally: `media_links` rows with `resource_type = 'expense'`, no new table, idempotent under the natural key migration 0004 added.)*
- Payouts and clearing-account model.
- Bank transaction ingestion/import path.
- Reconciliation foundation.
- Explicit `accounting_books` model separate from economic entities. *(implemented provisionally: `accounting_books` with no `economic_entity_id`, ever — ownership points inward from `book_entity_links`. A book carries its functional currency, accounting basis, fiscal-year start, and a gapless entry-number counter.)*
- Book-to-economic-entity relationship that supports multiple economic entities/operating identities sharing one book. *(implemented provisionally: `book_entity_links`, effective-dated, with `posting_primary`/`reporting_only` roles and an exclusion constraint permitting at most one primary book per entity per day. The accepted routing rule walks the entity and then its ancestors, so an assumed name's activity lands in its parent company's book while staying separately reportable.)*
- Chart of accounts and any required accounting dimensions/classes/departments. *(implemented provisionally: one `ledger_accounts` chart per book, seeded from a code-owned template with stable `system_key` handles; `accounting_dimensions` and their values ship EMPTY, because the economic entity is the primary separation mechanism and it is a column on the line.)*
- Double-entry journal. *(implemented provisionally: `journal_entries` and `journal_lines` with signed amounts, composite same-book foreign keys, gapless per-book numbering, a deferred per-currency balance constraint trigger, posted-entry immutability, soft-close period enforcement, and reversal-and-repost as the only correction path.)*
- Declarative posting-rule model. *(implemented provisionally: `posting_rules` plus immutable `posting_rule_versions` and their `posting_rule_lines` templates, resolved first-match-wins by priority. A rule is a selector plus a line template and deliberately not an expression language — every predicate is an AND, a `remainder` plug line makes an unbalanceable template unauthorable, and a template is validated against the fact type at save time rather than silently never firing. The engine reads orders, order fees, order refunds, and expenses; posts through the existing journal service; detects a re-synced unchanged fact by `source_fact_fingerprint` and does nothing; and corrects a changed fact by reversal plus a new entry under the current version. `journal_entry_source_links` records the facts an entry touched, and a version referenced by any entry is frozen at the database.)*
- Core financial statements/reports. *(implemented provisionally: the income statement and the balance sheet ship as read models over the same `sum(functional_amount)` partition the trial balance uses, so the three cannot disagree. Retained earnings is computed from prior fiscal years rather than stored, there are no closing entries, and an entity-filtered balance sheet is offered only for a book that requires the entity dimension AND whose coverage is complete — the entity-filtered income statement, which is ADR-0017's actual promise, is always available. loxep-6ea: both now render on `/finance/books/$id`'s Statements section with a period selector, and the trial balance's account rows drill through to `LedgerReports.accountActivity`; `dashboard-functions.ts`'s own dashboard-band income statement stays a hand-copied duplicate of this same service's SQL, flagged in-file as drift risk rather than fixed by this pass.)*
- Sales-tax fact model and marketplace-facilitator handling.
- **COGS posting from inventory depletion.** *(implemented provisionally, and stated explicitly here to resolve [contradiction 2](../../architecture/financial-schema-design/#contradictions-and-tensions-found-in-existing-documentation) of the Phase 5 design, which flagged that these bullets said nothing about it while the design posted it: a capitalized `acquisition_cost` debits the inventory asset, a `depletion_sale` movement debits COGS and credits inventory at the basis Phase 4 froze on the item, and an intake movement posts NOTHING because the acquisition cost already carried that dollar. That last rule is the seam that stops one purchase being deducted twice.)*
- Inventory valuation, revaluation, and the aging/turnover/carrying-cost reporting derived from Phase 4's cost basis. **Not** shipped with COGS posting and deliberately still unscheduled: Phase 4 stores what was paid, and forming a judgement about what stock is worth requires a reporting date, a policy, and a book to post to. It is why a disposal or shrinkage movement posts nothing today.
- The expense model that consumes Phase 4's non-capitalized `acquisition_costs` rows. *(implemented provisionally: such a row posts DIRECTLY through the shipped `acquisition_cost_expensed` rule, which matches `capitalize = false`, rather than being copied into `expenses`. Its account is `suspense` — the same honest catch-all the unmapped-expense rule uses — because this fact type carries no cost-type predicate to route on.)*

Do not assume one economic entity equals one accounting book. An LLC and several assumed-name operations may intentionally share one chart of accounts/ledger while remaining separately attributable operationally.

The physical schema for this phase — books and the effective-dated book-to-entity link, the per-book chart of accounts and dimensions, fiscal periods and closing semantics, the double-entry journal, declarative posting rules, payouts and clearing accounts, expenses, bank ingestion and reconciliation, sales-tax facts, and the statement read models — is designed in [Financial Foundation Schema Design (Phase 5)](../../architecture/financial-schema-design/).

**Four milestones of that design are implemented provisionally — expenses and receipts, then the financial core, then posting rules and statements, then COGS posting: thirteen of its twenty-two tables, the fourth milestone needing no migration at all.** Three load-bearing decisions are accepted because changing them after entries post would require a migration or restatement: books are toggleable per economic entity with child activity rolling up into its parent's book; corrections are always reversal plus repost, never mutation; and the initial build is USD-only while retaining a per-line conversion seam for future currencies.

The ledger stays **downstream of reality** and the seam between them is unchanged: a fact's link to its entry is a source-fact identity (`('expense', expenses.id)`), deliberately without a foreign key, so a posted entry survives the deletion of its source and `expenses` gains no `journal_entry_id`. Facts now post automatically through the rule engine, and a fact that cannot post — no entity with a book, no matching rule, no generated period, or a movement kind that is not an accounting event — is a visible backlog rather than a guess or a rejected ingestion. Money spent on goods reaches the ledger: it enters as an inventory asset when the acquisition cost is recorded and leaves as COGS when the item depletes, once each. What still does not exist is inventory valuation, plus payouts, banking, reconciliation, and tax facts. What shipped and what diverged is recorded in that document's [Provisional implementation decisions](../../architecture/financial-schema-design/#provisional-implementation-decisions).

## Phase 6 — Customers, projects, services, and billing

Goal: support non-e-commerce business activity coherently.

- Customer/organization/counterparty model distinct from installation-owned economic entities. *(implemented provisionally: `counterparties`, `counterparty_contacts`, `contact_channels`, and `counterparty_entity_roles`. The distinction is physical, not a comment — no `economic_entity_id` on a counterparty, no `counterparty_id` on an economic entity, a `CHECK` that refuses a tax identifier on a person, and roles as the single one-directional meeting point. Customer and vendor are relationship rows scoped to one of our entities, never flags on the party. Merge is a survivor pointer with one resolver; dedupe is exact-normalized and never automatic.)*
- Projects/jobs/sites. *(**implemented provisionally**: `counterparty_sites` ships with a full service — `@loxep/counterparties`'s `sites.ts` (create/update/deactivate/reactivate/list) — because sites are a Counterparties-domain table under open question 14's own package rule, and that package already exists. `projects` now ships a service too: `@loxep/work`'s `projects.ts` — create/get/update/updateStatus/reattributeEntity/list/listWithChildren — enforcing hierarchy-lite (depth ≤ 1), the billing-method consistency checks, and three of the design's four entity-attribution ladder rungs (`manual`, `counterparty_role_default`, `unattributed`; `installation_default` is accepted only as an explicit caller-supplied value, since resolving the installation's default-entity setting needs `@loxep/domain`, which `@loxep/work` deliberately does not depend on).)*
- Time and billable work. *(**implemented provisionally**: `@loxep/work`'s `time.ts` records time entries and resolves `bill_rate_amount`/`cost_rate_amount` through the design's six-scope-plus-manual-plus-unresolved precedence ladder (`rates.ts`), frozen on the entry at record time and never silently rewritten by a later rate change; `billing-rates.ts` is the rate-card CRUD the resolver reads. Derived billable amounts are exact `numeric(20,6)` decimal-string arithmetic (`decimal.ts`), never JS floats.)*
- Materials and expenses attributed to jobs. *(**partially implemented**: `@loxep/work`'s `materials.ts` records `project_material_uses` against a project, snapshotting cost from `inventory_items.landed_cost_amount` for the `inventory_basis` case and computing a markup-derived charge — but it writes no `inventory_movements` row itself (`@loxep/work` does not depend on `@loxep/inventory`; a caller holding both packages composes the consumption-movement write and the material-use insert in one transaction). The `expenses`/`expense_allocations` ALTERs this design promised are still **not** made in this slice.)*
- Service plans and subscriptions.
- Recurring service periods/billing facts.
- External-resource links to knowledge/task platforms.
- Outline/AFFiNE/Vikunja-style integrations where current APIs make them worthwhile.
- Invoice Ninja integration as an initial delivery surface where useful. *(adapter, connection UX, and the on-demand `pushDraftInvoice` action are implemented: `packages/integrations/invoiceninja` (`@loxep/integration-invoiceninja`) owns the self-hosted API boundary, and the action records external client/document links. Native invoice tables remain design-only, and the write mapping has not yet been independently live-verified. See [Connecting Invoice Ninja](../../guides/connecting-invoice-ninja/).)*
- Quotes/invoices/AR model where owning those capabilities provides value.
- Project and subscription profitability.

The physical schema for this phase — counterparties and their contacts, channels, sites, identifiers, and per-entity roles, projects with time entries and rate resolution, materials consumed on jobs, service plans and subscriptions with generated service periods, the minimal owned invoice and receivable model that round-trips with Invoice Ninja, and the profitability read models — is designed in [Counterparty, Project, Service, and Billing Schema Design (Phase 6)](../../architecture/services-billing-schema-design/).

**Two milestones of that design are implemented provisionally — the counterparty core, then projects, time, rates, materials, and sites: nine of its nineteen tables.** The second milestone's shape was decided by open question 14, the domain-to-package mapping rule this same design proposes: applied to Phase 6, it recommends a NEW `@loxep/work` package for the Projects-and-Work domain (projects, time, rates, materials, services, subscriptions, periods). That package (`loxep-nw0`) now exists and owns `projects`, `billing_rates`, `time_entries`, and `project_material_uses`'s services, plus the **unbilled-work read model** — the design's core Phase 6 capability. `@loxep/work`'s version of that read model can only ever cover the time-and-materials half of the design's four-source join (`service_periods` is design-only and `expenses.project_id` is one of the deferred Phase-5-table ALTERs, so neither is reachable), and the "billed" side is an injectable `BilledResolver` seam rather than a real `invoice_line_sources` anti-join, because that table does not exist yet. `counterparty_sites` remains the one table in this domain area with a service in `@loxep/counterparties` rather than `@loxep/work`, because sites are a Counterparties-domain table under the same rule and that package already exists. Open question 1 (own-versus-integrate invoicing) — resolved Ninja-first, nothing native ships yet — is the reason everything past this milestone (services, subscriptions, service periods, invoices, payments) is still design only, independent of the package question. **No table owned by an earlier phase was altered** — `orders` gains no `counterparty_id`, and `expenses` still carries a denormalized `payee_name` even though counterparties now exist in an earlier migration in this same phase. What shipped and what diverged is recorded in that document's [Provisional implementation decisions (partial)](../../architecture/services-billing-schema-design/#provisional-implementation-decisions-partial).

## Cross-cutting companion integrations

Companion services are not confined to a late roadmap phase. When they accelerate a current vertical slice without becoming architectural dependencies, Loxep can add integrations earlier.

Examples include:

- ntfy for notifications;
- RustFS or another S3-compatible backend for media;
- Databasus backup-health webhooks;
- Vikunja task/project links;
- Outline/AFFiNE knowledge links;
- Invoice Ninja billing delivery;
- Beszel/Gatus operational links or health context — designed in [Fleet Observability Design (Phase 8)](../../architecture/fleet-observability-design/).

## Later directions

Potential later work includes fine-grained per-resource/per-entity access controls if real shared-install workflows require them, richer purchasing/AP, landed-cost automation, shipping integrations, document/OCR workflows, fixed assets and mileage, direct listing synchronization, additional commerce providers, customer portals, deeper tax/reporting integrations, native task/project capabilities, and richer operational-health integrations.

These should be pulled forward only when actual use exposes the need. The domain map is territory, not a requirement to prebuild every subsystem.

## Phase 7 — Infrastructure control plane

Goal: give the installation a working surface over its operational estate — domain names, DNS state, mail hosting, hosting targets, and companion services — modeled as desired state plus a reconciler rather than as provisioning scripts.

This phase is deliberately sequenced last among the designed phases and is **not a prerequisite for any earlier one**. It shares the foundation (connections, encrypted credentials, the scheduling model, audit events, provider adapters) and touches no commerce, inventory, financial, or counterparty table. Its records are installation-scoped and carry no economic-entity attribution; see [Domain Boundaries](../../architecture/domain-boundaries/#infrastructure).

It also runs against an explicit non-goal — the [Master Domain Map](../master-domain-map/#what-loxep-is-not) says Loxep should not become an infrastructure management platform, and [Principle 18](../../architecture/principles/#18-integrate-before-rebuilding-mature-specialist-products) says integrate before rebuilding. The design reconciles the two by drawing a narrow line: Loxep owns the **declared intent and its reconciliation** for names and DNS, which no companion tool owns for the installation, and continues to *link and observe* rather than replace container management, metrics, and uptime tooling. That reconciliation is the design document's first section and should be read before any code is written.

### Milestone 1 — schema, Cloudflare DNS reconciler, and drift detection

**Implemented and PROVISIONAL (loxep-lmy.1).** Migration `0012` creates the seven milestone-1 tables and no existing table gained a column; `@loxep/integration-cloudflare` covers zones and DNS records; `@loxep/infrastructure` carries the materializer, pure diff, reconcile run, drift persistence, and idempotency ledger; and `@loxep/app` registers `infrastructure_domain_reconcile`. Zone and record reads have bounded live evidence, while apply remains fixture verified. The accepted safety gates prohibit automatic deletion, preserve pending-operation recovery, and leave CAA policy empty until an operator configures it. Divergences and corrected provider assumptions are recorded in the [design document's implementation-status header](../../architecture/infrastructure-control-design/).

- The infrastructure tables: domains and their provisioning state, DNS desired state with ownership markers, hosting targets, provider-operation idempotency, and the reconciler run/step ledger.
- A DNS-provider adapter at the integration boundary, with the same error taxonomy and per-connection rate-budget shapes the commerce adapters use, and its credential held as an ordinary encrypted connection credential created in-app.
- The record materializer as a pure, separately tested function from intent to desired records.
- The diff-and-apply reconciler as idempotent worker tasks registered against the shared scheduling model, with transactional enqueue so an intent change and its sync job commit together.
- Drift detection as the **same code path with apply disabled**, its findings persisted so a drifted record is a durable, reviewable row rather than a log line.
- Delegation polling with bounded backoff, and an explicit give-up state that surfaces in the UI instead of retrying forever. *Deferred within the milestone:* zone creation and delegation polling still need independent verification of the `provider_operations` read-back path.

### Milestone 2 — mail hosting

**Implemented and PROVISIONAL (loxep-lmy.2).** Migration `0013` creates the four mail tables and adds the one foreign key milestone 1 deferred by name; `@loxep/integration-purelymail` covers domains, ownership codes, mailboxes, and routing rules; `@loxep/infrastructure` owns the mail intent services and resumable reconciler; and `@loxep/app` registers the three mail tasks. The provider contract and required DNS record set are source/fixture verified, and one bounded probe has live evidence; the complete adapter and write flow remain unverified live.

- A mail-provider adapter at the same boundary, gated on delegation being confirmed before ownership verification is ever attempted. **The gate holds**: a domain whose registrar delegation has not landed makes zero provider calls, does not increment its attempt counter, and records the run as *succeeded* — because correctly waiting for a human at a registrar is a success, not a fault.
- Mailbox/alias templates so standard addresses are data-driven rather than hardcoded. The templates ship **empty on purpose**, the same refusal the CAA policy makes: a guessed standard address set that half-matches an operator's convention is worse than none, because it looks configured.
- Generated mailbox passwords stored as ordinary encrypted secrets under a new `mailbox_password` bundle purpose, and **write-only**. [ADR-0022](../../decisions/0022-minted-secret-reveal/) permits a one-time reveal *in the response to the creating action* — but this mint happens inside a worker job that runs whenever delegation finally completes, with no admin waiting on it, so there is no response to reveal into and only the write-only half applies. A lost password is a rotation, never a recovery. A milestone-3 reveal UI must move the mint into a request-scoped action rather than adding a read-back.
- The provider's required DNS record set materialized through the milestone 1 pipeline, with the never-proxy constraint enforced in the materializer *and* the schema *and* the adapter. The set was verified against the provider's own current documentation rather than carried forward from any draft — seven records, including three DKIM keys and a DMARC record that is a `CNAME` rather than the `TXT` almost every other provider uses.
- **Not built, deliberately:** no fourth scheduling target type. Ownership verification is a bounded, self-terminating poll, which the design's own cadence section classifies as *not* scheduling — a permanent `monitor_targets` row would outlive by years the single event it watches for.

### Milestone 3 — fleet, hosting targets, and the Infrastructure workspace

**Implemented and PROVISIONAL (loxep-lmy.3).** Migration `0016` creates the design's last two tables, `dns_provider_tokens` and `dns_provider_token_zones`, and no existing table gained a column — the design's twelve tables now all exist. `@loxep/infrastructure` gains `tokens.ts` (mint, zone-scope intent, roll, and the idempotent policy sync) and the `/infrastructure` workspace ships in `apps/web`: overview, domains list/detail (the DNS drift panel with per-row adopt/dismiss, and the mail panel), fleet list/detail (hosting targets, minted tokens, and companion links), and reconcile-run history with retry.

- **The HARD CONSTRAINT this milestone exists to prove holds**: minting and rolling a token are request-scoped admin server actions, never worker jobs. `tokens.ts`'s `mint`/`roll` call the provider synchronously from the handler and return the plaintext in that response, exactly once (ADR-0022) — never through `tasks.ts`, which lists only `infrastructure.sync-token-policy` (the idempotent, re-runnable half). The mint dialog's reveal UI shows the value with a copy button and an explicit "you will not see this again," never a control that could be mistaken for a re-fetch.
- Token minting is ledgered through `provider_operations` (a genuine non-idempotent create); a `pending` row is never retried — per open question 4, a token create has no readable natural identity, so an ambiguous mint surfaces as an operator decision, never a blind retry. Rolling is deliberately **not** ledgered the same way: it always targets an existing, uniquely identified token, and repeating it is always a safe, intentional remedy for a lost value.
- The hosting-target fronting-chain guard (one hop; no cycle) shipped in milestone 1's `targets.ts` and is exercised, not re-implemented, by the fleet surfaces.
- Zone-scope editing and token rolling are kept apart everywhere they appear — a scope change enqueues a cheap, instant policy sync; a roll is styled destructively and requires a confirm, because it is the one action that requires touching every host the old value was pasted into.
- **What did not ship, and why it is a real gap rather than a silent one:** `@loxep/integration-cloudflare` has no token-mint/roll/policy endpoints yet (only zone/record/read, per milestone 1's own note), so `apps/web/src/server/admin.ts` wires `mint`/`roll`/`syncPolicy` to a stub `DnsTokenProviderPort` that fails honestly with `provider_unavailable` until that adapter work lands — `setZones`/listing work fully against real data today. Reverse-proxy/tunnel provider integration (`@loxep/integration-pangolin`, the `infrastructure.sync-proxy-resource` task, and `hosting_targets.proxy_connection_id` actually driving anything) is a concurrently-scoped sibling slice and is not part of this milestone's delivery; `sync-proxy-resource`'s task name and payload shape are reserved in `tasks.ts` so that work has a fixed contract to land into. `sync-token-policy`'s executor is registered in `@loxep/app` (`infrastructure-token.ts`); `sync-proxy-resource` is deliberately unregistered so an accidental enqueue fails loudly until the Pangolin service exists.

**The missing proxy leg is now implemented** (2026-08-16): [Pangolin Integration & Chain-Provisioning Templates](../../architecture/pangolin-chain-design/) lands `@loxep/integration-pangolin`, the `ProxyProviderPort`, `sync-proxy-resource`, the four-tier write-authorization model, dynamic-IP aliases, and a provisioning-template compiler over the existing reconciler. Retirement disables rather than deletes, `wouldLockOut` rejects self-lockout changes independently of policy tier, and alias auto-apply requires explicit policy. Org/site/resource/rule/target reads have bounded live evidence. Every write tier remains fixture verified; the first controlled live-write protocol is tracked as `loxep-acj.9`.

**`hosting_targets` gained a typed multi-address model** (2026-08-16, `loxep-bub`): the single `address_v4`/`address_v6` pair — always WAN-only, never able to hold a LAN or Tailscale address — is replaced by `host_addresses` (kind `wan`/`lan`/`tailnet`/`other`, provenance `operator_declared` or `observed:<provider>`, primary-per-kind-and-family), with every existing value backfilled before the two columns are dropped. The DNS materializer's CGNAT/tailnet guard becomes structural rather than merely enforced — only an operator-declared `wan` row can ever reach a published record — and the Tailscale/Dockhand syncs now fill their own kinds automatically for a linked hosting target. Detail in [Infrastructure Control Plane Design (Phase 7)](../../architecture/infrastructure-control-design/#milestone-3-fleet-token-scope-and-the-infrastructure-workspace-loxep-lmy3)'s own amendment.

The physical schema for this phase — the intent tables, materialization rules, reconciler job graph, drift persistence, and reuse of credentials and scheduling — is designed in [Infrastructure Control Plane Design (Phase 7)](../../architecture/infrastructure-control-design/). **All three milestones are implemented and PROVISIONAL.** Its implementation-status header records remaining high-risk decisions, including behavior that becomes difficult to reverse after creating a zone, token, or mailbox against a live provider.

## Phase 8 — Fleet observability and management

Goal: make the installation's surrounding operational tooling — container management, host metrics, uptime monitoring, host consoles — visible inside Loxep without reimplementing any of it.

This phase is the **observe and link** layer [Phase 7](#phase-7--infrastructure-control-plane) named and deferred. It owns nothing new: companion tools are linked through the generic external-resource model, their reachability and status roll into one shared health table, and their alerts continue to be delivered by the tools themselves. It adds **one table** and alters none.

Two rules make the boundary checkable rather than aspirational. Loxep stores the **latest observed status** of a subject and never a metric sample — one row per subject, overwritten in place — so a hypertable of host metrics would be a visible violation rather than a judgement call. And Loxep **never calls a mutating endpoint** on a fleet tool: a deep link opens the real product, with the operator's own session and the tool's own permissions.

The phase's central argument is that Loxep runs on the fleet it would observe, so it cannot alert on its own outage — and every candidate tool already delivers to ntfy, which the operator already runs for Loxep. Loxep therefore stays out of the infrastructure alert path and, in the one integration that runs the other way, **publishes its own health into the operator's uptime monitor** so something independent can raise the alarm when Loxep is the thing that broke.

### Milestone 1 — the shared health model

**Implemented (loxep-ovj.1).** Migration `0014_integration_health` creates the one table exactly as designed, with no alteration to any owning table. `@loxep/domain` owns the service (`upsertHealth`/`listHealth`/`getHealth`/`clearHealthForSubject`), the subject registry, and the sweep mechanics as shared foundation, per [open question 6](../../architecture/fleet-observability-design/#open-questions)'s resolution; `packages/app`'s `health.sweep` is the thin Graphile Worker/cron wrapper around it, on the same shape `ebay.refresh-tokens` already uses. The design's implementation-status header records what shipped and how each pre-implementation gate was resolved.

- `integration_health` as shared foundation: one current-state row per subject, keyed `(subject_type, subject_id)`, covering connections, notification endpoints, and storage backends first. It is a derived rollup for display and never drives retry or backoff — tested directly against `connections`' and `monitor_targets`' own error/backoff columns.
- One recurring probe sweep (every 5 minutes), with due-ness and backoff computed from columns the row already carries — no scheduling table and no per-subject cron. Every probe is cheap, unauthenticated, and read-only; "unreachable from Loxep" (`'unknown'`) and "failing" render as distinct statuses.
- The Dashboard's Operations band now reads `integration_health` for its per-provider connection status, where this milestone's subjects overlap what the band already showed; a new "Integration health" table on `/settings/overview` reads the full rollup.

### Milestone 2 — publish Loxep's own health outward

- An outbound push of Loxep-only facts — worker backlog, sync freshness, drift count, readiness — into an operator's existing uptime monitor, so a stalled push becomes an alert Loxep could not have raised itself.

### Milestone 3 — companion links and the fleet tools panel

- Companion tools linked through `external_resources`/`resource_links` against hosting targets and domains, with a typed known-tool registry in code rather than a per-provider column or table.
- A tools panel on each fleet record showing every linked tool's latest status, its provenance, and its age, with "unreachable from Loxep" as a distinct state from "failing".

### Milestone 4 and beyond — selective adapters

- Read-only adapters only where an API genuinely merits one, each with the standard error taxonomy, rate budget, and Loxep-owned fact types; link-and-probe everywhere else; and alert evidence ingestion only if the installation is to expose an inbound webhook surface at all.

The verdict for each candidate tool, the upstream evidence behind it, and the questions that must be answered before any of it starts are in [Fleet Observability Design (Phase 8)](../../architecture/fleet-observability-design/). Five of its open questions require explicit design approval.

## Phase 9 — The flipping loop

Goal: close the operator's core loop — money out, goods in, goods described, goods listed — over the domain layer phases 3 through 6 already built.

This phase is different in kind from those before it, and **all six of its milestones are now implemented** (loxep-dgf.1 through loxep-dgf.6). Phases 3, 4, 5, and 6 had shipped **headless**: schema, services, and tests, with no product surface — there was no `/inventory`, `/commerce`, or `/finance` workspace, `@loxep/inventory` had no runtime consumer, and `channel_listings` was fully constrained and never written. Phase 9 closed that gap: roughly 70% first product surfaces over services that already existed and were tested, 20% additive schema, and 10% one new provider ingestion path. Its first milestone needed no migration.

- Expense capture from anywhere: dedicated entry, receipt attachment, and CSV import. *(implemented: the `/finance` workspace — expenses list/detail, `/finance/expenses/new`, void-and-re-record, receipt upload/gallery, and the missing-receipt/unallocated-expense reports on `/finance/overview`.)* Bank/OFX ingestion stays Phase 5 — a bank transaction is a settlement fact, not an expense.
- The acquisition seam: money spent on goods becomes an `acquisition_costs` row and cost basis, never an `expenses` row. *(implemented: the `/inventory` workspace's acquisition lot detail, cost components, and basis picker write through `@loxep/inventory`.)* Recording both would deduct the same dollar twice.
- Acquisition import from a connector: eBay buy-side purchase history through Trading `GetMyeBayBuying`'s `WonList` container. *(implemented, live-unverified: `packages/app/src/inventory-ebay.ts`'s `createEbayPurchasePollExecutor` is registered against the `ebay_purchases` target type, and migration `0018_purchase_idempotency.sql` adds the idempotent unique index.)* It needs no new OAuth scope, no re-consent, and no adapter change, because the traditional Trading APIs authorize on the IAF token rather than on scopes and `tradingCall` is already generic. It cannot be sandbox-verified — the sandbox returns no `GetMyeBayBuying` container at all — so the mapping ships marked unverified until a production account runs it, exactly as the watchlist vertical did.
- Receipt and invoice parsing as a defined **parser interface** with pluggable backends, shipping manual-assisted only. *(implemented for its manual-assisted scope: the `ReceiptParser` interface, `createParserRegistry`, and the one registered `manualParser` backend, with the intake review UI at `/finance/import`.)* No parse ever becomes a domain record without a human confirming it, enforced structurally rather than by convention.
- The **Documents** domain gains its first tables and its package, serving both the receipt parser and the CSV importer through one review queue. *(implemented: migration `0017_documents.sql`, the new `@loxep/documents` package, and the CSV upload → column mapping → dry-run preview → staged review → confirm flow.)*
- Inventory enrichment: images through the media layer, how-it's-sold, package dimensions and weight, description, and typed product specifics — every field chosen because a listing needs it. *(implemented: migration `0015_inventory_enrichment.sql`, `inventory_item_specifics`, the item-image gallery, and part-out.)*
- Offline and local listings (Facebook Marketplace, Craigslist, in person) as first-class `channel_listings` with no connection, and the declared bridge to Loxep-managed listing authoring. *(implemented: migration `0019_manual_and_draft_listings.sql` relaxes `orders.connection_id` and `channel_listings.connection_id`/`external_listing_id`; `RecordSaleForm`/`recordManualListingSale` write a real manual order and deplete the linked stock unit.)* Per-provider publish stays with each integration.

The physical design — the expense-to-acquisition seam, the Documents tables and parser contract, inventory enrichment, listing relaxations, and the map of how the surfaces meet — is in [Flipping Lifecycle Design (Phase 9)](../../architecture/flipping-lifecycle-design/). **All six milestones are implemented**; follow-up status notes record the later write, worker-wiring, and manual-sale work. See the design document for the accepted resolutions to its load-bearing open questions.

Two things were outside this phase's own scope when it started, and both have since shipped through other work. **COGS posting from inventory depletion was Phase 5 work**, not Phase 9's — it has since shipped there, so money spent on goods does now reach the ledger, but nothing in this phase's own scope caused that. And **a manual listing could not record its sale until Phase 9's own M6 closed the gap**, because `orders.connection_id` was `not null` and Phase 3 declined to create the manual-order path; that decision was the design's open question 7, resolved by migration `0019_manual_and_draft_listings.sql` relaxing `orders.connection_id` (PROVISIONALLY, per OQ7's resolution) — `RecordSaleForm`/`recordManualListingSale` (loxep-dgf.6) write a real manual order and deplete the linked stock unit today.

The [Expense Entry and Document Intelligence Design](../../architecture/expense-entry-design/) is also implemented through all seven milestones. It replaces quick-entry dialogs with `/finance/expenses/new`, makes counterparties and receipt lines first-class, adds text extraction and search, supports candidate highlights for image evidence, and confirms candidates through the accounting or inventory domain seam. The remaining deliberate gaps are a controlled PDF-canvas overlay and a representative OCR-accuracy measurement; see the design's milestone list for the status of record.
