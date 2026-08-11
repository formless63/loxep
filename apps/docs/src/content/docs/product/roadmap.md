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

- Create/manage an eBay connection in-app through supported authentication.
- Optionally attribute the connection to an economic entity where the account clearly belongs to one.
- Import/synchronize watchlist membership.
- Monitor watched listings around a configurable 60-second baseline within API constraints.
- Monitor explicit item IDs.
- Store listing observations in TimescaleDB.
- Detect price, availability, quantity, and listing-state changes.
- Configure ntfy in-app.
- Deliver useful notifications with direct listing links.
- Market workspace UI for connections/monitors, watched items, current state, event history, and price/availability history where available.
- Dashboard/Settings surfaces for runtime, job, storage, and integration health.

## Phase 2 — Search, sellers, and market intelligence

Goal: move from watchlist alerts to a personal market dataset.

- Persistent eBay search rules.
- New-listing detection.
- Seller monitoring.
- Adaptive scheduling/backoff.
- Historical price and stock charts.
- Restock and sellout metrics.
- Seller/search dashboards.
- Opportunity rules and scoring.
- Timescale continuous aggregates where justified by measured volume and real queries.

## Phase 3 — Commerce ingestion

Goal: connect market intelligence to actual selling outcomes while preserving explicit economic ownership.

- normalize eBay sales/orders and related fee/fulfillment facts;
- add WooCommerce connection and order ingestion;
- add Medusa connection and order ingestion;
- establish internal catalog/SKU and channel-listing relationships;
- attribute owned commerce activity to the appropriate economic entity rather than inferring ownership from the user/workspace/connection alone;
- preserve provider-native source data;
- initial cross-channel order and profitability views;
- begin using media storage for product/listing assets where useful.

The economic-entity foundation is already decided by ADR-0017. Accounting books remain deliberately separate and are not required for Phase 3 ingestion.

## Phase 4 — Inventory, acquisition, and fulfillment

Goal: follow physical goods from acquisition through sale.

- Acquisitions and inventory movements.
- Cost basis.
- Inventory locations.
- Economic-entity ownership/context for stock and acquisition workflows where needed.
- Purchasing/vendors/receiving foundation where acquisition workflows need them.
- Order allocations/depletion.
- Shipments and tracking.
- Actual outbound shipping costs.
- Marketplace/payment fees.
- Per-item/order realized profitability.
- Begin connecting market opportunities to historical realized resale outcomes.

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

Do not assume one economic entity equals one accounting book. An LLC and several assumed-name operations may intentionally share one chart of accounts/ledger while remaining separately attributable operationally.

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