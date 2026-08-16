import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * `/infrastructure` workspace render + panel empty-states (Phase 7 milestone
 * 3, loxep-lmy.3). No DNS/mail provider connection exists in the e2e
 * harness, so this spec asserts the honest "nothing declared yet" surfaces
 * rather than a live provisioning flow — the harness has no live provider to
 * provision against, and `/infrastructure/domains/new` explicitly refuses to
 * submit without a DNS connection selected (there being none to pick).
 *
 * Mirrors `settings.spec.ts`'s admin-session setup.
 */

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({
    baseURL: process.env['LOXEP_E2E_BASE_URL'] ?? 'http://localhost:3093',
    storageState: undefined
  });
  await signInWithMagicLink(page, ADMIN_EMAIL);
  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
  await page.close();
});

test.use({ storageState: ADMIN_STORAGE_STATE });

test('infrastructure overview renders with an empty fleet and no domains needing attention', async ({
  page
}) => {
  await page.goto('/infrastructure/overview');
  await expect(page.getByRole('heading', { name: 'Infrastructure' })).toBeVisible();

  // The stat tiles render even with nothing declared. Exact match: the
  // fleet nav card's description also starts with "Hosting targets …".
  await expect(page.getByText('Managed domains', { exact: true })).toBeVisible();
  await expect(page.getByText('Hosting targets', { exact: true })).toBeVisible();
  await expect(page.getByText('Unresolved drift', { exact: true })).toBeVisible();

  // Nav cards to the three sub-surfaces — scoped to the page body, since the
  // sidebar carries links with the same accessible names.
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /Domains/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /Fleet/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /Reconcile runs/ })).toBeVisible();
});

test('domains list shows the empty state with a New domain action', async ({ page }) => {
  await page.goto('/infrastructure/domains');
  await expect(page.getByRole('heading', { name: 'Domains' })).toBeVisible();
  await expect(page.getByText('No managed domains yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New domain' })).toBeVisible();
});

test('the new-domain wizard warns when no DNS connection exists yet', async ({ page }) => {
  await page.goto('/infrastructure/domains/new');
  await expect(page.getByRole('heading', { name: 'Declare a domain' })).toBeVisible();
  // No DNS connection exists in the harness (no live provider), so the
  // wizard refuses to render a form with nothing to select — the honest
  // empty state, not a submit button that would fail server-side.
  await expect(page.getByText('No DNS connection yet')).toBeVisible();
});

test('fleet list shows the empty state with a New hosting target action', async ({ page }) => {
  await page.goto('/infrastructure/fleet');
  await expect(page.getByRole('heading', { name: 'Fleet' })).toBeVisible();
  await expect(page.getByText('No hosting targets yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New hosting target' })).toBeVisible();
});

test('creates a hosting target with no fronting node, then shows it with an empty tokens/companion-links state', async ({
  page
}) => {
  const targetName = `e2e-target-${Date.now()}`;

  await page.goto('/infrastructure/fleet');
  await page.getByRole('button', { name: 'New hosting target' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('New hosting target')).toBeVisible();
  await dialog.getByLabel('Name *').fill(targetName);
  // `hosting_targets_addressable_check`: a direct/reverse-proxy target must
  // carry an address (or a fronting node) — the dialog refuses without one.
  await dialog.getByLabel('IPv4 address').fill('203.0.113.77');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('link', { name: targetName })).toBeVisible();
  await page.getByRole('link', { name: targetName }).click();
  await page.waitForURL('**/infrastructure/fleet/**');

  await expect(page.getByText('No tokens minted for this host')).toBeVisible();
  await expect(page.getByText('No companion tool linked yet')).toBeVisible();
  await expect(page.getByText('None yet.')).toBeVisible(); // "Domains pointing here (0)"

  // loxep-y64 slice 3: the operator-confirmed attach picker over Beszel's
  // discovery sweep. The e2e harness has no live Beszel hub (no fleet
  // credentials exist on this box — see that bead's report), so nothing has
  // ever discovered a system: this asserts the honest empty state rather
  // than a seeded discovery flow, which is covered at the service level
  // instead (`packages/app/test/fleet-health.test.ts`'s "beszel discovery"
  // suite, `packages/domain/test/resource-links.test.ts`'s
  // `listUnattachedByProvider` tests).
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Attach discovered Beszel system' }).click();
  const attachDialog = page.getByRole('dialog');
  await expect(attachDialog.getByText('Attach a discovered Beszel system')).toBeVisible();
  await expect(attachDialog.getByText('No discovered Beszel systems')).toBeVisible();
  await expect(attachDialog.getByRole('button', { name: 'Attach' })).toBeDisabled();
  await attachDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(attachDialog).toBeHidden();

  // loxep-v5r.3: the generic companion-link service, exercised end to end —
  // "Add tool link" writes external_resources + resource_links (no
  // credential, no adapter). Scoped to `main` and exact-matched throughout:
  // this file has been bitten by strict-mode ambiguity before (sidebar nav
  // vs. page body sharing accessible names).
  const linkLabel = `e2e-link-${Date.now()}`;
  await main.getByRole('button', { name: 'Add tool link' }).click();
  const linkDialog = page.getByRole('dialog');
  await expect(linkDialog.getByText('Add a companion link')).toBeVisible();
  await linkDialog.getByLabel('Provider *').fill('gatus');
  await linkDialog.getByLabel('Kind *').fill('dashboard');
  await linkDialog.getByLabel('URL *').fill('https://gatus.example.test/status');
  await linkDialog.getByLabel('Label').fill(linkLabel);
  await linkDialog.getByLabel('Purpose *').fill('status_page');
  await linkDialog.getByRole('button', { name: 'Add link' }).click();
  await expect(linkDialog).toBeHidden();

  await expect(main.getByText('No companion tool linked yet')).toHaveCount(0);
  await expect(main.getByText(linkLabel, { exact: true })).toBeVisible();
  await expect(main.getByText('gatus · dashboard · status_page', { exact: false })).toBeVisible();

  // Removing the link restores the honest empty state.
  await main.getByRole('button', { name: `Remove ${linkLabel} link` }).click();
  await expect(main.getByText('No companion tool linked yet')).toBeVisible();
  await expect(main.getByText(linkLabel, { exact: true })).toHaveCount(0);
});

test('reconcile runs list shows the empty state', async ({ page }) => {
  await page.goto('/infrastructure/runs');
  await expect(page.getByRole('heading', { name: 'Reconcile runs' })).toBeVisible();
  await expect(page.getByText('No reconcile runs yet')).toBeVisible();
});

/**
 * The Pangolin chain design's M4 (loxep-acj.4) apply affordance, rendered.
 *
 * ## The honesty boundary this test draws, deliberately (matching
 * `connections.spec.ts`'s own precedent for documenting a gap rather than
 * faking it)
 *
 * `createStoreConnection` writes a Cloudflare account row with no live
 * network call (the same "no live call" property `connections.spec.ts`'s
 * WooCommerce fixture relies on), and `createManagedDomain` writes intent +
 * enqueues without awaiting a provider — so this test CAN reach a real
 * `/infrastructure/domains/$name` page with nothing faked. What it cannot
 * reach is a `proxy_resources` row with real data: milestone 2
 * (loxep-acj.2) shipped the chain's third link "visibility only" — there is
 * NO UI anywhere that creates a `proxy_resources` row, so no e2e flow
 * (however much connection/domain setup it does first) can ever populate
 * one without a direct database write, which is not this suite's
 * convention (`books.spec.ts`/`inventory.spec.ts`/`connections.spec.ts` all
 * seed exclusively through the UI). So this is the affordance's
 * MOST-CONSERVATIVE reachable state — "nothing declared, so nothing to
 * apply" — proving the panel and its Apply control render correctly
 * (no crash, no stray button) rather than the deeper
 * `writePolicyTier: 'read_only'` blocked-alert variant, which needs data
 * this harness has no path to create.
 */
test('a domain with no declared proxy resource shows the honest empty state and no Apply control', async ({
  page
}) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  // A Cloudflare connection, so the "New domain" wizard has a DNS connection
  // to pick — no live token validation happens (see the module doc above).
  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Cloudflare account' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Account name *').fill(`E2E Cloudflare ${runId}`);
  await connectionDialog.getByLabel('API token *').fill(`cf_e2e_token_${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect account' }).click();
  await expect(connectionDialog).toBeHidden();

  const domainName = `e2e-proxy-${runId}.test`;
  await page.goto('/infrastructure/domains/new');
  await page.getByLabel('Domain name *').fill(domainName);
  await page.getByRole('combobox', { name: /^DNS connection/ }).click();
  await page.getByRole('option', { name: `E2E Cloudflare ${runId}` }).click();
  await page.getByRole('button', { name: 'Declare domain' }).click();
  await page.waitForURL('**/infrastructure/domains/**');

  await expect(page.getByText('Proxy resources', { exact: true })).toBeVisible();
  await expect(page.getByText('No proxy resource declared')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply' })).toHaveCount(0);
});
