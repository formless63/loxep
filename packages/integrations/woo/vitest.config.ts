import { defineConfig } from "vitest/config";

/**
 * Unit tests are pure (no network) — every one of them injects a `fetchImpl`
 * stub. The live leg (`test/live-store.test.ts`) talks to a REAL production
 * WooCommerce store with READ-ONLY credentials and skips cleanly when
 * ~/.config/loxep/woo-syracusesynergy.env is absent (CI has no credentials).
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Shared 4-core dev machine: cap file parallelism.
    maxWorkers: 2,
  },
});
