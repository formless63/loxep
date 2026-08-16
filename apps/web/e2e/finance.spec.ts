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
  await dialog.getByLabel('Payee (free text)').fill(payeeName);
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
  // The re-record dialog opens automatically and its description references
  // the voided row, so `hasText: 'Void'` matches it too — assert succession
  // (the void form's Reason field is gone) rather than dialog absence.
  await expect(page.getByLabel('Reason *')).toBeHidden();

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

/**
 * Void-and-promote (loxep-ytu; `flipping-lifecycle-design.md`'s open
 * question 2): the OTHER correction path alongside void-and-re-record above,
 * for the case where a recorded expense turns out to have bought goods for
 * resale. "Promote to acquisition" opens the SAME acquisition-lot picker the
 * document-review panel uses (create-new-or-attach), then a reason-collecting
 * confirm dialog; on success the expense is voided AND `acquisition_cost_id`
 * is stamped in the same write, visible on the expense-detail page's
 * "Voided and promoted to a lot's cost" alert with a "View the lot" link.
 */
test('a recorded expense offers promote-to-acquisition, voiding it and creating a lot cost', async ({
  page
}) => {
  const promotePayeeName = `E2E Promote Payee ${runId}`;
  const promoteCategory = `e2e-promote-${runId}`;
  const lotTitle = `E2E Promote Lot ${runId}`;

  await page.goto('/finance/expenses');
  await page.getByRole('button', { name: 'New expense' }).first().click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Amount *').fill('89.00');
  await createDialog.getByLabel('Category *').fill(promoteCategory);
  await createDialog.getByLabel('Payee (free text)').fill(promotePayeeName);
  await createDialog.getByRole('button', { name: 'Save' }).click();
  await expect(createDialog).toBeHidden();

  const row = tableRow(page, promotePayeeName);
  await row.getByRole('link').first().click();
  await page.waitForURL('**/finance/expenses/*');

  await page.getByRole('button', { name: /Promote to acquisition/ }).click();
  const lotPickerDialog = page.getByRole('dialog').filter({ hasText: 'Choose a lot' });
  await expect(lotPickerDialog).toBeVisible();
  await lotPickerDialog.getByRole('tab', { name: 'Create a new draft' }).click();
  await lotPickerDialog.getByLabel('Title *').fill(lotTitle);
  await lotPickerDialog.getByRole('button', { name: /Create & attach/ }).click();
  await expect(lotPickerDialog).toBeHidden();

  const promoteDialog = page.getByRole('dialog').filter({ hasText: 'Promote' });
  await expect(promoteDialog).toBeVisible();
  await promoteDialog.getByLabel('Reason *').fill(`e2e promotion ${runId}`);
  await promoteDialog.getByRole('button', { name: 'Promote to acquisition cost' }).click();
  await expect(promoteDialog).toBeHidden();

  // Voided, never deleted — the same posture void-and-re-record takes.
  await expect(page.getByText('Void', { exact: true })).toBeVisible();
  await expect(page.getByText("Voided and promoted to a lot's cost")).toBeVisible();
  await expect(page.getByRole('link', { name: 'View the lot' })).toBeVisible();

  // No stray "Void & re-record"/"Promote to acquisition" affordance survives
  // on an already-void row — both are gated on status === 'recorded'.
  await expect(page.getByRole('button', { name: /Void & re-record/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Promote to acquisition/ })).toHaveCount(0);
});

/**
 * The Invoice Ninja estate browser (loxep-47o.8) — the FIRST estate page
 * outside `/infrastructure`, so this is also the FIRST end-to-end proof that
 * Rule P1's workspace parameter actually routes to `/finance` rather than
 * `/infrastructure`: same Rule N1 "Open estate" row action on
 * `/settings/connections`, landing on `/finance/estate/$connectionId`
 * (never `/infrastructure/estate/...`).
 *
 * Mirrors `infrastructure.spec.ts`'s Gatus estate test's shape exactly:
 * Clients/Invoices make REAL provider calls against this fake-credential,
 * fake-URL fixture and are expected to render their own honesty state (Rule
 * P13) — this harness has no live Invoice Ninja instance to reach, so only
 * the section TITLES are asserted, never a specific error/blocked wording
 * that would couple this spec to network-timing or DNS-resolution details.
 * Zero write affordances are asserted absent: this page never grows a
 * create/edit/send button of any kind, unlike `/finance/overview`'s
 * existing push-draft dialog, which this page never mounts.
 */
test("the connections row action opens an Invoice Ninja connection's estate page", async ({
  page
}) => {
  const name = `E2E Invoice Ninja estate ${runId}`;

  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Invoice Ninja instance' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Instance name *').fill(name);
  await connectionDialog.getByLabel('Instance URL *').fill('https://billing.example.test');
  await connectionDialog.getByLabel('API token *').fill(`e2e-fake-token-${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect instance' }).click();
  await expect(connectionDialog).toBeHidden();

  await page.getByRole('textbox', { name: 'Account' }).fill(name);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Open estate' }).click();

  await page.waitForURL('**/finance/estate/**');
  expect(page.url()).not.toContain('/infrastructure/estate/');
  const estateMain = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
  await expect(estateMain.getByText(name, { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Invoice Ninja', { exact: true }).first()).toBeVisible();
  await expect(estateMain.getByText('Clients', { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Invoices', { exact: true })).toBeVisible();

  // Zero write affordances anywhere on this page — no create/edit/send
  // button of any kind, for either section.
  await expect(
    estateMain.getByRole('button', { name: /new client|new invoice|edit|send|mark sent/i })
  ).toHaveCount(0);
});
