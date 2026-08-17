import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * The /dashboard sidebar launchpad (loxep-koj): the Workspaces group
 * (derived from `config/workspaces.ts`, excluding Dashboard itself and the
 * `/starter` donor reference) and the Pinned group (localStorage-backed,
 * PROVISIONAL per the bead — no server function, no migration).
 *
 * The admin session is established once via the real magic-link flow and
 * reused through storageState, the same pattern `settings.spec.ts` uses.
 */

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({
    baseURL: process.env['LOXEP_E2E_BASE_URL'] ?? 'http://localhost:3093',
    // The browser fixture applies this file's `test.use` options to newPage,
    // but the admin state file does not exist until this hook writes it.
    storageState: undefined
  });
  await signInWithMagicLink(page, ADMIN_EMAIL);
  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
  await page.close();
});

test.use({ storageState: ADMIN_STORAGE_STATE });

test('the dashboard Workspaces group lists other workspaces and navigates to their default page', async ({
  page
}) => {
  await page.goto('/dashboard/overview');

  await expect(page.getByText('Workspaces')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Market', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Finance', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Infrastructure', exact: true })).toBeVisible();
  // Dashboard itself and the /starter donor reference never appear as
  // launchpad entries.
  await expect(page.getByRole('link', { name: 'Starter Reference' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Market', exact: true }).click();
  await page.waitForURL('**/market/overview');
});

test('pinning a page from another workspace surfaces it on the dashboard Pinned group', async ({
  page
}) => {
  // Pin "Monitors" from the Market sidebar.
  await page.goto('/market/monitors');
  const pinButton = page.getByRole('button', { name: 'Pin Monitors' });
  await pinButton.click();
  await expect(page.getByRole('button', { name: 'Unpin Monitors' })).toBeVisible();

  // The dashboard's own Pinned group now lists it, tagged with its owning
  // workspace, and clicking it navigates straight there.
  await page.goto('/dashboard/overview');
  const pinnedLink = page.getByRole('link', { name: 'Monitors', exact: true });
  await expect(pinnedLink).toBeVisible();
  await expect(pinnedLink.getByText('Market')).toBeVisible();

  await pinnedLink.click();
  // Trailing ** because the monitors table immediately writes its URL table
  // state (?page=1...) on arrival — a bare glob never observes the naked URL.
  await page.waitForURL('**/market/monitors**');

  // Clean up: unpin so this fixture does not leak into later runs sharing
  // the same browser storage state.
  await page.getByRole('button', { name: 'Unpin Monitors' }).click();
  await page.goto('/dashboard/overview');
  await expect(page.getByText('Pin pages from any sidebar for one-tap access')).toBeVisible();
});
