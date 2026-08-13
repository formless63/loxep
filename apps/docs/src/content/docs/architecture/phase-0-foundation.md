---
title: Phase 0 Foundation Specification
---

Phase 0 creates the smallest credible platform on which Phase 1 marketplace work can be built without committing future domains to accidental framework choices.

The UI shell portion of Phase 0 has already begun: `apps/web` exists, the dashboard donor is integrated, `/starter/*` preserves its reference/demo pages, and `/dashboard/*` is the first real Loxep workspace.

## Current/target repository shape

```text
loxep/
├── apps/
│   ├── web/                  # TanStack Start application
│   └── docs/                 # current docs source/renderer
├── bin/
│   └── loxep.ts              # runtime entrypoint: migrate | start | admin (ADR-0018)
├── packages/                 # created as real ownership/reuse warranted them
│   ├── auth/                 # Better Auth construction, role guards, first-admin bootstrap
│   ├── config/               # typed bootstrap configuration loading
│   ├── db/                   # Drizzle schema, migrations, database client
│   ├── domain/               # entity/connection/settings/secrets domain services
│   ├── jobs/                 # Graphile task contracts/helpers, embedded-runner conventions
│   ├── market/               # monitoring dispatch, observation/event write paths
│   ├── notifications/        # notification rules and delivery write paths
│   ├── observability/        # logging/correlation conventions
│   ├── runtime/              # health state/probes, embedded worker, worker-mode health server
│   └── storage/              # local + S3 media abstraction/migration
├── docker/                   # production Dockerfile + dev database compose file
├── compose.yml
├── package.json
├── bun.lock
└── tsconfig.base.json
```

Provider adapter packages (the planned `integrations/` family) arrive with Phase 1 eBay work. Loxep is a modular monolith; packages split when a real dependency/ownership boundary exists rather than mirroring the future domain map mechanically.

## Foundation capabilities

### Current-version verification

Before copying package manifests or pinning dependencies:

- verify current viable versions from upstream sources;
- treat starter/example versions as non-authoritative;
- use exact/reproducible pins and Bun's lockfile;
- keep Dependabot/CI responsible for surfacing updates;
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

Implemented: the real sign-in surface lives at `/auth/sign-in` (magic-link email form plus "Continue with SSO" when the bootstrap OIDC path is configured), backed by the `/api/auth/*` catch-all over `@loxep/auth`'s `createAuth()`; the workspace routes (`/dashboard/*`, `/starter/*`) are session-guarded and redirect anonymous visitors to sign-in, with `{ user, roles }` exposed through router context and a working sign-out in the shell's account menu.

Major future areas must be peer workspace roots such as `/market`, `/commerce`, or `/inventory`, not children of one giant `/dashboard/*` tree. See [Workspaces & Navigation](../../product/workspaces/).

Implemented: the first such peer is the `/settings/*` workspace — wired through the shared workspace configuration (sidebar + Cmd+K) and session-guarded like `/dashboard/*` — surfacing readiness/health detail, economic entities, connections (credential metadata only), storage backends (write-only S3 credential entry), users/roles via the Better Auth admin API, and registered/raw application settings; reads are member-accessible while mutations and user listing enforce the deployment `admin` role server-side (ADR-0017).

Provider set-up is split across two of those surfaces, driven by one typed registry (`apps/web/src/features/settings/integrations-catalog.ts`): `/settings/integrations` is the catalog of supported services — each card carries the service's description, its derived set-up status, and the single action that continues it (the one global eBay application keyset lives here; the notification transports point at `/settings/notifications`) — while `/settings/connections` is account-centric, listing accounts grouped by service and offering "Add account" per service through a guided per-provider form. Because both surfaces read the registry, `connections.provider` and `connections.kind` are system-supplied rather than typed, and no raw JSON connection config is offered in the UI; eBay's "Add account" is gated on a configured keyset, and the WooCommerce/Medusa forms write the non-secret base URL to `connections.config` while the key pair / API token goes to the encrypted connection credential (ADR-0019).

Phase 1 (loxep-62y.4) adds the second peer, `/market/*` — monitor-target management (`/market/monitors`, create/edit/enable/disable, admin-only mutations over `@loxep/market`'s `createMonitorService`), watched items joined with their latest observation (`/market/items`, filterable by monitor), an item detail page (`/market/items/$itemId`) with a Recharts price-history line and an availability/quantity timeline built on `@loxep/market/metrics.ts`'s `priceHistory`/`availabilityHistory`/`restockSellout`/`itemActivitySummary`, and an event-history list surfacing `market_events` deltas and the `rule_id` badge; `/market/overview` rolls up active-monitor/watched-item/24h-event counts and recent events. Reads stay member-accessible and monitor mutations enforce the `admin` role, same split as `/settings/*`.

Do not aggressively remove useful donor tooling merely to minimize dependencies. Recharts, DnD, and Zustand all have credible Loxep uses. Zustand remains constrained to genuine UI/editing state; PostgreSQL/Query/Router/Form retain their natural state ownership.

### Configuration and setup

Follow [Configuration & Secrets](../configuration-and-secrets/) and ADR-0016.

Phase 0 must establish two layers:

**Bootstrap/deployment configuration** for facts needed before DB-backed administration/login is possible, including database connectivity, runtime mode, canonical auth origin, Better Auth secret, Loxep root encryption key/keyring, at least one initial OIDC and/or SMTP magic-link login path, and first-admin bootstrap/recovery.

**Database-backed runtime configuration** for normal application/provider settings and encrypted runtime secrets.

Do not make normal eBay/provider credentials, ntfy settings, S3 keys, polling defaults, or future integration tokens Compose environment variables by default.

Secret inputs used at bootstrap should support mounted-file/Docker-secret style delivery where practical.

### Database

- PostgreSQL + TimescaleDB supported development/deployment image.
- Drizzle migration workflow, applied through the explicit migration command with advisory-lock protection; application startup never mutates schema (ADR-0018).
- UUID and timestamp conventions established.
- Timescale extension enabled by migration/bootstrap.
- Initial tables limited to foundation/auth/economic-entities/connections/settings/events/monitoring/media/external-resource links needed for early vertical slices.
- No speculative full accounting/commerce/project schema in Phase 0.
- Integration tests use real PostgreSQL/Timescale semantics.

### Economic entities

Phase 0 includes minimal `economic_entities` because one installation may contain personal activity and multiple business/operating identities even though it is not multi-tenant.

The foundation must support:

- individual/personal contexts;
- sole proprietorships and companies;
- assumed-name/DBA or operating identities beneath another entity;
- nullable attribution from a provider connection to an economic entity;
- entity records that are not permission containers;
- future accounting books that remain a separate concept.

Do not create accounting books yet. More than one economic entity/operating identity may later share one book and chart of accounts, with activity separated through accounts or accounting dimensions. Do not bake a one-entity-one-book assumption into Phase 0.

See ADR-0017.

### Jobs

- Graphile Worker runs embedded in the single Loxep process under `LOXEP_MODE=all` and independently under `LOXEP_MODE=worker` (ADR-0018).
- Typed task-name/payload conventions.
- Job-key/idempotency conventions.
- Retry/backoff policy documented.
- Health visibility for failed/stale jobs.
- One example/maintenance task proving the runtime path.

The default deployment does **not** require a separate worker container. The same image must support later worker-only replicas on other hosts.

Implemented conventions (`@loxep/jobs`, graphile-worker 0.17): the `graphile_worker` schema is **Graphile-owned** — the embedded runner creates/migrates it at startup; it is *not* part of Loxep's Drizzle migrations and never appears in `packages/db/migrations`. Tasks are defined with `defineTask({ name, payloadSchema, handler })` (Zod-validated payloads; execution scoped in `runWithLogContext({ jobId, correlationId })`). Handlers are at-least-once; dedupe-able work uses `jobKeyFor(taskName, stableId)` (`taskName:stableId`) with `jobKeyMode: "replace"`. Retries use Graphile's exponential backoff (`exp(least(attempts, 10))` seconds); Loxep's default retry budget is **`max_attempts = 8`** (typed enqueue helpers and cron items apply it; raw SQL enqueues fall back to Graphile's 25), overridable per task or per enqueue. The first maintenance task, `maintenance.heartbeat`, runs on a 5-minute cron and upserts `application_settings` key `runtime.heartbeat` (`{ lastRunAt, hostname }`), proving the job → database write path; queue statistics (pending/running/failed/oldest-pending) surface through the `worker-jobs` readiness check as detail — backlog is observable, never automatic unreadiness (ADR-0018). The task list a worker actually runs is assembled by the composition root `@loxep/app` (`buildWorkerRegistry`), which `bin/loxep.ts` lazily imports only for `LOXEP_MODE=all|worker` — `LOXEP_MODE=web` never loads it, so the request process never pulls in graphile-worker or the provider integrations.

Polling uses database-controlled scheduling. Do not create one recurring cron entry per watched item; a small number of recurring dispatchers enqueue jobs for due monitor targets.

Implemented conventions (`@loxep/market`): `market.dispatch-due-monitors` runs on a one-minute cron (jobKey-replace, `backfillPeriod: 0`) and claims due `monitor_targets` in a **single statement** — `UPDATE … SET next_poll_at = now + interval WHERE id IN (SELECT … WHERE enabled AND next_poll_at <= now AND backoff passed ORDER BY priority LIMIT n FOR UPDATE SKIP LOCKED) RETURNING …` — so concurrent dispatchers partition the due set and can never double-claim; smaller `priority` claims first, matching Graphile's convention. Each claimed target becomes one `market.poll-target` job (`jobKeyFor(task, targetId)`, replace). `market.poll-target` is a Phase 0 **stub** delegating to an injectable `pollExecutor` (Phase 1 provider adapters slot in per ADR-0009; the default executor performs no provider I/O and records a success with zero observations), and the composition root's real executor now branches on `target_type` across all four eBay kinds — `ebay_item`, `ebay_watchlist`, and the Phase 2 discovery pair `ebay_search`/`ebay_seller`, which diff a fetched page against known items *before* upserting it and derive `new_listing` *after* linking. A poll failure is domain state, not a job failure: the task records `consecutive_errors` and `backoff_until = failed_at + min(interval_seconds * 2^consecutive_errors, 1h)` and completes — backoff owns the retry cadence, so Graphile-level poll retries are disabled (`maxAttempts: 1`).

### Monitoring and notifications write paths

Implemented conventions (`@loxep/market`, `@loxep/notifications`): observation batches are written as one multi-row `INSERT … ON CONFLICT (observation_batch_id, marketplace_item_id, observed_at) DO NOTHING` — the batch ID and `observed_at` are minted once at fetch time and retained across retries, so at-least-once re-processing inserts zero new rows while distinct batches at the same instant both land; absent metrics stay NULL, never 0. Derived `market_events` deduplicate through the key convention `<marketplace_item_id>:<event_type>:<to_observed_at ISO-8601>` (the UNIQUE `deduplication_key` column plus `ON CONFLICT DO NOTHING` makes re-derivation a no-op). Detection→delivery bridging is **explicit**: nothing in event derivation enqueues notifications; `enqueueDeliveriesForEvent` matches enabled `notification_rules` (NULL event type/monitor target act as wildcards) and enqueues one `notifications.deliver` job per matched endpoint (jobKey `<market_event_id>:<endpoint_id>` under the task-key convention), which drives the UNIQUE `(market_event_id, endpoint_id)` delivery row from `pending` to `delivered`/`failed` — re-running a delivered row is a no-op.

Phase 1 (loxep-62y.3) adds the operator-facing surfaces on top of this write path without changing it: a `/settings/notifications` UI (endpoint create/edit + enable/disable, token entry write-only through the secrets service, an admin-only "send test notification" action via `createNtfyTransport`, rule create/edit against `@loxep/market`'s `MARKET_EVENT_TYPES`, and a read-only recent-`notification_deliveries` status table), plus `packages/notifications/src/render.ts`, a richer per-event-type `renderMarketEventMessage` (price/quantity/state deltas and the `marketplace_items.canonical_url` listing link) ready to be wired in as the delivery pipeline's `renderMessage` once a call site has joined listing context. Money deltas normalize the `numeric(20,6)` price string to a canonical display scale via `Intl.NumberFormat` on a fixed `en-US` locale (mirroring the intent of `apps/web`'s `formatMoney`, reimplemented locally since the package can't import from `apps/web`) — old and new prices in one message always share the same scale. When the event carries a listing URL, the rendered message also sets `NotificationMessage.url`, which `createNtfyTransport` sends as ntfy's `Click` header so tapping the push opens the listing directly, in addition to the URL line already in the body.

### Authentication and authorization

- Better Auth integration.
- Generic OIDC configuration with Pocket ID as an intended tested provider.
- Magic-link authentication.
- Password login disabled initially.
- Better Auth owns deployment-level roles `admin` and `member`.
- `member` has ordinary product access across the installation.
- `admin` adds installation/security/administrative capabilities where elevation is justified.
- Concrete first-admin bootstrap and shell-level recovery path.
- Application users, economic entities, workspaces, and provider connections remain distinct identities.
- No per-connection, per-workspace, or per-economic-entity ACL tables in Phase 0.

At least one viable pre-login auth path must be available from bootstrap configuration. Do not build a permanent unauthenticated web backdoor for setup.

Implemented conventions (`@loxep/auth`, Better Auth 1.6): `createAuth({ config, db })` explicitly constructs the runtime instance from bootstrap config (drizzle adapter over the checked-in auth schema, `secret`/`baseURL` from `LOXEP_AUTH_SECRET`/`LOXEP_PUBLIC_ORIGIN` — no `BETTER_AUTH_*` env anywhere, importing packages never constructs an instance); the plugin set is shared with CLI schema generation via `buildAuthPluginConfig()` (`@loxep/db`) so runtime and generated schema cannot drift; magic-link delivery goes through an injectable `sendMagicLinkEmail` (real nodemailer SMTP transport from `LOXEP_SMTP_*` by default); the bootstrap OIDC issuer registers as generic-OAuth provider id `oidc` via its discovery document (Pocket ID needs nothing provider-specific); roles are exactly `admin`/`member` with default `member`, guarded server-side by `requireRole(session, "admin")`; first-admin bootstrap and `loxep admin promote|list` recovery behave as described in [Configuration & Secrets](../configuration-and-secrets/#first-administrator-and-recovery).

Fine-grained resource authorization is a later extension if real shared-install workflows require it. Do not prebuild a speculative permissions matrix.

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
├── secret_key / purpose
├── current_version
├── created_at
└── updated_at

application_secret_versions
├── secret_id
├── version
├── key_version
├── nonce
├── auth_tag
├── ciphertext
└── created_at
```

Secrets separate the stable logical record from immutable ciphertext versions with an explicit `current_version` pointer, use typed validated payload bundles, and bind ciphertext to its context through AES-256-GCM AAD. See ADR-0019.

These are not a substitute for proper feature/domain tables. Connection metadata belongs with connections, monitor configuration with monitors, and durable user preferences in an appropriate preference model once their shape is known.

### Connections and credentials

Initial generic connection records represent configured external accounts/stores/services without pretending all providers share the same settings.

Credentials are encrypted in the application layer using AES-256-GCM with an externally supplied/versioned root key. Provider-specific non-secret metadata may use JSON where schema diversity is legitimate; frequently queried canonical fields remain relational.

Creating and managing eBay and later Woo/Medusa connections is an authenticated in-app workflow, not a Compose-edit workflow.

Connections may have nullable `economic_entity_id` where the account clearly represents one entity. That association is business context, not access control. `created_by_user_id` is audit/provenance metadata, not private ownership.

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

**Implemented** (`@loxep/storage`): the `local` and generic `s3` driver families exist behind one `StorageDriver` contract (`get` returns a stream; keys are validated uniformly — traversal/absolute keys are rejected by contract in every driver). The driver conformance suite is implementation-blind: one shared test set runs against both drivers with only endpoint configuration differing, and the S3 leg targets whatever generic endpoint `LOXEP_TEST_S3_*` points at (RustFS is the tested default, never an assumption). The AWS SDK client is configured for S3-compatible endpoints: path-style addressing and `requestChecksumCalculation`/`responseChecksumValidation` set to `WHEN_REQUIRED` by default, since the SDK's default CRC32 checksums are rejected by some non-AWS implementations. Storage migration follows copy → verify (size + sha256 re-hashed from a streamed destination read) → transactional metadata cutover → source retained, with per-object durable state and jobKey-deduped `storage.migrate-object` jobs making it resumable; source deletion happens only through the explicit `cleanupMigrationSources` call after completion. The multi-host local-media warning is not implemented yet — it needs a host registry and belongs to the diagnostics/health surface.

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
- Liveness (process/event loop) and readiness (mode-required dependencies) probes per ADR-0018; degraded conditions such as worker backlog surface as observable health detail, not automatic unreadiness. Concrete contract: `/health/live` (200 when the process functions), `/health/ready` (200/503 gating), `/health` (always-200 observable detail) — served by the web runtime in `web`/`all` modes and by a health-only listener on `LOXEP_PORT` in `worker` mode.
- Database/job/storage/integration health visibility.
- OpenTelemetry deferred until a concrete collector/use case exists.

Implemented conventions (`@loxep/observability`): `createLogger` (Pino) applies mandatory redaction with censor `[REDACTED]` for the secret keys `password`, `secret`, `token`, `accessToken`, `refreshToken`, `clientSecret`, `authorization`, `cookie`, `ciphertext`, `nonce`, `authTag`, `apiKey`, `apiSecret`, `privateKey` at up to four nesting levels (Pino redact wildcards match one segment each, traversing objects and array indices), plus explicit `headers.authorization`/`headers.cookie`/`headers["set-cookie"]` paths — deeper structures are not covered, so never log raw provider payloads or credential envelopes wholesale. Correlation uses `AsyncLocalStorage`: `runWithLogContext` scopes `correlationId`/`requestId`/`jobId` (correlationId auto-generated when absent, inherited by nested scopes) and a Pino `mixin` stamps the active context onto every line. Errors log under the `err` key (standard Pino serializer); `serializeError` produces `{ message, name, stack, code? }` for non-log transports. `pretty: true` (pino-pretty transport) is development-only.

### Testing

- Unit-test convention.
- Database integration tests against real PostgreSQL/TimescaleDB.
- Worker integration test path.
- Storage conformance tests against both `local` and S3-compatible targets.
- Playwright for critical browser flows once product flows exist.
- Type/lint/format/build checks.
- Automated docs-link validation so broken internal links fail CI rather than relying on manual browsing.

Implemented: package vitest suites (~330 tests across `config`/`observability`/`db`/`domain`/`jobs`/`auth`/`market`/`notifications`/`storage`) run against real PostgreSQL/TimescaleDB scratch databases on the dev container (`docker/compose.dev.yml`, host port 5433) — never SQLite substitutes; the storage conformance suite is implementation-blind across `local` and whatever S3 endpoint `LOXEP_TEST_S3_*` points at. Playwright chromium e2e specs (`apps/web/e2e/*.spec.ts`) cover the critical browser flows — magic-link authentication end to end (Mailpit captures the email), session guards, settings health, and economic-entity creation with parent attribution — against a **built** app started through `bin/loxep.ts`; the harness is documented in `apps/web/e2e/harness.md`. Type/lint/format checks and docs internal-link validation run through the workspace scripts (`typecheck`, `lint`, `format:check`, `docs:build`).

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

Implemented as `docker/Dockerfile` (multi-stage: Bun build/install stages, `node:24-slim` non-root runtime running `bin/loxep.ts` via native type stripping) and repo-root `compose.yml`: `loxep-db` (TimescaleDB Community) and the `loxep` service with `/health/ready` healthchecks, plus the optional `rustfs` Compose profile — migrations run by exec into the running `loxep` container (ADR-0018 as amended: startup never migrates, and no one-shot migrate service exists). Bootstrap configuration comes from a repo-root `.env` (template: `.env.example`); the README covers the quick start.

## Explicit Phase 0 non-goals

Do not build yet:

- accounting books/full accounting schema;
- full commerce/inventory/projects implementation merely because the domain map exists;
- per-resource/per-entity RBAC or a generic ACL engine;
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
3. migrate PostgreSQL/TimescaleDB from zero through the explicit migration command (never as a side effect of application startup);
4. start Loxep in default `all` mode;
5. start the same image successfully in separate `web` and `worker` modes;
6. authenticate through at least one supported login path and enforce `admin`/`member` deployment roles;
7. bootstrap/recover an administrator without manual SQL or a default password;
8. create/read/update a minimal economic entity and represent a parent/assumed-name relationship;
9. read/write validated database-backed application settings and encrypted application/runtime secrets;
10. create/read an external connection and optionally attribute it to an economic entity;
11. enqueue and execute a durable Graphile Worker job;
12. upload/read/delete media through the local storage driver;
13. run the same storage contract against an S3-compatible target, initially RustFS;
14. prove a resumable local-to-S3 migration path;
15. expose useful database/job/storage/integration health and structured logs;
16. run automated tests and type/lint/format checks;
17. build the documentation/application reproducibly and validate internal documentation links in CI.

Only then should Phase 1 eBay monitoring become the primary implementation focus.