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
apps/docs     current project documentation renderer/content
```

The UI donor has already been integrated. Do not restart from a blank TanStack app or re-copy the donor over Loxep.

Current workspace shell:

```text
/dashboard/*        cross-domain product overview
/market/*           observation and opportunities
/inventory/*        stock and acquisitions
/commerce/*         catalog, listings, and orders
/finance/*          expenses, accounting, and reporting
/infrastructure/*   the installation's operational estate
/settings/*         administration and diagnostics
/starter/*          preserved donor/reference workspace
```

The sidebar and Cmd+K command palette derive navigation from the active workspace configuration. Major product workspaces are peers of `/dashboard`; see [Workspaces & Navigation](../../product/workspaces/).

`apps/docs` currently uses Astro Starlight, but the docs renderer is intentionally replaceable. Preserve portable source content and do not couple product architecture to Starlight. A future `apps/site` may host the public `loxep.com` project/marketing site, with docs and a public demo remaining distinct surfaces. See [Project Surfaces & Future Sites](../project-surfaces/).

## Architecture shape

Loxep is a **modular monolith**, not a microservice system.

Default deployment is strictly two services:

```text
loxep                LOXEP_MODE=all; web + worker capability
postgres-timescale   PostgreSQL + TimescaleDB
```

RustFS is an **optional** S3-compatible companion added as a separate service/profile when shared object storage is wanted; it is never part of the default two-service stack.

The same Loxep image must support:

```text
LOXEP_MODE=all
LOXEP_MODE=web
LOXEP_MODE=worker
```

Do not introduce Redis, Kafka, BullMQ, pg-boss, or another queue/cache merely because workers exist. Graphile Worker and PostgreSQL are the accepted durable-job foundation.

### Runtime processes, migrations, and health (ADR-0018)

- Every mode is **one Node.js process**; `all` embeds Graphile Worker in-process. No in-container process supervisor or sibling processes.
- Schema migration is an explicit invocation of the same image (conceptually `loxep migrate`), protected by a PostgreSQL advisory lock. Normal startup never mutates schema; it fails readiness with a clear diagnostic when the database is behind.
- The Compose stack contains no migration service and no one-shot containers (ADR-0018 as amended): migrations run by exec into the running `loxep` container; the app boots unmigrated into a failed-readiness state with a pending count.
- Liveness = process/event loop functioning. Readiness = the mode's required dependencies usable (`web`: DB + web init; `worker`: DB + worker init; `all`: both). Worker backlog and similar degraded conditions are observable health information, not automatic unreadiness.

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
- shadcn/ui over Radix/Base UI primitives + Tailwind (the donor composition is mostly Radix today; see [ADR-0015](../../decisions/0015-dashboard-starter-and-ui-foundation/) for the current reality and incremental standardization policy);
- Lucide/icons already represented by the donor where appropriate.

The Kiranism dashboard is a presentation donor, not the domain architecture.

How that stack must be *used* — TanStack Table via the donor `DataTable` components as the only data table, `useAppForm` for forms, Recharts series bound to the `--chart-1..5` theme tokens, semantic-token discipline, shared formatters, and empty/skeleton/toast conventions — is specified in [Frontend Standards](../frontend-standards/). Treat it as part of this contract for any work inside `apps/web`.

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

For example, the Finance workspace composes Expenses, Counterparties, Billing, Accounting, Documents, and Reporting without those domains becoming one table/module.

Do not create database schemas or package boundaries solely to mirror sidebar workspaces.

## Authentication and authorization

Use Better Auth for:

- application users/sessions;
- OIDC and magic-link authentication;
- deployment-level roles `admin` and `member`.

Password login is disabled initially.

Initial access is intentionally simple:

- `member` can use/view ordinary product data across the installation;
- `admin` has the same ordinary product access plus installation/security/administrative operations that genuinely require elevation;
- Phase 0 does not implement per-connection, per-workspace, or per-economic-entity ACLs.

Do **not** create `connection_users` or a generic ACL engine as part of Phase 0. Fine-grained authorization may be added later when a real shared-install workflow requires it.

**Account provisioning** (ADR-0024) is a database-backed setting (`auth.provisioning`), never an environment variable and never a construction-time Better Auth plugin option. Enforcement belongs in `@loxep/auth`'s own hooks — `sendMagicLink` and `databaseHooks.user.create.before` — because `/api/auth/*` is a catch-all mount and a rule a web-layer caller can forget is a rule that can be bypassed. Provisioning controls govern account **creation** only: an existing user always keeps their sign-in path, which is what makes the feature lockout-proof. There is no invite system; a closed installation adds people through the admin plugin's `createUser` from `/settings/users`.

Do not equate:

- application user;
- eBay/Woo/other provider account;
- provider connection;
- workspace;
- economic entity;
- accounting book.

Loxep is not designed around classic SaaS multi-tenancy. Do not introduce an organization/workspace tenant hierarchy as a default architecture.

## Economic entities, counterparties, and accounting books

ADR-0017 resolves the initial ownership model.

One installation may represent personal activity plus multiple businesses/operating identities. Phase 0 therefore includes a minimal `economic_entities` model. It may represent an individual, sole proprietorship, LLC, partnership/corporation, assumed name/DBA, operating unit, or another explicitly tracked context.

Economic entities are attribution/business-context records. They are **not** users or permission containers.

Provider connections may have nullable `economic_entity_id` when one account clearly represents one entity. The association is context, not access control. `created_by_user_id` is audit provenance and does not confer private ownership.

An external organization or person that pays, buys from, or sells to an entity is a counterparty. Counterparties are implemented separately from economic entities; do not treat an outside party as an installation-owned economic entity.

Accounting books are separate from economic entities. The implemented `accounting_books` and effective-dated `book_entity_links` model deliberately permits multiple economic entities or operating identities to share one book and chart of accounts. Do not collapse that relationship into a required one-book-per-entity foreign key.

## Configuration and secrets

Follow [Configuration & Secrets](../../architecture/configuration-and-secrets/).

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

The domain map is not authorization to create future tables. Add schema only for an implemented capability, preserve the owning package's boundary, and record provisional decisions in the relevant architecture document. In particular, accounting books exist because the Accounting domain implements them, not merely because economic entities exist.

### Time-series observations

`marketplace_item_observations` is a Timescale hypertable from the beginning.

Initial physical direction:

- time column: `observed_at`;
- 7-day chunks as a starting point;
- recent rowstore data;
- current Timescale columnstore features for older observations;
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

Use maintained provider libraries where they fit, behind Loxep-owned adapters. The initial eBay direction is `ebay-api`, not provider types leaking through the application. This boundary is implemented in `packages/integrations/ebay` (`@loxep/integration-ebay`), with `ebay-api` v10 as the pinned client behind the adapter (Buy Browse item snapshots, observation mapping, error taxonomy, per-connection rate budget). Per-connection user access is an OAuth authorization-code consent run through the web app (consent URL → callback → encrypted `oauth_tokens` connection credential with `expires_at`/`refresh_after`, refreshed before expiry), while the installation's eBay application keyset is one typed application secret under the `integration.ebay.keyset` convention — never an environment variable.

WooCommerce has the same boundary in `packages/integrations/woo` (`@loxep/integration-woo`): a read-only adapter over the native REST API v3 with no client dependency (HTTPS Basic Auth, the same error taxonomy and rate-budget shapes, header-driven pagination, and order/product normalization into Loxep-owned facts), whose credentials are a `woo_credentials` bundle while the store URL stays non-secret connection config. Its `woo_orders` poll path persists normalized orders, lines, fees, refunds, fulfillments, and retained provider objects through `@loxep/commerce`; the mapping and ingestion path have been exercised against a live store with read-only credentials. The implementation remains provisional against the [Commerce Schema Design](../../architecture/commerce-schema-design/).

Medusa v2 has the same boundary in `packages/integrations/medusa` (`@loxep/integration-medusa`): a read-only adapter over the Admin REST API with no client dependency (secret-API-key auth sent as `Authorization: Basic <token>`, the same error taxonomy and rate-budget shapes, body-driven offset/limit/count pagination, and order/product normalization — including the v2 major-currency-unit money format, a real behavior change from v1's integer minor units — into Loxep-owned facts), whose credential is a single-field `medusa_credentials` bundle while the backend URL stays non-secret connection config. Its `medusa_orders` path now has the same persisted Commerce shape as WooCommerce and eBay, including retention redaction support. It was exercised against a throwaway Medusa 2.18.0 backend, including refund, fulfillment, inclusive-boundary, and idempotent re-poll behavior. This implementation is also provisional against the Commerce Schema Design.

Etsy has the same boundary in `packages/integrations/etsy` (`@loxep/integration-etsy`): a read-only adapter over Open API v3 with no client dependency (a public `x-api-key: <keystring>:<sharedSecret>` tier for market-browse reads plus a private `Authorization: Bearer <userId>.<accessToken>` tier for shop-management reads, OAuth2 with **mandatory PKCE** — the load-bearing divergence from eBay's non-PKCE flow — an integer-plus-divisor `Money` shape requiring exact `BigInt` division rather than eBay's/Woo's decimal-string amounts, and listing/shop observation mapping), whose credentials split into a `etsy_keyset` application secret (the approved Developer Portal app, one per installation) and a reused `oauth_tokens` connection credential (one per connected shop). Etsy's rate limit is **per application, not per connection** — the opposite of eBay's per-connection budget — so the composition root (`packages/app/src/etsy.ts`) builds exactly one shared `RateBudget` for the whole installation rather than one per connection, the single highest-risk copy-paste hazard flagged in the [Etsy Integration Design](../../architecture/etsy-integration-design/). Order ingestion (`orders.ts`) is design-only, not yet implemented.

Reverb has the same boundary in `packages/integrations/reverb` (`@loxep/integration-reverb`): a read-only adapter with no client dependency, auth simpler than either eBay's or Etsy's — a single, non-expiring `Authorization: Bearer <personalAccessToken>` on every call, no application-level keyset at all, self-service and instant to mint with no approval queue. Every request also carries a mandatory `Accept-Version: 3.0` header, a genuine Reverb-specific divergence neither eBay nor Etsy has. Money is a VERIFIED decimal string (`{amount: "29.99", currency: "USD"}`, confirmed against Reverb's own docs) — structurally like eBay's `Amount`, simpler than Etsy's integer-plus-divisor `Money`, needing validation and pass-through rather than arithmetic. The credential is a single-field `reverb_credentials` bundle with **no non-secret connection config at all** (no base URL, no shop id — Reverb has one fixed hosted API and m1's `reverb_shop` target always means the connection's own account). Because each connection's token is minted independently from a different Reverb account (unlike Etsy's one-keyset-per-installation), the rate budget is **per connection**, matching eBay's/Woo's shape rather than Etsy's shared one; Reverb publishes no numeric rate limit, so the budget defaults are a documented conservative guess. See the [Reverb Integration Design](../../architecture/reverb-integration-design/) for the full verified-fact citation trail. Order ingestion is design-only, not yet implemented.

Invoice Ninja is a different shape of boundary in `packages/integrations/invoiceninja` (`@loxep/integration-invoiceninja`): unlike the read-only eBay/WooCommerce/Medusa adapters, it **writes** — the [Services & Billing Schema Design](../../architecture/services-billing-schema-design/) has Loxep push invoice drafts to Invoice Ninja rather than pull anything from it. Auth is a single `X-API-TOKEN` header (no Basic/Bearer wrapping), carried in a one-field `invoiceninja_credentials` bundle while the instance URL stays non-secret connection config; the same 5-kind error taxonomy and rate-budget shapes as the other adapters; pagination is a `League\Fractal` `ArraySerializer` `{data, meta.pagination}` envelope advanced by page number, not offset; and client/invoice normalization follows the design's `external_resources` vocabulary (`purpose='billing_client'`/`'delivery_document'`). The on-demand `pushDraftInvoice` server action is implemented and records the external client/document links; it registers no `monitor_targets` type. Auth-failure behavior has been live-verified, but the write mapping has not yet been independently confirmed by a live draft push, so fixture/source verification must not be described as live write verification.

Pangolin — the reverse-proxy/tunnel identity provider fronting the installation's own estate — has the same boundary shape in `packages/integrations/pangolin` (`@loxep/integration-pangolin`), but it belongs to [Infrastructure](../../architecture/domain-boundaries/#infrastructure), not to any commercial domain: no listing, order, or catalog fact ever crosses it. Auth is `Authorization: Bearer <apiKeyId>.<apiKeySecret>`, held in a `pangolin_credentials` bundle while the base URL and org id stay non-secret connection config; the same 5-kind taxonomy and per-connection rate budget as every sibling adapter (duplicated, never shared, per ADR-0009); the `{data, success, error, message, status}` RPC envelope means HTTP 200 never implies success, the identical hazard Purelymail's adapter already handles. What makes this adapter different from every other provider Loxep writes to is not the boundary shape but what is on the other side of it: Pangolin is the access layer in front of the estate, including — in this installation — Loxep itself, so a wrong write here can remove the operator's own way to fix it. Two structural consequences follow directly from that, at the boundary rather than as a convention: the write operation union is **closed with no `delete` member, permanently** (Pangolin's rule `enabled` flag makes retirement `enabled: false` — reversible — so there is no unrecoverable operation this adapter needs a delete verb for), and every non-idempotent create (Pangolin has no upsert anywhere in this API) goes through the `provider_operations` ledger exactly as a Cloudflare zone or a Purelymail mailbox does. Layered above the adapter, not inside it, `infrastructure.provider_write_policy` — a registered setting keyed by connection id, four ordinal tiers (`read_only` default / `additive` / `access_affecting` / `lockout_class`) — gates whether `@loxep/infrastructure`'s reconciler may apply anything beyond a read, and a pure `wouldLockOut` preflight refuses (never warns) a change that would remove the operator's own access, independent of policy tier. This mechanism was ruled a Cloudflare-and-Purelymail rule too, not a Pangolin-only one (owner ruling, 2026-08-15), but it ships as an Infrastructure-domain registered setting (`infrastructure.provider_write_policy`, keyed by connection id) rather than a generic Loxep-wide connection property — so it extends this section's provider-ingestion boundary and does not warrant a new ADR. Full design, including the write-risk model's six binding rules and the three owner rulings that gated it, is in [Pangolin Integration & Chain-Provisioning Templates](../../architecture/pangolin-chain-design/).

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
ledger / accounting book
         |
         v
financial/tax reporting
```

The ledger is downstream of reality. Do not make journal entries the only surviving representation of orders, purchases, shipping, inventory movement, payments, project work, or other source facts.

An accounting book is an accounting interpretation/container, not the identity of the economic entity that generated the activity.

## Notifications

ntfy is the first notification adapter, but event detection and notification delivery remain separate concepts. A detected `RESTOCKED` event should not be coupled directly to one notification transport.

The ntfy adapter is implemented behind the transport-neutral `NotificationTransport` interface in `@loxep/notifications`; additional providers implement the same interface rather than extending ntfy-specific code paths.

The **ledger is subject-neutral too** (ADR-0023): a notifiable fact is a `notification_events` row (`event_class` + `event_type`, `subject_type` + `subject_id`, a small Loxep-owned render payload, and a mandatory unique `deduplication_key`), and `notification_deliveries` points at that, not at a market event. Detection writes the event; routing (`notification_rules`, filtered by class × type × monitor target) and delivery are separate steps behind an explicit bridge, and the emitting call site supplies the enqueue seam. Do not add a per-class delivery table, a rules engine on top of `notification_rules`, or a per-user read/inbox table. See [Notifications Design](../../architecture/notifications-design/).

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
- application and docs builds in CI;
- automated internal-doc-link validation.

Do not report a task complete while known build/type/test failures caused by the change remain unresolved.

## Documentation discipline

Architecture changes are incomplete until documentation is updated.

For the current Starlight renderer:

- frontmatter `title` is the page H1;
- do not repeat it with a Markdown `#` heading;
- use `##` and below in content;
- keep broad architecture/product docs synchronized when an ADR changes a previous assumption.

Keep documentation content portable enough to move to a different renderer later. Internal-link changes must be checked in a built/served docs site; do not assume source-relative links resolve the same way as generated directory URLs.

When an implementation discovers a real conflict with these rules, surface it explicitly. Do not quietly choose the easiest framework default and make the documentation false afterward.
