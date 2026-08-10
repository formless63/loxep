---
title: Foundational Data Model
---

# Foundational Data Model

This document defines the conceptual data model Loxep should implement first. Exact first-migration columns, indexes, and constraints live in the [Foundation Schema Draft](./foundation-schema/).

The foundation is intentionally smaller than the master domain map. It establishes identities, external connections, provenance/replay, durable monitoring, time-series observations, media storage, external-resource links, and auditability without prematurely creating commerce/accounting/project tables.

## Design goals

The foundation must support:

- multiple application users without SaaS-style tenancy;
- multiple accounts for the same external provider;
- sharing an external connection with more than one Loxep user;
- provider credentials that can be refreshed or rotated independently of business records;
- polling, webhooks, imports, and retries without duplicate side effects;
- retention of provider-native source data for audit/debug/replay;
- one canonical marketplace item even when discovered through many monitors;
- high-volume time-series observations through TimescaleDB;
- local media storage that can migrate cleanly to generic S3-compatible storage;
- generic links to companion-service resources without provider-specific columns throughout the schema;
- explicit separation between observed marketplace facts and Loxep-owned operational data.

# Conventions

## Identifiers

Loxep-owned durable entities use UUID primary keys. External/provider identifiers are stored separately and are never used as Loxep primary keys.

Provider identifiers are generally strings even when a provider currently exposes numeric-looking IDs.

## Timestamps

Persist instants as PostgreSQL `timestamptz` and use semantic names such as `observed_at`, `occurred_at`, `received_at`, `created_at`, `updated_at`, `last_success_at`, and `next_poll_at`.

## Money

Do not store money in floating point. The initial convention is exact PostgreSQL numeric values plus ISO currency code, currently `numeric(20,6)` for operational amounts.

Application arithmetic must use an exact-decimal representation rather than JavaScript `number`.

## Raw payloads

Provider payloads are retained as `jsonb` only at explicit provenance boundaries. Normalized domain tables should not become loosely typed JSON stores simply because upstream providers are flexible.

## State values

Use text columns with application-owned TypeScript constants/unions. Add database `CHECK` constraints for stable closed sets where useful. Avoid PostgreSQL enum types for extensible application/provider states initially.

# Identity, authentication, and authorization

Better Auth owns application authentication identity, sessions, login-provider state, and deployment-level roles such as `admin` and `member`.

Loxep does **not** duplicate Better Auth's user/session/account tables or create a parallel global `user_roles` table.

A small optional `user_profiles` relation may hold Loxep-specific presentation/profile data such as locale and time zone keyed by the Better Auth user ID.

Loxep owns **resource/business authorization**. For example, `connection_users` associates users with a particular external connection using roles such as:

```text
owner
manage
view
```

An application user and an external eBay/WooCommerce/etc. account are separate identities.

# External connections

A connection represents one configured relationship to an external system: eBay account, WooCommerce store, Medusa store, Invoice Ninja instance, ntfy endpoint, knowledge/task platform, bank feed, shipping provider, and similar integrations.

`connections` owns common identity/status fields and non-secret provider configuration. Provider-specific data remains provider-specific where normalization would be fake.

`connection_users` provides per-user resource access.

# Credentials and secrets

Credentials have a separate lifecycle from connection records.

`connection_credentials` stores application-encrypted credential material using the resolved AES-256-GCM design with versioned externally supplied keys.

Requirements:

- plaintext credentials are only exposed through a credential service;
- tokens/secrets never appear in ordinary APIs, logs, or audit snapshots;
- rotation is version-aware;
- credential revocation/deletion does not delete imported historical data.

# Provider ingestion and provenance

## `source_events`

The durable ingestion envelope records what an external provider delivered or what an import/synchronization operation observed when replay/provenance matters.

Core concepts include:

- connection/provider identity;
- event/object type and external IDs;
- occurred/received timestamps;
- raw payload;
- payload hash;
- processing state/attempts/errors.

Provider-stable event IDs should drive uniqueness where available. Payload hash alone is not a universal semantic identity.

## `provider_objects`

Retains provider-native snapshots when useful independently of an event envelope.

Do not write heavyweight provider JSON on every high-frequency poll when narrow normalized observation rows already preserve the useful state. Identical snapshots may be deduplicated by hash; retention is provider/object-class specific.

# Monitoring model

A monitor is **user/configuration intent** to observe something. A marketplace item is **the external object being observed**. An observation is **what Loxep knew at a moment in time**.

## `monitor_targets`

Controls watchlist/item/search/seller monitoring and data-driven scheduling. `next_poll_at` is authoritative for due-work discovery; Graphile Worker dispatches due monitors rather than creating thousands of permanent cron definitions.

Initial target types:

```text
ebay_watchlist
ebay_item
```

Search and seller monitor types follow without changing the scheduling model.

## `marketplace_items`

One canonical record per provider/marketplace/external-item identity.

A public eBay listing discovered by two Loxep connections or by a watchlist plus search remains one marketplace item. Connection/account-specific observations remain representable separately.

## `monitor_items`

Many-to-many relation between monitor targets and marketplace items, preserving where/how an item was discovered without duplicating item history.

# Marketplace observations (TimescaleDB)

`marketplace_item_observations` is a Timescale hypertable partitioned on `observed_at`.

It stores narrow typed observational facts such as:

- price and shipping price;
- currency;
- availability/listing state;
- observable quantities;
- listing end time;
- seller metrics when useful;
- source/connection provenance;
- state hash.

Successful polls are recorded even when values are unchanged because repeated equal observations establish useful bounds for restock, sellout, and transition timing.

Missing/unobservable data remains `NULL`; absence is not normalized to zero.

Initial Timescale policy uses a 7-day chunk interval, recent rowstore data, later Hypercore/columnstore conversion around 30 days, and no automatic retention deletion. These are starting values and current Timescale syntax must be verified before implementation.

# Detected market events

Observations are source facts; `market_events` are derived interpretations of changes between observations.

Initial event concepts include:

```text
price_changed
price_dropped
restocked
sold_out
quantity_changed
listing_ended
```

Domain-level deduplication prevents worker retries from producing duplicate user-visible events/notifications.

# Media and object storage

Binary files are not stored as ordinary PostgreSQL blobs.

## `media_objects`

Stores stable Loxep identity and metadata such as:

- backend identity;
- opaque storage key;
- original filename;
- MIME type;
- size;
- SHA-256;
- creator/timestamps;
- non-secret metadata.

## `media_links`

Associates media with arbitrary domain resources by stable Loxep media ID.

Initial storage drivers:

```text
local
s3
```

Local storage is the zero-extra-service default. RustFS is the initial recommended/tested self-hosted S3 companion, but the application contract is generic S3 compatibility.

## Storage migration

`storage_migrations` and `storage_migration_objects` persist resumable local-to-S3 or S3-to-S3 migration state.

A migration copies, verifies, then cuts metadata over. Source objects remain intact until an explicit later cleanup action.

# External companion resources

## `external_resources`

Represents an object owned by an external specialist platform—such as an Outline document, Vikunja task/project, AFFiNE page, GitHub issue, or Invoice Ninja record—using provider/connection identity plus external ID/URL/metadata.

## `resource_links`

Associates those external resources with Loxep domain objects.

This is intentionally generic so future integrations do not add `outline_document_id`, `vikunja_task_id`, and similar columns throughout unrelated tables.

# Notifications

Notifications are outputs of detected/domain events, not part of marketplace observation state.

The foundation includes concepts for:

- notification endpoints;
- rules;
- delivery attempts/status/deduplication.

ntfy is the first adapter.

# Audit events

`audit_events` is append-oriented evidence of user/admin configuration changes.

It is separate from:

- `source_events` — what an external provider told Loxep;
- domain events — what Loxep inferred happened in a business domain.

Secrets must be redacted before audit serialization.

# Runtime topology does not change the schema

The same schema supports both:

```text
minimal:
  loxep (web + worker)
  postgres-timescale
  local media
```

and later:

```text
scaled:
  loxep-web-*
  loxep-worker-*
  shared postgres-timescale
  shared S3-compatible storage
```

Local filesystem media is valid for single-node operation. Multi-host deployments should migrate to S3/shared storage or receive a prominent topology warning.

# Phase 1 minimum physical schema

The first useful eBay monitor should physically require roughly:

```text
Better Auth tables/config
optional user_profiles
connections
connection_users
connection_credentials
source_events
provider_objects where useful
monitor_targets
marketplace_items
monitor_items
marketplace_item_observations
market_events
notification_endpoints
notification_rules
notification_deliveries
media_objects
media_links
storage migration state
external_resources
resource_links
audit_events
Graphile Worker schema
```

It should **not** create placeholder tables for orders, inventory, customers, projects, invoices, journal entries, or tax filings merely because those domains exist on the long-term map.

# Resolved implementation choices

The previously open foundational choices are now captured in [Foundational Implementation Decisions](./foundational-decisions/) and ADRs. Implementers should not reopen them casually:

- AES-256-GCM application-level credential encryption;
- Better Auth-owned authentication/global roles and Loxep-owned resource authorization;
- exact-decimal PostgreSQL money;
- Timescale observation policy;
- nullable connection provenance on observations;
- conservative source/provider-object retention;
- text/check-constraint state strategy;
- append-oriented audit events;
- local/S3 media abstraction and migration;
- default combined Loxep runtime with optional split workers;
- Kiranism-derived dashboard foundation;
- generic companion-resource links.

Before writing actual migrations, verify all current library/database APIs and versions under the project's dependency/version policy.
