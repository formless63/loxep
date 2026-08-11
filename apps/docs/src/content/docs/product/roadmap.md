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
- Import/synchronize watchlist membership — implemented, pending live consent: the `ebay_watchlist` poll executor syncs membership, links `monitor_items`, deactivates absent members, and observes members inside one batch; the Trading watchlist call needs a real user token, so only the mocked path is proven end to end.
- Monitor watched listings around a configurable 60-second baseline within API constraints — implemented: cadence is the operator's `interval_seconds` adjusted by the adaptive policy and clamped by the per-connection rate-budget interval floor the executor injects. The installation-wide defaults are registered application settings — `monitors.defaults` (the 60-second baseline), `monitors.observation_caps`, and `integration.ebay.rate_budget`, whose refill rate derives that floor — so cadence, per-poll observation cost, and the provider budget are operator-editable without a restart.
- Monitor explicit item IDs — implemented and exercised against the live eBay sandbox (application-token Browse path).
- Store listing observations in TimescaleDB — implemented: one observation batch per poll, minted once at fetch time and retry-safe.
- Detect price, availability, quantity, and listing-state changes — implemented: derived per poll from the previous observation and bridged into opportunity-rule attribution and notification delivery.
- Configure ntfy in-app.
- Deliver useful notifications with direct listing links — implemented: the worker's delivery pipeline renders per-event-type messages with the canonical listing URL.
- Market workspace UI for connections/monitors, watched items, current state, event history, and price/availability history where available.
- Dashboard/Settings surfaces for runtime, job, storage, and integration health.

## Phase 2 — Search, sellers, and market intelligence

Goal: move from watchlist alerts to a personal market dataset.

- Persistent eBay search rules — implemented and exercised against the live eBay sandbox: an `ebay_search` target runs Browse search through the worker's poll executor, bounded by its `maxItems` cost knob, and links every result into `monitor_items`.
- New-listing detection — implemented: a discovery poll diffs the fetched page against known items *before* upserting it and derives `new_listing` *after* linking, so exactly one event fires per marketplace item on its first global discovery, however many monitors match it.
- Seller monitoring — implemented: an `ebay_seller` target enumerates one seller through the Browse `sellers` filter and feeds the same pipeline; a page eBay returned by silently dropping the seller filter is refused outright rather than ingested as that seller's inventory.
- Adaptive scheduling/backoff.
- Historical price and stock charts.
- Restock and sellout metrics.
- Seller/search dashboards — implemented: `/market/searches` (per-monitor discovered-item counts and recent new-listing events for `ebay_search`/`ebay_seller` monitors) and `/market/opportunities` (recent rule-stamped events with score/rule/link-out), plus two `/market/overview` cards (new listings 24h, top opportunity). The monitor create/edit dialog and constants now cover all four `MonitorTargetType` values.
- Opportunity rules and scoring.
- Timescale continuous aggregates where justified by measured volume and real queries.

## Phase 3 — Commerce ingestion

Goal: connect market intelligence to actual selling outcomes while preserving explicit economic ownership.

- normalize eBay sales/orders and related fee/fulfillment facts;
- add WooCommerce connection and order ingestion — implemented PROVISIONALLY, pending the [Commerce Schema Design](../../architecture/commerce-schema-design/#provisional-implementation-decisions) review: a `woo_orders` monitor target registered against the shared scheduling model is claimed by the existing dispatcher, and the worker's poll executor runs the incremental `modified_after` sync into orders, lines, fees, refunds, fulfillments, and retained provider payloads. A store's connection keeps its URL as non-secret `connections.config` and its REST key pair as an encrypted `woo_credentials` bundle. Exercised against a live production store with read-only credentials;
- add Medusa connection and order ingestion;
- establish internal catalog/SKU and channel-listing relationships;
- attribute owned commerce activity to the appropriate economic entity rather than inferring ownership from the user/workspace/connection alone;
- preserve provider-native source data;
- initial cross-channel order and profitability views;
- begin using media storage for product/listing assets where useful.

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

The physical schema for this phase — acquisitions and lot costs, inventory items and locations, append-only movements, allocation and depletion against Phase 3 order lines, outbound shipments, and the opportunity-to-outcome link — is designed in [Inventory & Acquisition Schema Design (Phase 4)](../../architecture/inventory-schema-design/), and is now implemented **provisionally**: every open question in that design was resolved per its own documented recommendation under an owner directive, pending review. What shipped and what diverged is recorded in that document's [Provisional implementation decisions](../../architecture/inventory-schema-design/#provisional-implementation-decisions).

Inventory **valuation** is not in this phase and is not the same thing as cost basis. Phase 4 stores what was paid for a specific unit — a historical fact; forming a judgement about what stock is worth now requires a reporting date, a policy, and a book to post the adjustment to, all of which are Phase 5.

## Phase 5 — Financial foundation

Goal: create trustworthy financial facts without making the ledger the only representation of operational reality.

- Expenses and flexible cost attribution.
- Receipt/document attachments through the media layer.
- Payouts and clearing-account model.
- Bank transaction ingestion/import path.
- Reconciliation foundation.
- Explicit `accounting_books` model separate from economic entities.
- Book-to-economic-entity relationship that supports multiple economic entities/operating identities sharing one book.
- Chart of accounts and any required accounting dimensions/classes/departments.
- Double-entry journal.
- Declarative posting-rule model.
- Core financial statements/reports.
- Sales-tax fact model and marketplace-facilitator handling.
- Inventory valuation, revaluation, and COGS posting, plus the aging/turnover/carrying-cost reporting derived from Phase 4's cost basis. Phase 4 stores what was paid; forming a judgement about what stock is worth requires a reporting date, a policy, and a book to post to.
- The expense model that consumes Phase 4's non-capitalized `acquisition_costs` rows.

Do not assume one economic entity equals one accounting book. An LLC and several assumed-name operations may intentionally share one chart of accounts/ledger while remaining separately attributable operationally.

The physical schema for this phase — books and the effective-dated book-to-entity link, the per-book chart of accounts and dimensions, fiscal periods and closing semantics, the double-entry journal, declarative posting rules, payouts and clearing accounts, expenses, bank ingestion and reconciliation, sales-tax facts, and the statement read models — is designed in [Financial Foundation Schema Design (Phase 5)](../../architecture/financial-schema-design/).

## Phase 6 — Customers, projects, services, and billing

Goal: support non-e-commerce business activity coherently.

- Customer/organization/counterparty model distinct from installation-owned economic entities.
- Projects/jobs/sites.
- Time and billable work.
- Materials and expenses attributed to jobs.
- Service plans and subscriptions.
- Recurring service periods/billing facts.
- External-resource links to knowledge/task platforms.
- Outline/AFFiNE/Vikunja-style integrations where current APIs make them worthwhile.
- Invoice Ninja integration as an initial delivery/payment surface where useful.
- Quotes/invoices/AR model where owning those capabilities provides value.
- Project and subscription profitability.

The physical schema for this phase — counterparties and their contacts, channels, sites, identifiers, and per-entity roles, projects with time entries and rate resolution, materials consumed on jobs, service plans and subscriptions with generated service periods, the minimal owned invoice and receivable model that round-trips with Invoice Ninja, and the profitability read models — is designed in [Counterparty, Project, Service, and Billing Schema Design (Phase 6)](../../architecture/services-billing-schema-design/).

## Cross-cutting companion integrations

Companion services are not confined to a late roadmap phase. When they accelerate a current vertical slice without becoming architectural dependencies, Loxep can add integrations earlier.

Examples include:

- ntfy for notifications;
- RustFS or another S3-compatible backend for media;
- Databasus backup-health webhooks;
- Vikunja task/project links;
- Outline/AFFiNE knowledge links;
- Invoice Ninja billing delivery;
- Beszel/Gatus operational links or health context.

## Later directions

Potential later work includes fine-grained per-resource/per-entity access controls if real shared-install workflows require them, richer purchasing/AP, landed-cost automation, shipping integrations, document/OCR workflows, fixed assets and mileage, direct listing synchronization, additional commerce providers, customer portals, deeper tax/reporting integrations, native task/project capabilities, and richer operational-health integrations.

These should be pulled forward only when actual use exposes the need. The domain map is territory, not a requirement to prebuild every subsystem.