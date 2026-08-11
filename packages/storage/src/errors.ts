/**
 * Storage-layer error types.
 *
 * Error messages may reference storage keys, backend IDs/names, driver
 * families, and structural facts — never credentials or decrypted secret
 * material.
 */

/** Base class for all @loxep/storage errors. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A storage key failed validation (traversal, absolute path, illegal chars). */
export class StorageKeyError extends StorageError {}

/** The requested object key does not exist on the backend. */
export class ObjectNotFoundError extends StorageError {
  readonly key: string;

  constructor(key: string, detail?: string) {
    super(
      `storage object "${key}" does not exist${detail !== undefined ? ` (${detail})` : ""}`,
    );
    this.key = key;
  }
}

/** A driver operation failed for a reason other than a missing key. */
export class StorageDriverError extends StorageError {}

/** Backend record missing, disabled where enabled is required, or malformed. */
export class StorageBackendError extends StorageError {}

/** The referenced media object row does not exist. */
export class MediaObjectNotFoundError extends StorageError {}

/** Storage-migration workflow failure (copy/verify/cutover/cleanup). */
export class StorageMigrationError extends StorageError {}
