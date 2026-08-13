/**
 * Client-side call to `POST /api/inventory/image` (loxep-dgf.3) — a plain
 * HTTP multipart upload, not a `createServerFn`, since the payload is binary
 * file bytes rather than a JSON-shaped input. Mirrors
 * `@/features/finance/api/receipt-upload.ts`'s `uploadReceipt`.
 * `errorMessage` on a non-OK response is whatever `handleInventoryImageUpload`
 * (`@/server/inventory-media`) put in the JSON body's `message`, including
 * the 409 "no storage backend" case.
 */
export interface InventoryImageUploadResult {
  mediaObjectId: string;
  purpose: string;
  sortOrder: number | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number;
  servingUrl: string;
}

export async function uploadInventoryImage(input: {
  file: File;
  inventoryItemId: string;
  purpose?: 'gallery' | 'condition_evidence' | 'supporting_document';
}): Promise<InventoryImageUploadResult> {
  const formData = new FormData();
  formData.set('file', input.file);
  formData.set('inventoryItemId', input.inventoryItemId);
  if (input.purpose) {
    formData.set('purpose', input.purpose);
  }

  const response = await fetch('/api/inventory/image', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const message = await response
      .json()
      .then((body: unknown) =>
        typeof body === 'object' && body !== null && 'message' in body
          ? String((body as { message: unknown }).message)
          : null
      )
      .catch(() => null);
    throw new Error(message ?? 'Failed to upload image');
  }

  return response.json() as Promise<InventoryImageUploadResult>;
}
