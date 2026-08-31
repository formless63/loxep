import { Readable } from "node:stream";
import type { LoxepDb } from "@loxep/db";
import { describe, expect, it, vi } from "vitest";
import { createMediaService } from "../src/media.ts";
import type { MediaObjectRecord } from "../src/media.ts";
import type { StorageBackendsService } from "../src/backends.ts";
import type { StorageDriver } from "../src/driver.ts";
import { collect } from "./helpers.ts";

const mediaObject: MediaObjectRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  storageBackendId: "00000000-0000-4000-8000-000000000002",
  storageKey: "media/00/00/00000000-0000-4000-8000-000000000001",
  originalFilename: null,
  mimeType: "application/octet-stream",
  sizeBytes: 7,
  sha256: "0".repeat(64),
  createdByUserId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  metadata: {},
};

function createHarness(get: StorageDriver["get"]) {
  const close = vi.fn();
  const driver = {
    get,
    close,
  } as unknown as StorageDriver;
  const db = {
    query: {
      mediaObjects: {
        findFirst: vi.fn().mockResolvedValue(mediaObject),
      },
    },
  } as unknown as LoxepDb;
  const backends = {
    resolveDriver: vi.fn().mockResolvedValue(driver),
  } as unknown as StorageBackendsService;
  return {
    close,
    media: createMediaService({ db, backends }),
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("media read driver lifecycle", () => {
  it("keeps the driver open until the body is consumed, then closes it once", async () => {
    const payload = Buffer.from("payload");
    const { close, media } = createHarness(async () =>
      Readable.from([payload]),
    );

    const { body } = await media.read(mediaObject.id);
    expect(close).not.toHaveBeenCalled();

    expect(await collect(body)).toEqual(payload);
    await nextTurn();
    expect(close).toHaveBeenCalledTimes(1);

    body.destroy();
    await nextTurn();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the driver once when an unread web body is cancelled", async () => {
    const source = new Readable({ read() {} });
    const { close, media } = createHarness(async () => source);
    const { body } = await media.read(mediaObject.id);
    const reader = Readable.toWeb(body).getReader();

    expect(close).not.toHaveBeenCalled();
    await reader.cancel("response abandoned");
    await nextTurn();

    expect(body.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the driver once when the body errors", async () => {
    const source = new Readable({ read() {} });
    const { close, media } = createHarness(async () => source);
    const { body } = await media.read(mediaObject.id);
    const observedError = new Promise<Error>((resolve) => {
      body.once("error", resolve);
    });
    const failure = new Error("read failed");

    body.destroy(failure);

    await expect(observedError).resolves.toBe(failure);
    await nextTurn();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the driver once when obtaining the body fails", async () => {
    const failure = new Error("get failed");
    const { close, media } = createHarness(async () => {
      throw failure;
    });

    await expect(media.read(mediaObject.id)).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
