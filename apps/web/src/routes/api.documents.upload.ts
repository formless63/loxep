import { createFileRoute } from '@tanstack/react-router';

/**
 * Receipt/invoice upload for the `/finance/import` review flow (loxep-dgf.4,
 * M4): `POST` a multipart/form-data image or PDF under the `file` field,
 * plus an optional `documentKind` (`receipt | invoice | packing_slip |
 * statement`, default `receipt`). All logic lives in
 * `@/server/documents-media` and is loaded dynamically so the server-only
 * module stays out of the client bundle — mirrors `/api/expenses/receipt`
 * and `/api/inventory/image`.
 */
export const Route = createFileRoute('/api/documents/upload')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleDocumentUpload } = await import('@/server/documents-media');
        return handleDocumentUpload(request);
      }
    }
  }
});
