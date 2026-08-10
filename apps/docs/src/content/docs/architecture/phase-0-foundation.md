---
title: Phase 0 Foundation Specification
---

Phase 0 creates the smallest credible platform on which Phase 1 marketplace work can be built without committing future domains to accidental framework choices.

The UI shell portion of Phase 0 has already begun: `apps/web` exists, the dashboard donor is integrated, `/starter/*` preserves its reference/demo pages, and `/dashboard/*` is the first real Loxep workspace.

## Current/target repository shape

```text
loxep/
├── apps/
│   ├── web/                  # TanStack Start application + runtime entrypoints
│   └── docs/                 # Astro Starlight
├── packages/                 # add only when real ownership/reuse warrants them
│   ├── auth/                 # likely Better Auth config + domain auth helpers
│   ├── config/               # typed bootstrap/runtime configuration helpers
│   ├── db/                   # Drizzle schema, migrations, database client
│   ├── domain/               # shared domain primitives/contracts where justified
│   ├── integrations/         # provider adapter modules/packages
│   ├── jobs/                 # Graphile task contracts/helpers
│   ├── storage/              # local + S3 media abstraction/migration
│   └── observability/        # logging/telemetry conventions
├── docker/
├── compose.yml
├── package.json
├── bun.lock
└── tsconfig.base.json
```

Do not create every proposed package immediately. Loxep is a modular monolith; split code when a real dependency/ownership boundary exists rather than mirroring the future domain map mechanically.

## Foundation capabilities

### Current-version verification

Before copying package manifests or pinning dependencies:

- verify current viable versions from upstream sources;
- treat starter/example versions as non-authoritative;
- use exact/reproducible pins and Bun's lockfile;
- keep Renovate/CI responsible for surfacing updates;
- re-verify tightly coupled TanStack/Start/Nitro dependencies as a compatible set rather than independently trusting broad ranges.

### UI/application shell

Already established direction:

- responsive dashboard shell;
- workspace switcher at the top of the sidebar;
- active-workspace sidebar navigation;
- Cmd+K using the same workspace navigation source;
- multi-theme/tweakcn theme system;
- shadcn/Base UI component composition;
- TanStack Router/Query/Table/Form patterns;
- `/starter/*` preserved as reference/demo material;
- `/dashboard/*` reserved for Loxep's actual dashboard workspace.

Major future areas must be peer workspace roots such as `/market`, `/commerce`, or `/inventory`, not children of one giant `/dashboard/*` tree. See [Workspaces & Navigation](../product/workspaces/).

Do not aggressively remove useful donor tooling merely to minimize dependencies. Recharts, DnD, and Zustand all have credible Loxep uses. Zustand remains constrained to genuine UI/editing state; PostgreSQL/Query/Router/Form retain their natural state ownership.

### Configuration and setup

Follow [Configuration & Secrets](./configuration-and-secrets/) and ADR-0016.

Phase 0 must establish two layers:

**Bootstrap/deployment configuration** for facts needed before DB-backed administration/login is possible, including database connectivity, runtime mode, canonical auth origin, Better Auth secret, Loxep root encryption key/keyring, at least one initial OIDC and/or SMTP magic-link login path, and first-admin bootstrap/recovery.

**Database-backed runtime configuration** for normal application/provider settings and encrypted runtime secrets.

Do not make normal eBay/provider credentials, ntfy settings, S3 keys, polling defaults, or future integration tokens Compose environment variables by default.

Secret inputs used at bootstrap should support mounted-file/Docker-secret style delivery where practical.

### Database

- PostgreSQL + TimescaleDB supported development/deployment image.
- Drizzle migration workflow.
- UUID and timestamp conventions established.
- Timescale extension enabled by migration/bootstrap.
- Initial tables limited to foundation/auth/connections/settings/events/monitoring/media/external-resource links needed for early vertical slices.
- No speculative full accounting/commerce/project schema in Phase 0.
- Integration tests use real PostgreSQL/Timescale semantics.

### Jobs

- Graphile Worker starts as part of the default Loxep runtime and independently under `LOXEP_MODE=worker`.
- Typed task-name/payload conventions.
- Job-key/idempotency conventions.
- Retry/backoff policy documented.
- Health visibility for failed/stale jobs.
- One example/maintenance task proving the runtime path.

The default deployment does **not** require a separate worker container. The same image must support later worker-only replicas on other hosts.

Polling uses database-controlled scheduling. Do not create one recurring cron entry per watched item; a small number of recurring dispatchers enqueue jobs for due monitor targets.

### Authentication and authorization

- Better Auth integration.
- Generic OIDC configuration with Pocket ID as an intended tested provider.
- Magic-link authentication.
- Password login disabled initially.
- Better Auth owns deployment-level roles such as `admin` and `member`.
- Concrete first-admin bootstrap and shell-level recovery path.
- Application user and provider connection identities remain separate.
- Loxep relations own resource-specific authorization such as connection `owner/manage/view` permissions.

At least one viable pre-login auth path must be available from bootstrap configuration. Do not build a permanent unauthenticated web backdoor for setup.

### Application settings and runtime secrets

Phase 0 needs shared semantics for application-level settings and secrets in addition to provider connection credentials.

Conceptually:

```text
application_settings
├── key
├── value jsonb
├── schema_version
├── updated_by_user_id
└── updated_at

application_secrets
├── id
├── key / purpose
├── secret_version
├── key_version
├── nonce
├── auth_tag
├── ciphertext
├── created_at
└── updated_at
```

These are not a substitute for proper feature/domain tables. Connection metadata belongs with connections, monitor configuration with monitors, and durable user preferences in an appropriate preference model once their shape is known.

### Connections and credentials

Initial generic connection records represent configured external accounts/stores/services without pretending all providers share the same settings.

Credentials are encrypted in the application layer using AES-256-GCM with an externally supplied/versioned root key. Provider-specific non-secret metadata may use JSON where schema diversity is legitimate; frequently queried canonical fields remain relational.

Creating and managing eBay and later Woo/Medusa connections is an authenticated in-app workflow, not a Compose-edit workflow.

### Source events and raw provider objects

Establish conventions before eBay ingestion begins:

- provider/source identity;
- external object/event ID where available;
- received/observed/occurred timestamps;
- payload hash;
- retained raw JSON payload where useful;
- processing state/version;
- idempotent uniqueness rules.

Not every polling response becomes a heavyweight domain event. Source retention serves replay/debugging/audit without duplicating high-frequency observation storage unnecessarily.

### Media and object storage

- PostgreSQL stores media metadata/relationships, not ordinary binary payloads.
- `local` filesystem storage works with no extra service.
- generic `s3` storage is supported behind the same application contract.
- RustFS is the initial recommended/tested self-hosted S3 companion.
- RustFS remains a separate optional service/container.
- local-to-S3 migration is resumable/idempotent and verifies objects before metadata cutover.
- multi-host Loxep deployments warn when unsafe node-local media is configured.

Storage backend choice/configuration should be manageable in-app where possible; deployment filesystem mounts remain deployment topology.

### External companion resources

Create the generic foundation needed to link Loxep records to external specialist applications without provider-specific columns throughout the schema:

```text
external_resources
resource_links
```

This can later represent Outline/AFFiNE documents, Vikunja tasks/projects, GitHub issues, Invoice Ninja records, backup-health resources, and similar external objects.

### Observability

- Structured logging with Pino.
- Request/job correlation IDs.
- Provider/account context in logs without leaking secrets/tokens.
- `/health` and readiness behavior.
- Database/job/storage/integration health visibility.
- OpenTelemetry deferred until a concrete collector/use case exists.

### Testing

- Unit-test convention.
- Database integration tests against real PostgreSQL/TimescaleDB.
- Worker integration test path.
- Storage conformance tests against both `local` and S3-compatible targets.
- Playwright for critical browser flows once product flows exist.
- Type/lint/format/build checks.

### Deployment

Default supported self-host shape:

```text
loxep     -> web + Graphile Worker capability, LOXEP_MODE=all
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
- full commerce/inventory/projects implementation merely because the domain map exists;
- universal marketplace abstraction;
- generic workflow engine;
- plugin marketplace/runtime;
- Redis;
- tRPC as the external integration architecture;
- duplicate global client/server state stores;
- full public API implementation;
- Timescale aggregates before observation queries exist;
- classic SaaS tenant/organization hierarchy;
- browser-stealth eBay checkout automation;
- native replacements for every recommended companion service.

## Exit criteria

Phase 0 is complete when a fresh clone can:

1. install dependencies with Bun from the repository lockfile;
2. start the supported Compose development stack;
3. migrate PostgreSQL/TimescaleDB from zero;
4. start Loxep in default `all` mode;
5. start the same image successfully in separate `web` and `worker` modes;
6. authenticate through at least one supported login path and enforce deployment roles;
7. bootstrap/recover an administrator without manual SQL or a default password;
8. read/write validated database-backed application settings and encrypted application/runtime secrets;
9. create/read an authorized external connection through a minimal internal flow;
10. enqueue and execute a durable Graphile Worker job;
11. upload/read/delete media through the local storage driver;
12. run the same storage contract against an S3-compatible target, initially RustFS;
13. prove a resumable local-to-S3 migration path;
14. expose useful database/job/storage/integration health and structured logs;
15. run automated tests and type/lint/format checks;
16. build the documentation and application reproducibly in CI.

Only then should Phase 1 eBay monitoring become the primary implementation focus.
