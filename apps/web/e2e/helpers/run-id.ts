/**
 * A run-stable fixture seed (loxep-wtk).
 *
 * Module-level `const runId = Date.now()` was the cascade mechanism behind a
 * confirmed failure pair: when one test fails, Playwright restarts the
 * worker, the spec module re-evaluates, `Date.now()` mints a NEW id — and
 * every later test in that file hunts fixtures named with an id that was
 * never used to create them. The seed below is minted ONCE per run in the
 * runner process (playwright.config.ts sets the env var before workers
 * spawn; child workers inherit it), so a worker restart re-imports the spec
 * and lands on the SAME id. A fresh run still gets a fresh seed, so shared
 * scratch databases never collide across runs.
 */
export function runSeed(): string {
  return process.env['LOXEP_E2E_RUN_SEED'] ?? String(Date.now());
}
