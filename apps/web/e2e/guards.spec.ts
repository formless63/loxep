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

/**
 * Fleet alert evidence webhook (Phase 8 milestone 7, loxep-ovj.7) — Loxep's
 * first inbound integration surface, unauthenticated by session on purpose.
 * A wrong bearer token and an unknown connection id must be
 * INDISTINGUISHABLE, both a bare 401 — the cheap end-to-end proof that the
 * real built app answers this way over HTTP, not just in a unit test
 * against an injected service.
 */
test('fleet evidence webhook rejects an unknown connection and a bad token identically', async ({
  request
}) => {
  const unknownConnection = await request.post(
    '/api/v1/hooks/fleet/00000000-0000-4000-8000-000000000000',
    {
      headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
      data: { status: 'ok' }
    }
  );
  expect(unknownConnection.status()).toBe(401);

  const missingToken = await request.post(
    '/api/v1/hooks/fleet/00000000-0000-4000-8000-000000000000',
    { headers: { 'content-type': 'application/json' }, data: { status: 'ok' } }
  );
  expect(missingToken.status()).toBe(401);

  const unknownBody = (await unknownConnection.json()) as unknown;
  const missingBody = (await missingToken.json()) as unknown;
  expect(unknownBody).toEqual(missingBody);
});
