---
title: System Overview
---

# Initial System Overview

This is the current directional architecture for the first implementation. ADRs remain authoritative where a later decision supersedes older prose.

```text
                    External providers
      eBay / Woo / Medusa / ntfy / OIDC / companions / ...
                           |
             +-------------+-------------+
             |                           |
             v                           v
       Webhooks/OAuth                 Polling/jobs
             |                           |
             +-------------+-------------+
                           |
                           v
                 Provider adapters
                           |
                           v
               Source events / objects
                           |
                           v
                   Domain services
             +-------------+-------------+
             |             |             |
             v             v             v
          Market        Commerce      Inventory      ...
             |             |             |
             +-------------+-------------+
                           |
                           v
                 Financial events
                           |
                           v
                    Accounting
                           |
                           v
                 Reports / tax views
```

## Default deployment shape

The smallest supported deployment is intentionally simple:

```text
+--------------------------------------------------+
|                    Loxep                         |
|                                                  |
| TanStack Start + React                           |
| Better Auth                                      |
| Graphile Worker                                  |
| provider adapters / domain services              |
| local media storage (default)                    |
|                                                  |
| LOXEP_MODE=all                                   |
+--------------------------+-----------------------+
                           |
                           v
                +---------------------+
                | PostgreSQL          |
                | + TimescaleDB       |
                |                     |
                | relational domains  |
                | observations        |
                | Graphile Worker     |
                +---------------------+
```

`LOXEP_MODE=all` means one Loxep container runs both interactive web work and background jobs. The implementation may run those as sibling Node processes or an equivalent clean lifecycle arrangement; the product requirement is one easy application container, not forcing all work onto one event loop.

## Optional object storage

The media abstraction supports both local filesystem storage and generic S3-compatible storage.

The initial recommended/tested self-hosted S3 companion is **RustFS**, deployed as a separate optional service in the same Compose project:

```text
loxep
postgres-timescale
rustfs              # optional S3 profile
```

Loxep stores stable media identity and metadata in PostgreSQL, while file bytes live in the configured storage backend. Local-to-S3 migration is a supported, resumable application workflow so a small deployment can grow without rewriting domain references.

RustFS is not an application dependency: Garage, SeaweedFS S3, hosted S3-compatible services, and other conforming implementations remain portable alternatives.

## Scale-out deployment

When actual load requires it, the same Loxep image can be split by runtime mode:

```text
loxep-web-1       LOXEP_MODE=web
loxep-web-2       LOXEP_MODE=web
loxep-worker-1    LOXEP_MODE=worker
loxep-worker-2    LOXEP_MODE=worker
postgres-timescale
shared S3-compatible storage
```

Graphile Worker coordinates through PostgreSQL, so worker processes may run on other servers without introducing Redis, Kafka, or a new queue architecture. Multi-host application deployments should use shared object storage rather than node-local media unless the filesystem is genuinely shared.

## Authentication and authorization

Better Auth owns:

- application users and sessions;
- OIDC and magic-link authentication;
- deployment-level roles such as `admin` and `member`.

Loxep owns business/resource authorization, such as which users may view or manage a particular eBay account, WooCommerce store, or other connection.

External provider identities remain distinct from application-login identities.

## UI foundation

The web application will use **Kiranism/tanstack-start-dashboard** as its initial dashboard/UI foundation and donor rather than beginning from a blank shell.

The useful presentation pieces—responsive shell, theme system, shadcn/Base UI composition, navigation, tables, forms, command palette, and application states—are adopted and adapted. Loxep does not inherit its demo backend, auth, data model, unnecessary dependencies, or architectural assumptions.

The official TanStack, shadcn, Better Auth, and other upstream documentation remains authoritative for current framework wiring and dependency versions.

## Expected technology direction

- TypeScript and ESM.
- Current supported Node.js LTS production runtime.
- Bun for package installation, lockfile, workspaces, and tooling where compatible.
- TanStack Start + React, with TanStack Router/Query/Table/Form where useful.
- shadcn/ui with Base UI/Tailwind and Loxep-owned component source.
- Kiranism TanStack Start dashboard as the initial UI shell/donor.
- PostgreSQL with TimescaleDB from the initial deployment.
- Drizzle as the typed SQL/application data layer, with first-class SQL where appropriate.
- Graphile Worker for durable background work.
- Better Auth with generic OIDC and magic links; no password login initially.
- Generic local/S3 media abstraction; RustFS is the initial recommended self-hosted S3 companion.
- Zod or equivalent schema validation at external boundaries.
- Pino structured logging.
- Apache ECharts is the preferred analytical-chart direction when Loxep outgrows starter/demo charting.
- ntfy as the first notification adapter.
- `ebay-api` as the initial eBay protocol/client dependency behind Loxep-owned adapters.

All dependency/runtime versions must be verified from current upstream sources before they are pinned, per the dependency and version policy.
