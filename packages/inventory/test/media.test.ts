/**
 * Item-image gallery links over `media_links` (M3, loxep-dgf.3) — the
 * ordering rule (primary = lowest `sort_order`, `purpose` never gains a
 * `'primary'` value), reorder writing only `sort_order`, and the 0004
 * natural-key idempotency, against real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mediaObjects, storageBackends } from "@loxep/db/schema";
import { InventoryNotFoundError } from "../src/errors.ts";
import { createItemsService } from "../src/items.ts";
import { createInventoryMediaService } from "../src/media.ts";
import { createMigratedScratchDb } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

async function seedMediaObject(scratch: ScratchDb, filename: string): Promise<string> {
  const db = scratch.handle.db;
  const backendRows = await db
    .insert(storageBackends)
    .values({ name: "test-local", driver: "local" })
    .returning({ id: storageBackends.id });
  const backendId = backendRows[0]?.id;
  if (backendId === undefined) throw new Error("storage backend insert returned no row");

  const objectRows = await db
    .insert(mediaObjects)
    .values({
      storageBackendId: backendId,
      storageKey: `test/${filename}`,
      originalFilename: filename,
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      sha256: "0".repeat(64),
      metadata: { purpose: "item_image" },
    })
    .returning({ id: mediaObjects.id });
  const objectId = objectRows[0]?.id;
  if (objectId === undefined) throw new Error("media object insert returned no row");
  return objectId;
}

describe("inventory item media gallery", () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_media");
  });

  afterAll(async () => {
    await scratch.close();
  });

  const media = () => createInventoryMediaService({ db: scratch.handle.db });

  /** Each test gets its own item so gallery ordering assertions never see a sibling test's rows. */
  async function seedItem(label: string): Promise<string> {
    const item = await createItemsService({ db: scratch.handle.db }).create({
      label,
      currency: "USD",
    });
    return item.id;
  }

  it("attaches into 'gallery' by default and assigns increasing sort_order", async () => {
    const itemId = await seedItem("a camera body");
    const first = await seedMediaObject(scratch, "front.jpg");
    const second = await seedMediaObject(scratch, "back.jpg");

    const firstLink = await media().attach({ inventoryItemId: itemId, mediaObjectId: first });
    expect(firstLink.created).toBe(true);
    expect(firstLink.link.purpose).toBe("gallery");
    expect(firstLink.link.sortOrder).toBe(0);

    const secondLink = await media().attach({ inventoryItemId: itemId, mediaObjectId: second });
    expect(secondLink.link.sortOrder).toBe(1);

    const gallery = await media().list(itemId, "gallery");
    expect(gallery.map((link) => link.mediaObjectId)).toEqual([first, second]);
    // Primary is a SORT, not a flag: the first row IS the primary image.
    expect(gallery[0]?.mediaObjectId).toBe(first);
  });

  it("reorder writes only sort_order and can move a photo to primary", async () => {
    const itemId = await seedItem("a second camera body");
    const front = await seedMediaObject(scratch, "reorder-front.jpg");
    const flaw = await seedMediaObject(scratch, "reorder-flaw.jpg");
    await media().attach({ inventoryItemId: itemId, mediaObjectId: front, purpose: "gallery" });
    await media().attach({ inventoryItemId: itemId, mediaObjectId: flaw, purpose: "gallery" });

    const before = await media().list(itemId, "gallery");
    const flawLink = before.find((link) => link.mediaObjectId === flaw);
    const frontLink = before.find((link) => link.mediaObjectId === front);
    expect(flawLink?.sortOrder).not.toBe(0);

    // The simple up/down swap the M3 gallery UI performs: exchange the two
    // adjacent sort_order values, both through reorder() — never `purpose`.
    await media().reorder({
      inventoryItemId: itemId,
      mediaObjectId: front,
      purpose: "gallery",
      sortOrder: flawLink?.sortOrder ?? 0,
    });
    const reordered = await media().reorder({
      inventoryItemId: itemId,
      mediaObjectId: flaw,
      purpose: "gallery",
      sortOrder: frontLink?.sortOrder ?? 0,
    });
    expect(reordered[0]?.mediaObjectId).toBe(flaw);
    // Purpose is untouched by a reorder.
    expect(reordered[0]?.purpose).toBe("gallery");
  });

  it("purposes are independent link rows sharing the object, per the 0004 key", async () => {
    const itemId = await seedItem("a third camera body");
    const shared = await seedMediaObject(scratch, "shared-receipt.jpg");
    await media().attach({
      inventoryItemId: itemId,
      mediaObjectId: shared,
      purpose: "gallery",
    });
    await media().attach({
      inventoryItemId: itemId,
      mediaObjectId: shared,
      purpose: "supporting_document",
    });
    const gallery = await media().list(itemId, "gallery");
    const documents = await media().list(itemId, "supporting_document");
    expect(gallery.some((link) => link.mediaObjectId === shared)).toBe(true);
    expect(documents.some((link) => link.mediaObjectId === shared)).toBe(true);

    // Detaching one purpose leaves the other fact intact.
    await media().detach({ inventoryItemId: itemId, mediaObjectId: shared, purpose: "gallery" });
    const galleryAfter = await media().list(itemId, "gallery");
    const documentsAfter = await media().list(itemId, "supporting_document");
    expect(galleryAfter.some((link) => link.mediaObjectId === shared)).toBe(false);
    expect(documentsAfter.some((link) => link.mediaObjectId === shared)).toBe(true);
  });

  it("attaching the identical (object, item, purpose) fact twice is idempotent", async () => {
    const itemId = await seedItem("a fourth camera body");
    const object = await seedMediaObject(scratch, "idempotent.jpg");
    const first = await media().attach({
      inventoryItemId: itemId,
      mediaObjectId: object,
      purpose: "condition_evidence",
    });
    const second = await media().attach({
      inventoryItemId: itemId,
      mediaObjectId: object,
      purpose: "condition_evidence",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const list = await media().list(itemId, "condition_evidence");
    expect(list.filter((link) => link.mediaObjectId === object)).toHaveLength(1);
  });

  it("refuses to attach an unknown media object", async () => {
    const itemId = await seedItem("a fifth camera body");
    await expect(
      media().attach({
        inventoryItemId: itemId,
        mediaObjectId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow(InventoryNotFoundError);
  });
});
