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
- Define persistent marketplace searches independent of the eBay watchlist.
- Monitor explicit listings/items.
- Monitor sellers and seller inventory.
- Poll at configurable/adaptive intervals, initially around 60 seconds where API limits permit.
- Persist granular observations over time rather than only current state.
- Detect price changes.
- Detect availability/restock transitions.
- Detect sellout/unavailable transitions.
- Detect quantity changes where observable.
- Detect new matching listings.
- Detect listing endings/ended state.
- Retain raw provider payload/evidence where useful.
- ntfy notifications with deep links and configurable rules.
- Durable, idempotent event processing.

### NEXT

- Price-history charts.
- Availability/stock-history charts.
- Restock frequency and time-of-day analysis.
- Approximate sellout duration from observation boundaries.
- Seller-level inventory and pricing trends.
- Search-result history and market trend views.
- Opportunity/deal scoring.
- Configurable target-price and acquisition rules.
- More adaptive polling around interesting transitions.

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

- Generic connection/account model.
- Multiple accounts for the same provider.
- Credentials encrypted at rest.
- Per-connection health and synchronization status.
- Provider-specific configuration without leaking provider details through the domain model.
- eBay adapter built on a maintained API library where appropriate.
- Incoming provider-event/raw-object persistence and idempotency.

### NEXT

- WooCommerce adapter.
- Medusa adapter.
- Webhook ingestion where providers support it.
- Connection diagnostics and resynchronization tools.

### DESIGN-FOR

- Shopify, Etsy, payment processors, banks, shipping services, tax services, and other commerce providers.
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

- Listing creation and synchronization.
- Channel-specific pricing.
- Channel-specific availability.
- Bundles/kits.
- Returns and exchanges.
- Customer service history.

## 4. Catalog and listings

### NEXT

- Internal catalog items/SKUs independent of provider listings.
- Map one catalog item to multiple marketplace/store listings.
- Listing state and channel metadata.
- Product costs and sale prices.

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
- Purchase orders.
- Purchase receipts.
- Vendor bills.
- Vendor credits/refunds.
- Payment terms.
- Inbound freight.
- Duties/tariffs.
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
- Pirate Ship or other shipping-data ingestion where feasible.
- Label purchasing.
- Packages, dimensions, and weights.
- Insurance.
- Carrier adjustments/refunds.
- Split shipments.
- Shipping cost allocation across order lines.
- Shipping-performance analytics.

## 8. Customers and CRM foundation

### DESIGN-FOR

- Individuals and organizations.
- Multiple contacts.
- Multiple addresses/sites.
- Communication details.
- Tax status/exemption metadata.
- Payment/billing terms.
- Notes and attachments.
- Unified operational history across commerce, projects, services, and billing.

The intent is operational customer context, not a general-purpose enterprise CRM.

## 9. Projects, jobs, and service work

### DESIGN-FOR

- Projects/jobs linked to customers and sites.
- Project lifecycle/status.
- Estimates/budgets.
- Tasks/milestones where operationally useful.
- Time entries.
- Billable and non-billable work.
- Materials allocated from inventory.
- Project expenses.
- Reimbursable expenses.
- Mileage/travel attribution.
- Subcontractor/vendor costs.
- Work orders.
- Project/job profitability.

Use cases include consulting, development, hosting work, technology integration, installation, repair, and similar service activity.

## 10. Services and subscriptions

### DESIGN-FOR

- Service plans.
- Customer subscriptions.
- Subscription items.
- Monthly, annual, and arbitrary billing cadences.
- Service periods.
- Renewal dates.
- Recurring and usage/manual charges.
- Hosting/service operational metadata.
- Internal cost basis for recurring services.
- Subscription profitability.
- Suspension/cancellation/history.

Subscriptions should be operational objects that can produce billing, not merely recurring invoice templates.

## 11. Billing and accounts receivable

### DESIGN-FOR

- Quotes/estimates.
- Invoices.
- Invoice lines from products, time, projects, subscriptions, expenses, and manual billables.
- Recurring billing.
- Credit notes.
- Payments.
- Payment allocation.
- Accounts receivable aging.
- Payment reminders.
- Invoice numbering.
- Taxes.
- Customer-facing PDFs.
- Email delivery.
- Customer portal/payment links.

### TRANSITION OPTION

- Integrate with Invoice Ninja initially rather than rebuilding its mature delivery/payment/portal features before Loxep's underlying business model is useful.

## 12. Payments, payouts, and banking

### DESIGN-FOR

- Payment-provider transactions.
- Marketplace fees.
- Processor fees.
- Refunds.
- Chargebacks.
- Marketplace reserves/holds.
- Payout batches.
- Clearing accounts.
- Bank transactions.
- Bank feeds/imports.
- Reconciliation.
- Transfers.

A sale and its eventual bank deposit must remain reconcilable through intervening fees, refunds, taxes, and clearing balances.

## 13. Expenses and cost attribution

### DESIGN-FOR

- Expenses and receipts.
- Vendors/payees.
- Categories/accounting accounts.
- Recurring expenses.
- Reimbursable expenses.
- Fixed-asset candidates.
- Flexible attribution of costs to relevant operational objects.

A cost may relate to any combination of:

- customer;
- project/job;
- order;
- shipment;
- inventory acquisition;
- product/SKU;
- sales channel;
- vendor;
- service/subscription;
- accounting entry.

Cost attribution is a first-class analytical concern, not merely an expense category.

## 14. Accounting

### DESIGN-FOR

- Double-entry ledger.
- Chart of accounts.
- Journal entries and lines.
- Posted versus draft states.
- Fiscal periods and closing controls.
- Accounts receivable and payable integration.
- Inventory/COGS postings.
- Marketplace clearing accounts.
- Payment-processor clearing accounts.
- Declarative posting rules translating operational/financial events into journal entries.
- Replay/rebuild of derived accounting when posting logic changes, subject to appropriate controls.
- Trial balance.
- Profit and loss.
- Balance sheet.
- Cash-flow-oriented reporting.

### Principle

The ledger is downstream of operational truth. Orders, shipments, purchases, payments, inventory movements, and other source facts should not be destroyed merely because accounting treatment changes.

## 15. Tax

### DESIGN-FOR

- Sales-tax amounts and jurisdiction facts attached to transactions.
- Marketplace-facilitator treatment.
- Taxable/non-taxable products and services.
- Customer exemption information.
- Sales-tax liability reporting by jurisdiction/period.
- External tax-calculation integrations rather than inventing a comprehensive tax engine.
- Income-tax-oriented reporting and exports.
- Estimated-tax periods/reminders.
- 1099/vendor reporting inputs where applicable.

Loxep should preserve tax facts and support reporting; it should not attempt to become tax-law software.

## 16. Assets and vehicles

### POSSIBLE / DESIGN-FOR

- Business equipment/tools/computers/vehicles.
- Acquisition and disposal.
- Assignment/location.
- Depreciation inputs and accounting references.
- Vehicle mileage logs.
- Mileage attribution to projects/customers/business purpose.

## 17. Documents

### DESIGN-FOR

- Attach documents to domain objects without duplicating storage concepts in every module.
- Receipts.
- Vendor bills/invoices.
- Customer purchase orders.
- Quotes/contracts.
- Packing slips.
- Shipping documents.
- Statements.
- Searchable metadata.
- OCR/text extraction.
- Structured extraction of invoice/receipt fields.
- Matching extracted documents to existing transactions, vendors, products, and purchases.
- Object storage abstraction.

## 18. Reporting and analytics

### NEXT

- Marketplace price/availability history.
- Seller/search/listing metrics.
- Channel/order metrics as commerce ingestion arrives.

### DESIGN-FOR

- Profitability by item, SKU, order, customer, project, channel, and service.
- Realized acquisition ROI.
- Shipping variance.
- Marketplace/processor fee analysis.
- Inventory valuation.
- Inventory aging/turnover.
- AR/AP aging.
- Recurring revenue and subscription profitability.
- Vendor/purchasing analytics.
- P&L, balance sheet, trial balance.
- Sales-tax liability.
- Cash and clearing reconciliation.

## 19. Time-series data

### NOW

- PostgreSQL with TimescaleDB available from the initial deployment.
- Marketplace/listing observations modeled as hypertables from the beginning.
- Preserve raw observation resolution where valuable.

### NEXT

- Continuous aggregates for hourly/daily analytical views.
- Retention/compression policies chosen from measured data volume rather than assumptions.

### DESIGN-FOR

- Inventory-level observations/snapshots.
- Balance snapshots.
- Operational KPI history.
- Shipping/market/channel metrics over time.

Transactional relational data remains ordinary PostgreSQL tables; Timescale is used where the data is genuinely temporal.

## 20. Events and background work

### NOW

- Graphile Worker backed by the same PostgreSQL deployment.
- Scheduled polling.
- Durable jobs.
- Retries/backoff.
- Priorities.
- Job-key deduplication/idempotency.
- Database-driven monitor scheduling rather than a permanent cron entry per watched item.
- Raw provider events/objects separated from normalized domain processing.

### DESIGN-FOR

- Replayable ingestion pipelines.
- Dead-letter/error investigation workflows.
- Operational job visibility.
- Domain events consumed independently by notifications, commerce, inventory, accounting, and analytics processors.

## 21. Authentication, users, and authorization

### NOW

- Multiple application users even though Loxep is not designed around SaaS tenancy.
- Better Auth.
- Generic OIDC, with Pocket ID as an intended deployment.
- Magic-link authentication.
- Password authentication disabled by default/initially unsupported.
- First-run administrator bootstrap.

### NEXT / DESIGN-FOR

- Users can access multiple provider connections/accounts.
- Connection-level owner/manage/view permissions.
- Roles/capabilities where needed.
- Audit trail for consequential actions.

An external marketplace account is not the same thing as an application login identity.

## 22. Public/integration API

### DESIGN-FOR FROM THE START

- Stable versioned HTTP API for integrations outside the Loxep frontend.
- OpenAPI contract.
- Authentication/API credentials appropriate to self-hosted deployments.
- Webhooks/outbound events eventually.
- Internal application code calls shared domain services rather than implementing business logic separately in the API.

The browser application may use framework-native server functions internally; Loxep should not depend on a TypeScript-only RPC protocol as its sole integration boundary.

## 23. Notifications

### NOW

- ntfy integration.
- Priority, title, message, tags, and deep links.
- Notification rules separated from event detection.

### DESIGN-FOR

- Email.
- Web push.
- Other notification providers through adapters.
- Quiet hours/escalation/routing.

## 24. Deployment and operations

### NOW

- Generic, unbranded self-hosted containers.
- Docker Compose reference deployment.
- Separate web/app and worker processes.
- PostgreSQL + TimescaleDB.
- No Redis requirement merely for queueing.
- Environment-based configuration/secrets.
- Health checks.
- Database migrations.
- Backup/restore documentation.

### DESIGN-FOR

- Reverse-proxy-agnostic deployment.
- Container registry releases.
- Upgrade/migration guidance.
- Observability and structured logs.
- Optional OpenTelemetry.
- Scale-out workers if actual workload requires them.

## 25. Documentation and open-source project needs

### NOW

- Documentation stored with the repository.
- Astro Starlight documentation site.
- Public GitHub Pages deployment.
- Product/domain documentation.
- Architecture documentation.
- Architecture Decision Records (ADRs).
- Development/setup documentation as implementation begins.
- MIT license.

### DESIGN-FOR

- User guide.
- Integration authoring guide.
- API documentation.
- Contributor guide.
- Deployment and upgrade guides.

## Cross-domain flow

The intended high-level relationship is:

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
- a project-management suite;
- an HR system.

Where mature external systems solve specialized problems well, Loxep should integrate rather than reproduce them until owning that capability provides clear value.
