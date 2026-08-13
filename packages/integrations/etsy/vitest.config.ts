import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Shared 4-core dev machine: cap file parallelism.
    maxWorkers: 2,
  },
});
