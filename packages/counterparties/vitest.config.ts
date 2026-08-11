import { defineConfig } from "vitest/config";

/**
 * Integration tests run against the real dev database
 * (docker/compose.dev.yml → localhost:5433), configurable via
 * LOXEP_TEST_DATABASE_URL. Real PostgreSQL/TimescaleDB, never SQLite
 * substitutes; each test file provisions its own scratch database.
 *
 * `UNIQUE ... NULLS NOT DISTINCT`, `num_nonnulls`, partial unique indexes over
 * a `coalesce()` expression, and the counterparty-boundary `CHECK`s have no
 * meaning anywhere else — which is why `normalize.test.ts` is the only
 * unit-only tier here.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Shared 4-core dev machine: cap file parallelism.
    maxWorkers: 2,
  },
});
