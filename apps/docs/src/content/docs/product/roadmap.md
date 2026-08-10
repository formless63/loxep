---
title: Roadmap
---

# Roadmap

The master domain map describes the territory. This roadmap deliberately does not attempt to build all of it at once.

## Phase 0 — Foundation and decisions

Goal: create a repository and architecture that can support the first useful vertical slice without prematurely implementing future domains.

- Finalize initial stack decisions and ADRs.
- Use Kiranism's TanStack Start dashboard as the initial UI shell/donor, while replacing its demo backend/auth/data assumptions.
- Establish the Bun workspace/monorepo structure.
- Establish PostgreSQL + TimescaleDB development environment.
- Establish Drizzle migrations and database conventions.
- Establish Graphile Worker runtime and job conventions.
- Ship one Loxep image with `LOXEP_MODE=all|web|worker`; `all` is the default self-hosted deployment.
- Establish TanStack Start application shell, routing, Query/Table/Form patterns, shadcn/Base UI, and theme system.
- Establish Better Auth with generic OIDC, Pocket ID as a tested provider, magic links, no passwords, and Better Auth-owned deployment roles.
- Establish Loxep-owned per-resource authorization such as connection `owner/manage/view` access.
- Establish connection/credential model and application-layer credential encryption.
- Establish source-event/raw-provider-object conventions.
- Establish media metadata and a `local`/generic-`s3` storage abstraction.
- Make local-to-S3 media migration a resumable application workflow.
- Provide RustFS as the initial recommended/tested optional S3 Compose companion without coupling Loxep to RustFS-specific APIs.
- Establish generic external-resource links so Outline/Vikunja/AFFiNE/GitHub-style companion objects do not require provider-specific columns throughout future domains.
- Establish logging, configuration, health checks, and tests.
- Establish generic Docker Compose deployment and optional companion profiles.
- Publish and continuously validate project documentation.

The normal minimal deployment target is:

```text
loxep                    # web + Graphile Worker
postgres-timescale
```

A media-heavy or expansion-ready deployment can add:

```text
rustfs                   # optional S3-compatible companion
```

## Phase 1 — Useful eBay monitor

Goal: Loxep replaces manual checking and creates immediate daily value.

- Connect an eBay account through supported authentication.
- Import/synchronize watchlist membership.
- Monitor watched listings around a configurable 60-second baseline within API constraints.
- Monitor explicit item IDs.
- Store listing observations in TimescaleDB.
- Detect price, availability, quantity, and listing-state changes.
- Configure ntfy.
- Deliver useful notifications with direct listing links.
- Basic web UI for connections, watches, current item state, events, runtime/job health, and integration health.

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

Goal: connect market intelligence to actual selling outcomes.

- Normalize eBay sales/orders and related fees/fulfillment facts.
- Add WooCommerce connection and order ingestion.
- Add Medusa connection and order ingestion.
- Establish internal catalog/SKU and channel-listing relationships.
- Preserve provider-native source data.
- Initial cross-channel order and profitability views.
- Begin using media storage for product/listing assets where useful.

## Phase 4 — Inventory, acquisition, and fulfillment

Goal: follow physical goods from acquisition through sale.

- Acquisitions and inventory movements.
- Cost basis.
- Inventory locations.
- Order allocations/depletion.
- Shipments and tracking.
- Actual outbound shipping costs.
- Marketplace/payment fees.
- Per-item/order realized profitability.
- Begin connecting market opportunities to historical realized resale outcomes.

## Phase 5 — Financial foundation

Goal: create trustworthy financial facts without attempting to replace every accounting workflow immediately.

- Expenses and flexible cost attribution.
- Receipt/document attachments through the media layer.
- Payouts and clearing-account model.
- Bank transaction ingestion/import path.
- Reconciliation foundation.
- Chart of accounts.
- Double-entry journal.
- Declarative posting-rule model.
- Core financial statements/reports.
- Sales-tax fact model and marketplace-facilitator handling.

## Phase 6 — Customers, projects, services, and billing

Goal: support non-e-commerce business activity coherently.

- Customer/organization model.
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

Potential later work includes purchasing/AP, landed-cost automation, richer shipping integrations, document/OCR workflows, fixed assets and mileage, direct listing synchronization, additional commerce providers, customer portals, deeper tax/reporting integrations, native task/project capabilities, and richer operational-health integrations.

These should be pulled forward only when actual use exposes the need.
