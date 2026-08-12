---
name: add-domain-package
description: Create a new workspace package under packages/ (a domain, runtime, or service library published as @loxep/<name>) — manifest and lockfile ownership, tsconfig extends, erasable-syntax TypeScript with explicit .ts import specifiers for Node type stripping, the scratch-database-per-file vitest harness, and registration in the root typecheck/test aggregate scripts. Use when asked to add a new package, split a domain out of an existing one, or scaffold a library the worker or web app will import.
---

Packages are plain TypeScript **source** libraries — no build step, no `dist/`. `apps/web`
imports them through path aliases and `bin/loxep.ts` runs them directly under Node 24 type
stripping. Use `packages/counterparties` as the reference package; provider adapters go under
`packages/integrations/<name>` and follow the `add-integration-provider` skill instead.

## Manifest and lockfile are ORCHESTRATOR-owned

**Never run `bun install`, `bun add`, or edit `bun.lock` from an agent session.** A scaffolded
`package.json` is committed *together with* the lockfile update the orchestrator performs; an
agent that installs on its own produces a lockfile diff nobody reviewed and can silently float
a dependency. Write the manifest, state which dependencies you added, and stop.

Dependency rules (`apps/docs/src/content/docs/development/dependency-policy.md`): exact pins,
never `latest`, and verify the current newest viable upstream release before choosing a
version — starter ranges and remembered versions are not authoritative.

## 1. `packages/<name>/package.json`

```json
{
  "name": "@loxep/<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@loxep/db": "workspace:*", "zod": "4.4.3" },
  "devDependencies": { "@types/node": "24.13.3", "@types/pg": "8.21.0", "typescript": "5.9.3", "vitest": "4.1.10" }
}
```

`exports` points at **source**. Add subpath exports only when a consumer genuinely needs one
(`@loxep/db` exports `.`, `./schema`, `./migrate`).

## 2. `packages/<name>/tsconfig.json`

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "vitest.config.ts"] }
```

Never restate compiler options — `tsconfig.base.json` is the single source
(`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`,
`allowImportingTsExtensions`, `module: NodeNext`).

## 3. TypeScript that Node can strip

`erasableSyntaxOnly` is on because the production runtime executes these `.ts` files directly:

- **No `enum`, no `namespace`, no constructor parameter properties, no `declare` class fields.** Domain states are `const` arrays + TS unions (the same rule the DB follows: text + unions, never PG enums).
- **`import type` for every type-only import** (`verbatimModuleSyntax`).
- **Every intra-package import carries an explicit `.ts` extension** — `from "./errors.ts"`, `from "./schema/index.ts"`. Extensionless relative imports do not resolve under Node.
- **Node builtins are imported with the `node:` specifier** — `node:crypto`, `node:fs`, `node:url`. This is the import gate: a bare `fs`/`crypto` specifier is wrong here.
- Package sources use double quotes and trailing commas; `bun run format` (oxfmt) only covers `apps/web`, so match the surrounding files by hand.
- Zod at every input boundary; money is a decimal string, never a JS `number`.

Give `src/index.ts` a module doc naming the package's boundary and the ADRs it implements —
see `packages/integrations/medusa/src/index.ts`. Re-export explicitly; do not `export *`
across the whole tree.

## 4. Tests: real PostgreSQL, a scratch DB per file

Never substitute SQLite or an in-memory database. `packages/<name>/vitest.config.ts`:

```ts
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 120_000, maxWorkers: 2 }
});
```

Copy `packages/counterparties/test/helpers.ts` verbatim and adapt the seeds. Its shape:

```ts
export const baseDatabaseUrl =
  process.env["LOXEP_TEST_DATABASE_URL"] ?? "postgres://postgres:loxep-dev@localhost:5433/loxep_test";

export async function createMigratedScratchDb(prefix: string): Promise<ScratchDb> {
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  await withMaintenanceDb(`create database "${name}"`);        // via the /postgres maintenance DB
  await runMigrations({ databaseUrl, logger: silentLogger });   // real migrations, never a hand-built schema
  …  // close() drops it with (force)
}
```

One scratch database **per test file**, created in `beforeAll`, dropped in `afterAll`, so files
run in parallel and never inherit state. Seed FK-valid actors with a real `user` row (ADR-0020)
rather than a random string. The dev container must be up:
`docker compose -f docker/compose.dev.yml up -d --wait` (host port 5433).

Live-provider legs go in a `test/live-*.test.ts` that **skips cleanly** when its credential file
is absent — never fails the suite.

## 5. Register the package

- Root `package.json`: append `&& bun --cwd packages/<name> typecheck` to `typecheck` **and** `&& bun --cwd packages/<name> test` to `test:packages`. A package missing from those chains is untested in CI.
- `CLAUDE.md` workspace list: add the package name.
- `apps/docs/src/content/docs/architecture/domain-boundaries.md`: state what the package owns and what it must not reach into. A new boundary is not done until it is documented.
- Only add the package to root `dependencies` if `bin/loxep.ts` composes it directly.

## Boundary rules

- No package imports another provider integration package; shared-looking taxonomies (error kinds, rate budgets) are deliberately duplicated rather than pulled into a shared core.
- `apps/web` must never import `packages/app`'s worker registry — `LOXEP_MODE=web` is exactly the mode that runs no jobs.
- Executors and task handlers are wired in the composition root (`packages/app/src/registry.ts`), never inside the scheduling package.
- Do not add Redis/Kafka/BullMQ/pg-boss. Graphile Worker on PostgreSQL is the job system.

## Done when

- [ ] Manifest written but **no** install run and `bun.lock` untouched.
- [ ] `tsconfig.json` extends the base; sources are erasable, `.ts`-suffixed, `node:`-prefixed.
- [ ] Scratch-DB-per-file harness against real PostgreSQL; live legs skip cleanly.
- [ ] Root `typecheck` + `test:packages` and the CLAUDE.md workspace list updated.
- [ ] `bun run typecheck` and `bun --cwd packages/<name> test` pass.
