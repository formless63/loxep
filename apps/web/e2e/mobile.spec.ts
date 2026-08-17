import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_STORAGE_STATE,
  MEMBER_EMAIL,
  signInWithMagicLink
} from './helpers/auth';

/**
 * The `mobile-chromium` regression tripwire (UI overhaul 2026 design §3,
 * rule M6, `loxep-pso`/W5): a small, hand-picked subset of the desktop
 * suite's own flows, re-run at a 390x844 iPhone-class viewport against the
 * M1-M5 mobile mechanisms W2 (`loxep-45k`) shipped — `ResponsiveDialog`, the
 * `useDataTable` mobile first-column pin, `DataTableToolbar`'s filter sheet,
 * the sidebar Sheet, and the shared `Button` icon-size touch targets. This
 * file is NOT a second copy of the whole suite; it exists to catch a
 * regression in those shared mechanisms, while the desktop `chromium`
 * project stays the completeness gate.
 *
 * Every `test()` title ends in the literal string `@mobile` — the tag
 * `playwright.config.ts`'s two projects key off (`grep`/`grepInvert`) to
 * route this file's tests to `mobile-chromium` ONLY and exclude them from
 * `chromium`, so the desktop test count never moves because of this file.
 * The project itself supplies the 390x844/touch/`isMobile`/`deviceScaleFactor`
 * emulation — nothing in this file sets viewport/device options.
 *
 * Every fixture below builds its own fresh, uniquely-named connection/
 * expense/etc. inside the TEST that needs it (never a module-level `runId`
 * shared across tests) — the trap loxep-wtk already named for this suite: a
 * module-level id used by only the first test means a mid-run failure
 * re-imports the file with a new id and strands every later test hunting
 * for a fixture that was never created under that id.
 */

function freshRunId(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function tableRow(page: Page, text: string): Locator {
  return page.getByRole('row').filter({ hasText: text });
}

/**
 * Below 768px `DataTableToolbar` collapses every per-column filter
 * (including a plain text one) into one "Filters" button opening a bottom
 * `Sheet` (rule M2.3) — there is no inline filter input to fill directly the
 * way the desktop suite's own `filteredRow`-style helpers do. `label` is the
 * filter's `columnMeta.label` (e.g. `'Account'`, `'Category'`), which is
 * also the `Input`'s `aria-label` inside the sheet.
 */
async function mobileFilterByText(page: Page, label: string, value: string): Promise<void> {
  await page.getByRole('button', { name: 'Filters' }).click();
  const sheet = page.getByRole('dialog').filter({ hasText: 'Filters' });
  await sheet.getByRole('textbox', { name: label }).fill(value);
  await page.keyboard.press('Escape');
}

/** One Cloudflare account (2 required fields, no live network call) — the lightest infra-category connection to seed for the tests below that just need A row, not Cloudflare-specific behavior. */
async function createCloudflareConnection(
  page: Page,
  name: string,
  tokenSuffix: string
): Promise<void> {
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Cloudflare account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Account name *').fill(name);
  await dialog.getByLabel('API token *').fill(`cf_e2e_mobile_${tokenSuffix}`);
  await dialog.getByRole('button', { name: 'Connect account' }).click();
  await expect(dialog).toBeHidden();
}

/** No horizontal page scroll — the "stacks" half of "opens and stacks" (rule M5's single-column mobile discipline). */
async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  expect(overflows).toBe(false);
}

test.describe('sign-in at mobile viewport', () => {
  test.use({ storageState: undefined });

  test('magic-link sign-in completes and lands authenticated at 390px @mobile', async ({
    page
  }) => {
    await signInWithMagicLink(page, MEMBER_EMAIL);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    // `useIsMobile()` (the shared M1 breakpoint hook) resolves its `true`
    // value from a `useEffect` that runs after the initial paint — the
    // dashboard heading above proves the ROUTE rendered, but not that this
    // hook's post-mount effect has flushed yet. Clicking the sidebar trigger
    // in that narrow window would toggle the DESKTOP `open` state instead of
    // `openMobile` (`toggleSidebar()` branches on `isMobile`), leaving the
    // Sheet closed. `networkidle` is a reliable, non-arbitrary point by which
    // React's mount effects have run — this is the one spot in the suite
    // that acts on the sidebar immediately after a fresh auth redirect
    // (every other spec's first sidebar interaction follows a plain
    // `page.goto`, which already gives the same effect time to settle).
    await page.waitForLoadState('networkidle');
    // Full session, not just a navigated URL: the account menu (in the
    // sidebar footer) carries the signed-in identity — same proof
    // `auth.spec.ts` uses on desktop. Below 768px the sidebar is a collapsed
    // Sheet (rule M1), so the account button only exists in the accessibility
    // tree once that Sheet is open — unlike desktop, where the sidebar (and
    // its footer) render inline and are always present.
    await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: new RegExp(MEMBER_EMAIL) })
    ).toBeVisible();
  });
});

test.describe('authenticated mobile flows', () => {
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

  test('the sidebar Sheet opens and navigates to /settings/connections @mobile', async ({
    page
  }) => {
    await page.goto('/settings/overview');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Below the 768px structural breakpoint (rule M1) the sidebar renders as
    // a Sheet rather than an inline pane; `SidebarTrigger` (the header's
    // hamburger) opens it.
    await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
    const sheet = page.getByRole('dialog');
    const connectionsLink = sheet.getByRole('link', { name: 'Connections' });
    await expect(connectionsLink).toBeVisible();
    await connectionsLink.click();
    await page.waitForURL('**/settings/connections');

    // FOUND (not fixed here — `app-sidebar.tsx`/`sidebar.tsx` own the
    // `openMobile` state and are outside this wave's fence): the mobile
    // sidebar Sheet does not close itself when a nav `Link` inside it
    // navigates — `SidebarProvider`'s `openMobile` lives above the routed
    // `Outlet` and nothing wires a close on click, so the Sheet (and Radix's
    // resulting inert/aria-hidden on everything behind it) stays up over the
    // destination page until dismissed. A real mobile user would see the
    // menu still covering the screen after tapping a link. Dismiss it
    // explicitly — exactly what that user would have to do too — before
    // asserting the page underneath.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
  });

  test('connections table scrolls horizontally with a 40px row-menu hit target @mobile', async ({
    page
  }) => {
    const runId = freshRunId();
    const name = `E2E Mobile Scroll Cloudflare ${runId}`;

    await page.goto('/settings/connections');
    await createCloudflareConnection(page, name, runId);
    await mobileFilterByText(page, 'Account', name);

    const main = page.getByRole('main');
    const row = tableRow(page, name);
    await expect(row).toBeVisible();

    // Horizontal scroll (rule M2.1) is the mobile table pattern, never a
    // card-list transform — this table genuinely overflows at 390px.
    const viewport = main.locator('[data-slot="scroll-area-viewport"]').first();
    const { scrollWidth, clientWidth } = await viewport.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth
    }));
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    const providerCell = row.getByText('Cloudflare', { exact: true }).first();
    const providerBefore = await providerCell.boundingBox();
    if (providerBefore === null) {
      throw new Error('row cells not visible before scrolling');
    }

    await viewport.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });

    const providerAfter = await providerCell.boundingBox();
    if (providerAfter === null) {
      throw new Error('row cells not visible after scrolling');
    }
    expect(providerAfter.x).toBeLessThan(providerBefore.x);

    // FOUND (not fixed here — the root cause sits in `data-table.tsx`'s
    // outer Radix `ScrollArea` wrapping the base `Table` primitive's OWN
    // built-in `[data-slot="table-container"]` `overflow-x-auto` scroller,
    // neither of which is one of this wave's four permitted W2 mechanism
    // files): rule M2.2's first-column pin (`useDataTable`'s mobile
    // `columnPinning.start` override, verified correct at the hook/style
    // level — `getCommonPinningStyles` DOES emit `position: sticky; left:
    // 0px` on the Account `<td>`) does not actually stay visually fixed when
    // scrolled. Two NESTED horizontal-scroll containers exist for the same
    // table (the donor `Table` component's own `table-container` div, inside
    // `DataTable`'s additional `ScrollArea`); `position: sticky` only
    // counteracts scrolling of its OWN nearest scrolling ancestor
    // (`table-container`), so scrolling the OUTER, user-visible one (the one
    // with the actual `ScrollBar`) carries the "pinned" cell along with
    // everything else — confirmed by measuring the Account cell's
    // `boundingBox()` shift by the same ~520px as an ordinary column when
    // only the outer container's `scrollLeft` is moved. This is the mobile
    // pin's first real browser-rendered verification (`loxep-45k`'s own
    // status note describes the mechanism only at the hook/style level); the
    // apparent fix (drop the redundant outer `ScrollArea`, or make the inner
    // `table-container` non-scrolling) touches a primitive shared by 52+
    // tables app-wide, well beyond this wave's mobile-QA-only scope.

    // The row action trigger (`size='icon-sm'`) carries a mobile-only
    // invisible `::after` hit-box (`after:-inset-1`, `md:after:hidden`) that
    // brings its 32px visible button up to a 40px touch target (rule M4).
    const menuTrigger = row.getByRole('button', { name: 'Open menu' });
    await expect(menuTrigger).toBeVisible();
    const triggerBox = await menuTrigger.boundingBox();
    if (triggerBox === null) throw new Error('row menu trigger not visible');
    const after = await menuTrigger.evaluate((el) => {
      const style = window.getComputedStyle(el, '::after');
      return { position: style.position, top: style.top, left: style.left };
    });
    expect(after.position).toBe('absolute');
    const topInset = Math.abs(parseFloat(after.top));
    const leftInset = Math.abs(parseFloat(after.left));
    expect(triggerBox.height + topInset * 2).toBeGreaterThanOrEqual(39.5);
    expect(triggerBox.width + leftInset * 2).toBeGreaterThanOrEqual(39.5);

    await menuTrigger.click();
    await expect(page.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('an expense records through the ResponsiveDialog drawer at 390px @mobile', async ({
    page
  }) => {
    const runId = freshRunId();
    const category = `e2e-mobile-expense-${runId}`;
    const payeeName = `E2E Mobile Payee ${runId}`;

    await page.goto('/finance/expenses');
    await expect(page.getByRole('heading', { name: 'Expenses' })).toBeVisible();

    await page.getByRole('button', { name: 'New expense' }).first().click();

    // Below 768px `ResponsiveDialog` renders vaul's `Drawer`, not `Dialog`
    // (rule M3) — `data-slot='drawer-content'` is the direct proof of that.
    // `Drawer.Content` still exposes `role='dialog'` under the hood
    // (`responsive-dialog.tsx`'s own doc comment), so every
    // `getByRole('dialog')` selector below is unchanged from the desktop
    // spec this test otherwise mirrors (`finance.spec.ts`).
    await expect(page.locator('[data-slot="drawer-content"]')).toBeVisible();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('New expense')).toBeVisible();
    await dialog.getByLabel('Amount *').fill('12.34');
    await dialog.getByLabel('Category *').fill(category);
    await dialog.getByLabel('Payee (free text)').fill(payeeName);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    // The expenses table accumulates fixtures across the whole suite's
    // reused scratch database, so the freshly-recorded row is located
    // through the mobile filter sheet's own "Category" column filter
    // (`expenses-table/columns.tsx`) rather than assumed to land on page one.
    await mobileFilterByText(page, 'Category', category);
    const row = tableRow(page, payeeName);
    await expect(row).toBeVisible();
    await expect(row.getByText('$12.34')).toBeVisible();
  });

  test("a connection's estate page opens and stacks single-column at 390px @mobile", async ({
    page
  }) => {
    const runId = freshRunId();
    const name = `E2E Mobile Gatus estate ${runId}`;

    await page.goto('/settings/connections');
    await page.getByRole('button', { name: 'Add connection' }).click();
    await page.getByRole('menuitem', { name: 'Add Gatus instance' }).click();
    const connectionDialog = page.getByRole('dialog');
    await connectionDialog.getByLabel('Instance name *').fill(name);
    await connectionDialog.getByLabel('Instance URL *').fill('https://status.example.com');
    await connectionDialog.getByRole('button', { name: 'Connect instance' }).click();
    await expect(connectionDialog).toBeHidden();

    await mobileFilterByText(page, 'Account', name);
    const row = tableRow(page, name);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('menuitem', { name: 'Open estate' }).click();

    await page.waitForURL('**/infrastructure/estate/**');
    const estateMain = page.getByRole('main');
    await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
    await expect(estateMain.getByText(name, { exact: true })).toBeVisible();
    await expect(estateMain.getByText('Gatus', { exact: true }).first()).toBeVisible();

    // Estate pages already stack single-column by construction (rule M5's
    // module doc); the falsifiable form of that at 390px is: no sideways
    // page scroll.
    await assertNoHorizontalOverflow(page);
  });

  test('the connections table toolbar filter sheet filters by Account @mobile', async ({
    page
  }) => {
    const runId = freshRunId();
    const keepName = `E2E Mobile Filter Keep ${runId}`;
    const dropName = `E2E Mobile Filter Drop ${runId}`;

    await page.goto('/settings/connections');
    await createCloudflareConnection(page, keepName, `${runId}-keep`);
    await createCloudflareConnection(page, dropName, `${runId}-drop`);

    // Both rows exist, but neither is asserted visible UNFILTERED first: the
    // table's default order is not "newest first" and this suite's shared
    // scratch database accumulates fixtures across every prior spec, so a
    // freshly-created row is not guaranteed to land on page one before the
    // filter narrows the set down to it (the same reason the desktop suite's
    // own `filteredRow`-style helpers never assert unfiltered either).
    const keepRow = tableRow(page, keepName);
    const dropRow = tableRow(page, dropName);

    // Open the funnel, apply the Account filter (rule M2.3) — the same
    // per-column filter the desktop toolbar renders inline, here reached
    // through the bottom Sheet instead.
    await mobileFilterByText(page, 'Account', keepName);

    await expect(keepRow).toBeVisible();
    await expect(dropRow).toHaveCount(0);
  });

  test('the infrastructure topology page renders its tabs and legend at 390px @mobile', async ({
    page
  }) => {
    const runId = freshRunId();
    const name = `E2E Mobile Topology Cloudflare ${runId}`;

    await page.goto('/settings/connections');
    await createCloudflareConnection(page, name, runId);

    await page.goto('/infrastructure/topology');
    await expect(page.getByRole('heading', { name: 'Topology' })).toBeVisible();

    const main = page.getByRole('main');
    await expect(main.getByRole('tab', { name: 'Graph' })).toBeVisible();
    await expect(main.getByRole('tab', { name: 'Map' })).toBeVisible();
    // The legend's honesty stamp (rule G6) renders at 390px too.
    await expect(main.getByText("Assembled from Loxep's records", { exact: false })).toBeVisible();
    await expect(main.getByText(name)).toBeVisible();

    await assertNoHorizontalOverflow(page);
  });
});
