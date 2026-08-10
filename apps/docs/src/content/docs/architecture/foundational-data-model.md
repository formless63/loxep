---
title: Foundational Data Model
---

# Foundational Data Model

This document defines the first durable data model Loxep should implement. It is intentionally smaller than the master domain map. The goal is to establish identities, external connections, provenance/replay, durable monitoring, and time-series observations without prematurely creating tables for future commerce, accounting, billing, or service modules.

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
- explicit separation between observed marketplace facts and Loxep-owned operational data;
- future extension to WooCommerce, Medusa, shipping, banking, billing, and other providers without an eBay-shaped core schema.

# Conventions

## Identifiers

Loxep-owned durable entities use UUID primary keys. External/provider identifiers are stored separately and are never used as Loxep primary keys.

Provider identifiers are generally strings even when a provider currently exposes numeric-looking IDs. This avoids accidental integer assumptions and permits provider format changes.

## Timestamps

All persisted instants use timezone-aware PostgreSQL `timestamptz` values and are normalized to UTC by the database/client boundary.

Use semantic timestamps rather than a generic timestamp when meaning matters, for example:

- `observed_at`
- `occurred_at`
- `received_at`
- `created_at`
- `updated_at`
- `last_success_at`
- `next_poll_at`

## Money

Do not store money in floating-point columns.

Initial provider observations should store:

- amount as a fixed-precision numeric value;
- ISO currency code separately.

A later money-domain ADR may standardize minor-unit integer representation where appropriate. Provider-native precision must not be discarded during ingestion.

## Raw payloads

Provider payloads are retained as `jsonb` only at explicit provenance boundaries. Application/domain tables should not become loosely typed JSON stores merely because the upstream provider is flexible.

## Soft deletion

Do not add `deleted_at` to every table by default. Use explicit lifecycle states where historical records remain meaningful. Hard deletion is acceptable for ephemeral/configuration records where no audit requirement exists.

# Identity and authorization

Authentication is provided by Better Auth. Its implementation-owned tables should remain logically separate from Loxep domain authorization.

Loxep should not duplicate Better Auth's user/session/account tables solely to mirror them.

## `user_profiles`

Application-specific attributes associated one-to-one with the authenticated user identifier.

Suggested fields:

```text
user_id              text primary key   # Better Auth user identifier
display_name         text nullable
locale               text nullable
time_zone            text nullable
created_at            timestamptz
updated_at            timestamptz
```

The Better Auth user ID is intentionally referenced here rather than hidden behind a second Loxep user UUID.

## Global roles

Loxep initially needs a small deployment-level authorization model rather than generalized RBAC.

Suggested roles:

```text
admin
member
```

An administrator can manage deployment-level configuration and user access. Fine-grained resource access belongs on the resource relationship itself.

The role can live in a small `user_roles` table or Better Auth-supported metadata if that remains clean and queryable. The schema decision should be made during auth implementation, but domain tables must not assume every authenticated user can access every connection.

# External connections

A connection represents one authenticated/configured relationship to an external system. Examples include an eBay account, WooCommerce store, Medusa store, Invoice Ninja instance, bank feed, or shipping provider.

## `connections`

```text
id                    uuid primary key
provider              text
kind                  text
name                  text
status                text
external_account_id   text nullable
external_account_name text nullable
config                 jsonb
created_by_user_id    text
created_at             timestamptz
updated_at             timestamptz
last_success_at        timestamptz nullable
last_error_at          timestamptz nullable
last_error_code        text nullable
```

### Provider

Examples:

```text
ebay
woocommerce
medusa
invoice_ninja
ntfy
```

Provider values should be application-defined identifiers, not arbitrary user input.

### Kind

`kind` distinguishes connection capabilities where a provider may expose materially different surfaces. Examples might later include `marketplace`, `commerce_store`, `billing`, `banking`, or `notification`.

Do not make application behavior depend on `kind` where provider capability discovery is more precise.

### Config

`config` contains non-secret provider-specific configuration such as marketplace/country selection, store URL, polling preferences, or installation metadata.

Secrets do not belong in this column.

## `connection_users`

Many-to-many authorization between application users and external connections.

```text
connection_id         uuid
user_id               text
role                  text
created_at             timestamptz
```

Initial connection roles:

```text
owner
manage
view
```

Primary/unique key:

```text
(connection_id, user_id)
```

A deployment with one person still uses this model so multi-user support does not require a later identity migration.

# Credentials and secrets

Credentials require a separate lifecycle from the connection record.

## `connection_credentials`

This table stores references/encrypted credential material as determined by the deployment secret-storage implementation.

Suggested logical fields:

```text
id                    uuid primary key
connection_id         uuid
credential_type       text
secret_payload        encrypted/opaque
expires_at             timestamptz nullable
refresh_after          timestamptz nullable
version                integer
created_at             timestamptz
updated_at             timestamptz
```

Requirements:

- credentials are never returned through ordinary connection APIs;
- refresh tokens/access tokens are not written to logs;
- rotation creates an auditable version boundary where practical;
- provider code requests credentials through a credential service rather than directly querying arbitrary secret columns;
- credential deletion/revocation does not delete the historical connection or its imported data.

The exact encryption mechanism is deferred to an implementation ADR because self-hosted deployments need a usable key-management story.

# Provider ingestion and provenance

Two concepts are required: an immutable-ish record of something received/observed from a provider, and optional retained provider objects representing the latest or fetched native object.

## `source_events`

The durable ingestion envelope.

```text
id                    uuid primary key
connection_id         uuid nullable
provider              text
event_type            text
external_event_id     text nullable
external_object_type  text nullable
external_object_id    text nullable
occurred_at             timestamptz nullable
received_at             timestamptz
payload                jsonb
payload_hash           text
processing_status      text
processing_attempts    integer
processed_at            timestamptz nullable
last_error             text nullable
```

Typical sources:

- provider webhook;
- polling response transformed into an explicit source event when the response itself is consequential;
- manual/imported source record;
- synchronization result.

### Idempotency

Where the provider supplies a stable event ID, enforce uniqueness scoped by provider/connection.

Where no provider event ID exists, use appropriate combinations of object identity, semantic event type, timestamps, and payload hash. Do not assume payload hash alone defines semantic uniqueness.

Potential unique index when `external_event_id` is present:

```text
(connection_id, provider, external_event_id)
```

## `provider_objects`

Retains provider-native object snapshots when useful independently of an event envelope.

```text
id                    uuid primary key
connection_id         uuid nullable
provider              text
object_type           text
external_object_id    text
fetched_at             timestamptz
provider_updated_at    timestamptz nullable
payload                jsonb
payload_hash           text
```

This table is not a substitute for normalized domain tables.

Whether every fetch creates a provider-object row should be decided per provider/object type. High-frequency market observations should use their dedicated Timescale model rather than writing giant repeated provider JSON payloads every minute.

# Monitoring model

A monitor is a user/configuration intent to observe something. A marketplace item is the external object being observed. The same item can be associated with many monitors.

## `monitor_targets`

```text
id                    uuid primary key
connection_id         uuid nullable
target_type           text
name                  text
enabled                boolean
interval_seconds      integer
priority              integer
next_poll_at           timestamptz nullable
last_poll_at           timestamptz nullable
last_success_at        timestamptz nullable
backoff_until          timestamptz nullable
consecutive_errors    integer
config                 jsonb
created_by_user_id    text
created_at             timestamptz
updated_at             timestamptz
```

Initial `target_type` values:

```text
ebay_watchlist
ebay_item
ebay_search
ebay_seller
```

The first vertical slice needs only `ebay_watchlist` and `ebay_item`; search/seller support can reuse the same control plane in Phase 2.

`config` is target-type-specific scheduling/query configuration. Stable domain concepts should be promoted to typed columns when they become broadly queried.

### Scheduling

`next_poll_at` is authoritative for due-work discovery. Graphile Worker runs a small dispatcher job that finds due monitors and enqueues provider-specific poll jobs.

Individual monitor schedules are data, not thousands of static cron definitions.

Use Graphile Worker job keys to prevent redundant pending work for the same target.

## `marketplace_items`

One canonical record per provider marketplace listing/item identity.

```text
id                    uuid primary key
provider              text
marketplace            text
external_item_id      text
seller_external_id    text nullable
canonical_url         text nullable
title                 text nullable
condition_code        text nullable
category_external_id  text nullable
listing_type          text nullable
listing_started_at    timestamptz nullable
listing_ends_at       timestamptz nullable
first_seen_at         timestamptz
last_seen_at          timestamptz
current_state         text
created_at             timestamptz
updated_at             timestamptz
```

Unique identity:

```text
(provider, marketplace, external_item_id)
```

Do not include `connection_id` in this identity. The same public eBay listing discovered by two connected accounts is still one marketplace item.

Account-specific/private facts belong in separate relationships or observations if eBay exposes them.

## `monitor_items`

Many-to-many relationship between monitors and discovered items.

```text
monitor_target_id     uuid
marketplace_item_id   uuid
first_discovered_at   timestamptz
last_matched_at       timestamptz
active                boolean
metadata              jsonb
```

Unique key:

```text
(monitor_target_id, marketplace_item_id)
```

This permits a single item to be discovered through a watchlist, explicit-item monitor, search, and seller monitor without duplicating the item history.

# Marketplace observations (TimescaleDB)

## `marketplace_item_observations`

This is a Timescale hypertable partitioned on `observed_at`.

Logical fields:

```text
marketplace_item_id   uuid
observed_at           timestamptz
connection_id         uuid nullable
source                text
currency              char(3) nullable
price                 numeric nullable
shipping_price        numeric nullable
quantity_available    integer nullable
quantity_sold         integer nullable
availability          text nullable
listing_state         text nullable
watch_count           integer nullable
seller_feedback_score bigint nullable
seller_feedback_pct   numeric nullable
listing_ends_at       timestamptz nullable
raw_state_hash        text nullable
```

Timescale-compatible key/index design must account for the partitioning time column. Do not blindly apply a conventional UUID-only primary key to a hypertable.

### Observation semantics

An observation means: *at `observed_at`, this is what Loxep was able to determine about the external item from this source/account.*

Absence is not the same as zero. Provider fields that are unavailable must remain `NULL` rather than being normalized to `0`.

For the market-intelligence use case, record successful polls even when the values did not change. The interval between repeated equal observations establishes useful bounds for restock/sellout/change timing.

The observation row should remain narrow. Large raw eBay responses belong in provider provenance storage only when needed.

### Initial indexes

At minimum, design for efficient access by:

```text
marketplace_item_id + observed_at desc
observed_at
availability transitions
```

Do not add speculative indexes until actual query patterns are represented by Phase 1/2 screens and analytics.

# Detected market events

Observations are facts; events are derived interpretations of changes between facts.

## `market_events`

```text
id                    uuid primary key
marketplace_item_id   uuid
monitor_target_id     uuid nullable
event_type            text
detected_at            timestamptz
from_observed_at       timestamptz nullable
to_observed_at         timestamptz
payload                jsonb
rule_id                uuid nullable
deduplication_key      text
created_at             timestamptz
```

Initial event types:

```text
price_changed
price_dropped
restocked
sold_out
quantity_changed
listing_ended
```

Later:

```text
new_listing
search_match
seller_listing_added
opportunity_detected
```

`deduplication_key` provides a domain-level uniqueness mechanism so worker retries cannot send duplicate notifications for the same detected transition.

# Notification configuration

Notifications are an output of events, not part of market observation state.

## `notification_endpoints`

```text
id                    uuid primary key
provider              text
name                  text
enabled                boolean
config                 jsonb
secret_credential_id  uuid nullable
created_by_user_id    text
created_at             timestamptz
updated_at             timestamptz
```

Initial provider: `ntfy`.

## `notification_rules`

```text
id                    uuid primary key
name                  text
enabled                boolean
market_event_type     text nullable
monitor_target_id     uuid nullable
endpoint_id           uuid
conditions            jsonb
created_by_user_id    text
created_at             timestamptz
updated_at             timestamptz
```

## `notification_deliveries`

```text
id                    uuid primary key
market_event_id       uuid
endpoint_id           uuid
status                text
attempt_count         integer
last_attempt_at       timestamptz nullable
delivered_at          timestamptz nullable
provider_message_id   text nullable
last_error             text nullable
created_at             timestamptz
```

Uniqueness should prevent duplicate delivery for the same event/endpoint unless an explicit resend workflow is requested.

# Initial relationship map

```text
Better Auth user
      │
      ├── user_profiles
      │
      └── connection_users ─────────────┐
                                       │
                                  connections
                                       │
                         ┌─────────────┼──────────────┐
                         │             │              │
               connection_credentials │       source_events
                                       │
                                  monitor_targets
                                       │
                                  monitor_items
                                       │
                               marketplace_items
                                       │
                         marketplace_item_observations
                                  (Timescale)
                                       │
                                  market_events
                                       │
                             notification_deliveries
```

`provider_objects` sits alongside `source_events` as provenance storage and links to provider/external identities rather than becoming the parent of normalized domain records.

# Phase 1 minimum schema

The first useful eBay monitor should physically require roughly:

```text
Better Auth tables
user_profiles / deployment authorization
connections
connection_users
connection_credentials
source_events
provider_objects (only if required by ingestion implementation)
monitor_targets
marketplace_items
monitor_items
marketplace_item_observations (Timescale hypertable)
market_events
notification_endpoints
notification_rules
notification_deliveries
Graphile Worker schema
```

It should **not** create placeholder tables for:

```text
orders
inventory
customers
projects
invoices
journal_entries
tax filings
```

Those domains have documented ownership and can be added when their first vertical slices are designed.

# Open implementation decisions

These should be resolved before or during the first schema migration rather than left implicit:

1. exact credential encryption/key-management mechanism for generic self-hosting;
2. whether deployment-level `admin/member` role is stored through Better Auth metadata or a Loxep authorization table;
3. exact monetary representation convention across operational domains;
4. observation hypertable chunk interval and retention/compression policy;
5. whether high-frequency observation rows should carry `connection_id` for all public observations or only where account-specific provenance matters;
6. raw provider-object retention policy and cleanup rules;
7. exact enum strategy: PostgreSQL enum, check constraint, or application-defined text for extensible states;
8. audit/event model for user-initiated configuration changes.

These are small enough to settle before code generation but material enough that an agent should not invent them independently.
