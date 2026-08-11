---
title: Foundational Implementation Decisions
---

These decisions resolve implementation questions left open by the foundational data model. They are defaults for the initial schema/runtime. Accepted ADRs remain authoritative where they supersede this summary.

## 1. Credential encryption and key management

**Decision:** encrypt runtime/provider credential payloads in the application layer using AES-256-GCM from Node's built-in `crypto` implementation.

The deployment provides a 256-bit root encryption key/keyring through environment or mounted-secret bootstrap configuration. Ciphertext rows store key version, random nonce/IV, authentication tag, and ciphertext. Secrets never live in ordinary connection/settings JSON and are never returned through general APIs.

The credential/secret service is the only application boundary that directly encrypts/decrypts plaintext. Provider adapters and other infrastructure request secrets through that service.

Key rotation is explicit: a new key becomes active for writes; existing credentials/secrets can be re-encrypted through a controlled durable job while old key versions remain available for reads until rotation completes.

Why not PostgreSQL `pgcrypto`: Loxep ultimately has to present plaintext credentials to external APIs. Keeping encryption/key handling at the application boundary gives self-hosted deployments a clearer secret-management and rotation story.

## 2. Authentication and authorization ownership

**Decision:** Better Auth owns authentication, sessions, login-provider state, and deployment-level roles. The initial product-access model is installation-wide rather than fine-grained.

Use Better Auth's current Admin/access-control capabilities for:

- `admin` — ordinary product access plus installation/security/administrative operations that genuinely require elevation;
- `member` — ordinary product access across the installation.

Do not create a parallel Loxep global-role table.

Phase 0 does **not** create `connection_users`, per-workspace ACLs, or per-economic-entity ACLs. Fine-grained resource authorization may be added later when a concrete shared-install workflow requires it.

Application users, provider accounts/connections, economic entities, workspaces, and accounting books are separate concepts. `created_by_user_id` records provenance/audit information and does not make a record private to its creator.

See ADR-0017.

## 3. Economic entities and accounting books

**Decision:** add minimal `economic_entities` during Phase 0, but keep accounting books separate and deferred until accounting implementation.

An economic entity is a tracked person, business, or operating identity whose activity Loxep may attribute. The concept intentionally includes things that are not separate legal persons, such as assumed names/DBAs or operating units beneath another entity.

A nullable parent relation can express those structures. Provider connections may carry nullable `economic_entity_id` when one account clearly belongs to one entity.

Economic entities are not tenants or permission containers.

They are also not ledgers/books. Multiple economic entities or operating identities may later participate in the same accounting book. That separation may be represented through chart-of-accounts structure or accounting dimensions rather than distinct books. Therefore Phase 0 must not add a required `accounting_book_id` to each economic entity.

When Accounting is implemented, introduce explicit book records and a book-to-entity relationship that reflects real accounting needs.

## 4. Monetary representation

**Decision:** use PostgreSQL fixed-precision `numeric`, never floating point and not one universal minor-unit integer representation.

Initial convention:

```text
amount       numeric(20,6)
currency     char(3)
```

Application code must not convert persisted money to JavaScript `number` for arithmetic. Drizzle should expose monetary numerics without precision loss and the domain layer should use a verified exact-decimal implementation.

Display/settlement rounding belongs to the currency/provider/accounting context rather than storage.

## 5. Timescale observation policy

**Decision:** create `marketplace_item_observations` as a Timescale hypertable from the first migration.

Initial physical policy:

- partition column `observed_at`;
- 7-day chunks as a starting point;
- recent chunks remain rowstore;
- use current Timescale columnstore features for older observations;
- initial columnstore policy target around 30 days;
- segment primarily by `marketplace_item_id` and order by `observed_at DESC` where supported;
- no automatic retention/deletion policy by default.

Exact migration syntax must be verified against the current supported Timescale release immediately before implementation.

## 6. Observation connection provenance

**Decision:** keep nullable `connection_id` on marketplace observations.

When an observation came from an authenticated provider connection, record it even when the listing itself is public. Account context can affect availability, shipping, location, provider behavior, and returned fields.

Canonical marketplace-item identity remains independent of connection identity and economic-entity identity.

## 7. Raw provider-object retention

**Decision:** treat source events and provider-object snapshots differently.

`source_events` are provenance/replay records and are retained by default unless the user explicitly configures an appropriate retention policy.

`provider_objects` are debugging/synchronization snapshots. Where history is useful, keep changed snapshots and deduplicate identical payloads by hash. High-frequency polling must not dump a full provider JSON response every minute when a narrow observation row already preserves the useful state.

## 8. Enum/state strategy

**Decision:** do not use PostgreSQL enum types for application/domain states initially.

Use text columns with application-owned TypeScript constants/unions. Add database `CHECK` constraints for stable closed sets where database enforcement materially helps.

Provider identifiers and intentionally extensible values remain text without a DB enum.

## 9. User/configuration audit model

**Decision:** use a separate append-oriented `audit_events` model for user-initiated and administrative changes.

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

Audit serialization must redact secrets and sensitive credential material.

`audit_events` is distinct from `source_events`: external provider provenance and Loxep user/admin changes are different concerns. System-generated domain events such as `restocked` remain in their owning domain.

## 10. Media and object storage

**Decision:** do not use PostgreSQL as the normal byte store for images, PDFs, receipts, attachments, product media, or other potentially large binary objects.

PostgreSQL stores stable identity, metadata, hashes, MIME type, size, relationships, and configured storage backend. Bytes go through a storage abstraction with at least:

- `local`: filesystem-backed zero-extra-service storage;
- `s3`: standard S3-compatible object storage.

RustFS is the initial recommended/tested self-hosted S3 companion. It remains a separate optional service and a conformance target rather than a domain dependency.

Storage backends are application records so local-to-S3 and S3-to-S3 migration can be represented. Migration is a product workflow: resumable copy, verification, metadata cutover only after verification, retry/reporting, and delayed explicit source cleanup.

## 11. Process and container topology

**Decision:** a worker runtime is an architectural capability, not a mandatory separate container.

Build one Loxep application image with:

```text
LOXEP_MODE=all
LOXEP_MODE=web
LOXEP_MODE=worker
```

`all` is the default initial self-hosted profile. Larger deployments can run the same image as independent web/worker services or hosts. Graphile Worker coordinates through PostgreSQL, so splitting workers later does not require a new queue architecture.

## 12. UI/dashboard starting point

**Decision:** use Kiranism's TanStack Start dashboard as Loxep's initial UI donor/reference rather than rebuilding common dashboard presentation infrastructure from scratch.

This is now implemented in `apps/web`:

```text
/dashboard/*    real Loxep dashboard workspace
/starter/*      preserved donor/reference workspace
```

The shared shell is workspace-aware and sidebar/Cmd+K navigation derive from the active workspace. Future major product surfaces are peer workspace roots rather than children of `/dashboard`.

Keep/adapt useful shell, themes, shadcn/Base UI, tables, forms, Recharts, DnD, notification, command, and application-state patterns. Replace donor authentication/backend/data assumptions on real product routes.

Zustand is retained as an available narrow UI-state tool under ADR-0011, not as a second server-state store. Recharts remains useful for ordinary charts; ECharts can be added when dense analytical views justify it.

## 13. External companion-resource links

**Decision:** establish generic external resource/link records early so integrations with knowledge, task, billing, backup, and other specialist platforms do not require provider-specific ID columns in every domain.

The foundation uses concepts equivalent to:

```text
external_resources
resource_links
```

Provider adapters may add richer operations, but Loxep records should be able to link to Outline/AFFiNE documents, Vikunja tasks/projects, GitHub issues, Invoice Ninja objects, and future systems through the same relationship model.

## 14. Runtime configuration and secret ownership

**Decision:** environment/mounted-secret configuration is for bootstrap/deployment facts; normal runtime/provider settings are database-backed and managed in-app.

Bootstrap configuration includes only values needed before PostgreSQL-backed administration or login can function: database connectivity, runtime mode, canonical auth origin, Better Auth secret, the external encryption root/keyring, at least one initial OIDC and/or SMTP magic-link path, first-admin/recovery information, and genuine deployment topology.

Normal configuration such as eBay/provider credentials, ntfy settings, storage selection/non-secret S3 settings, S3 credentials, monitor defaults, and later integration tokens belongs in PostgreSQL. Sensitive runtime values are encrypted through the credential/secret service.

This is formalized by ADR-0016 and [Configuration & Secrets](../configuration-and-secrets/).

## Resulting first-schema direction

These choices allow implementation to proceed with clear defaults around:

- Better Auth `admin`/`member` roles with installation-wide ordinary access;
- minimal economic-entity attribution distinct from users, connections, counterparties, and accounting books;
- database-backed runtime settings plus external bootstrap configuration;
- application-encrypted provider/runtime secrets and key rotation;
- exact money persistence;
- Timescale observation aging;
- provider/account provenance;
- raw-data retention;
- extensible state values;
- user/configuration auditing;
- local/S3 media storage and migration;
- simple vs split runtime deployment;
- workspace-aware donor UI adoption;
- generic companion-resource relationships.

Implementation work must verify the exact current APIs and supported syntax of PostgreSQL, TimescaleDB, Drizzle, Better Auth, Graphile Worker, TanStack Start, storage dependencies, and runtime dependencies immediately before pinning versions or writing migrations, per the project dependency/version policy.