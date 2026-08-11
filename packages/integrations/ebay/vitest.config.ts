import { defineConfig } from "vitest/config";

/**
 * Unit tests are pure (no network). The live sandbox leg
 * (`test/live-sandbox.test.ts`) talks to the real eBay SANDBOX and skips
 * cleanly when ~/.config/loxep/ebay-sandbox.env is absent (CI has no creds).
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
