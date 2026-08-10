---
title: Implementation Contract
---

This page is the short list of **load-bearing implementation constraints** for contributors and coding agents. It exists so a technically reasonable implementation does not accidentally contradict decisions already made elsewhere in the documentation.

When implementation work changes one of these rules, update the relevant architecture documentation and create/supersede an ADR rather than silently drifting.

## Source-of-truth order

When documents or examples appear to disagree, use this order:

1. accepted/superseding ADRs;
2. current architecture documents;
3. this implementation contract;
4. product/domain maps and roadmap;
5. existing implementation where it is clearly intentional;
6. starter/demo code;
7. remembered framework behavior or model training knowledge.

Current upstream documentation wins over remembered APIs. Dependency versions in examples or starter repositories are never authoritative.

## Current repository baseline

The repository is a Bun workspace with:

```text
apps/web      TanStack Start application
apps/docs     Astro Starlight documentation
```

The UI donor has already been integrated. Do not restart from a blank TanStack app or re-copy the donor over Loxep.

Current workspace shell:

```text
/dashboard/*    Loxep product workspace
/starter/*      preserved donor/reference workspace
```

The sidebar and Cmd+K command palette derive navigation from the active workspace configuration. Future major product workspaces are peers of `/dashboard`; see [Workspaces & Navigation](../product/workspaces/).

## Architecture shape

Loxep is a **modular monolith**, not a microservice system.

Default deployment:

```text
loxep                LOXEP_MODE=all; web + worker capability
postgres-timescale   PostgreSQL + TimescaleDB
rustfs               optional S3-compatible companion
```

The same Loxep image must support:

```text
LOXEP_MODE=all
LOXEP_MODE=web
LOXEP_MODE=worker
```

Do not introduce Redis, Kafka, BullMQ, pg-boss, or another queue/cache merely because workers exist. Graphile Worker and PostgreSQL are the accepted durable-job foundation.

## Runtime and package tooling

- Production/runtime target: Node.js on the current supported LTS line selected by repository tooling.
- Package manager/workspaces/scripts: Bun.
- TypeScript + ESM.
- Exact/reproducible dependency pins and lockfile.
- Before adding or changing a dependency/runtime/container/GitHub Action, verify the **current newest viable upstream release and compatibility**.
- Starter package ranges and remembered versions are not authoritative.

Do not float production dependencies on `latest`.

## Frontend foundation

Accepted stack:

- TanStack Start + React;
- TanStack Router;
- TanStack Query;
- TanStack Table;
- TanStack Form;
- Zod at validation boundaries;
- shadcn/ui + Base UI + Tailwind;
- Lucide/icons already represented by the donor where appropriate.

The Kiranism dashboard is a presentation donor, not the domain architecture.

### Preserve useful donor capability

Do not remove dependencies/features merely to minimize package count when they have credible product use.

In particular, the current direction permits retaining:

- **Recharts** for ordinary dashboard/business charts;
- **DnD Kit** for configurable dashboards, Kanban/orderable interfaces, media ordering, and similar interactions;
- **Zustand** for genuine cross-component ephemeral/workspace UI state.

Apache ECharts remains a good option for dense time-series/analytical views when Recharts becomes limiting. It is not necessary to replace every Recharts chart with ECharts.

### State ownership

Classify state before adding it to Zustand:

```text
PostgreSQL        durable product state and durable user preferences
TanStack Query    server/cache state
Router            URL/navigation state
TanStack Form     form state
React             local component state
Zustand           cross-component ephemeral/editing UI state when useful
```

For user-customizable dashboards/tables/charts, Zustand may own the immediate editing experience while PostgreSQL owns preferences that should survive browsers/devices.

Do not duplicate server data into a global Zustand store.

## Workspace UX is not domain ownership

A workspace is a navigation surface. A backend domain is an ownership boundary.

For example, the future Finance workspace may compose Billing, Payments, Banking, Accounting, Tax, and Reporting domains without those domains becoming one table/module.

Do not create database schemas or package boundaries solely to mirror sidebar workspaces.

## Authentication and authorization

Use Better Auth for:

- application users/sessions;
- OIDC and magic-link authentication;
- deployment-level roles such as `admin` and `member`.

Password login is disabled initially.

Loxep owns resource/domain authorization such as per-connection `owner/manage/view` access.

Do not equate:

- application user;
- eBay/Woo/other provider account;
- provider connection;
- future legal/economic entity ownership.

Loxep is not designed around classic SaaS multi-tenancy. Do not introduce an organization/workspace tenant hierarchy as a default architecture.

## Configuration and secrets

Follow [Configuration & Secrets](../architecture/configuration-and-secrets/).

The default policy is:

- environment/mounted secrets only for bootstrap/deployment facts needed before DB-backed config or login is possible;
- normal settings configured in-app and stored in PostgreSQL;
- normal runtime/provider secrets encrypted in PostgreSQL using the Loxep secret/credential service;
- external root encryption key/keyring remains outside PostgreSQL;
- eBay and other provider connections are created/managed in the application, not encoded as Compose environment variables.

Never put plaintext credentials into logs, source events, job payloads, audit snapshots, or general JSON configuration.

## Database and schema

- PostgreSQL is the system of record.
- TimescaleDB is enabled from the first migration/deployment.
- Drizzle is the typed application data layer; first-class SQL is encouraged where PostgreSQL/Timescale capabilities require it.
- Do not substitute SQLite or an in-memory database for integration tests that need PostgreSQL semantics.
- Money uses fixed-precision PostgreSQL `numeric`; do not do persisted monetary arithmetic with JavaScript `number`.
- Application/domain state uses text + TypeScript unions/constants, with DB checks where useful; avoid PostgreSQL enums initially.

Phase 0 should create only foundation tables required by early vertical slices. Do not eagerly create the full future commerce/accounting/project schema because the domain map describes it.

### Time-series observations

`marketplace_item_observations` is a Timescale hypertable from the beginning.

Initial physical direction:

- time column: `observed_at`;
- 7-day chunks as a starting point;
- recent rowstore data;
- current Timescale Hypercore/columnstore features for older observations;
- initial columnstore policy around 30 days;
- no automatic deletion/retention by default.

Verify current Timescale migration syntax at implementation time.

## Provider ingestion

Provider SDK/API shapes stop at the integration boundary.

The general pipeline is:

```text
provider
   |
   v
raw source event/object
   |
   v
normalization / adapter
   |
   v
Loxep domain services
   +--> market
   +--> commerce
   +--> inventory
   +--> financial facts
   +--> notifications / analytics
```

Retain enough provider evidence for replay/debugging without writing full heavyweight JSON snapshots every minute when a narrow observation row already captures the useful state.

Use maintained provider libraries where they fit, behind Loxep-owned adapters. The initial eBay direction is `ebay-api`, not provider types leaking through the application.

## Background work

Graphile Worker is the durable queue/job system.

Use it for:

- polling dispatch;
- provider synchronization;
- normalization/processing;
- notification delivery;
- storage migrations;
- retries/backoff;
- maintenance work.

Do **not** create one permanent cron schedule per monitored item. Store scheduling state in the database (`interval`, `next_poll_at`, priority, backoff/error state) and have a small number of recurring dispatcher jobs enqueue work for due targets.

Jobs are at-least-once. Handlers must be idempotent or otherwise safe to retry.

## Media and storage

PostgreSQL owns media identity/metadata/relationships, not ordinary binary payloads.

Supported storage contract:

- `local` filesystem driver for zero-extra-service deployments;
- generic `s3` driver;
- RustFS as the initial recommended/tested optional self-hosted S3 companion.

Do not write RustFS-specific assumptions into domain models. Garage, SeaweedFS S3, hosted S3, or other compatible implementations must remain possible.

Local-to-S3 migration is a supported resumable application workflow with verification before metadata cutover.

## Operational facts before accounting

Preserve this direction:

```text
operational/source facts
         |
         v
normalized economic facts
         |
         v
accounting/posting rules
         |
         v
ledger
         |
         v
financial/tax reporting
```

The ledger is downstream of reality. Do not make journal entries the only surviving representation of orders, purchases, shipping, inventory movement, payments, project work, or other source facts.

## Economic/legal entity ownership

The eventual accounting/book owner of transactions is important because one deployment may represent personal and business activity. The exact economic/legal-entity model is intentionally not yet expanded into the Phase 0 schema.

Until that decision is finalized:

- do not weld ownership to application users;
- do not infer ownership solely from a provider connection;
- do not introduce a SaaS tenant model as a substitute;
- keep stable references and schema choices flexible enough to add explicit economic-entity ownership before broad commerce/accounting implementation.

This becomes a required design decision before financial/commerce schemas expand materially.

## Notifications

ntfy is the first notification adapter, but event detection and notification delivery remain separate concepts. A detected `RESTOCKED` event should not be coupled directly to one notification transport.

## External API

Framework-native server functions are appropriate inside the Loxep web application. They must not become the only integration boundary.

Design for a stable `/api/v1` HTTP/OpenAPI surface as external integration needs arrive. Do not introduce tRPC as the sole public integration model.

## Testing and quality gates

Foundation work should establish:

- unit tests where useful;
- real PostgreSQL/Timescale integration tests;
- Graphile Worker integration tests;
- storage conformance tests for local and S3 drivers;
- Playwright for critical browser flows;
- type/lint/format/build checks;
- application and docs builds in CI.

Do not report a task complete while known build/type/test failures caused by the change remain unresolved.

## Documentation discipline

Architecture changes are incomplete until documentation is updated.

For Starlight pages:

- frontmatter `title` is the page H1;
- do not repeat it with a Markdown `#` heading;
- use `##` and below in content;
- keep broad architecture/product docs synchronized when an ADR changes a previous assumption.

When an implementation discovers a real conflict with these rules, surface it explicitly. Do not quietly choose the easiest framework default and make the documentation false afterward.
