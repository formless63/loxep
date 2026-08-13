import { defineConfig } from "vitest/config";

/**
 * Integration tests run against the real dev database
 * (docker/compose.dev.yml → localhost:5433), configurable via
 * LOXEP_TEST_DATABASE_URL. Real PostgreSQL, never a SQLite substitute — every
 * `CHECK` in migration 0017 and exact `numeric(20,6)`/`numeric(4,3)`
 * arithmetic are only meaningfully testable against it. Each test file
 * provisions its own scratch database.
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
