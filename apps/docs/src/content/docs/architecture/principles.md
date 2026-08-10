---
title: Architectural Principles
---

# Architectural Principles

These are intended to constrain implementation decisions before individual technologies or modules accumulate enough inertia to define the architecture accidentally.

## 1. Modular monolith first

Loxep begins as a modular application, not a collection of microservices. Domain boundaries should be explicit in code and data ownership, but deployment boundaries are introduced only when they solve a measured problem.

The initial runtime shape is expected to be a web/application process, a worker process, and PostgreSQL/TimescaleDB.

## 2. PostgreSQL is the durable center

Operational relational data, Graphile Worker jobs, accounting data, and time-series data should coexist in PostgreSQL where appropriate. TimescaleDB extends PostgreSQL for observation-heavy workloads rather than introducing a separate analytical datastore at the outset.

Redis is not required solely to provide a queue.

## 3. Preserve source facts

Provider-native events and important raw objects should be retained sufficiently to explain and, where feasible, replay ingestion. Normalization must not destroy information simply because the current domain model does not expose it.

## 4. Derived state should be rebuildable where practical

Normalized views, analytics, and accounting outputs should be derived from durable source facts/events when feasible. A corrected rule should not require reconstructing history from screenshots or bank statements.

## 5. The ledger is downstream of reality

Orders, payments, shipments, inventory movements, purchases, projects, and other operational facts exist independently of their accounting treatment. Accounting translates economic events into journal entries; it does not replace the operational record.

## 6. Provider boundaries are explicit

External APIs are accessed through adapters. Provider SDK/library response types should not become the application's domain types.

Use maintained libraries such as `ebay-api` to avoid rebuilding OAuth, signing, serialization, pagination, and protocol details where they are reliable, while keeping the option to bypass or replace them endpoint-by-endpoint.

## 7. Normalize only where concepts are genuinely shared

Orders, payments, inventory, customers, and shipments have useful cross-provider concepts. Marketplace search semantics often do not. Loxep should avoid premature universal abstractions that merely hide provider-specific behavior behind leaky interfaces.

## 8. External accounts are first-class objects

Application users, eBay accounts, WooCommerce stores, payment processors, and other external connections are distinct identities. A deployment may contain multiple accounts for the same provider and multiple users with different access to them.

This does not imply SaaS-style tenancy.

## 9. Idempotency is designed in

Polling, webhooks, retries, imports, and provider inconsistencies make duplicate delivery normal. Source-event identity, external IDs, payload hashes, database constraints, and Graphile Worker job keys should make repeated work safe.

## 10. Background work is durable

Scheduled polling, ingestion, normalization, notification, synchronization, and derived processing run through durable jobs with retries and backoff. Fire-and-forget in-memory events are not used for consequential work.

## 11. APIs are product surfaces

The first-party web UI is not the only intended consumer. Loxep should expose a stable, versioned HTTP API as external integration needs arrive, with an OpenAPI contract. Internal UI convenience must not make the domain inaccessible to sidecars or non-TypeScript clients.

## 12. Time is a first-class dimension

For market observations and other genuinely temporal datasets, history is not an audit afterthought. The system should preserve enough resolution to answer questions about change, duration, frequency, and trends. TimescaleDB is available from the initial deployment for these workloads.

## 13. Cost attribution is richer than expense categorization

Costs should be attributable to the operational objects that caused them: orders, shipments, acquisitions, projects, customers, products, channels, and services. This enables actual profitability rather than merely categorized bookkeeping.

## 14. Integrate before rebuilding mature specialist products

Loxep should not rebuild payment processing, tax calculation, shipping-carrier infrastructure, or mature invoicing/customer-portal capabilities simply to avoid dependencies. Own a capability when doing so materially improves the coherent operational model or user experience.

## 15. Generic self-hosting is a product requirement

No deployment should assume a particular business, domain, reverse proxy, identity provider, or eBay account. Configuration, migrations, backup/restore, upgrades, and multi-account support are part of the product.

## 16. Documentation records why

Important technology and architecture choices should be captured as ADRs. Coding agents and future contributors should be able to distinguish intentional constraints from accidental implementation details.

## 17. Build vertically, design horizontally

Early releases should deliver complete useful slices—beginning with marketplace monitoring—rather than partially implementing every eventual module. However, foundational identities, events, connections, and boundaries should be designed with the broader domain map visible.
