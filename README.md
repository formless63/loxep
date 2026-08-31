# Loxep

**Loxep** is an open-source, self-hosted platform for marketplace intelligence, multichannel commerce operations, services, inventory, billing, and financial visibility.

It starts with a practical first vertical slice: continuously observe eBay listings/watchlists, retain useful history, detect meaningful changes, and notify the user. The architecture is deliberately broad enough to grow into commerce, inventory, projects/services, billing, accounting, tax, documents/media, and operational integrations without turning into a collection of unrelated tools.

The name combines **loxodrome** and **ephemeris**: navigation and observation over time.

## Current implementation direction

The Phase 0 platform foundation is implemented: one Loxep image with `LOXEP_MODE=all|web|worker` runtime modes, explicit advisory-locked Drizzle migrations, Better Auth sign-in (magic links + generic OIDC, `admin`/`member` deployment roles, first-admin bootstrap and shell-level recovery), database-backed application settings with application-encrypted runtime secrets, the embedded Graphile Worker job runtime with database-controlled polling dispatch, local/S3 media storage behind one contract with resumable migration, monitoring/notification write-path foundations, structured logging and health probes, and the `/settings` administration workspace.

Phase 1 (eBay connections, watchlist/item monitors, TimescaleDB observations, change detection, ntfy delivery) and much of Phase 2 (persistent searches, seller monitoring, new-listing detection, opportunity scoring, the `/market` workspace) are implemented. Commerce ingestion now covers eBay, WooCommerce, and Medusa; the inventory, commerce, finance, and infrastructure workspaces also have substantial implemented workflows. Provider capabilities vary from fixture-tested adapters to live-verified reads, and most schema work after the foundation remains provisional. See the [Roadmap](apps/docs/src/content/docs/product/roadmap.md) and [Integration Status](apps/docs/src/content/docs/product/integrations-status.md) for the per-capability status of record.

The foundation follows this accepted direction:

- TanStack Start + React with TanStack Router/Query/Table/Form;
- Kiranism's TanStack Start dashboard integrated as the initial UI/theme/reference donor;
- eight peer workspaces for Dashboard, Market, Inventory, Commerce, Finance, Infrastructure, Settings, and the preserved Starter donor/reference routes;
- workspace-aware sidebar switching and Cmd+K navigation, with future major product areas added as peer route roots rather than children of `/dashboard`;
- shadcn/ui over Radix/Base UI primitives + Tailwind (donor components are mostly Radix today; standardization is incremental, per ADR-0015);
- Recharts, DnD, and narrowly-owned Zustand available for credible product/UI uses; ECharts when dense analytics justify it;
- Node.js current supported LTS runtime and Bun workspaces/tooling;
- PostgreSQL + TimescaleDB;
- Drizzle + first-class SQL;
- Graphile Worker for durable jobs;
- Better Auth with OIDC + magic links and no password login initially;
- Better Auth-owned `admin`/`member` deployment roles with installation-wide ordinary product access initially;
- economic-entity records for personal/business/operating attribution, separate from users, provider connections, workspaces, counterparties, and accounting books;
- database-backed normal runtime/application settings and application-encrypted provider/runtime secrets;
- bootstrap environment/mounted-secret configuration only for pre-database/pre-login/runtime-topology facts;
- local filesystem media by default with generic S3-compatible storage available from the same abstraction;
- RustFS as the initial recommended/tested optional self-hosted S3 companion;
- resumable local-to-S3 storage migration as a product feature;
- generic external-resource links for integrations with knowledge, task, billing, backup, and other companion systems.

The normal minimal deployment target is intentionally small:

```text
loxep
postgres-timescale
```

The same Loxep image supports `LOXEP_MODE=all|web|worker`, so workers can later scale independently without requiring a different application architecture. RustFS can be added as an optional separate service/profile when shared object storage is desired.

## Run with Docker

The default deployment is the repo-root Compose stack: Loxep (`LOXEP_MODE=all`) plus PostgreSQL/TimescaleDB. Application startup never migrates the schema; migrations are an explicit command executed inside the running Loxep container.

```bash
cp .env.example .env
# Generate real secrets (see .env.example comments):
head -c 32 /dev/urandom | base64    # -> keyring key inside LOXEP_KEYRING
head -c 32 /dev/urandom | base64    # -> LOXEP_AUTH_SECRET
docker compose up -d --build
docker compose exec loxep node bin/loxep.ts migrate
```

All configuration comes from the repo-root `.env`. Compose starts exactly two long-running services: PostgreSQL/TimescaleDB and Loxep. On a new or outdated database, Loxep starts but reports failed readiness with the pending-migration count; the `docker compose exec` command above applies migrations under an advisory lock, and readiness recovers without a restart. Re-run that command after any schema update. Follow the structured logs with `docker compose logs -f loxep`.

Loxep is then available at `http://localhost:3020` (readiness: `/health/ready`). Add the optional S3-compatible object-storage companion with `docker compose --profile rustfs up -d`. For scale-out, the same image runs `LOXEP_MODE=web` and `LOXEP_MODE=worker` replicas against the shared PostgreSQL, so background processing can scale independently of web traffic without any architectural change.

Provider connections are made **in the app**, not in Compose: `/settings/integrations` lists the integration catalog and installation-wide setup, while `/settings/connections` adds individual provider accounts and instances. Credentials are encrypted in PostgreSQL with the root key supplied outside the database. The [operator guides](apps/docs/src/content/docs/guides/index.md) cover every currently supported marketplace, store, billing, infrastructure, and fleet integration.

Note: the bundled database image is `timescale/timescaledb-ha:pg18.4-ts2.29.1-all` — TimescaleDB **Community** (Timescale License), deliberately chosen because Loxep's observation hypertable uses TSL-licensed columnstore capabilities — see [ADR-0002](apps/docs/src/content/docs/decisions/0002-postgresql-timescaledb.md). Self-hosting is fine under the TSL; offering TimescaleDB itself as a hosted database service is what the license restricts.

## Development quickstart

The Compose stack above is the normal way to run Loxep. `bun run dev` is the fast UI loop — a Vite dev server, web-only, on the same port 3020, so run one or the other.

```bash
bun install --frozen-lockfile

# Real PostgreSQL + TimescaleDB for development and package tests
# (timescale/timescaledb-ha:pg18.4-ts2.29.1-all, host port 5433; package
# integration tests create their own scratch databases here)
docker compose -f docker/compose.dev.yml up -d --wait
psql postgres://postgres:loxep-dev@localhost:5433/postgres -c 'CREATE DATABASE loxep'

# Bootstrap configuration for the dev server
cp apps/web/env.example.txt apps/web/.env
# then replace the keyring key and LOXEP_AUTH_SECRET placeholders with real
# values: head -c 32 /dev/urandom | base64

# Apply migrations — always explicit; application startup never migrates
node --env-file=apps/web/.env bin/loxep.ts migrate

bun run dev    # web dev server on http://localhost:3020
```

The dev server is web-only. When background jobs matter, run a worker alongside it from the same configuration (on a different health port):

```bash
LOXEP_PORT=3021 node --env-file=apps/web/.env bin/loxep.ts start --mode=worker
```

Checks:

```bash
bun run test:packages   # 4,000+ tests in the 32-package workspace; DB suites use real Postgres/TimescaleDB
bun run typecheck       # aggregate tsc across the workspace
bun run lint            # oxlint (apps/web)
bun run format:check    # oxfmt
bun run docs:build      # docs build + internal-link validation
```

The 32 workspace packages comprise 18 foundation/domain packages (`accounting`, `app`, `auth`, `commerce`, `config`, `counterparties`, `db`, `documents`, `domain`, `infrastructure`, `inventory`, `jobs`, `market`, `notifications`, `observability`, `runtime`, `storage`, and `work`) plus 14 provider adapters under `packages/integrations`. Database-backed tests use real PostgreSQL/TimescaleDB — never SQLite substitutes.

Browser e2e tests (Playwright, chromium) run against a **built** app plus a Mailpit SMTP sink; the harness — scratch database, environment, server start — is documented in [`apps/web/e2e/harness.md`](apps/web/e2e/harness.md) (`bun --cwd apps/web test:e2e`).

## Documentation

Public project documentation: **https://formless63.github.io/loxep/**

Source documentation lives in `apps/docs` and is currently published with Astro Starlight on GitHub Pages. The documentation renderer is intentionally replaceable; product architecture is not coupled to Starlight.

Useful starting points:

- [Vision](apps/docs/src/content/docs/overview/vision.md)
- [Guides](apps/docs/src/content/docs/guides/index.md) — operating Loxep and connecting supported providers
- [Master Domain Map](apps/docs/src/content/docs/product/master-domain-map.md)
- [Workspaces & Navigation](apps/docs/src/content/docs/product/workspaces.md)
- [Roadmap](apps/docs/src/content/docs/product/roadmap.md)
- [System Overview](apps/docs/src/content/docs/architecture/system-overview.md)
- [Domain Boundaries](apps/docs/src/content/docs/architecture/domain-boundaries.md)
- [Configuration & Secrets](apps/docs/src/content/docs/architecture/configuration-and-secrets.md)
- [Phase 0 Foundation](apps/docs/src/content/docs/architecture/phase-0-foundation.md)
- [Foundational Data Model](apps/docs/src/content/docs/architecture/foundational-data-model.md)
- [Foundation Schema](apps/docs/src/content/docs/architecture/foundation-schema.md)
- [Implementation Contract](apps/docs/src/content/docs/development/implementation-contract.md)
- [Frontend Standards](apps/docs/src/content/docs/development/frontend-standards.md)
- [Project Surfaces & Future Sites](apps/docs/src/content/docs/development/project-surfaces.md)
- [Companion Services](apps/docs/src/content/docs/product/companion-services.md)
- [Dependency & Version Policy](apps/docs/src/content/docs/development/dependency-policy.md)
- [Architecture Decision Records](apps/docs/src/content/docs/decisions/)

The Implementation Contract is the short load-bearing guide intended for contributors and coding agents; accepted ADRs and current architecture documents remain authoritative where deeper detail is needed.

## Dependency freshness

Before adding or pinning a runtime, framework, library, container image, or GitHub Action, verify the newest viable current upstream release. Starter templates and remembered/model-training versions are not authoritative. Loxep uses reproducible pins/lockfiles plus automated update tooling rather than either stale pins or floating `latest` dependencies.

## License

MIT
