import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * `/finance/expenses/new` critical flow (loxep-cd3.2, M2 —
 * `expense-entry-design.md` section 1): drop one file into the evidence
 * pane, watch it upload and preview inline, fill the minimum required
 * fields, and confirm one save both records the expense AND links the
 * uploaded evidence — the "one confirm" the design's upload-order-of-
 * operations decision exists to produce (`createExpenseWithEvidence`,
 * `@/server/expense-functions.ts`, reusing the same `ExpensesService.create`
 * / `ReceiptsService.attach` quick entry and `confirmLinesAsExpense` use).
 *
 * Recording a spend is session-gated (`requireSession`), not admin-only —
 * reuses the bootstrap-admin storage state only because that is the
 * established reusable-session pattern (`finance.spec.ts`,
 * `documents-import.spec.ts`), not because the role matters here.
 */

const runId = Date.now();
const category = `e2e-new-expense-${runId}`;

/**
 * Receipt/document upload writes a media object, which needs a registered
 * storage backend — the harness DB starts with none (`/api/documents/upload`
 * answers 409 no-storage-backend otherwise). Mirrors
 * `documents-import.spec.ts`'s `ensureStorageBackend` helper verbatim
 * (duplicated locally per this repo's existing per-spec-file convention,
 * e.g. each spec's own local `tableRow`) — registers a local backend through
 * the real settings flow, idempotently, so this spec is fresh-DB-safe.
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

test('drop one file, preview it, and record the expense with evidence attached', async ({
  page
}) => {
  await ensureStorageBackend(page);

  await page.goto('/finance/expenses/new');
  await expect(page.getByRole('heading', { name: 'New expense' })).toBeVisible();

  // Scoped to `main` throughout — the sidebar/palette carry a "New expense"
  // link with an overlapping accessible name elsewhere on this page.
  const main = page.getByRole('main');

  // Drop the fixture on the evidence pane's dropzone input (hidden, but
  // `setInputFiles` does not require visibility — same approach
  // `documents-import.spec.ts` uses).
  const fileInput = main.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: `e2e-new-expense-${runId}.png`,
    mimeType: 'image/png',
    buffer: pngFixture()
  });

  // Uploads immediately, before anything is typed — the design's own
  // "upload order of operations" decision. Wait for the attachment to
  // finish (never assert on "Uploading…", which is a race).
  await expect(main.getByText('Uploaded', { exact: false })).toBeVisible();

  // The per-file preview renders inline — a real <img> against the object's
  // own servingUrl, not a broken-image placeholder.
  await expect(main.getByRole('img', { name: `e2e-new-expense-${runId}.png` })).toBeVisible();

  // Minimum required fields; Date/Payment/Currency/Entity keep their
  // sensible defaults, exactly like the quick-entry dialog.
  await main.getByLabel('Amount *').fill('18.25');
  await main.getByLabel('Category *').fill(category);

  await main.getByRole('button', { name: 'Record expense' }).click();

  // One save both creates the expense and links the evidence in the same
  // transaction — lands on the detail page.
  await page.waitForURL('**/finance/expenses/*');
  await expect(page.getByText(category).first()).toBeVisible();
  await expect(page.getByText('$18.25').first()).toBeVisible();

  // The evidence pane's upload IS the receipt: one attached receipt, no
  // separate "attach later" step.
  await expect(page.getByText('No receipts attached')).toHaveCount(0);
  await expect(page.getByText('Receipt', { exact: true })).toBeVisible();
});

test('a two-line entry records BOTH expense_lines and renders them, with their total, on the detail page', async ({
  page
}) => {
  // loxep-cd3.3, M3 — the optional line-items editor
  // (`expense-entry-design.md` section 4): "1 candidate row -> 1 expense
  // line" for the documents-review flow has its mirror here — every row the
  // operator types in the compose-time array becomes its own `expense_lines`
  // row in the SAME transaction as the expense (`createExpenseWithEvidence`,
  // `@/server/expense-functions.ts`). Lines are optional and never merged
  // with allocations, which this page does not surface at all.
  const lineCategory = `e2e-new-expense-lines-${runId}`;
  const firstLineDescription = `Shelving unit ${runId}`;
  const secondLineDescription = `Packing tape ${runId}`;

  await page.goto('/finance/expenses/new');
  await expect(page.getByRole('heading', { name: 'New expense' })).toBeVisible();

  // Scoped to `main` throughout — the sidebar/palette carry a "New expense"
  // link with an overlapping accessible name elsewhere on this page.
  const main = page.getByRole('main');

  // The lines sum to the expense's own amount EXACTLY (30.00) — the
  // over-transcription guard (`sum(|line_amount|) <= |expenses.amount|`)
  // refuses exceeding it, and equality is the fully-transcribed case.
  await main.getByLabel('Amount *').fill('30.00');
  await main.getByLabel('Category *').fill(lineCategory);

  const addLineButton = main.getByRole('button', { name: 'Add line' });
  await addLineButton.click();
  await main.getByRole('textbox', { name: 'Line 1 description' }).fill(firstLineDescription);
  await main.getByRole('textbox', { name: 'Line 1 amount' }).fill('20.00');

  await addLineButton.click();
  await main.getByRole('textbox', { name: 'Line 2 description' }).fill(secondLineDescription);
  await main.getByRole('textbox', { name: 'Line 2 amount' }).fill('10.00');

  await main.getByRole('button', { name: 'Record expense' }).click();

  // One save creates the expense AND both lines in the same transaction —
  // lands on the detail page with the recorded amount visible.
  await page.waitForURL('**/finance/expenses/*');
  await expect(page.getByText(lineCategory)).toBeVisible();
  await expect(page.getByText('$30.00').first()).toBeVisible();

  // Both lines render, and the lines summary shows the absolute TOTAL —
  // matched as a regex (not the exact "$30.00" substring alone) so this
  // assertion is unambiguous against the expense header's OWN "$30.00"
  // amount asserted above.
  await expect(page.getByText(firstLineDescription)).toBeVisible();
  await expect(page.getByText(secondLineDescription)).toBeVisible();
  await expect(page.getByText(/2 line\(s\).*\$30\.00.*total/)).toBeVisible();
});
