# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Loxep is an open-source, self-hosted platform for marketplace intelligence and multichannel commerce operations, starting with an eBay listing/watchlist observation vertical slice. The repo is currently in foundation buildout: `apps/web` holds the application (donor dashboard integrated, `/settings` and `/market` are the real product surfaces), `packages/*` holds the domain/runtime libraries, and `apps/docs` holds extensive architecture documentation that functions as the product spec. **Most decisions you might be tempted to make have already been made and documented — read the docs before choosing.**

The single most important document is the **Implementation Contract**: `apps/docs/src/content/docs/development/implementation-contract.md`. It is the short list of load-bearing constraints written specifically for coding agents. Follow it. For UI work, its companion is **Frontend Standards** (`apps/docs/src/content/docs/development/frontend-standards.md`) — TanStack Table via the donor `DataTable` components is the only data table, `useAppForm` is the only form, chart series bind to the `--chart-1..5` theme tokens, and product surfaces use semantic tokens (never `gray-*`/hex) and must visibly respond to a theme switch. ADRs live in `apps/docs/src/content/docs/decisions/`.

Workspace packages: `app`, `accounting`, `auth`, `commerce`, `config`, `counterparties`, `db`, `domain`, `integrations/{ebay,medusa,woo}`, `inventory`, `jobs`, `market`, `notifications`, `observability`, `runtime`, `storage`.

Source-of-truth order when documents disagree: accepted ADRs → architecture docs → implementation contract → product/domain maps and roadmap → clearly intentional existing implementation → starter/demo code → remembered framework knowledge. Current upstream documentation always beats remembered APIs; dependency versions in starters or model memory are never authoritative.

## Commands

### Compose-first dev loop (the normal way to run Loxep)

The repo-root Compose stack is the primary way the app runs. Configuration comes from the **root `.env`** (`cp .env.example .env`; generate `LOXEP_KEYRING` and `LOXEP_AUTH_SECRET` with `head -c 32 /dev/urandom | base64`).

```bash
docker compose up -d --build        # postgres → one-shot `migrate` → loxep (LOXEP_MODE=all)
docker compose logs -f loxep        # app logs (structured JSON)
docker compose run --rm migrate     # re-run migrations explicitly after a schema change
docker compose --profile rustfs up -d   # optional S3-compatible companion
```

The app lands on `http://localhost:3020` (readiness `/health/ready`). `migrate` is a separate one-shot service using the same image; the app service waits on `service_completed_successfully` and **startup never migrates** (ADR-0018). The bundled DB image is `timescale/timescaledb-ha:pg18.4-ts2.29.1-all`. `compose.override.yml` adds `host.docker.internal` so magic links can reach a host Mailpit.

`bun run dev` is the **fast UI loop** — Vite dev server on port 3020 (strictPort, host 0.0.0.0), web-only, reading `apps/web/.env`. Use it for frontend work; use Compose for anything touching runtime modes, workers, or migrations. The two both bind 3020, so run one at a time.

### Repo scripts (Bun workspace, `bun@1.3.14` pinned in package.json)

```bash
bun install               # install all workspaces
bun run dev               # apps/web dev server — port 3020, strictPort, host 0.0.0.0
bun run build             # apps/web production build (Vite + Nitro → .output/)
bun run migrate           # node bin/loxep.ts migrate — explicit, advisory-locked
bun run start             # node bin/loxep.ts start [--mode=all|web|worker]
bun run test:packages     # vitest across all 18 packages
bun run typecheck         # aggregate tsc across the workspace
bun run lint              # oxlint (apps/web)
bun run format            # oxfmt --write (apps/web)
bun run format:check      # oxfmt --check
bun run docs:dev          # Astro Starlight docs dev server
bun run docs:build        # docs production build; fails on broken internal links (starlight-links-validator + scripts/check-doc-links.mjs browser-semantics check)
```

Inside `apps/web` there is also `lint:fix` (`oxlint --fix`), `start` (`node .output/server/index.mjs`), and `test:e2e` (`playwright test`). Runtime commands run outside Compose need `LOXEP_*` bootstrap env (see `apps/web/env.example.txt`; `node --env-file=apps/web/.env bin/loxep.ts …` works).

### Tests

Tests are real, not planned: ~1,600 vitest tests across 18 packages run against actual PostgreSQL/TimescaleDB (never SQLite substitutes) using scratch databases on the dev container:

```bash
docker compose -f docker/compose.dev.yml up -d --wait   # timescale/timescaledb-ha:pg18.4-ts2.29.1-all, host port 5433
bun run test:packages                                    # or bun --cwd packages/<name> test
```

`bun run test:packages` covers every package: config, observability, db, domain, jobs, runtime, market, notifications, storage, auth, commerce, app, integrations/{ebay,woo,medusa}, inventory, accounting, counterparties. Storage's S3 leg needs `LOXEP_TEST_S3_*`. Playwright e2e specs live in `apps/web/e2e/` and run against a **built** app with an already-running harness (scratch DB + Mailpit) documented in `apps/web/e2e/harness.md` (`bun --cwd apps/web test:e2e`).

## Architecture

Modular monolith. One Loxep image runs as `LOXEP_MODE=all|web|worker`; default deployment is `loxep` + `postgres-timescale` (+ optional RustFS S3 companion). Do not add Redis/Kafka/BullMQ/pg-boss — Graphile Worker on PostgreSQL is the accepted job system, and polling uses DB-stored scheduling state with a small number of dispatcher jobs, never one cron entry per monitored item. Jobs are at-least-once; handlers must be idempotent.

Accepted stack (do not relitigate): TanStack Start/Router/Query/Table/Form, React 19, Zod at validation boundaries, shadcn/ui over Radix/Base UI primitives + Tailwind v4 (donor components are mostly Radix today; standardization is incremental, per ADR-0015), Drizzle + first-class SQL on PostgreSQL + TimescaleDB, Better Auth (OIDC + magic links, no passwords initially, `admin`/`member` roles only), Node.js LTS runtime with Bun as package manager/tooling.

### apps/web layout

- `src/routes/` — TanStack Router file routes; `routeTree.gen.ts` is generated, never hand-edit.
- `/settings/*` and `/market/*` are the real Loxep product surfaces today; `/dashboard/*` is the product workspace shell; `/starter/*` is the preserved Kiranism donor/reference workspace. Do not delete the donor routes or re-copy the donor over Loxep. Future major product areas become peers of `/dashboard`, not children.
- `src/config/workspaces.ts` — workspace configuration that drives the sidebar and Cmd+K palette.
- `src/features/` — feature modules. Real: `settings`, `market`, `auth`. Donor/reference: `products`, `users`, `overview`, `forms`, `kanban`, `chat`, `notifications`, `elements`.
- `src/components/ui/` — shadcn/donor primitives, including the `table/` data-table stack and `chart.tsx`. `src/components/themes/` + `src/styles/themes/*.css` — ten themes selected by a `data-theme` attribute on `<html>`; see Frontend Standards before styling anything.
- Integrations are catalog-driven: `src/features/settings/integrations-catalog.ts` describes each provider and its readiness, `/settings/integrations` renders the catalog and holds the eBay keyset dialog, and `/settings/connections` creates per-account provider connections. Provider secrets are entered in-app and encrypted in PostgreSQL — never Compose env vars.
- Path aliases via `vite-tsconfig-paths`; Nitro auto-detects deploy target (override with `SERVER_PRESET`).

### Load-bearing domain rules (from the contract — read it for the full list)

- **No SaaS multi-tenancy.** Do not introduce an organization/workspace tenant hierarchy. Workspaces are navigation surfaces, not ownership boundaries; do not mirror sidebar workspaces in DB schemas or package boundaries.
- **Economic entities** (ADR-0017) are minimal attribution/business-context records — not users, not permission containers. No per-entity/per-connection ACLs, no `connection_users`, no generic ACL engine in Phase 0. Accounting books are a later, separate concern — do not create `accounting_books` or a one-book-per-entity relationship now.
- Never equate: application user, provider account, provider connection, workspace, economic entity, accounting book.
- **Config/secrets:** env vars only for bootstrap/pre-DB facts; normal settings live in PostgreSQL; provider secrets are application-encrypted in PostgreSQL with the root key outside the DB. Provider connections are created in-app, not via Compose env vars. Never log plaintext credentials.
- **Schema:** money is PostgreSQL `numeric` (never JS `number` arithmetic for persisted amounts); domain states are text + TS unions, not PG enums; TimescaleDB enabled from the first migration; `marketplace_item_observations` is a hypertable (7-day chunks, columnstore ~30 days, no auto-retention). Phase 0 creates only foundation tables — don't eagerly build the future commerce/accounting schema.
- **Provider ingestion:** provider SDK shapes stop at the integration boundary (eBay via `ebay-api` behind Loxep-owned adapters); raw event → normalization → domain services.
- **Storage:** `local` and generic `s3` drivers behind one abstraction; RustFS is a tested companion, not a modeling assumption.
- **Notifications:** event detection and delivery are separate concepts; ntfy is the first transport, not the model.
- **State ownership:** PostgreSQL (durable), TanStack Query (server cache), Router (URL), TanStack Form (forms), React (local), Zustand (cross-component ephemeral UI only — never duplicate server data into it).
- **External API:** server functions are internal; design toward a stable `/api/v1` HTTP/OpenAPI surface; no tRPC as the sole public integration model.

## Dependency policy

Before adding or pinning any runtime, library, container image, or GitHub Action, verify the newest viable current upstream release — starter templates and training-data versions are not authoritative. Reproducible pins + Renovate; never float production deps on `latest`.

## Documentation discipline

Architecture changes are incomplete until the docs are updated (and an ADR added/superseded when a rule changes). The docs sidebar groups are Overview, **Guides** (end-user connection walkthroughs: eBay, WooCommerce, Medusa — keep these in step with the integrations catalog and the `/settings` flow), Product, Architecture, Development, and Decisions. Starlight conventions: frontmatter `title` is the H1 — don't repeat it as a `#` heading; use `##` and below. Keep content portable (renderer is intentionally replaceable). Verify internal links against the built site (`bun run docs:build`), not source-relative paths. If implementation genuinely conflicts with a documented rule, surface the conflict explicitly instead of silently drifting.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
