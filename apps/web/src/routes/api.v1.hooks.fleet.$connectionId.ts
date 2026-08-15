import { createFileRoute } from '@tanstack/react-router';

/**
 * Fleet alert evidence webhook (Phase 8 milestone 7, loxep-ovj.7) —
 * `POST /api/v1/hooks/fleet/:connectionId`, `Authorization: Bearer <per-
 * connection ingest token>`. Loxep's FIRST inbound integration surface and
 * the opening move of the stable `/api/v1` the contract designs toward.
 *
 * Deliberately UNAUTHENTICATED BY SESSION — there is no admin browser
 * session on the other end of this request, only a companion tool (Gatus,
 * Beszel, Databasus, …) POSTing to a URL an operator pasted into its own
 * configuration. Authentication is the bearer token alone, verified in
 * `@/server/fleet-evidence-webhook`, which also owns the rate limit and size
 * cap the design requires run BEFORE any parsing. All logic lives there and
 * is loaded dynamically so the server-only module — and every integration
 * package behind it — stays out of the client bundle, mirroring
 * `/api/integrations/ebay/callback`'s split.
 */
export const Route = createFileRoute('/api/v1/hooks/fleet/$connectionId')({
  server: {
    handlers: {
      POST: async ({ request, params }: { request: Request; params: { connectionId: string } }) => {
        const { handleFleetEvidenceWebhook } = await import('@/server/fleet-evidence-webhook');
        return handleFleetEvidenceWebhook(request, params.connectionId);
      }
    }
  }
});
