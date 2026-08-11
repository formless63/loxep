import { createFileRoute } from '@tanstack/react-router';

/**
 * eBay OAuth consent callback (loxep-62y.1.2).
 *
 * This path is what the eBay keyset's RuName ("eBay Redirect URL name") must
 * resolve to: configure `https://<host>/api/integrations/ebay/callback` as the
 * redirect's *auth accepted URL* in the eBay developer portal, then store the
 * generated RuName with the keyset. eBay's authorization request carries the
 * RuName as `redirect_uri`, never this URL directly.
 *
 * All logic lives in `@/server/ebay-oauth` and is loaded dynamically so the
 * server-only module (and the integration package behind it) stays out of the
 * client bundle, matching the `/api/auth/$` route's shape.
 */
export const Route = createFileRoute('/api/integrations/ebay/callback')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { handleEbayConsentCallback } = await import('@/server/ebay-oauth');
        return handleEbayConsentCallback(request);
      }
    }
  }
});
