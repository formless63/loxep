---
title: Phase 0 Exit Walkthrough
---

Final validation gate for the Phase 0 exit criteria ([Phase 0 Foundation → Exit criteria](../../architecture/phase-0-foundation/#exit-criteria)), executed as a genuinely fresh-clone walkthrough.

- **Date:** 2026-08-11
- **Commit validated:** `83c4031700a8abfa09f857e42b2cc4586fb981ce`
- **Method:** fresh `git clone` of pushed `main` into a scratch directory; every step followed documented commands (README quickstart, `compose.yml`, `docker/compose.dev.yml`, `apps/web/e2e/harness.md`, package test docs). Deviations from documentation are recorded below.
- **Wall time:** ~18 minutes end to end (sequential, 4-core host).

## Criteria matrix

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Install dependencies from lockfile | PASS | `bun install --frozen-lockfile` — 1890 packages, no lockfile drift |
| 2 | Start supported Compose development stack | PASS | `docker compose -f docker/compose.dev.yml up -d --wait` healthy (host-port/name remap needed, see gap G2) |
| 3 | Migrate PostgreSQL/TimescaleDB from zero via explicit command | PASS | `node --env-file=apps/web/.env bin/loxep.ts migrate` → advisory lock acquired, "applied 2 migrations"; also the compose one-shot `migrate` service from zero |
| 4 | Start Loxep in default `all` mode | FAIL (defect found; runtime verified after one-file fix) | Documented `docker compose up -d` cannot build the image from a fresh clone: `docker/Dockerfile` omits `COPY` of 4 workspace manifests (gap G1). With those lines added, the full stack (postgres + migrate + loxep `all`) comes up healthy on :3020 |
| 5 | Same image in separate `web` and `worker` modes | PASS | Same `loxep` image run with `LOXEP_MODE=web` (:3022) and `LOXEP_MODE=worker` (:3023); both `/health/ready` 200 with `"mode":"web"` / `"mode":"worker"` |
| 6 | Login path + `admin`/`member` role enforcement | PASS | curl transcript: magic-link request → Mailpit capture → verify URL → session. Bootstrap admin got `role: admin`, second user `role: member`. Admin-only `fetchUsers` server fn: admin 200, member 403 "Role 'admin' required", anonymous 401. Playwright auth/guards specs also green |
| 7 | Bootstrap/recover admin without manual SQL | PASS | `LOXEP_BOOTSTRAP_ADMIN_EMAIL` → first login became admin; `docker compose exec loxep node bin/loxep.ts admin list` / `admin promote --email=…` promoted the member; demotion via authenticated `setUserRole` admin API returned the user to `member` |
| 8 | Economic entity CRU + parent/assumed-name relationship | PASS | Playwright `settings.spec.ts`: admin creates root entity and child entity beneath a parent (10/10 e2e green); domain package suite (68 tests) covers create/read/update incl. hierarchy |
| 9 | Validated DB-backed settings + encrypted secrets | PASS | `packages/config` (69) + `packages/domain` (68) suites green against the clone's own dev DB; heartbeat row visible in `application_settings` on the compose stack |
| 10 | Connection create/read with optional entity attribution | PASS | Domain suite green (connections service incl. attribution); `/settings/connections` surface present with admin-gated mutations |
| 11 | Enqueue + execute durable Graphile Worker job | PASS | `packages/jobs` suite green (12 tests); on the compose stack the cron-scheduled `maintenance.heartbeat` executed and upserted `application_settings.runtime.heartbeat` (`lastRunAt` + worker hostname) |
| 12 | Media upload/read/delete via local driver | PASS | `packages/storage` suite from the clone: 58 tests green incl. local-backend contract (upload/read/delete) |
| 13 | Same storage contract against S3-compatible target | PASS | Disposable RustFS container per storage test docs (`docker run … -p 9002:9000 rustfs/rustfs:1.0.0-rc.1`); S3 conformance leg ran (not skipped) and passed |
| 14 | Resumable local-to-S3 migration proof | PASS | `packages/storage` `migration.test.ts` green within the 58-test run |
| 15 | Health detail + structured logs | PASS | `/health` returns mode/uptime/components + database/migrations/worker-jobs check detail; container logs are pino JSON lines (startup config summary, worker start, heartbeat) |
| 16 | Automated tests + type/lint/format checks | PASS | From the clone: `test:packages` 226 tests green; auth/storage/notifications/market suites +128 green (354 total); `typecheck` clean; `lint` exit 0 (donor-component warnings only); `format:check` clean; Playwright e2e 10/10 |
| 17 | Reproducible app + docs builds with link validation | PASS | `bun run build` (Vite+Nitro) exit 0; `bun run docs:build` — 38 pages, "All internal links resolve" |

**Gate verdict: 16/17 PASS.** The single FAIL (criterion 4) is a mechanical, fully-diagnosed Dockerfile gap, not an architectural one; the runtime itself satisfies the criterion once the image builds.

## Deviations and docs gaps

- **G1 (defect, blocks criterion 4):** `docker/Dockerfile` copies only 6 of the 10 workspace package manifests. `bun install --frozen-lockfile` inside the image fails with `Workspace dependency "@loxep/auth" not found` / `"@loxep/storage" not found`, so a fresh clone cannot complete the documented `docker compose up -d`. Fix: add `COPY packages/{auth,market,notifications,storage}/package.json …` lines to both the `build` and `deps` stages (verified — with these 8 lines the image builds and the whole stack runs).
- **G2 (docs/portability gap, criterion 2):** `docker/compose.dev.yml` hardcodes `container_name: loxep-dev-db` and host port `5433` with no env override for the port. Two checkouts on one host (or any other Postgres on 5433) collide; the walkthrough needed a compose override file (`ports: !override` remap to 5434 + distinct container name/project). An env-var port default (like `LOXEP_DEV_DB_PASSWORD` already has) would make this edit-free.
- **G3 (portability gap):** `compose.yml` hardcodes `image: loxep`, so building from a second checkout silently retags another checkout's image. A project-scoped default (or documented override) would avoid this.
- **G4 (docs nuance):** README's "`bun run test:packages` — package vitest suites" reads as complete coverage, but the script covers 5 of 9 test-bearing packages; `auth`, `market`, `notifications`, `storage` run per package (CLAUDE.md documents this; README does not). `packages/runtime` declares a `test` script but has no test files.
- **Deviation (environment, not a gap):** all scale-out (`web`/`worker` replicas), host-gateway SMTP wiring, and port remaps were done via additive compose override files with `-p` project names; no tracked file was modified except the G1 Dockerfile fix needed to proceed past criterion 4.
- **Deviation (harness):** `apps/web/e2e/harness.md` commands were followed verbatim except every `localhost:5433` became `localhost:5434` (G2 collision) — `LOXEP_TEST_DATABASE_URL` handled the same substitution for package suites.

## Resolution

All findings were fixed in the main repository immediately after this walkthrough:

- **G1** — the four missing workspace manifest `COPY` lines were added to both Dockerfile stages (with a drift-warning comment); a clean `docker build` from the repository was re-verified. Criterion 4 therefore passes at HEAD.
- **G2/G3** — `docker/compose.dev.yml` project name, container name, port, and password, and `compose.yml`'s image name, are now `${VAR:-default}`-overridable so parallel checkouts cannot collide.
- **G4** — the root `test:packages` script now aggregates all nine test-bearing packages.

## 2026-09-02 coordinated stack refresh

The historical matrix above remains the evidence for the original Phase 0
exit. A follow-on validation exercised the current stack after the coordinated
Bun, Node, TypeScript, Vite, Better Auth, PostgreSQL/TimescaleDB, RustFS, and
delivery-tooling refresh:

- `bun run agent:preflight --full` passed with zero lint warnings, formatting
  across 858 web files, every workspace typecheck, 333 web tests, 4,228 package
  tests, and the 81-page documentation build/link check.
- The pinned Bun 1.4.0 build image completed `bun install --frozen-lockfile` and
  the production Vite/Nitro build. The same image passed all 333 web tests with
  one CPU and no network access.
- The final Node 24.20.0 image applied all 35 migrations to a fresh `template0`
  database, installed TimescaleDB 2.29.2, and reached worker-mode readiness with
  its database, migration, worker, and worker-job checks healthy.
- An existing 2.29.1 extension was upgraded through the explicit migration
  path; the retained local maintenance/template databases were also verified at
  PostgreSQL 18.4 / TimescaleDB 2.29.2. Test databases now use `TEMPLATE
  template0`, so they never inherit a stale extension from a long-lived local
  volume.
- A disposable pinned RustFS 1.0.0-rc.4 instance reported ready and passed all
  67 storage tests with the real S3 conformance and resumable-migration legs
  enabled.
- Runtime-image validation exposed a restrictive-source-permission failure that
  an ordinary image build did not: the non-root process could not read a newly
  added migration. The Dockerfile now normalizes shipped sources to
  root-owned, world-readable/non-writable files, and the corrected image was
  re-verified.

## Original walkthrough environment notes

- Host: Linux, 4 cores, ~10 GB free RAM; Docker 29.6.1; Node 24.15.0; Bun 1.3.14 (matched the then-current `packageManager` pin).
- Shared services: Mailpit on `localhost:1025/8025` (message deletion always scoped `to:` recipient); the main checkout's `loxep-dev-db` on 5433 was left untouched.
- Everything created for the walkthrough (both compose projects + volumes, RustFS test container, `loxep-fresh` image, e2e scratch DB and media dir) was removed afterwards; the fresh clone was kept for inspection.
