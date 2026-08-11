import { defineConfig } from "vitest/config";

/**
 * Integration tests run against the real dev database
 * (docker/compose.dev.yml → localhost:5433), configurable via
 * LOXEP_TEST_DATABASE_URL. Real PostgreSQL/TimescaleDB, never SQLite
 * substitutes; each test file provisions its own scratch database.
 *
 * The LIVE tier (`test/live-store.test.ts`) additionally needs the read-only
 * WooCommerce credentials at ~/.config/loxep/woo-syracusesynergy.env and skips
 * cleanly when that file is absent.
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
