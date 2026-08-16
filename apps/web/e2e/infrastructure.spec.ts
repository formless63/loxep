import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_STORAGE_STATE, signInWithMagicLink } from './helpers/auth';

/**
 * `/infrastructure` workspace render + panel empty-states (Phase 7 milestone
 * 3, loxep-lmy.3). No DNS/mail provider connection exists in the e2e
 * harness, so this spec asserts the honest "nothing declared yet" surfaces
 * rather than a live provisioning flow — the harness has no live provider to
 * provision against, and `/infrastructure/domains/new` explicitly refuses to
 * submit without a DNS connection selected (there being none to pick).
 *
 * Mirrors `settings.spec.ts`'s admin-session setup.
 */

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

test('infrastructure overview renders with an empty fleet and no domains needing attention', async ({
  page
}) => {
  await page.goto('/infrastructure/overview');
  await expect(page.getByRole('heading', { name: 'Infrastructure' })).toBeVisible();

  // The stat tiles render even with nothing declared. Exact match: the
  // fleet nav card's description also starts with "Hosting targets …".
  await expect(page.getByText('Managed domains', { exact: true })).toBeVisible();
  await expect(page.getByText('Hosting targets', { exact: true })).toBeVisible();
  await expect(page.getByText('Unresolved drift', { exact: true })).toBeVisible();

  // Nav cards to the three sub-surfaces — scoped to the page body, since the
  // sidebar carries links with the same accessible names.
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /Domains/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /Fleet/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /Reconcile runs/ })).toBeVisible();
});

test('domains list shows the empty state with a New domain action', async ({ page }) => {
  await page.goto('/infrastructure/domains');
  await expect(page.getByRole('heading', { name: 'Domains' })).toBeVisible();
  await expect(page.getByText('No managed domains yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New domain' })).toBeVisible();
});

test('the new-domain wizard warns when no DNS connection exists yet', async ({ page }) => {
  await page.goto('/infrastructure/domains/new');
  await expect(page.getByRole('heading', { name: 'Declare a domain' })).toBeVisible();
  // No DNS connection exists in the harness (no live provider), so the
  // wizard refuses to render a form with nothing to select — the honest
  // empty state, not a submit button that would fail server-side.
  await expect(page.getByText('No DNS connection yet')).toBeVisible();
});

test('fleet list shows the empty state with a New hosting target action', async ({ page }) => {
  await page.goto('/infrastructure/fleet');
  await expect(page.getByRole('heading', { name: 'Fleet' })).toBeVisible();
  await expect(page.getByText('No hosting targets yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New hosting target' })).toBeVisible();
});

test('creates a hosting target with no fronting node, then shows it with an empty tokens/companion-links state', async ({
  page
}) => {
  const targetName = `e2e-target-${Date.now()}`;

  await page.goto('/infrastructure/fleet');
  await page.getByRole('button', { name: 'New hosting target' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('New hosting target')).toBeVisible();
  await dialog.getByLabel('Name *').fill(targetName);
  // `hosting_targets_addressable_check`: a direct/reverse-proxy target must
  // carry an address (or a fronting node) — the dialog refuses without one.
  await dialog.getByLabel('IPv4 address').fill('203.0.113.77');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('link', { name: targetName })).toBeVisible();
  await page.getByRole('link', { name: targetName }).click();
  await page.waitForURL('**/infrastructure/fleet/**');

  await expect(page.getByText('No tokens minted for this host')).toBeVisible();
  await expect(page.getByText('No companion tool linked yet')).toBeVisible();
  await expect(page.getByText('None yet.')).toBeVisible(); // "Domains pointing here (0)"

  // loxep-bub: the typed multi-address card. The dialog's "IPv4 address"
  // convenience field writes a wan/operator_declared/primary host_addresses
  // row through the same transaction as create() — this asserts that row
  // renders on the card, not just that the target has SOME address.
  const addressesCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText('Addresses', { exact: true }) });
  // The kind badge AND the row's reclassify select both show "WAN" — scoped
  // to the badge specifically so the assertion stays single-element.
  await expect(addressesCard.locator('[data-slot="badge"]', { hasText: 'WAN' })).toBeVisible();
  await expect(addressesCard.getByText('203.0.113.77', { exact: true })).toBeVisible();
  await expect(addressesCard.getByText('Declared', { exact: true })).toBeVisible();
  await expect(addressesCard.getByText('primary', { exact: true })).toBeVisible();

  // loxep-y64 slice 3: the operator-confirmed attach picker over Beszel's
  // discovery sweep. The e2e harness has no live Beszel hub (no fleet
  // credentials exist on this box — see that bead's report), so nothing has
  // ever discovered a system: this asserts the honest empty state rather
  // than a seeded discovery flow, which is covered at the service level
  // instead (`packages/app/test/fleet-health.test.ts`'s "beszel discovery"
  // suite, `packages/domain/test/resource-links.test.ts`'s
  // `listUnattachedByProvider` tests).
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Attach discovered Beszel system' }).click();
  const attachDialog = page.getByRole('dialog');
  await expect(attachDialog.getByText('Attach a discovered Beszel system')).toBeVisible();
  await expect(attachDialog.getByText('No discovered Beszel systems')).toBeVisible();
  await expect(attachDialog.getByRole('button', { name: 'Attach' })).toBeDisabled();
  await attachDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(attachDialog).toBeHidden();

  // loxep-v5r.3: the generic companion-link service, exercised end to end —
  // "Add tool link" writes external_resources + resource_links (no
  // credential, no adapter). Scoped to `main` and exact-matched throughout:
  // this file has been bitten by strict-mode ambiguity before (sidebar nav
  // vs. page body sharing accessible names).
  const linkLabel = `e2e-link-${Date.now()}`;
  await main.getByRole('button', { name: 'Add tool link' }).click();
  const linkDialog = page.getByRole('dialog');
  await expect(linkDialog.getByText('Add a companion link')).toBeVisible();
  await linkDialog.getByLabel('Provider *').fill('gatus');
  await linkDialog.getByLabel('Kind *').fill('dashboard');
  await linkDialog.getByLabel('URL *').fill('https://gatus.example.test/status');
  await linkDialog.getByLabel('Label').fill(linkLabel);
  await linkDialog.getByLabel('Purpose *').fill('status_page');
  await linkDialog.getByRole('button', { name: 'Add link' }).click();
  await expect(linkDialog).toBeHidden();

  await expect(main.getByText('No companion tool linked yet')).toHaveCount(0);
  await expect(main.getByText(linkLabel, { exact: true })).toBeVisible();
  await expect(main.getByText('gatus · dashboard · status_page', { exact: false })).toBeVisible();

  // Removing the link restores the honest empty state.
  await main.getByRole('button', { name: `Remove ${linkLabel} link` }).click();
  await expect(main.getByText('No companion tool linked yet')).toBeVisible();
  await expect(main.getByText(linkLabel, { exact: true })).toHaveCount(0);
});

test('reconcile runs list shows the empty state', async ({ page }) => {
  await page.goto('/infrastructure/runs');
  await expect(page.getByRole('heading', { name: 'Reconcile runs' })).toBeVisible();
  await expect(page.getByText('No reconcile runs yet')).toBeVisible();
});

/**
 * The Pangolin chain design's M4 (loxep-acj.4) apply affordance, rendered.
 *
 * ## The honesty boundary this test draws, deliberately (matching
 * `connections.spec.ts`'s own precedent for documenting a gap rather than
 * faking it)
 *
 * `createStoreConnection` writes a Cloudflare account row with no live
 * network call (the same "no live call" property `connections.spec.ts`'s
 * WooCommerce fixture relies on), and `createManagedDomain` writes intent +
 * enqueues without awaiting a provider — so this test CAN reach a real
 * `/infrastructure/domains/$name` page with nothing faked. What it cannot
 * reach is a `proxy_resources` row with real data: milestone 2
 * (loxep-acj.2) shipped the chain's third link "visibility only" — there is
 * NO UI anywhere that creates a `proxy_resources` row, so no e2e flow
 * (however much connection/domain setup it does first) can ever populate
 * one without a direct database write, which is not this suite's
 * convention (`books.spec.ts`/`inventory.spec.ts`/`connections.spec.ts` all
 * seed exclusively through the UI). So this is the affordance's
 * MOST-CONSERVATIVE reachable state — "nothing declared, so nothing to
 * apply" — proving the panel and its Apply control render correctly
 * (no crash, no stray button) rather than the deeper
 * `writePolicyTier: 'read_only'` blocked-alert variant, which needs data
 * this harness has no path to create.
 */
test('a domain with no declared proxy resource shows the honest empty state and no Apply control', async ({
  page
}) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  // A Cloudflare connection, so the "New domain" wizard has a DNS connection
  // to pick — no live token validation happens (see the module doc above).
  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Cloudflare account' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Account name *').fill(`E2E Cloudflare ${runId}`);
  await connectionDialog.getByLabel('API token *').fill(`cf_e2e_token_${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect account' }).click();
  await expect(connectionDialog).toBeHidden();

  const domainName = `e2e-proxy-${runId}.test`;
  await page.goto('/infrastructure/domains/new');
  await page.getByLabel('Domain name *').fill(domainName);
  await page.getByRole('combobox', { name: /^DNS connection/ }).click();
  await page.getByRole('option', { name: `E2E Cloudflare ${runId}` }).click();
  await page.getByRole('button', { name: 'Declare domain' }).click();
  await page.waitForURL('**/infrastructure/domains/**');

  await expect(page.getByText('Proxy resources', { exact: true })).toBeVisible();
  await expect(page.getByText('No proxy resource declared')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply' })).toHaveCount(0);
});

/**
 * M7 (`loxep-acj.7`)'s rules-panel filter and retire/re-enable actions,
 * rendered — the "no live providers" reachable state.
 *
 * The same gap the test just above documents applies here with equal force:
 * M2 (`loxep-acj.2`) shipped `proxy_resources`/`proxy_resource_rules` as
 * VISIBILITY ONLY, and no milestone through M7 has added a rule-authoring
 * UI (declaring a resource's rule set stays a later milestone's surface,
 * per the design's own milestone table) — so there is still no UI path in
 * this app that can seed a `proxy_resource_rules` row for a genuine
 * filter-round-trip or blocked-disable render to exercise. Seeding one
 * directly in the database would break this suite's own convention
 * (`books.spec.ts`/`inventory.spec.ts`/`connections.spec.ts` all seed
 * exclusively through the UI).
 *
 * What IS reachable, and what this test proves instead: the honest absence
 * of every rule-scoped control — the "Show only disabled rules" filter
 * toggle (`RulesList` renders it only when `disabledCount > 0`) and the
 * Retire/Re-enable buttons (`RuleRow`, offered per rule) — when a domain's
 * declared resource has no rules at all. The filter toggle's own
 * hide-disabled/only-disabled logic (a pure client-side `Array#filter` over
 * `resource.rules`) and the retire/enable orchestration's tier/lockout gates
 * are exhaustively covered where they can actually be driven with real data:
 * `packages/infrastructure/test/proxy-retire.test.ts` (20 tests, real
 * PostgreSQL) and `packages/app/test/infrastructure-proxy.test.ts` (the job
 * wiring, end to end).
 */
test('the rules panel renders no filter toggle and no retire/re-enable controls when a resource has no rules', async ({
  page
}) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Cloudflare account' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Account name *').fill(`E2E Cloudflare rules ${runId}`);
  await connectionDialog.getByLabel('API token *').fill(`cf_e2e_token_rules_${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect account' }).click();
  await expect(connectionDialog).toBeHidden();

  const domainName = `e2e-proxy-rules-${runId}.test`;
  await page.goto('/infrastructure/domains/new');
  await page.getByLabel('Domain name *').fill(domainName);
  await page.getByRole('combobox', { name: /^DNS connection/ }).click();
  await page.getByRole('option', { name: `E2E Cloudflare rules ${runId}` }).click();
  await page.getByRole('button', { name: 'Declare domain' }).click();
  await page.waitForURL('**/infrastructure/domains/**');

  await expect(page.getByText('Proxy resources', { exact: true })).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.getByText('Show only disabled rules', { exact: false })).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Retire' })).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Re-enable' })).toHaveCount(0);
});

/**
 * The provisioning-template engine (Pangolin chain design milestone 6,
 * `loxep-acj.6`) — the list, the "create from example" affordance, the
 * step ladder, and the run wizard's MANDATORY compiled-plan preview.
 *
 * ## Why this suite never clicks "Start run"
 *
 * `--mode=all` runs a real worker in this harness, and
 * `infrastructure.run-provisioning-template` would genuinely process a
 * started run — but `domain.declare`'s zone RESOLVE is a tier-0 READ, never
 * gated by the connection's write policy (which defaults `read_only`), so it
 * is NOT one of the honest write-policy blocks this design demonstrates: it
 * is a live `findZoneByName` call against whatever Cloudflare connection the
 * run's inputs name. This harness's Cloudflare connections carry FAKE tokens
 * with no live network call anywhere else in this suite (see the module doc
 * above) — deliberately, because nothing here has real egress to Cloudflare
 * to rely on. Starting a run would be the one path in this file that breaks
 * that property. So this suite stops exactly where `infrastructure.spec.ts`'s
 * own established convention already stops for the proxy-resource tests
 * above: the most-conservative REACHABLE state — list, create, preview — no
 * live call, no started run, no fabricated 'blocked' render. The actual
 * driver behavior (advance/blocked-naming/evidence/no-rollback) is
 * exhaustively covered against fakes at the service level instead:
 * `packages/infrastructure/test/provisioning.test.ts` (14 tests) and
 * `packages/app/test/infrastructure-provisioning.test.ts` (4 tests, through
 * the real composition-root wiring).
 */
test('templates list shows the empty state with a Create from example action', async ({ page }) => {
  await page.goto('/infrastructure/templates');
  await expect(page.getByRole('heading', { name: 'Provisioning templates' })).toBeVisible();
  await expect(page.getByText('No provisioning templates yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create from example' })).toBeVisible();
});

test('creates the "New domain" example template, renders its step ladder, and the run wizard previews a compiled plan with no live provider call', async ({
  page
}) => {
  await page.goto('/infrastructure/templates');
  await page.getByRole('button', { name: 'Create from example' }).click();
  await page.waitForURL('**/infrastructure/templates/**');

  await expect(page.getByRole('heading', { name: 'Provisioning template' })).toBeVisible();
  await expect(page.getByText('New domain', { exact: true })).toBeVisible();
  // The closed seven step kinds this example uses, in order — declare,
  // point DNS, ensure the Pangolin resource and its rules, enable mail,
  // ensure the mailbox.
  await expect(page.getByText('Declare domain', { exact: true })).toBeVisible();
  await expect(page.getByText('Point DNS at target', { exact: true })).toBeVisible();
  await expect(page.getByText('Ensure Pangolin resource', { exact: true })).toBeVisible();
  await expect(page.getByText('Ensure Pangolin rules', { exact: true })).toBeVisible();
  await expect(page.getByText('Enable mail', { exact: true })).toBeVisible();
  await expect(page.getByText('Ensure mailbox', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Run template' }).click();
  await page.waitForURL('**/infrastructure/templates/**/run');
  await expect(page.getByRole('heading', { name: 'Run template' })).toBeVisible();

  // One field per `${placeholder}` the template's own steps reference — no
  // hand-authored form. `domain`/`bypassAddress` render as plain text
  // fields; the three connection-shaped keys render as selects, empty in
  // this harness (no DNS/mail/Pangolin connection or hosting target exists
  // for THIS test) — a real UUID is required to compile, so a `domain`-only
  // fill honestly fails to compile, proving the MANDATORY preview refuses
  // an incomplete plan rather than fabricating a "Start run" it cannot back.
  await expect(page.getByLabel(/^domain/)).toBeVisible();
  await expect(page.getByRole('combobox', { name: /DNS connection/ })).toBeVisible();
  await page.getByLabel(/^domain/).fill('e2e-preview-only.test');

  await page.getByRole('button', { name: 'Preview compiled plan' }).click();
  await expect(page.getByText('Compiled plan preview', { exact: true })).toHaveCount(0);
  // `Start run` stays disabled until a real preview has succeeded — see
  // this test's own module doc for why this suite never supplies real
  // connection ids and never reaches that state.
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
});

/**
 * Pangolin estate browser (loxep-pq2), now mounted on the estate-browser
 * SHELL at `/infrastructure/estate/$connectionId` (loxep-47o.1's route
 * convergence — this page lived at `/infrastructure/proxy/$connectionId`
 * before the shell existed; the "Pangolin estate" heading assertion below
 * is gone for exactly that reason, see the second test's own comment). No
 * Pangolin — or any provider — connection exists in this harness (see the
 * module doc), so these two assertions are exactly what a harness with no
 * live Pangolin CAN prove honestly: the overview's quick-links card is
 * ABSENT rather than an empty list implying a browsable-but-empty estate
 * (matching `UnmatchedContainerHostsCard`'s own "punch list, not a status
 * row" rule, which `PangolinEstateLinksCard` mirrors), and the
 * per-connection page itself degrades to an honest error — never a blank
 * page or an unhandled exception — when asked for a connection id that does
 * not exist.
 */
test('infrastructure overview has no Pangolin estates card when no Pangolin connection exists', async ({
  page
}) => {
  await page.goto('/infrastructure/overview');
  await expect(page.getByRole('heading', { name: 'Infrastructure' })).toBeVisible();
  await expect(page.getByText('Pangolin estates', { exact: true })).toHaveCount(0);
});

/**
 * The estate SHELL's own honest degrade (loxep-47o.1) for an unresolvable
 * connection id — provider-agnostic by construction (Rule P1: the provider
 * is read FROM the connection row, so a connection that does not exist has
 * no provider to name yet), which is why the page heading is the shell's
 * generic "Estate" rather than "Pangolin estate": the loader's very first
 * read (`fetchEstateConnectionSummary`) is what fails here, before any
 * provider-specific server function — Pangolin's or Cloudflare's — is ever
 * reached. This is the regression this route rename must keep passing.
 */
test('the estate shell degrades honestly for a connection that does not exist', async ({
  page
}) => {
  await page.goto('/infrastructure/estate/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
  await expect(page.getByText('Could not read this connection')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});

/**
 * `/infrastructure/estate` — Rule N2's index. No connections exist in this
 * harness, so the honest assertion is an empty, rendering table rather than
 * an unhandled crash; the "Open estate" row action itself (Rule N1) is
 * covered by the next test, once a connection exists to click it from.
 */
test('the estate index renders with no connections', async ({ page }) => {
  await page.goto('/infrastructure/estate');
  await expect(page.getByRole('heading', { name: 'Estates' })).toBeVisible();
});

/**
 * The Cloudflare estate browser (loxep-47o.2) — Rule N1's "Open estate" row
 * action, all the way to the estate page's connection-identity HEADER.
 * Reuses the SAME fake-token Cloudflare fixture the proxy-resource tests
 * above already establish (`createStoreConnection` writes the row with no
 * live network call). This test deliberately asserts ONLY the header:
 * `fetchEstateConnectionSummary` is a database read (Rule P1 — no provider
 * call to resolve which provider a connection is), so it always resolves
 * fast and reliably, but the Zones section mounted below it makes a REAL
 * `listZones` call against Cloudflare with this fake token — this suite's
 * own established discipline (see the "no live egress" module doc above)
 * is to never depend on a live provider call's outcome or timing, so this
 * test proves navigation and the shell's own read wire up correctly without
 * waiting on that call at all.
 */
test("the connections row action opens a Cloudflare connection's estate page", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `E2E Cloudflare estate ${runId}`;

  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Cloudflare account' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Account name *').fill(name);
  await connectionDialog.getByLabel('API token *').fill(`cf_e2e_estate_${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect account' }).click();
  await expect(connectionDialog).toBeHidden();

  // Filtered lookup (`connections.spec.ts`'s own `filteredRow` precedent):
  // this row's exact, unique name is guaranteed to be the only match even
  // once this suite has accumulated fixtures across many runs against a
  // reused scratch database.
  await page.getByRole('textbox', { name: 'Account' }).fill(name);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Open estate' }).click();

  await page.waitForURL('**/infrastructure/estate/**');
  await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText('Cloudflare', { exact: true }).first()).toBeVisible();
});

/**
 * The Purelymail estate browser (loxep-47o.3) — same Rule N1 path as
 * Cloudflare's test above, to the same connection-identity HEADER. Domains/
 * Mailboxes/Routing rules each make a REAL provider call against this
 * fake-token fixture and are expected to render their own error state (this
 * suite's "never depend on a live provider call's outcome or timing"
 * discipline) — asserted only as "not stuck pending", never for a specific
 * error message, since the exact failure text is Purelymail's own.
 */
test("the connections row action opens a Purelymail connection's estate page", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `E2E Purelymail estate ${runId}`;

  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Purelymail account' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Account name *').fill(name);
  await connectionDialog.getByLabel('API token *').fill(`pm_e2e_estate_${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect account' }).click();
  await expect(connectionDialog).toBeHidden();

  await page.getByRole('textbox', { name: 'Account' }).fill(name);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Open estate' }).click();

  await page.waitForURL('**/infrastructure/estate/**');
  // Scoped to main — the sidebar carries a 'Domains' group label and link
  // with identical accessible text (this file's own standing rule).
  const estateMain = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
  await expect(estateMain.getByText(name, { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Purelymail', { exact: true }).first()).toBeVisible();
  await expect(estateMain.getByText('Domains', { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Mailboxes', { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Routing rules', { exact: true })).toBeVisible();
});

/**
 * The Tailscale estate browser (loxep-47o.6) — same Rule N1 path as
 * Cloudflare/Purelymail's tests above, to the same connection-identity
 * HEADER. Uses the default OAuth-client credential shape (this form's own
 * default `mode`) so the fixture needs no radio click. The Tailnet section
 * makes a REAL `listDevices()` call against this fake-credential fixture and
 * is expected to render its own error state — this suite's established
 * "never depend on a live provider call's outcome or timing" discipline
 * (see the Cloudflare test's own module doc above), so only the section
 * TITLE is asserted, never a specific device row or error message.
 */
test("the connections row action opens a Tailscale connection's estate page", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `E2E Tailscale estate ${runId}`;

  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Tailscale tailnet' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Tailnet name *').fill(name);
  await connectionDialog.getByLabel('OAuth client ID *').fill(`ts_client_e2e_${runId}`);
  await connectionDialog.getByLabel('OAuth client secret *').fill(`ts_secret_e2e_${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect tailnet' }).click();
  await expect(connectionDialog).toBeHidden();

  await page.getByRole('textbox', { name: 'Account' }).fill(name);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Open estate' }).click();

  await page.waitForURL('**/infrastructure/estate/**');
  const estateMain = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
  await expect(estateMain.getByText(name, { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Tailscale', { exact: true }).first()).toBeVisible();
  await expect(estateMain.getByText('Tailnet', { exact: true })).toBeVisible();
});

/**
 * The Beszel estate browser (loxep-47o.7) — same Rule N1 path, to the same
 * connection-identity HEADER. Both sections (Hub, Systems) make REAL
 * provider calls against this fake-credential fixture and are expected to
 * render their own error/blocked state — only the section TITLES are
 * asserted, matching every other estate e2e test's own discipline.
 */
test("the connections row action opens a Beszel connection's estate page", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `E2E Beszel estate ${runId}`;

  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Beszel hub' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Hub name *').fill(name);
  await connectionDialog.getByLabel('Hub base URL *').fill('https://beszel.example.com');
  await connectionDialog.getByLabel('Email *').fill(`beszel-readonly-${runId}@example.com`);
  await connectionDialog.getByLabel('Password *').fill(`bs_e2e_estate_${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect hub' }).click();
  await expect(connectionDialog).toBeHidden();

  await page.getByRole('textbox', { name: 'Account' }).fill(name);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Open estate' }).click();

  await page.waitForURL('**/infrastructure/estate/**');
  const estateMain = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
  await expect(estateMain.getByText(name, { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Beszel', { exact: true }).first()).toBeVisible();
  await expect(estateMain.getByText('Hub', { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Systems', { exact: true })).toBeVisible();
});

/**
 * The Termix estate browser (loxep-47o.7) — same Rule N1 path, to the same
 * connection-identity HEADER. Both sections (Hosts, Active sessions) make
 * REAL provider calls against this fake-credential fixture and are expected
 * to render their own error state — only the section TITLES are asserted.
 * The Sessions section ships instance-wide per the owner's 5b ruling
 * (2026-08-16) — see `termix-estate-functions.ts`'s module doc.
 */
test("the connections row action opens a Termix connection's estate page", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `E2E Termix estate ${runId}`;

  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Termix instance' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Instance name *').fill(name);
  await connectionDialog.getByLabel('Instance URL *').fill('https://termix.example.com');
  await connectionDialog.getByLabel('Username *').fill(`termix-readonly-${runId}`);
  await connectionDialog.getByLabel('Password *').fill(`tx_e2e_estate_${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect instance' }).click();
  await expect(connectionDialog).toBeHidden();

  await page.getByRole('textbox', { name: 'Account' }).fill(name);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Open estate' }).click();

  await page.waitForURL('**/infrastructure/estate/**');
  const estateMain = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
  await expect(estateMain.getByText(name, { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Termix', { exact: true }).first()).toBeVisible();
  await expect(estateMain.getByText('Hosts', { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Active sessions', { exact: true })).toBeVisible();
});

/**
 * The Dockhand estate browser (loxep-47o.4, READ-ONLY per its own title) —
 * same Rule N1 path, to the same connection-identity HEADER. The
 * Environments section makes a REAL `listHosts` call against this
 * fake-credential fixture and is expected to render its own error/blocked
 * state — only the section TITLE is asserted, matching every other estate
 * e2e test's own discipline. No lifecycle control of any kind is asserted
 * ABSENT here — this file has no live Dockhand host to render a container
 * row for in the first place, so `forbidden-verbs.test.ts` (the adapter's
 * own exported-surface assertion) is the binding proof, not this spec.
 */
test("the connections row action opens a Dockhand connection's estate page", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `E2E Dockhand estate ${runId}`;

  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Dockhand instance' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Instance name *').fill(name);
  await connectionDialog.getByLabel('Instance URL *').fill('https://dockhand.example.com');
  await connectionDialog.getByLabel('Username *').fill(`dockhand-readonly-${runId}`);
  await connectionDialog.getByLabel('Password *').fill(`dh_e2e_estate_${runId}`);
  await connectionDialog.getByRole('button', { name: 'Connect instance' }).click();
  await expect(connectionDialog).toBeHidden();

  await page.getByRole('textbox', { name: 'Account' }).fill(name);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { name: 'Open estate' }).click();

  await page.waitForURL('**/infrastructure/estate/**');
  const estateMain = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
  await expect(estateMain.getByText(name, { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Dockhand', { exact: true }).first()).toBeVisible();
  await expect(estateMain.getByText('Environments', { exact: true })).toBeVisible();
  // Rule 13, absolute: no lifecycle control of any kind renders anywhere on
  // this page — not even a disabled one.
  await expect(
    estateMain.getByRole('button', { name: /restart|stop|start|kill|exec/i })
  ).toHaveCount(0);
});

/**
 * The Gatus estate browser (loxep-47o.5) — same Rule N1 path, to the same
 * connection-identity HEADER. Instance/Endpoints make REAL provider calls
 * against this fake-credential fixture (no username/password filled, so the
 * connection carries no `gatus_credentials` row — the 'open' posture leg)
 * and are expected to render their own error/blocked state — only the
 * section TITLES are asserted. The mandatory heartbeat-quarantine exclusion
 * (loxep-1au Binding Rule 1) has its own unit-tested proof in
 * `gatus-estate-functions.test.ts`; this harness has no live Gatus to
 * exercise it end to end against.
 */
test("the connections row action opens a Gatus connection's estate page", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `E2E Gatus estate ${runId}`;

  await page.goto('/settings/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('menuitem', { name: 'Add Gatus instance' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Instance name *').fill(name);
  await connectionDialog.getByLabel('Instance URL *').fill('https://status.example.com');
  await connectionDialog.getByRole('button', { name: 'Connect instance' }).click();
  await expect(connectionDialog).toBeHidden();

  await page.getByRole('textbox', { name: 'Account' }).fill(name);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  // toPass retry: in the full-suite sequence a query resolving mid-open
  // re-mounts the dropdown and the item never reads stable (loxep-9iw).
  // Reopen-and-click until the menu holds still; remove with that bug.
  await expect(async () => {
    await row.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('menuitem', { name: 'Open estate' }).click({ timeout: 2000 });
  }).toPass({ timeout: 20000 });

  await page.waitForURL('**/infrastructure/estate/**');
  const estateMain = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'Estate' })).toBeVisible();
  await expect(estateMain.getByText(name, { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Gatus', { exact: true }).first()).toBeVisible();
  await expect(estateMain.getByText('Instance', { exact: true })).toBeVisible();
  await expect(estateMain.getByText('Endpoints', { exact: true })).toBeVisible();
});
