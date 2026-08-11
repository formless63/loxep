/**
 * Generic S3-compatible storage driver (ADR-0012, ADR-0014) over
 * @aws-sdk/client-s3 (verified against 3.1107.0).
 *
 * Compatibility posture — this driver targets *generic* S3 semantics
 * (RustFS is the tested companion, never a modeling assumption):
 *
 * - **Path-style addressing** defaults ON (`forcePathStyle: true`): custom
 *   endpoints like `http://rustfs:9000` do not resolve virtual-host bucket
 *   subdomains.
 * - **Flexible checksums**: since the Dec 2024 data-integrity rollout the
 *   JS SDK defaults `requestChecksumCalculation`/`responseChecksumValidation`
 *   to `WHEN_SUPPORTED`, sending a CRC32 checksum (header or aws-chunked
 *   trailer) on every PutObject — which several S3-compatible services
 *   reject. Both settings therefore default to `WHEN_REQUIRED` here
 *   (verified against the AWS SDK reference, feature-dataintegrity).
 *   Loxep performs its own end-to-end sha256 verification at the media
 *   layer, so nothing is lost.
 * - Streamed `put` bodies are buffered before upload because S3 `PutObject`
 *   requires a known Content-Length and multipart upload is not part of the
 *   Phase 0 contract. Callers with very large objects should pass bytes or
 *   accept the buffering cost.
 */
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ObjectNotFoundError,
  StorageDriverError,
} from "../errors.ts";
import { validateStorageKey, validateStorageKeyPrefix } from "../keys.ts";
import type {
  ListOptions,
  ListResult,
  PutOptions,
  StatResult,
  StorageDriver,
} from "../driver.ts";

export type ChecksumMode = "WHEN_SUPPORTED" | "WHEN_REQUIRED";

export interface S3DriverOptions {
  /** Full endpoint URL, e.g. `http://rustfs:9000` or an AWS regional URL. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Default true — required by most S3-compatible endpoints. */
  forcePathStyle?: boolean;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  /** Default "WHEN_REQUIRED" (see module doc). */
  requestChecksumCalculation?: ChecksumMode;
  /** Default "WHEN_REQUIRED" (see module doc). */
  responseChecksumValidation?: ChecksumMode;
}

const DEFAULT_LIST_LIMIT = 1000;

interface S3LikeError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

function isMissingKeyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as S3LikeError;
  return (
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.$metadata?.httpStatusCode === 404
  );
}

async function collectBytes(data: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of data) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    );
  }
  return Buffer.concat(chunks);
}

export function createS3Driver(options: S3DriverOptions): StorageDriver {
  const bucket = options.bucket;
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle ?? true,
    credentials: {
      accessKeyId: options.credentials.accessKeyId,
      secretAccessKey: options.credentials.secretAccessKey,
    },
    requestChecksumCalculation:
      options.requestChecksumCalculation ?? "WHEN_REQUIRED",
    responseChecksumValidation:
      options.responseChecksumValidation ?? "WHEN_REQUIRED",
  });

  async function put(
    key: string,
    data: Uint8Array | Readable,
    opts?: PutOptions,
  ): Promise<void> {
    validateStorageKey(key);
    const body = data instanceof Readable ? await collectBytes(data) : data;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        ...(opts?.contentType !== undefined
          ? { ContentType: opts.contentType }
          : {}),
      }),
    );
  }

  async function get(key: string): Promise<Readable> {
    validateStorageKey(key);
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (!(response.Body instanceof Readable)) {
        throw new StorageDriverError(
          `unexpected non-stream GetObject body for key "${key}"`,
        );
      }
      return response.Body;
    } catch (error) {
      if (isMissingKeyError(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async function deleteKey(key: string): Promise<void> {
    validateStorageKey(key);
    // S3 DeleteObject is idempotent: deleting a missing key succeeds.
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async function statKey(key: string): Promise<StatResult> {
    validateStorageKey(key);
    try {
      const response = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (response.ContentLength === undefined) {
        throw new StorageDriverError(
          `HeadObject for key "${key}" returned no ContentLength`,
        );
      }
      const etag = response.ETag?.replaceAll('"', "");
      return {
        sizeBytes: response.ContentLength,
        ...(etag !== undefined ? { etag } : {}),
      };
    } catch (error) {
      if (isMissingKeyError(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
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

  async function list(
    prefix: string,
    opts?: ListOptions,
  ): Promise<ListResult> {
    validateStorageKeyPrefix(prefix);
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: Math.max(1, Math.min(opts?.limit ?? DEFAULT_LIST_LIMIT, 1000)),
        ...(opts?.cursor !== undefined
          ? { ContinuationToken: opts.cursor }
          : {}),
      }),
    );
    const keys = (response.Contents ?? [])
      .map((entry) => entry.Key)
      .filter((key): key is string => key !== undefined);
    return {
      keys,
      cursor:
        response.IsTruncated === true &&
        response.NextContinuationToken !== undefined
          ? response.NextContinuationToken
          : null,
    };
  }

  return {
    put,
    get,
    delete: deleteKey,
    exists,
    stat: statKey,
    list,
    close: () => client.destroy(),
  };
}
