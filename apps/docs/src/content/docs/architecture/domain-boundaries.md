---
title: Domain Boundaries and Ownership
---

# Domain Boundaries and Ownership

Loxep is a modular monolith. Modules are ownership boundaries, not deployment boundaries. Each domain owns its canonical records and exposes operations/events to other domains rather than allowing presentation code or unrelated modules to mutate arbitrary tables.

## Shared foundation

The shared foundation owns infrastructural concepts rather than commercial business logic:

- application identity references and profile data;
- Loxep resource authorization relationships;
- external connections/accounts and credentials;
- source/provider events and retained raw provider objects;
- durable jobs and job conventions;
- media identity/storage abstraction and storage-migration state;
- generic external-resource links;
- application configuration, audit metadata, and health state;
- stable identifiers and cross-domain references.

Better Auth owns application authentication/session state and deployment-level roles. Shared foundation should reference that identity rather than duplicate Better Auth's global role model.

Shared foundation must not become a dumping ground for unrelated business logic.

## Market Intelligence

Owns observations about things Loxep does not necessarily own or sell.

Owns:

- monitor targets;
- marketplace searches;
- watched listings/items;
- sellers being observed;
- time-series listing observations;
- detected market events;
- market-derived metrics such as price history, restock timing, and sellout estimates;
- opportunity rules/scores.

Does not own internal inventory, orders, customers, or accounting records.

## Integrations

Each provider adapter owns protocol-specific behavior, authentication mechanics, rate-limit handling, pagination, provider identifiers, mapping, and webhook/poll ingestion.

Examples include eBay, WooCommerce, Medusa, Invoice Ninja, ntfy, task/knowledge systems, shipping providers, banks, backup-health sources, and other companions.

Provider SDK response types must stop at this boundary. Integration code emits provider/source facts or calls domain services using Loxep types.

An external application's object identity may be represented through `external_resources` and linked to Loxep objects without creating provider-specific columns throughout the schema.

## Media and storage foundation

Media identity is cross-domain infrastructure rather than something each domain reimplements.

Owns:

- `media_objects` metadata and stable Loxep media IDs;
- `media_links` between media and domain resources;
- local/S3 storage-driver contract;
- storage backend configuration references;
- resumable storage-migration state and verification.

The storage foundation does not own the business meaning of an attachment. For example, Accounting may know that an image is receipt evidence; Media knows how that file is identified, stored, verified, and retrieved.

RustFS is an initial deployment recommendation, not a domain dependency. Storage semantics remain generic local/S3.

## Catalog and Listings

Owns Loxep's internal description of products/services and their channel representations.

Owns:

- products/SKUs/variants where an internal catalog is required;
- listing-to-item mappings;
- channel listing metadata and publication state;
- bundles/kits/assemblies at the commercial-definition level.

Provider-native listing fields may remain in provider-specific extensions when normalization would be lossy. Product/listing media references the shared media foundation.

## Commerce

Owns sales transactions originating from commerce channels.

Owns:

- orders;
- order lines;
- order-level adjustments/discount facts;
- refunds/returns as commercial facts;
- order status lifecycle;
- channel/customer references associated with the sale.

Commerce does not directly create journal lines or mutate inventory quantities. It requests/causes inventory movements and emits economic facts consumed downstream.

## Inventory and Acquisition

Owns physical ownership and movement of goods.

Owns:

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

## Purchasing

Owns intent and obligations to vendors before inventory is received.

Owns:

- vendors in purchasing context;
- purchase orders and lines;
- expected receipts;
- vendor bills/credits where AP functionality is implemented.

Receipt of physical goods produces Inventory facts. Financial obligations produce Financial/Accounting facts.

## Shipping and Fulfillment

Owns movement from seller to buyer after a sale and shipping-related operational facts.

Owns:

- shipments;
- packages;
- labels;
- tracking;
- carrier/service;
- actual postage, insurance, surcharges, adjustments, and refunds;
- links from shipment to order/order lines.

Customer-paid shipping is a Commerce fact; actual carrier cost is a Shipping/Cost fact. They must remain distinguishable.

## Customers

Owns the reusable party/contact model for people and organizations Loxep users do business with.

Owns:

- people/organizations;
- contacts;
- addresses/sites;
- customer preferences/terms;
- tax/exemption metadata belonging to the customer identity.

Domains may reference customers but should not duplicate customer identity records.

## Projects and Work

Owns non-commerce work execution.

Owns:

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

Owns recurring or continuing service obligations independent of invoice generation.

Owns:

- service definitions/plans;
- subscriptions and items;
- service periods;
- billing cadence/renewal schedule;
- operational metadata for hosted/managed services where useful.

A subscription can generate billable facts but is not itself an invoice.

## Billing and Receivables

Owns amounts requested from customers outside or above channel-native order billing.

Owns:

- quotes/estimates when implemented;
- invoices and lines;
- credit notes;
- receivable state;
- recurring invoice generation as a billing concern;
- mappings/links to an external billing surface such as Invoice Ninja.

Invoice Ninja may initially deliver invoices and customer portal/payment UX without becoming Loxep's canonical operational model.

## Payments, Payouts, and Banking

Owns movement/settlement facts involving payment processors, marketplaces, and financial accounts.

Owns:

- payments and allocations;
- processor/marketplace fees as source financial facts;
- payout batches;
- clearing relationships;
- imported bank transactions;
- reconciliation state.

This domain records financial reality; Accounting determines how those facts post to the ledger.

## Costs and Expenses

Owns costs not already represented as inventory acquisition or another specialized source fact, plus flexible attribution of costs to operational objects.

A cost may reference customer, project, order, shipment, acquisition, product/SKU, channel, service, or other supported dimensions.

Cost attribution is operational metadata and must survive changes to accounting classification.

## Accounting

Owns accounting interpretation, not source business facts.

Owns:

- accounting entities;
- chart of accounts;
- fiscal periods;
- journal entries/lines;
- posting rules;
- reconciliation links needed by the ledger;
- trial balance and financial statements.

The ledger is downstream of operational facts. Journal entries generated from rules should retain references back to source facts and be reproducible where practical.

## Tax

Owns tax facts, obligations, classifications, and reporting support, but Loxep does not initially attempt to become a tax-rate/calculation authority.

Owns/designs for:

- sales-tax facts by jurisdiction;
- marketplace-facilitator treatment;
- exemptions and taxability classifications;
- filing-period summaries;
- income-tax-oriented reports/exports;
- external tax-provider mappings where used.

Tax calculations supplied by marketplaces/processors/providers must be preserved as source facts.

## Documents

Owns **document semantics and extracted content**, while the shared Media foundation owns the underlying binary storage.

Examples include receipts, bills, customer POs, contracts, quotes, invoices, packing slips, shipping documents, and tax records.

Documents may own OCR text, structured extraction, matching status, document type, and business relationships while referencing one or more shared media objects.

## Reporting and Analytics

Owns derived read models, aggregates, dashboards, and metrics. It does not become the canonical owner of the underlying operational data.

Timescale continuous aggregates, materialized views, and analytical SQL belong here when they represent derived views rather than source observations.

# Cross-domain rules

1. A domain may reference another domain's stable ID but should not mutate another domain's canonical tables directly from presentation code.
2. Cross-domain workflows run through domain services and/or durable events/jobs.
3. Raw provider data is retained at the integration/source boundary; normalized business facts are stored by the owning domain.
4. Derived state should identify the source facts from which it was computed.
5. Avoid shared tables that contain unrelated optional columns from many domains merely to reduce table count.
6. Do not create generic abstractions until concrete workflows demonstrate that the abstraction is real; the media and external-resource abstractions are early exceptions because they solve clearly cross-domain relationships already present in the planned product.
7. Financial and tax interpretations must not overwrite operational history.
8. External companion applications remain independently authoritative for data Loxep has not deliberately chosen to own.
