import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * Connections-table sync toggles (loxep-bdt): order sync and purchase sync,
 * the two per-connection dropdown actions `settings.spec.ts` never exercised.
 *
 * ## The honesty boundary this spec draws, deliberately
 *
 * Order sync is real, end to end, for a WooCommerce store: `isOrderSyncEligible`
 * (`order-sync-cell.tsx`) says any ACTIVE woocommerce connection qualifies, no
 * consent involved, and `createStoreConnection` writes an active row with no
 * live network call — so this harness can create a store, flip the toggle, and
 * watch the real `enableOrderSync`/`disableOrderSync` server functions and the
 * real status badge round-trip, with nothing faked.
 *
 * Purchase sync is eBay-only and gated on completed OAuth consent
 * (`isPurchaseSyncEligible` in `purchase-sync-cell.tsx`) — and eBay's own
 * "Add account" action is ADDITIONALLY gated on an application keyset
 * (`integrations-catalog.ts`'s `blockedReason`) that nothing in this e2e
 * harness ever configures (no eBay references anywhere under `apps/web/e2e/`
 * before this file, and `harness.md` provisions no keyset). Completing real
 * consent needs eBay's live sign-in and a sandbox test user, which a headless
 * CI browser cannot do, and faking the granted-scopes state with a direct DB
 * write is NOT this codebase's convention — `books.spec.ts`/`inventory.spec.ts`
 * seed every fixture through the UI, never the database, and this spec follows
 * that precedent rather than breaking it.
 *
 * So the purchase-sync coverage here is exactly what IS honest without a
 * consented eBay account: the column's "not applicable" rendering for a
 * provider that isn't eBay, the dropdown correctly never offering the action
 * for that row, and the prior gate — eBay's "Add account" action itself
 * disabled with an explanatory hint — that is WHY no consented fixture can
 * exist in this harness at all. The residual gap (an actual eBay purchase-sync
 * enable/disable round trip) is recorded on loxep-bdt rather than faked here.
 */

const runId = Date.now();
const wooStoreName = `E2E Woo Store ${runId}`;

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

function tableRow(page: Page, text: string): Locator {
  return page.getByRole('row').filter({ hasText: text });
}

/**
 * The "Purchase sync" cell, by column position (`columns.tsx`: name, status,
 * entity, credentials, orderSync, purchaseSync, …) rather than by text — its
 * "not applicable" glyph (`—`) is IDENTICAL to the "Last error" column's own
 * empty state, so text alone cannot disambiguate them within one row.
 */
function purchaseSyncCell(row: Locator): Locator {
  return row.getByRole('cell').nth(5);
}

test('admin toggles order sync on a WooCommerce connection, badge round-trips', async ({
  page
}) => {
  await page.goto('/settings/connections');

  await page.getByRole('button', { name: 'Add WooCommerce store' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Add WooCommerce store')).toBeVisible();
  await dialog.getByLabel('Store name *').fill(wooStoreName);
  await dialog.getByLabel('Store URL *').fill(`https://e2e-woo-${runId}.example.test`);
  await dialog.getByLabel('Consumer key *').fill(`ck_e2e_${runId}`);
  await dialog.getByLabel('Consumer secret *').fill(`cs_e2e_${runId}`);
  await dialog.getByRole('button', { name: 'Connect store' }).click();
  await expect(dialog).toBeHidden();

  const row = tableRow(page, wooStoreName);
  await expect(row).toBeVisible();
  // Freshly created, active, no sync configured yet: order sync starts off,
  // and purchase sync is not a WooCommerce concept at all (see the module doc).
  await expect(row.getByText('Off', { exact: true })).toBeVisible();
  await expect(purchaseSyncCell(row)).toHaveText('—');

  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Enable order sync' }).click();
  await expect(page.getByText('Order sync enabled')).toBeVisible();
  // No successful sync has run yet — the badge shows the bare "Syncing" state
  // (see OrderSyncStatusCell), tolerant of a date suffix if a poll landed
  // between the toggle and this assertion.
  await expect(row.getByText(/^Syncing/)).toBeVisible();
  // Purchase sync stays "not applicable" throughout: this row is never eBay.
  await expect(purchaseSyncCell(row)).toHaveText('—');

  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Disable order sync' }).click();
  await expect(page.getByText('Order sync disabled')).toBeVisible();
  await expect(row.getByText('Off', { exact: true })).toBeVisible();
});

test('a non-eBay connection never offers the purchase-sync action', async ({ page }) => {
  await page.goto('/settings/connections');
  const row = tableRow(page, wooStoreName);
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Enable order sync' })).toBeVisible();
  // supportsPurchaseSync(connection) is false for woocommerce (cell-action.tsx),
  // so neither purchase-sync menu item ever renders for this row.
  await expect(page.getByRole('menuitem', { name: /purchase sync/i })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('eBay account creation — and so any consented purchase-sync fixture — is blocked without an application keyset', async ({
  page
}) => {
  await page.goto('/settings/connections');
  const ebaySection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'eBay' }) });
  const addButton = ebaySection.getByRole('button', { name: 'Add eBay account' });

  await expect(addButton).toBeDisabled();
  // Either "no admin has configured a keyset" or "a keyset exists but isn't
  // set up yet" — both branches of blockedReason (integrations-catalog.ts)
  // name the same missing prerequisite, and either is the honest reason a
  // real, consented eBay row (and therefore a real purchase-sync toggle)
  // cannot exist in this harness.
  await expect(ebaySection.getByText(/eBay application keyset/)).toBeVisible();
});
