/**
 * Receipt upload/serve handlers (loxep-dgf.1): reached ONLY from the two
 * server-only API routes — `routes/api.expenses.receipt.ts` (POST) and
 * `routes/api.media.receipt.$mediaId.ts` (GET) — via a dynamic import inside
 * each route's handler, mirroring `@/server/avatar`'s shape.
 *
 * Divergences from the avatar path, per the design
 * (`flipping-lifecycle-design.md`, "Where a receipt attaches when the spend
 * was a purchase" / "The upload path mirrors handleAvatarUpload"):
 *
 *  - the payload is scoped to ONE expense (`expenseId` in the form data) and
 *    attaches through `@loxep/accounting`'s `ReceiptsService.attach`, not a
 *    bare media upload — a receipt with no expense to attach to is not yet
 *    a receipt;
 *  - many objects per expense, so there is no "replace" semantics — each
 *    upload ADDS a link, it never deletes a sibling (the avatar route
 *    replaces the one object a user has);
 *  - the serving route is its OWN route with its OWN
 *    `metadata.purpose === 'receipt'` gate — the avatar route's gate is
 *    UNTOUCHED, exactly as the design and the implementation contract
 *    require, so neither endpoint can be repurposed into a generic "fetch
 *    any media by id" route;
 *  - session-gated (any authenticated member, matching
 *    `@/server/expense-functions.ts`'s role choice for this whole surface)
 *    rather than an ACL — media ownership is a metadata fact, never a
 *    permission container.
 *
 * Size cap and MIME allowlist come from the registered
 * `documentsMediaLimitsSetting` (`@loxep/domain`, loxep-cd3.2 M2) rather than
 * the hardcoded constants this route shipped with — the design's own point:
 * a page whose headline feature is dropping many files at once
 * (`/finance/expenses/new`'s evidence pane, `@/server/documents-media.ts`)
 * made "three upload routes, two different policies" a coin-flip for the
 * fourth. Shared with `documents-media.ts` on purpose: both routes write the
 * same media-object shape through the same `MediaService.upload`.
 */
import { Readable } from 'node:stream';
import { documentsMediaLimitsSetting } from '@loxep/domain';
import { MediaObjectNotFoundError, StorageBackendError } from '@loxep/storage';
import { parseLimitedMultipartFormData } from '@/server/multipart-upload';

/**
 * The media OBJECT's own `metadata.purpose` — a single constant, used ONLY
 * to gate the serving route below. Distinct from `media_links.purpose`
 * (`receipt | invoice | supporting_document`, `ReceiptsService`'s richer
 * union for how an attachment relates to the expense) — same word, two
 * different columns, the same split the design draws between "media knows
 * how the file is identified" and "the domain knows the image is receipt
 * evidence".
 */
const RECEIPT_MEDIA_METADATA_PURPOSE = 'receipt';
const EXPENSE_LINK_PURPOSES = new Set(['receipt', 'invoice', 'supporting_document']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** `POST /api/expenses/receipt` — multipart upload attached to one expense. */
export async function handleReceiptUpload(request: Request): Promise<Response> {
  const { requireSession, getAdminServices, getMediaService, getReceiptsService } =
    await import('@/server/admin');

  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch {
    return jsonResponse(401, { error: 'unauthorized', message: 'Authentication required' });
  }

  const { settings } = getAdminServices();
  const limits = await settings.get(documentsMediaLimitsSetting);
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
  const expenseIdField = formData.get('expenseId');
  if (typeof expenseIdField !== 'string' || !UUID_PATTERN.test(expenseIdField)) {
    return jsonResponse(400, {
      error: 'invalid-request',
      message: 'Missing or invalid "expenseId" field'
    });
  }
  const expenseId = expenseIdField;
  const purposeField = formData.get('purpose');
  const purpose =
    typeof purposeField === 'string' && EXPENSE_LINK_PURPOSES.has(purposeField)
      ? purposeField
      : 'receipt';

  if (!limits.allowedMimeTypes.includes(file.type)) {
    return jsonResponse(400, {
      error: 'invalid-content-type',
      message: `Receipts must be one of: ${limits.allowedMimeTypes.join(', ')}`
    });
  }
  if (file.size > limits.maxBytes) {
    return jsonResponse(400, {
      error: 'file-too-large',
      message: `Receipts must be ${Math.floor(limits.maxBytes / (1024 * 1024))}MB or smaller`
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
      metadata: { purpose: RECEIPT_MEDIA_METADATA_PURPOSE }
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

  const receiptsService = await getReceiptsService();
  let link: Awaited<ReturnType<typeof receiptsService.attach>>['link'];
  try {
    ({ link } = await receiptsService.attach({
      expenseId,
      mediaObjectId: mediaObject.id,
      purpose: purpose as 'receipt' | 'invoice' | 'supporting_document',
      actorUserId: session.user.id
    }));
  } catch (error) {
    // The expense didn't exist (or some other attach failure) — clean up the
    // object we just wrote rather than leaving an unreferenced upload behind.
    await mediaService.remove(mediaObject.id).catch(() => undefined);
    throw error;
  }

  return jsonResponse(200, {
    mediaObjectId: mediaObject.id,
    purpose: link.purpose,
    originalFilename: mediaObject.originalFilename,
    mimeType: mediaObject.mimeType,
    sizeBytes: mediaObject.sizeBytes,
    servingUrl: `/api/media/receipt/${mediaObject.id}`
  });
}

/** `GET /api/media/receipt/:mediaId` — streams a stored receipt's bytes back. */
export async function handleReceiptServe(mediaId: string): Promise<Response> {
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
  if (purpose !== RECEIPT_MEDIA_METADATA_PURPOSE) {
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
