---
title: Architectural Principles
---

These principles constrain implementation choices before incidental code becomes architecture.

## 1. Modular monolith first

Loxep begins as a modular application, not a collection of microservices. Domain boundaries are explicit in code/data ownership; deployment boundaries are introduced only when they solve an operational problem.

The default installation is **one Loxep application container plus PostgreSQL/TimescaleDB**. The same Loxep image can later run `all`, `web`, or `worker` modes so background work can scale independently without changing the domain model.

## 2. PostgreSQL is the durable center for structured state

Operational relational data, application settings, encrypted runtime-secret records, Graphile Worker jobs, accounting data, and time-series data coexist in PostgreSQL where appropriate. TimescaleDB extends PostgreSQL for observation-heavy workloads rather than introducing a separate analytical datastore at the outset.

PostgreSQL is not the normal blob store for images, PDFs, receipts, or other large media. Binary content goes through Loxep's media-storage abstraction.

Redis is not required solely to provide a queue.

## 3. Storage starts simple and grows without domain rewrites

A small deployment may use local filesystem media with no extra service. Shared/distributed deployments use generic S3-compatible storage.

Domain records reference stable Loxep media IDs rather than local paths, bucket URLs, or storage-provider URLs. Local-to-S3 migration is a supported resumable workflow.

RustFS is the initial recommended/tested self-hosted S3 companion, but S3 compatibility—not RustFS—is the application contract.

## 4. Preserve source facts

Provider-native events and important raw objects are retained sufficiently to explain and, where feasible, replay ingestion. Normalization must not destroy information simply because the current domain model does not expose it.

## 5. Derived state should be rebuildable where practical

Normalized views, analytics, and accounting outputs should be derived from durable source facts/events when feasible. A corrected rule should not require reconstructing history from screenshots or bank statements.

## 6. The ledger is downstream of reality

Orders, payments, shipments, inventory movements, purchases, projects, and other operational facts exist independently of their accounting treatment. Accounting translates economic facts into journal entries; it does not replace the operational record.

## 7. Provider boundaries are explicit

External APIs are accessed through adapters. Provider SDK/library response types do not become the application's domain types.

Use maintained libraries such as `ebay-api` to avoid rebuilding OAuth, signing, serialization, pagination, and protocol details where they are reliable, while keeping the option to bypass or replace them endpoint-by-endpoint.

## 8. Normalize only where concepts are genuinely shared

Orders, payments, inventory, customers, and shipments have useful cross-provider concepts. Marketplace search semantics often do not. Avoid premature universal abstractions that merely hide provider-specific behavior behind leaky interfaces.

## 9. External accounts are first-class objects

Application users, eBay accounts, WooCommerce stores, payment processors, and other external connections are distinct identities. A deployment may contain multiple accounts for the same provider and multiple application users.

This does not imply SaaS-style tenancy, and a provider connection is not automatically the economic owner of its transactions.

## 10. Initial access is installation-wide

Better Auth owns application identity, sessions, login methods, and deployment-level roles `admin` and `member`.

For the initial product, trusted members have ordinary product access across the installation. `admin` adds installation/security/administrative capabilities where elevation is actually needed.

Do not introduce per-connection, per-workspace, or per-economic-entity ACLs until a concrete workflow justifies the added complexity. In particular, do not create a speculative `connection_users` permission model in Phase 0.

## 11. Economic entities are not tenants or accounting books

One installation may represent personal activity and several businesses/operating identities. Model those explicitly as economic entities rather than inferring ownership from users, workspaces, or provider accounts.

An economic entity may also represent an assumed name/DBA or operating identity beneath another entity; the concept is broader than a legal-person table.

Economic entities classify operational attribution, not permissions.

Accounting books remain a separate later concept. More than one economic entity/operating identity may share one book and chart of accounts, with separation implemented through accounts or accounting dimensions. Do not hardcode one entity = one ledger.

## 12. Normal administration belongs in the application

Environment variables and mounted secrets are bootstrap/deployment inputs, not the primary settings UI.

If a value can be safely loaded after PostgreSQL is available and is normally created/changed during operation, prefer a typed database-backed setting or encrypted runtime secret managed through Loxep.

Provider credentials such as eBay keys/tokens should not require editing Compose. The external root encryption key/keyring, database connectivity, Better Auth secret, and enough pre-login OIDC/SMTP configuration remain bootstrap concerns.

See [Configuration & Secrets](../configuration-and-secrets/).

## 13. Idempotency is designed in

Polling, webhooks, retries, imports, and provider inconsistencies make duplicate delivery normal. Source-event identity, external IDs, payload hashes, database constraints, and Graphile Worker job keys should make repeated work safe.

## 14. Background work is durable

Scheduled polling, ingestion, normalization, notification, synchronization, migration, and derived processing run through durable jobs with retries/backoff. Fire-and-forget in-memory events are not used for consequential work.

A worker is a logical runtime capability, not a required separate container. Small deployments run it alongside the web runtime; larger deployments can scale worker processes/hosts independently.

## 15. APIs are product surfaces

The first-party web UI is not the only intended consumer. Loxep should expose a stable, versioned HTTP API as external integration needs arrive, with an OpenAPI contract. Internal UI convenience must not make the domain inaccessible to sidecars or non-TypeScript clients.

## 16. Time is a first-class dimension

For market observations and other genuinely temporal datasets, history is not an audit afterthought. Preserve enough resolution to answer questions about change, duration, frequency, and trends. TimescaleDB is available from the initial deployment for these workloads.

## 17. Cost attribution is richer than expense categorization

Costs should be attributable to the operational objects that caused them: orders, shipments, acquisitions, projects, customers, products, channels, services, and economic entities where appropriate. This enables actual profitability rather than merely categorized bookkeeping.

## 18. Integrate before rebuilding mature specialist products

Loxep should not delay useful capability by rebuilding mature specialist products merely to minimize containers or dependencies.

Where a good external system exists—knowledge/docs, task management, invoicing, notifications, backups, infrastructure monitoring—prefer a clean integration or recommended companion until owning the capability materially improves Loxep's coherent operational model.

External companion resources should be linkable generically rather than adding provider-specific foreign-key columns throughout the schema.

## 19. Generic self-hosting is a product requirement

No deployment assumes a particular business, domain, reverse proxy, identity provider, object store, or marketplace account. Configuration, migrations, backup/restore, upgrades, multi-account support, first-admin recovery, and storage migration are product concerns.

## 20. Workspaces organize UX, not ownership

Major application areas are peer workspace routes rather than everything living below `/dashboard`.

A workspace switcher and workspace-specific navigation keep the UI manageable, but workspace boundaries do not define database schemas, backend modules, provider accounts, tenants, economic entities, or accounting books.

## 21. Adopt good scaffolding without surrendering architecture

Kiranism's TanStack Start dashboard is the initial UI donor because it supplies a polished dashboard shell/theme/component vocabulary aligned with Loxep's frontend choices.

The donor is now isolated under `/starter/*` for reference while Loxep owns real product workspaces. Demo data/auth/backend assumptions remain non-authoritative.

Do not remove useful donor capability merely to minimize dependency count. Recharts, DnD, and Zustand have credible Loxep uses. Their state/behavior ownership must still follow Loxep architecture.

## 22. State has an owner

Use the natural state owner before adding another one:

```text
PostgreSQL        durable state and durable user preferences
TanStack Query    server/cache state
Router            URL/navigation state
TanStack Form     form state
React             local component state
Zustand           cross-component ephemeral/editing UI state when useful
```

A configurable dashboard can use Zustand for immediate dragging/editing while PostgreSQL persists the user's durable layout. Do not mirror server data into Zustand merely for convenience.

## 23. Dependency freshness is deliberate

Do not pin old versions because an example, starter, or model training data happens to use them. Verify current viable releases from primary upstream sources immediately before adoption, then pin reproducibly and keep them current with automated update tooling and CI.

## 24. Documentation records why

Important technology/architecture choices belong in ADRs and current architecture docs. Coding agents and contributors should distinguish intentional constraints from accidental implementation details.

When a later ADR changes a recommendation, update broad documentation so the repository maintains one coherent current story.

## 25. Build vertically, design horizontally

Early releases should deliver complete useful slices—beginning with marketplace monitoring—rather than partially implementing every eventual module. Foundational identities, economic entities, settings/secrets, events, connections, storage, and boundaries should still be designed with the broader domain map visible.