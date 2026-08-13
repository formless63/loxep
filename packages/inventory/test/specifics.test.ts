/**
 * Typed key/value product specifics (M3, loxep-dgf.3) — the multi-value
 * shape, the `value_numeric` shadow, and upsert-on-natural-key idempotency,
 * against real PostgreSQL so the `unique(inventory_item_id, name, value)`
 * constraint and its `ON CONFLICT`-free race are exercised for real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InventoryNotFoundError } from "../src/errors.ts";
import { createItemsService } from "../src/items.ts";
import { createSpecificsService } from "../src/specifics.ts";
import { createMigratedScratchDb } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("inventory item specifics", () => {
  let scratch: ScratchDb;
  let itemId = "";

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_specifics");
    const item = await createItemsService({ db: scratch.handle.db }).create({
      label: "a film camera",
      currency: "USD",
    });
    itemId = item.id;
  });

  afterAll(async () => {
    await scratch.close();
  });

  const specifics = () => createSpecificsService({ db: scratch.handle.db });

  it("sets a specific and derives value_numeric only when the value parses cleanly", async () => {
    const brand = await specifics().set({
      inventoryItemId: itemId,
      name: "Brand",
      value: "Nikon",
    });
    expect(brand.created).toBe(true);
    expect(brand.specific.valueNumeric).toBeNull();

    const shutterCount = await specifics().set({
      inventoryItemId: itemId,
      name: "Shutter Count",
      value: "4200",
      unit: "actuations",
    });
    expect(shutterCount.specific.valueNumeric).toBe("4200.000000");

    // "PSA 9.8 (qualified)" is a different claim from a bare "9.8" — the
    // verbatim string survives even though it does not parse as a number.
    const grade = await specifics().set({
      inventoryItemId: itemId,
      name: "Grade",
      value: "9.8 (qualified)",
    });
    expect(grade.specific.value).toBe("9.8 (qualified)");
    expect(grade.specific.valueNumeric).toBeNull();
  });

  it("multi-value falls out of the key: the same name may have several rows", async () => {
    await specifics().set({ inventoryItemId: itemId, name: "Color", value: "Black" });
    await specifics().set({ inventoryItemId: itemId, name: "Color", value: "Chrome" });
    const rows = await specifics().list(itemId);
    const colors = rows.filter((row) => row.name === "Color").map((row) => row.value);
    expect(colors).toEqual(expect.arrayContaining(["Black", "Chrome"]));
  });

  it("upserts on the natural key instead of erroring on a repeat set", async () => {
    const first = await specifics().set({
      inventoryItemId: itemId,
      name: "Condition",
      value: "Excellent",
      source: "manual",
    });
    expect(first.created).toBe(true);

    const second = await specifics().set({
      inventoryItemId: itemId,
      name: "Condition",
      value: "Excellent",
      source: "channel_suggested",
      unit: null,
    });
    expect(second.created).toBe(false);
    expect(second.specific.id).toBe(first.specific.id);
    expect(second.specific.source).toBe("channel_suggested");
  });

  it("removes a specific by its natural key", async () => {
    await specifics().set({ inventoryItemId: itemId, name: "Lens Mount", value: "F-mount" });
    await specifics().remove({ inventoryItemId: itemId, name: "Lens Mount", value: "F-mount" });
    const rows = await specifics().list(itemId);
    expect(rows.find((row) => row.name === "Lens Mount")).toBeUndefined();
  });

  it("refuses a specific on an item that does not exist", async () => {
    await expect(
      specifics().set({
        inventoryItemId: "00000000-0000-0000-0000-000000000000",
        name: "Brand",
        value: "Nikon",
      }),
    ).rejects.toThrow(InventoryNotFoundError);
  });
});
