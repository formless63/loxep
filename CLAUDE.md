# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Loxep is an open-source, self-hosted platform for marketplace intelligence and multichannel commerce operations, starting with an eBay listing/watchlist observation vertical slice. The repo is currently in foundation buildout: `apps/web` holds the UI shell (donor dashboard integrated), and `apps/docs` holds extensive architecture documentation that functions as the product spec. **Most decisions you might be tempted to make have already been made and documented — read the docs before choosing.**

The single most important document is the **Implementation Contract**: `apps/docs/src/content/docs/development/implementation-contract.md`. It is the short list of load-bearing constraints written specifically for coding agents. Follow it. ADRs live in `apps/docs/src/content/docs/decisions/`.

Source-of-truth order when documents disagree: accepted ADRs → architecture docs → implementation contract → product/domain maps and roadmap → clearly intentional existing implementation → starter/demo code → remembered framework knowledge. Current upstream documentation always beats remembered APIs; dependency versions in starters or model memory are never authoritative.

## Commands

Bun workspace (`bun@1.3.14`, pinned in package.json). Run from the repo root:

```bash
bun install               # install all workspaces
bun run dev               # apps/web dev server — port 3020, strictPort, host 0.0.0.0
bun run build             # apps/web production build (Vite + Nitro → .output/)
bun run lint              # oxlint (apps/web)
bun run format            # oxfmt --write (apps/web)
bun run format:check      # oxfmt --check
bun run docs:dev          # Astro Starlight docs dev server
bun run docs:build        # docs production build (no automated link check yet — a Phase 0 to-do)
```

Inside `apps/web` there is also `lint:fix` (`oxlint --fix`) and `start` (`node .output/server/index.mjs`). There is no test suite yet; the contract's "Testing and quality gates" section describes what foundation work is expected to establish (real Postgres/Timescale integration tests — never SQLite substitutes — Graphile Worker tests, Playwright, storage conformance tests).

## Architecture

Modular monolith. One Loxep image runs as `LOXEP_MODE=all|web|worker`; default deployment is `loxep` + `postgres-timescale` (+ optional RustFS S3 companion). Do not add Redis/Kafka/BullMQ/pg-boss — Graphile Worker on PostgreSQL is the accepted job system, and polling uses DB-stored scheduling state with a small number of dispatcher jobs, never one cron entry per monitored item. Jobs are at-least-once; handlers must be idempotent.

Accepted stack (do not relitigate): TanStack Start/Router/Query/Table/Form, React 19, Zod at validation boundaries, shadcn/ui + Base UI + Tailwind v4, Drizzle + first-class SQL on PostgreSQL + TimescaleDB, Better Auth (OIDC + magic links, no passwords initially, `admin`/`member` roles only), Node.js LTS runtime with Bun as package manager/tooling.

### apps/web layout

- `src/routes/` — TanStack Router file routes; `routeTree.gen.ts` is generated, never hand-edit.
- `/dashboard/*` is the real Loxep product workspace; `/starter/*` is the preserved Kiranism donor/reference workspace. Do not delete the donor routes or re-copy the donor over Loxep. Future major product areas become peers of `/dashboard`, not children.
- `src/config/workspaces.ts` — workspace configuration that drives the sidebar and Cmd+K palette.
- `src/features/` — feature modules (auth, overview, products, kanban, etc.; mostly donor-derived today).
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

Architecture changes are incomplete until the docs are updated (and an ADR added/superseded when a rule changes). Starlight conventions: frontmatter `title` is the H1 — don't repeat it as a `#` heading; use `##` and below. Keep content portable (renderer is intentionally replaceable). Verify internal links against the built site (`bun run docs:build`), not source-relative paths. If implementation genuinely conflicts with a documented rule, surface the conflict explicitly instead of silently drifting.


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
