---
title: Foundation Schema Draft
---

This document turns the foundational data model into a concrete first-migration target. It remains implementation-oriented documentation until the exact current Drizzle, Better Auth, Graphile Worker, PostgreSQL, TimescaleDB, TanStack Start, and related dependency versions are verified immediately before code generation.

The UI donor/reference workspace does not own this schema. Backend architecture is Loxep-owned and independent of the starter's demo data/backend choices.

## Scope

The first schema physically covers only:

- Better Auth-owned authentication tables and deployment-level `admin`/`member` roles;
- minimal economic-entity identity/attribution;
- database-backed application settings and encrypted runtime secrets;
- provider connections and encrypted connection credentials;
- provider/source provenance;
- monitoring targets;
- canonical marketplace items;
- Timescale-backed observations;
- derived market events;
- notifications;
- media/storage-backend metadata and migration state;
- external-resource links;
- user/configuration audit events;
- Graphile Worker-owned job schema.

Phase 0 does **not** create per-connection/per-entity ACL tables or placeholder full commerce/accounting/project tables.

## Auth tables and user references

Per ADR-0020, Better Auth's CLI generates its Drizzle schema, which is checked in and migrated through the same reviewed Drizzle workflow as every other table.

User-reference columns in this draft (`created_by_user_id`, `updated_by_user_id`, `actor_user_id`) are refined at implementation time into one of two intentional forms: nullable foreign keys to the Better Auth user ID with `ON DELETE SET NULL` (the default for provenance), or documented non-FK historical identity references where the identifier itself must survive user deletion. Cascading deletion from auth tables into domain, audit, or business tables is prohibited.

The implementation (`packages/db`) resolved this refinement: every `created_by_user_id`/`updated_by_user_id` column is a nullable `ON DELETE SET NULL` foreign key to the Better Auth user id — including the columns this draft sketched as `not null` on `connections`, `monitor_targets`, `storage_migrations`, `notification_endpoints`, and `notification_rules` — while `audit_events.actor_user_id` remains an intentional non-FK historical text reference.

## Application settings and runtime secrets

Normal runtime configuration should be manageable inside Loxep rather than encoded as environment variables. See [Configuration & Secrets](../configuration-and-secrets/) and ADR-0016.

### `application_settings`

```text
key                   text primary key
value                 jsonb not null
schema_version        integer not null default 1
updated_by_user_id    text null
updated_at            timestamptz not null
```

This table is for genuinely application-level settings. It is **not** a substitute for proper domain tables: monitor settings belong with monitors, connection settings with connections, and feature-specific relational configuration with the feature that owns it.

Settings are validated through a typed registry/domain service before persistence. Values requiring a restart should be exceptional and identified explicitly.

### `application_secrets` and `application_secret_versions`

Per ADR-0019, secret storage separates the stable logical secret from immutable ciphertext versions:

```text
application_secrets
id                    uuid primary key
secret_key            text not null unique
purpose               text not null
current_version       integer not null
created_by_user_id    text null
created_at            timestamptz not null
updated_at            timestamptz not null

application_secret_versions
secret_id             uuid not null references application_secrets(id)
version               integer not null
key_version           integer not null
nonce                 bytea not null
auth_tag              bytea not null
ciphertext            bytea not null
created_at            timestamptz not null
primary key(secret_id, version)
```

Use this for encrypted runtime secrets that are not naturally credentials of a provider connection, for example an S3 backend credential bundle or a global notification-service token. Consumers such as `storage_backends.secret_id` reference the logical `application_secrets.id`, never a version row. `current_version` is the explicit active pointer; rotation writes a new immutable version and then moves the pointer.

Plaintext payloads are typed bundles validated per purpose/type before encryption (an S3 credential atomically contains access key ID and secret access key). Encryption uses AES-256-GCM with AAD binding ciphertext to record class, logical ID, version, and key version, so ciphertext moved between rows fails authentication.

The external root encryption keyring — a defined document carrying an active key version plus versioned 256-bit keys, delivered preferably as a mounted file/Docker secret — is bootstrap configuration and never lives in PostgreSQL. Plaintext values are available only through the narrow credential/secret service and are never returned through general settings APIs.

Connection-specific credentials keep their own model because token expiry/refresh/version semantics are part of a connection lifecycle.

## Economic entities

An installation may represent activity for more than one person, business, or operating identity even though the installation is not multi-tenant. ADR-0017 defines this distinction.

### `economic_entities`

```text
id                    uuid primary key
name                  text not null
kind                  text not null
parent_entity_id      uuid null references economic_entities(id)
legal_name            text null
active                boolean not null default true
created_at            timestamptz not null
updated_at            timestamptz not null
```

Initial application-owned `kind` values may include:

```text
individual
sole_proprietorship
llc
partnership
corporation
assumed_name
operating_unit
other
```

`kind` is descriptive application state, not a tax/legal determination. Keep it as text with TypeScript-owned validation rather than a PostgreSQL enum.

`parent_entity_id` allows an operating identity or assumed name to sit beneath another entity without claiming that it is a separate legal person.

Economic entities are **not authorization containers** and are **not accounting books**. Multiple economic entities/operating identities may later participate in the same accounting book, with separation handled by chart-of-accounts structure or other accounting dimensions. Phase 0 intentionally does not create `accounting_books` or put a required book ID on this table.

## Connection foundation

### `connections`

```text
id                    uuid primary key
provider              text not null
kind                  text not null
name                  text not null
status                text not null
economic_entity_id    uuid null references economic_entities(id)
external_account_id   text null
external_account_name text null
config                 jsonb not null default '{}'
created_by_user_id    text not null
created_at            timestamptz not null
updated_at            timestamptz not null
last_success_at       timestamptz null
last_error_at         timestamptz null
last_error_code       text null
```

Indexes/constraints:

```text
index(provider, status)
index(economic_entity_id)
index(created_by_user_id)
```

Do not globally enforce uniqueness of `external_account_id`; provider semantics differ. Provider-specific adapters may enforce stronger scoped uniqueness where reliable.

`economic_entity_id` is nullable because some integrations are shared, infrastructural, or not meaningfully attributable to one entity. Where an account clearly represents one economic entity—such as a business marketplace account—the relationship should be recorded.

Provider connections are created and managed through authenticated Loxep workflows. They are not Compose environment entries.

Phase 0 intentionally has no `connection_users` relation. Better Auth `admin` and `member` users have installation-wide ordinary product access. `created_by_user_id` is audit/provenance metadata, not an ACL or ownership rule. Fine-grained connection/entity/workspace permissions are deferred until a real use case requires them.

### `connection_credentials` and `connection_credential_versions`

Per ADR-0019, connection credentials follow the same logical-record-plus-versions pattern:

```text
connection_credentials
id                    uuid primary key
connection_id         uuid not null references connections(id)
credential_type       text not null
current_version       integer not null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(connection_id, credential_type)

connection_credential_versions
credential_id         uuid not null references connection_credentials(id)
version               integer not null
key_version           integer not null
nonce                 bytea not null
auth_tag              bytea not null
ciphertext            bytea not null
expires_at            timestamptz null
refresh_after         timestamptz null
created_at            timestamptz not null
primary key(credential_id, version)
```

Expiry/refresh metadata lives on the version row because it describes one issued token, not the logical credential slot. Plaintext payloads are typed bundles validated per credential type before encryption.

Only the credential service accesses plaintext credentials. The encryption implementation follows the accepted AES-256-GCM/key-versioning design with ADR-0019's AAD context binding.

## Provider provenance

### `source_events`

```text
id                    uuid primary key
connection_id         uuid null references connections(id)
provider              text not null
event_type            text not null
external_event_id     text null
external_object_type  text null
external_object_id    text null
occurred_at           timestamptz null
received_at           timestamptz not null
payload               jsonb not null
payload_hash          text not null
processing_status     text not null
processing_attempts   integer not null default 0
processed_at          timestamptz null
last_error            text null
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

### `provider_objects`

```text
id                    uuid primary key
connection_id         uuid null references connections(id)
provider              text not null
object_type           text not null
external_object_id    text not null
fetched_at            timestamptz not null
provider_updated_at   timestamptz null
payload               jsonb not null
payload_hash           text not null
```

Indexes:

```text
index(provider, object_type, external_object_id, fetched_at desc)
index(payload_hash)
```

High-frequency marketplace observations use the narrow Timescale table rather than repeated full JSON snapshots.

## Monitoring

### `monitor_targets`

```text
id                    uuid primary key
connection_id         uuid null references connections(id)
target_type           text not null
name                  text not null
enabled               boolean not null default true
interval_seconds      integer not null
priority              integer not null default 0
next_poll_at           timestamptz null
last_poll_at           timestamptz null
last_success_at        timestamptz null
backoff_until          timestamptz null
consecutive_errors    integer not null default 0
config                 jsonb not null default '{}'
created_by_user_id    text not null
created_at            timestamptz not null
updated_at            timestamptz not null
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

A later phase adds search/seller types without changing the scheduling model.

### `marketplace_items`

```text
id                    uuid primary key
provider              text not null
marketplace           text not null
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
created_at            timestamptz not null
updated_at            timestamptz not null
unique(provider, marketplace, external_item_id)
```

Indexes:

```text
index(provider, marketplace, seller_external_id)
index(last_seen_at desc)
```

### `monitor_items`

```text
monitor_target_id     uuid not null references monitor_targets(id)
marketplace_item_id   uuid not null references marketplace_items(id)
first_discovered_at   timestamptz not null
last_matched_at       timestamptz not null
active                boolean not null default true
metadata              jsonb not null default '{}'
primary key(monitor_target_id, marketplace_item_id)
```

## Timescale observations

### `marketplace_item_observations`

Logical columns:

```text
marketplace_item_id   uuid not null
observed_at           timestamptz not null
observation_batch_id  uuid not null
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
- current columnstore policy after roughly 30 days initially;
- no automatic retention deletion by default.

### Retry identity

Observation writes must be idempotent under at-least-once job execution. `observation_batch_id` is generated **once when a provider fetch/poll result is obtained** and retained across processing retries; `observed_at` is likewise fixed at that moment rather than regenerated on retry. One watchlist response uses one batch ID across its many items.

Uniqueness:

```text
unique(observation_batch_id, marketplace_item_id, observed_at)
```

This includes the partition column as Timescale requires for hypertable unique indexes, while providing genuine retry identity: a retried handler re-inserting the same batch conflicts instead of duplicating, and two connections legitimately observing the same item at the same moment remain distinct batches. `connection_id` stays provenance, not part of uniqueness.

Successful unchanged observations are retained because they establish time bounds for state changes.

Exact current Timescale syntax is intentionally not frozen here; verify it immediately before migration implementation.

## Derived market events

### `market_events`

```text
id                    uuid primary key
marketplace_item_id   uuid not null references marketplace_items(id)
monitor_target_id     uuid null references monitor_targets(id)
event_type            text not null
detected_at           timestamptz not null
from_observed_at      timestamptz null
to_observed_at        timestamptz not null
payload               jsonb not null default '{}'
rule_id               uuid null
deduplication_key     text not null unique
created_at            timestamptz not null
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

## Media and object storage

Storage backends are configured resources rather than hardcoded driver names. This allows one installation to migrate between local storage and one or more S3-compatible destinations without changing media identity.

### `storage_backends`

```text
id                    uuid primary key
name                  text not null
driver                text not null
enabled               boolean not null default true
is_default            boolean not null default false
config                jsonb not null default '{}'
secret_id             uuid null references application_secrets(id)
created_by_user_id    text null
created_at            timestamptz not null
updated_at            timestamptz not null
```

Initial driver families:

```text
local
s3
```

For `s3`, non-secret endpoint/region/bucket/addressing settings live in `config`; credentials use encrypted secret storage. RustFS is the initial recommended/tested self-hosted S3 conformance target, but no RustFS-specific identity belongs in this schema.

The local filesystem mount/root may still involve bootstrap deployment topology even when backend selection is represented in-app.

### `media_objects`

```text
id                    uuid primary key
storage_backend_id    uuid not null references storage_backends(id)
storage_key           text not null
original_filename     text null
mime_type             text null
size_bytes            bigint not null
sha256                text not null
created_by_user_id    text null
created_at            timestamptz not null
metadata              jsonb not null default '{}'
```

Constraints/indexes:

```text
unique(storage_backend_id, storage_key)
index(sha256)
```

### `media_links`

```text
media_object_id       uuid not null references media_objects(id)
resource_type         text not null
resource_id           text not null
purpose               text not null
sort_order            integer null
created_at            timestamptz not null
```

Suggested uniqueness should be based on actual attachment semantics rather than enforcing one universal relationship rule.

## Storage migration state

Storage migrations are durable jobs and have persisted administrative state rather than relying only on worker logs.

### `storage_migrations`

```text
id                     uuid primary key
source_backend_id      uuid not null references storage_backends(id)
destination_backend_id uuid not null references storage_backends(id)
status                 text not null
started_at             timestamptz null
completed_at           timestamptz null
created_by_user_id     text not null
created_at             timestamptz not null
summary                jsonb not null default '{}'
```

### `storage_migration_objects`

```text
migration_id          uuid not null references storage_migrations(id)
media_object_id       uuid not null references media_objects(id)
status                text not null
attempt_count         integer not null default 0
verified_at           timestamptz null
last_error             text null
primary key(migration_id, media_object_id)
```

Migration jobs are resumable and idempotent. Source data is never deleted as part of copy/verify. Metadata cutover occurs only after successful verification.

The first conformance path should prove `local -> RustFS/S3`; the workflow must remain valid for other S3-compatible destinations and later S3-to-S3 migration.

## External companion resources

### `external_resources`

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

### `resource_links`

```text
external_resource_id  uuid not null references external_resources(id)
resource_type         text not null
resource_id           text not null
purpose               text not null
created_at             timestamptz not null
```

This supports relationships to knowledge documents, tasks/projects, GitHub issues, billing records, and future companion systems without provider-specific columns in every domain table.

## Notifications

### `notification_endpoints`

```text
id                    uuid primary key
provider              text not null
name                  text not null
enabled                boolean not null default true
config                 jsonb not null default '{}'
secret_id             uuid null references application_secrets(id)
created_by_user_id    text not null
created_at             timestamptz not null
updated_at             timestamptz not null
```

A notification endpoint is not necessarily an external account connection. Its secret therefore uses application-level encrypted secret storage unless a future provider model makes a real connection record appropriate.

### `notification_rules`

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

### `notification_deliveries`

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

## Audit events

### `audit_events`

```text
id                    uuid primary key
occurred_at           timestamptz not null
actor_user_id         text null
action                text not null
resource_type         text not null
resource_id           text null
before                jsonb null
after                 jsonb null
request_id            text null
metadata              jsonb not null default '{}'
```

Secrets must be redacted before audit serialization. Secret-change events record metadata/status, never plaintext values.

## Relationship overview

The first schema is intentionally narrow. The important relationships are:

```text
Better Auth users
    |
    +--> installation-wide admin/member access
    +--> audit/provenance fields

economic_entities
    |
    +--> economic_entities.parent_entity_id
    +--> connections --> connection_credentials
                      |
                      +--> source_events / provider_objects
                      +--> monitor_targets --> monitor_items
                                              |
                                              v
                                       marketplace_items
                                              |
                                              +--> observations (Timescale)
                                              +--> market_events
                                                       |
                                                       v
                                              notification_deliveries

application_settings
application_secrets --> storage_backends --> media_objects --> media_links
                         |
                         +--> storage_migrations

audit_events

connections / domain resources <--> external_resources <--> resource_links
```

This is not the eventual business schema. Commerce, inventory, projects, finance, accounting books, and accounting are added when their workflows become implementation scope.

A future Accounting model must keep accounting books distinct from `economic_entities`: more than one entity/operating identity may share the same book and chart of accounts.

## Runtime topology constraints

The schema is independent of deployment topology.

Default deployment:

```text
loxep (LOXEP_MODE=all: web + worker)
postgres-timescale
local media
```

Optional object-storage profile:

```text
rustfs (generic S3 target)
```

Expanded deployment:

```text
one or more LOXEP_MODE=web runtimes
one or more LOXEP_MODE=worker runtimes
shared postgres-timescale
shared S3-compatible object storage
```

If Loxep detects multiple application hosts with a `local` media backend that is not known to be shared, administration should display a prominent migration/topology warning.

## Before implementing this schema

Immediately before generating the actual Drizzle schema/migrations:

1. verify current viable versions of Drizzle ORM/Kit, Better Auth, Graphile Worker, PostgreSQL, TimescaleDB, TanStack Start, Bun, and other foundational packages;
2. verify current Timescale hypertable/columnstore migration syntax (the removed Hypercore TAM APIs must not be used) — done against TimescaleDB 2.29.1: the observation migration uses `CREATE TABLE ... WITH (tsdb.hypertable, tsdb.partition_column = 'observed_at', tsdb.chunk_interval = '7 days')`, `ALTER TABLE ... SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'marketplace_item_id', timescaledb.orderby = 'observed_at DESC, observation_batch_id')`, and `CALL add_columnstore_policy('marketplace_item_observations', after => INTERVAL '30 days')`;
3. verify Better Auth's current table/plugin requirements for OIDC, magic links, and admin/member roles;
4. verify the exact first-admin bootstrap/recovery implementation against the current Better Auth API;
5. implement ADR-0017's installation-wide access model without a speculative `connection_users` ACL table;
6. keep `economic_entities` independent of future accounting books and counterparties;
7. select the exact maintained decimal library after current verification;
8. verify the current RustFS release and S3 behavior used by the development/CI conformance target;
9. implement storage conformance tests shared by `local` and generic `s3` drivers — the S3 tests take only a generic endpoint configuration and must not know they are testing RustFS, which is simply the official CI target (ADR-0014);
10. implement settings/secret validation and redacted audit behavior before provider credentials are used;
11. use the Kiranism donor/reference workspace for UI patterns without copying its demo backend architecture into Loxep.