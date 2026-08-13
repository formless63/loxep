import { createFileRoute } from '@tanstack/react-router';

/**
 * Etsy OAuth2+PKCE consent callback (loxep-g4t.1).
 *
 * This path is what the redirect URI registered with the Etsy Developer
 * Portal app must be: `https://<host>/api/integrations/etsy/callback`
 * (or, per the design's documented local-development exception,
 * `http://127.0.0.1:<port>/api/integrations/etsy/callback`) — unlike eBay's
 * RuName indirection, Etsy takes this literal URL as `redirect_uri`.
 *
 * All logic lives in `@/server/etsy-oauth-callback` and is loaded
 * dynamically so the server-only module (and the integration package
 * behind it) stays out of the client bundle — mirrors
 * `/api/integrations/ebay/callback`'s shape exactly.
 */
export const Route = createFileRoute('/api/integrations/etsy/callback')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { handleEtsyConsentCallback } = await import('@/server/etsy-oauth-callback');
        return handleEtsyConsentCallback(request);
      }
    }
  }
});
