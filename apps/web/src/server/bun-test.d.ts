/**
 * Minimal ambient typing for `bun:test`, scoped to this directory's own
 * `*.test.ts` files (loxep-v5r.5's `finance-billing.test.ts`).
 *
 * `apps/web` has no vitest harness (only Playwright e2e — see
 * `apps/web/package.json`'s scripts) and no `bun-types`/`@types/bun`
 * devDependency declared anywhere reachable from this workspace, and this
 * package.json is out of scope for this change (see the task notes on
 * `apps/web/src/server/finance-billing.ts`). Bun's own test runner works at
 * runtime with zero extra dependencies (`bun test <file>`); this file exists
 * only so `bun run typecheck` (`tsc --noEmit`) does not fail on the
 * `bun:test` import. It intentionally types just the handful of APIs these
 * tests use, with loose `expect(...)` matcher typing rather than
 * reproducing Bun's full matcher surface — adding the real `bun-types`
 * devDependency (a one-line `apps/web/package.json` addition) would let this
 * file be deleted.
 */
declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function expect(value: unknown): any;
}
