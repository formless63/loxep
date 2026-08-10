---
title: Companion Services and Recommended Stack
---

# Companion Services and Recommended Stack

Loxep is intended to become a broad business-operations platform, but it should not delay useful capability by rebuilding mature specialist software prematurely.

The project therefore distinguishes three relationships with external self-hosted tools:

1. **First-class integrations** — Loxep exchanges structured data, health state, links, events, or actions with the external service.
2. **Recommended companions** — a well-suited tool that solves an adjacent problem and is documented as part of a practical deployment pattern.
3. **Optional implementation references** — projects whose ideas or workflows inform future Loxep-native functionality without being runtime dependencies.

Companion software remains independently deployed and independently licensed. Loxep's MIT license does not imply that every recommended companion is MIT-licensed.

## Knowledge, documentation, and notes

### Outline

**Role:** recommended knowledge-base integration candidate.

Outline has a broad authenticated API that exposes the same application capabilities used by its own frontend. That makes it attractive for linking Loxep customers, projects, products, procedures, and other records to canonical documentation or for creating/updating documents through automation.

Outline is currently BSL 1.1, not OSI open source. It can still be supported as an independent external integration; Loxep should not bundle or redistribute Outline as though it were an MIT component.

Potential Loxep integration:

- attach an Outline document/collection URL to any supported Loxep entity;
- create a document from a project/customer/product template;
- surface backlinks from Loxep to relevant operational records;
- optionally synchronize selected metadata rather than copying document content into Loxep.

### AFFiNE

**Role:** recommended evaluation candidate for users wanting a more open, canvas/document-oriented workspace.

AFFiNE Community Edition is MIT-licensed and combines documents, whiteboards/canvas, tables, and knowledge-management concepts. Integration should wait on a stable, supported API surface rather than relying on internal implementation endpoints.

### Generic external resources

Loxep should not require a bespoke schema change for each documentation provider. A generic external-resource relationship can eventually support URLs/references such as:

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

Provider-specific adapters can then add richer actions where APIs permit them.

## Task and project management

### Vikunja

**Role:** recommended early task-management companion and strong first integration candidate.

Vikunja is self-hostable and AGPL-licensed. Its current v2 API uses standard REST semantics and publishes an OpenAPI 3.1 specification; it also supports webhooks, API tokens, OIDC, and a single deployable container.

This makes it a practical way to gain mature task/project capability before Loxep's native Projects/Tasks domains are complete.

Potential Loxep integration:

- link Loxep projects/customers/orders to Vikunja projects/tasks;
- create tasks from Loxep events or workflows;
- consume webhook updates for task completion/status;
- show related task counts/status in Loxep without duplicating the entire task model;
- provide a later migration/import path if native Loxep task management eventually supersedes it.

The integration boundary should preserve the option for other task systems later rather than making Vikunja IDs first-class columns throughout Loxep.

## Billing and customer-facing invoicing

### Invoice Ninja

**Role:** recommended companion and initial billing/delivery surface.

Loxep can own customers, projects, subscriptions, billable facts, and eventually accounting while Invoice Ninja continues to provide mature invoice delivery, recurring billing, PDFs, payment links, reminders, and customer-facing workflows until replacing those capabilities is justified.

The long-term goal is not to make Loxep permanently dependent on Invoice Ninja, but to avoid blocking useful service/business functionality on rebuilding a mature invoicing product.

## Notifications

### ntfy

**Role:** first-class integration.

ntfy's HTTP publish API makes it a natural default notification provider for Loxep. Self-hosted ntfy also exposes subscription APIs and access-control capabilities.

Initial integration should focus on a user-supplied ntfy endpoint/topic/token rather than requiring Loxep to administer the ntfy server. Server-management capabilities can be added later if a stable API and real user need justify them.

## Object storage

### Garage

**Role:** recommended S3-compatible self-hosted storage companion.

Garage is an S3-compatible, lightweight object store designed for small-to-medium self-hosted deployments and is licensed AGPLv3.

Loxep should integrate through standard S3 semantics rather than a Garage-specific API. This preserves compatibility with AWS S3, Cloudflare R2, Backblaze B2 S3, and other S3-compatible implementations.

The smallest Loxep deployment can use local filesystem media storage; Garage becomes a recommended profile once shared/durable object storage is desirable.

## Backup and recovery

Backup tooling is operational infrastructure, not a feature Loxep should reinvent.

### Databasus

**Role:** recommended PostgreSQL backup companion; candidate for first-class backup-health integration.

Databasus supports PostgreSQL backups, GFS retention, multiple storage targets, encryption, restore-oriented features, and webhook notifications. Loxep should provide a documented configuration/template for backing up its PostgreSQL/Timescale database.

A useful first integration is inbound backup-health reporting:

```text
Databasus success/failure webhook
            ↓
Loxep integration endpoint
            ↓
backup status / last verified backup
            ↓
health dashboard + ntfy alert if stale
```

Loxep should not claim a backup is healthy merely because a schedule exists; integrations should favor evidence of successful and ideally verified backups/restores.

### Backrest / restic

**Role:** recommended file/object-configuration backup companion.

Backrest provides a web UI and orchestration layer over restic, including scheduling, repository maintenance, snapshot browsing/restores, hooks, and many storage backends.

It is appropriate for protecting Loxep media/configuration volumes and other self-hosted infrastructure outside the PostgreSQL database.

A deployment guide should distinguish:

- database-consistent PostgreSQL/Timescale backups (Databasus or equivalent);
- file/object/config backups (restic/Backrest or equivalent);
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
- **file/config backups:** Backrest/restic.

These recommendations should have copyable examples and compatibility notes, but remain optional. Loxep should run using ordinary Docker/Compose and standard networking/storage primitives without requiring any of them.

## Integration health as a Loxep feature

A broader opportunity is to make external operational dependencies visible inside Loxep without trying to manage every application.

A generic integration-health model can eventually track:

```text
integration_health
  connection_id
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
- object-storage read/write test;
- Invoice Ninja API connectivity;
- Vikunja API/webhook connectivity.

This turns the integrations page into a practical operational dashboard while keeping the specialist applications independently deployable.

# Guiding rule

**Integrate mature specialist capability before rebuilding it, but keep Loxep's own domain model authoritative where the data is central to its long-term purpose.**

A companion service should accelerate Loxep rather than become an irreversible architectural dependency.
