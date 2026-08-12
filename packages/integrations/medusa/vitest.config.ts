import { defineConfig } from "vitest/config";

/**
 * Unit tests are pure (no network) — every one of them injects a `fetchImpl`
 * stub. The live leg (`test/live-store.test.ts`) talks to a real Medusa v2
 * backend over https with a read-only-intended secret API key, and skips
 * cleanly when ~/.config/loxep/medusa.env is absent (CI, fresh clone). See
 * that file's header for the harness it expects and the six provider claims
 * it pins.
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
