---
title: Phase 0 Foundation Specification
---

# Phase 0 Foundation Specification

Phase 0 creates the smallest credible platform on which Phase 1 can be built without committing future domains to accidental framework choices.

## Target repository shape

```text
loxep/
├── apps/
│   ├── web/                 # TanStack Start
│   ├── worker/              # Graphile Worker runtime
│   └── docs/                # Astro Starlight
├── packages/
│   ├── auth/                # Better Auth config + authorization helpers
│   ├── config/              # typed environment/configuration
│   ├── db/                  # Drizzle schema, migrations, database client
│   ├── domain/              # shared domain primitives/contracts
│   ├── integrations/        # provider adapter packages/modules
│   ├── jobs/                # task names/payload contracts/enqueue helpers
│   ├── observability/       # logging/telemetry conventions
│   └── ui/                  # owned shared UI components where useful
├── docker/
├── compose.yml
├── package.json
├── bun.lock
└── tsconfig.base.json
```

Do not create a package for every future domain before code exists. Split packages when they create a real dependency/ownership boundary.

## Foundation capabilities

### Configuration

- Typed environment parsing and startup validation.
- No business-specific defaults.
- Secrets never stored in repository configuration.
- Support Docker secrets/file-backed secrets later without forcing them into Phase 0 if unnecessary.

### Database

- PostgreSQL + TimescaleDB supported development image.
- Drizzle migration workflow.
- UUID strategy and timestamp conventions established.
- Timescale extension enabled by migration/bootstrap.
- Initial tables limited to foundation/auth/connections/events needed for Phase 1.
- No speculative accounting/commerce tables in Phase 0.

### Jobs

- Graphile Worker process starts independently.
- Typed task-name/payload conventions.
- Job-key/idempotency conventions.
- Retry/backoff policy documented.
- Health visibility for failed/stale jobs.
- One example/no-op or maintenance task proving the runtime path.

### Authentication and authorization

- Better Auth integration.
- Generic OIDC configuration with Pocket ID documented/tested.
- Magic-link provider interface/configuration.
- Password login disabled.
- First-admin bootstrap path designed.
- Application user and provider connection identities remain separate.

### Connections and credentials

Initial generic connection record should represent a configured external account/store/service without pretending all providers share the same settings.

Credentials must be encrypted at rest using an application-managed key supplied outside the database. Provider-specific metadata may be JSON where schema diversity is legitimate, while frequently queried canonical fields remain relational.

Connection access should be authorizable per user even though Loxep is not tenant-based.

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

### Observability

- Structured logging with Pino.
- Request/job correlation IDs.
- Provider/account context in logs without leaking secrets/tokens.
- `/health` and readiness behavior.
- Basic worker/database health visibility.
- OpenTelemetry is deferred until there is a concrete collector/use case.

### Testing

- Unit test convention.
- Database integration tests against real PostgreSQL/TimescaleDB, not an incompatible in-memory substitute.
- Worker integration test path.
- Playwright for critical browser flows once UI flows exist.

### Deployment

Initial supported self-host shape:

```text
web       -> Node application process
worker    -> Node Graphile Worker process
postgres  -> PostgreSQL + TimescaleDB
```

The web and worker images may be built from the same repository/build context. No Redis, message broker, or separate analytical database is required.

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
- browser-based eBay checkout automation.

## Exit criteria

Phase 0 is complete when a fresh clone can:

1. install dependencies with Bun;
2. start the supported Compose development stack;
3. migrate a PostgreSQL/Timescale database from zero;
4. start the web and worker processes;
5. authenticate through at least one supported development login path;
6. create/read an authorized external connection through a minimal internal flow;
7. enqueue and execute a durable Graphile Worker job;
8. expose useful health/log output;
9. run automated tests and type/lint checks;
10. build the docs and application reproducibly in CI.

Only then should Phase 1 eBay monitoring become the primary implementation focus.
