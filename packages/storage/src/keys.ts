/**
 * Storage-key validation and generation.
 *
 * Keys are opaque Loxep-generated strings, stable across storage backends
 * (ADR-0012): media uploads use `media/<aa>/<bb>/<uuid>` where `aa`/`bb` are
 * the first four hex characters of the media object's UUID, keeping local
 * directories and S3 prefix listings shallow. Drivers never interpret this
 * convention — they only enforce the syntactic rules below so no key can
 * escape a driver's root or collide with driver-internal paths.
 */
import { StorageKeyError } from "./errors.ts";

export const MAX_STORAGE_KEY_LENGTH = 1024;

/** Local-driver private directory for atomic-write temp files. */
export const LOCAL_TMP_DIR = ".loxep-tmp";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validates a storage key; throws {@link StorageKeyError} when invalid.
 * Rules (uniform across drivers):
 * - non-empty, at most {@link MAX_STORAGE_KEY_LENGTH} characters;
 * - no absolute keys (leading `/`), no trailing `/`, no empty segments;
 * - no `.` or `..` segments (path traversal);
 * - no backslashes or control characters;
 * - first segment must not be the local driver's private temp directory.
 */
export function validateStorageKey(key: string): string {
  if (key.length === 0) {
    throw new StorageKeyError("storage key must not be empty");
  }
  if (key.length > MAX_STORAGE_KEY_LENGTH) {
    throw new StorageKeyError(
      `storage key exceeds ${MAX_STORAGE_KEY_LENGTH} characters`,
    );
  }
  if (key.includes("\\")) {
    throw new StorageKeyError("storage key must not contain backslashes");
  }
  if (CONTROL_CHARS.test(key)) {
    throw new StorageKeyError("storage key must not contain control characters");
  }
  if (key.startsWith("/")) {
    throw new StorageKeyError("storage key must not be absolute");
  }
  if (key.endsWith("/")) {
    throw new StorageKeyError("storage key must not end with '/'");
  }
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === "") {
      throw new StorageKeyError("storage key must not contain empty segments");
    }
    if (segment === "." || segment === "..") {
      throw new StorageKeyError(
        "storage key must not contain '.' or '..' segments",
      );
    }
  }
  if (segments[0] === LOCAL_TMP_DIR) {
    throw new StorageKeyError(
      `storage key must not start with the reserved segment "${LOCAL_TMP_DIR}"`,
    );
  }
  return key;
}

/**
 * Validates a list prefix: same character rules as keys, but an empty prefix
 * and a trailing `/` (or any partial segment) are allowed.
 */
export function validateStorageKeyPrefix(prefix: string): string {
  if (prefix === "") return prefix;
  if (prefix.length > MAX_STORAGE_KEY_LENGTH) {
    throw new StorageKeyError(
      `storage key prefix exceeds ${MAX_STORAGE_KEY_LENGTH} characters`,
    );
  }
  if (prefix.includes("\\") || CONTROL_CHARS.test(prefix)) {
    throw new StorageKeyError(
      "storage key prefix must not contain backslashes or control characters",
    );
  }
  if (prefix.startsWith("/")) {
    throw new StorageKeyError("storage key prefix must not be absolute");
  }
  for (const segment of prefix.split("/")) {
    if (segment === "." || segment === "..") {
      throw new StorageKeyError(
        "storage key prefix must not contain '.' or '..' segments",
      );
    }
  }
  return prefix;
}

/**
 * Canonical storage key for a media object UUID:
 * `media/<uuid[0..2]>/<uuid[2..4]>/<uuid>`.
 */
export function generateMediaStorageKey(mediaObjectId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    mediaObjectId,
  )) {
    throw new StorageKeyError(
      "media storage keys are generated from a canonical UUID",
    );
  }
  const id = mediaObjectId.toLowerCase();
  return `media/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
}
