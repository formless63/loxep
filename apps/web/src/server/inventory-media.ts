/**
 * Item image gallery upload/serve handlers (loxep-dgf.3, M3): reached ONLY
 * from the two server-only API routes — `routes/api.inventory.image.ts`
 * (POST) and `routes/api.media.inventory.$mediaId.ts` (GET) — via a dynamic
 * import inside each route's handler, mirroring `@/server/avatar.ts` and
 * `@/server/receipt-media.ts`'s shape.
 *
 * Divergences from both precedents, per the design
 * (`flipping-lifecycle-design.md`, "Images" / "The upload path mirrors
 * handleAvatarUpload"):
 *
 *  - the payload is scoped to ONE inventory item (`inventoryItemId` in the
 *    form data) and attaches through `@loxep/inventory`'s
 *    `InventoryMediaService.attach` — a media upload with no item to attach
 *    to is not yet gallery content;
 *  - many objects per item, so there is no "replace" semantics — each
 *    upload ADDS a link at the end of its purpose group, exactly like the
 *    receipt path and unlike the avatar path's single-object replace;
 *  - the serving route is its OWN route with its OWN
 *    `metadata.purpose === 'item_image'` gate — the avatar and receipt
 *    routes' gates are UNTOUCHED, exactly as the design and the
 *    implementation contract require, so none of the three can become a
 *    generic "fetch any media by id" endpoint;
 *  - the size cap and MIME allowlist are a SETTING
 *    (`inventoryMediaLimitsSetting`, `@loxep/domain`), not a hardcoded
 *    constant — the design's explicit point: 2 MB is right for one avatar
 *    and wrong for a twelve-photo gallery, and unlike the receipt path
 *    (which predates this pattern) M3 is specified to use a registered
 *    setting from the start;
 *  - session-gated (any authenticated member, matching every other write on
 *    `/inventory`) rather than an ACL — media ownership is a metadata fact,
 *    never a permission container.
 */
import { Readable } from 'node:stream';
import { inventoryMediaLimitsSetting } from '@loxep/domain';
import { MediaObjectNotFoundError, StorageBackendError } from '@loxep/storage';
import { parseLimitedMultipartFormData } from '@/server/multipart-upload';

/**
 * The media OBJECT's own `metadata.purpose` — a single constant, used ONLY
 * to gate the serving route below. Distinct from `media_links.purpose`
 * (`gallery | condition_evidence | supporting_document`,
 * `InventoryMediaService`'s richer union for how an attachment relates to
 * the item) — same split the design draws between "media knows how the file
 * is identified" and "the domain knows the image is item evidence", the
 * identical treatment `@/server/receipt-media.ts` gives its own
 * `RECEIPT_MEDIA_METADATA_PURPOSE`.
 */
const ITEM_MEDIA_METADATA_PURPOSE = 'item_image';
const ITEM_LINK_PURPOSES = new Set(['gallery', 'condition_evidence', 'supporting_document']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** `POST /api/inventory/image` — multipart upload attached to one inventory item. */
export async function handleInventoryImageUpload(request: Request): Promise<Response> {
  const { requireSession, getAdminServices, getMediaService, getInventoryMediaService } =
    await import('@/server/admin');

  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch {
    return jsonResponse(401, { error: 'unauthorized', message: 'Authentication required' });
  }

  const { settings } = getAdminServices();
  const limits = await settings.get(inventoryMediaLimitsSetting);
  const parsed = await parseLimitedMultipartFormData(request, limits.maxBytes);
  if (!parsed.ok) return parsed.response;
  const { formData } = parsed;

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return jsonResponse(400, {
      error: 'invalid-request',
      message: 'Missing "file" field in the upload'
    });
  }
  const inventoryItemIdField = formData.get('inventoryItemId');
  if (typeof inventoryItemIdField !== 'string' || !UUID_PATTERN.test(inventoryItemIdField)) {
    return jsonResponse(400, {
      error: 'invalid-request',
      message: 'Missing or invalid "inventoryItemId" field'
    });
  }
  const inventoryItemId = inventoryItemIdField;
  const purposeField = formData.get('purpose');
  const purpose =
    typeof purposeField === 'string' && ITEM_LINK_PURPOSES.has(purposeField)
      ? (purposeField as 'gallery' | 'condition_evidence' | 'supporting_document')
      : 'gallery';

  if (!limits.allowedMimeTypes.includes(file.type)) {
    return jsonResponse(400, {
      error: 'invalid-content-type',
      message: `Item media must be one of: ${limits.allowedMimeTypes.join(', ')}`
    });
  }
  if (file.size > limits.maxBytes) {
    return jsonResponse(400, {
      error: 'file-too-large',
      message: `Item media must be ${Math.floor(limits.maxBytes / (1024 * 1024))}MB or smaller`
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
      metadata: { purpose: ITEM_MEDIA_METADATA_PURPOSE }
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

  const inventoryMediaService = await getInventoryMediaService();
  let link: Awaited<ReturnType<typeof inventoryMediaService.attach>>['link'];
  try {
    ({ link } = await inventoryMediaService.attach({
      inventoryItemId,
      mediaObjectId: mediaObject.id,
      purpose,
      actorUserId: session.user.id
    }));
  } catch (error) {
    // The item didn't exist (or some other attach failure) — clean up the
    // object we just wrote rather than leaving an unreferenced upload behind.
    await mediaService.remove(mediaObject.id).catch(() => undefined);
    throw error;
  }

  return jsonResponse(200, {
    mediaObjectId: mediaObject.id,
    purpose: link.purpose,
    sortOrder: link.sortOrder,
    originalFilename: mediaObject.originalFilename,
    mimeType: mediaObject.mimeType,
    sizeBytes: mediaObject.sizeBytes,
    servingUrl: `/api/media/inventory/${mediaObject.id}`
  });
}

/** `GET /api/media/inventory/:mediaId` — streams a stored item image's bytes back. */
export async function handleInventoryImageServe(mediaId: string): Promise<Response> {
  const { requireSession, getMediaService } = await import('@/server/admin');

  try {
    await requireSession();
  } catch {
    return jsonResponse(401, { error: 'unauthorized', message: 'Authentication required' });
  }

  if (!UUID_PATTERN.test(mediaId)) {
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
  if (purpose !== ITEM_MEDIA_METADATA_PURPOSE) {
    body.destroy();
    return new Response(null, { status: 404 });
  }

  return new Response(Readable.toWeb(body) as unknown as ReadableStream, {
    status: 200,
    headers: {
      'content-type': mediaObject.mimeType ?? 'application/octet-stream',
      'content-length': String(mediaObject.sizeBytes),
      // Private (session-gated) and immutable in practice — a re-upload gets
      // a new media id/URL rather than overwriting bytes in place.
      'cache-control': 'private, max-age=86400, immutable'
    }
  });
}
