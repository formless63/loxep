import { defineConfig } from "vitest/config";

/**
 * Integration tests run against the real dev database
 * (docker/compose.dev.yml → localhost:5433), configurable via
 * LOXEP_TEST_DATABASE_URL. Real PostgreSQL/TimescaleDB, never SQLite
 * substitutes; each test file provisions its own scratch database.
 *
 * The append-only trigger, the cached-balance recompute, the largest-remainder
 * distributions, and every `CHECK` in migration 0005 are only meaningfully
 * testable against real PostgreSQL, which is why there is no unit-only tier
 * here beyond `decimal.test.ts`.
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
