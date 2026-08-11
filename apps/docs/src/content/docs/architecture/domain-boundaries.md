---
title: Domain Boundaries and Ownership
---

Loxep is a modular monolith. Modules are ownership boundaries, not deployment boundaries. Each domain owns its canonical records and exposes operations/events to other domains rather than allowing presentation code or unrelated modules to mutate arbitrary tables.

## Workspaces are not domain boundaries

The application's top-level workspaces organize navigation and workflows. They do **not** define database schemas, package boundaries, services, or tenancy.

For example, the proposed Finance workspace may compose Billing, Payments, Banking, Accounting, Tax, and Reporting domains. Those domains keep distinct ownership even if the user experiences them in one navigation surface.

See [Workspaces & Navigation](../../product/workspaces/) for the UX map.

## Shared foundation

The shared foundation owns infrastructural concepts rather than commercial business logic:

- application identity references and profile data;
- minimal economic-entity identity/attribution;
- external connections/accounts and credentials;
- database-backed application settings and encrypted application/runtime secrets;
- source/provider events and retained raw provider objects;
- durable jobs and job conventions;
- media identity/storage abstraction and storage-migration state;
- generic external-resource links;
- audit metadata and health state;
- stable identifiers and cross-domain references.

Better Auth owns application authentication/session state and deployment-level `admin`/`member` roles. The initial access model is installation-wide for ordinary product data; Phase 0 does not create connection/entity/workspace ACL relations.

Bootstrap environment/mounted-secret configuration remains outside this domain where it must exist before PostgreSQL-backed administration or login can work. Normal runtime/provider settings belong in PostgreSQL. See [Configuration & Secrets](../configuration-and-secrets/).

Shared foundation must not become a dumping ground for unrelated business logic.

### Scheduling is shared foundation infrastructure

**PROVISIONAL — implemented ahead of review; see [Commerce Schema Design](../commerce-schema-design/#provisional-implementation-decisions).**

The polling/due-work scheduling model (`monitor_targets` and its `interval_seconds`, `next_poll_at`, `priority`, `backoff_until`, `consecutive_errors`, and namespaced `config` state) is **shared foundation infrastructure that any domain may register a target type against**, not a Market Intelligence-owned table. Market Intelligence owns the `ebay_*` target types and everything they observe; it does not own the mechanism. The claim/backoff/adaptive-cadence primitives are deliberately target-type-agnostic and operate on any row.

This resolves the tension between this document's earlier placement of monitor targets under Market Intelligence and the [Foundational Data Model](../foundational-data-model/)'s presentation of scheduling as the general due-work mechanism. The alternative — a second scheduling table per domain — would duplicate claim semantics, adaptive cadence, and rate-budget handling for no gain, and is rejected.

The rules that keep this from becoming a shared dumping ground:

- a domain registers a **target type** and a Zod schema for that type's `config`; it does not add columns to `monitor_targets`;
- transient per-type state lives under a **namespaced `config` key** owned by the registering domain (`adaptive` for the scheduler, `commerceSync` for Commerce's order cursor). No domain reads or writes another's namespace;
- the **executor** for a target type belongs to the domain that registered it, wired in the composition root — never in the scheduling package.

Phase 3 registers `woo_orders` (Commerce order polling) this way.

## Economic entities

The foundation owns the minimal identity of people, businesses, and operating identities whose activity Loxep represents.

Examples include:

- personal/individual activity;
- sole proprietorships;
- LLCs, partnerships, and corporations;
- assumed names/DBAs and operating units beneath another entity.

An economic entity is neither a tenant nor an authorization container. A parent relation may express an assumed name beneath an LLC without implying that it is a separate legal person.

Provider connections and later operational records may reference an economic entity when ownership/context is meaningful.

Economic entities are also distinct from accounting books. The Accounting domain may later associate multiple economic entities/operating identities with one book and chart of accounts. Do not force one accounting ledger per economic entity.

See ADR-0017.

## Market Intelligence

Owns observations about things Loxep does not necessarily own or sell:

- monitor targets;
- marketplace searches;
- watched listings/items;
- sellers being observed;
- time-series listing observations;
- detected market events;
- market-derived metrics such as price history, restock timing, and sellout estimates;
- opportunity rules/scores.

It does not own internal inventory, orders, customers, or accounting records.

Marketplace listings/observations are generally entity-neutral public facts. A monitor or authenticated observation may still carry connection context that indirectly identifies the interested economic entity.

## Integrations

Each provider adapter owns protocol-specific behavior, authentication mechanics, rate-limit handling, pagination, provider identifiers, mapping, and webhook/poll ingestion.

Examples include eBay, WooCommerce, Medusa, Invoice Ninja, ntfy, task/knowledge systems, shipping providers, banks, backup-health sources, and other companions.

Provider SDK response types stop at this boundary. Integration code emits provider/source facts or calls domain services using Loxep-owned types.

An external application's object identity may be represented through `external_resources` and linked to Loxep objects without creating provider-specific columns throughout the schema.

Provider credentials are obtained through the shared credential/secret service rather than read from arbitrary environment variables or serialized into provider config JSON.

## Media and storage foundation

Media identity is cross-domain infrastructure rather than something each domain reimplements.

Owns:

- configured storage backends;
- `media_objects` metadata and stable Loxep media IDs;
- `media_links` between media and domain resources;
- local/S3 storage-driver contract;
- resumable storage-migration state and verification.

The storage foundation does not own the business meaning of an attachment. Accounting may know that an image is receipt evidence; Media knows how that file is identified, stored, verified, and retrieved.

RustFS is an initial deployment recommendation, not a domain dependency. Storage semantics remain generic local/S3.

## Catalog and Listings

Owns Loxep's internal description of products/services and their channel representations:

- products/SKUs/variants where an internal catalog is required;
- listing-to-item mappings;
- channel listing metadata/publication state;
- bundles/kits/assemblies at the commercial-definition level.

Provider-native listing fields may remain in provider-specific extensions when normalization would be lossy. Product/listing media references the shared media foundation.

## Commerce

Owns sales transactions originating from commerce channels:

- orders;
- order lines;
- order-level adjustments/discount facts;
- refunds/returns as commercial facts;
- order status lifecycle;
- channel/customer references associated with the sale.

Commerce does not directly create journal lines or mutate inventory quantities. It requests/causes inventory movements and emits economic facts consumed downstream.

Commerce facts that represent owned activity should carry explicit economic-entity attribution rather than inferring it from the logged-in user or workspace.

## Inventory and Acquisition

Owns physical ownership and movement of goods:

- inventory items/stock units;
- locations;
- acquisitions;
- receipts;
- inventory movements;
- allocations/reservations;
- cost layers/cost basis;
- landed-cost allocations;
- serial/lot information where needed.

An order line can reference inventory, but Commerce does not own stock state.

Inventory ownership/location design must allow entity attribution where required rather than assuming all stock in an installation belongs to one business.

## Purchasing

Owns intent and obligations to vendors before inventory is received:

- vendors in purchasing context;
- purchase orders/lines;
- expected receipts;
- vendor bills/credits where AP functionality is implemented.

Receipt of physical goods produces Inventory facts. Financial obligations produce Financial/Accounting facts.

## Shipping and Fulfillment

Owns movement from seller to buyer after a sale and shipping-related operational facts:

- shipments;
- packages;
- labels;
- tracking;
- carrier/service;
- actual postage, insurance, surcharges, adjustments, and refunds;
- links from shipment to order/order lines.

Customer-paid shipping is a Commerce fact; actual carrier cost is a Shipping/Cost fact. They remain distinguishable.

## Customers and counterparties

Owns the reusable party/contact model for people and organizations Loxep economic entities do business with:

- people/organizations;
- contacts;
- addresses/sites;
- customer preferences/terms;
- tax/exemption metadata belonging to the customer identity.

Domains may reference customers/counterparties but should not duplicate party identity records.

An external organization is not automatically an installation-owned economic entity. The same real-world company could be an economic entity in one Loxep installation and merely a customer/vendor/payer in another.

## Projects and Work

Owns non-commerce work execution:

- projects/jobs;
- sites;
- work status;
- time entries;
- project tasks/milestones where implemented;
- billable work facts;
- project attribution for materials, expenses, and services.

Physical materials remain Inventory-owned and may be allocated/consumed by a project.

External task/project systems such as Vikunja may be linked through the generic external-resource model without becoming canonical project data unless an explicit synchronization/import design says otherwise.

## Services and Subscriptions

Owns recurring or continuing service obligations independent of invoice generation:

- service definitions/plans;
- subscriptions/items;
- service periods;
- billing cadence/renewal schedule;
- operational metadata for hosted/managed services where useful.

A subscription can generate billable facts but is not itself an invoice.

## Billing and Receivables

Owns amounts requested from customers outside or above channel-native order billing:

- quotes/estimates when implemented;
- invoices/lines;
- credit notes;
- receivable state;
- recurring invoice generation as a billing concern;
- mappings/links to an external billing surface such as Invoice Ninja.

Invoice Ninja may initially deliver invoices and customer portal/payment UX without becoming Loxep's canonical operational model.

## Payments, Payouts, and Banking

Owns movement/settlement facts involving payment processors, marketplaces, and financial accounts:

- payments and allocations;
- processor/marketplace fees as source financial facts;
- payout batches;
- clearing relationships;
- imported bank transactions;
- reconciliation state.

This domain records financial reality; Accounting determines how those facts post to a book/ledger.

## Costs and Expenses

Owns costs not already represented as inventory acquisition or another specialized source fact, plus flexible attribution of costs to operational objects.

A cost may reference customer, project, order, shipment, acquisition, product/SKU, channel, service, economic entity, or other supported dimensions.

Cost attribution is operational metadata and must survive changes to accounting classification.

## Accounting

Owns accounting interpretation, not source business facts:

- accounting books;
- relationships between books and economic entities/operating identities;
- chart of accounts;
- fiscal periods;
- journal entries/lines;
- posting rules;
- accounting dimensions/classes/departments where justified;
- reconciliation links needed by the ledger;
- trial balance and financial statements.

The ledger is downstream of operational facts. Journal entries generated from rules should retain references back to source facts and be reproducible where practical.

An accounting book is **not** synonymous with an economic entity. Multiple economic entities/operating identities may share one book and be separated by chart-of-accounts structure or accounting dimensions. Conversely, the eventual book/entity cardinality should be chosen from real accounting needs rather than encoded prematurely in the Phase 0 foundation.

## Tax

Owns tax facts, obligations, classifications, and reporting support, but Loxep does not initially attempt to become a tax-rate/calculation authority.

Owns/designs for:

- sales-tax facts by jurisdiction;
- marketplace-facilitator treatment;
- exemptions/taxability classifications;
- filing-period summaries;
- income-tax-oriented reports/exports;
- external tax-provider mappings where used.

Tax calculations supplied by marketplaces/processors/providers are preserved as source facts.

## Documents

Owns **document semantics and extracted content**, while the shared Media foundation owns underlying binary storage.

Examples include receipts, bills, customer POs, contracts, quotes, invoices, packing slips, shipping documents, and tax records.

Documents may own OCR text, structured extraction, matching status, document type, and business relationships while referencing one or more shared media objects.

## Reporting and Analytics

Owns derived read models, aggregates, dashboards, and metrics. It does not become the canonical owner of underlying operational data.

Timescale continuous aggregates, materialized views, and analytical SQL belong here when they represent derived views rather than source observations.

Reporting may aggregate or segment by economic entity independently of how Accounting groups those entities into books.

## Cross-domain rules

1. A domain may reference another domain's stable ID but should not mutate another domain's canonical tables directly from presentation code.
2. Cross-domain workflows run through domain services and/or durable events/jobs.
3. Raw provider data is retained at the integration/source boundary; normalized business facts are stored by the owning domain.
4. Derived state identifies the source facts from which it was computed where practical.
5. Avoid shared tables containing unrelated optional columns from many domains merely to reduce table count.
6. Do not create generic abstractions until concrete workflows show the abstraction is real; media, settings/secrets, economic-entity attribution, and external-resource links are early exceptions because they solve already-known cross-cutting needs.
7. Financial and tax interpretations must not overwrite operational history.
8. External companion applications remain independently authoritative for data Loxep has not deliberately chosen to own.
9. UI workspace placement does not transfer backend ownership between domains.
10. Application users, provider connections, economic entities, counterparties, and accounting books are distinct concepts.
11. Economic entities classify owned/operated activity; they do not define who may access data in the installation.
