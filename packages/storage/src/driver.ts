/**
 * Storage driver contract (ADR-0012, ADR-0014).
 *
 * A driver stores and retrieves opaque byte objects addressed by
 * Loxep-generated string keys. Drivers know nothing about media identity,
 * PostgreSQL, or each other — the database owns identity/metadata, the
 * driver owns bytes.
 *
 * Contract decisions (uniform across ALL drivers — the conformance suite in
 * `test/conformance.test.ts` enforces them implementation-blind):
 *
 * - `get` returns a Node `Readable` stream (chosen over `Uint8Array` so
 *   large objects never require full buffering on the read path; callers
 *   that want bytes collect the stream).
 * - `get`/`stat` on a missing key throw {@link ObjectNotFoundError};
 *   `exists` returns `false`; `delete` is idempotent (missing key is a
 *   successful no-op).
 * - `put` overwrites an existing key.
 * - Every operation validates its key with `validateStorageKey` first —
 *   traversal segments (`.`/`..`), absolute keys, backslashes, and control
 *   characters are rejected by contract, not merely by one implementation.
 * - `list` returns keys in lexicographic order with opaque cursor
 *   pagination; the cursor format is driver-private.
 */
import type { Readable } from "node:stream";

export interface PutOptions {
  /** Best-effort content type hint; drivers may ignore it (local does). */
  contentType?: string;
}

export interface StatResult {
  sizeBytes: number;
  /** Backend-provided entity tag where available (S3); absent for local. */
  etag?: string;
}

export interface ListOptions {
  /** Opaque cursor from a previous page's `cursor`; driver-private format. */
  cursor?: string;
  /** Maximum keys per page (drivers may return fewer; S3 caps at 1000). */
  limit?: number;
}

export interface ListResult {
  /** Keys in lexicographic order. */
  keys: string[];
  /** Cursor for the next page, or null when the listing is exhausted. */
  cursor: string | null;
}

/**
 * The storage driver interface. Keys are opaque Loxep-generated strings —
 * see `keys.ts` for the `media/<uuid-prefix-split>` convention media uploads
 * use; the driver itself must not care about key semantics.
 */
export interface StorageDriver {
  put(
    key: string,
    data: Uint8Array | Readable,
    opts?: PutOptions,
  ): Promise<void>;
  /** Returns a Readable over the object bytes (see module doc). */
  get(key: string): Promise<Readable>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StatResult>;
  list(prefix: string, opts?: ListOptions): Promise<ListResult>;
  /**
   * Releases held resources (sockets). Optional; local driver holds none.
   * Do not close while a `get` stream is still being consumed.
   */
  close?(): void;
}
