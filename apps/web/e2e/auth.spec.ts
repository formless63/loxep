import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, MEMBER_EMAIL, signInWithMagicLink } from './helpers/auth';
import { deleteMessagesFor } from './helpers/mailpit';

/**
 * Magic-link authentication critical flow (ADR-0007): anonymous redirect,
 * sign-in form, check-your-email state, real link completion via Mailpit,
 * and sign-out. Plus the account provisioning policy (ADR-0024) end to end.
 *
 * Ordering note: Playwright runs spec files alphabetically on one worker, so
 * this file runs first against a fresh harness database — which is why the
 * member sign-in above still succeeds under the shipped closed-by-default
 * policy. No administrator exists yet at that point, so provisioning is in its
 * bootstrap window. The last test is what closes that window (by signing the
 * bootstrap admin in) and it restores an open policy before finishing.
 */

test('anonymous visit to / redirects to /auth/sign-in', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL('**/auth/sign-in');
  await expect(page.getByText('Sign in to Loxep')).toBeVisible();
});

test('sign-in page renders the magic-link email form', async ({ page }) => {
  await page.goto('/auth/sign-in');
  await expect(page.getByText('Sign in to Loxep')).toBeVisible();
  await expect(page.getByLabel('Email *')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send sign-in link' })).toBeVisible();
});

test('submitting an email reaches the check-your-email state', async ({ page }) => {
  const email = 'e2e-pending@example.com';
  await deleteMessagesFor(email);
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email *').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  // Consume the unused link so later runs start clean.
  await deleteMessagesFor(email);
});

test('magic link from Mailpit signs in; sign-out returns to sign-in', async ({ page }) => {
  await signInWithMagicLink(page, MEMBER_EMAIL);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Account menu lives in the sidebar footer; its button shows the user identity.
  await page.getByRole('button', { name: new RegExp(MEMBER_EMAIL) }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL('**/auth/sign-in');
  await expect(page.getByText('Sign in to Loxep')).toBeVisible();
});

const MAILPIT_API = process.env['LOXEP_E2E_MAILPIT_API'] ?? 'http://localhost:8025/api/v1';

/**
 * Whether Mailpit ever receives a message for `email` within `windowMs`.
 * Proving a NEGATIVE needs a real wait — a single immediate poll would pass
 * even if the link were merely slow — so this drains the whole window when
 * nothing arrives and returns early the moment something does.
 */
async function anyMessageArrives(email: string, windowMs = 4000): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  const url = `${MAILPIT_API}/search?query=${encodeURIComponent(`to:"${email}"`)}`;
  while (Date.now() < deadline) {
    const res = await fetch(url);
    if (res.ok) {
      const result = (await res.json()) as { messages: unknown[] };
      if (result.messages.length > 0) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** The magic-link provisioning switch on /settings/users (ADR-0024). */
const NEW_ACCOUNTS_SWITCH = 'Anyone with an email address can create an account';

test('closing new accounts states it on the sign-in page and stops the link', async ({
  page,
  browser
}) => {
  // Two real magic-link round trips plus a deliberate no-mail wait.
  test.setTimeout(90_000);

  // The bootstrap admin's first sign-in is also what closes the provisioning
  // bootstrap window (ADR-0016 grants admin; ADR-0024 then honours the stored
  // policy). Before this point the installation has no administrator at all.
  await signInWithMagicLink(page, ADMIN_EMAIL);

  await page.goto('/settings/users');
  const newAccounts = page.getByRole('switch', { name: NEW_ACCOUNTS_SWITCH });
  await expect(newAccounts).toBeVisible();
  if ((await newAccounts.getAttribute('data-state')) === 'checked') {
    await newAccounts.click();
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('New accounts closed')).toBeVisible();

  // A second context is an anonymous visitor — no sign-out needed.
  const anonymous = await browser.newPage({
    baseURL: process.env['LOXEP_E2E_BASE_URL'] ?? 'http://localhost:3093',
    storageState: undefined
  });
  try {
    await anonymous.goto('/auth/sign-in');
    await expect(anonymous.getByText('New accounts are closed')).toBeVisible();
    await expect(
      anonymous.getByText('an administrator must create one for you', { exact: false })
    ).toBeVisible();

    // A stranger's request is accepted-looking (no account-existence oracle)
    // but no mail is sent at all.
    const stranger = 'e2e-stranger@example.com';
    await deleteMessagesFor(stranger);
    await anonymous.getByLabel('Email *').fill(stranger);
    await anonymous.getByRole('button', { name: 'Send sign-in link' }).click();
    await expect(anonymous.getByText('Check your email')).toBeVisible();
    expect(await anyMessageArrives(stranger)).toBe(false);
  } finally {
    await anonymous.close();
  }

  // Restore an open policy so the rest of the suite — and a rerun against this
  // same harness database — behaves exactly as a fresh one does.
  await page.goto('/settings/users');
  await page.getByRole('switch', { name: NEW_ACCOUNTS_SWITCH }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('New accounts open')).toBeVisible();
});
