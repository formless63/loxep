/**
 * Resumable storage-migration workflow (ADR-0012 §"Local-to-S3 migration",
 * ADR-0014 §7, foundation schema "Storage migration state").
 *
 * Semantics, in order, per object — enforced by `migrateObject` (which is
 * both the `storage.migrate-object` job handler and directly callable):
 *
 *   copy → verify (size + sha256 re-hashed from a streamed destination
 *   read) → metadata cutover (`media_objects.storage_backend_id`) in a
 *   transaction with the `done` status → source object NOT deleted.
 *
 * Source cleanup is a separate, deliberate call
 * ({@link StorageMigrationService.cleanupMigrationSources}), allowed only
 * after the migration has completed, and only for objects whose metadata
 * has verifiably cut over.
 *
 * Resumability comes from durable state, not memory: per-object rows in
 * `storage_migration_objects` plus one Graphile Worker job per object with
 * a stable `jobKey` (dedupe). A crashed/stopped worker leaves the queued
 * jobs and `pending` rows in place; any later worker finishes them. The
 * handler is idempotent — objects already cut over short-circuit to `done`.
 *
 * A failed verification deletes the bad destination copy, records the error
 * on the object row with status `failed`, performs NO cutover, and throws so
 * the jobs runtime retries per policy.
 */
import { createHash } from "node:crypto";
import {
  mediaObjects,
  storageMigrationObjects,
  storageMigrations,
} from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { EnqueueOptions, LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import { StorageMigrationError } from "./errors.ts";
import type { StorageBackendsService } from "./backends.ts";
import type { StorageDriver } from "./driver.ts";
import type { MediaObjectRecord } from "./media.ts";

export const STORAGE_MIGRATE_OBJECT_TASK_NAME = "storage.migrate-object";

/** Migration lifecycle states (text + TS union, never a PG enum). */
export const STORAGE_MIGRATION_STATUSES = [
  "running",
  "completed",
  "completed_with_errors",
] as const;
export type StorageMigrationStatus =
  (typeof STORAGE_MIGRATION_STATUSES)[number];

/** Per-object states. `failed` may flip to `done` on a later retry. */
export const STORAGE_MIGRATION_OBJECT_STATUSES = [
  "pending",
  "done",
  "skipped",
  "failed",
] as const;
export type StorageMigrationObjectStatus =
  (typeof STORAGE_MIGRATION_OBJECT_STATUSES)[number];

export interface StorageMigrationRecord {
  id: string;
  sourceBackendId: string;
  destinationBackendId: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  summary: unknown;
}

export interface MigrationStatusCounts {
  pending: number;
  done: number;
  skipped: number;
  failed: number;
  total: number;
}

export interface MigrationStatus {
  migration: StorageMigrationRecord;
  counts: MigrationStatusCounts;
}

export interface CleanupResult {
  /** Source objects deleted. */
  deleted: number;
  /** Objects skipped (not `done`, or metadata not on the destination). */
  skipped: number;
  failures: Array<{ mediaObjectId: string; error: string }>;
}

const migrateObjectPayloadSchema = z.object({
  migrationId: z.uuid(),
  mediaObjectId: z.uuid(),
  correlationId: z.string().optional(),
});

/** Typed enqueue signature (structural subset of @loxep/jobs `AddJob`). */
export type MigrationEnqueue = (
  task: LoxepTask<typeof migrateObjectPayloadSchema>,
  payload: z.input<typeof migrateObjectPayloadSchema>,
  options?: EnqueueOptions,
) => Promise<unknown>;

export interface StartMigrationInput {
  sourceBackendId: string;
  destinationBackendId: string;
  createdByUserId?: string | null;
  /** Per-object retry budget override (default: task default). */
  maxAttemptsPerObject?: number;
}

export interface StorageMigrationService {
  /**
   * The `storage.migrate-object` task; register it in the worker runtime's
   * task registry alongside this service.
   */
  task: LoxepTask<typeof migrateObjectPayloadSchema>;
  startMigration(input: StartMigrationInput): Promise<StorageMigrationRecord>;
  /**
   * Every migration this installation has started, newest first — the read
   * `/settings/storage`'s migration panel needs to survive a page reload.
   * Without it the UI could only track a migration it had started in the
   * same React session, so a refresh lost the pointer while the migration
   * itself kept running (loxep-4wa). Optionally narrowed to one status.
   */
  listMigrations(filter?: {
    status?: string;
    limit?: number;
  }): Promise<StorageMigrationRecord[]>;
  /** Re-enqueues jobs for still-pending objects (jobKey dedupe: no dupes). */
  resumeMigration(migrationId: string): Promise<{ enqueued: number }>;
  getMigrationStatus(migrationId: string): Promise<MigrationStatus>;
  /**
   * Explicit later source cleanup — never part of copy/verify. Requires the
   * migration to be `completed`/`completed_with_errors`; deletes source
   * objects only for `done` rows whose media metadata is on the destination.
   */
  cleanupMigrationSources(migrationId: string): Promise<CleanupResult>;
  /** The job handler body, directly callable (idempotent). */
  migrateObject(migrationId: string, mediaObjectId: string): Promise<void>;
}

async function sha256OfStream(driver: StorageDriver, key: string) {
  const hash = createHash("sha256");
  const body = await driver.get(key);
  for await (const chunk of body) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

export function createStorageMigrationService(options: {
  db: LoxepDb;
  backends: StorageBackendsService;
  /**
   * Enqueue function, typically the worker runtime's `addJob` (or a closure
   * over it, since the runtime is usually started with this service's task
   * already in its registry).
   */
  addJob: MigrationEnqueue;
}): StorageMigrationService {
  const { db, backends, addJob } = options;

  async function getMigration(
    migrationId: string,
  ): Promise<StorageMigrationRecord> {
    const row = await db.query.storageMigrations.findFirst({
      where: (table, { eq }) => eq(table.id, migrationId),
    });
    if (row === undefined) {
      throw new StorageMigrationError(
        `unknown storage migration "${migrationId}"`,
      );
    }
    return row;
  }

  /** Composite-primary-key upsert as the object-row update path. */
  async function updateObjectRow(
    migrationId: string,
    mediaObjectId: string,
    set: {
      status?: StorageMigrationObjectStatus;
      attemptCount?: number;
      verifiedAt?: Date | null;
      lastError?: string | null;
    },
  ): Promise<void> {
    await db
      .insert(storageMigrationObjects)
      .values({ migrationId, mediaObjectId, status: "pending" })
      .onConflictDoUpdate({
        target: [
          storageMigrationObjects.migrationId,
          storageMigrationObjects.mediaObjectId,
        ],
        set,
      });
  }

  async function countsFor(migrationId: string): Promise<MigrationStatusCounts> {
    const rows = await db.query.storageMigrationObjects.findMany({
      where: (table, { eq }) => eq(table.migrationId, migrationId),
      columns: { status: true },
    });
    const counts: MigrationStatusCounts = {
      pending: 0,
      done: 0,
      skipped: 0,
      failed: 0,
      total: rows.length,
    };
    for (const row of rows) {
      if (row.status === "pending") counts.pending += 1;
      else if (row.status === "done") counts.done += 1;
      else if (row.status === "skipped") counts.skipped += 1;
      else if (row.status === "failed") counts.failed += 1;
    }
    return counts;
  }

  async function updateMigration(
    row: StorageMigrationRecord,
    set: {
      status?: StorageMigrationStatus;
      startedAt?: Date;
      completedAt?: Date | null;
      summary?: Record<string, unknown>;
    },
  ): Promise<void> {
    await db
      .insert(storageMigrations)
      .values({
        id: row.id,
        sourceBackendId: row.sourceBackendId,
        destinationBackendId: row.destinationBackendId,
        status: row.status,
      })
      .onConflictDoUpdate({ target: storageMigrations.id, set });
  }

  /**
   * Marks the migration completed when no pending objects remain. `failed`
   * counts as terminal here; a later successful retry re-runs this check and
   * upgrades `completed_with_errors` accordingly.
   */
  async function checkCompletion(migrationId: string): Promise<void> {
    const migration = await getMigration(migrationId);
    const counts = await countsFor(migrationId);
    if (counts.pending > 0) return;
    const status: StorageMigrationStatus =
      counts.failed > 0 ? "completed_with_errors" : "completed";
    await updateMigration(migration, {
      status,
      completedAt: new Date(),
      summary: {
        done: counts.done,
        skipped: counts.skipped,
        failed: counts.failed,
        total: counts.total,
      },
    });
  }

  function enqueueObject(
    migrationId: string,
    mediaObjectId: string,
    maxAttempts?: number,
  ): Promise<unknown> {
    return addJob(
      task,
      { migrationId, mediaObjectId },
      {
        jobKey: jobKeyFor(
          STORAGE_MIGRATE_OBJECT_TASK_NAME,
          `${migrationId}:${mediaObjectId}`,
        ),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      },
    );
  }

  async function startMigration(
    input: StartMigrationInput,
  ): Promise<StorageMigrationRecord> {
    if (input.sourceBackendId === input.destinationBackendId) {
      throw new StorageMigrationError(
        "source and destination backends must differ",
      );
    }
    // Both must exist (throws otherwise); destination should be usable.
    await backends.getBackend(input.sourceBackendId);
    await backends.getBackend(input.destinationBackendId);

    const inserted = await db
      .insert(storageMigrations)
      .values({
        sourceBackendId: input.sourceBackendId,
        destinationBackendId: input.destinationBackendId,
        status: "running",
        startedAt: new Date(),
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning();
    const migration = inserted[0];
    if (migration === undefined) {
      throw new StorageMigrationError("failed to create storage migration");
    }

    const objects = await db.query.mediaObjects.findMany({
      where: (table, { eq }) =>
        eq(table.storageBackendId, input.sourceBackendId),
      columns: { id: true },
    });

    if (objects.length === 0) {
      await updateMigration(migration, {
        status: "completed",
        completedAt: new Date(),
        summary: { done: 0, skipped: 0, failed: 0, total: 0 },
      });
      return getMigration(migration.id);
    }

    await db.insert(storageMigrationObjects).values(
      objects.map((object) => ({
        migrationId: migration.id,
        mediaObjectId: object.id,
        status: "pending" as const,
      })),
    );
    for (const object of objects) {
      await enqueueObject(
        migration.id,
        object.id,
        input.maxAttemptsPerObject,
      );
    }
    return getMigration(migration.id);
  }

  async function resumeMigration(
    migrationId: string,
  ): Promise<{ enqueued: number }> {
    await getMigration(migrationId);
    const rows = await db.query.storageMigrationObjects.findMany({
      where: (table, { and, eq }) =>
        and(eq(table.migrationId, migrationId), eq(table.status, "pending")),
      columns: { mediaObjectId: true },
    });
    for (const row of rows) {
      await enqueueObject(migrationId, row.mediaObjectId);
    }
    return { enqueued: rows.length };
  }

  async function migrateObject(
    migrationId: string,
    mediaObjectId: string,
  ): Promise<void> {
    const migration = await getMigration(migrationId);
    const objectRow = await db.query.storageMigrationObjects.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.migrationId, migrationId),
          eq(table.mediaObjectId, mediaObjectId),
        ),
    });
    if (objectRow === undefined) {
      throw new StorageMigrationError(
        `media object "${mediaObjectId}" is not part of migration "${migrationId}"`,
      );
    }
    // Idempotent short-circuit for at-least-once delivery.
    if (objectRow.status === "done" || objectRow.status === "skipped") return;

    await updateObjectRow(migrationId, mediaObjectId, {
      attemptCount: objectRow.attemptCount + 1,
    });

    const media = await db.query.mediaObjects.findFirst({
      where: (table, { eq }) => eq(table.id, mediaObjectId),
    });
    if (media === undefined) {
      await updateObjectRow(migrationId, mediaObjectId, {
        status: "skipped",
        lastError: "media object row no longer exists",
      });
      await checkCompletion(migrationId);
      return;
    }
    if (media.storageBackendId === migration.destinationBackendId) {
      // Already cut over (previous attempt crashed after its transaction).
      await updateObjectRow(migrationId, mediaObjectId, {
        status: "done",
        verifiedAt: objectRow.verifiedAt ?? new Date(),
        lastError: null,
      });
      await checkCompletion(migrationId);
      return;
    }
    if (media.storageBackendId !== migration.sourceBackendId) {
      await updateObjectRow(migrationId, mediaObjectId, {
        status: "skipped",
        lastError: `media object moved to backend "${media.storageBackendId}" outside this migration`,
      });
      await checkCompletion(migrationId);
      return;
    }

    const source = await backends.resolveDriver(migration.sourceBackendId);
    const destination = await backends.resolveDriver(
      migration.destinationBackendId,
    );
    try {
      // 1. Copy by stable storage key (metadata/checksum stay in the row).
      const body = await source.get(media.storageKey);
      await destination.put(media.storageKey, body, {
        ...(media.mimeType !== null ? { contentType: media.mimeType } : {}),
      });

      // 2. Verify size and sha256 against a re-hashed STREAMED destination
      //    read — proving the destination can serve the exact bytes back.
      const destinationStat = await destination.stat(media.storageKey);
      const destinationSha256 = await sha256OfStream(
        destination,
        media.storageKey,
      );
      if (
        destinationStat.sizeBytes !== media.sizeBytes ||
        destinationSha256 !== media.sha256
      ) {
        const detail =
          destinationStat.sizeBytes !== media.sizeBytes
            ? `size mismatch: destination ${destinationStat.sizeBytes} != recorded ${media.sizeBytes}`
            : `sha256 mismatch: destination ${destinationSha256} != recorded ${media.sha256}`;
        // Remove the bad copy; NO cutover happens on this path.
        await destination.delete(media.storageKey).catch(() => undefined);
        await updateObjectRow(migrationId, mediaObjectId, {
          status: "failed",
          lastError: detail,
        });
        await checkCompletion(migrationId);
        throw new StorageMigrationError(
          `verification failed for media object "${mediaObjectId}": ${detail}`,
        );
      }

      // 3. Metadata cutover + done status in one transaction. Source object
      //    is left intact (explicit later cleanup only).
      const verifiedAt = new Date();
      await db.transaction(async (tx) => {
        await tx
          .insert(mediaObjects)
          .values({
            id: media.id,
            storageBackendId: media.storageBackendId,
            storageKey: media.storageKey,
            sizeBytes: media.sizeBytes,
            sha256: media.sha256,
          })
          .onConflictDoUpdate({
            target: mediaObjects.id,
            set: { storageBackendId: migration.destinationBackendId },
          });
        await tx
          .insert(storageMigrationObjects)
          .values({ migrationId, mediaObjectId, status: "pending" })
          .onConflictDoUpdate({
            target: [
              storageMigrationObjects.migrationId,
              storageMigrationObjects.mediaObjectId,
            ],
            set: { status: "done", verifiedAt, lastError: null },
          });
      });
      await checkCompletion(migrationId);
    } finally {
      source.close?.();
      destination.close?.();
    }
  }

  const task = defineTask({
    name: STORAGE_MIGRATE_OBJECT_TASK_NAME,
    payloadSchema: migrateObjectPayloadSchema,
    handler: (payload) =>
      migrateObject(payload.migrationId, payload.mediaObjectId),
  });

  async function getMigrationStatus(
    migrationId: string,
  ): Promise<MigrationStatus> {
    const migration = await getMigration(migrationId);
    const counts = await countsFor(migrationId);
    return { migration, counts };
  }

  async function cleanupMigrationSources(
    migrationId: string,
  ): Promise<CleanupResult> {
    const migration = await getMigration(migrationId);
    if (
      migration.status !== "completed" &&
      migration.status !== "completed_with_errors"
    ) {
      throw new StorageMigrationError(
        `refusing source cleanup: migration "${migrationId}" is "${migration.status}", not completed`,
      );
    }
    const rows = await db.query.storageMigrationObjects.findMany({
      where: (table, { eq }) => eq(table.migrationId, migrationId),
    });
    const source = await backends.resolveDriver(migration.sourceBackendId);
    const result: CleanupResult = { deleted: 0, skipped: 0, failures: [] };
    try {
      for (const row of rows) {
        if (row.status !== "done") {
          result.skipped += 1;
          continue;
        }
        const media: MediaObjectRecord | undefined =
          await db.query.mediaObjects.findFirst({
            where: (table, { eq }) => eq(table.id, row.mediaObjectId),
          });
        // Never delete a source object the metadata still points at.
        if (
          media === undefined ||
          media.storageBackendId !== migration.destinationBackendId
        ) {
          result.skipped += 1;
          continue;
        }
        try {
          await source.delete(media.storageKey);
          result.deleted += 1;
        } catch (error) {
          result.failures.push({
            mediaObjectId: row.mediaObjectId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      source.close?.();
    }
    return result;
  }

  /** See the interface doc: the panel must survive a reload (loxep-4wa). */
  async function listMigrations(filter?: {
    status?: string;
    limit?: number;
  }): Promise<StorageMigrationRecord[]> {
    return db.query.storageMigrations.findMany({
      where: (table, { eq }) =>
        filter?.status === undefined ? undefined : eq(table.status, filter.status),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: filter?.limit ?? 50,
    });
  }

  return {
    task,
    startMigration,
    listMigrations,
    resumeMigration,
    getMigrationStatus,
    cleanupMigrationSources,
    migrateObject,
  };
}
