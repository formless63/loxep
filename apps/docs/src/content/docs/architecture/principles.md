---
title: Architectural Principles
---

# Architectural Principles

These principles constrain implementation choices before incidental code becomes architecture.

## 1. Modular monolith first

Loxep begins as a modular application, not a collection of microservices. Domain boundaries should be explicit in code and data ownership, while deployment boundaries are introduced only when they solve an operational problem.

The default installation is **one Loxep application container plus PostgreSQL/TimescaleDB**. The same Loxep image can later run `all`, `web`, or `worker` modes so background work can scale independently without changing the domain model.

## 2. PostgreSQL is the durable center for structured state

Operational relational data, Graphile Worker jobs, accounting data, and time-series data should coexist in PostgreSQL where appropriate. TimescaleDB extends PostgreSQL for observation-heavy workloads rather than introducing a separate analytical datastore at the outset.

PostgreSQL is not the normal blob store for images, PDFs, receipts, or other large media. Binary content goes through Loxep's media-storage abstraction.

Redis is not required solely to provide a queue.

## 3. Storage starts simple and grows without domain rewrites

A small deployment may use local filesystem media with no extra service. Shared/distributed deployments use generic S3-compatible storage.

Domain records reference stable Loxep media IDs rather than local paths, bucket URLs, or storage-provider URLs. Local-to-S3 migration must be a supported, resumable workflow.

RustFS is the initial recommended/tested self-hosted S3 companion, but S3 compatibility—not RustFS—is the application contract.

## 4. Preserve source facts

Provider-native events and important raw objects should be retained sufficiently to explain and, where feasible, replay ingestion. Normalization must not destroy information simply because the current domain model does not expose it.

## 5. Derived state should be rebuildable where practical

Normalized views, analytics, and accounting outputs should be derived from durable source facts/events when feasible. A corrected rule should not require reconstructing history from screenshots or bank statements.

## 6. The ledger is downstream of reality

Orders, payments, shipments, inventory movements, purchases, projects, and other operational facts exist independently of their accounting treatment. Accounting translates economic events into journal entries; it does not replace the operational record.

## 7. Provider boundaries are explicit

External APIs are accessed through adapters. Provider SDK/library response types should not become the application's domain types.

Use maintained libraries such as `ebay-api` to avoid rebuilding OAuth, signing, serialization, pagination, and protocol details where they are reliable, while keeping the option to bypass or replace them endpoint-by-endpoint.

## 8. Normalize only where concepts are genuinely shared

Orders, payments, inventory, customers, and shipments have useful cross-provider concepts. Marketplace search semantics often do not. Avoid premature universal abstractions that merely hide provider-specific behavior behind leaky interfaces.

## 9. External accounts are first-class objects

Application users, eBay accounts, WooCommerce stores, payment processors, and other external connections are distinct identities. A deployment may contain multiple accounts for the same provider and multiple users with different access to them.

This does not imply SaaS-style tenancy.

## 10. Authentication and domain authorization are separate concerns

Better Auth owns application identity, sessions, login methods, and deployment-level roles such as `admin` and `member`.

Loxep owns resource/business permissions such as which users can view or manage a particular external connection. Do not duplicate Better Auth's global role model, and do not force domain permissions into auth-library metadata.

## 11. Idempotency is designed in

Polling, webhooks, retries, imports, and provider inconsistencies make duplicate delivery normal. Source-event identity, external IDs, payload hashes, database constraints, and Graphile Worker job keys should make repeated work safe.

## 12. Background work is durable

Scheduled polling, ingestion, normalization, notification, synchronization, migration, and derived processing run through durable jobs with retries and backoff. Fire-and-forget in-memory events are not used for consequential work.

A worker is a logical runtime capability, not a required separate container. Small deployments run it alongside the web runtime; larger deployments can scale worker processes/hosts independently.

## 13. APIs are product surfaces

The first-party web UI is not the only intended consumer. Loxep should expose a stable, versioned HTTP API as external integration needs arrive, with an OpenAPI contract. Internal UI convenience must not make the domain inaccessible to sidecars or non-TypeScript clients.

## 14. Time is a first-class dimension

For market observations and other genuinely temporal datasets, history is not an audit afterthought. The system should preserve enough resolution to answer questions about change, duration, frequency, and trends. TimescaleDB is available from the initial deployment for these workloads.

## 15. Cost attribution is richer than expense categorization

Costs should be attributable to the operational objects that caused them: orders, shipments, acquisitions, projects, customers, products, channels, and services. This enables actual profitability rather than merely categorized bookkeeping.

## 16. Integrate before rebuilding mature specialist products

Loxep should not delay useful capability by rebuilding mature specialist products merely to minimize containers or dependencies.

Where a good external system exists—knowledge/docs, task management, invoicing, notifications, backups, infrastructure monitoring—prefer a clean integration or recommended companion until owning the capability materially improves Loxep's coherent operational model.

External companion resources should be linkable generically rather than adding provider-specific foreign-key columns throughout the schema.

## 17. Generic self-hosting is a product requirement

No deployment should assume a particular business, domain, reverse proxy, identity provider, object store, or marketplace account. Configuration, migrations, backup/restore, upgrades, multi-account support, and storage migration are product concerns.

## 18. Adopt good scaffolding without surrendering architecture

Loxep may begin from maintained starters where they save meaningful work. Kiranism's TanStack Start dashboard is the initial UI foundation because it already supplies a polished dashboard shell and theme system aligned with our frontend choices.

Starter code is a donor, not an architectural authority. Demo data, auth, backend assumptions, unnecessary state libraries, and stale dependency pins must be removed or replaced.

## 19. Dependency freshness is deliberate

Do not pin old versions because an example, starter, or model training data happens to use them. Verify current viable releases from primary upstream sources immediately before adoption, then pin reproducibly and keep them current with automated update tooling and CI.

## 20. Documentation records why

Important technology and architecture choices should be captured as ADRs. Coding agents and future contributors should be able to distinguish intentional constraints from accidental implementation details.

When a later ADR changes a recommendation, older broad documentation should be updated so the repository has one coherent current story.

## 21. Build vertically, design horizontally

Early releases should deliver complete useful slices—beginning with marketplace monitoring—rather than partially implementing every eventual module. Foundational identities, events, connections, storage, and boundaries should still be designed with the broader domain map visible.
