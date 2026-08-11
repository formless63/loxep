/**
 * @loxep/storage — media/object-storage foundation (ADR-0012, ADR-0014).
 *
 * One storage-driver contract with `local` and generic `s3` implementations,
 * `storage_backends` records with encrypted credentials, media identity in
 * PostgreSQL, and the resumable copy→verify→cutover→explicit-cleanup
 * storage-migration workflow on Graphile Worker.
 */
export {
  MediaObjectNotFoundError,
  ObjectNotFoundError,
  StorageBackendError,
  StorageDriverError,
  StorageError,
  StorageKeyError,
  StorageMigrationError,
} from "./errors.ts";

export {
  LOCAL_TMP_DIR,
  MAX_STORAGE_KEY_LENGTH,
  generateMediaStorageKey,
  validateStorageKey,
  validateStorageKeyPrefix,
} from "./keys.ts";

export type {
  ListOptions,
  ListResult,
  PutOptions,
  StatResult,
  StorageDriver,
} from "./driver.ts";

export { createLocalDriver } from "./drivers/local.ts";
export type { LocalDriverOptions } from "./drivers/local.ts";

export { createS3Driver } from "./drivers/s3.ts";
export type { ChecksumMode, S3DriverOptions } from "./drivers/s3.ts";

export {
  STORAGE_DRIVER_FAMILIES,
  backendSecretKey,
  createStorageBackendsService,
  localBackendConfigSchema,
  s3BackendConfigSchema,
} from "./backends.ts";
export type {
  LocalBackendConfig,
  RegisterBackendInput,
  S3BackendConfig,
  StorageBackendRecord,
  StorageBackendsService,
  StorageDriverFamily,
} from "./backends.ts";

export { createMediaService } from "./media.ts";
export type {
  MediaLinkInput,
  MediaLinkRecord,
  MediaObjectRecord,
  MediaService,
  UploadInput,
} from "./media.ts";

export {
  STORAGE_MIGRATE_OBJECT_TASK_NAME,
  STORAGE_MIGRATION_OBJECT_STATUSES,
  STORAGE_MIGRATION_STATUSES,
  createStorageMigrationService,
} from "./migration.ts";
export type {
  CleanupResult,
  MigrationEnqueue,
  MigrationStatus,
  MigrationStatusCounts,
  StartMigrationInput,
  StorageMigrationObjectStatus,
  StorageMigrationRecord,
  StorageMigrationService,
  StorageMigrationStatus,
} from "./migration.ts";
