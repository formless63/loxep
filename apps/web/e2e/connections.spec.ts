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
 *
 * ## Why these tests are no longer a race with the worker (loxep-6i1)
 *
 * Turning order sync on creates a `woo_orders` monitor target that is due
 * immediately, and the store URL these fixtures use is deliberately
 * unreachable — so whenever `market.dispatch-due-monitors` (a one-minute cron)
 * claimed that target inside a test window, the poll failed,
 * `recordConnectionFailure` flipped the connection `active` → `error`, and
 * assertions that silently assumed `active` broke. That is correct product
 * behaviour, not a bug to design around, so nothing here suppresses the
 * dispatcher. Instead the coupling is gone on both sides:
 *
 * - the Order-sync column now reports the order-sync TARGET's state once one
 *   exists, not the connection's health (see `OrderSyncStatusCell`), so
 *   `Off`/`Syncing` mean the same thing whether or not a poll has failed;
 * - the purchase-sync test never enables order sync, so its row has no target
 *   to poll at all.
 *
 * Both tests also build their own store, so neither can cascade into the
 * other. The suite is still single-worker against one shared database.
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

function tableRow(page: Page, text: string): Locator {
  return page.getByRole('row').filter({ hasText: text });
}

/**
 * Filter the unified connections table down to rows matching `text` via the
 * toolbar's "Account" search input, then return the (now guaranteed page-one)
 * row locator (loxep-5is).
 *
 * The table pages at 10 rows and this spec's WooCommerce fixtures accumulate
 * across every run against a reused scratch database — recreating the
 * database between runs already avoids it, but a lookup that only searches
 * whatever rows are CURRENTLY RENDERED (a plain `tableRow`) still falls off
 * page one once enough prior runs' fixtures pile up, and fails with a
 * confusing row-not-found that reads like a selector bug. Every fixture name
 * this spec creates is unique (`createWooStore`'s `Date.now()` + random
 * suffix), so filtering by that exact name is guaranteed to leave at most
 * this run's own row(s) — an honest use of the toolbar, not a workaround.
 */
async function filteredRow(page: Page, text: string): Promise<Locator> {
  await page.getByRole('textbox', { name: 'Account' }).fill(text);
  const row = tableRow(page, text);
  await expect(row).toBeVisible();
  return row;
}

/**
 * The "Purchase sync" sub-cell inside the unified table's merged "Sync"
 * column, by `data-testid` (`columns.tsx`'s `SyncSummaryCell`) rather than
 * column position or text — with credential state, entity, and sync merged
 * into a handful of composite columns (loxep-4t7), a positional index is
 * fragile (it shifts if a column is reordered or a default-hidden one is
 * toggled), and the "not applicable" glyph (`—`) it renders is IDENTICAL to
 * several other cells' own empty state, so text alone cannot disambiguate
 * it within one row either.
 */
function purchaseSyncCell(row: Locator): Locator {
  return row.getByTestId('purchase-sync-status');
}

/**
 * Create one WooCommerce store through the UI and return its name.
 *
 * Each test that needs a store calls this itself rather than sharing a
 * module-level fixture (loxep-6i1). A module-level `runId = Date.now()` used
 * to name a store that only the FIRST test created, so when that test failed
 * Playwright tore the worker down, re-imported this file with a fresh `runId`,
 * and every later test hunted for a store name that had never existed —
 * turning one real failure into a cascade of misleading ones. Per-test
 * fixtures make each test's verdict its own.
 */
async function createWooStore(page: Page): Promise<string> {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `E2E Woo Store ${runId}`;
  // "Add account" actions live in the unified table's toolbar menu now
  // (loxep-4t7), not a per-service section button.
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add WooCommerce store' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Add WooCommerce store')).toBeVisible();
  await dialog.getByLabel('Store name *').fill(name);
  await dialog.getByLabel('Store URL *').fill(`https://e2e-woo-${runId}.example.test`);
  await dialog.getByLabel('Consumer key *').fill(`ck_e2e_${runId}`);
  await dialog.getByLabel('Consumer secret *').fill(`cs_e2e_${runId}`);
  await dialog.getByRole('button', { name: 'Connect store' }).click();
  await expect(dialog).toBeHidden();
  return name;
}

test('admin toggles order sync on a WooCommerce connection, badge round-trips', async ({
  page
}) => {
  await page.goto('/settings/connections');
  const wooStoreName = await createWooStore(page);

  const row = await filteredRow(page, wooStoreName);
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

  // Reopening the row menu right after an action closed it is load-bearing
  // coverage, not incidental (loxep-6i1): the click used to be swallowed by
  // the still-animating closed menu's dismissable layer. Do not insert a
  // wait here to "stabilise" it — a wait would hide exactly the regression
  // this line catches.
  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Disable order sync' }).click();
  await expect(page.getByText('Order sync disabled')).toBeVisible();
  await expect(row.getByText('Off', { exact: true })).toBeVisible();
});

test('a non-eBay connection never offers the purchase-sync action', async ({ page }) => {
  await page.goto('/settings/connections');
  // Its own store, and order sync is deliberately never turned on for it: no
  // order-sync target means no monitor for the dispatcher to poll, so this
  // row's status cannot be flipped to `error` mid-test by the unreachable
  // fixture URL, and "Enable order sync" is guaranteed to be the arm the
  // dropdown renders.
  const wooStoreName = await createWooStore(page);
  const row = await filteredRow(page, wooStoreName);

  await row.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Enable order sync' })).toBeVisible();
  // supportsPurchaseSync(connection) is false for woocommerce (cell-action.tsx),
  // so neither purchase-sync menu item ever renders for this row.
  await expect(page.getByRole('menuitem', { name: /purchase sync/i })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('no consented eBay purchase-sync fixture can exist in this harness', async ({ page }) => {
  await page.goto('/settings/connections');
  // Sections are gone (loxep-4t7): every "Add account" action is one item in
  // the toolbar's "Add connection" menu now.
  await page.getByRole('button', { name: 'Add connection' }).click();
  const addItem = page.getByRole('menuitem', { name: 'Add eBay account' });
  await expect(addItem).toBeVisible();

  // Two honest worlds, both ending in "no consented eBay row exists here":
  // with no application keyset the menu item is disabled and names the
  // missing prerequisite; with the dev-file keyset fallback present (as on
  // a developer box) the item is enabled, but completing consent needs a
  // live eBay OAuth round-trip the harness cannot perform. Either way the
  // table must show no eBay row — the concrete reason the purchase-sync
  // toggle has no real fixture in this suite.
  if ((await addItem.getAttribute('data-disabled')) !== null) {
    await expect(page.getByText(/eBay application keyset/)).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('table').getByRole('row').filter({ hasText: 'eBay' })).toHaveCount(0);
});
