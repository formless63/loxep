/**
 * Avatar upload/serve handlers (loxep-0oq): reached ONLY from the two
 * server-only API routes — `routes/api.account.avatar.ts` (POST) and
 * `routes/api.media.avatar.$mediaId.ts` (GET) — via a dynamic import inside
 * each route's handler, matching the shape `server/ebay-oauth-callback.ts`
 * establishes for non-serverFn HTTP routes.
 *
 * Media ownership is a metadata fact (`media_objects.created_by_user_id`),
 * never an ACL (implementation contract): the upload records who uploaded
 * an avatar, but any signed-in user may fetch any avatar by id — the same
 * trust model plain URL avatars already have. `metadata.purpose` gates the
 * serving route to media actually uploaded as an avatar, so this endpoint
 * can't be repurposed into a general "fetch any media object by id" route
 * without that being a deliberate, separate decision later.
 *
 * Replace semantics: uploading again overwrites `user.image` (via the same
 * `auth.api.updateUser` call `updateProfile` uses) and deletes the previous
 * media object — but ONLY when the previous `user.image` was itself a
 * Loxep-hosted avatar URL (`extractAvatarMediaId` returns non-null); an
 * external OIDC/user-supplied URL is left alone.
 */
import '@tanstack/react-start/server-only';

import { Readable } from 'node:stream';
import { MediaObjectNotFoundError, StorageBackendError } from '@loxep/storage';
import { avatarServingUrl, extractAvatarMediaId } from '@/lib/avatar';
import { parseLimitedMultipartFormData } from '@/server/multipart-upload';

const ALLOWED_AVATAR_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** `POST /api/account/avatar` — multipart image upload for the caller's own avatar. */
export async function handleAvatarUpload(request: Request): Promise<Response> {
  const [{ requireSession, getMediaService }, { getAuth }, { getRequestHeaders }] =
    await Promise.all([
      import('@/server/admin'),
      import('@/server/auth'),
      import('@tanstack/react-start/server')
    ]);

  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch {
    return jsonResponse(401, { error: 'unauthorized', message: 'Authentication required' });
  }

  const parsed = await parseLimitedMultipartFormData(request, MAX_AVATAR_BYTES);
  if (!parsed.ok) return parsed.response;
  const { formData } = parsed;

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return jsonResponse(400, {
      error: 'invalid-request',
      message: 'Missing "file" field in the upload'
    });
  }
  if (!ALLOWED_AVATAR_MIME_TYPES.has(file.type)) {
    return jsonResponse(400, {
      error: 'invalid-content-type',
      message: 'Avatars must be a PNG, JPEG, or WEBP image'
    });
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return jsonResponse(400, {
      error: 'file-too-large',
      message: 'Avatars must be 2MB or smaller'
    });
  }

  const mediaService = await getMediaService();
  const bytes = new Uint8Array(await file.arrayBuffer());

  let mediaObject: Awaited<ReturnType<typeof mediaService.upload>>;
  try {
    mediaObject = await mediaService.upload({
      data: bytes,
      originalFilename: file.name,
      mimeType: file.type,
      createdByUserId: session.user.id,
      metadata: { purpose: 'avatar' }
    });
  } catch (error) {
    if (error instanceof StorageBackendError) {
      return jsonResponse(409, {
        error: 'no-storage-backend',
        message: 'Register a storage backend under /settings/storage first.'
      });
    }
    throw error;
  }

  const servingUrl = avatarServingUrl(mediaObject.id);
  const previousImage = session.user.image ?? null;

  const headers = getRequestHeaders();
  await getAuth().api.updateUser({ headers, body: { image: servingUrl } });

  // Replace semantics: delete the previous object ONLY when it was itself a
  // Loxep-stored avatar, and never the one we just wrote.
  const previousMediaId = previousImage !== null ? extractAvatarMediaId(previousImage) : null;
  if (previousMediaId !== null && previousMediaId !== mediaObject.id) {
    await mediaService.remove(previousMediaId).catch(() => undefined);
  }

  return jsonResponse(200, { image: servingUrl });
}

/** `GET /api/media/avatar/:mediaId` — streams a stored avatar's bytes back. */
export async function handleAvatarServe(mediaId: string): Promise<Response> {
  const { requireSession, getMediaService } = await import('@/server/admin');

  try {
    await requireSession();
  } catch {
    return jsonResponse(401, { error: 'unauthorized', message: 'Authentication required' });
  }

  if (!MEDIA_ID_PATTERN.test(mediaId)) {
    return new Response(null, { status: 404 });
  }

  const mediaService = await getMediaService();
  let mediaObject: Awaited<ReturnType<typeof mediaService.read>>['mediaObject'];
  let body: Awaited<ReturnType<typeof mediaService.read>>['body'];
  try {
    ({ mediaObject, body } = await mediaService.read(mediaId));
  } catch (error) {
    if (error instanceof MediaObjectNotFoundError) {
      return new Response(null, { status: 404 });
    }
    throw error;
  }

  const metadata = mediaObject.metadata;
  const purpose =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).purpose
      : undefined;
  if (purpose !== 'avatar') {
    body.destroy();
    return new Response(null, { status: 404 });
  }

  return new Response(Readable.toWeb(body) as unknown as ReadableStream, {
    status: 200,
    headers: {
      'content-type': mediaObject.mimeType ?? 'application/octet-stream',
      'content-length': String(mediaObject.sizeBytes),
      // Private (session-gated) and immutable in practice — a new upload
      // gets a new media id/URL rather than overwriting bytes in place.
      'cache-control': 'private, max-age=86400, immutable'
    }
  });
}
