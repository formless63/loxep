/**
 * Document upload/serve handlers (loxep-dgf.4, M4): reached ONLY from the
 * two server-only API routes — `routes/api.documents.upload.ts` (POST) and
 * `routes/api.media.document.$mediaId.ts` (GET) — via a dynamic import
 * inside each route's handler, mirroring `@/server/receipt-media.ts`'s shape.
 *
 * Unlike the receipt/inventory-image paths, this upload creates the
 * `documents` ROW itself in the same request (`source_kind = 'upload'`,
 * `status = 'pending'`) — there is no pre-existing resource to attach to,
 * the upload IS the document's creation. This mirrors
 * `@loxep/documents/documents.ts`'s `attachMedia`, re-implemented here for
 * the same "no `@loxep/documents` dependency" reason
 * `documents-functions.ts` documents at its own top.
 *
 * Size cap and MIME allowlist come from the registered
 * `documentsMediaLimitsSetting` (`@loxep/domain`, loxep-cd3.2 M2) rather than
 * a hardcoded constant — this module's own doc used to note that it declined
 * the M3 registered-setting pattern deliberately; a page whose headline
 * feature is dropping many files at once (`/finance/expenses/new`'s evidence
 * pane) is the moment that stops being acceptable. Shared with
 * `receipt-media.ts` on purpose: both routes write the same media-object
 * shape through the same `MediaService.upload`, and this route's pane and
 * `/finance/import` are explicitly the same pipeline entered from two
 * directions.
 */
import { Readable } from 'node:stream';
import { documentsMediaLimitsSetting } from '@loxep/domain';
import { MediaObjectNotFoundError, StorageBackendError } from '@loxep/storage';

/** Mirrors `DOCUMENT_KINDS` minus `csv_import` — a CSV never uploads through this route. */
const UPLOADABLE_DOCUMENT_KINDS = new Set(['receipt', 'invoice', 'packing_slip', 'statement']);

/** The media OBJECT's own `metadata.purpose` — gates the serving route below, distinct from `documents.document_kind`. */
const DOCUMENT_MEDIA_METADATA_PURPOSE = 'document';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function textLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** `POST /api/documents/upload` — multipart upload that CREATES a new `source_kind = 'upload'` document. */
export async function handleDocumentUpload(request: Request): Promise<Response> {
  const { requireSession, getAdminServices, getMediaService } = await import('@/server/admin');

  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch {
    return jsonResponse(401, { error: 'unauthorized', message: 'Authentication required' });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse(400, {
      error: 'invalid-request',
      message: 'Expected a multipart/form-data upload'
    });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return jsonResponse(400, {
      error: 'invalid-request',
      message: 'Missing "file" field in the upload'
    });
  }
  const documentKindField = formData.get('documentKind');
  const documentKind =
    typeof documentKindField === 'string' && UPLOADABLE_DOCUMENT_KINDS.has(documentKindField)
      ? documentKindField
      : 'receipt';

  const { settings } = getAdminServices();
  const limits = await settings.get(documentsMediaLimitsSetting);

  if (!limits.allowedMimeTypes.includes(file.type)) {
    return jsonResponse(400, {
      error: 'invalid-content-type',
      message: `Documents must be one of: ${limits.allowedMimeTypes.join(', ')}`
    });
  }
  if (file.size > limits.maxBytes) {
    return jsonResponse(400, {
      error: 'file-too-large',
      message: `Documents must be ${Math.floor(limits.maxBytes / (1024 * 1024))}MB or smaller`
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
      metadata: { purpose: DOCUMENT_MEDIA_METADATA_PURPOSE }
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

  const { handle } = getAdminServices();
  let documentId: string;
  try {
    const inserted = await handle.db.execute(
      `insert into documents (document_kind, source_kind, media_object_id, original_filename,
                              status, created_by_user_id)
       values (${textLiteral(documentKind)}, 'upload', '${mediaObject.id}',
               ${textLiteral(file.name)}, 'pending', ${textLiteral(session.user.id)})
       returning id`
    );
    const id = inserted.rows[0]?.['id'] as string | undefined;
    if (id === undefined) throw new Error('documents insert returned no row');
    documentId = id;
  } catch (error) {
    // The document row failed for some reason — clean up the object we just
    // wrote rather than leaving an unreferenced upload behind.
    await mediaService.remove(mediaObject.id).catch(() => undefined);
    throw error;
  }

  return jsonResponse(200, {
    documentId,
    mediaObjectId: mediaObject.id,
    documentKind,
    originalFilename: mediaObject.originalFilename,
    mimeType: mediaObject.mimeType,
    sizeBytes: mediaObject.sizeBytes,
    servingUrl: `/api/media/document/${mediaObject.id}`
  });
}

/** `GET /api/media/document/:mediaId` — streams a stored document's bytes back. */
export async function handleDocumentServe(mediaId: string): Promise<Response> {
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
  if (purpose !== DOCUMENT_MEDIA_METADATA_PURPOSE) {
    return new Response(null, { status: 404 });
  }

  return new Response(Readable.toWeb(body) as unknown as ReadableStream, {
    status: 200,
    headers: {
      'content-type': mediaObject.mimeType ?? 'application/octet-stream',
      'content-length': String(mediaObject.sizeBytes),
      'cache-control': 'private, max-age=86400, immutable'
    }
  });
}
