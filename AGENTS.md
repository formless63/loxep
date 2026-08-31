# Loxep contributor and agent guide

This file is the canonical working agreement for every human contributor and
coding agent in this repository. Tool-specific instruction files may point here,
but they must not duplicate or override it.

## Start here

Loxep is an open-source, self-hosted marketplace-intelligence and multichannel
commerce platform. It is a TypeScript/ESM modular monolith: one Node.js image can
run the web application, Graphile Worker, or both; PostgreSQL with TimescaleDB is
the system of record; Bun is the pinned package manager and workspace runner.

Before making a non-trivial change:

1. Run `git status --short --branch` and preserve every pre-existing change.
2. Run `bd ready`, then inspect or create the Beads issue for the work.
3. Read the relevant accepted ADRs and architecture documentation.
4. Read the [Implementation Contract](apps/docs/src/content/docs/development/implementation-contract.md).
5. For UI work, also read [Frontend Standards](apps/docs/src/content/docs/development/frontend-standards.md).

Most architectural choices have already been made. Surface a genuine conflict
instead of silently replacing an established decision.

## Source-of-truth order

When sources disagree, use this order:

1. accepted or superseding ADRs;
2. current architecture documents;
3. the implementation contract;
4. product/domain maps and the roadmap;
5. clearly intentional, tested implementation;
6. starter/demo code;
7. remembered framework or model knowledge.

Current upstream documentation wins over remembered APIs. Verify the current
viable release before changing a dependency, runtime, image, or GitHub Action.
Keep production dependencies exact-pinned; never use `latest`.

## Privacy and secrets

The tracked repository is public-safe. The local Beads database is deliberately
private and may contain operator decisions or deployment context.

- `.beads/` must remain ignored and local. Never force-add it, export it into a
  tracked path, paste its private contents into commits, or configure a public
  Beads remote.
- Never put real names, usernames, private domains, hostnames, connection names,
  LAN/tailnet addresses, or private topology into tracked files. Use RFC 2606
  example domains, RFC 5737 addresses, and generic personas.
- Treat files under user configuration directories and all live provider
  credentials as private external state. Do not read or use them unless the task
  explicitly requires a live integration check.
- Live tests are opt-in. They must check the opt-in flag before reading credential
  files or contacting a service, and they must default to non-destructive behavior.
- Never log plaintext credentials or place them in jobs, source events, audit
  snapshots, fixtures, or general JSON configuration.
- Synthetic secret fixtures must not resemble real provider token formats; avoid
  authentic prefixes such as `ghp_`, `tskey-`, `AKIA`, `xoxb-`, or `sk-`.

## Local issue tracking with Beads

Beads is the local source of truth for development work on this machine:

```bash
bd ready
bd show <id>
bd create --title="..." --description="..." --acceptance="..." --type=task --priority=2
bd update <id> --claim
bd close <id> --reason="..."
bd lint
```

Rules:

- Create or identify an issue before writing code and claim it before substantial
  implementation. Give executable tasks acceptance criteria.
- Use `bd remember` for private, durable local context; never create tracked
  memory files for operator-specific facts.
- Defer work that is intentionally postponed. Label genuinely owner-gated or
  policy-gated work `human` so it does not masquerade as autonomous ready work.
- Beads is configured for one machine with no remote and no auto-export. Do not
  run `bd dolt push` or add a remote.
- `bd prime` is optional command reference. Its output can include private local
  memories and a generic remote-oriented close protocol: never paste that output
  into tracked files, and treat this section as the Loxep-specific override.
- `bd preflight --check` currently contains upstream Go/Nix checks unrelated to
  Loxep. Use `bun run agent:preflight` instead.

## Shared worktree and Git safety

Several agents can share this worktree. Uncommitted changes may belong to someone
else even when you did not see them at session start.

- Re-run `git status --short` before editing, formatting, staging, or committing.
- Never discard, rewrite, or “clean up” changes you do not own.
- Do not use `git stash` in the shared worktree. Do not run destructive reset,
  checkout, clean, or broad removal commands.
- Prefer `rg`/`rg --files` for discovery and `apply_patch` for edits.
- Use non-interactive file-operation flags. Resolve exact targets before deletion;
  never use a broad directory, unresolved variable, or workspace root as a
  destructive target.
- Format only the files in your scope when other work is in flight.
- Stage explicit paths, never `git add -A` or `git add .`. Inspect
  `git diff --cached --stat` and `git diff --cached` before committing.
- Do not pull/rebase over a dirty shared tree. If the remote advanced, first make
  the tree safe and ensure every change is owned and committed.
- This is currently a local-first, single-machine project. Make focused local
  commits, but do not push Git changes unless the owner explicitly asks to
  publish or synchronize them.
- Never rewrite public history or force-push unless the owner explicitly asks.

## Development commands

The pinned toolchain is declared in `package.json` and `bun.lock`.

```bash
bun install --frozen-lockfile

# Fast web loop (port 3020)
bun run dev

# Production web build
bun run build

# Repository checks
bun run lint
bun run format:check
bun run typecheck
bun --cwd apps/web test
bun run docs:build

# Project-aware preflight; add --full for package tests, web tests, and docs
bun run agent:preflight
bun run agent:preflight --full
```

The root lint and formatter currently cover `apps/web`; until their scope is
expanded, run the owning package's formatter/linter or focused checks for package
changes as well.

### Compose-first runtime loop

```bash
docker compose up -d --build
docker compose exec loxep node bin/loxep.ts migrate
docker compose logs -f loxep

# PostgreSQL/TimescaleDB used by package tests
docker compose -f docker/compose.dev.yml up -d --wait
```

Normal startup never migrates. There is no migration service and there are no
one-shot migration containers. Readiness reports pending schema work until the
explicit `migrate` command succeeds.

The development machine is resource-constrained. Keep at most four active agents,
do not overlap production/container builds, and check available memory before a
build-heavy task. A targeted test is usually the right first check.

## Architecture constraints

### Runtime and jobs

- Preserve the modular monolith and the `LOXEP_MODE=all|web|worker` modes.
- Each mode is one Node.js process; `all` embeds Graphile Worker.
- PostgreSQL/Graphile Worker is the durable job foundation. Do not introduce
  Redis, Kafka, BullMQ, pg-boss, or a service per capability.
- Jobs are at-least-once. Handlers must be idempotent, bounded, observable, and
  safe to retry. Store polling schedules in PostgreSQL; do not create one cron
  entry per monitored object.
- Liveness means the process/event loop functions. Readiness means the mode's
  required DB/web/worker dependencies are initialized and usable.

### Domain ownership

- A UI workspace is navigation, not a backend ownership or tenancy boundary.
- Never equate application users, provider accounts, provider connections,
  workspaces, economic entities, counterparties, or accounting books.
- Loxep is not a SaaS multi-tenant system. Do not add organization tenancy,
  per-connection ACLs, or a generic permission engine without an accepted design.
- Keep writes and invariants in their owning package. `apps/web` may orchestrate
  package commands but should not duplicate domain SQL or business rules.
- Cross-domain commands in this shared-database monolith should use a transaction-
  scoped application service where atomicity matters. Otherwise define explicit
  idempotency, compensation, and repair behavior.
- External provider types stop at their integration boundary: provider payload →
  adapter normalization → domain service. Never leak SDK shapes into domain APIs.

### Data and migrations

- PostgreSQL is durable state; TanStack Query is server cache; Router owns URL
  state; TanStack Form owns form state; React owns local state; Zustand is only
  cross-component ephemeral UI state.
- Persist money as fixed-precision PostgreSQL `numeric`; use exact decimal/scaled-
  integer arithmetic, never JavaScript `number`, for monetary decisions.
- Prefer text plus TypeScript unions/check constraints over PostgreSQL enums.
- Tests that depend on PostgreSQL semantics use real PostgreSQL/TimescaleDB, not
  SQLite or an in-memory substitute.
- Migrations are append-only after application. Never edit an applied migration,
  including comments, because migration identity is content-hash based. Add a new
  migration or follow the documented recovery process.
- Migration ownership, journal entries, schema exports, and migration tests land
  together. Coordinate before touching shared migration metadata.

### Configuration and storage

- Environment variables are only bootstrap/pre-database facts. Normal settings
  live in PostgreSQL; provider secrets are application-encrypted in PostgreSQL;
  the root key remains outside the database.
- Provider connections are created in the application, not encoded as Compose
  environment variables.
- Storage remains behind the `local`/generic-`s3` abstraction. RustFS is an
  optional compatible companion, not a domain assumption.

### Authentication and public APIs

- Better Auth owns users/sessions, OIDC, magic links, and the installation roles
  `admin` and `member`. Initial password login remains disabled.
- Account-provisioning enforcement belongs inside `@loxep/auth` hooks, not in a
  web caller that can be bypassed.
- Server functions are internal. Design external integrations toward stable
  `/api/v1` HTTP/OpenAPI endpoints; do not make tRPC the only public model.
- Public webhook/upload paths must bound unauthenticated memory, CPU, body size,
  and cardinality before expensive parsing, database, or credential work.

## Frontend rules

`apps/web` uses TanStack Start/Router/Query/Table/Form, React 19, Tailwind v4,
and the donor/shadcn component system.

- Never hand-edit `src/routeTree.gen.ts`.
- Major workspaces are peers under the workspace shell; configure them in
  `src/config/workspaces.ts`. Do not copy the donor application over product code.
- Use the shared TanStack `DataTable` stack for data tables and provide stable
  domain row IDs for interactive rows.
- Use `useAppForm` and shared form components for product forms.
- Use semantic theme tokens, not literal gray palettes or hex colors. Every
  product surface must visibly respond to a theme switch.
- Bind chart series to `--chart-1` through `--chart-5` and use shared formatters.
- Preserve accessibility, keyboard behavior, empty/loading/error states, and
  user-facing feedback.
- Components should not perform side effects or state mutation during render.

Task playbooks under `.claude/skills/` are optional helpers. This file and the
current documentation remain authoritative; if a playbook references a missing
path or contradicts current code, fix the playbook rather than following it.

## Testing discipline

- Start with the smallest focused test and expand in proportion to risk.
- Package tests use the dev TimescaleDB stack and isolated scratch databases.
- A skipped suite is not coverage. Do not use `--passWithNoTests` to hide a new
  package or runtime surface that needs tests.
- External/live tests require explicit opt-in and must never load credentials at
  module scope. Tests should remain deterministic when private credential files
  exist on the machine.
- Teardown must preserve the primary failure and clean resources in `finally` or
  `allSettled`; database/client cleanup should be safe after partial setup.
- Changes to accounting, auth, storage, migrations, provider writes, webhooks, or
  cross-domain workflows need boundary and failure-path tests, not only happy paths.
- Playwright uses a built application and the documented scratch DB + Mailpit
  harness in `apps/web/e2e/harness.md`.

## Documentation discipline

Architecture changes are incomplete until documentation changes with them. Add or
supersede an ADR when a load-bearing rule changes.

- Keep README onboarding commands executable against current Compose files.
- Keep integration status honest: distinguish fixture-tested, implemented,
  persistence-verified, live-read-verified, and live-write-verified behavior.
- Starlight frontmatter supplies the page H1; start content headings at `##`.
- Keep docs renderer-portable and validate links through `bun run docs:build`.

## Completion protocol

Before handing work back:

1. Re-check `git status` and review the complete diff, including concurrent files.
2. Run focused tests plus the proportional lint, format, typecheck, build, docs,
   or e2e gates for the changed risk surface.
3. Update documentation/ADRs and file Beads follow-ups for remaining work.
4. Close completed Beads issues or leave accurate status/notes. No Beads push is
   required or desired.
5. Stage only owned paths, inspect the staged diff, and commit with a focused
   message. Keep it local unless the owner explicitly requests a push.
6. Report changed files, verification, known skips, and any unresolved risk.
