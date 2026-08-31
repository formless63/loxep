/**
 * Media service (ADR-0012): uploads bytes to a configured storage backend
 * and records stable media identity in PostgreSQL. Domain records reference
 * `media_objects.id` — never filesystem paths or provider URLs.
 *
 * Upload computes sha256 + size while the bytes stream to the driver, then
 * inserts the `media_objects` row (object-before-row: a crash between the
 * two leaves an unreferenced blob, never a row pointing at nothing).
 * Removal is the mirror image: object delete first (idempotent), then the
 * rows — a crash in between leaves a retryable row, never a dangling blob
 * reference that the row claims exists.
 */
import { createHash, randomUUID } from "node:crypto";
import { finished, Readable, Transform } from "node:stream";
import { mediaLinks, mediaObjects } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { MediaObjectNotFoundError, StorageError } from "./errors.ts";
import { generateMediaStorageKey } from "./keys.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";
import type { StorageBackendsService } from "./backends.ts";
import type { StorageDriver } from "./driver.ts";

/** A `media_objects` row. */
export interface MediaObjectRecord {
  id: string;
  storageBackendId: string;
  storageKey: string;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string;
  createdByUserId: string | null;
  createdAt: Date;
  metadata: unknown;
}

export interface MediaLinkRecord {
  mediaObjectId: string;
  resourceType: string;
  resourceId: string;
  purpose: string;
  sortOrder: number | null;
  createdAt: Date;
}

export interface UploadInput {
  /** Target backend; the enabled default backend when omitted. */
  backendId?: string;
  data: Uint8Array | Readable;
  originalFilename?: string;
  mimeType?: string;
  createdByUserId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MediaLinkInput {
  mediaObjectId: string;
  resourceType: string;
  resourceId: string;
  purpose: string;
  sortOrder?: number;
}

export interface MediaService {
  upload(input: UploadInput): Promise<MediaObjectRecord>;
  getMediaObject(mediaObjectId: string): Promise<MediaObjectRecord>;
  /**
   * Returns the row plus a Readable over the object bytes. Consumers must
   * consume or destroy the body so the resolved driver's resources release.
   */
  read(
    mediaObjectId: string,
  ): Promise<{ mediaObject: MediaObjectRecord; body: Readable }>;
  /** Deletes the stored object, its links, and the row. */
  remove(mediaObjectId: string): Promise<void>;
  addLink(input: MediaLinkInput): Promise<MediaLinkRecord>;
  listLinksForResource(input: {
    resourceType: string;
    resourceId: string;
    purpose?: string;
  }): Promise<MediaLinkRecord[]>;
  listLinksForMedia(mediaObjectId: string): Promise<MediaLinkRecord[]>;
  removeLink(input: Omit<MediaLinkInput, "sortOrder">): Promise<void>;
}

/** Counts and hashes bytes as they pass through to the driver. */
function hashingTap(hash: ReturnType<typeof createHash>, onByte: (n: number) => void) {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      onByte(chunk.length);
      callback(null, chunk);
    },
  });
}

export function createMediaService(options: {
  db: LoxepDb;
  backends: StorageBackendsService;
}): MediaService {
  const { db, backends } = options;

  function closeDriver(driver: StorageDriver): void {
    driver.close?.();
  }

  /**
   * Keep the resolved driver alive until its read stream reaches a terminal
   * state. `finished` covers normal consumption, stream errors, and explicit
   * destruction (including cancellation of a `Readable.toWeb` adapter).
   */
  function closeDriverWithStream(
    driver: StorageDriver,
    body: Readable,
  ): Readable {
    const stopWatching = finished(
      body,
      { readable: true, writable: false },
      () => {
        stopWatching();
        closeDriver(driver);
      },
    );
    return body;
  }

  async function upload(input: UploadInput): Promise<MediaObjectRecord> {
    const backend =
      input.backendId !== undefined
        ? await backends.getBackend(input.backendId)
        : await backends.getDefaultBackend();
    if (!backend.enabled) {
      throw new StorageError(
        `storage backend "${backend.id}" is disabled; uploads require an enabled backend`,
      );
    }
    const id = randomUUID();
    const storageKey = generateMediaStorageKey(id);
    const driver = await backends.resolveDriver(backend.id);
    const hash = createHash("sha256");
    let sizeBytes = 0;

    try {
      if (input.data instanceof Readable) {
        const tap = hashingTap(hash, (n) => {
          sizeBytes += n;
        });
        // Propagate source failure into the tap so the driver's write fails
        // rather than seeing a silently truncated stream.
        input.data.on("error", (error) => tap.destroy(error));
        await driver.put(storageKey, input.data.pipe(tap), {
          ...(input.mimeType !== undefined
            ? { contentType: input.mimeType }
            : {}),
        });
      } else {
        hash.update(input.data);
        sizeBytes = input.data.byteLength;
        await driver.put(storageKey, input.data, {
          ...(input.mimeType !== undefined
            ? { contentType: input.mimeType }
            : {}),
        });
      }
      const sha256 = hash.digest("hex");

      try {
        const inserted = await db
          .insert(mediaObjects)
          .values({
            id,
            storageBackendId: backend.id,
            storageKey,
            originalFilename: input.originalFilename ?? null,
            mimeType: input.mimeType ?? null,
            sizeBytes,
            sha256,
            createdByUserId: input.createdByUserId ?? null,
            metadata: input.metadata ?? {},
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new StorageError("media_objects insert returned no row");
        }
        return row;
      } catch (error) {
        // Row failed after the object landed: clean the orphan blob.
        await driver.delete(storageKey).catch(() => undefined);
        throw error;
      }
    } finally {
      closeDriver(driver);
    }
  }

  async function getMediaObject(
    mediaObjectId: string,
  ): Promise<MediaObjectRecord> {
    const row = await db.query.mediaObjects.findFirst({
      where: (table, { eq }) => eq(table.id, mediaObjectId),
    });
    if (row === undefined) {
      throw new MediaObjectNotFoundError(
        `unknown media object "${mediaObjectId}"`,
      );
    }
    return row;
  }

  async function read(mediaObjectId: string) {
    const mediaObject = await getMediaObject(mediaObjectId);
    // The driver stays open for the lifetime of the returned stream; S3
    // clients keep pooled sockets, released when the stream is consumed.
    const driver = await backends.resolveDriver(mediaObject.storageBackendId);
    try {
      const body = await driver.get(mediaObject.storageKey);
      return { mediaObject, body: closeDriverWithStream(driver, body) };
    } catch (error) {
      // No stream was handed to the caller, so no terminal event can own
      // cleanup. Release the driver before preserving the original failure.
      closeDriver(driver);
      throw error;
    }
  }

  async function remove(mediaObjectId: string): Promise<void> {
    const mediaObject = await getMediaObject(mediaObjectId);
    const driver = await backends.resolveDriver(mediaObject.storageBackendId);
    try {
      // Object first (idempotent), rows second — see module doc.
      await driver.delete(mediaObject.storageKey);
    } finally {
      closeDriver(driver);
    }
    await db.transaction(async (tx) => {
      await tx.execute(
        `delete from media_links where media_object_id = ${uuidLiteral(mediaObject.id)}`,
      );
      await tx.execute(
        `delete from media_objects where id = ${uuidLiteral(mediaObject.id)}`,
      );
    });
  }

  async function addLink(input: MediaLinkInput): Promise<MediaLinkRecord> {
    await getMediaObject(input.mediaObjectId);
    const inserted = await db
      .insert(mediaLinks)
      .values({
        mediaObjectId: input.mediaObjectId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        purpose: input.purpose,
        sortOrder: input.sortOrder ?? null,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new StorageError("media_links insert returned no row");
    }
    return row;
  }

  async function listLinksForResource(input: {
    resourceType: string;
    resourceId: string;
    purpose?: string;
  }): Promise<MediaLinkRecord[]> {
    return db.query.mediaLinks.findMany({
      where: (table, { and, eq }) =>
        input.purpose !== undefined
          ? and(
              eq(table.resourceType, input.resourceType),
              eq(table.resourceId, input.resourceId),
              eq(table.purpose, input.purpose),
            )
          : and(
              eq(table.resourceType, input.resourceType),
              eq(table.resourceId, input.resourceId),
            ),
      orderBy: (table, { asc }) => [asc(table.sortOrder), asc(table.createdAt)],
    });
  }

  async function listLinksForMedia(
    mediaObjectId: string,
  ): Promise<MediaLinkRecord[]> {
    return db.query.mediaLinks.findMany({
      where: (table, { eq }) => eq(table.mediaObjectId, mediaObjectId),
      orderBy: (table, { asc }) => [asc(table.sortOrder), asc(table.createdAt)],
    });
  }

  async function removeLink(
    input: Omit<MediaLinkInput, "sortOrder">,
  ): Promise<void> {
    await db.execute(
      `delete from media_links
        where media_object_id = ${uuidLiteral(input.mediaObjectId)}
          and resource_type = ${textLiteral(input.resourceType)}
          and resource_id = ${textLiteral(input.resourceId)}
          and purpose = ${textLiteral(input.purpose)}`,
    );
  }

  return {
    upload,
    getMediaObject,
    read,
    remove,
    addLink,
    listLinksForResource,
    listLinksForMedia,
    removeLink,
  };
}
