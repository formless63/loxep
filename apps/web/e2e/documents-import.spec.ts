import { Buffer } from 'node:buffer';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * `/finance/import` critical flow (loxep-dgf.4, M4): a CSV of "money I
 * spent" goes upload -> operator-guided column mapping -> dry-run preview ->
 * staged review batch -> confirm into a real, recorded expense. Exercises
 * `@/server/documents-functions.ts`'s `stageCsvImport`/`confirmLinesAsExpense`
 * end to end, and the never-auto-commit rule from the UI side: the staged
 * row is visible and editable BEFORE the "Confirm" click, and only that
 * click produces an expense.
 *
 * The CSV fixture is a small inline buffer (never a real file on disk),
 * `setInputFiles` on the hidden `<input type="file">` — Playwright does not
 * require the input to be visible for this action, unlike `.click()`.
 * Values are synthetic and deliberately DO NOT resemble any real credential
 * or account-number format (a plain description/amount/date/payee row).
 */

const runId = Date.now();
const payeeName = `E2E CSV Vendor ${runId}`;
const category = `e2e-import-${runId}`;

function csvFixture(): Buffer {
  const csv = [
    'Date,Description,Amount,Vendor',
    `2026-03-05,Shipping supplies,24.99,${payeeName}`,
    '2026-03-06,Unreadable row,,'
  ].join('\n');
  return Buffer.from(csv, 'utf8');
}

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
 * Receipt upload (unlike inline CSV staging) writes a media object, which
 * needs a registered storage backend — the harness DB starts with none
 * (`/api/documents/upload` answers 409 no-storage-backend otherwise).
 * Registers a local backend through the real settings flow, idempotently.
 */
async function ensureStorageBackend(page: Page): Promise<void> {
  await page.goto('/settings/storage');
  const registerButton = page.getByRole('button', { name: 'Register backend' });
  await expect(registerButton.first()).toBeVisible();
  if ((await page.getByText('No storage backends').count()) > 0) {
    await registerButton.first().click();
    const storageDialog = page.getByRole('dialog');
    await storageDialog.getByLabel('Name *').fill('e2e-media');
    await storageDialog.getByLabel('Root directory *').fill('/tmp/loxep-e2e-media');
    await storageDialog.getByLabel('Make default backend').click();
    await storageDialog.getByRole('button', { name: 'Register backend' }).click();
    await expect(storageDialog).toBeHidden();
  }
}

/** A minimal valid 1x1 PNG — the upload path only checks MIME/size, it never decodes the image. */
function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}

test('CSV import: upload, map, preview, stage, and confirm a row into a recorded expense', async ({
  page
}) => {
  await page.goto('/finance/import');
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible();

  // The CSV tab is the default; upload the inline fixture.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: `e2e-import-${runId}.csv`,
    mimeType: 'text/csv',
    buffer: csvFixture()
  });

  // Best-guess column mapping pre-fills from the header names — Date/Amount
  // map automatically, so "Preview" is enabled without operator action.
  await expect(page.getByRole('button', { name: 'Preview' })).toBeEnabled();
  await page.getByRole('button', { name: 'Preview' }).click();

  // The dry-run preview shows both rows: one ready, one flagged — the
  // importer never silently drops a row it could not fully read.
  await expect(page.getByText('2 row(s) read')).toBeVisible();
  await expect(page.getByText('1 ready to stage')).toBeVisible();
  await expect(page.getByText('row has no amount')).toBeVisible();

  await page.getByRole('button', { name: /Stage 1 row/ }).click();

  // Staging hands off to the review panel automatically (no navigation —
  // local component state). BOTH rows land as candidates (warn, never drop
  // — the unreadable row stays visible rather than silently vanishing),
  // and neither is confirmed yet.
  await expect(page.getByText('0 of 2 line(s) confirmed')).toBeVisible();
  const stagedRow = tableRow(page, 'Shipping supplies');
  await expect(stagedRow).toBeVisible();
  await expect(stagedRow.getByText('Unresolved')).toBeVisible();

  // The never-auto-commit rule, from the UI side: a staged suggestion is
  // not yet a fact — no expense exists for it until the operator confirms.
  await page.goto('/finance/expenses');
  await expect(tableRow(page, category)).toHaveCount(0);

  // Back on the review queue, the just-staged document is resumable by its
  // original filename.
  await page.goto('/finance/import');
  const queueEntry = page.getByRole('button').filter({ hasText: `e2e-import-${runId}.csv` });
  await expect(queueEntry).toBeVisible();
  await queueEntry.click();
  await expect(page.getByText('0 of 2 line(s) confirmed')).toBeVisible();

  // Confirm — scoped to `main` since the sidebar carries links with
  // overlapping accessible names elsewhere in this app. Only the one row
  // dispositioned "Expense" is ready; the unreadable row (no amount) is
  // not — the "Confirm N as expense" count reflects that.
  const main = page.getByRole('main');
  await main.getByLabel('Category *').fill(category);
  // Payment (card) and Entity (Unattributed) keep their sensible defaults.
  await main.getByRole('button', { name: /Confirm 1 as expense/ }).click();

  await expect(page.getByText('1 of 2 line(s) confirmed')).toBeVisible();
  await expect(tableRow(page, 'Shipping supplies').getByText('Confirmed')).toBeVisible();

  // The confirm action produced a real, recorded expense — the whole point.
  await page.goto('/finance/expenses');
  const expenseRow = tableRow(page, category);
  await expect(expenseRow).toBeVisible();
  await expect(expenseRow.getByText('$24.99')).toBeVisible();
  await expect(expenseRow.getByText('Recorded')).toBeVisible();
});

test('a document with no confirmed lines can be discarded', async ({ page }) => {
  await ensureStorageBackend(page);

  await page.goto('/finance/import');
  await page.getByRole('tab', { name: 'Receipt / invoice' }).click();

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: `e2e-discard-${runId}.png`,
    mimeType: 'image/png',
    buffer: pngFixture()
  });

  await expect(page.getByText('0 of 0 line(s) confirmed')).toBeVisible();
  await page.getByRole('button', { name: 'Discard document' }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByText('Document discarded')).toBeVisible();
});

test('confirming a receipt-backed line attaches the receipt, so it never lands in Missing receipts', async ({
  page
}) => {
  // Regression for loxep-4mg: `confirmLinesAsExpense` used to create the
  // expense without writing the `media_links` row the receipt image needs,
  // so a confirmed, receipt-backed expense read as "missing" on
  // `/finance/overview`'s Missing receipts card despite its image sitting
  // one table away on the `documents` row.
  await ensureStorageBackend(page);

  await page.goto('/finance/import');
  await page.getByRole('tab', { name: 'Receipt / invoice' }).click();

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: `e2e-receipt-${runId}.png`,
    mimeType: 'image/png',
    buffer: pngFixture()
  });

  // A receipt/invoice upload gets no automatic candidate lines (no OCR
  // backend ships this milestone) — transcribe one by hand.
  await expect(page.getByText('0 of 0 line(s) confirmed')).toBeVisible();
  const main = page.getByRole('main');
  const receiptCategory = `e2e-receipt-${runId}`;
  await main.getByLabel('Description *').fill(`E2E receipt line ${runId}`);
  await main.getByLabel('Amount *').fill('42.00');
  await main.getByRole('button', { name: 'Add line' }).click();
  await expect(page.getByText('0 of 1 line(s) confirmed')).toBeVisible();

  await main.getByLabel('Category *').fill(receiptCategory);
  await main.getByRole('button', { name: /Confirm 1 as expense/ }).click();
  await expect(page.getByText('1 of 1 line(s) confirmed')).toBeVisible();

  // The confirmed expense exists…
  await page.goto('/finance/expenses');
  await expect(tableRow(page, receiptCategory)).toBeVisible();

  // …and, because its source document had a receipt image, it does NOT
  // appear as missing paper.
  await page.goto('/finance/overview');
  await expect(page.getByText('Missing receipts', { exact: true })).toBeVisible();
  await expect(page.getByText(receiptCategory)).toHaveCount(0);
});
