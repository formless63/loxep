import { createFileRoute } from '@tanstack/react-router';

/**
 * Item image serving route (loxep-dgf.3, M3): streams a Loxep-stored item
 * image's bytes back by `media_objects.id`. Gated on its OWN
 * `metadata.purpose === 'item_image'` — see `@/server/inventory-media`'s doc
 * for why this must stay a SEPARATE gate from `/api/media/avatar/$mediaId`'s
 * and `/api/media/receipt/$mediaId`'s, rather than loosening either of
 * those. All logic lives there and is loaded dynamically, matching
 * `/api/media/receipt/$mediaId`.
 */
export const Route = createFileRoute('/api/media/inventory/$mediaId')({
  server: {
    handlers: {
      GET: async ({ params }: { params: { mediaId: string } }) => {
        const { handleInventoryImageServe } = await import('@/server/inventory-media');
        return handleInventoryImageServe(params.mediaId);
      }
    }
  }
});
