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
  await expect(page.getByText('Check your email')).toBeVisible();
  const magicLink = await waitForMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL('**/dashboard/overview');
}
