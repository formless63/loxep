---
name: run-e2e-harness
description: Stand up and tear down the Loxep Playwright e2e harness in apps/web — dev database container, scratch database, explicit migration, a production build served by bin/loxep.ts on port 3093, Mailpit magic-link capture, then the suite — plus the safe cleanup and build-serialization rules. Use when asked to run e2e or Playwright tests, reproduce a browser-flow failure, or verify auth/settings flows against a real built app.
---

The suite runs against an **already-running built** Loxep instance: `playwright.config.ts` has
no `webServer` block, so nothing starts or stops the app for you. Canonical setup:
`apps/web/e2e/harness.md` — read it; this skill adds the operating rules an agent must not get
wrong.

## Rules that override convenience

- **PID-only cleanup.** Capture the PID of the server you started and kill exactly that PID.
  Never `pkill -f node`, `killall node`, `pkill -f loxep`, or anything pattern-matched — this
  workstation runs other Node processes, including the user's editor tooling and the dev
  container's clients. If you lost the PID, find the listener on your port
  (`ss -lptn 'sport = :3093'`) and kill that one process.
- **Build mutex.** `bun run build` writes one shared `apps/web/.output/`. Only one build at a
  time, and never while a server is serving that output — stop the server, build, restart.
  `bun run dev` and the e2e server both bind ports on this machine (dev is 3020, the default
  Compose stack is 3020, e2e is 3093); do not run the dev server and a Compose stack at once.
- **Run in the background.** The server call blocks; start it with `run_in_background` and poll
  readiness rather than sleeping in the foreground.
- **Never drop a database you did not create**, and never point the harness at the Compose
  stack's database.

## Prerequisites

```bash
docker compose -f docker/compose.dev.yml up -d --wait   # PostgreSQL+Timescale, host port 5433
```

Plus Mailpit locally (SMTP `:1025`, API `http://localhost:8025/api/v1`) — the specs fetch
magic-link emails from the API and delete consumed messages, always scoped by recipient, so a
shared Mailpit is safe. Playwright's Chromium comes from the bundled `@playwright/test`.

## Setup (once per scratch database), from the repo root

```bash
psql postgres://postgres:loxep-dev@localhost:5433/postgres -c 'CREATE DATABASE loxep_e2e'

export LOXEP_DATABASE_URL='postgresql://postgres:loxep-dev@localhost:5433/loxep_e2e'
export LOXEP_KEYRING='{"active_version":1,"keys":{"1":"'"$(head -c 32 /dev/urandom | base64)"'"}}'
export LOXEP_AUTH_SECRET="$(head -c 32 /dev/urandom | base64)"
export LOXEP_PUBLIC_ORIGIN='http://localhost:3093'
export LOXEP_PORT=3093
export LOXEP_SMTP_URL='smtp://localhost:1025'
export LOXEP_SMTP_FROM='loxep-e2e@example.com'
export LOXEP_BOOTSTRAP_ADMIN_EMAIL='e2e-admin@example.com'
export LOXEP_MEDIA_ROOT="$(mktemp -d)"

bun run build                       # only when app or package sources changed
node bin/loxep.ts migrate           # explicit — startup NEVER migrates (ADR-0018)
node bin/loxep.ts start --mode=all  # background; record the PID
```

`LOXEP_BOOTSTRAP_ADMIN_EMAIL=e2e-admin@example.com` is load-bearing: `settings.spec.ts` signs
in as that address and expects the deployment `admin` role. Port 3093 avoids the dev server and
the Compose stack. Every export must be in the **same shell** as `migrate` and `start`.

Wait for readiness before running tests — poll `http://localhost:3093/health/ready` until it
returns healthy; a 503 naming a behind-schema database means the migrate step did not run in
this environment.

## Run, from `apps/web`

```bash
bun run test:e2e             # whole suite, headless chromium
bunx playwright test auth    # one spec
```

Overrides: `LOXEP_E2E_BASE_URL` (default `http://localhost:3093`), `LOXEP_E2E_MAILPIT_API`
(default `http://localhost:8025/api/v1`). The suite is deliberately `workers: 1`, `retries: 0`,
`fullyParallel: false` — one database, one server process, one mailbox. Do not raise the worker
count or add retries to make a flake pass; a flake here is a real serialization bug. Traces and
screenshots land in `apps/web/e2e/.artifacts/` on failure.

Entity names are timestamped per run, so the scratch database survives repeated runs. Recreate
it only for a truly clean slate — and rerun `node bin/loxep.ts migrate` after.

## Teardown

```bash
kill "$SERVER_PID"            # the PID you captured; never a pattern match
psql postgres://postgres:loxep-dev@localhost:5433/postgres -c 'DROP DATABASE loxep_e2e'
rm -rf "$LOXEP_MEDIA_ROOT"
```

Leave the dev database container running — other package suites use it.

## Adding a spec

Specs live in `apps/web/e2e/*.spec.ts` with shared helpers in `apps/web/e2e/helpers/`. Reuse
the existing magic-link/sign-in helpers rather than re-implementing Mailpit polling, always
scope mailbox queries by recipient, and keep new specs order-independent — they share the
database with everything else in the run.
