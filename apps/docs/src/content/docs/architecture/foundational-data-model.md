---
title: Foundational Data Model
---

This document defines the conceptual data model Loxep should implement first. Exact first-migration columns, indexes, and constraints live in the [Foundation Schema Draft](../foundation-schema/).

The foundation is intentionally smaller than the master domain map. It establishes identities, economic-entity attribution, database-backed configuration, encrypted secrets, external connections, provenance/replay, durable monitoring, time-series observations, media/storage, external-resource links, notifications, and auditability without prematurely creating broad commerce/accounting/project tables.

## Design goals

The foundation must support:

- multiple application users without SaaS-style tenancy;
- simple installation-wide `admin`/`member` access initially;
- multiple economic entities/operating identities within one installation;
- multiple accounts for the same external provider;
- provider/runtime credentials that can be refreshed or rotated independently of business records;
- normal application/provider configuration managed in-app rather than Compose;
- polling, webhooks, imports, and retries without duplicate side effects;
- provider-native source data for audit/debug/replay where useful;
- one canonical marketplace item even when discovered through many monitors;
- high-volume time-series observations through TimescaleDB;
- local media storage that can migrate cleanly to generic S3-compatible storage;
- generic links to companion-service resources without provider-specific columns throughout the schema;
- explicit separation between observed marketplace facts and Loxep-owned operational data;
- future accounting books that are not forced into a one-book-per-economic-entity model.

## Conventions

### Identifiers

Loxep-owned durable entities use UUID primary keys unless a specific external/library-owned schema dictates otherwise. External/provider identifiers are stored separately and are never used as Loxep primary keys.

Provider identifiers are generally strings even when a provider currently exposes numeric-looking IDs.

### Timestamps

Persist instants as PostgreSQL `timestamptz` and use semantic names such as `observed_at`, `occurred_at`, `received_at`, `created_at`, `updated_at`, `last_success_at`, and `next_poll_at`.

### Money

Do not store money in floating point. The initial convention is exact PostgreSQL numeric values plus ISO currency code, currently `numeric(20,6)` for operational amounts.

Application arithmetic uses an exact-decimal representation rather than JavaScript `number`.

### Raw payloads

Provider payloads are retained as `jsonb` only at explicit provenance boundaries. Normalized domain tables must not become loosely typed JSON stores merely because upstream providers are flexible.

### State values

Use text columns with application-owned TypeScript constants/unions. Add database `CHECK` constraints for stable closed sets where useful. Avoid PostgreSQL enum types for extensible application/provider states initially.

## Identity, authentication, and authorization

Better Auth owns application authentication identity, sessions, login-provider state, and deployment-level roles `admin` and `member`.

Loxep does **not** duplicate Better Auth's user/session/account tables or create a parallel global `user_roles` table. Per ADR-0020, Better Auth's CLI generates those tables as checked-in Drizzle schema flowing through the normal reviewed migration workflow, and user-reference columns elsewhere are nullable `ON DELETE SET NULL` foreign keys or intentional non-FK historical references — never cascade-deleting history with an auth user.

A small optional `user_profiles` relation may hold Loxep-specific presentation/profile data such as locale/time zone keyed by the Better Auth user ID.

The initial access model is deliberately installation-wide:

- `member` can access normal product data throughout the installation;
- `admin` adds installation/security/administrative authority where elevation is actually required;
- Phase 0 does not implement per-connection, per-workspace, or per-economic-entity ACLs.

Fine-grained resource permissions remain a later extension if concrete shared-install workflows require them. `created_by_user_id` is provenance/audit metadata, not private ownership.

Application user identity, provider connection identity, workspace identity, and economic-entity identity remain separate concepts.

## Economic entities and accounting books

An installation may represent activity for multiple people, businesses, or operating identities. `economic_entities` is the foundation concept for that attribution.

Examples include:

```text
individual / personal activity
sole proprietorship
LLC
partnership
corporation
assumed name / DBA
operating unit
```

The term is intentionally broader than legal entity. A parent relationship can express that an assumed name or operating identity belongs beneath another entity without treating it as a separate legal person.

Economic entities are not users, tenants, workspaces, provider accounts, or counterparties.

They are also **not accounting books**. When accounting arrives, books will own chart-of-accounts, fiscal-period, posting, journal, and financial-statement concerns. More than one economic entity/operating identity may share the same book, with separation handled by accounts, dimensions, classes, departments, or another accounting classification model.

Therefore Phase 0 creates `economic_entities` but does not create `accounting_books` and does not add a required book ID to each entity. See ADR-0017.

## Bootstrap configuration versus database configuration

Some values must remain outside PostgreSQL because the application needs them before it can read database-backed settings or authenticate the first administrator. Examples include database connectivity, Better Auth secret, the external encryption key/keyring, runtime mode, and enough OIDC/SMTP configuration to provide at least one initial login path.

Most normal settings belong in PostgreSQL and are managed through authenticated Loxep administration.

### `application_settings`

Represents genuinely application-level non-secret runtime configuration with typed validation and schema versioning.

It is not a generic replacement for proper domain models. Monitor configuration belongs with monitors; connection config with connections; user dashboard preferences with a preference model once that shape exists.

### `application_secrets`

Stores application-encrypted runtime secrets that are not naturally credentials of one provider connection, for example an S3 credential bundle or a global notification-service token.

Per ADR-0019, a stable logical secret record carries an explicit `current_version` pointer while immutable version rows hold the ciphertext; consumers reference the logical record. Plaintext payloads are typed validated bundles, and AES-256-GCM AAD binds ciphertext to its record/version/key context.

The external root encryption key/keyring never lives in PostgreSQL.

See [Configuration & Secrets](../configuration-and-secrets/).

## External connections

A connection represents one configured relationship to an external account/store/service where account identity and synchronization state matter: eBay account, WooCommerce store, Medusa store, bank/provider account, shipping/payment integration, and similar provider relationships.

`connections` owns common identity/status fields and non-secret provider configuration. Provider-specific data remains provider-specific where normalization would be fake.

A connection may carry nullable `economic_entity_id` when the account clearly represents one entity. The relationship is attribution/context, not authorization. Shared/infrastructural connections may remain unassigned.

`@loxep/domain` implements this as the economic-entities and connections services: kinds and statuses are validated against the application-owned text unions, every mutation is audited, and entity attribution is enforced as context-only per ADR-0017.

Not every external endpoint needs to become a `connection`. For example, a simple ntfy notification endpoint can remain a notification-owned configuration record with an application secret rather than pretending it has provider-account lifecycle semantics.

## Connection credentials and secrets

`connection_credentials` stores application-encrypted credential material associated with provider connections using the accepted AES-256-GCM design with versioned externally supplied keys and ADR-0019's logical-record-plus-versions structure.

Requirements:

- plaintext credentials are only exposed through a credential/secret service;
- tokens/secrets never appear in ordinary APIs, logs, job payloads, source events, or audit snapshots;
- rotation is version-aware with an explicit current-version pointer, and multi-part credentials rotate as one typed bundle;
- credential revocation/deletion does not delete imported historical data.

Connection credentials and application secrets may share encryption primitives/services while retaining separate schema semantics.

## Provider ingestion and provenance

### `source_events`

The durable ingestion envelope records what an external provider delivered or what an import/synchronization operation observed when replay/provenance matters.

Core concepts include:

- connection/provider identity;
- event/object type and external IDs;
- occurred/received timestamps;
- raw payload;
- payload hash;
- processing state/attempts/errors.

Provider-stable event IDs should drive uniqueness where available. Payload hash alone is not a universal semantic identity.

### `provider_objects`

Retains provider-native snapshots when useful independently of an event envelope.

Do not write heavyweight provider JSON on every high-frequency poll when narrow normalized observation rows already preserve useful state. Identical snapshots may be deduplicated by hash; retention is provider/object-class specific.

## Monitoring model

A monitor is **user/configuration intent** to observe something. A marketplace item is **the external object being observed**. An observation is **what Loxep knew at a moment in time**.

### `monitor_targets`

Controls watchlist/item/search/seller monitoring and data-driven scheduling. `next_poll_at` is authoritative for due-work discovery; Graphile Worker dispatches due monitors rather than creating thousands of permanent cron definitions.

Initial target types:

```text
ebay_watchlist
ebay_item
```

Search and seller monitor types follow without changing the scheduling model.

### Adaptive cadence

`interval_seconds` is the **operator-set base cadence** and is never rewritten by the scheduler. Within that base, polling adapts to observed activity: when a poll outcome is recorded, a pure policy turns cheap signals — recent `market_events` for the target's items, observation `raw_state_hash` deltas, consecutive unchanged polls, and time to the soonest future `listing_ends_at` — into the interval used to advance `next_poll_at`. Claim semantics are untouched: adaptivity is computed at record time, and the claim's own flat advance remains the at-least-once safety net.

Tiers multiply the base interval. The most aggressive tightening tier wins, and relaxation applies only when the recent window is completely quiet:

```text
auction_endgame           end < 5 min            base / 8
auction_near_end          end < 30 min           base / 4
auction_approaching_end   end < 6 h              base / 2
activity_hot              >= 8 events + deltas   base / 4
activity_warm             >= 3 events + deltas   base / 2
steady                    otherwise              base
idle_relaxed              6 unchanged polls      base * 2
idle_long                 12 unchanged polls     base * 4
idle_very_long            24 unchanged polls     base * 8
```

Two safety rules bound the result. Consecutive computations may not move the interval by more than 4× in either direction, so cadence walks between tiers instead of thrashing. The result is then clamped into `[min, max]` bounds supplied by the caller, where `min` carries the per-connection **rate budget** floor — the floor outranks every other rule, including a ceiling set below it.

Adaptivity needs no schema change. Transient state lives in the existing `config` jsonb under the namespaced `adaptive` key (`unchangedStreak`, `lastComputedInterval`, `lastTier`, `updatedAt`), alongside an opt-out `enabled` flag that defaults to on and will later be superseded by a registered application setting. A target with `config.adaptive.enabled = false`, or a caller that reports no change information, keeps the flat `interval_seconds` cadence.

### `marketplace_items`

One canonical record per provider/marketplace/external-item identity.

A public eBay listing discovered by two Loxep connections or by a watchlist plus search remains one marketplace item. Connection/account-specific observations remain representable separately.

Marketplace intelligence is largely economic-entity-neutral: the public listing exists independently of which business or personal activity is interested in it. Account/entity context can still be inferred from the monitor's connection where relevant.

### `monitor_items`

Many-to-many relation between monitor targets and marketplace items, preserving where/how an item was discovered without duplicating item history.

## Marketplace observations (TimescaleDB)

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

Observation writes are retry-safe: each provider fetch mints one `observation_batch_id` and fixes `observed_at` at that moment, both retained across processing retries, with hypertable uniqueness on `(observation_batch_id, marketplace_item_id, observed_at)`. See the foundation schema draft.

Initial Timescale policy uses 7-day chunks, recent rowstore data, later columnstore conversion around 30 days, and no automatic retention deletion. These are starting values and current Timescale syntax must be verified before implementation.

## Detected market events

Observations are source facts; `market_events` are derived interpretations of changes between observations.

Initial concepts include:

```text
price_changed
price_dropped
restocked
sold_out
quantity_changed
listing_ended
```

Domain-level deduplication prevents worker retries from producing duplicate user-visible events/notifications.

Derived events are also scored against declarative opportunity rules: a rule is a small closed set of predicates (event type, price/quantity thresholds, listing-state predicates, monitor/item scope) evaluated purely against the event and the two observations it came from, never a general-purpose rule engine. The first (highest-priority) matching rule stamps `market_events.rule_id` — first-wins and never overwritten, so replays are safe — while its score merges into the event payload under a namespaced key and every match is handed back to the caller, which decides whether to bridge it into notification delivery.

## Media, storage backends, and migration

Binary files are not stored as ordinary PostgreSQL blobs.

### `storage_backends`

Represents one configured local or generic-S3 storage destination. Backend records separate stable storage identity/configuration from the driver family.

Initial driver families:

```text
local
s3
```

S3 endpoint/region/bucket/addressing settings may be database-backed; credentials use encrypted application secrets. The local filesystem mount/root remains partly deployment topology.

RustFS is the initial recommended/tested self-hosted S3 companion, but the Loxep contract is generic S3 compatibility.

### `media_objects`

Stores stable Loxep media identity and metadata such as:

- storage backend ID;
- opaque storage key;
- original filename;
- MIME type;
- size;
- SHA-256;
- creator/timestamps;
- non-secret metadata.

### `media_links`

Associates media with domain resources by stable Loxep media ID.

### Storage migration

`storage_migrations` and `storage_migration_objects` persist resumable local-to-S3 or S3-to-S3 migration state.

A migration copies, verifies, then cuts metadata over. Source objects remain intact until an explicit later cleanup action.

## External companion resources

### `external_resources`

Represents an object owned by an external specialist platform—such as an Outline document, Vikunja task/project, AFFiNE page, GitHub issue, or Invoice Ninja record—using provider/connection identity plus external ID/URL/metadata.

### `resource_links`

Associates those external resources with Loxep domain objects.

This is intentionally generic so future integrations do not add `outline_document_id`, `vikunja_task_id`, and similar columns throughout unrelated tables.

## Notifications

Notifications are outputs of detected/domain events, not part of marketplace observation state.

The foundation includes:

- notification endpoints;
- notification rules;
- delivery attempts/status/deduplication.

ntfy is the first adapter. Endpoint credentials may use `application_secrets` when a full provider connection model is unnecessary.

## Audit events

`audit_events` is append-oriented evidence of user/admin configuration changes.

It is separate from:

- `source_events` — what an external provider told Loxep;
- domain events — what Loxep inferred happened in a business domain.

Secrets are redacted before audit serialization.

## Runtime topology does not change the schema

The same schema supports both:

```text
minimal:
  loxep (web + worker capability)
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

## Phase 0/1 minimum physical schema

The first useful eBay-monitor foundation should physically require roughly:

```text
Better Auth tables/config
optional user_profiles
economic_entities
application_settings
application_secrets
connections
connection_credentials
source_events
provider_objects
monitor_targets
marketplace_items
monitor_items
marketplace_item_observations   # Timescale hypertable
market_events
storage_backends
media_objects
media_links
storage_migrations
storage_migration_objects
external_resources
resource_links
notification_endpoints
notification_rules
notification_deliveries
audit_events
Graphile Worker schema
```

There is intentionally no `connection_users` ACL table in Phase 0 and no `accounting_books` table yet.

The exact physical target and constraints remain defined by the [Foundation Schema Draft](../foundation-schema/). Commerce, inventory, project, billing, and accounting tables are deliberately not pre-created merely because future domains are known.