import { defineConfig } from "vitest/config";

/**
 * Integration tests run against the real dev database
 * (docker/compose.dev.yml → localhost:5433), configurable via
 * LOXEP_TEST_DATABASE_URL. Real PostgreSQL/TimescaleDB, never SQLite
 * substitutes; each test file provisions its own scratch database.
 *
 * Every `CHECK` in migration 0006, the `media_links` natural key from 0004 that
 * makes receipt attachment idempotent, and exact `numeric(20,6)` arithmetic are
 * only meaningfully testable against real PostgreSQL — which is why the only
 * unit-only tier here is `decimal.test.ts`.
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
