import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * Settings workspace critical flows as the bootstrap admin: health report,
 * economic-entity creation, and parent/assumed-name hierarchy (ADR-0017).
 *
 * The admin session is established once via the real magic-link flow and
 * reused through storageState. Entity names are unique per run because the
 * harness database persists across suite invocations.
 */

const runId = Date.now();
const rootEntityName = `E2E Holdings ${runId}`;
const childEntityName = `E2E Trading Post ${runId}`;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({
    baseURL: process.env['LOXEP_E2E_BASE_URL'] ?? 'http://localhost:3093',
    // The browser fixture applies this file's `test.use` options to newPage,
    // but the admin state file does not exist until this hook writes it.
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

/** Row identified by an exact name cell ('worker' must not match 'worker-jobs'). */
function namedRow(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
}

test('settings overview reports healthy runtime and components', async ({ page }) => {
  await page.goto('/settings/overview');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // Runtime card: overall readiness ok, mode `all` under the harness.
  await expect(page.getByText('ok', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('all', { exact: true })).toBeVisible();

  // Component and dependency checks all report ok (no `failing` badge anywhere).
  await expect(namedRow(page, 'worker').getByText('ok', { exact: true })).toBeVisible();
  await expect(namedRow(page, 'database').getByText('ok', { exact: true })).toBeVisible();
  await expect(namedRow(page, 'migrations').getByText('ok', { exact: true })).toBeVisible();
  await expect(page.getByText('failing')).toHaveCount(0);
});

test('admin creates an economic entity through the dialog', async ({ page }) => {
  await page.goto('/settings/entities');
  await page.getByRole('button', { name: 'New entity' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('New economic entity')).toBeVisible();
  await dialog.getByLabel('Name *').fill(rootEntityName);
  await dialog.getByRole('combobox', { name: /^Kind/ }).click();
  await page.getByRole('option', { name: 'LLC' }).click();
  await dialog.getByRole('button', { name: 'Create entity' }).click();

  await expect(dialog).toBeHidden();
  const row = tableRow(page, rootEntityName);
  await expect(row).toBeVisible();
  await expect(row.getByText('LLC')).toBeVisible();
  await expect(row.getByText('active')).toBeVisible();
});

/**
 * Application settings are editable by admins (loxep-fev). The registered
 * setting's Zod schema only exists server-side, so the dialog's job is to send
 * raw JSON and surface the server's validation message inline — both halves
 * are asserted here. `commerce.order_payload_retention` is used because
 * changing its window has no effect on any other spec's flow.
 */
test('admin edits a registered application setting', async ({ page }) => {
  await page.goto('/settings/application');
  const settingKey = 'commerce.order_payload_retention';

  await page
    .getByRole('row')
    .filter({ hasText: settingKey })
    .getByRole('button', { name: 'Edit' })
    .first()
    .click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(settingKey)).toBeVisible();
  const valueField = dialog.getByLabel('Value (JSON) *');

  // A shape the registered schema rejects: the server's message renders on the
  // field, and the dialog stays open.
  await valueField.fill('{"mode":"delete","afterDays":180}');
  await dialog.getByRole('button', { name: 'Save setting' }).click();
  await expect(dialog.getByText(/mode/)).toBeVisible();
  await expect(dialog).toBeVisible();

  // A valid value saves, closes the dialog, and shows up in the table.
  await valueField.fill('{"mode":"redact","afterDays":200}');
  await dialog.getByRole('button', { name: 'Save setting' }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: settingKey }).first();
  await expect(row.getByText('200')).toBeVisible();
  await expect(row.getByText('stored')).toBeVisible();
});

test('admin creates a child entity beneath a parent', async ({ page }) => {
  await page.goto('/settings/entities');
  await page.getByRole('button', { name: 'New entity' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name *').fill(childEntityName);
  await dialog.getByRole('combobox', { name: /^Kind/ }).click();
  await page.getByRole('option', { name: 'Assumed name' }).click();
  await dialog.getByRole('combobox', { name: /^Parent entity/ }).click();
  await page.getByRole('option', { name: rootEntityName }).click();
  await dialog.getByRole('button', { name: 'Create entity' }).click();

  await expect(dialog).toBeHidden();
  const childRow = tableRow(page, childEntityName);
  await expect(childRow).toBeVisible();
  await expect(childRow.getByText(rootEntityName)).toBeVisible(); // parent column
  await expect(tableRow(page, rootEntityName).first()).toBeVisible(); // both entities listed
});
