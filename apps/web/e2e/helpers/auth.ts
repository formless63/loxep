import { expect, type Page } from '@playwright/test';
import { deleteMessagesFor, waitForMagicLink } from './mailpit';

/**
 * Bootstrap-admin identity: the harness starts the server with
 * `LOXEP_BOOTSTRAP_ADMIN_EMAIL=e2e-admin@example.com`, so this address
 * receives the deployment `admin` role on first sign-in.
 */
export const ADMIN_EMAIL = 'e2e-admin@example.com';

/** Ordinary member identity (no bootstrap match → default `member` role). */
export const MEMBER_EMAIL = 'e2e-member@example.com';

/** storageState path shared by specs that reuse the admin session. */
export const ADMIN_STORAGE_STATE = 'e2e/.auth/admin.json';

/**
 * Complete the real magic-link flow through the UI: request a link on
 * /auth/sign-in, pull the verification URL from Mailpit, and follow it.
 * Lands authenticated on /dashboard/overview.
 */
export async function signInWithMagicLink(page: Page, email: string): Promise<void> {
  await deleteMessagesFor(email);
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email *').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  // Wait on the mail actually landing in Mailpit BEFORE asserting the
  // "Check your email" UI copy (loxep-u6p). That copy only renders after the
  // client's `authClient.signIn.magicLink()` call resolves, and the
  // server-side `sendMagicLink` hook `await`s the SMTP send before it ever
  // responds (`create-auth.ts`) — so by the time the message exists in
  // Mailpit, the response (and the UI text) is already on its way, and by
  // the time this poll returns the copy is reliably up already. Gating on
  // the UI text FIRST, against Playwright's 10s default expect timeout, is
  // what flaked once: it raced the request's full round trip (client call →
  // server → SMTP handoff → response) inside a window shorter than
  // `waitForMagicLink`'s own 15s poll allows for the same round trip. Mailpit
  // is the ground truth that the link was actually sent, so wait on it
  // first and let a genuine send failure (e.g. a rejected/rate-limited
  // request) surface as `waitForMagicLink`'s own clear timeout message
  // instead of a misleading "Check your email never appeared".
  const magicLink = await waitForMagicLink(email);
  await expect(page.getByText('Check your email')).toBeVisible();
  await page.goto(magicLink);
  await page.waitForURL('**/dashboard/overview');
}
