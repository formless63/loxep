import { expect, test } from '@playwright/test';

/**
 * Session guards and health contract: anonymous visitors never reach the
 * workspace routes, and the readiness probe answers 200 JSON when the
 * harness stack (database migrated, worker embedded) is healthy.
 */

test('unauthenticated /dashboard redirects to sign-in', async ({ page }) => {
  await page.goto('/dashboard/overview');
  await page.waitForURL('**/auth/sign-in');
  await expect(page.getByText('Sign in to Loxep')).toBeVisible();
});

test('unauthenticated /settings redirects to sign-in', async ({ page }) => {
  await page.goto('/settings/overview');
  await page.waitForURL('**/auth/sign-in');
  await expect(page.getByText('Sign in to Loxep')).toBeVisible();
});

test('/health/ready returns 200 JSON with ok status', async ({ request }) => {
  const res = await request.get('/health/ready');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  const report = (await res.json()) as { status: string; checks: Record<string, unknown> };
  expect(report.status).toBe('ok');
  expect(report.checks).toBeTruthy();
});
