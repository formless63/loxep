---
title: System Overview
---

This is the current directional architecture for the first implementation. ADRs remain authoritative where a later decision supersedes older prose, and the [Implementation Contract](../development/implementation-contract/) collects the constraints most likely to matter during coding work.

## Operational flow

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
                 Financial/economic facts
                           |
                           v
                    Accounting
                           |
                           v
                 Reports / tax views
```

The ledger is downstream of operational truth. Provider payloads, orders, purchases, inventory movements, shipping facts, project work, payments, and other source facts must not disappear merely because an accounting interpretation exists.

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
                | settings/secrets    |
                | Graphile Worker     |
                +---------------------+
```

`LOXEP_MODE=all` means one Loxep container provides interactive web and background-worker capability. The implementation may use sibling Node processes or another clean lifecycle arrangement; the product requirement is one easy default application container, not forcing every task onto one event loop.

## Optional object storage

The media abstraction supports local filesystem storage and generic S3-compatible storage.

The initial recommended/tested self-hosted S3 companion is **RustFS**, deployed as a separate optional service in the same Compose project:

```text
loxep
postgres-timescale
rustfs              # optional S3 profile
```

Loxep stores stable media identity and metadata in PostgreSQL while file bytes live in the configured storage backend. Storage backends are application records, so a deployment can migrate from local storage to S3 or between S3-compatible destinations without changing domain references.

Local-to-S3 migration is a supported, resumable application workflow. RustFS is not an application dependency: Garage, SeaweedFS S3, hosted S3-compatible services, and other conforming implementations remain portable alternatives.

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

Graphile Worker coordinates through PostgreSQL, so worker processes may run on other servers without introducing Redis, Kafka, or a second queue architecture. Multi-host application deployments should use shared object storage rather than node-local media unless the filesystem is genuinely shared.

## Application workspaces

The web application already uses a workspace-aware shell rather than placing every feature beneath `/dashboard`.

Current route roots:

```text
/dashboard/*    real Loxep dashboard workspace
/starter/*      preserved donor/reference workspace
```

The shared shell owns the workspace switcher, sidebar frame, header, command palette, theme controls, and account controls. The active workspace supplies its navigation tree. Sidebar navigation and Cmd+K therefore follow the same active-workspace configuration.

Future major product surfaces are peer route roots such as `/market`, `/commerce`, `/inventory`, `/projects`, `/finance`, and `/settings`. Workspaces are UX/navigation boundaries, **not** backend/domain ownership boundaries. See [Workspaces & Navigation](../product/workspaces/).

## Authentication and authorization

Better Auth owns:

- application users and sessions;
- OIDC and magic-link authentication;
- deployment-level roles such as `admin` and `member`.

Loxep owns business/resource authorization, such as which users may view or manage a particular eBay account, WooCommerce store, or other connection.

External provider identities remain distinct from application-login identities. Future legal/economic entity ownership also remains a separate concern rather than being inferred from either users or provider connections.

## Configuration and secrets

Loxep uses a bootstrap/runtime split rather than treating environment variables as the normal administration interface.

Bootstrap configuration contains only facts needed before the application can read PostgreSQL-backed settings or authenticate an administrator: database connectivity, runtime mode, canonical auth origin, Better Auth secret, the external encryption root/keyring, and at least one viable initial OIDC and/or SMTP magic-link login path.

Normal application/provider configuration is stored in PostgreSQL and managed in-app. Runtime secrets such as eBay credentials, ntfy tokens, S3 keys, and future integration credentials are encrypted in PostgreSQL by Loxep's credential/secret service. The root encryption key remains external.

See [Configuration & Secrets](./configuration-and-secrets/) and ADR-0016.

## UI foundation and state ownership

The Kiranism TanStack Start dashboard is now integrated as a UI donor/reference, not merely planned. Useful responsive layout, theme, shadcn/Base UI, table/form, chart, DnD, notification, and command patterns remain available under `/starter` while Loxep product routes evolve independently.

Current frontend state ownership:

```text
PostgreSQL        durable product state and durable user preferences
TanStack Query    server/cache state
Router            URL/navigation state
TanStack Form     form state
React             local component state
Zustand           cross-component ephemeral/editing UI state when useful
```

Recharts remains appropriate for ordinary dashboard/business charts. Apache ECharts may be added for denser time-series/analytical interfaces rather than replacing Recharts universally.

## Expected technology direction

- TypeScript and ESM.
- Current supported Node.js LTS production runtime selected by repository tooling.
- Bun for package installation, lockfile, workspaces, and tooling where compatible.
- TanStack Start + React, with TanStack Router/Query/Table/Form where useful.
- shadcn/ui with Base UI/Tailwind and Loxep-owned component source.
- Kiranism TanStack Start dashboard as the initial UI donor/reference.
- PostgreSQL with TimescaleDB from the initial deployment.
- Drizzle as the typed SQL/application data layer, with first-class SQL where appropriate.
- Graphile Worker for durable background work.
- Better Auth with generic OIDC and magic links; no password login initially.
- Database-backed runtime settings and application-encrypted runtime secrets.
- Generic local/S3 media abstraction; RustFS as the initial recommended self-hosted S3 companion.
- Zod or equivalent schema validation at external boundaries.
- Pino structured logging.
- Recharts for ordinary dashboard charts; ECharts when dense analytics justify it.
- DnD Kit for interaction patterns that need ordering/dragging.
- Zustand for narrowly-owned cross-component UI/editing state.
- ntfy as the first notification adapter.
- `ebay-api` as the initial eBay protocol/client dependency behind Loxep-owned adapters.

All dependency/runtime versions must be verified from current upstream sources before they are pinned, per the dependency and version policy.
