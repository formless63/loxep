import { createFileRoute } from '@tanstack/react-router';

/**
 * Better Auth catch-all API route (better-auth.com/docs/integrations/tanstack):
 * every /api/auth/* request — magic-link send/verify, OAuth2 sign-in and
 * callback, session endpoints — delegates to the server-side instance's
 * fetch handler. Cookie setting rides on the returned Response's Set-Cookie
 * headers, so no framework cookie plugin is involved on this path.
 */
async function handle({ request }: { request: Request }) {
  const { getAuth } = await import('@/server/auth');
  return getAuth().handler(request);
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle
    }
  }
});
