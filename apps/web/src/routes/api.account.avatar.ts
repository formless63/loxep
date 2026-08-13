import { createFileRoute } from '@tanstack/react-router';

/**
 * Self-service avatar upload (loxep-0oq): `POST` a multipart/form-data image
 * under the `file` field. All logic lives in `@/server/avatar` and is loaded
 * dynamically so the server-only module (and `@loxep/storage` behind it)
 * stays out of the client bundle — see that module's doc, and the
 * `/api/integrations/ebay/callback` route's, for the shared shape.
 */
export const Route = createFileRoute('/api/account/avatar')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleAvatarUpload } = await import('@/server/avatar');
        return handleAvatarUpload(request);
      }
    }
  }
});
