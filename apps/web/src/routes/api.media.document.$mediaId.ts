import { createFileRoute } from '@tanstack/react-router';

/**
 * Document serving route (loxep-dgf.4, M4): streams a Loxep-stored
 * receipt/invoice's bytes back by `media_objects.id`. Gated on its OWN
 * `metadata.purpose === 'document'` — a separate gate from
 * `/api/media/receipt/$mediaId`'s and `/api/media/inventory/$mediaId`'s, per
 * the implementation contract's rule that no serving route becomes a
 * generic "fetch any media by id" endpoint. All logic lives in
 * `@/server/documents-media` and is loaded dynamically.
 */
export const Route = createFileRoute('/api/media/document/$mediaId')({
  server: {
    handlers: {
      GET: async ({ params }: { params: { mediaId: string } }) => {
        const { handleDocumentServe } = await import('@/server/documents-media');
        return handleDocumentServe(params.mediaId);
      }
    }
  }
});
