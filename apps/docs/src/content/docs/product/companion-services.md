---
title: Companion Services and Recommended Stack
---

Loxep is intended to become a broad business-operations platform, but it should not delay useful capability by rebuilding mature specialist software prematurely.

The project distinguishes three relationships with external tools:

1. **First-class integrations** — Loxep exchanges structured data, health state, links, events, or actions with the external service.
2. **Recommended companions** — a well-suited tool that solves an adjacent problem and is documented as part of a practical deployment pattern.
3. **Implementation references** — projects whose ideas/workflows inform future Loxep-native functionality without becoming runtime dependencies.

Companion software remains independently deployed and independently licensed. Loxep's MIT license does not imply that every recommended companion is MIT-licensed.

Because companion projects evolve quickly, API/version/licensing claims must be reverified against current upstream sources before implementation or before publishing a version-specific deployment template.

## Knowledge, documentation, and notes

**Surveyed and designed in [Knowledge and Task Companion Integration Design](../../architecture/knowledge-tasks-integration-design/) (2026-08-13).** That page carries the verified license/API table for this whole category, the integration shape, and the milestones. Two of the dispositions below were changed by it — read it before acting on this section.

### Outline

**Role:** strong knowledge-base integration candidate.

Potential Loxep integration:

- attach an Outline document/collection to any supported Loxep entity;
- create documents from project/customer/product templates;
- surface backlinks from knowledge documents to operational records;
- synchronize selected metadata rather than copying document content into Loxep.

Outline remains independently deployed. Its current license/API behavior must be checked before implementation; Loxep should never treat an external companion's license as inherited from Loxep.

**QUALIFIED 2026-08-13 — the license/API check above was performed.** Outline's API is excellent and free in self-hosting: 113 documented endpoints, ~60 webhook event types, API keys plus OAuth 2.0 with scopes, and free OIDC. **But Outline is BUSL 1.1, not open source, until its 2030-07-13 change date to Apache-2.0.** Its Additional Use Grant permits a Loxep operator's own use outright and bars only reselling a "Document Service", so it remains a legitimate recommendation — it is simply not an open-source one. The [design page](../../architecture/knowledge-tasks-integration-design/#the-two-finalists-and-the-honest-trade-between-them) recommends **BookStack** (MIT, comparable API, no paid gating) as the first adapter and Outline as the co-supported alternative, and leaves the choice as an owner decision.

### BookStack

**Role:** recommended first knowledge-base adapter, added 2026-08-13.

BookStack was absent from this document until the [category survey](../../architecture/knowledge-tasks-integration-design/#category-a-survey-living-documentation-and-knowledge-platforms) found it has the best-documented API of any candidate — a self-documenting REST surface at `/api/docs` and `/api/docs.json` on every instance, ~50 webhook event types, and free OIDC/SAML/LDAP — under an unmodified MIT license with **no paid tier of any kind**. Its costs are honest: MySQL/MariaDB rather than PostgreSQL, no official container image, per-page editing rather than multiplayer co-editing, and a severe single-maintainer bus factor mitigated by the MIT license itself.

### AFFiNE

**Role:** evaluation candidate for users wanting a more open canvas/document-oriented workspace.

Potential value includes documents, whiteboards/canvas, tables, and knowledge-management workflows. A first-class adapter should wait for a stable supported external API rather than relying on undocumented internal endpoints.

**OVERTURNED 2026-08-13 — the wait described above has no end condition.** The disposition is left visible rather than deleted, because the reasoning that produced it was sound and only the facts were missing. Verified against upstream: AFFiNE's GraphQL API exposes document **metadata and permissions only** — `DocType` carries `id, title, summary, mode, public` and **no body field**, and `Query` has zero document-content fields. Document content is a Yjs CRDT synced over WebSocket, so there is no stable external API to wait for; writing a page programmatically means reimplementing a client. Separately, `packages/backend/server/LICENSE` is an **"AFFiNE Enterprise Edition License"** requiring a seat subscription for production use, so the server half is not open source even though the client is MIT. **AFFiNE is not a viable document-integration target** and should not be carried forward as a pending evaluation.

### Docmost, AppFlowy, SiYuan, Wiki.js, Alexandrie

Also surveyed and **not recommended today**, each for a specific verified reason — Docmost gates its API and all SSO behind an enterprise license; AppFlowy's free self-hosted tier is one user seat; SiYuan has no user model in Docker mode; Wiki.js's v3 rewrite has never shipped a release. **Alexandrie** (MIT, RustFS-native storage, the best storage-model fit of any candidate) is **watch-tier purely for want of API documentation** — its Go/Gin routes exist but no endpoint reference or OpenAPI spec is published anywhere, and its "Kanban boards" are a JSON blob on a document with no task entity, so it is not a task-management candidate. See the [survey table](../../architecture/knowledge-tasks-integration-design/#category-a-survey-living-documentation-and-knowledge-platforms) for citations.

### Generic external resources

Loxep should not require a bespoke schema change for each documentation or work-management provider. The foundation includes generic relationships:

```text
external_resources
  id
  provider
  connection_id nullable
  external_type
  external_id nullable
  url
  title nullable
  metadata jsonb

resource_links
  external_resource_id
  resource_type
  resource_id
  purpose
```

Provider-specific adapters can add richer actions where APIs permit them.

Both tables shipped in Phase 0. The concrete `provider` / `external_type` / `resource_type` / `purpose` vocabulary for knowledge and task companions is fixed in the [integration design](../../architecture/knowledge-tasks-integration-design/#the-integration-shape), alongside the rule that `metadata` holds sync metadata only and never a copy of a document body or task description.

## Task and project management

**Surveyed and designed in [Knowledge and Task Companion Integration Design](../../architecture/knowledge-tasks-integration-design/) (2026-08-13).** Vikunja's disposition below is **confirmed** by that survey; the page adds the verified license/API comparison against Planka, OpenProject, Leantime, Taiga, and Focalboard, plus the integration shape and milestones.

### Vikunja

**Role:** recommended early task-management companion and strong first integration candidate.

Vikunja is a practical way to gain mature task/project capability before Loxep's native Projects/Tasks domains are complete.

Potential Loxep integration:

- link Loxep projects/customers/orders to Vikunja projects/tasks;
- create tasks from Loxep events or workflows;
- consume supported webhook/API updates for task completion/status;
- show related task counts/status in Loxep without duplicating the entire task model;
- provide a later migration/import path if native Loxep task management eventually supersedes it.

The integration boundary must preserve other task systems later rather than placing Vikunja-specific IDs throughout domain tables.

**CONFIRMED 2026-08-13, with one correction and one caveat.** The correction: `@loxep/work` now owns projects, time entries, billing rates, and the unbilled-work queue, so the framing above — Vikunja as a stand-in "before Loxep's native Projects/Tasks domains are complete" — understates the split. What Loxep genuinely lacks is the **task, kanban, assignee, and due-date layer**, and that is what Vikunja supplies. Verified: AGPL-3.0, an **OpenAPI 3.1** surface at `/api/v2/openapi.json`, HMAC-SHA256-signed webhooks with a documented event taxonomy, API tokens with per-route scoping, free multi-provider OIDC, and **two containers**. Vikunja's paid Pro tier gates exactly three things — the admin panel, **time tracking**, and audit logs — and time tracking is precisely the capability Loxep must own rather than delegate, so the free build loses nothing this integration wants. The caveat: Vikunja is effectively a one-maintainer project, which is an [open question](../../architecture/knowledge-tasks-integration-design/#open-questions) for the owner at the tier where a stored credential exists.

Also worth recording, because it constrains the bullet above: *"consume supported webhook/API updates"* needs an inbound webhook receiver — **IMPLEMENTED 2026-08-15** as the shared `/api/v1` surface [Phase 8](../../architecture/fleet-observability-design/#evidence-ingestion-if-it-ships) built (loxep-ovj.7). A Vikunja-specific normalizer against that same receiver is not built by this bullet and remains separate, smaller follow-up work.

### OpenProject

**Role:** documented alternative for operators wanting a full project-management suite, and the only surveyed tool where **one** documented API covers both a wiki and a work tracker.

GPL-3.0 with enterprise features gated at runtime — notably **SSO/SAML/OIDC**, which is a paid tier — and nine Compose services. It is the honest answer to "one companion instead of two" and is recorded as such rather than recommended, because it overlaps `@loxep/work`'s own projects far more than Vikunja does.

### Not recommended

**Planka** relicensed away from MIT to the non-OSI "PLANKA Community License 1.1", whose fair-use grant bars operating it as a hosted service for commercial gain. **Focalboard** is unmaintained — its README states so and it has moved to a community organization. **Leantime** offers only JSON-RPC with no machine-readable spec, and **Taiga** (MPL-2.0, and alive despite its reputation) is in caretaker mode with eight services including two RabbitMQ instances.

## Billing and customer-facing invoicing

### Invoice Ninja

**Role:** recommended companion and initial billing/delivery surface.

Loxep can own customers, projects, subscriptions, billable facts, and eventually accounting while Invoice Ninja provides mature invoice delivery, recurring billing, PDFs, payment links, reminders, and customer-facing workflows until replacing those capabilities is justified.

The long-term goal is not permanent dependency; it is to avoid blocking useful service/business functionality on rebuilding a mature invoicing product too early.

## Notifications

### ntfy

**Role:** first-class integration and initial default notification adapter.

Initial integration should focus on a user-supplied ntfy endpoint/topic/token. Loxep does not need to administer the ntfy server merely to publish useful notifications. Server-management capabilities can be added only if current supported APIs and real user needs justify them.

## Object storage

Loxep itself owns the storage abstraction, media metadata, and migration workflow. The object-storage implementation remains replaceable.

### RustFS

**Role:** initial recommended/tested self-hosted S3 companion.

The smallest Loxep deployment can use local filesystem storage with no object-storage service. When object storage is desired, official Loxep Compose examples should offer RustFS as an **optional separate service/profile** in the same stack.

```text
minimal:
  loxep
  postgres-timescale

with object storage:
  loxep
  postgres-timescale
  rustfs
```

RustFS is deliberately not embedded into the Loxep container. It has an independent storage/runtime/upgrade lifecycle, while the Compose project can still make the combined deployment simple to manage.

Loxep integrates through generic S3 semantics, not RustFS-specific object identity. Local -> RustFS and RustFS -> another S3 backend must not require domain-schema changes.

### Garage

**Role:** supported/recommended alternative for operators who value its distributed/multi-site self-hosting design.

Garage remains a useful future pivot because Loxep's contract is S3 compatibility. It is not the initial backend Loxep plans to test/document most heavily.

### SeaweedFS

**Role:** advanced alternative for users who need a broader distributed storage/filesystem platform.

SeaweedFS provides substantially more than Loxep needs for ordinary media storage. It may be attractive to operators who already want its wider storage, filesystem, replication, or tiering capabilities.

### Hosted/other S3-compatible storage

AWS S3, Cloudflare R2, Backblaze B2 S3, and other sufficiently compatible implementations should remain viable through the same `s3` driver. Provider-specific optimizations may be optional capability layers; they must not replace the portable baseline.

## Backup and recovery

Backup tooling is operational infrastructure, not a feature Loxep should reinvent.

### Databasus

**Role:** recommended PostgreSQL backup companion; strong candidate for first-class backup-health integration.

Loxep should provide a documented configuration/template for PostgreSQL/Timescale backups with retention and off-host storage appropriate to the deployment.

**IMPLEMENTED 2026-08-15 (Phase 8 milestone 7, loxep-ovj.7):** the inbound receiver this sketch names now exists — see [Fleet Observability Design](../../architecture/fleet-observability-design/#evidence-ingestion-if-it-ships) and the [Sending fleet alert evidence](../../guides/fleet-evidence-webhooks/) guide. What shipped is the "backup status / last successful evidence" half of the sketch below (a `POST` of `{status, message?, occurredAt?}` rolls into `integration_health`, `source: 'ingest'`); the "ntfy alert if stale" half — Loxep noticing a sender has gone quiet and raising its own alert about that silence — is explicitly NOT built yet, recorded as a scope boundary in the design doc's own implementation-status note.

A useful first integration is inbound backup-health reporting:

```text
Databasus success/failure webhook
            ↓
Loxep integration endpoint
            ↓
backup status / last successful evidence
            ↓
health dashboard + ntfy alert if stale
```

Loxep should not claim a backup is healthy merely because a schedule exists. Integration health should favor evidence of successful backups and, where available, restore verification.

### Backrest / restic

**Role:** recommended file/config/object-backup companion.

Use this class of tooling for Loxep's local media/configuration volumes and surrounding self-hosted infrastructure. Deployment guidance should distinguish:

- database-consistent PostgreSQL/Timescale backups;
- file/config/local-media backups;
- object-store backup/replication appropriate to the selected backend;
- off-host/off-site copies;
- restore testing.

## Infrastructure operations

Loxep documentation should eventually offer an opinionated but optional self-hosting toolkit rather than assuming users already know how to operate the surrounding infrastructure.

Initial recommended-tool categories include:

- **container/stack management:** Dockhand;
- **terminal/SSH access management:** TermixSSH;
- **host/container metrics:** Beszel;
- **uptime/endpoint monitoring:** Gatus;
- **private networking/VPN:** Tailscale;
- **notifications:** ntfy;
- **database backups:** Databasus;
- **file/config backups:** Backrest/restic;
- **object storage:** RustFS initially, with Garage/SeaweedFS/hosted S3 alternatives.

These recommendations should eventually have copyable templates and compatibility notes, but remain optional. Loxep must run using ordinary Docker/Compose and standard networking/storage primitives without requiring the surrounding toolkit.

## Integration health as a Loxep feature

A broader opportunity is to make external operational dependencies visible inside Loxep without trying to manage every application.

A generic integration-health model can eventually track health per **subject**, where a subject is whatever kind of record actually owns the integration — a provider connection, a notification endpoint, a storage backend, or an external resource. Not every health subject is a `connection`; an ntfy endpoint or S3 backend is configured through its own record with an application secret rather than a provider-connection lifecycle.

```text
integration_health
  subject_type          e.g. connection | notification_endpoint | storage_backend | external_resource
  subject_id
  checked_at
  status
  last_success_at
  last_failure_at
  detail
```

Examples:

- last successful eBay synchronization;
- last successful Databasus backup webhook;
- ntfy publish test;
- RustFS/S3 read-write health test;
- Invoice Ninja API connectivity;
- Vikunja API/webhook connectivity;
- linked documentation/task platform connectivity.

This turns the integrations page into a practical operational dashboard while keeping specialist applications independently deployable.

## Guiding rule

**Integrate mature specialist capability before rebuilding it, but keep Loxep's own domain model authoritative where the data is central to its long-term purpose.**

A companion service should accelerate Loxep rather than become an irreversible architectural dependency.
