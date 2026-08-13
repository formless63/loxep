import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * /finance workspace critical flow (loxep-dgf.1, M1): quick-entry an expense
 * through the dialog and confirm it lands, recorded, in the expenses table —
 * lighting up `@loxep/accounting`'s `createExpensesService`, which shipped
 * complete with zero callers before this milestone.
 *
 * Recording a spend is session-gated (`requireSession`), not admin-only —
 * this spec reuses the harness's bootstrap-admin storage state only because
 * that is the established reusable-session pattern (`settings.spec.ts`), not
 * because the role matters here.
 */

const runId = Date.now();
const payeeName = `E2E Payee ${runId}`;
const category = `e2e-shipping-${runId}`;

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

test('quick-entry records an expense that appears in the expenses table', async ({ page }) => {
  await page.goto('/finance/expenses');
  await expect(page.getByRole('heading', { name: 'Expenses' })).toBeVisible();

  await page.getByRole('button', { name: 'New expense' }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('New expense')).toBeVisible();
  await dialog.getByLabel('Amount *').fill('42.50');
  await dialog.getByLabel('Category *').fill(category);
  await dialog.getByLabel('Payee').fill(payeeName);
  // Payment (card), currency (USD), and entity (Unattributed) all keep
  // their sensible quick-entry defaults — see `QuickExpenseDialog`.
  await dialog.getByRole('button', { name: 'Save' }).click();

  await expect(dialog).toBeHidden();

  const row = tableRow(page, payeeName);
  await expect(row).toBeVisible();
  await expect(row.getByText(category)).toBeVisible();
  await expect(row.getByText('$42.50')).toBeVisible();
  // Quick entry writes `status: 'recorded'` in one action, never `draft`.
  await expect(row.getByText('Recorded')).toBeVisible();
});

test('a recorded expense offers void-and-re-record, never an edit affordance', async ({ page }) => {
  await page.goto('/finance/expenses');
  const row = tableRow(page, payeeName);
  await row.getByRole('link').first().click();
  await page.waitForURL('**/finance/expenses/*');

  await expect(page.getByRole('button', { name: /Void & re-record/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);

  await page.getByRole('button', { name: /Void & re-record/ }).click();
  const voidDialog = page.getByRole('dialog').filter({ hasText: 'Void' });
  await voidDialog.getByLabel('Reason *').fill(`e2e correction ${runId}`);
  await voidDialog.getByRole('button', { name: 'Void expense' }).click();
  await expect(voidDialog).toBeHidden();

  // Voiding is the correction path, not a delete: the row stays as evidence.
  await expect(page.getByText('Void', { exact: true })).toBeVisible();

  // The re-record dialog opens automatically, pre-filled from the voided row.
  const reRecordDialog = page.getByRole('dialog');
  await expect(reRecordDialog.getByText('Record corrected expense')).toBeVisible();
  // `expenses.amount` is `numeric(20,6)` — the prefill carries the stored
  // six-decimal-scale string, not the table's 2-decimal display format.
  await expect(reRecordDialog.getByLabel('Amount *')).toHaveValue('42.500000');
  await reRecordDialog.getByRole('button', { name: 'Cancel' }).click();
});
