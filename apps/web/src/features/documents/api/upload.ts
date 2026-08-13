/**
 * Client-side call to `POST /api/documents/upload` (loxep-dgf.4) — a plain
 * HTTP multipart upload, not a `createServerFn`, mirroring
 * `@/features/finance/api/receipt-upload.ts`'s `uploadReceipt`.
 */
export interface DocumentUploadResult {
  documentId: string;
  mediaObjectId: string;
  documentKind: string;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number;
  servingUrl: string;
}

export async function uploadDocument(input: {
  file: File;
  documentKind?: 'receipt' | 'invoice' | 'packing_slip' | 'statement';
}): Promise<DocumentUploadResult> {
  const formData = new FormData();
  formData.set('file', input.file);
  if (input.documentKind) {
    formData.set('documentKind', input.documentKind);
  }

  const response = await fetch('/api/documents/upload', {
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
    throw new Error(message ?? 'Failed to upload document');
  }

  return response.json() as Promise<DocumentUploadResult>;
}
