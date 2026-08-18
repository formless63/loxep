import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';
// Reuses `@loxep/documents`' own OCR test fixture (a tiny, deterministic,
// pure-Node PNG generator — no dependency beyond `node:zlib`, see that
// module's own doc) rather than re-implementing a text-bearing receipt
// image here. This is a filesystem reference to a test-only fixture, not a
// package dependency: `apps/web/package.json` gains nothing.
import { syntheticReceiptPng } from '../../../packages/documents/test/fixtures/synthetic-receipt';
import { runSeed } from './helpers/run-id';

/**
 * OCR tier B — highlight overlay and drag-to-field (loxep-cd3.5, M5 —
 * `expense-entry-design.md` section 3's tier B, and "the weave").
 *
 * Two things are proven end to end against the REAL pipeline (real
 * tesseract.js, run by the harness's own `node bin/loxep.ts start
 * --mode=all` worker process, per `harness.md`):
 *
 * 1. Enabling `ocr_tesseract` (`documents.parser_id`, via the
 *    schema-driven generic settings form — loxep-8ja.2's proof-of-concept
 *    swap, the one class (a) setting mounted on `SchemaSettingDialog`
 *    instead of the raw-JSON dialog `settings.spec.ts` still exercises for
 *    every other registered setting) makes an uploaded receipt's
 *    `document_line_candidates` actually carry a `source_region`, and
 *    `<DocumentPreview>`'s overlay renders a "Detected lines" list from them.
 * 2. Dragging a detected line (`@dnd-kit/core`'s `useDraggable`, the
 *    sanctioned drag library — never a hand-rolled `DragEvent`/`dataTransfer`
 *    handler) onto a form field fills it — PURE UI, per the design's
 *    "dragging changes nothing in the database" rule; no expense or
 *    candidate confirmation happens here, only a controlled input's value.
 *
 * dnd-kit's `PointerSensor` listens on native `pointerdown`/`pointermove`
 * events, not HTML5 `dragstart`/`dragover`/`drop` — so this drives the drag
 * with real `page.mouse` actions (which Chromium turns into trusted pointer
 * events) rather than `dispatchEvent`/`DataTransfer`, which is the
 * native-HTML5-only technique and does not apply to a dnd-kit surface.
 */

const runId = runSeed();

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

/**
 * Opts the installation into `ocr_tesseract` via `/settings/application` —
 * `documents.parser_id`'s row now opens `SchemaSettingDialog`
 * (loxep-8ja.2's proof-of-concept swap for this one class (a) setting: its
 * schema is a single bare string field, mapped to one `TextField` labeled
 * "Parser id" per the field-mapping table), not the raw-JSON dialog every
 * other registered setting still uses. There is no dedicated Documents
 * settings page yet (M5's own scope does not build one — see the design
 * doc's status note), so this generic surface is the only in-app path to
 * the setting; idempotent (setting it twice is harmless), so this is safe
 * to call from `beforeAll` even if the harness DB is reused across runs.
 */
async function enableTesseractOcr(page: Page): Promise<void> {
  // The setting renders inline on a grouped Card since the 8ja.3 rebuild —
  // no row, no Edit dialog. The card is titled with the setting key.
  await page.goto('/settings/application');
  const card = page
    .locator('[data-slot="card"]')
    .filter({ hasText: 'documents.parser_id' })
    .first();
  await expect(card).toBeVisible();
  await card.getByLabel('Parser id').fill('ocr_tesseract');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved documents.parser_id')).toBeVisible();
}

/**
 * Drags `source` onto `target` via real pointer events — dnd-kit's
 * `PointerSensor` (`activationConstraint: { distance: 4 }`,
 * `document-line-dnd.tsx`) needs the pointer to actually move past that
 * threshold before a drag is recognized, so this moves in multiple steps
 * rather than jumping straight to the destination.
 */
async function dragOverlayLine(page: Page, source: Locator, target: Locator): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (sourceBox === null || targetBox === null) {
    throw new Error('dragOverlayLine: source or target has no bounding box (not rendered?)');
  }
  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Past the activation-constraint distance, then several intermediate
  // steps toward the target — dnd-kit's collision detection re-evaluates on
  // every pointermove, so a single jump can skip over the droppable.
  await page.mouse.move(startX + 15, startY + 15, { steps: 5 });
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 10 });
  await page.mouse.move(endX, endY, { steps: 10 });
  await page.mouse.up();
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({
    baseURL: process.env['LOXEP_E2E_BASE_URL'] ?? 'http://localhost:3093',
    storageState: undefined
  });
  await signInWithMagicLink(page, ADMIN_EMAIL);
  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
  await enableTesseractOcr(page);
  await page.close();
});

// A tall viewport so the drag source (the evidence pane's overlay, upper
// right) and a drop target added mid-test (a line row, appended at the
// bottom of the left column) are BOTH simultaneously on-screen —
// `page.mouse.move` targets viewport coordinates and does not auto-scroll,
// unlike a locator action such as `.click()`/`.fill()`.
test.use({ storageState: ADMIN_STORAGE_STATE, viewport: { width: 1440, height: 2200 } });

test('a real OCR run produces a highlight overlay with detected lines', async ({ page }) => {
  test.setTimeout(90_000);
  await ensureStorageBackend(page);

  await page.goto('/finance/expenses/new');
  await expect(page.getByRole('heading', { name: 'New expense' })).toBeVisible();
  const main = page.getByRole('main');

  const fileInput = main.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: `e2e-ocr-overlay-${runId}.png`,
    mimeType: 'image/png',
    buffer: syntheticReceiptPng()
  });
  await expect(main.locator('[title*="uploaded"]').first()).toBeVisible();

  // Extraction runs asynchronously (a Graphile Worker task the harness's
  // `--mode=all` process actually runs) — poll for the overlay's own
  // "Detected lines" heading rather than a fixed sleep. Tesseract's
  // measured cost is well under a second (design section 3's own survey);
  // the generous timeout absorbs job-queue scheduling latency, not OCR
  // itself.
  await expect(main.getByText('Detected lines', { exact: false })).toBeVisible({
    timeout: 60_000
  });

  // "TOTAL" and "COST" are the two words this hand-rolled block font
  // renders most unambiguously (the same anchor
  // `tesseract-parser.test.ts`'s own real-OCR assertions use) — loose,
  // resilient assertions rather than an exact transcript.
  await expect(main.getByText(/TOTAL/i)).toBeVisible();
  await expect(main.locator('[data-testid="document-line-box"]').first()).toBeVisible();
});

test('dragging a detected line onto a line-item field fills it — pure UI, nothing confirmed', async ({
  page
}) => {
  test.setTimeout(90_000);
  await ensureStorageBackend(page);

  await page.goto('/finance/expenses/new');
  await expect(page.getByRole('heading', { name: 'New expense' })).toBeVisible();
  const main = page.getByRole('main');

  const fileInput = main.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: `e2e-ocr-drag-${runId}.png`,
    mimeType: 'image/png',
    buffer: syntheticReceiptPng()
  });
  await expect(main.locator('[title*="uploaded"]').first()).toBeVisible();
  await expect(main.getByText('Detected lines', { exact: false })).toBeVisible({
    timeout: 60_000
  });

  // A real line row to drop onto — the "Add line" affordance already
  // proven by `new-expense-page.spec.ts`.
  await main.getByRole('button', { name: 'Add line' }).click();
  const descriptionField = main.getByRole('textbox', { name: 'Line 1 description' });
  await expect(descriptionField).toHaveValue('');

  // `document_line_candidates` are inserted in the SAME line order
  // `tsv-lines.ts` groups them in (top of the receipt first) — the
  // synthetic receipt's own first line is "TOTAL $12.99"
  // (`synthetic-receipt.ts`'s `syntheticReceiptPng`), so `.first()` is the
  // TOTAL line, deterministically.
  const totalLineBox = page.locator('[data-testid="document-line-box"]').first();
  await expect(totalLineBox).toBeVisible();

  await dragOverlayLine(page, totalLineBox, descriptionField);

  // The drop filled the field with the OCR'd text, verbatim — never
  // auto-committed anywhere. A drop into a description/field target is
  // PURE UI (`expense-entry-design.md`'s "the weave": only a drop into the
  // LINES LIST creates a candidate relationship), so nothing else on the
  // page should have changed as a result of this single drag.
  await expect(descriptionField).toHaveValue(/TOTAL/i);

  // Confirms the never-auto-commit rule held: no expense exists yet (the
  // page is still the compose form, not a detail page), and the dropped
  // field's value came from a plain input change, not a save.
  await expect(page).toHaveURL(/\/finance\/expenses\/new/);
});
