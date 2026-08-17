import { defineConfig, devices } from '@playwright/test';

// Run-stable fixture seed (loxep-wtk): minted once here in the runner
// process before workers spawn; workers inherit the env, so a worker
// restart after a failure re-imports spec modules onto the SAME seed
// instead of minting a new one and orphaning earlier tests' fixtures.
// See e2e/helpers/run-id.ts for the full mechanism.
process.env['LOXEP_E2E_RUN_SEED'] ??= String(Date.now());

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
 *
 * ## `mobile-chromium` (UI overhaul 2026 design §3, rule M6, `loxep-pso`/W5)
 *
 * A second project running ONLY the `@mobile`-tagged subset in
 * `e2e/mobile.spec.ts` (6-8 specs, per M6: sign-in, sidebar-sheet nav, a
 * table scroll + row action, an expense create through the drawer, one
 * estate open, one table filter through the sheet, the topology page) —
 * the regression tripwire for the M1-M5 mobile mechanisms, NOT a second
 * full run of the suite. The desktop `chromium` project stays the
 * completeness gate and explicitly excludes `@mobile` tests (`grepInvert`)
 * so its own count never moves because of this project's specs.
 *
 * Deliberately built from `devices['Desktop Chrome']` (Chromium engine —
 * this is "mobile-chromium", not a WebKit iPhone emulation) with only the
 * specific emulation fields M6 names overridden: viewport pinned to the
 * exact 390x844 iPhone-class size the design specifies (not
 * `devices['iPhone 14']`'s own 390x664 *browser-chrome-subtracted*
 * viewport), plus `hasTouch`/`isMobile`/`deviceScaleFactor` for touch-target
 * and responsive-image behavior. `workers: 1` above is the suite-wide
 * setting and stays true per-project too — both projects still share the
 * one database/server/mailbox.
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
      use: { ...devices['Desktop Chrome'] },
      grepInvert: /@mobile/
    },
    {
      name: 'mobile-chromium',
      testMatch: '**/mobile.spec.ts',
      grep: /@mobile/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 3
      }
    }
  ]
});
