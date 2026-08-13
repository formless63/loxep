import { createFileRoute } from '@tanstack/react-router';

/**
 * Receipt serving route (loxep-dgf.1): streams a Loxep-stored receipt's
 * bytes back by `media_objects.id`. Gated on its OWN
 * `metadata.purpose === 'receipt'` — see `@/server/receipt-media`'s doc for
 * why this must stay a SEPARATE gate from `/api/media/avatar/$mediaId`'s,
 * rather than loosening that one. All logic lives there and is loaded
 * dynamically, matching `/api/media/avatar/$mediaId`.
 */
export const Route = createFileRoute('/api/media/receipt/$mediaId')({
  server: {
    handlers: {
      GET: async ({ params }: { params: { mediaId: string } }) => {
        const { handleReceiptServe } = await import('@/server/receipt-media');
        return handleReceiptServe(params.mediaId);
      }
    }
  }
});
