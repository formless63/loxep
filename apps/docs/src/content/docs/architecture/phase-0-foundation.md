---
title: Phase 0 Foundation Specification
---

# Phase 0 Foundation Specification

Phase 0 creates the smallest credible platform on which Phase 1 can be built without committing future domains to accidental framework choices.

## Target repository shape

```text
loxep/
├── apps/
│   ├── app/                  # TanStack Start + runtime entrypoints
│   └── docs/                 # Astro Starlight
├── packages/
│   ├── auth/                 # Better Auth config + domain auth helpers
│   ├── config/               # typed environment/configuration
│   ├── db/                   # Drizzle schema, migrations, database client
│   ├── domain/               # shared domain primitives/contracts
│   ├── integrations/         # provider adapter modules/packages
│   ├── jobs/                 # Graphile task definitions/contracts/helpers
│   ├── storage/              # local + S3 media abstraction/migration
│   └── observability/        # logging/telemetry conventions
├── docker/
├── compose.yml
├── package.json
├── bun.lock
└── tsconfig.base.json
```

The exact package split may evolve during scaffolding. Do not create a package for every future domain before code exists; split packages only when they create a real dependency or ownership boundary.

`apps/app` should be seeded from Kiranism's TanStack Start dashboard where useful rather than generated as a visually blank application.

## Foundation capabilities

### Current-version verification

Before copying package manifests or pinning dependencies:

- verify current viable versions from upstream sources;
- treat starter/example versions as non-authoritative;
- pin reproducibly with Bun's lockfile;
- keep Renovate/CI responsible for surfacing updates.

### UI/application shell

Adopt and adapt from `Kiranism/tanstack-start-dashboard`:

- responsive dashboard shell;
- navigation/sidebar/header patterns;
- multi-theme/tweakcn theme system;
- shadcn/Base UI component composition;
- TanStack Router/Query/Table/Form patterns;
- command palette and useful application-state patterns.

Replace or remove:

- demo/mock entities;
- starter auth/backend assumptions;
- unnecessary dependencies/features;
- general Zustand usage where Router/Query/Form/local React state is sufficient;
- starter charting where ECharts better fits Loxep analytics.

### Configuration

- Typed environment parsing and startup validation.
- No business-specific defaults.
- Secrets never stored in repository configuration.
- File-backed/Docker-secret style inputs should be supportable without redesign.
- Runtime mode is explicit: `LOXEP_MODE=all|web|worker`.
- Storage backend configuration is explicit and provider-neutral.

### Database

- PostgreSQL + TimescaleDB supported development image.
- Drizzle migration workflow.
- UUID strategy and timestamp conventions established.
- Timescale extension enabled by migration/bootstrap.
- Initial tables limited to foundation/auth/connections/events/monitoring/media/external-resource links needed for early vertical slices.
- No speculative accounting/commerce tables in Phase 0.

### Jobs

- Graphile Worker can start as part of the default Loxep container and independently under `LOXEP_MODE=worker`.
- Typed task-name/payload conventions.
- Job-key/idempotency conventions.
- Retry/backoff policy documented.
- Health visibility for failed/stale jobs.
- One example/no-op or maintenance task proving the runtime path.

The default deployment does **not** require a separate worker container. The same image must support later worker-only replicas on other hosts.

### Authentication and authorization

- Better Auth integration.
- Generic OIDC configuration with Pocket ID documented/tested.
- Magic-link provider interface/configuration.
- Password login disabled.
- Better Auth Admin/access-control capabilities own deployment-level roles such as `admin` and `member`.
- First-admin bootstrap and recovery path designed.
- Application user and provider connection identities remain separate.
- Loxep relations own resource-specific authorization, such as connection `owner/manage/view` permissions.

### Connections and credentials

Initial generic connection records represent configured external accounts/stores/services without pretending all providers share the same settings.

Credentials are encrypted in the application layer using the current foundational decision: AES-256-GCM with an externally supplied/versioned root key. Provider-specific non-secret metadata may be JSON where schema diversity is legitimate; frequently queried canonical fields remain relational.

### Source events and raw provider objects

Establish conventions before eBay ingestion begins:

- provider/source identity;
- external object/event ID where available;
- received/observed/occurred timestamps;
- payload hash;
- retained raw JSON payload where useful;
- processing state/version;
- idempotent uniqueness rules.

Not every polling response must become a heavyweight domain event. Source retention should serve replay/debugging/audit needs without duplicating high-frequency observation storage unnecessarily.

### Media and object storage

- PostgreSQL stores media metadata/relationships, not ordinary binary payloads.
- `local` filesystem storage is supported with no extra service.
- generic `s3` storage is supported behind the same application contract.
- RustFS is the initial recommended/tested self-hosted S3 companion.
- RustFS remains a separate service/container, optionally launched from the same Loxep Compose project/profile.
- local-to-S3 migration is resumable/idempotent and verifies objects before metadata cutover.
- multi-host Loxep deployments warn when node-local media is configured without known shared storage.

### External companion resources

Create the generic foundation needed to link Loxep records to external specialist applications without provider-specific columns throughout the schema:

```text
external_resources
resource_links
```

This can later represent Outline documents, AFFiNE pages, Vikunja projects/tasks, GitHub issues, Invoice Ninja records, and similar external objects.

### Observability

- Structured logging with Pino.
- Request/job correlation IDs.
- Provider/account context in logs without leaking secrets/tokens.
- `/health` and readiness behavior.
- Database/job/storage/integration health visibility.
- OpenTelemetry is deferred until there is a concrete collector/use case.

### Testing

- Unit test convention.
- Database integration tests against real PostgreSQL/TimescaleDB, not an incompatible in-memory substitute.
- Worker integration test path.
- Storage conformance tests run against both `local` and a generic S3-compatible target.
- Playwright for critical browser flows once UI flows exist.

### Deployment

Default supported self-host shape:

```text
loxep     -> web + Graphile Worker runtime(s), LOXEP_MODE=all
postgres  -> PostgreSQL + TimescaleDB
```

Optional object-storage profile:

```text
rustfs    -> S3-compatible storage companion
```

Scale-out uses the same Loxep image:

```text
loxep-web-*      -> LOXEP_MODE=web
loxep-worker-*   -> LOXEP_MODE=worker
postgres         -> shared PostgreSQL + TimescaleDB
object-storage   -> shared S3-compatible backend
```

No Redis, message broker, or separate analytical database is required.

## Explicit Phase 0 non-goals

Do not build yet:

- full accounting schema;
- universal marketplace abstraction;
- generic workflow engine;
- plugin marketplace/runtime;
- Redis;
- tRPC;
- global Zustand store;
- full public API implementation;
- Timescale aggregates before observation queries exist;
- multi-tenant organization hierarchy;
- browser-based eBay checkout automation;
- native replacements for every recommended companion service.

## Exit criteria

Phase 0 is complete when a fresh clone can:

1. install dependencies with Bun using current verified pins/lockfile;
2. start the supported Compose development stack;
3. migrate PostgreSQL/TimescaleDB from zero;
4. start Loxep in default `all` mode;
5. start the same image successfully in separate `web` and `worker` modes;
6. authenticate through at least one supported development login path and enforce deployment roles;
7. create/read an authorized external connection through a minimal internal flow;
8. enqueue and execute a durable Graphile Worker job;
9. upload/read/delete media through the local storage driver;
10. run the same storage contract against an S3-compatible target, initially RustFS;
11. prove a resumable local-to-S3 migration path;
12. expose useful database/job/storage/integration health and structured logs;
13. run automated tests and type/lint checks;
14. build the docs and application reproducibly in CI.

Only then should Phase 1 eBay monitoring become the primary implementation focus.
