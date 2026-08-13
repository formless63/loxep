/**
 * Client-side call to `POST /api/account/avatar` (loxep-0oq) — a plain HTTP
 * multipart upload, not a `createServerFn`, since the payload is binary
 * image bytes rather than a JSON-shaped input. `errorMessage` on a non-OK
 * response is whatever `handleAvatarUpload` (`@/server/avatar`) put in the
 * JSON body's `message`, including the 409 "no storage backend" case.
 */
export interface AvatarUploadResult {
  image: string;
}

export async function uploadAvatar(file: File): Promise<AvatarUploadResult> {
  const formData = new FormData();
  formData.set('file', file);

  const response = await fetch('/api/account/avatar', {
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
    throw new Error(message ?? 'Failed to upload avatar');
  }

  return response.json() as Promise<AvatarUploadResult>;
}
