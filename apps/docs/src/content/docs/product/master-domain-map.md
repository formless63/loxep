---
title: Master Domain Map
---

# Master Domain & Feature Map

This document is intentionally broader than the implementation roadmap. Its purpose is to preserve the territory Loxep may need to cover before implementation choices accidentally close useful paths.

## Scope labels

- **NOW** — belongs in the initial useful product or its immediate foundation.
- **NEXT** — likely follow-on once the foundation is stable.
- **DESIGN-FOR** — do not necessarily build yet, but avoid architectural decisions that make it unnecessarily difficult.
- **POSSIBLE** — plausible direction worth remembering; do not distort today's architecture to accommodate it.

These labels are planning signals, not commitments.

## 1. Marketplace intelligence

### NOW

- Connect one or more eBay accounts independently of application users.
- Import and monitor eBay watchlists.
- Monitor explicit listings/items.
- Data-driven polling around a configurable 60-second baseline where API constraints permit.
- Persist granular observations over time rather than only current state.
- Detect price, availability/restock, sellout/unavailable, quantity, and listing-state changes where observable.
- Retain provider payload/evidence where useful.
- ntfy notifications with deep links and configurable rules.
- Durable, idempotent event processing.

### NEXT

- Persistent marketplace searches independent of the eBay watchlist.
- Seller monitoring and seller inventory history.
- New matching listing detection.
- Price-history and stock-history charts.
- Restock frequency/time-of-day analysis.
- Approximate sellout duration from observation boundaries.
- Seller/search dashboards and market trend views.
- Opportunity/deal scoring and target-price rules.
- Adaptive polling around interesting transitions.

### DESIGN-FOR

- Human-reviewed purchase candidates/workflows.
- Official marketplace purchase APIs where available and authorized.
- Multiple marketplace providers.
- Correlation of acquisition opportunities with actual historical resale performance.

### POSSIBLE

- Additional resale/auction marketplaces.
- Cross-market arbitrage intelligence.
- Statistical pricing and demand models.

## 2. Connections and integrations

### NOW

- Generic external connection/account model.
- Multiple accounts for the same provider.
- Application-encrypted credentials with rotation/versioning.
- Per-connection health and synchronization status.
- Per-user `owner/manage/view` access to connections.
- Provider-specific configuration without leaking provider types through the whole domain model.
- eBay adapter built on a maintained API library where appropriate.
- Incoming provider-event/raw-object persistence and idempotency.
- Generic `external_resources` / `resource_links` model for companion applications.

### NEXT

- WooCommerce adapter.
- Medusa adapter.
- Webhook ingestion where providers support it.
- Connection diagnostics, resynchronization, and integration-health dashboards.
- First companion integrations where useful: backup health, task/document links, billing links.

### DESIGN-FOR

- Shopify, Etsy, payment processors, banks, shipping services, tax services, knowledge/task systems, and other providers.
- External sidecars/integrations using a stable Loxep API.
- Import/export connectors.

## 3. Commerce

### NEXT

- Normalize orders from multiple selling channels.
- Order lines, adjustments, discounts, taxes, refunds, and status history.
- Channel/customer identity references without destroying provider-native identity.
- Fulfillment state.
- Provider-native raw object retention.
- Product/SKU/listing relationships.

### DESIGN-FOR

- Listing creation/synchronization.
- Channel-specific pricing/availability.
- Bundles/kits.
- Returns/exchanges.
- Customer service history.

## 4. Catalog and listings

### NEXT

- Internal catalog items/SKUs independent of provider listings.
- Map one catalog item to multiple marketplace/store listings.
- Listing state and channel metadata.
- Product costs and sale prices.
- Product/listing media through the common media layer.

### DESIGN-FOR

- Variants/options.
- Kits/bundles/assemblies.
- Listing templates.
- Channel-specific descriptions/media/policies.
- Pricing rules.

## 5. Inventory

### NEXT

- Inventory items and quantities.
- Inventory locations.
- Immutable inventory movements.
- Acquisitions/receipts.
- Sales/fulfillment depletion.
- Adjustments.
- Cost basis.
- Allocation/reservation.

### DESIGN-FOR

- FIFO, weighted-average, and specific-identification costing policies where appropriate.
- Serial/lot tracking.
- Transfers.
- Assemblies/kits.
- Materials consumed by service/installation projects.
- Centralized availability exposed to sales channels.
- Landed-cost allocation.

## 6. Purchasing and vendors

### DESIGN-FOR

- Vendors.
- Purchase orders and lines.
- Purchase receipts.
- Vendor bills/credits/refunds.
- Payment terms.
- Inbound freight and duties/tariffs.
- Landed cost distributed to inventory.
- Vendor price history.

## 7. Shipping and fulfillment

### NEXT

- Shipments linked to orders/fulfillments.
- Tracking numbers and carriers.
- Customer shipping amount versus actual postage cost.
- Actual shipping-cost attribution to orders.

### DESIGN-FOR

- Shippo/EasyPost/carrier integrations.
- Other shipping-data ingestion where feasible.
- Label purchasing.
- Packages, dimensions, weights, insurance, adjustments/refunds.
- Split shipments.
- Shipping-cost allocation across order lines.
- Shipping-performance analytics.

## 8. Customers and CRM foundation

### DESIGN-FOR

- Individuals and organizations.
- Multiple contacts and addresses/sites.
- Communication details.
- Tax status/exemption metadata.
- Payment/billing terms.
- Notes, attachments, and external resource links.
- Unified operational history across commerce, projects, services, and billing.

The intent is operational customer context, not a general-purpose enterprise CRM.

## 9. Projects, jobs, and service work

### DESIGN-FOR

- Projects/jobs linked to customers and sites.
- Lifecycle/status, estimates/budgets, tasks/milestones.
- Time entries and billable/non-billable work.
- Materials allocated from inventory.
- Project expenses/reimbursables/mileage/travel.
- Subcontractor/vendor costs and work orders.
- Documents/media/external resources attached to work.
- Project/job profitability.

Use cases include consulting, development, hosting, technology integration, installation, repair, and similar service activity.

### TRANSITION OPTION

- Integrate with Vikunja or another task/project platform before Loxep's native task functionality is mature.

## 10. Services and subscriptions

### DESIGN-FOR

- Service plans and customer subscriptions.
- Subscription items, service periods, renewal dates.
- Monthly/annual/arbitrary billing cadences.
- Recurring and usage/manual charges.
- Hosting/service operational metadata and cost basis.
- Subscription profitability.
- Suspension/cancellation/history.

Subscriptions should be operational objects that can produce billing, not merely recurring invoice templates.

## 11. Billing and accounts receivable

### DESIGN-FOR

- Quotes/estimates.
- Invoices and invoice lines from products, time, projects, subscriptions, expenses, and manual billables.
- Recurring billing.
- Credit notes and payments/allocation.
- AR aging and reminders.
- Invoice numbering, taxes, PDFs, email delivery, customer portal/payment links.

### TRANSITION OPTION

- Integrate with Invoice Ninja initially rather than rebuilding its mature delivery/payment/portal features before Loxep's underlying business model is useful.

## 12. Payments, payouts, and banking

### DESIGN-FOR

- Payment-provider transactions.
- Marketplace/processor fees.
- Refunds and chargebacks.
- Marketplace reserves/holds.
- Payout batches and clearing accounts.
- Bank transactions/feeds/imports.
- Reconciliation and transfers.

A sale and its eventual bank deposit must remain reconcilable through intervening fees, refunds, taxes, and clearing balances.

## 13. Expenses and cost attribution

### DESIGN-FOR

- Expenses and receipts.
- Vendors/payees.
- Categories/accounting accounts.
- Recurring/reimbursable expenses.
- Fixed-asset candidates.
- Flexible attribution of costs to customer, project, order, shipment, acquisition, SKU, channel, vendor, service, and accounting references.

Cost attribution is a first-class analytical concern, not merely an expense category.

## 14. Accounting

### DESIGN-FOR

- Double-entry ledger.
- Chart of accounts.
- Journal entries/lines and draft/posted state.
- Fiscal periods and closing controls.
- AR/AP integration.
- Inventory/COGS and clearing-account postings.
- Declarative posting rules translating operational facts into journal entries.
- Replay/rebuild of derived accounting when posting logic changes, subject to controls.
- Trial balance, P&L, balance sheet, cash-flow-oriented reporting.

### Principle

The ledger is downstream of operational truth. Orders, shipments, purchases, payments, inventory movements, and other source facts must survive changes in accounting treatment.

## 15. Tax

### DESIGN-FOR

- Sales-tax amounts and jurisdiction facts attached to transactions.
- Marketplace-facilitator treatment.
- Taxability/exemption data.
- Sales-tax liability reporting by jurisdiction/period.
- External tax-calculation integrations rather than a comprehensive tax engine.
- Income-tax-oriented reporting/exports, estimated-tax periods/reminders, and vendor-reporting inputs where applicable.

Loxep should preserve tax facts and support reporting; it should not attempt to become tax-law software.

## 16. Assets and vehicles

### POSSIBLE / DESIGN-FOR

- Business equipment/tools/computers/vehicles.
- Acquisition/disposal, assignment/location, depreciation inputs.
- Vehicle mileage logs and business-purpose attribution.

## 17. Media and documents

### NOW — foundation

- Stable `media_objects` identity and `media_links` relationships.
- PostgreSQL stores metadata; ordinary binary bytes live outside the database.
- `local` storage driver for the smallest deployment.
- generic `s3` storage driver.
- RustFS as the initial recommended/tested self-hosted S3 companion.
- resumable local-to-S3 and S3-to-S3 migration with verification before cutover.
- storage topology warning when multi-host application runtimes use unsafe node-local media.

### DESIGN-FOR

- Receipts, vendor bills/invoices, customer POs, contracts, quotes, packing slips, shipping docs, statements.
- Searchable metadata.
- OCR/text extraction and structured invoice/receipt extraction.
- Matching extracted documents to transactions, vendors, products, purchases, projects, etc.

## 18. Reporting and analytics

### NEXT

- Marketplace price/availability history.
- Seller/search/listing metrics.
- Channel/order metrics as commerce ingestion arrives.

### DESIGN-FOR

- Profitability by item, SKU, order, customer, project, channel, and service.
- Realized acquisition ROI.
- Shipping variance and marketplace/processor fee analysis.
- Inventory valuation/aging/turnover.
- AR/AP aging and recurring-revenue metrics.
- Vendor/purchasing analytics.
- P&L, balance sheet, trial balance, tax liability, cash/clearing reconciliation.

## 19. Time-series data

### NOW

- PostgreSQL with TimescaleDB from the initial deployment.
- Marketplace/listing observations modeled as hypertables from the beginning.
- Preserve raw observation resolution where valuable.
- Initial 7-day chunk policy with current Hypercore/columnstore direction for older observations and no automatic deletion by default.

### NEXT

- Continuous aggregates for hourly/daily analytical views where real queries justify them.
- Tune chunk/columnstore/retention behavior from measured data volume and query patterns rather than assumptions.

### DESIGN-FOR

- Inventory-level observations/snapshots.
- Balance snapshots.
- Operational KPI history.
- Shipping/market/channel metrics over time.

Transactional relational data remains ordinary PostgreSQL tables; Timescale is used where data is genuinely temporal.

## 20. Events and background work

### NOW

- Graphile Worker backed by the same PostgreSQL deployment.
- Scheduled polling, durable jobs, retries/backoff, priorities, job-key deduplication/idempotency.
- Database-driven monitor scheduling rather than a permanent cron entry per watched item.
- Raw provider events/objects separated from normalized domain processing.
- One Loxep image supports `LOXEP_MODE=all|web|worker`.
- Default deployment runs web + worker in one Loxep container.

### DESIGN-FOR

- Multiple worker processes/hosts sharing the same PostgreSQL queue.
- Replayable ingestion pipelines.
- Dead-letter/error investigation workflows.
- Operational job visibility.
- Specialized worker pools if measured workloads justify them.

## 21. Authentication, users, and authorization

### NOW

- Multiple application users even though Loxep is not designed around SaaS tenancy.
- Better Auth.
- Generic OIDC, with Pocket ID as an intended tested deployment.
- Magic-link authentication.
- Password authentication disabled initially.
- Better Auth-owned deployment-level roles such as `admin`/`member`.
- First-run administrator bootstrap/recovery.
- Loxep-owned per-resource permissions for external connections.

### NEXT / DESIGN-FOR

- Broader domain capabilities/permissions where real workflows require them.
- Audit trail for consequential actions.

An external marketplace account is not the same thing as an application login identity.

## 22. Public/integration API

### DESIGN-FOR FROM THE START

- Stable versioned HTTP API for integrations outside the Loxep frontend.
- OpenAPI contract.
- Authentication/API credentials appropriate to self-hosted deployments.
- Webhooks/outbound events eventually.
- Internal application code calls shared domain services rather than implementing business logic separately in API handlers.

The browser application may use framework-native server functions internally; Loxep should not depend on a TypeScript-only RPC protocol as its sole integration boundary.

## 23. Notifications

### NOW

- ntfy integration.
- Priority/title/message/tags/deep links.
- Notification rules separated from event detection.

### DESIGN-FOR

- Email, web push, other adapters, quiet hours/escalation/routing.

## 24. Companion services and operational integrations

### NOW / NEXT

- Generic external resource/link model.
- RustFS optional S3 Compose profile.
- ntfy as a first-class notification companion.
- Document an opinionated but optional self-hosting toolkit.
- Databasus backup-health webhook integration is a strong early candidate.

### RECOMMENDED / EVALUATE

- Knowledge/docs: Outline, AFFiNE, other compatible platforms.
- Tasks/projects: Vikunja or other compatible systems.
- Billing portal/delivery: Invoice Ninja.
- Database backups: Databasus.
- File/config backups: Backrest/restic.
- Container management: Dockhand.
- SSH/terminal management: TermixSSH.
- Metrics: Beszel.
- Uptime: Gatus.
- Private networking: Tailscale.

These are independent applications, not required Loxep dependencies. Their APIs, versions, and licenses must be reverified before implementation or version-specific documentation.

## 25. UI/application experience

### NOW

- TanStack Start + React.
- TanStack Router/Query/Table/Form where useful.
- shadcn/ui + Base UI + Tailwind.
- Kiranism `tanstack-start-dashboard` as the initial UI foundation/donor.
- Preserve/adapt its polished responsive shell and multi-theme/tweakcn theme system.
- Remove demo domain/backend/auth assumptions.
- Zustand only where genuine cross-client UI/workspace state warrants it.
- Prefer Apache ECharts for dense analytical visualization when starter charting is insufficient.

### Principle

Starter code accelerates presentation; it does not own Loxep architecture or dependency versions.

## 26. Deployment and operations

### NOW

- Generic, unbranded self-hosted containers.
- One Loxep image with `all|web|worker` runtime modes.
- Default minimal Compose deployment: `loxep + postgres-timescale`.
- Optional RustFS Compose service/profile for S3-compatible media.
- No Redis requirement merely for queueing.
- Environment/file-backed configuration and secrets.
- Health checks and database migrations.
- Backup/restore documentation.
- Dependency/version policy requiring current viable upstream verification before pins.

### DESIGN-FOR

- Reverse-proxy-agnostic deployment.
- Container registry releases.
- Upgrade/migration guidance.
- Observability and structured logs; optional OpenTelemetry.
- Scale-out web/worker hosts when actual workload requires them.
- Shared S3-compatible object storage for multi-host operation.

## 27. Documentation and open-source project needs

### NOW

- Documentation stored with the repository.
- Astro Starlight documentation site and public GitHub Pages deployment.
- Product/domain documentation, architecture docs, ADRs, Phase 0 spec, foundation schema.
- Dependency/version freshness policy.
- MIT license.
- Keep broad docs updated when later ADRs supersede earlier assumptions.

### DESIGN-FOR

- User guide, integration authoring guide, API docs, contributor guide, deployment/upgrade/backup guides.
- Copyable companion-service Compose/config templates.

## Cross-domain flow

```text
External providers / manual activity
              |
              v
      Source facts & events
              |
              v
        Domain workflows
  +-----------+------------+-------------+
  |           |            |             |
Commerce   Inventory    Services      Projects
  |           |            |             |
  +-----------+------------+-------------+
              |
              v
      Financial events / costs
              |
              v
        Accounting ledger
              |
              v
       Tax & reporting views
```

Marketplace intelligence also feeds acquisition decisions and can eventually be compared with realized commerce outcomes:

```text
Market observations
       |
       v
Opportunity / acquisition
       |
       v
Inventory -> Listing -> Sale -> Fulfillment
                              |
                              v
                    Fees / shipping / payout
                              |
                              v
                      Realized profitability
                              |
                              +----> future market decisions
```

## Non-goals implied by this map

This document does **not** mean Loxep should immediately become:

- a general enterprise ERP;
- a full CRM platform;
- tax-preparation software;
- a payment processor;
- a shipping carrier;
- a universal marketplace abstraction;
- a complete project-management suite;
- an HR system;
- an infrastructure management platform.

Where mature external systems solve specialized problems well, Loxep should integrate or recommend them until owning that capability provides clear value.
