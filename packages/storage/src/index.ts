/**
 * @loxep/storage — media/object-storage foundation (ADR-0012, ADR-0014).
 *
 * One storage-driver contract with `local` and generic `s3` implementations,
 * `storage_backends` records with encrypted credentials, and media identity
 * in PostgreSQL. This entry point is dependency-light and does not import
 * @loxep/jobs. The resumable copy→verify→cutover→explicit-cleanup
 * storage-migration workflow (Graphile Worker-backed) is exported from the
 * "@loxep/storage/migration" subpath instead — see ./migration.ts.
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

// Storage-migration exports (Graphile Worker-backed) live behind the
// "@loxep/storage/migration" subpath so importers that only need the
// driver/backend/media surface do not pull in @loxep/jobs transitively.
