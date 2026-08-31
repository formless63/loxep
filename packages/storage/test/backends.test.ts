/**
 * storage_backends records + media service integration tests against real
 * PostgreSQL (scratch database per file) and — where the generic S3 test
 * endpoint is reachable — a real S3 backend with encrypted credentials.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import { createSecretsService } from "@loxep/domain";
import type { DbHandle } from "@loxep/db";
import {
  MediaObjectNotFoundError,
  ObjectNotFoundError,
  StorageBackendError,
  backendSecretKey,
  createMediaService,
  createStorageBackendsService,
} from "../src/index.ts";
import type {
  MediaService,
  StorageBackendsService,
} from "../src/index.ts";
import {
  collect,
  createScratchDb,
  dropScratchDb,
  insertTestUser,
  s3EndpointAvailable,
  s3TestConfig,
  s3UnavailableMessage,
  scratchDbName,
  silentLogger,
  testKeyring,
} from "./helpers.ts";

const s3Available = await s3EndpointAvailable();
if (!s3Available) {
  // eslint-disable-next-line no-console
  console.warn(s3UnavailableMessage());
}

describe("storage backends + media services", () => {
  const dbName = scratchDbName("loxep_test_storage_backends");
  let handle: DbHandle;
  let backends: StorageBackendsService;
  let media: MediaService;
  let actorId: string;
  let localRootDir: string;
  let localBackendId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    backends = createStorageBackendsService({
      db: handle.db,
      keyring: testKeyring(),
    });
    media = createMediaService({ db: handle.db, backends });
    actorId = await insertTestUser(handle.db, "user_storage_actor");
    localRootDir = await mkdtemp(join(tmpdir(), "loxep-storage-backends-"));
    const backend = await backends.registerBackend({
      name: "local default",
      driver: "local",
      config: { rootDir: localRootDir },
      makeDefault: true,
      createdByUserId: actorId,
    });
    localBackendId = backend.id;
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
    await rm(localRootDir, { recursive: true, force: true });
  });

  it("registers a local backend as default", async () => {
    const backend = await backends.getBackend(localBackendId);
    expect(backend.driver).toBe("local");
    expect(backend.enabled).toBe(true);
    expect(backend.isDefault).toBe(true);
    expect(backend.secretId).toBeNull();
    expect(backend.config).toEqual({ rootDir: localRootDir });
  });

  it("rejects invalid per-family config", async () => {
    await expect(
      backends.registerBackend({
        name: "bad local",
        driver: "local",
        config: { rootDir: "relative/path" },
      }),
    ).rejects.toThrow(/absolute/);
    await expect(
      backends.registerBackend({
        name: "bad s3",
        driver: "s3",
        // @ts-expect-error deliberately malformed config
        config: { endpoint: "not a url", bucket: "" },
        credentials: { accessKeyId: "k", secretAccessKey: "s" },
      }),
    ).rejects.toThrow();
  });

  it("default-backend semantics: single default, switchable, guarded", async () => {
    const other = await backends.registerBackend({
      name: "second local",
      driver: "local",
      config: { rootDir: localRootDir },
    });
    await backends.setDefaultBackend(other.id);
    const rows = await backends.listBackends();
    expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([
      other.id,
    ]);
    // Cannot disable the default.
    await expect(backends.disableBackend(other.id)).rejects.toThrow(
      StorageBackendError,
    );
    // Restore the original default; the other backend can then be disabled
    // and a disabled backend cannot become default.
    await backends.setDefaultBackend(localBackendId);
    await backends.disableBackend(other.id);
    await expect(backends.setDefaultBackend(other.id)).rejects.toThrow(
      StorageBackendError,
    );
    expect((await backends.getDefaultBackend()).id).toBe(localBackendId);
  });

  it("serializes concurrent default switches and leaves one enabled default", async () => {
    const candidates = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        backends.registerBackend({
          name: `concurrent default ${index}`,
          driver: "local" as const,
          config: { rootDir: localRootDir },
        }),
      ),
    );

    await expect(
      Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          backends.setDefaultBackend(
            candidates[index % candidates.length]?.id ?? localBackendId,
          ),
        ),
      ),
    ).resolves.toHaveLength(16);

    const defaults = (await backends.listBackends()).filter(
      (row) => row.isDefault,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.enabled).toBe(true);

    // Keep the fixture's original default stable for later media tests.
    await backends.setDefaultBackend(localBackendId);
  });

  it("enforces default invariants below the service boundary", async () => {
    await expect(
      handle.pool.query(
        `insert into storage_backends (name, driver, enabled, is_default)
         values ('duplicate default', 'local', true, true)`,
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "storage_backends_default_uq",
    });

    await expect(
      handle.pool.query(
        `insert into storage_backends (name, driver, enabled, is_default)
         values ('disabled default', 'local', false, true)`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "storage_backends_default_enabled_check",
    });

    await expect(
      handle.pool.query(
        `update storage_backends set enabled = false where id = $1`,
        [localBackendId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "storage_backends_default_enabled_check",
    });
    expect((await backends.getDefaultBackend()).id).toBe(localBackendId);
  });

  it("serializes a default-selection race with disabling the same backend", async () => {
    const candidate = await backends.registerBackend({
      name: "default-disable race",
      driver: "local",
      config: { rootDir: localRootDir },
    });
    const outcomes = await Promise.allSettled([
      backends.setDefaultBackend(candidate.id),
      backends.disableBackend(candidate.id),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(StorageBackendError);

    const rows = await backends.listBackends();
    const defaults = rows.filter((row) => row.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.enabled).toBe(true);
    expect(rows.some((row) => row.isDefault && !row.enabled)).toBe(false);

    if (!(await backends.getBackend(candidate.id)).enabled) {
      await backends.enableBackend(candidate.id);
    }
    await backends.setDefaultBackend(localBackendId);
  });

  it("uploads to the default backend, computes sha256/size, reads back, removes", async () => {
    const payload = Buffer.from("loxep media payload — ünïcode ✓");
    const uploaded = await media.upload({
      data: payload,
      originalFilename: "note.txt",
      mimeType: "text/plain",
      createdByUserId: actorId,
    });
    expect(uploaded.storageBackendId).toBe(localBackendId);
    expect(uploaded.sizeBytes).toBe(payload.length);
    expect(uploaded.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(uploaded.storageKey).toBe(
      `media/${uploaded.id.slice(0, 2)}/${uploaded.id.slice(2, 4)}/${uploaded.id}`,
    );

    const { mediaObject, body } = await media.read(uploaded.id);
    expect(mediaObject.id).toBe(uploaded.id);
    expect((await collect(body)).equals(payload)).toBe(true);

    await media.remove(uploaded.id);
    await expect(media.getMediaObject(uploaded.id)).rejects.toThrow(
      MediaObjectNotFoundError,
    );
    const driver = await backends.resolveDriver(localBackendId);
    await expect(driver.get(uploaded.storageKey)).rejects.toThrow(
      ObjectNotFoundError,
    );
  });

  it("uploads streamed data and hashes it on the way through", async () => {
    const payload = Buffer.from("streamed bytes ".repeat(1000));
    const uploaded = await media.upload({
      data: Readable.from([payload]),
      mimeType: "application/octet-stream",
    });
    expect(uploaded.sizeBytes).toBe(payload.length);
    const { body } = await media.read(uploaded.id);
    expect((await collect(body)).equals(payload)).toBe(true);
  });

  it("manages media links", async () => {
    const uploaded = await media.upload({ data: Buffer.from("linked") });
    const link = await media.addLink({
      mediaObjectId: uploaded.id,
      resourceType: "listing",
      resourceId: "listing-1",
      purpose: "gallery",
      sortOrder: 1,
    });
    expect(link.mediaObjectId).toBe(uploaded.id);
    const forResource = await media.listLinksForResource({
      resourceType: "listing",
      resourceId: "listing-1",
    });
    expect(forResource).toHaveLength(1);
    expect(await media.listLinksForMedia(uploaded.id)).toHaveLength(1);
    await media.removeLink({
      mediaObjectId: uploaded.id,
      resourceType: "listing",
      resourceId: "listing-1",
      purpose: "gallery",
    });
    expect(await media.listLinksForMedia(uploaded.id)).toHaveLength(0);
    // remove() also clears remaining links before deleting the row.
    await media.addLink({
      mediaObjectId: uploaded.id,
      resourceType: "listing",
      resourceId: "listing-1",
      purpose: "gallery",
    });
    await media.remove(uploaded.id);
    expect(
      await media.listLinksForResource({
        resourceType: "listing",
        resourceId: "listing-1",
      }),
    ).toHaveLength(0);
  });

  it("rejects uploads to unknown or disabled backends", async () => {
    await expect(
      media.upload({ backendId: randomUUID(), data: Buffer.from("x") }),
    ).rejects.toThrow(StorageBackendError);
    const disabled = await backends.registerBackend({
      name: "disabled local",
      driver: "local",
      config: { rootDir: localRootDir },
    });
    await backends.disableBackend(disabled.id);
    await expect(
      media.upload({ backendId: disabled.id, data: Buffer.from("x") }),
    ).rejects.toThrow(/disabled/);
  });

  describe("rotateCredentials (loxep-4wa)", () => {
    it("replaces an s3 backend's stored credentials in place, keeping its id", async () => {
      const backend = await backends.registerBackend({
        name: `rotatable ${randomUUID().slice(0, 8)}`,
        driver: "s3",
        config: {
          endpoint: "https://s3.example.test",
          region: "us-east-1",
          bucket: "loxep-rotate-test",
        },
        credentials: { accessKeyId: "AKIA_OLD", secretAccessKey: "old-secret" },
        createdByUserId: actorId,
      });

      await backends.rotateCredentials(
        backend.id,
        { accessKeyId: "AKIA_NEW", secretAccessKey: "new-secret" },
        { actorUserId: actorId },
      );

      // Same backend row, same secret pointer — only the payload version
      // moved, which is what keeps every media_objects row and any
      // in-flight migration pointing at a backend that still works.
      const after = await backends.getBackend(backend.id);
      expect(after.id).toBe(backend.id);
      expect(after.secretId).toBe(backend.secretId);

      const secrets = createSecretsService({
        db: handle.db,
        keyring: testKeyring(),
      });
      const { payload } = await secrets.getSecretPayload(
        backendSecretKey(backend.id),
        "s3_credentials",
      );
      expect(payload).toMatchObject({
        accessKeyId: "AKIA_NEW",
        secretAccessKey: "new-secret",
      });
    });

    it("refuses a local backend — there is nothing to rotate", async () => {
      await expect(
        backends.rotateCredentials(localBackendId, {
          accessKeyId: "AKIA",
          secretAccessKey: "s",
        }),
      ).rejects.toThrow(/has no credentials to rotate/);
    });
  });

  describe.runIf(s3Available)("s3 backend with encrypted credentials", () => {
    let s3BackendId: string;
    const bucket = `loxep-backends-${randomUUID().slice(0, 13)}`;

    beforeAll(async () => {
      const config = s3TestConfig();
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
      const backend = await backends.registerBackend({
        name: "generic s3",
        driver: "s3",
        config: {
          endpoint: config.endpoint,
          region: config.region,
          bucket,
        },
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        createdByUserId: actorId,
      });
      s3BackendId = backend.id;
    });

    it("stores credentials as an encrypted logical secret, never in config", async () => {
      const backend = await backends.getBackend(s3BackendId);
      expect(backend.secretId).not.toBeNull();
      const config = s3TestConfig();
      expect(JSON.stringify(backend.config)).not.toContain(
        config.secretAccessKey,
      );
      const secretRow = await handle.db.query.applicationSecrets.findFirst({
        where: (table, { eq }) => eq(table.id, backend.secretId as string),
      });
      expect(secretRow?.secretKey).toBe(backendSecretKey(s3BackendId));
      expect(secretRow?.purpose).toBe("s3_credentials");
      // No plaintext credential material anywhere in the backends table.
      const raw = await handle.pool.query(
        "select to_json(t)::text as row from storage_backends t",
      );
      for (const row of raw.rows as Array<{ row: string }>) {
        expect(row.row).not.toContain(config.secretAccessKey);
      }
    });

    it("resolveDriver decrypts credentials internally and uploads work end-to-end", async () => {
      const payload = Buffer.from("s3-backed media object");
      const uploaded = await media.upload({
        backendId: s3BackendId,
        data: payload,
        mimeType: "application/octet-stream",
      });
      expect(uploaded.storageBackendId).toBe(s3BackendId);
      const { body } = await media.read(uploaded.id);
      expect((await collect(body)).equals(payload)).toBe(true);
      await media.remove(uploaded.id);
    });
  });
});
