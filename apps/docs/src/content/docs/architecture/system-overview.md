---
title: System Overview
---

# Initial System Overview

This is a directional architecture, not a frozen implementation specification.

```text
                    External providers
          eBay / Woo / Medusa / ntfy / OIDC / ...
                           |
             +-------------+-------------+
             |                           |
             v                           v
       Webhooks/OAuth                 Worker polling
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

## Initial deployment shape

```text
+----------------------+       +----------------------+
|      Loxep Web       |       |     Loxep Worker     |
|                      |       |                      |
| TanStack Start       |       | Graphile Worker      |
| React                |       | provider polling     |
| Better Auth          |       | ingestion            |
| internal server fns  |       | event processing     |
| HTTP API             |       | notifications        |
+----------+-----------+       +----------+-----------+
           |                              |
           +---------------+--------------+
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

A service being a separate process does not automatically make it a separate domain or microservice. The worker is isolated because background execution has different lifecycle and scaling characteristics from HTTP/UI work while still sharing the same domain packages and database.

## Expected technology direction

- TypeScript and ESM.
- Bun for package/workspace tooling where compatible.
- Node.js LTS runtime where required by core dependencies such as Graphile Worker.
- TanStack Start + React for the web application.
- shadcn/ui using contemporary headless primitives and Tailwind for application UI.
- PostgreSQL with TimescaleDB from the initial deployment.
- Drizzle as the typed SQL/application data layer, with first-class SQL for analytical/database-native work.
- Graphile Worker for durable background work.
- Better Auth with generic OIDC and magic links; no password-based authentication as an initial requirement.
- Zod or equivalent schema validation at external boundaries.
- Pino structured logging.
- Apache ECharts for analytical visualization.
- ntfy as the first notification adapter.
- `ebay-api` as the initial eBay protocol/client dependency behind Loxep-owned adapters.

Technology choices should receive ADRs before they become difficult to reverse.
