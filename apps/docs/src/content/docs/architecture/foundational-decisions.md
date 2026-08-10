---
title: Foundational Implementation Decisions
---

# Foundational Implementation Decisions

These decisions resolve implementation questions left open by the foundational data model. They are defaults for the initial schema and runtime, not irreversible product constraints. A future change that alters a foundational invariant should be recorded as an ADR.

## 1. Credential encryption and key management

**Decision:** encrypt provider credential payloads in the application layer using AES-256-GCM from Node's built-in `crypto` implementation.

The deployment provides a 256-bit root encryption key through an environment variable or mounted secret. Ciphertext rows store a key identifier/version, random nonce/IV, authentication tag, and ciphertext. Secrets are never stored in ordinary connection `config` JSON and are never returned through general connection APIs.

The credential service is the only application component that directly encrypts/decrypts secret payloads. Provider adapters request credentials through that service.

Key rotation is explicit: a new key becomes active for writes; existing credentials can be re-encrypted in a controlled migration/job while old key versions remain available for reads until rotation is complete.

Why not PostgreSQL `pgcrypto`: Loxep must ultimately present the plaintext token to an external provider API, and keeping encryption/key handling at the application boundary gives generic self-hosted deployments a clearer secret-management and rotation story.

## 2. Authentication and authorization ownership

**Decision:** Better Auth owns authentication, sessions, login-provider state, and deployment-level user roles. Loxep owns domain/resource authorization.

Use Better Auth's current Admin/access-control capabilities for deployment roles such as:

- `admin`
- `member`

Do not create a parallel Loxep `user_roles` table merely to duplicate those global roles.

Loxep-owned relations still model permissions that are business/domain data rather than authentication-system concerns. For example, `connection_users` expresses that one user may `owner`, `manage`, or `view` a specific eBay/WooCommerce connection while another user cannot access it.

## 3. Monetary representation

**Decision:** use PostgreSQL fixed-precision `numeric`, never floating point and not a universal minor-unit integer representation.

Initial operational convention:

```text
amount       numeric(20,6)
currency     char(3)
```

Six fractional decimal places preserve provider precision, shipping/fee allocations, exchange-rate-derived values, and future cost allocation without requiring every amount to be rounded prematurely to a currency's display exponent.

Application code must not convert persisted money to JavaScript `number` for arithmetic. Drizzle should expose monetary numerics as strings and the domain layer should use an exact decimal implementation for calculations.

Display and settlement rounding occur according to the currency/provider/accounting context, not implicitly at storage time.

## 4. Timescale observation policy

**Decision:** create `marketplace_item_observations` as a Timescale hypertable from the first migration.

Initial physical policy:

- partition column: `observed_at`;
- initial chunk interval: **7 days**;
- recent chunks remain in the rowstore;
- enable current Hypercore/columnstore features for older observation data;
- initial columnstore policy target: **30 days**;
- segment primarily by `marketplace_item_id` and order by `observed_at DESC` where supported by the deployed Timescale version;
- **no automatic retention/deletion policy by default**.

The 7-day interval is a starting value, not a performance promise. Chunk sizing should be revisited after real ingestion volume exists. Exact migration/API syntax must be verified against the current supported Timescale release immediately before implementation.

## 5. Observation connection provenance

**Decision:** keep nullable `connection_id` on marketplace observations.

When an observation came from an authenticated provider connection, record that connection even when the listing itself is public. Account context can affect availability, shipping, location, marketplace behavior, and fields returned by the provider.

Canonical marketplace-item identity remains independent of connection identity.

## 6. Raw provider-object retention

**Decision:** treat source events and provider-object snapshots differently.

`source_events` are provenance/replay records and should be retained by default unless a user explicitly configures a retention policy for a provider/event class.

`provider_objects` are debugging/synchronization snapshots. For object types where history is useful, keep changed snapshots and deduplicate identical payloads by hash. High-frequency polling must not dump a complete provider JSON response every minute when a narrow observation row already preserves the useful state.

Initial cleanup policy for historical provider-object snapshots should be configurable and conservative. No destructive cleanup should be enabled until the ingestion implementation identifies which object classes are safely reconstructable.

## 7. Enum/state strategy

**Decision:** do not use PostgreSQL enum types for application/domain states initially.

Use `text` columns with application-owned TypeScript constants/unions. Add database `CHECK` constraints for stable closed state sets where database enforcement materially helps.

Provider identifiers, connection providers, integration-specific object types, and other intentionally extensible identifiers remain text without a database enum.

## 8. User/configuration audit model

**Decision:** add a separate append-oriented `audit_events` model for user-initiated and administrative changes.

Logical fields:

```text
id              uuid primary key
occurred_at     timestamptz
actor_user_id   text nullable
action          text
resource_type   text
resource_id     text nullable
before          jsonb nullable
after           jsonb nullable
request_id      text nullable
metadata        jsonb nullable
```

Audit serialization must redact secrets and sensitive credential material before persistence.

`audit_events` is distinct from `source_events`:

- `source_events` explain what an external provider told Loxep;
- `audit_events` explain what a user/system administrator changed in Loxep.

System-generated domain events such as `restocked` or `price_changed` remain in their owning domain and are not shoved into the audit table.

## 9. Media and object storage

**Decision:** do not use PostgreSQL as the normal storage layer for images, PDFs, receipts, attachments, product media, or other potentially large binary objects.

PostgreSQL stores metadata, ownership, hashes, MIME type, size, and relationships. File bytes go through a storage abstraction with at least two drivers:

- `local`: filesystem-backed storage for the smallest deployment with no additional service;
- `s3`: standard S3-compatible object storage for production/shared deployments.

**RustFS is the initial recommended/tested self-hosted S3 companion.** It runs as a separate service/container but may be supplied as an optional profile in Loxep's Compose project. Loxep's application contract remains generic S3, so Garage, SeaweedFS S3, hosted S3 services, and future alternatives can replace RustFS without a domain-schema redesign.

Logical metadata resembles:

```text
media_objects
  id
  storage_backend
  storage_key
  original_filename
  mime_type
  size_bytes
  sha256
  created_by_user_id
  created_at

media_links
  media_object_id
  resource_type
  resource_id
  purpose
```

Do not store public bucket URLs as canonical identity. Generate access URLs from the configured backend.

Local-to-S3 migration is a product feature: resumable copy, verification, metadata cutover only after verification, retry, reporting, and explicit delayed source cleanup.

## 10. Process and container topology

**Decision:** a worker runtime is an architectural capability, not a mandatory separate container.

Build one Loxep application image with explicit runtime modes:

```text
LOXEP_MODE=all
LOXEP_MODE=web
LOXEP_MODE=worker
```

`all` is the default initial self-hosted profile. It runs the web runtime and Graphile Worker in the same Loxep container. They do not need to share one event loop; implementation may use clean sibling Node processes or another lifecycle arrangement that preserves a single application container.

Larger deployments can run the same image as independent `web` and `worker` services/processes on one or more hosts. Because jobs are durable in PostgreSQL/Graphile Worker, splitting workers later does not require redesigning the job model.

A dedicated worker becomes useful when background work needs independent resources, concurrency, restarts, or host placement. It should not be required merely for conceptual purity.

## 11. UI/dashboard starting point

**Decision:** use Kiranism's TanStack Start dashboard as Loxep's initial UI shell/donor rather than building common dashboard presentation infrastructure from scratch.

Adopt/adapt:

- responsive application shell;
- sidebar/header/navigation;
- multi-theme/tweakcn theme system;
- shadcn/Base UI composition;
- useful TanStack Table/Form/Query patterns;
- command palette and application-state patterns.

Do not blindly inherit:

- demo data or domain model;
- starter auth/backend implementation;
- unnecessary dependencies;
- broad Zustand usage;
- starter charting choices where Loxep needs denser analytical visualization;
- dependency versions without current upstream verification.

The starter supplies presentation acceleration; Loxep ADRs remain authoritative for architecture.

## 12. External companion-resource links

**Decision:** establish generic external resource/link records early so future integrations with knowledge, task, billing, and other specialist platforms do not require provider-specific ID columns in every domain.

The foundation uses concepts equivalent to:

```text
external_resources
resource_links
```

Provider adapters may add richer operations, but Loxep domain records should be able to link to Outline documents, Vikunja tasks/projects, AFFiNE pages, GitHub issues, Invoice Ninja objects, or future systems through the same relationship model.

# Resulting first-schema direction

These choices allow the first migrations and application scaffold to proceed with clear defaults around:

- Better Auth authentication/global roles vs Loxep resource authorization;
- provider-secret protection;
- exact money persistence;
- Timescale observation aging;
- provider/account provenance;
- raw-data retention;
- extensible state values;
- user/configuration auditing;
- local/S3 media storage and migration;
- simple vs split runtime deployment;
- UI starter adoption;
- generic companion-resource relationships.

Implementation work must verify the exact current APIs and supported syntax of PostgreSQL, TimescaleDB, Drizzle, Better Auth, Graphile Worker, TanStack Start, storage dependencies, and runtime dependencies immediately before pinning versions or writing migrations, per the project dependency/version policy.
