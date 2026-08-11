/**
 * Local filesystem storage driver (ADR-0012): the zero-extra-service
 * default. Objects live under `rootDir` at their key path; writes are atomic
 * (temp file in a driver-private directory + `rename`), so readers never see
 * partial objects and a crash never leaves a truncated object at a live key.
 *
 * Key → path mapping is safe by construction: keys pass
 * `validateStorageKey` (no `..`/`.` segments, no absolute keys, no
 * backslashes), and the resolved path is additionally verified to stay
 * inside `rootDir` as defense in depth.
 *
 * `list` walks the smallest directory subtree containing the prefix and
 * filters by string prefix — O(subtree) per page, which is fine for the
 * Phase 0 catalog sizes this driver targets; large installations are
 * expected to migrate to S3-compatible storage anyway.
 */
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ObjectNotFoundError,
  StorageDriverError,
  StorageKeyError,
} from "../errors.ts";
import {
  LOCAL_TMP_DIR,
  validateStorageKey,
  validateStorageKeyPrefix,
} from "../keys.ts";
import type {
  ListOptions,
  ListResult,
  PutOptions,
  StatResult,
  StorageDriver,
} from "../driver.ts";

export interface LocalDriverOptions {
  /** Absolute directory that owns all objects; created on first write. */
  rootDir: string;
}

const DEFAULT_LIST_LIMIT = 1000;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function createLocalDriver(options: LocalDriverOptions): StorageDriver {
  if (!isAbsolute(options.rootDir)) {
    throw new StorageDriverError(
      "local storage driver requires an absolute rootDir",
    );
  }
  const rootDir = resolve(options.rootDir);
  const tmpDir = join(rootDir, LOCAL_TMP_DIR);

  function pathFor(key: string): string {
    validateStorageKey(key);
    const resolved = resolve(rootDir, ...key.split("/"));
    // Defense in depth: validateStorageKey already forbids traversal.
    if (resolved !== rootDir && !resolved.startsWith(rootDir + sep)) {
      throw new StorageKeyError(
        `storage key "${key}" resolves outside the storage root`,
      );
    }
    return resolved;
  }

  async function put(
    key: string,
    data: Uint8Array | Readable,
    _opts?: PutOptions,
  ): Promise<void> {
    const finalPath = pathFor(key);
    await mkdir(dirname(finalPath), { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, randomUUID());
    try {
      if (data instanceof Readable) {
        await pipeline(data, createWriteStream(tmpPath, { flags: "wx" }));
      } else {
        await writeFile(tmpPath, data, { flag: "wx" });
      }
      await rename(tmpPath, finalPath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function statKey(key: string): Promise<StatResult> {
    const path = pathFor(key);
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        throw new ObjectNotFoundError(key, "path is not a regular file");
      }
      return { sizeBytes: info.size };
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        throw new ObjectNotFoundError(key);
      }
      throw error;
    }
  }

  async function get(key: string): Promise<Readable> {
    // Eager existence check so missing keys reject the returned promise
    // instead of erroring later on the stream.
    await statKey(key);
    return createReadStream(pathFor(key));
  }

  async function deleteKey(key: string): Promise<void> {
    await rm(pathFor(key), { force: true });
  }

  async function exists(key: string): Promise<boolean> {
    try {
      await statKey(key);
      return true;
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return false;
      throw error;
    }
  }

  async function walk(dir: string, keyPrefix: string, out: string[]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const childKey =
        keyPrefix === "" ? entry.name : `${keyPrefix}/${entry.name}`;
      if (keyPrefix === "" && entry.name === LOCAL_TMP_DIR) continue;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), childKey, out);
      } else if (entry.isFile()) {
        out.push(childKey);
      }
    }
  }

  async function list(
    prefix: string,
    opts?: ListOptions,
  ): Promise<ListResult> {
    validateStorageKeyPrefix(prefix);
    const limit = Math.max(1, opts?.limit ?? DEFAULT_LIST_LIMIT);
    // Walk from the deepest directory the prefix fully names, so a partial
    // last segment ("media/ab" matching "media/abc/...") still matches.
    const lastSlash = prefix.lastIndexOf("/");
    const dirPart = lastSlash === -1 ? "" : prefix.slice(0, lastSlash);
    const walkDir =
      dirPart === "" ? rootDir : resolve(rootDir, ...dirPart.split("/"));
    const all: string[] = [];
    await walk(walkDir, dirPart, all);
    const matching = all.filter((key) => key.startsWith(prefix)).sort();
    const startIndex =
      opts?.cursor === undefined
        ? 0
        : matching.findIndex((key) => key > (opts.cursor as string));
    const window =
      startIndex === -1 ? [] : matching.slice(startIndex, startIndex + limit);
    const exhausted =
      startIndex === -1 || startIndex + limit >= matching.length;
    const lastKey = window[window.length - 1];
    return {
      keys: window,
      cursor: exhausted || lastKey === undefined ? null : lastKey,
    };
  }

  return {
    put,
    get,
    delete: deleteKey,
    exists,
    stat: statKey,
    list,
  };
}
