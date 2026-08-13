import { createFileRoute } from '@tanstack/react-router';

/**
 * Receipt upload for an expense (loxep-dgf.1): `POST` a multipart/form-data
 * image or PDF under the `file` field, plus the target `expenseId` (and an
 * optional `purpose`). All logic lives in `@/server/receipt-media` and is
 * loaded dynamically so the server-only module (and `@loxep/storage`/
 * `@loxep/accounting` behind it) stays out of the client bundle — mirrors
 * `/api/account/avatar`.
 */
export const Route = createFileRoute('/api/expenses/receipt')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleReceiptUpload } = await import('@/server/receipt-media');
        return handleReceiptUpload(request);
      }
    }
  }
});
