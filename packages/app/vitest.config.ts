import { defineConfig } from "vitest/config";

/**
 * Composition-root integration tests run against the real dev database
 * (docker/compose.dev.yml → localhost:5433), configurable via
 * LOXEP_TEST_DATABASE_URL. Real PostgreSQL/TimescaleDB and the real Graphile
 * Worker runtime, never substitutes; each test file provisions its own
 * scratch database. Provider I/O is the one thing that is mocked (the eBay
 * adapter factory), except in the skip-cleanly live sandbox tier.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    // Shared dev machine: cap file parallelism.
    maxWorkers: 2,
  },
});
