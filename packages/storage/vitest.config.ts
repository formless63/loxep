import { defineConfig } from "vitest/config";

/**
 * Integration tests run against the real dev database
 * (docker/compose.dev.yml → localhost:5433, configurable via
 * LOXEP_TEST_DATABASE_URL) and — for the S3 conformance leg — a real generic
 * S3-compatible endpoint (default http://localhost:9002, configurable via
 * LOXEP_TEST_S3_* variables). Never SQLite or in-memory substitutes.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
