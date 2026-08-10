---
title: Foundational Implementation Decisions
---

# Foundational Implementation Decisions

These decisions resolve the implementation questions left open by the foundational data model. They are defaults for the initial schema and runtime, not irreversible product constraints. A future change that alters a foundational invariant should be recorded as an ADR.

## 1. Credential encryption and key management

**Decision:** encrypt provider credential payloads in the application layer using AES-256-GCM from Node's built-in `crypto` implementation.

The deployment provides a 256-bit root encryption key through an environment variable or mounted secret. Ciphertext rows store a key identifier/version, random nonce/IV, authentication tag, and ciphertext. Secrets are never stored in ordinary connection `config` JSON and are never returned through general connection APIs.

The credential service is the only application component that directly encrypts/decrypts secret payloads. Provider adapters request credentials through that service.

Key rotation is explicit: a new key becomes active for writes; existing credentials can be re-encrypted in a controlled migration/job while old key versions remain available for reads until rotation is complete.

Why not PostgreSQL `pgcrypto`: Loxep must ultimately present the plaintext token to an external provider API, and keeping encryption/key handling at the application boundary gives generic self-hosted deployments a clearer secret-management and rotation story.

## 2. Deployment roles

**Decision:** keep Loxep authorization in Loxep-owned tables rather than Better Auth metadata.

Better Auth owns authentication identity, sessions, and login-provider state. Loxep owns authorization.

Initial deployment-level roles:

- `admin`
- `member`

Use a small `user_roles` relation keyed to the Better Auth user ID. Resource-specific access remains modeled separately, e.g. `connection_users` with `owner/manage/view` access.

This avoids coupling domain authorization to a particular authentication library's metadata conventions.

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

Accounting may adopt a wider precision if required, but it should use the same exact-decimal semantics.

## 4. Timescale observation policy

**Decision:** create `marketplace_item_observations` as a Timescale hypertable from the first migration.

Initial physical policy:

- partition column: `observed_at`;
- initial chunk interval: **7 days**;
- recent chunks remain in the rowstore;
- enable Hypercore/columnstore for older observation data;
- initial columnstore policy target: **30 days**;
- segment primarily by `marketplace_item_id` and order by `observed_at DESC` where supported by the deployed Timescale version;
- **no automatic retention/deletion policy by default**.

The 7-day interval is a starting value, not a performance promise. Timescale recommends sizing chunks based on actual data/index size relative to memory, so Loxep should expose operational metrics and revisit the interval after real ingestion volume exists.

The 30-day columnstore threshold keeps recent data optimized for active ingestion while compacting historical observations for analytics. This should be configurable later, but the initial migration should not build around legacy compression APIs.

## 5. Observation connection provenance

**Decision:** keep nullable `connection_id` on marketplace observations.

When an observation came from an authenticated provider connection, record that connection even when the listing itself is public. Account context can affect availability, shipping, location, marketplace behavior, and fields returned by the provider.

`connection_id` is nullable so future public/unauthenticated or imported observations remain representable.

Canonical marketplace-item identity remains independent of connection identity.

## 6. Raw provider-object retention

**Decision:** treat source events and provider-object snapshots differently.

`source_events` are provenance/replay records and should be retained by default unless a user explicitly configures a retention policy for a provider/event class.

`provider_objects` are debugging/synchronization snapshots. For object types where history is useful, keep changed snapshots and deduplicate identical payloads by hash. High-frequency polling must not dump a complete provider JSON response every minute when a narrow observation row already preserves the useful state.

Initial cleanup policy for historical provider-object snapshots should be configurable, with a conservative default such as 90 days while retaining the current/latest useful snapshot. No destructive cleanup should be enabled until the ingestion implementation identifies which object classes are safely reconstructable.

## 7. Enum/state strategy

**Decision:** do not use PostgreSQL enum types for application/domain states initially.

Use `text` columns with application-owned TypeScript constants/unions. Add database `CHECK` constraints for stable closed state sets where database enforcement materially helps.

Provider identifiers, connection providers, integration-specific object types, and other intentionally extensible identifiers remain text without a database enum.

Rationale: PostgreSQL enums create unnecessary migration friction for an application explicitly expected to add providers and states over time. We still want database constraints where a state machine is truly closed; avoiding PG enums does not mean accepting arbitrary strings everywhere.

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

# Resulting first-schema direction

These choices allow the first migrations to proceed without further foundational ambiguity around:

- who authenticates vs who authorizes;
- how provider secrets are protected;
- how exact money is persisted;
- how observation history ages in Timescale;
- how provider/account provenance is retained;
- which raw data is kept;
- how state values evolve;
- how configuration changes are explained later.

Implementation work should verify the exact current APIs and supported syntax of PostgreSQL, TimescaleDB, Drizzle, Better Auth, Graphile Worker, and cryptographic/runtime dependencies immediately before pinning versions or writing migrations, per the project dependency/version policy.
