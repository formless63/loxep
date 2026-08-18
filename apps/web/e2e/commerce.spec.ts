import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';
import { runSeed } from './helpers/run-id';

/**
 * /commerce workspace critical flow (loxep-dgf.6, Flipping M6: manual/
 * offline channel listings and the inventory-to-draft bridge). Mirrors
 * `inventory.spec.ts`'s pattern: create an item through `/inventory/stock`'s
 * "Add item" dialog (no acquisition needed — found stock), complete its
 * intake review so it is `Available`, then create a manual listing for it
 * from the item detail page's new Listings panel (`InventoryItemListingsPanel`)
 * and confirm the item shows `Listed` and the listing renders at
 * `/commerce/listings/:id`.
 *
 * Selectors are scoped to `main` (the `SidebarInset`'s landmark, id
 * `main-content`) throughout, because several labels here (`Listed`,
 * `Draft`, the item code) are short enough to also match sidebar/command-
 * palette chrome outside the page content in strict mode.
 */

const runId = runSeed();
const itemLabel = `E2E vintage lamp ${runId}`;

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

function main(page: Page): Locator {
  return page.locator('main#main-content');
}

function tableRow(page: Page, text: string): Locator {
  return main(page).getByRole('row').filter({ hasText: text });
}

test('creates a manual listing for an item and it shows Listed, and the listing renders', async ({
  page
}) => {
  // --- Create the item (found stock, no acquisition) and complete review,
  // following inventory.spec.ts's flow.
  await page.goto('/inventory/stock');
  await expect(main(page).getByRole('heading', { name: 'Stock' })).toBeVisible();

  await main(page).getByRole('button', { name: 'Add item' }).click();
  const intakeDialog = page.getByRole('dialog');
  await expect(intakeDialog.getByText('Add item to intake')).toBeVisible();
  await intakeDialog.getByLabel('Description *').fill(itemLabel);
  await intakeDialog.getByRole('button', { name: 'Add item' }).click();
  await expect(intakeDialog).toBeHidden();

  const stockRow = tableRow(page, itemLabel);
  await expect(stockRow).toBeVisible();
  await expect(stockRow.getByText('Intake')).toBeVisible();

  await stockRow.getByRole('link').first().click();
  await page.waitForURL('**/inventory/stock/*');
  await expect(main(page).getByText('Intake', { exact: true }).first()).toBeVisible();
  await main(page).getByRole('button', { name: 'Complete review' }).click();
  // Scoped to `[data-slot="badge"]`, not plain text: the item detail page's
  // "Listed" DetailRow LABEL (as opposed to its value) is the exact string
  // "Listed" regardless of the item's actual status, which would make a bare
  // `getByText('Listed', { exact: true })` pass before the item is ever
  // listed — the badge is the only place the item's actual status renders.
  const statusBadge = main(page).locator('[data-slot="badge"]');
  await expect(statusBadge.filter({ hasText: 'Available' })).toBeVisible();

  // --- The listings panel: nothing listed yet.
  await expect(main(page).getByText('Not listed anywhere yet.')).toBeVisible();
  await expect(main(page).getByText('Not listed', { exact: true })).toBeVisible();

  // --- Create a manual listing, prefilled for this item.
  await main(page).getByRole('button', { name: 'List this item' }).click();
  const listingDialog = page.getByRole('dialog');
  await expect(listingDialog.getByText('Create manual listing')).toBeVisible();
  // Channel/status/currency keep their quick-entry defaults (Facebook
  // Marketplace, Draft, USD) — mirrors `IntakeForm`'s reasoning.
  await listingDialog.getByLabel('Price').fill('45.00');
  await listingDialog.getByRole('button', { name: 'Create listing' }).click();

  // --- Creation closes the loop by navigating to the created listing
  // (loxep-0l5): the listing detail renders with the item linked back.
  await page.waitForURL('**/commerce/listings/*');
  await expect(main(page).getByText(itemLabel)).toBeVisible();
  await expect(
    main(page).locator('[data-slot="badge"]').filter({ hasText: 'Draft' })
  ).toBeVisible();
  const listingCodeText = await main(page)
    .getByText(/LST-\d{4}-\d{4}/)
    .first()
    .textContent();
  const listingCode = listingCodeText?.match(/LST-\d{4}-\d{4}/)?.[0];
  expect(listingCode).toMatch(/^LST-\d{4}-\d{4}$/);

  // --- Back on the item via the reverse link: the item now shows Listed
  // (badge), and its "Listed" date is no longer "Not listed".
  await main(page).getByRole('link', { name: /^ITM-/ }).click();
  await page.waitForURL('**/inventory/stock/*');
  await expect(statusBadge.filter({ hasText: 'Listed' })).toBeVisible();
  await expect(main(page).getByText('Not listed', { exact: true })).toHaveCount(0);
  await expect(main(page).getByRole('link', { name: /^LST-/ })).toBeVisible();

  // --- And it shows up in the /commerce/listings list.
  await page.goto('/commerce/listings');
  await expect(main(page).getByRole('heading', { name: 'Listings' })).toBeVisible();
  await expect(tableRow(page, listingCode as string)).toBeVisible();

  // --- Synced column (loxep-egl E2): `channel_listings.last_synced_at`
  // is now surfaced (previously dropped from the DTO entirely).
  await expect(main(page).getByRole('columnheader', { name: 'Synced' })).toBeVisible();
});
