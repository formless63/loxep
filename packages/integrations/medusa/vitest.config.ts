import { defineConfig } from "vitest/config";

/**
 * Unit tests are pure (no network) — every one of them injects a `fetchImpl`
 * stub. The live leg (`test/live-store.test.ts`) would talk to a real
 * Medusa v2 backend with a read-only-intended secret API key and skips
 * cleanly when ~/.config/loxep/medusa.env is absent — which it always is in
 * this environment, since no live Medusa instance exists here. See the
 * module doc and the "Live-verify Medusa adapter against a real instance"
 * follow-up bead.
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
