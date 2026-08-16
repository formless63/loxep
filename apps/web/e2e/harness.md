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

# 4. Confirm nothing else holds the port, then start the built app
#    (leave running while tests execute)
lsof -t -i :3093    # must print nothing; if it prints a PID, kill that PID
                    # by number — never pkill by name
node bin/loxep.ts start --mode=all
```

**Port 3093 is single-occupant.** `loxep start` refuses to start when the
port is already bound (it exits 1 with `EADDRINUSE` — this is deliberate;
the underlying Nitro/srvx server layer swallows its own listen failure, so
without the preflight a second process would report "web runtime started"
while holding no listener, and every request would silently land on the
_other_ process's server and database). The `lsof` check before starting is
the companion rule: know whose server you are about to test against. If two
harnesses must run in parallel, give each its own port and database —
override `LOXEP_PORT`, `LOXEP_PUBLIC_ORIGIN`, and `LOXEP_E2E_BASE_URL`
together, and use a distinct scratch database name.

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

## QA sessions against a live deployment (loxep-kw3)

`signInWithMagicLink` (`helpers/auth.ts`) needs a Mailpit this suite can
read; once a deployment's SMTP is a real provider (e.g. Purelymail on
`dev.loxep.com`), magic-link emails land in a real inbox instead, and that
sign-in path stops working there. `helpers/qa-session.ts`'s
`applyQaSession(context, sessionFilePath, origin)` is the alternative for
that case: it adds a Better Auth session cookie straight into the browser
context, skipping sign-in entirely. It never mints anything itself — it only
replays `{cookieName, cookieValue, expiresAt}` JSON produced by
`scripts/mint-qa-session.mjs`, a container-run one-off script (see the
`one-off-scripts-against-the-live-loxep-stack` bd memory) that inserts a
real `session` row for an already-existing user and signs the cookie value
with better-auth's/better-call's own exported cookie functions
(`better-auth/cookies` `getCookies`, `better-call` `serializeSignedCookie`)
rather than reimplementing the HMAC. Both halves are gated hard: the mint
script refuses to run without `--i-know-this-mints-a-session` and refuses
any email that isn't an existing user; the session it creates is
short-lived (2h), stamped `ipAddress`/`userAgent` `qa-mint` so it is trivial
to find and delete afterward, and the JSON file it writes (mode 600) must
live only in a scratch/temp directory and be deleted the moment the run
that consumes it finishes — it is a live, valid session credential. This
path is for one-off interactive/orchestrator QA against a real deployment,
not a checked-in spec: no spec in this suite calls `applyQaSession`.
