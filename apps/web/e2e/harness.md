# Loxep e2e harness

The Playwright suite (`bun run test:e2e` from `apps/web`, or `bunx playwright
test` there) runs against an **already-running built Loxep instance** — the
config deliberately has no `webServer` block, so nothing starts or stops the
app for you. The suite exercises the real production path: `bun run build`
output served by `node bin/loxep.ts start --mode=all`, real PostgreSQL +
TimescaleDB, real SMTP magic-link delivery captured by Mailpit.

## Prerequisites

- The dev database container: `docker compose -f docker/compose.dev.yml up -d --wait`
  (PostgreSQL + TimescaleDB on `postgres://postgres:loxep-dev@localhost:5433`).
- [Mailpit](https://mailpit.axllent.org/) running locally: SMTP on `:1025`,
  REST API on `http://localhost:8025/api/v1`. Tests fetch magic-link emails
  from the API and delete consumed messages, always scoped by recipient
  (`to:` search queries) so a shared Mailpit is safe.
- Playwright's Chromium (bundled `@playwright/test` devDependency; browsers
  under `~/.cache/ms-playwright`). Tests run headless.
- A current build: `bun run build` from the repo root whenever app or package
  sources changed.

## Setup (once per scratch database)

From the repo root:

```bash
# 1. Scratch database on the dev container (drop/recreate to reset)
psql postgres://postgres:loxep-dev@localhost:5433/postgres \
  -c 'CREATE DATABASE loxep_e2e'

# 2. Environment for migrate + start (same shell)
export LOXEP_DATABASE_URL='postgresql://postgres:loxep-dev@localhost:5433/loxep_e2e'
export LOXEP_KEYRING='{"active_version":1,"keys":{"1":"'"$(head -c 32 /dev/urandom | base64)"'"}}'
export LOXEP_AUTH_SECRET="$(head -c 32 /dev/urandom | base64)"
export LOXEP_PUBLIC_ORIGIN='http://localhost:3093'
export LOXEP_PORT=3093
export LOXEP_SMTP_URL='smtp://localhost:1025'
export LOXEP_SMTP_FROM='loxep-e2e@example.com'
export LOXEP_BOOTSTRAP_ADMIN_EMAIL='e2e-admin@example.com'
export LOXEP_MEDIA_ROOT="$(mktemp -d)"   # keep scratch media out of the repo

# 3. Migrate (explicit — startup never migrates, ADR-0018)
node bin/loxep.ts migrate

# 4. Start the built app (leave running while tests execute)
node bin/loxep.ts start --mode=all
```

`LOXEP_BOOTSTRAP_ADMIN_EMAIL=e2e-admin@example.com` is load-bearing:
`settings.spec.ts` signs in as that address and expects the deployment
`admin` role. Port `3093` avoids the dev server (3020) and the default
Compose stack.

## Run

From `apps/web` (server still running):

```bash
bun run test:e2e             # whole suite, headless chromium
bunx playwright test auth    # one spec
```

Overrides: `LOXEP_E2E_BASE_URL` (default `http://localhost:3093`) and
`LOXEP_E2E_MAILPIT_API` (default `http://localhost:8025/api/v1`).

The suite is intentionally single-worker (`workers: 1`, `retries: 0`): all
specs share one database, one server process, and one Mailpit mailbox.
Entity names are timestamped per run, so the scratch database does not need
resetting between runs — drop/recreate `loxep_e2e` only when you want a
truly clean slate (then rerun `node bin/loxep.ts migrate`).

## Teardown

```bash
# stop the `node bin/loxep.ts start` process (Ctrl-C / kill), then:
psql postgres://postgres:loxep-dev@localhost:5433/postgres \
  -c 'DROP DATABASE loxep_e2e'
```
