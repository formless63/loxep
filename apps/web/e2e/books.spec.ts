import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';
import { runSeed } from './helpers/run-id';

/**
 * /finance/books critical flow (loxep-cmo): create a book — which, in one
 * step, seeds the starter chart of accounts and opens the fiscal year
 * covering today (`createBook`'s own composition, `@loxep/accounting`) —
 * generate an additional fiscal year through the UI, open/close/reopen a
 * period, and confirm the dashboard's Financial band, previously stuck on
 * its "no accounting book yet" Empty for the whole suite, now renders real
 * statement tiles. That transition is the payoff this surface exists for.
 *
 * Every write here is admin-gated (`requireAdmin`), unlike expense quick
 * entry, so this spec reuses the bootstrap-admin storage state for that
 * reason, not only as the established reusable-session pattern.
 */

const runId = runSeed();
const bookCode = `E2E-${runId}`;
const bookName = `E2E Book ${runId}`;

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

test('creating a book seeds its chart and first fiscal year, and the dashboard Financial band fills in', async ({
  page
}) => {
  await page.goto('/finance/books');
  await expect(page.getByRole('heading', { name: 'Books' })).toBeVisible();

  await page.getByRole('button', { name: 'New book' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('New book')).toBeVisible();
  await dialog.getByLabel('Code *').fill(bookCode);
  await dialog.getByLabel('Name *').fill(bookName);
  // Opened on (today), accounting basis (accrual), and the fiscal-year start
  // (Jan 1) all keep their sensible defaults — functional currency is not a
  // field at all, fixed at USD.
  await dialog.getByRole('button', { name: 'Create book' }).click();
  await expect(dialog).toBeHidden();

  const row = tableRow(page, bookCode);
  await expect(row).toBeVisible();
  await expect(row.getByText('USD')).toBeVisible();

  await row.getByRole('link', { name: bookCode }).click();
  await page.waitForURL('**/finance/books/*');
  await expect(page.getByText(bookName)).toBeVisible();

  // createBook already generated the fiscal year covering `openedOn`
  // (today, month/day 1/1 default) — its first period is present and open.
  await expect(page.getByText(/FY\d{4}-P01/).first()).toBeVisible();
  const openPeriodRow = page.getByRole('row').filter({ hasText: 'open' }).first();
  await expect(openPeriodRow).toBeVisible();

  // A freshly seeded, unposted book's trial balance still shows every
  // account (this surface asks for `includeEmptyAccounts`) and balances to
  // zero.
  await expect(page.getByText('Balances to zero')).toBeVisible();

  // Accounts section (loxep-l49): `createBook`'s own `seedDefaultChart` call
  // already populated the chart, so the seeded accounts are visible without
  // any action here — the section renders read data, it doesn't create it.
  await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
  await expect(page.getByText('Business Checking', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Sales Revenue', { exact: true }).first()).toBeVisible();

  // Journal section (loxep-l49): read-only, and honestly empty — nothing has
  // posted to a book nobody has recorded activity against yet. Assert the
  // empty message, never a fabricated entry.
  await expect(page.getByText('Journal', { exact: true })).toBeVisible();
  await expect(page.getByText('No journal entries')).toBeVisible();
  // No write affordance anywhere in the Journal section — the posting engine
  // is the only writer (`journal-functions.ts`'s own module doc).
  await expect(
    page.getByRole('button', { name: /new entry|post entry|create entry/i })
  ).toHaveCount(0);

  // Generate an additional fiscal year through the UI (not implied by
  // createBook's own composition) and confirm its periods appear.
  const nextYear = new Date().getUTCFullYear() + 1;
  await page.getByRole('button', { name: 'Generate fiscal year' }).click();
  const generateDialog = page.getByRole('dialog');
  await generateDialog.getByLabel('Fiscal year *').fill(String(nextYear));
  await generateDialog.getByRole('button', { name: 'Generate' }).click();
  await expect(generateDialog).toBeHidden();
  await expect(page.getByText(`FY${nextYear}-P01`)).toBeVisible();

  // Close is consequential and confirm-gated — close the newly generated
  // year's first period, then reopen it.
  const newPeriodRow = tableRow(page, `FY${nextYear}-P01`);
  await newPeriodRow.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Close period' }).click();
  await expect(newPeriodRow.getByText('soft closed')).toBeVisible();

  await newPeriodRow.getByRole('button', { name: 'Reopen' }).click();
  await page.getByRole('button', { name: 'Reopen period' }).click();
  await expect(newPeriodRow.getByText('open', { exact: true })).toBeVisible();

  // The payoff: the dashboard's Financial band, empty for the whole suite
  // until now, renders real statement tiles instead of "No accounting book
  // yet".
  await page.goto('/dashboard/overview');
  await expect(page.getByRole('heading', { name: 'Financial' })).toBeVisible();
  await expect(page.getByText('No accounting book yet')).toHaveCount(0);
  await expect(page.getByText('Revenue', { exact: true })).toBeVisible();
  await expect(page.getByText('Net income', { exact: true })).toBeVisible();
});
