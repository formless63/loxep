/**
 * Storage-driver conformance suite (ADR-0012, ADR-0014 §9).
 *
 * ONE shared suite runs against every driver leg; the tests receive only a
 * `StorageDriver` factory and never know which implementation they exercise.
 * Leg setup is necessarily leg-specific (a temp directory vs. a bucket on a
 * generic S3 endpoint), but nothing inside a test is.
 *
 * The S3 leg targets whatever generic S3-compatible endpoint
 * `LOXEP_TEST_S3_*` points at (default: the disposable RustFS test
 * container). If the endpoint is unreachable the leg is skipped with a
 * clear message instead of failing.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  ObjectNotFoundError,
  StorageKeyError,
  createLocalDriver,
  createS3Driver,
} from "../src/index.ts";
import type { StorageDriver } from "../src/index.ts";
import {
  collect,
  s3EndpointAvailable,
  s3TestConfig,
  s3UnavailableMessage,
} from "./helpers.ts";

interface DriverLeg {
  name: string;
  create: () => Promise<{ driver: StorageDriver; destroy: () => Promise<void> }>;
}

const localLeg: DriverLeg = {
  name: "local",
  create: async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "loxep-storage-conf-"));
    const driver = createLocalDriver({ rootDir });
    return {
      driver,
      destroy: async () => {
        await rm(rootDir, { recursive: true, force: true });
      },
    };
  },
};

const s3Leg: DriverLeg = {
  name: "s3 (generic endpoint)",
  create: async () => {
    const config = s3TestConfig();
    const bucket = `loxep-conformance-${randomUUID().slice(0, 13)}`;
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
    const driver = createS3Driver({
      endpoint: config.endpoint,
      region: config.region,
      bucket,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    return {
      driver,
      destroy: async () => {
        // Best-effort bucket drain; scratch buckets on a disposable test
        // endpoint may simply be discarded with the container.
        let cursor: string | undefined;
        do {
          const page = await driver.list("", {
            ...(cursor !== undefined ? { cursor } : {}),
          });
          for (const key of page.keys) await driver.delete(key);
          cursor = page.cursor ?? undefined;
        } while (cursor !== undefined);
        driver.close?.();
      },
    };
  },
};

const s3Available = await s3EndpointAvailable();
if (!s3Available) {
  // eslint-disable-next-line no-console
  console.warn(s3UnavailableMessage());
}

const legs: DriverLeg[] = [localLeg, ...(s3Available ? [s3Leg] : [])];

if (!s3Available) {
  describe("s3 conformance leg availability", () => {
    it.skip(s3UnavailableMessage(), () => {});
  });
}

describe.each(legs)("storage driver conformance: $name", (leg) => {
  let driver: StorageDriver;
  let destroy: () => Promise<void>;

  beforeAll(async () => {
    const created = await leg.create();
    driver = created.driver;
    destroy = created.destroy;
  });

  afterAll(async () => {
    await destroy();
  });

  it("round-trips bytes exactly", async () => {
    const key = `conf/roundtrip/${randomUUID()}`;
    const payload = randomBytes(4096);
    await driver.put(key, payload, { contentType: "application/octet-stream" });
    const got = await collect(await driver.get(key));
    expect(got.equals(payload)).toBe(true);
  });

  it("round-trips bytes supplied as a stream", async () => {
    const key = `conf/stream/${randomUUID()}`;
    const payload = randomBytes(64 * 1024);
    await driver.put(key, Readable.from([payload]));
    const got = await collect(await driver.get(key));
    expect(got.equals(payload)).toBe(true);
  });

  it("overwrites an existing key", async () => {
    const key = `conf/overwrite/${randomUUID()}`;
    await driver.put(key, Buffer.from("first version"));
    await driver.put(key, Buffer.from("second version"));
    const got = await collect(await driver.get(key));
    expect(got.toString("utf8")).toBe("second version");
    expect((await driver.stat(key)).sizeBytes).toBe(
      Buffer.byteLength("second version"),
    );
  });

  it("delete removes the object and is idempotent on missing keys", async () => {
    const key = `conf/delete/${randomUUID()}`;
    await driver.put(key, Buffer.from("to be deleted"));
    expect(await driver.exists(key)).toBe(true);
    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
    await expect(driver.delete(key)).resolves.toBeUndefined();
  });

  it("exists reflects presence", async () => {
    const key = `conf/exists/${randomUUID()}`;
    expect(await driver.exists(key)).toBe(false);
    await driver.put(key, Buffer.from("x"));
    expect(await driver.exists(key)).toBe(true);
  });

  it("stat reports exact size", async () => {
    const key = `conf/stat/${randomUUID()}`;
    const payload = randomBytes(12_345);
    await driver.put(key, payload);
    const stat = await driver.stat(key);
    expect(stat.sizeBytes).toBe(12_345);
  });

  it("stores and serves an empty object", async () => {
    const key = `conf/empty/${randomUUID()}`;
    await driver.put(key, new Uint8Array(0));
    expect((await driver.stat(key)).sizeBytes).toBe(0);
    const got = await collect(await driver.get(key));
    expect(got.length).toBe(0);
  });

  it("round-trips a ~5MB object", async () => {
    const key = `conf/large/${randomUUID()}`;
    const payload = randomBytes(5 * 1024 * 1024);
    await driver.put(key, payload);
    expect((await driver.stat(key)).sizeBytes).toBe(payload.length);
    const got = await collect(await driver.get(key));
    expect(got.equals(payload)).toBe(true);
  });

  it("handles unicode keys", async () => {
    const key = `conf/ünïcode/文件-media-${randomUUID()}`;
    await driver.put(key, Buffer.from("unicode payload"));
    expect(await driver.exists(key)).toBe(true);
    const got = await collect(await driver.get(key));
    expect(got.toString("utf8")).toBe("unicode payload");
    await driver.delete(key);
  });

  it("handles long keys", async () => {
    const segment = "a".repeat(60);
    const key = `conf/long/${segment}/${segment}/${segment}/${randomUUID()}`;
    expect(key.length).toBeGreaterThan(200);
    await driver.put(key, Buffer.from("long key payload"));
    const got = await collect(await driver.get(key));
    expect(got.toString("utf8")).toBe("long key payload");
  });

  it("lists by prefix in lexicographic order with pagination", async () => {
    const prefix = `conf/list-${randomUUID().slice(0, 8)}/`;
    const keys = Array.from({ length: 5 }, (_, i) => `${prefix}item-${i}`);
    for (const key of [...keys].reverse()) {
      await driver.put(key, Buffer.from(key));
    }
    // Unrelated key that must NOT appear under the prefix.
    await driver.put(`conf/other-${randomUUID()}`, Buffer.from("noise"));

    const pageOne = await driver.list(prefix, { limit: 2 });
    expect(pageOne.keys).toEqual(keys.slice(0, 2));
    expect(pageOne.cursor).not.toBeNull();

    const pageTwo = await driver.list(prefix, {
      limit: 2,
      cursor: pageOne.cursor as string,
    });
    expect(pageTwo.keys).toEqual(keys.slice(2, 4));

    const collected = [...pageOne.keys, ...pageTwo.keys];
    let cursor = pageTwo.cursor;
    while (cursor !== null) {
      const page = await driver.list(prefix, { limit: 2, cursor });
      collected.push(...page.keys);
      cursor = page.cursor;
    }
    expect(collected).toEqual(keys);
  });

  it("returns an empty listing for an unknown prefix", async () => {
    const result = await driver.list(`conf/absent-${randomUUID()}/`);
    expect(result.keys).toEqual([]);
    expect(result.cursor).toBeNull();
  });

  it("rejects traversal and absolute keys", async () => {
    const payload = Buffer.from("must never land");
    await expect(driver.put("../escape", payload)).rejects.toThrow(
      StorageKeyError,
    );
    await expect(driver.put("conf/../../escape", payload)).rejects.toThrow(
      StorageKeyError,
    );
    await expect(driver.put("/absolute/key", payload)).rejects.toThrow(
      StorageKeyError,
    );
    await expect(driver.put("conf/./sneaky", payload)).rejects.toThrow(
      StorageKeyError,
    );
    await expect(driver.get("../escape")).rejects.toThrow(StorageKeyError);
    await expect(driver.delete("../escape")).rejects.toThrow(StorageKeyError);
  });

  it("throws ObjectNotFoundError for missing keys", async () => {
    const key = `conf/missing/${randomUUID()}`;
    await expect(driver.get(key)).rejects.toThrow(ObjectNotFoundError);
    await expect(driver.stat(key)).rejects.toThrow(ObjectNotFoundError);
    expect(await driver.exists(key)).toBe(false);
  });
});
