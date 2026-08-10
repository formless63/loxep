---
title: Domain Boundaries and Ownership
---

# Domain Boundaries and Ownership

Loxep is a modular monolith. Modules are not deployment boundaries; they are ownership boundaries. Each domain owns its canonical records and exposes operations/events to other domains rather than allowing arbitrary cross-domain mutation.

## Shared foundation

The shared foundation owns concepts that are infrastructural rather than commercial:

- application users and authorization;
- external connections/accounts and credentials;
- source/provider events and retained raw provider objects;
- durable jobs and job conventions;
- application configuration, audit metadata, and health state;
- stable identifiers and cross-domain references.

Shared foundation must not become a dumping ground for business logic.

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

Examples: eBay, WooCommerce, Medusa, Invoice Ninja, ntfy, shipping providers, banks.

Provider SDK response types must stop at this boundary. Integration code emits provider/source facts or calls domain services using Loxep types.

## Catalog and Listings

Owns Loxep's internal description of products/services and their channel representations.

Owns:
- products/SKUs/variants where an internal catalog is required;
- listing-to-item mappings;
- channel listing metadata and publication state;
- bundles/kits/assemblies at the commercial-definition level.

Provider-native listing fields may remain in provider-specific extensions when normalization would be lossy.

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

An order line can reference inventory, but the Commerce domain does not own stock state.

## Purchasing

Owns intent and obligations to vendors before inventory is received.

Owns:
- vendors in purchasing context;
- purchase orders;
- purchase-order lines;
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
- tax/exemption metadata that belongs to the customer identity.

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

## Services and Subscriptions

Owns recurring or continuing service obligations independent of invoice generation.

Owns:
- service definitions/plans;
- subscriptions;
- subscription items;
- service periods;
- billing cadence/renewal schedule;
- operational metadata for hosted/managed services where useful.

A subscription can generate billable facts but is not itself an invoice.

## Billing and Receivables

Owns amounts requested from customers outside or above channel-native order billing.

Owns:
- quotes/estimates when implemented;
- invoices;
- invoice lines;
- credit notes;
- receivable state;
- recurring invoice generation as a billing concern;
- mappings to an external billing surface such as Invoice Ninja.

Invoice Ninja may initially deliver invoices and customer portal/payment UX without becoming Loxep's canonical operational model.

## Payments, Payouts, and Banking

Owns movement/settlement facts involving payment processors, marketplaces, and financial accounts.

Owns:
- payments;
- payment allocations;
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

The ledger is downstream of operational facts. Journal entries generated from rules should retain references back to their source facts and be reproducible where practical.

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

Owns files and extracted document metadata while allowing documents to attach to objects in other domains.

Examples include receipts, bills, customer POs, contracts, quotes, invoices, packing slips, shipping documents, and tax records.

## Reporting and Analytics

Owns derived read models, aggregates, dashboards, and metrics. It does not become the canonical owner of the underlying operational data.

Timescale continuous aggregates, materialized views, and analytical SQL belong here when they represent derived views rather than source observations.

# Cross-domain rules

1. A domain may reference another domain's stable ID but should not mutate another domain's canonical tables directly from presentation code.
2. Cross-domain workflows run through domain services and/or durable events/jobs.
3. Raw provider data is retained at the integration/source boundary; normalized business facts are stored by the owning domain.
4. Derived state should identify the source facts from which it was computed.
5. Avoid shared tables that contain unrelated optional columns from many domains merely to reduce table count.
6. Do not create generic abstractions until at least two concrete providers/workflows demonstrate that the abstraction is real.
7. Financial and tax interpretations must not overwrite operational history.
