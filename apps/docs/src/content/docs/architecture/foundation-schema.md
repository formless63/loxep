---
title: Foundation Schema Draft
---

# Foundation Schema Draft

This document turns the foundational data model into a concrete first-migration target. It remains implementation-oriented documentation until the exact current Drizzle, Better Auth, Graphile Worker, PostgreSQL, and TimescaleDB versions are verified immediately before code generation.

## Scope

The first schema physically covers only:

- Better Auth-owned authentication tables;
- provider connections and resource access;
- encrypted connection credentials;
- provider/source provenance;
- monitoring targets;
- canonical marketplace items;
- Timescale-backed observations;
- derived market events;
- notifications;
- media/object-storage metadata;
- external-resource links;
- user/configuration audit events;
- Graphile Worker-owned job schema.

No placeholder commerce/accounting/project tables are created yet.

# Connection foundation

## `connections`

```text
id                    uuid primary key
provider              text not null
kind                  text not null
name                  text not null
status                text not null
external_account_id   text null
external_account_name text null
config                 jsonb not null default '{}'
created_by_user_id    text not null
created_at             timestamptz not null
updated_at             timestamptz not null
last_success_at        timestamptz null
last_error_at          timestamptz null
last_error_code        text null
```

Indexes/constraints:

```text
index(provider, status)
index(created_by_user_id)
```

Do not globally enforce uniqueness of `external_account_id`; provider semantics differ. Provider-specific adapters may enforce stronger scoped uniqueness where reliable.

## `connection_users`

```text
connection_id         uuid not null references connections(id)
user_id               text not null
role                  text not null
created_at             timestamptz not null
primary key(connection_id, user_id)
check role in ('owner','manage','view')
```

Deployment-wide `admin/member` roles remain Better Auth-owned. This relation represents Loxep resource authorization.

## `connection_credentials`

```text
id                    uuid primary key
connection_id         uuid not null references connections(id)
credential_type       text not null
key_version           integer not null
nonce                 bytea not null
auth_tag              bytea not null
ciphertext            bytea not null
expires_at             timestamptz null
refresh_after          timestamptz null
version                integer not null
created_at             timestamptz not null
updated_at             timestamptz not null
```

Suggested uniqueness:

```text
unique(connection_id, credential_type, version)
```

Only the credential service accesses plaintext credentials.

# Provider provenance

## `source_events`

```text
id                    uuid primary key
connection_id         uuid null references connections(id)
provider              text not null
event_type            text not null
external_event_id     text null
external_object_type  text null
external_object_id    text null
occurred_at             timestamptz null
received_at             timestamptz not null
payload                jsonb not null
payload_hash           text not null
processing_status      text not null
processing_attempts    integer not null default 0
processed_at            timestamptz null
last_error             text null
```

Indexes:

```text
index(connection_id, received_at desc)
index(provider, event_type, received_at desc)
index(external_object_type, external_object_id)
```

Partial uniqueness where a provider gives a stable event ID:

```text
unique(connection_id, provider, external_event_id)
where external_event_id is not null
```

## `provider_objects`

```text
id                    uuid primary key
connection_id         uuid null references connections(id)
provider              text not null
object_type           text not null
external_object_id    text not null
fetched_at             timestamptz not null
provider_updated_at    timestamptz null
payload                jsonb not null
payload_hash           text not null
```

Indexes:

```text
index(provider, object_type, external_object_id, fetched_at desc)
index(payload_hash)
```

High-frequency marketplace observations use the narrow Timescale table rather than repeated full JSON snapshots.

# Monitoring

## `monitor_targets`

```text
id                    uuid primary key
connection_id         uuid null references connections(id)
target_type           text not null
name                  text not null
enabled                boolean not null default true
interval_seconds      integer not null
priority              integer not null default 0
next_poll_at           timestamptz null
last_poll_at           timestamptz null
last_success_at        timestamptz null
backoff_until          timestamptz null
consecutive_errors    integer not null default 0
config                 jsonb not null default '{}'
created_by_user_id    text not null
created_at             timestamptz not null
updated_at             timestamptz not null
```

Indexes:

```text
index(enabled, next_poll_at) where enabled = true
index(connection_id, target_type)
```

Initial target types:

```text
ebay_watchlist
ebay_item
```

Phase 2 adds search/seller types without changing the scheduling model.

## `marketplace_items`

```text
id                    uuid primary key
provider              text not null
marketplace            text not null
external_item_id      text not null
seller_external_id    text null
canonical_url         text null
title                 text null
condition_code        text null
category_external_id  text null
listing_type          text null
listing_started_at    timestamptz null
listing_ends_at       timestamptz null
first_seen_at         timestamptz not null
last_seen_at          timestamptz not null
current_state         text not null
created_at             timestamptz not null
updated_at             timestamptz not null
unique(provider, marketplace, external_item_id)
```

Indexes:

```text
index(provider, marketplace, seller_external_id)
index(last_seen_at desc)
```

## `monitor_items`

```text
monitor_target_id     uuid not null references monitor_targets(id)
marketplace_item_id   uuid not null references marketplace_items(id)
first_discovered_at   timestamptz not null
last_matched_at       timestamptz not null
active                boolean not null default true
metadata              jsonb not null default '{}'
primary key(monitor_target_id, marketplace_item_id)
```

# Timescale observations

## `marketplace_item_observations`

Logical columns:

```text
marketplace_item_id   uuid not null
observed_at           timestamptz not null
connection_id         uuid null
source                text not null
currency              char(3) null
price                 numeric(20,6) null
shipping_price        numeric(20,6) null
quantity_available    integer null
quantity_sold         integer null
availability          text null
listing_state         text null
watch_count           integer null
seller_feedback_score bigint null
seller_feedback_pct   numeric(10,6) null
listing_ends_at       timestamptz null
raw_state_hash        text null
```

Physical policy:

- Timescale hypertable partitioned by `observed_at`;
- initial chunk interval 7 days;
- index optimized for `(marketplace_item_id, observed_at desc)`;
- Hypercore/columnstore policy after roughly 30 days initially;
- no automatic retention deletion by default.

Successful unchanged observations are retained because they establish time bounds for state changes.

# Derived market events

## `market_events`

```text
id                    uuid primary key
marketplace_item_id   uuid not null references marketplace_items(id)
monitor_target_id     uuid null references monitor_targets(id)
event_type            text not null
detected_at            timestamptz not null
from_observed_at       timestamptz null
to_observed_at         timestamptz not null
payload                jsonb not null default '{}'
rule_id                uuid null
deduplication_key      text not null unique
created_at             timestamptz not null
```

Initial events:

```text
price_changed
price_dropped
restocked
sold_out
quantity_changed
listing_ended
```

# Media and object storage

## `media_objects`

```text
id                    uuid primary key
storage_backend       text not null
storage_key           text not null
original_filename     text null
mime_type             text null
size_bytes            bigint not null
sha256                text not null
created_by_user_id    text null
created_at             timestamptz not null
metadata              jsonb not null default '{}'
```

Constraints/indexes:

```text
unique(storage_backend, storage_key)
index(sha256)
```

`storage_backend` initially distinguishes configured backend identities, not just `local` vs `s3`, so future migrations between two S3 stores remain representable.

## `media_links`

```text
media_object_id       uuid not null references media_objects(id)
resource_type         text not null
resource_id           text not null
purpose               text not null
sort_order            integer null
created_at             timestamptz not null
```

Suggested uniqueness should be based on actual attachment semantics rather than enforcing one universal relationship rule.

# Local-to-S3 migration state

Storage migrations are durable jobs and should have persisted administrative state rather than relying only on worker logs.

## `storage_migrations`

```text
id                    uuid primary key
source_backend        text not null
destination_backend   text not null
status                text not null
started_at             timestamptz null
completed_at           timestamptz null
created_by_user_id    text not null
created_at             timestamptz not null
summary                jsonb not null default '{}'
```

## `storage_migration_objects`

```text
migration_id          uuid not null references storage_migrations(id)
media_object_id       uuid not null references media_objects(id)
status                text not null
attempt_count         integer not null default 0
verified_at            timestamptz null
last_error             text null
primary key(migration_id, media_object_id)
```

Migration jobs are resumable and idempotent. Source data is never deleted as part of the copy/verify step.

# External companion resources

## `external_resources`

```text
id                    uuid primary key
provider              text not null
connection_id         uuid null references connections(id)
external_type         text not null
external_id           text null
url                   text not null
title                 text null
metadata              jsonb not null default '{}'
created_at             timestamptz not null
updated_at             timestamptz not null
```

## `resource_links`

```text
external_resource_id  uuid not null references external_resources(id)
resource_type         text not null
resource_id           text not null
purpose               text not null
created_at             timestamptz not null
```

This supports relationships to Outline documents, Vikunja projects/tasks, GitHub issues, AFFiNE pages, and future companion systems without provider-specific columns in every domain table.

# Notifications

## `notification_endpoints`

```text
id                    uuid primary key
provider              text not null
name                  text not null
enabled                boolean not null default true
config                 jsonb not null default '{}'
secret_credential_id  uuid null references connection_credentials(id)
created_by_user_id    text not null
created_at             timestamptz not null
updated_at             timestamptz not null
```

## `notification_rules`

```text
id                    uuid primary key
name                  text not null
enabled                boolean not null default true
market_event_type     text null
monitor_target_id     uuid null references monitor_targets(id)
endpoint_id           uuid not null references notification_endpoints(id)
conditions            jsonb not null default '{}'
created_by_user_id    text not null
created_at             timestamptz not null
updated_at             timestamptz not null
```

## `notification_deliveries`

```text
id                    uuid primary key
market_event_id       uuid not null references market_events(id)
endpoint_id           uuid not null references notification_endpoints(id)
status                text not null
attempt_count         integer not null default 0
last_attempt_at       timestamptz null
delivered_at          timestamptz null
provider_message_id   text null
last_error             text null
created_at             timestamptz not null
unique(market_event_id, endpoint_id)
```

# Audit events

## `audit_events`

```text
id                    uuid primary key
occurred_at             timestamptz not null
actor_user_id         text null
action                text not null
resource_type         text not null
resource_id           text null
before                jsonb null
after                 jsonb null
request_id            text null
metadata              jsonb not null default '{}'
```

Secrets must be redacted before audit serialization.

# Runtime topology constraints

The schema is independent of deployment topology.

Default deployment:

```text
loxep (web + worker)
postgres/timescale
local media or optional S3
```

Expanded deployment:

```text
one or more web runtimes
one or more worker runtimes
shared postgres/timescale
shared S3-compatible object storage
```

If Loxep detects multiple application hosts/processes with a `local` media backend that is not known to be shared, administration should display a prominent migration/topology warning.

# Before implementing this schema

Immediately before generating the actual Drizzle schema/migrations:

1. verify current stable versions of Drizzle ORM/Kit, Better Auth, Graphile Worker, PostgreSQL, TimescaleDB, and TanStack Start;
2. verify current Timescale hypertable/Hypercore migration syntax;
3. verify Better Auth's current table/plugin requirements for OIDC, magic links, and admin roles;
4. decide the exact decimal library after checking current maintenance/status;
5. implement storage conformance tests shared by `local` and `s3` drivers.
