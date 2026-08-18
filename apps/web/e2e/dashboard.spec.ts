import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * The /dashboard sidebar launchpad (loxep-koj): the Workspaces group
 * (derived from `config/workspaces.ts`, excluding Dashboard itself and the
 * `/starter` donor reference) and the Pinned group — durable per-user
 * storage in PostgreSQL (loxep-lbj), replacing loxep-koj's original
 * localStorage-only persistence. Assertions below are behavior-only (button
 * roles, visible text); nothing here depends on where a pin is persisted.
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

/**
 * Market item detail charts (loxep-48v): watch-count trend, sell-through
 * velocity, and landed price (price + shipping) — three of the five
 * `marketplace_item_observations` columns that were captured but had zero
 * readers before this pass. No spec seeds a real marketplace item (items
 * only arrive via a live provider poll, which this harness does not run),
 * so this test skips itself when the watched-items table is empty rather
 * than asserting on data that cannot exist here; when an item DOES exist
 * (e.g. a harness that has run a real poll), it asserts the new chart
 * cards render — the "no data yet" state counts as rendering.
 */
test('the market item detail page renders the watch-count, sell-through, and landed-price series (or their honest empty states) when an item exists', async ({
  page
}) => {
  await page.goto('/market/items');
  await expect(page.getByRole('heading', { name: 'Watched items' })).toBeVisible();

  // Scoped to main and settled first: a bare page-wide locator also matches
  // chrome outside the table and counts hidden nodes, so it reported items
  // this harness does not have and then timed out clicking one.
  await page.waitForLoadState('networkidle');
  const itemLinks = page
    .getByRole('main')
    .locator("a[href^='/market/items/']")
    .filter({ visible: true });
  const itemCount = await itemLinks.count();
  test.skip(itemCount === 0, 'no marketplace items seeded in this e2e environment');

  await itemLinks.first().click();
  await page.waitForURL('**/market/items/**');

  // Each chart is its own Card (CardTitle renders a styled <div>, not a
  // heading role — plain text assertions match how these render); the
  // empty state ("No ... yet.") IS the rendered state when the item has no
  // history for that series, so these hold whether or not the item has
  // real observations.
  await expect(page.getByText('Price history')).toBeVisible();
  await expect(page.getByText('Watch count')).toBeVisible();
  await expect(page.getByText('Sell-through velocity')).toBeVisible();
  await expect(page.getByText('Feedback score')).toBeVisible();
  await expect(page.getByText('Feedback %')).toBeVisible();
});
