import { readFileSync } from 'node:fs';
import type { BrowserContext } from '@playwright/test';

interface QaSessionFile {
  cookieName: string;
  cookieValue: string;
  /** ISO timestamp; matches the `session.expiresAt` row the mint script inserted. */
  expiresAt: string;
}

/**
 * Apply a QA-minted Better Auth session (loxep-kw3) to a Playwright browser
 * context by adding its signed session cookie directly, bypassing the
 * magic-link sign-in flow entirely.
 *
 * Exists because the live stack's SMTP is real (Purelymail): magic-link
 * emails no longer land in a Mailpit this suite can read, so
 * `signInWithMagicLink` (`./auth.ts`) does not work against it. The
 * companion `scripts/mint-qa-session.mjs` runs inside the app container,
 * inserts a real `session` row for an existing user, and writes
 * `{cookieName, cookieValue, expiresAt}` to a JSON file using better-auth's
 * / better-call's own cookie-signing functions — this helper never signs or
 * derives anything itself, it only replays what the script already
 * produced.
 *
 * `sessionFilePath` must point at that JSON file, which must live in a
 * scratch/temp location and be deleted as soon as the run that consumes it
 * finishes — it contains a live, valid session cookie. `origin` is the
 * deployment the cookie is scoped to (e.g. `https://dev.loxep.com`).
 *
 * Cookie attributes (`Secure`, `httpOnly`, `path=/`, `SameSite=Lax`, no
 * `Domain`) mirror what better-auth's `createCookieGetter` computes for an
 * https `baseURL` with no `advanced` cookie overrides — see
 * `packages/auth/src/create-auth.ts`, which sets none.
 */
export async function applyQaSession(
  context: BrowserContext,
  sessionFilePath: string,
  origin: string
): Promise<void> {
  const session = JSON.parse(readFileSync(sessionFilePath, 'utf8')) as QaSessionFile;
  const { hostname } = new URL(origin);

  await context.addCookies([
    {
      name: session.cookieName,
      value: session.cookieValue,
      domain: hostname,
      path: '/',
      expires: Math.floor(new Date(session.expiresAt).getTime() / 1000),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    }
  ]);
}
