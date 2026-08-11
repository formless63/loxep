/**
 * Resumable storage-migration workflow tests (ADR-0012, ADR-0014 §7)
 * against real PostgreSQL + Graphile Worker, migrating from a local source
 * backend to an S3 destination when the generic S3 test endpoint is
 * reachable (proving local → S3), else to a second local backend — the
 * workflow is driver-agnostic by construction.
 *
 * Covers: durable per-object state, jobKey dedupe, worker-restart
 * resumability (stop mid-migration, restart, complete without duplication
 * or corruption), copy→verify→cutover ordering, failed-verification leaving
 * NO cutover, source retention, and explicit source cleanup.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  createTaskRegistry,
  defineTask,
  startWorkerRuntime,
} from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import {
  STORAGE_MIGRATE_OBJECT_TASK_NAME,
  StorageMigrationError,
  createMediaService,
  createStorageBackendsService,
  createStorageMigrationService,
} from "../src/index.ts";
import type {
  MediaObjectRecord,
  MediaService,
  StorageBackendsService,
  StorageMigrationService,
} from "../src/index.ts";
import {
  collect,
  createScratchDb,
  dropScratchDb,
  s3EndpointAvailable,
  s3TestConfig,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testKeyring,
  waitFor,
} from "./helpers.ts";

const s3Available = await s3EndpointAvailable();

const OBJECT_COUNT = 8;

describe("storage migration workflow", () => {
  const dbName = scratchDbName("loxep_test_storage_migration");
  let databaseUrl = "";
  let handle: DbHandle;
  let backends: StorageBackendsService;
  let media: MediaService;
  let service: StorageMigrationService;
  let runtime: WorkerRuntime | null = null;
  let sourceRootDir = "";
  let destRootDir = "";
  let sourceBackendId = "";
  let destinationBackendId = "";
  let uploads: MediaObjectRecord[] = [];
  let migrationId = "";

  async function stopRuntime(): Promise<void> {
    if (runtime !== null) {
      await runtime.stop();
      runtime = null;
    }
  }

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    backends = createStorageBackendsService({
      db: handle.db,
      keyring: testKeyring(),
    });
    media = createMediaService({ db: handle.db, backends });
    service = createStorageMigrationService({
      db: handle.db,
      backends,
      addJob: (task, payload, options) => {
        if (runtime === null) {
          throw new Error("no worker runtime running to enqueue into");
        }
        return runtime.addJob(task, payload, options);
      },
    });

    sourceRootDir = await mkdtemp(join(tmpdir(), "loxep-migration-src-"));
    const source = await backends.registerBackend({
      name: "local source",
      driver: "local",
      config: { rootDir: sourceRootDir },
      makeDefault: true,
    });
    sourceBackendId = source.id;

    if (s3Available) {
      const config = s3TestConfig();
      const bucket = `loxep-migration-${randomUUID().slice(0, 13)}`;
      const admin = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
      await admin.send(new CreateBucketCommand({ Bucket: bucket }));
      admin.destroy();
      const destination = await backends.registerBackend({
        name: "s3 destination",
        driver: "s3",
        config: { endpoint: config.endpoint, region: config.region, bucket },
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
      destinationBackendId = destination.id;
    } else {
      destRootDir = await mkdtemp(join(tmpdir(), "loxep-migration-dst-"));
      const destination = await backends.registerBackend({
        name: "local destination",
        driver: "local",
        config: { rootDir: destRootDir },
      });
      destinationBackendId = destination.id;
    }
  });

  afterAll(async () => {
    await stopRuntime();
    await closeDb(handle);
    await dropScratchDb(dbName);
    await rm(sourceRootDir, { recursive: true, force: true });
    if (destRootDir !== "") {
      await rm(destRootDir, { recursive: true, force: true });
    }
  });

  it("rejects a migration whose source and destination are the same", async () => {
    await expect(
      service.startMigration({
        sourceBackendId,
        destinationBackendId: sourceBackendId,
      }),
    ).rejects.toThrow(StorageMigrationError);
  });

  it("completes immediately when the source holds no media objects", async () => {
    const migration = await service.startMigration({
      sourceBackendId,
      destinationBackendId,
    });
    expect(migration.status).toBe("completed");
    const status = await service.getMigrationStatus(migration.id);
    expect(status.counts.total).toBe(0);
  });

  it("creates durable per-object state and deduplicates enqueues by jobKey", async () => {
    uploads = [];
    for (let i = 0; i < OBJECT_COUNT; i += 1) {
      uploads.push(
        await media.upload({
          data: randomBytes(i === 0 ? 0 : 8 * 1024 + i),
          originalFilename: `object-${i}.bin`,
          mimeType: "application/octet-stream",
        }),
      );
    }

    // Runtime with an unrelated registry: its schema lets us enqueue, but
    // nothing processes storage.migrate-object jobs yet.
    const idleTask = defineTask({
      name: "test.idle",
      payloadSchema: z.object({}),
      handler: () => undefined,
    });
    runtime = await startWorkerRuntime({
      databaseUrl,
      logger: silentJobsLogger,
      registry: createTaskRegistry([idleTask]),
      pollInterval: 100,
    });

    const migration = await service.startMigration({
      sourceBackendId,
      destinationBackendId,
    });
    migrationId = migration.id;
    expect(migration.status).toBe("running");
    expect(migration.startedAt).not.toBeNull();

    const status = await service.getMigrationStatus(migrationId);
    expect(status.counts).toEqual({
      pending: OBJECT_COUNT,
      done: 0,
      skipped: 0,
      failed: 0,
      total: OBJECT_COUNT,
    });

    // Re-enqueueing must replace by jobKey, never duplicate.
    const resumed = await service.resumeMigration(migrationId);
    expect(resumed.enqueued).toBe(OBJECT_COUNT);
    const jobs = await handle.pool.query(
      "select count(*)::int as count from graphile_worker.jobs where task_identifier = $1",
      [STORAGE_MIGRATE_OBJECT_TASK_NAME],
    );
    expect((jobs.rows[0] as { count: number }).count).toBe(OBJECT_COUNT);

    // Source cleanup must refuse while the migration is incomplete.
    await expect(
      service.cleanupMigrationSources(migrationId),
    ).rejects.toThrow(/not completed/);

    await stopRuntime();
  });

  it("survives a worker stop mid-migration and completes on restart without duplication", async () => {
    // Slowed wrapper around the real handler so the stop lands mid-way.
    const slowedTask = defineTask({
      name: STORAGE_MIGRATE_OBJECT_TASK_NAME,
      payloadSchema: service.task.payloadSchema,
      handler: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await service.migrateObject(payload.migrationId, payload.mediaObjectId);
      },
    });
    runtime = await startWorkerRuntime({
      databaseUrl,
      logger: silentJobsLogger,
      registry: createTaskRegistry([slowedTask]),
      concurrency: 1,
      pollInterval: 50,
    });
    await waitFor(
      async () => (await service.getMigrationStatus(migrationId)).counts.done >= 2,
      { label: "two objects migrated", intervalMs: 25 },
    );
    // "Interruption": graceful stop finishes the in-flight job and leaves
    // the rest queued in PostgreSQL.
    await stopRuntime();

    const mid = await service.getMigrationStatus(migrationId);
    expect(mid.counts.done).toBeGreaterThanOrEqual(2);
    expect(mid.counts.pending).toBeGreaterThan(0);
    expect(mid.migration.status).toBe("running");

    // Restart with the real task: remaining queued jobs are picked up.
    runtime = await startWorkerRuntime({
      databaseUrl,
      logger: silentJobsLogger,
      registry: createTaskRegistry([service.task]),
      concurrency: 2,
      pollInterval: 50,
    });
    await waitFor(
      async () => {
        const { migration } = await service.getMigrationStatus(migrationId);
        return migration.status === "completed";
      },
      { label: "migration completed", timeoutMs: 30_000 },
    );
    await stopRuntime();

    const final = await service.getMigrationStatus(migrationId);
    expect(final.counts).toEqual({
      pending: 0,
      done: OBJECT_COUNT,
      skipped: 0,
      failed: 0,
      total: OBJECT_COUNT,
    });
    expect(final.migration.completedAt).not.toBeNull();
    expect(final.migration.summary).toMatchObject({ done: OBJECT_COUNT });

    // No duplicated executions: each object was handled exactly once.
    const objectRows = await handle.db.query.storageMigrationObjects.findMany({
      where: (table, { eq }) => eq(table.migrationId, migrationId),
    });
    expect(objectRows).toHaveLength(OBJECT_COUNT);
    for (const row of objectRows) {
      expect(row.status).toBe("done");
      expect(row.attemptCount).toBe(1);
      expect(row.verifiedAt).not.toBeNull();
      expect(row.lastError).toBeNull();
    }

    // Cutover happened, bytes are intact on the destination, and the source
    // objects were NOT deleted.
    const sourceDriver = await backends.resolveDriver(sourceBackendId);
    const destinationDriver = await backends.resolveDriver(
      destinationBackendId,
    );
    try {
      for (const uploaded of uploads) {
        const row = await media.getMediaObject(uploaded.id);
        expect(row.storageBackendId).toBe(destinationBackendId);
        const bytes = await collect(
          await destinationDriver.get(uploaded.storageKey),
        );
        expect(bytes.length).toBe(uploaded.sizeBytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          uploaded.sha256,
        );
        expect(await sourceDriver.exists(uploaded.storageKey)).toBe(true);
        // read() follows the cutover transparently.
        const { body } = await media.read(uploaded.id);
        expect((await collect(body)).equals(bytes)).toBe(true);
      }
    } finally {
      sourceDriver.close?.();
      destinationDriver.close?.();
    }
  });

  it("cleans up source objects only via the explicit later call", async () => {
    const result = await service.cleanupMigrationSources(migrationId);
    expect(result).toEqual({
      deleted: OBJECT_COUNT,
      skipped: 0,
      failures: [],
    });
    const sourceDriver = await backends.resolveDriver(sourceBackendId);
    const destinationDriver = await backends.resolveDriver(
      destinationBackendId,
    );
    try {
      for (const uploaded of uploads) {
        expect(await sourceDriver.exists(uploaded.storageKey)).toBe(false);
        expect(await destinationDriver.exists(uploaded.storageKey)).toBe(true);
      }
    } finally {
      sourceDriver.close?.();
      destinationDriver.close?.();
    }
    // Idempotent: a second cleanup finds nothing left to delete but does
    // not fail (driver deletes are idempotent).
    const again = await service.cleanupMigrationSources(migrationId);
    expect(again.failures).toEqual([]);
  });

  it("records failed verification without performing cutover", async () => {
    const original = Buffer.from("original bytes the row's sha256 records");
    const uploaded = await media.upload({
      data: original,
      originalFilename: "corrupted.bin",
    });
    // Corrupt the SOURCE object after upload so the copied bytes can never
    // match the recorded sha256.
    const sourceDriver = await backends.resolveDriver(sourceBackendId);
    await sourceDriver.put(
      uploaded.storageKey,
      Buffer.from("tampered bytes that do not match the recorded hash"),
    );
    sourceDriver.close?.();

    runtime = await startWorkerRuntime({
      databaseUrl,
      logger: silentJobsLogger,
      registry: createTaskRegistry([service.task]),
      pollInterval: 50,
    });
    const migration = await service.startMigration({
      sourceBackendId,
      destinationBackendId,
      maxAttemptsPerObject: 1,
    });
    await waitFor(
      async () => {
        const { migration: row } = await service.getMigrationStatus(
          migration.id,
        );
        return row.status === "completed_with_errors";
      },
      { label: "failed migration settled", timeoutMs: 30_000 },
    );
    await stopRuntime();

    const status = await service.getMigrationStatus(migration.id);
    expect(status.counts.failed).toBe(1);
    expect(status.counts.done).toBe(0);

    const objectRow = await handle.db.query.storageMigrationObjects.findFirst({
      where: (table, { eq }) => eq(table.migrationId, migration.id),
    });
    expect(objectRow?.status).toBe("failed");
    expect(objectRow?.lastError).toMatch(/mismatch/);
    expect(objectRow?.verifiedAt).toBeNull();

    // NO cutover: the media row still points at the source backend, and the
    // bad destination copy was removed.
    const mediaRow = await media.getMediaObject(uploaded.id);
    expect(mediaRow.storageBackendId).toBe(sourceBackendId);
    const destinationDriver = await backends.resolveDriver(
      destinationBackendId,
    );
    try {
      expect(await destinationDriver.exists(uploaded.storageKey)).toBe(false);
    } finally {
      destinationDriver.close?.();
    }

    // Cleanup skips failed objects — the (only) source copy stays intact.
    const cleanup = await service.cleanupMigrationSources(migration.id);
    expect(cleanup).toEqual({ deleted: 0, skipped: 1, failures: [] });
    const sourceCheck = await backends.resolveDriver(sourceBackendId);
    try {
      expect(await sourceCheck.exists(uploaded.storageKey)).toBe(true);
    } finally {
      sourceCheck.close?.();
    }
  });
});
