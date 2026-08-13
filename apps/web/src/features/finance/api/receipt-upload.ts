import type { ExpenseMediaPurpose } from '@/features/finance/constants';

/**
 * Client-side call to `POST /api/expenses/receipt` (loxep-dgf.1) — a plain
 * HTTP multipart upload, not a `createServerFn`, since the payload is binary
 * file bytes rather than a JSON-shaped input. Mirrors
 * `@/features/account/api/avatar.ts`'s `uploadAvatar`. `errorMessage` on a
 * non-OK response is whatever `handleReceiptUpload`
 * (`@/server/receipt-media`) put in the JSON body's `message`, including the
 * 409 "no storage backend" case.
 */
export interface ReceiptUploadResult {
  mediaObjectId: string;
  purpose: string;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number;
  servingUrl: string;
}

export async function uploadReceipt(input: {
  file: File;
  expenseId: string;
  purpose?: ExpenseMediaPurpose;
}): Promise<ReceiptUploadResult> {
  const formData = new FormData();
  formData.set('file', input.file);
  formData.set('expenseId', input.expenseId);
  if (input.purpose) {
    formData.set('purpose', input.purpose);
  }

  const response = await fetch('/api/expenses/receipt', {
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
    throw new Error(message ?? 'Failed to upload receipt');
  }

  return response.json() as Promise<ReceiptUploadResult>;
}
