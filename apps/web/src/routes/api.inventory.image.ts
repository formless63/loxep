import { createFileRoute } from '@tanstack/react-router';

/**
 * Item image upload for the /inventory gallery (loxep-dgf.3, M3): `POST` a
 * multipart/form-data image or PDF under the `file` field, plus the target
 * `inventoryItemId` (and an optional `purpose`). All logic lives in
 * `@/server/inventory-media` and is loaded dynamically so the server-only
 * module (and `@loxep/storage`/`@loxep/inventory` behind it) stays out of
 * the client bundle — mirrors `/api/expenses/receipt`.
 */
export const Route = createFileRoute('/api/inventory/image')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleInventoryImageUpload } = await import('@/server/inventory-media');
        return handleInventoryImageUpload(request);
      }
    }
  }
});
