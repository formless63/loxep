import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Loxep critical-flow e2e coverage.
 *
 * There is deliberately no `webServer` block: the suite runs against an
 * already-running **built** Loxep instance (`node bin/loxep.ts start
 * --mode=all` on port 3093) plus a Mailpit SMTP sink for magic-link
 * capture. See `e2e/harness.md` for the exact harness setup — scratch
 * database, migration, environment, and server start commands.
 *
 * Tests share one database, one server, and one Mailpit mailbox, so the
 * suite runs single-worker/serial by design. Retries stay at 0 locally so
 * flakes surface instead of being papered over.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: process.env['LOXEP_E2E_BASE_URL'] ?? 'http://localhost:3093',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
