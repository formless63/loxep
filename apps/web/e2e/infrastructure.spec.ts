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

  // The stat tiles render even with nothing declared.
  await expect(page.getByText('Managed domains')).toBeVisible();
  await expect(page.getByText('Hosting targets')).toBeVisible();
  await expect(page.getByText('Unresolved drift')).toBeVisible();

  // Nav cards to the three sub-surfaces.
  await expect(page.getByRole('link', { name: /Domains/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Fleet$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Reconcile runs/ })).toBeVisible();
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
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('link', { name: targetName })).toBeVisible();
  await page.getByRole('link', { name: targetName }).click();
  await page.waitForURL('**/infrastructure/fleet/**');

  await expect(page.getByText('No tokens minted for this host')).toBeVisible();
  await expect(page.getByText('No companion tool linked yet')).toBeVisible();
  await expect(page.getByText('None yet.')).toBeVisible(); // "Domains pointing here (0)"
});

test('reconcile runs list shows the empty state', async ({ page }) => {
  await page.goto('/infrastructure/runs');
  await expect(page.getByRole('heading', { name: 'Reconcile runs' })).toBeVisible();
  await expect(page.getByText('No reconcile runs yet')).toBeVisible();
});
