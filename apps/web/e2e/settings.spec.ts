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

  // Component and dependency checks report ok BY NAME. A page-global
  // "zero failing badges" assertion is deliberately absent: this harness
  // runs the real worker, whose health sweeps genuinely mark earlier
  // specs' fake-credential connections failing over the suite's own
  // wall-clock — a live race, not a runtime problem (loxep-0g4 W5's
  // finding). The runtime components asserted here are the contract.
  await expect(namedRow(page, 'worker').getByText('ok', { exact: true })).toBeVisible();
  await expect(namedRow(page, 'database').getByText('ok', { exact: true })).toBeVisible();
  await expect(namedRow(page, 'migrations').getByText('ok', { exact: true })).toBeVisible();
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
 * `/settings/application`'s grouped-Cards rebuild (loxep-8ja.3): every class
 * (a) registered setting now renders inline through the generic
 * schema-driven form (`SchemaSettingForm`) instead of a row + raw-JSON
 * dialog — one Card, one `useAppForm`, one Save, matching
 * `SettingsService.write`'s one-setting-per-save discipline exactly.
 * `commerce.order_payload_retention`'s `afterDays` number field is used
 * because changing its window has no effect on any other spec's flow. The
 * Card is found by its own key (rendered as the `CardTitle`, mono, via
 * `data-slot="card"`) rather than by a table row, since there is no table
 * for a class (a) setting anymore.
 */
test('admin saves a numeric field through the generic schema-driven settings form', async ({
  page
}) => {
  await page.goto('/settings/application');
  const settingKey = 'commerce.order_payload_retention';

  const card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(settingKey, { exact: true }) });
  await expect(card).toBeVisible();

  const afterDaysField = card.getByLabel('After days');
  await afterDaysField.fill('200');
  await card.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(`Saved ${settingKey}`)).toBeVisible();
  await expect(afterDaysField).toHaveValue('200');
});

/**
 * The collapsed "Advanced" section (settings-ux-design.md §3's last
 * paragraph) preserves today's exact raw-JSON `SettingEditDialog` behavior
 * for registered settings with no dedicated form yet —
 * `integration.tailscale.ignored_devices` here, a `Record<deviceNodeId,
 * isoInstant>` with no operator-typed shape a generic form could render.
 * Saving `{}` (its own default) back is idempotent, so this is safe to
 * re-run against the harness's persisted database.
 */
test('the advanced raw-JSON section opens and still edits an unmapped registered setting', async ({
  page
}) => {
  await page.goto('/settings/application');
  const settingKey = 'integration.tailscale.ignored_devices';

  await page.getByRole('button', { name: 'Raw settings (advanced)' }).click();

  const row = tableRow(page, settingKey);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(settingKey)).toBeVisible();
  const valueField = dialog.getByLabel('Value (JSON) *');
  await expect(valueField).toBeVisible();

  await valueField.fill('{}');
  await dialog.getByRole('button', { name: 'Save setting' }).click();
  await expect(dialog).toBeHidden();
});

/**
 * The `integrations.enabled` row editor (loxep-8ja.4) on the catalog grid:
 * an admin-only per-provider `Switch`, one `useMutation` per row, mirroring
 * `WritePolicyCell`'s row-scoped shape. Disabling hides the provider from
 * the default catalog view entirely (not merely dims it) and folds it into
 * "Show disabled"; re-enabling restores the default view exactly, so this
 * test leaves no persisted side effect for a re-run against the harness's
 * shared database. Reverb is used because no other e2e spec references it.
 */
test('admin hides a provider from the integrations catalog and re-enables it', async ({ page }) => {
  await page.goto('/settings/integrations');
  const providerName = 'Reverb';

  const providerCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(providerName, { exact: true }) });
  await expect(providerCard).toBeVisible();

  await providerCard.getByRole('switch', { name: `Hide ${providerName} from the catalog` }).click();
  await expect(page.getByText(`${providerName} hidden`)).toBeVisible();

  // Hidden means gone from the default catalog view, not merely dimmed.
  // Wider timeout (loxep-wtk): the toast confirms the write; the card's
  // removal waits on the enabled-map refetch, which lags under a loaded
  // machine — this is one genuinely-async repaint, not a retry loop.
  await expect(providerCard).toHaveCount(0, { timeout: 15000 });

  // "Show disabled" reveals it again, dimmed and badged — never a silent stop.
  await page.getByLabel(/^Show disabled/).click();
  await expect(providerCard).toBeVisible();
  await expect(providerCard.getByText('Disabled here')).toBeVisible();

  // Re-enable, restoring the default view for the next run.
  await providerCard.getByRole('switch', { name: `Show ${providerName} in the catalog` }).click();
  await expect(page.getByText(`${providerName} shown in the catalog`)).toBeVisible();
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
