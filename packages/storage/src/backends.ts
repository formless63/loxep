/**
 * `storage_backends` records service (ADR-0012, ADR-0014, foundation
 * schema): storage destinations are configured resources, not hardcoded
 * driver names. Non-secret config lives in the `config` jsonb (validated
 * per driver family with Zod); S3 credentials are application-encrypted
 * through the @loxep/domain secrets service (`s3_credentials` bundle), with
 * `storage_backends.secret_id` referencing the LOGICAL `application_secrets`
 * row (ADR-0019 — never a version row).
 *
 * Credentials are decrypted ONLY inside `resolveDriver`; they never appear
 * on backend records, list output, or error messages.
 *
 * Known limitation (deliberately out of scope here): a multi-host
 * deployment still using a `local` backend should surface a
 * health/configuration warning (ADR-0014 §8). That needs a host registry
 * and belongs to the diagnostics/health surface, not this records service.
 */
import { storageBackends } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { createSecretsService } from "@loxep/domain";
import { z } from "zod";
import { StorageBackendError } from "./errors.ts";
import { createLocalDriver } from "./drivers/local.ts";
import { createS3Driver } from "./drivers/s3.ts";
import type { StorageDriver } from "./driver.ts";
import { uuidLiteral } from "./sql.ts";

type Keyring = Parameters<typeof createSecretsService>[0]["keyring"];

/** Storage driver families (mirrors @loxep/db `STORAGE_DRIVERS`). */
export const STORAGE_DRIVER_FAMILIES = ["local", "s3"] as const;
export type StorageDriverFamily = (typeof STORAGE_DRIVER_FAMILIES)[number];

/** Non-secret config for a `local` backend. */
export const localBackendConfigSchema = z.strictObject({
  rootDir: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("/"), {
      message: "rootDir must be an absolute path",
    }),
});
export type LocalBackendConfig = z.infer<typeof localBackendConfigSchema>;

/**
 * Non-secret config for a generic `s3` backend. Endpoint/region/bucket/
 * addressing only — credentials go through the secrets service.
 */
export const s3BackendConfigSchema = z.strictObject({
  endpoint: z.url(),
  region: z.string().min(1),
  bucket: z.string().min(1),
  forcePathStyle: z.boolean().default(true),
  requestChecksumCalculation: z
    .enum(["WHEN_SUPPORTED", "WHEN_REQUIRED"])
    .default("WHEN_REQUIRED"),
  responseChecksumValidation: z
    .enum(["WHEN_SUPPORTED", "WHEN_REQUIRED"])
    .default("WHEN_REQUIRED"),
});
export type S3BackendConfig = z.infer<typeof s3BackendConfigSchema>;

/** A `storage_backends` row as surfaced by this service (never secrets). */
export interface StorageBackendRecord {
  id: string;
  name: string;
  driver: string;
  enabled: boolean;
  isDefault: boolean;
  config: unknown;
  secretId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RegisterBackendInput =
  | {
      name: string;
      driver: "local";
      config: LocalBackendConfig;
      makeDefault?: boolean;
      createdByUserId?: string | null;
    }
  | {
      name: string;
      driver: "s3";
      config: z.input<typeof s3BackendConfigSchema>;
      credentials: { accessKeyId: string; secretAccessKey: string };
      makeDefault?: boolean;
      createdByUserId?: string | null;
    };

export interface StorageBackendsService {
  registerBackend(input: RegisterBackendInput): Promise<StorageBackendRecord>;
  listBackends(): Promise<StorageBackendRecord[]>;
  getBackend(backendId: string): Promise<StorageBackendRecord>;
  enableBackend(backendId: string): Promise<void>;
  /** Refuses to disable the default backend — set another default first. */
  disableBackend(backendId: string): Promise<void>;
  /** Makes an enabled backend the single default. */
  setDefaultBackend(backendId: string): Promise<void>;
  getDefaultBackend(): Promise<StorageBackendRecord>;
  /**
   * Builds a live {@link StorageDriver} for the backend. Works for disabled
   * backends too (migrations must read from retired sources); *upload*
   * enablement is enforced by the media service. S3 credentials are
   * decrypted only inside this call.
   */
  resolveDriver(backendId: string): Promise<StorageDriver>;
}

/** Logical secret key convention for a backend's S3 credentials. */
export function backendSecretKey(backendId: string): string {
  return `storage.backend.${backendId}.credentials`;
}

export function createStorageBackendsService(options: {
  db: LoxepDb;
  keyring: Keyring;
}): StorageBackendsService {
  const { db, keyring } = options;
  const secrets = createSecretsService({ db, keyring });

  async function getBackend(backendId: string): Promise<StorageBackendRecord> {
    const row = await db.query.storageBackends.findFirst({
      where: (table, { eq }) => eq(table.id, backendId),
    });
    if (row === undefined) {
      throw new StorageBackendError(`unknown storage backend "${backendId}"`);
    }
    return row;
  }

  /** Primary-key upsert used as the update path (no drizzle-orm dep). */
  async function updateBackend(
    row: StorageBackendRecord,
    set: Partial<
      Pick<StorageBackendRecord, "enabled" | "isDefault" | "secretId">
    >,
  ): Promise<void> {
    await db
      .insert(storageBackends)
      .values({ id: row.id, name: row.name, driver: row.driver })
      .onConflictDoUpdate({
        target: storageBackends.id,
        set: { ...set, updatedAt: new Date() },
      });
  }

  async function setDefaultBackend(backendId: string): Promise<void> {
    const target = await getBackend(backendId);
    if (!target.enabled) {
      throw new StorageBackendError(
        `cannot make disabled backend "${backendId}" the default`,
      );
    }
    const currentDefaults = await db.query.storageBackends.findMany({
      where: (table, { eq }) => eq(table.isDefault, true),
    });
    for (const row of currentDefaults) {
      if (row.id !== backendId) {
        await updateBackend(row, { isDefault: false });
      }
    }
    await updateBackend(target, { isDefault: true });
  }

  async function registerBackend(
    input: RegisterBackendInput,
  ): Promise<StorageBackendRecord> {
    const config =
      input.driver === "local"
        ? localBackendConfigSchema.parse(input.config)
        : s3BackendConfigSchema.parse(input.config);
    const createdByUserId = input.createdByUserId ?? null;

    const inserted = await db
      .insert(storageBackends)
      .values({
        name: input.name,
        driver: input.driver,
        config,
        createdByUserId,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new StorageBackendError(
        `failed to register storage backend "${input.name}"`,
      );
    }

    if (input.driver === "s3") {
      try {
        const secret = await secrets.setSecret({
          secretKey: backendSecretKey(row.id),
          purpose: "s3_credentials",
          payload: input.credentials,
          actorUserId: createdByUserId,
        });
        await updateBackend(row, { secretId: secret.id });
      } catch (error) {
        // Roll back the half-registered backend so a failed secret write
        // never leaves an s3 backend without credentials.
        await db
          .execute(
            `delete from storage_backends where id = ${uuidLiteral(row.id)}`,
          )
          .catch(() => undefined);
        throw error;
      }
    }

    if (input.makeDefault === true) {
      await setDefaultBackend(row.id);
    }
    return getBackend(row.id);
  }

  async function listBackends(): Promise<StorageBackendRecord[]> {
    return db.query.storageBackends.findMany({
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    });
  }

  async function enableBackend(backendId: string): Promise<void> {
    const row = await getBackend(backendId);
    await updateBackend(row, { enabled: true });
  }

  async function disableBackend(backendId: string): Promise<void> {
    const row = await getBackend(backendId);
    if (row.isDefault) {
      throw new StorageBackendError(
        `cannot disable default storage backend "${backendId}"; set another default first`,
      );
    }
    await updateBackend(row, { enabled: false });
  }

  async function getDefaultBackend(): Promise<StorageBackendRecord> {
    const row = await db.query.storageBackends.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.isDefault, true), eq(table.enabled, true)),
    });
    if (row === undefined) {
      throw new StorageBackendError(
        "no enabled default storage backend is configured",
      );
    }
    return row;
  }

  async function resolveDriver(backendId: string): Promise<StorageDriver> {
    const row = await getBackend(backendId);
    if (row.driver === "local") {
      const config = localBackendConfigSchema.parse(row.config);
      return createLocalDriver({ rootDir: config.rootDir });
    }
    if (row.driver === "s3") {
      const config = s3BackendConfigSchema.parse(row.config);
      if (row.secretId === null) {
        throw new StorageBackendError(
          `s3 backend "${backendId}" has no credentials secret`,
        );
      }
      const secretRow = await db.query.applicationSecrets.findFirst({
        where: (table, { eq }) => eq(table.id, row.secretId as string),
        columns: { secretKey: true },
      });
      if (secretRow === undefined) {
        throw new StorageBackendError(
          `s3 backend "${backendId}" references a missing credentials secret`,
        );
      }
      // Decryption happens here and only here; the credentials object stays
      // local to the driver instance.
      const { payload } = await secrets.getSecretPayload(
        secretRow.secretKey,
        "s3_credentials",
      );
      return createS3Driver({
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        forcePathStyle: config.forcePathStyle,
        credentials: payload,
        requestChecksumCalculation: config.requestChecksumCalculation,
        responseChecksumValidation: config.responseChecksumValidation,
      });
    }
    throw new StorageBackendError(
      `storage backend "${backendId}" has unknown driver family "${row.driver}"`,
    );
  }

  return {
    registerBackend,
    listBackends,
    getBackend,
    enableBackend,
    disableBackend,
    setDefaultBackend,
    getDefaultBackend,
    resolveDriver,
  };
}
