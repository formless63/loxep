---
title: Roadmap
---

# Roadmap

The master domain map describes the territory. This roadmap deliberately does not attempt to build all of it at once.

## Phase 0 — Foundation and decisions

Goal: create a repository and architecture that can support the first vertical slice without prematurely implementing future domains.

- Finalize initial stack decisions and ADRs.
- Establish monorepo/workspace structure.
- Establish PostgreSQL + TimescaleDB development environment.
- Establish Drizzle migrations and database conventions.
- Establish Graphile Worker runtime and job conventions.
- Establish TanStack Start application shell.
- Establish Better Auth with OIDC and magic-link design.
- Establish connection/credential model.
- Establish source-event/raw-provider-object conventions.
- Establish logging, configuration, health checks, and tests.
- Establish generic Docker Compose deployment.
- Publish project documentation.

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
- Basic web UI for connections, watches, current item state, events, and worker health.

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
- Continuous aggregates for analytical views where justified by volume.

## Phase 3 — Commerce ingestion

Goal: connect market intelligence to actual selling outcomes.

- Normalize eBay sales/orders and related fees/fulfillment facts.
- Add WooCommerce connection and order ingestion.
- Add Medusa connection and order ingestion.
- Establish internal catalog/SKU and channel-listing relationships.
- Preserve provider-native source data.
- Initial cross-channel order and profitability views.

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
- Invoice Ninja integration as an initial delivery/payment surface where useful.
- Quotes/invoices/AR model where owning those capabilities provides value.
- Project and subscription profitability.

## Later directions

Potential later work includes purchasing/AP, landed-cost automation, richer shipping integrations, document/OCR workflows, fixed assets and mileage, direct listing synchronization, additional commerce providers, customer portals, and deeper tax/reporting integrations.

These should be pulled forward only when actual use exposes the need.
