---
title: Master Domain Map
---

This document is intentionally broader than the implementation roadmap. It preserves the territory Loxep may need to cover before implementation choices accidentally close useful paths.

It describes **product/domain capability**, not one giant screen hierarchy and not a promise to build everything. See [Workspaces & Navigation](./workspaces/) for the current UI map and [Domain Boundaries](../architecture/domain-boundaries/) for backend ownership.

## Scope labels

- **NOW** — belongs in the initial useful product or its immediate foundation.
- **NEXT** — likely follow-on once the foundation is stable.
- **DESIGN-FOR** — do not necessarily build yet, but avoid architectural decisions that make it unnecessarily difficult.
- **POSSIBLE** — plausible direction worth remembering; do not distort today's architecture to accommodate it.

These labels are planning signals, not commitments.

## Workspace view of the territory

Workspaces are navigation surfaces that compose one or more backend domains.

| Workspace | Route root | Primary domains/capabilities |
| --- | --- | --- |
| Dashboard | `/dashboard` | cross-domain overview, alerts, activity, health, configurable widgets |
| Market | `/market` | marketplace intelligence, monitors, observations, searches, sellers, opportunities |
| Commerce | `/commerce` | catalog/listings, orders, returns, fulfillment, channel operations |
| Inventory | `/inventory` | stock, acquisition, purchasing, vendors, receiving, landed cost |
| Customers | `/customers` | people, organizations, contacts, addresses/sites, operational history |
| Projects | `/projects` | projects/jobs, time, materials, expenses, services/subscriptions |
| Finance | `/finance` | billing/AR, expenses/AP, payments/payouts, banking, reconciliation, accounting, tax |
| Settings | `/settings` | users/access, economic entities, provider connections, notifications, storage, runtime settings/secrets, diagnostics |
| Starter Reference | `/starter` | donor demos and reusable UI patterns; not product-domain data |

This UI grouping does **not** merge the underlying domains. For example, Finance may display Billing, Payments, Banking, Accounting, Tax, and Reporting without turning those into one backend module.

## 1. Marketplace intelligence

### NOW

- Connect one or more eBay accounts independently of application users.
- Import and monitor eBay watchlists.
- Monitor explicit listings/items.
- Data-driven polling around a configurable 60-second baseline where API constraints permit.
- Persist granular observations over time rather than only current state.
- Detect price, availability/restock, sellout/unavailable, quantity, and listing-state changes where observable.
- Retain provider evidence where useful.
- ntfy notifications with deep links and configurable rules.
- Durable, idempotent event processing.

### NEXT

- Persistent marketplace searches independent of the eBay watchlist.
- Seller monitoring and seller inventory history.
- New matching listing detection.
- Price/stock history charts.
- Restock frequency/time-of-day analysis.
- Approximate sellout duration from observation boundaries.
- Seller/search dashboards and market trend views.
- Opportunity/deal scoring and target-price rules.
- Adaptive polling around interesting transitions.

### DESIGN-FOR / POSSIBLE

- Human-reviewed acquisition/purchase candidate workflows.
- Official marketplace purchase APIs where available and authorized.
- Multiple marketplace providers.
- Correlation of acquisition opportunities with actual resale performance.
- Cross-market intelligence and statistical pricing/demand models.

## 2. Installation identity, economic entities, connections, and configuration

### NOW

- Multiple application users in one shared installation without classic SaaS tenancy.
- Better Auth-owned `admin`/`member` deployment roles.
- Installation-wide ordinary product access initially; `admin` adds installation/security/administrative authority.
- Minimal `economic_entities` records for personal activity, sole proprietorships, companies, assumed names/DBAs, and operating identities.
- Optional parent relation between economic entities/operating identities.
- Generic external connection/account model.
- Multiple accounts for the same provider.
- Nullable connection attribution to an economic entity where one account clearly represents one entity.
- Application-encrypted credentials with rotation/versioning.
- Per-connection health/synchronization state.
- Provider-specific configuration without leaking SDK/provider types through the domain model.
- Incoming source-event/raw-object persistence and idempotency.
- Generic `external_resources` / `resource_links` model for companion applications.
- Database-backed application settings and application-encrypted runtime secrets.

Phase 0 does **not** implement per-connection/per-workspace/per-economic-entity ACLs. Fine-grained access can be added later when a concrete shared-install workflow requires it.

Normal provider settings and credentials are configured in-app and stored in PostgreSQL. Environment/mounted-secret configuration is reserved for bootstrap facts required before database-backed administration or login can work. See [Configuration & Secrets](../architecture/configuration-and-secrets/).

### NEXT / DESIGN-FOR

- WooCommerce and Medusa adapters.
- Webhook ingestion where providers support it.
- Connection diagnostics/resynchronization and integration-health dashboards.
- Shopify, Etsy, payment processors, banks, shipping/tax providers, knowledge/task systems, and other connectors as real needs arrive.
- Stable external API/import/export boundaries.
- Fine-grained access controls only if real use cases justify them.

### Principle

Do not equate application users, workspaces, provider connections, economic entities, counterparties, or accounting books. They are different concepts.

## 3. Commerce, catalog, and listings

### NEXT

- Normalize orders from multiple selling channels.
- Order lines, adjustments, discounts, taxes, refunds, and status history.
- Channel/customer identity references without destroying provider-native identity.
- Fulfillment state.
- Provider-native source retention.
- Internal catalog items/SKUs independent of provider listings.
- Map one catalog item to multiple marketplace/store listings.
- Listing state/channel metadata.
- Product costs/sale prices and product/listing media.
- Explicit economic-entity attribution for owned commerce activity where appropriate.

### DESIGN-FOR

- Variants/options.
- Kits/bundles/assemblies.
- Listing templates and synchronization.
- Channel-specific descriptions/media/policies/pricing/availability.
- Returns/exchanges and richer customer-service history.

## 4. Inventory, acquisition, purchasing, and vendors

### NEXT

- Inventory items and quantities.
- Locations.
- Immutable inventory movements.
- Acquisitions/receipts.
- Sales/fulfillment depletion.
- Adjustments, reservations/allocations, and cost basis.
- Economic-entity ownership/context where inventory is not installation-global.

### DESIGN-FOR

- Vendors, purchase orders/lines, purchase receipts, vendor bills/credits/refunds.
- Inbound freight, duties/tariffs, and landed-cost allocation.
- FIFO, weighted-average, and specific-identification policies where appropriate.
- Serial/lot tracking.
- Transfers and assemblies/kits.
- Materials consumed by service/installation projects.
- Centralized availability exposed to sales channels.
- Vendor price history.

## 5. Shipping and fulfillment

### NEXT

- Shipments linked to orders/fulfillments.
- Tracking numbers and carriers.
- Customer shipping amount versus actual postage cost.
- Actual shipping-cost attribution to orders.

### DESIGN-FOR

- Shipping-provider/carrier integrations and label purchasing.
- Packages, dimensions, weights, insurance, adjustments/refunds.
- Split shipments.
- Shipping-cost allocation across order lines.
- Shipping-performance analytics.

## 6. Customers and operational CRM

### DESIGN-FOR

- Individuals and organizations as counterparties.
- Multiple contacts and addresses/sites.
- Communication details.
- Tax status/exemption metadata.
- Payment/billing terms.
- Notes, attachments, and external-resource links.
- Unified operational history across commerce, projects, services, and billing.

The intent is operational customer context, not a general-purpose enterprise CRM.

A customer/vendor/other counterparty is not automatically an installation-owned economic entity. The same real-world organization may be an economic entity in one Loxep installation and merely a counterparty in another.

## 7. Projects, jobs, service work, and subscriptions

### DESIGN-FOR

- Projects/jobs linked to customers and sites.
- Lifecycle/status, estimates/budgets, tasks/milestones.
- Time entries and billable/non-billable work.
- Materials allocated from inventory.
- Project expenses/reimbursables/mileage/travel.
- Subcontractor/vendor costs and work orders.
- Documents/media/external resources attached to work.
- Project/job profitability.
- Service plans and customer subscriptions.
- Service periods, renewal dates, billing cadences, usage/manual charges.
- Hosting/service operational metadata and cost basis.
- Subscription profitability and suspension/cancellation/history.
- Economic-entity attribution for the party providing the service where needed.

Use cases include consulting, development, hosting, technology integration, installation, repair, and similar service activity.

External task/project systems such as Vikunja may remain useful transition/companion surfaces until native capability provides enough value.

## 8. Billing and accounts receivable

### DESIGN-FOR

- Quotes/estimates.
- Invoices and lines sourced from products, time, projects, subscriptions, expenses, and manual billables.
- Recurring billing.
- Credit notes and payments/allocation.
- AR aging and reminders.
- Invoice numbering, tax facts, PDFs, email delivery, portal/payment links.
- Explicit economic-entity attribution for the seller/service provider represented by the invoice.

Invoice Ninja can remain an initial delivery/payment/customer-portal companion while Loxep owns the deeper operational source data.

## 9. Payments, payouts, banking, expenses, and costs

### DESIGN-FOR

- Payment-provider transactions.
- Marketplace/processor fees.
- Refunds and chargebacks.
- Marketplace reserves/holds.
- Payout batches and clearing accounts.
- Bank transactions/feeds/imports.
- Reconciliation and transfers.
- Expenses/receipts and recurring/reimbursable expenses.
- Vendors/payees and accounting classifications.
- Flexible cost attribution to customer, project, order, shipment, acquisition, SKU, channel, vendor, service, economic entity, and other supported dimensions.

A sale and its eventual bank deposit must remain reconcilable through intervening fees, refunds, taxes, and clearing balances. Cost attribution is operational metadata and must survive changes to accounting classification.

## 10. Accounting and tax

### DESIGN-FOR

- Explicit `accounting_books` separate from economic entities.
- Relationship between accounting books and economic entities/operating identities.
- Ability for multiple economic entities/operating identities to share one accounting book.
- Chart of accounts.
- Accounting dimensions/classes/departments where useful for separating activity within one book.
- Journal entries/lines and draft/posted state.
- Fiscal periods and closing controls.
- AR/AP, inventory/COGS, and clearing-account postings.
- Declarative posting rules translating operational facts into journal entries.
- Replay/rebuild of derived accounting where controls permit.
- Trial balance, P&L, balance sheet, and cash-flow-oriented reporting.
- Sales-tax facts/jurisdictions and marketplace-facilitator treatment.
- Taxability/exemption data and filing-period summaries.
- External tax-calculation integrations rather than a comprehensive tax engine.
- Income-tax-oriented reporting/exports and related planning inputs.

### Principle

The ledger is downstream of operational truth. Orders, shipments, purchases, payments, inventory movements, time/project facts, and other source records must survive changes in accounting treatment.

An economic entity is not automatically a separate set of books. An LLC with multiple assumed names/operating identities may intentionally use one chart of accounts/ledger while separating activity through accounts or accounting dimensions. Do not hardcode one economic entity = one accounting book.

## 11. Assets and vehicles

### POSSIBLE / DESIGN-FOR

- Business equipment/tools/computers/vehicles.
- Acquisition/disposal, assignment/location, depreciation inputs.
- Vehicle mileage logs and business-purpose attribution.

## 12. Media, storage, and documents

### NOW — foundation

- Stable `media_objects` identity and `media_links` relationships.
- Configured `storage_backends` records.
- PostgreSQL metadata with bytes outside the database.
- `local` storage driver for the smallest deployment.
- generic `s3` storage driver.
- RustFS as the initial recommended/tested self-hosted S3 companion.
- resumable local-to-S3 and S3-to-S3 migration with verification before cutover.
- storage-topology warning when multi-host runtimes use unsafe node-local media.

### DESIGN-FOR

- Receipts, vendor bills/invoices, customer POs, contracts, quotes, packing slips, shipping docs, statements.
- Searchable metadata and document semantics.
- OCR/text extraction and structured invoice/receipt extraction.
- Matching extracted documents to transactions, vendors, products, purchases, projects, and other domain records.

Media owns binary identity/storage. The Documents domain owns document meaning/extracted content.

## 13. Reporting, analytics, and time-series data

### NOW / NEXT

- PostgreSQL + TimescaleDB from the initial deployment.
- Marketplace/listing observations as hypertables from the beginning.
- Preserve useful raw observation resolution.
- Initial 7-day chunks with current Hypercore/columnstore direction for older observations and no automatic deletion by default.
- Marketplace price/availability history.
- Seller/search/listing metrics.
- Continuous aggregates when measured query/volume needs justify them.

### DESIGN-FOR

- Profitability by item, SKU, order, customer, project, channel, service, and economic entity.
- Acquisition ROI, shipping variance, and marketplace/processor fee analysis.
- Inventory valuation/aging/turnover.
- AR/AP aging and recurring-revenue metrics.
- Vendor/purchasing analytics.
- Financial/tax/clearing reports.
- Inventory/balance/operational KPI snapshots and other genuinely temporal metrics.
- Reporting by economic entity independently of how accounting books group those entities.

Transactional relational data remains ordinary PostgreSQL tables; Timescale is used where data is genuinely temporal.

## 14. Events and background work

### NOW

- Graphile Worker backed by the same PostgreSQL deployment.
- Scheduled polling, durable jobs, retries/backoff, priorities, and job-key deduplication/idempotency.
- Database-driven monitor scheduling rather than one permanent cron entry per watched item.
- Raw provider events/objects separated from normalized domain processing.
- One Loxep image supporting `LOXEP_MODE=all|web|worker`.
- Default deployment running web + worker capability in one Loxep container.

### DESIGN-FOR

- Multiple worker processes/hosts sharing the same PostgreSQL queue.
- Replayable ingestion pipelines.
- Dead-letter/error investigation workflows and operational job visibility.
- Specialized worker pools if measured workloads justify them.

## 15. Authentication, users, authorization, and settings

### NOW

- Multiple application users even though Loxep is not designed around classic SaaS tenancy.
- Better Auth.
- Generic OIDC, with Pocket ID as an intended tested deployment.
- Magic-link authentication.
- Password authentication disabled initially.
- Better Auth-owned deployment roles `admin`/`member`.
- Installation-wide ordinary product access for trusted members.
- Admin-only installation/security/administrative actions where elevation is justified.
- Explicit first-admin bootstrap/recovery.
- No Phase 0 per-connection/per-workspace/per-economic-entity ACL model.
- Database-backed application settings.
- Application-encrypted runtime secrets with external root key/keyring.

An external marketplace account is not the same thing as an application login identity. A workspace is not a tenant. An economic entity is neither a user nor a permission container. Fine-grained access remains a later extension if real use demands it.

## 16. Public/integration API and notifications

### NOW / DESIGN-FOR

- ntfy as the first notification adapter.
- Priority/title/message/tags/deep links.
- Notification rules separated from event detection/delivery.
- Stable versioned HTTP API designed for integrations outside the Loxep frontend.
- OpenAPI contract when the external API is implemented.
- Authentication/API credentials appropriate to self-hosted deployments.
- Webhooks/outbound events eventually.
- Internal application code using shared domain services rather than duplicating business logic in route/API handlers.

Framework-native server functions are fine internally; Loxep must not depend on a TypeScript-only RPC protocol as its sole integration boundary.

## 17. Companion services

### NOW / NEXT

- Generic external resource/link model.
- RustFS optional S3 Compose profile.
- ntfy first-class notification companion.
- Databasus backup-health integration as a strong early candidate.

### RECOMMENDED / EVALUATE

- Knowledge/docs: Outline, AFFiNE, compatible alternatives.
- Tasks/projects: Vikunja or compatible alternatives.
- Billing portal/delivery: Invoice Ninja.
- Database backups: Databasus.
- File/config backups: Backrest/restic.
- Container management: Dockhand.
- SSH/terminal management: TermixSSH.
- Metrics: Beszel.
- Uptime: Gatus.
- Private networking: Tailscale.

These are independent applications, not required Loxep dependencies. Their APIs, versions, licenses, and compatibility must be reverified before implementation or version-specific documentation.

## 18. UI/application experience

### NOW

- TanStack Start + React.
- TanStack Router/Query/Table/Form where useful.
- shadcn/ui + Base UI + Tailwind.
- Kiranism `tanstack-start-dashboard` integrated as the initial UI donor/reference.
- `/dashboard/*` as real Loxep product space and `/starter/*` as preserved reference space.
- Workspace-aware sidebar and Cmd+K navigation.
- Multi-theme/tweakcn theme system.
- Recharts retained for ordinary dashboard/business charts.
- DnD retained for workflows/configuration that benefit from it.
- Zustand retained for genuine cross-component ephemeral/editing UI state, while durable preferences live in PostgreSQL.
- Apache ECharts available later when dense time-series/analytical views justify it.

### Principle

Starter code accelerates presentation; it does not own Loxep architecture, data model, auth, provider behavior, or dependency versions.

## 19. Deployment and operations

### NOW

- Generic, unbranded self-hosted containers.
- One Loxep image with `all|web|worker` runtime modes.
- Default minimal Compose deployment: `loxep + postgres-timescale`.
- Optional RustFS Compose service/profile for S3-compatible media.
- No Redis requirement merely for queueing.
- Bootstrap environment/mounted-secret configuration only for pre-DB/pre-login/runtime-topology facts.
- Normal settings/provider credentials managed in-app and stored in PostgreSQL, with secrets encrypted.
- Health checks, readiness, migrations, structured logging, backup/restore guidance.
- Dependency/version policy requiring current viable upstream verification before pins.

### DESIGN-FOR

- Reverse-proxy-agnostic deployment.
- Container registry releases.
- Upgrade/migration guidance.
- Optional OpenTelemetry when a concrete use exists.
- Scale-out web/worker hosts.
- Shared S3-compatible storage for multi-host operation.

## 20. Documentation and open-source project needs

### NOW

- Documentation stored with the repository.
- Current Astro Starlight documentation site and GitHub Pages deployment.
- Product/domain documentation, architecture docs, ADRs, Phase 0 spec, foundation schema, workspace map, configuration policy, and implementation contract.
- Dependency/version freshness policy.
- Internal-doc-link validation in CI.
- MIT license.
- Broad docs updated when later decisions supersede earlier assumptions.

### DESIGN-FOR

- User guide, integration-authoring guide, API docs, contributor guide, deployment/upgrade/backup guides.
- Copyable companion-service Compose/config templates.
- Future docs-renderer migration without coupling product architecture to Starlight.
- Separate public `loxep.com` informational/marketing site and public demo surface.

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
      Financial/economic facts
              |
              v
        Accounting books
              |
              v
       Reporting / tax views
```

## What Loxep is not

The map should not be read as a plan to become:

- a generic enterprise CRM;
- a comprehensive tax-rate/legal-advice engine;
- a microservice platform;
- a classic multi-tenant SaaS framework;
- a plugin marketplace before concrete extension needs exist;
- a replacement for every mature specialist self-hosted tool;
- an infrastructure management platform.

Where mature external systems solve specialized problems well, Loxep should integrate or recommend them until owning that capability provides clear value.