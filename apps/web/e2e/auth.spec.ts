import { expect, test } from '@playwright/test';
import { MEMBER_EMAIL, signInWithMagicLink } from './helpers/auth';
import { deleteMessagesFor } from './helpers/mailpit';

/**
 * Magic-link authentication critical flow (ADR-0007): anonymous redirect,
 * sign-in form, check-your-email state, real link completion via Mailpit,
 * and sign-out.
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
