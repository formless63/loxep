import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * /inventory workspace critical flow (loxep-dgf.2, M2): create an
 * acquisition (the direct path — "create acquisition via the market handoff
 * or direct" per the milestone's acceptance), add an item to it through the
 * intake form, confirm the row lands, in `Intake` status, in the stock
 * table, then complete the review and confirm it moves to `Available`.
 * Mirrors `finance.spec.ts`'s pattern for M1.
 *
 * `createAcquisition`/`createInventoryItem` (`@/server/inventory-functions.ts`)
 * call the real `@loxep/inventory` services (`createAcquisitionsService`,
 * `createItemsService`) through `@/server/admin.ts`, registered there behind
 * the same `@vite-ignore` lazy-module pattern `@loxep/market` uses (see
 * `admin.ts`'s `getInventoryModule` doc) — exactly the shape
 * `QuickExpenseDialog`'s create flow exercises for `/finance`.
 *
 * The create-time receipt movement used to promote a new item straight past
 * `intake` (a real bug this spec's first run caught — `deriveItemStatus`,
 * `packages/inventory/src/movements.ts`, now preserves `intake` while stock
 * remains, the same way it already preserved `listed`/`reserved`). Leaving
 * `intake` is `completeItemIntakeReview`'s job (`itemsService.completeIntakeReview`,
 * `packages/inventory/src/items.ts`) — a status-only, one-way transition
 * exercised here from the item detail page rather than the intake-filtered
 * list, because completing review removes the row from a `status=intake`
 * filtered view (it no longer matches), which would make "still visible,
 * now Available" an untestable assertion on that view.
 */

const runId = Date.now();
const acquisitionTitle = `E2E Estate Sale ${runId}`;
const itemLabel = `E2E brass lamp ${runId}`;

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

test('creates an acquisition, adds an item to it, and the item lands in the stock table', async ({
  page
}) => {
  await page.goto('/inventory/acquisitions');
  await expect(page.getByRole('heading', { name: 'Acquisitions' })).toBeVisible();

  await page.getByRole('button', { name: 'New acquisition' }).click();
  const acquisitionDialog = page.getByRole('dialog');
  await expect(acquisitionDialog.getByText('New acquisition')).toBeVisible();
  await acquisitionDialog.getByLabel('Title *').fill(acquisitionTitle);
  // Source (thrift/retail default) and currency (USD default) keep their
  // quick-entry defaults — mirrors `QuickExpenseDialog`'s reasoning.
  await acquisitionDialog.getByRole('button', { name: 'Create' }).click();
  await expect(acquisitionDialog).toBeHidden();

  const lotRow = tableRow(page, acquisitionTitle);
  await expect(lotRow).toBeVisible();
  await lotRow.getByRole('link').first().click();
  await page.waitForURL('**/inventory/acquisitions/*');

  await page.getByRole('button', { name: 'Add item to this lot' }).click();
  const intakeDialog = page.getByRole('dialog');
  await expect(intakeDialog.getByText('Add item to intake')).toBeVisible();
  await intakeDialog.getByLabel('Description *').fill(itemLabel);
  await intakeDialog.getByRole('button', { name: 'Add item' }).click();
  await expect(intakeDialog).toBeHidden();

  // The new row shows up in this lot's own item list, in Intake status.
  const lotItemRow = tableRow(page, itemLabel);
  await expect(lotItemRow).toBeVisible();
  await expect(lotItemRow.getByText('Intake')).toBeVisible();

  // And the intake review queue (`/inventory/stock?status=intake`, reachable
  // from the "Intake review" nav entry) shows the same row, with a "Complete
  // review" action now that it isn't silently skipping intake.
  await page.goto('/inventory/intake');
  await page.waitForURL('**/inventory/stock**');
  const stockRow = tableRow(page, itemLabel);
  await expect(stockRow).toBeVisible();
  await expect(stockRow.getByText('Intake')).toBeVisible();
  await expect(stockRow.getByRole('button', { name: 'Complete review' })).toBeVisible();

  // Complete review from the item's own detail page: the intake-filtered
  // list drops the row the moment it leaves `intake`, so asserting the
  // Available badge has to happen somewhere that keeps showing the item
  // regardless of status.
  await stockRow.getByRole('link').first().click();
  await page.waitForURL('**/inventory/stock/*');
  await expect(page.getByText('Intake', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Complete review' }).click();
  await expect(page.getByText('Available', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete review' })).toHaveCount(0);

  // --- M3 enrichment (loxep-dgf.3): set package dimensions/weight and a
  // typed specific on the same item, from its detail page's Enrichment
  // panel and Specifics editor (`item-enrichment-panel.tsx`,
  // `specifics-editor.tsx`). Image upload is intentionally NOT covered here
  // — it needs a real file fixture and browser file-input automation the
  // rest of this suite does not set up; the upload/serve ROUTES are covered
  // by the package-level services and the route registration, not by e2e.
  await page.getByLabel('Package weight (g)').fill('850');
  await page.getByLabel('Length (mm)').fill('200');
  await page.getByLabel('Width (mm)').fill('150');
  await page.getByLabel('Height (mm)').fill('100');
  await page.getByRole('button', { name: 'Save enrichment' }).click();

  // Reload to prove the write round-tripped through `itemsService.update()`
  // rather than only reflecting locally-typed form state.
  await page.reload();
  await expect(page.getByLabel('Package weight (g)')).toHaveValue('850.000000');
  await expect(page.getByLabel('Length (mm)')).toHaveValue('200.000000');
  await expect(page.getByLabel('Width (mm)')).toHaveValue('150.000000');
  await expect(page.getByLabel('Height (mm)')).toHaveValue('100.000000');

  const specificName = `Condition detail ${runId}`;
  await page.getByLabel('Name').fill(specificName);
  await page.getByLabel('Value').fill('Excellent');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const specificRow = page.getByText(specificName).locator('..');
  await expect(specificRow).toContainText('Excellent');
});
