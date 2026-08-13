/**
 * M3 inventory enrichment (loxep-dgf.3): the descriptive `update()`, the
 * `setSaleMode()` declaration, and the `partOut()` verb — against real
 * PostgreSQL so the migration's `CHECK`s (package weight, the
 * `num_nonnulls` dimension guard, `sale_mode`) are exercised for real, not
 * just the service's own pre-validation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InventoryConflictError,
  InventoryImmutableFactError,
  InventoryValidationError,
} from "../src/errors.ts";
import { createItemsService } from "../src/items.ts";
import { createMigratedScratchDb } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("inventory item enrichment (M3)", () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_enrichment");
  });

  afterAll(async () => {
    await scratch.close();
  });

  const items = () => createItemsService({ db: scratch.handle.db });

  /* ------------------------------------------------------------ defaults */

  it("defaults a new item to sale_mode 'unit' with every enrichment column null", async () => {
    const item = await items().create({ label: "a brass lamp", currency: "USD" });
    expect(item.saleMode).toBe("unit");
    expect(item.description).toBeNull();
    expect(item.packageWeightGrams).toBeNull();
    expect(item.packageLengthMm).toBeNull();
  });

  /* ------------------------------------------------------------- update() */

  it("sets and clears description and package dimensions/weight", async () => {
    const item = await items().create({ label: "a camera body", currency: "USD" });
    const enriched = await items().update({
      inventoryItemId: item.id,
      description: "A well-loved film camera.",
      packageWeightGrams: "850",
      packageLengthMm: "200",
      packageWidthMm: "150",
      packageHeightMm: "100",
    });
    expect(enriched.description).toBe("A well-loved film camera.");
    expect(enriched.packageWeightGrams).toBe("850.000000");
    expect(enriched.packageLengthMm).toBe("200.000000");

    // A field left `undefined` is unchanged; a field set to `null` clears it.
    const partial = await items().update({
      inventoryItemId: item.id,
      description: null,
    });
    expect(partial.description).toBeNull();
    expect(partial.packageWeightGrams).toBe("850.000000");
  });

  it("refuses a half-entered package box (two of three dimensions)", async () => {
    const item = await items().create({ label: "a mystery box", currency: "USD" });
    await expect(
      items().update({
        inventoryItemId: item.id,
        packageLengthMm: "200",
        packageWidthMm: "150",
      }),
    ).rejects.toThrow(InventoryValidationError);
  });

  it("refuses a half-entered box across two calls (existing dims plus one new one)", async () => {
    // The migration's CHECK is num_nonnulls(...) in (0, 3) on the MERGED row,
    // not the single call's payload — update() must validate against the
    // item as it will exist after the write, not just the fields it was given.
    const item = await items().create({ label: "a slow unboxing", currency: "USD" });
    await items().update({
      inventoryItemId: item.id,
      packageLengthMm: "200",
      packageWidthMm: "150",
      packageHeightMm: "100",
    });
    await expect(
      items().update({ inventoryItemId: item.id, packageLengthMm: null }),
    ).rejects.toThrow(InventoryValidationError);
  });

  it("refuses a non-positive package weight", async () => {
    const item = await items().create({ label: "a feather", currency: "USD" });
    await expect(
      items().update({ inventoryItemId: item.id, packageWeightGrams: "0" }),
    ).rejects.toThrow(InventoryValidationError);
  });

  /* -------------------------------------------------------- setSaleMode() */

  it("declares how an item is going to be sold", async () => {
    const item = await items().create({ label: "forty Hot Wheels", currency: "USD" });
    const lot = await items().setSaleMode({ inventoryItemId: item.id, saleMode: "lot" });
    expect(lot.saleMode).toBe("lot");
  });

  it("the sale mode enum structurally refuses 'parted_out' as an input", async () => {
    const item = await items().create({ label: "not parted out yet", currency: "USD" });
    await expect(
      items().setSaleMode({
        inventoryItemId: item.id,
        // @ts-expect-error -- 'parted_out' is deliberately excluded from the
        // settable union; only partOut() may write it.
        saleMode: "parted_out",
      }),
    ).rejects.toThrow(InventoryValidationError);
  });

  it("refuses to change the sale mode of an item that has already been parted out", async () => {
    const parent = await items().create({
      label: "a broken laptop",
      currency: "USD",
      quantity: "1",
      landedCostAmount: "100",
      acquisitionCostAmount: "80",
    });
    await items().partOut({
      inventoryItemId: parent.id,
      children: [{ label: "screen" }, { label: "keyboard" }],
    });
    await expect(
      items().setSaleMode({ inventoryItemId: parent.id, saleMode: "unit" }),
    ).rejects.toThrow(InventoryImmutableFactError);
  });

  /* ------------------------------------------------------------ partOut() */

  it("breaks a unit into children, conserves basis exactly, and depletes the parent", async () => {
    const parent = await items().create({
      label: "a parts-donor laptop",
      currency: "USD",
      quantity: "1",
      landedCostAmount: "100.01",
      acquisitionCostAmount: "70.01",
    });
    expect(parent.quantityOnHand).toBe("1.000000");

    const result = await items().partOut({
      inventoryItemId: parent.id,
      children: [
        { label: "screen", weight: "2" },
        { label: "keyboard", weight: "1" },
        { label: "battery", weight: "1" },
      ],
    });

    expect(result.parent.saleMode).toBe("parted_out");
    expect(result.parent.quantityOnHand).toBe("0.000000");
    expect(result.parent.status).toBe("depleted");
    expect(result.parent.landedCostAmount).toBe("0.000000");
    expect(result.parent.acquisitionCostAmount).toBe("0.000000");

    expect(result.children).toHaveLength(3);
    for (const child of result.children) {
      expect(child.originItemId).toBe(parent.id);
      expect(child.status).toBe("intake");
      expect(child.quantityOnHand).toBe(child.quantity);
    }

    // Largest-remainder distribution: shares sum EXACTLY to the parent's
    // original basis, with no cent invented or stranded.
    const landedSum = result.children.reduce(
      (sum, child) => sum + Number(child.landedCostAmount),
      0,
    );
    const goodsSum = result.children.reduce(
      (sum, child) => sum + Number(child.acquisitionCostAmount),
      0,
    );
    expect(landedSum.toFixed(6)).toBe("100.010000");
    expect(goodsSum.toFixed(6)).toBe("70.010000");

    // The parent's depletion is a real ledger row, not a status flip.
    const consumption = await scratch.handle.db.execute(
      `select movement_kind, quantity::text as q, reason_code
         from inventory_movements
        where inventory_item_id = '${parent.id}' and movement_kind = 'consumption'`,
    );
    expect(consumption.rows).toHaveLength(1);
    expect(consumption.rows[0]?.["q"]).toBe("-1.000000");
    expect(consumption.rows[0]?.["reason_code"]).toBe("part_out");
  });

  it("refuses to part out an item with no stock on hand", async () => {
    const parent = await items().create({
      label: "already sold out",
      currency: "USD",
      receive: false,
    });
    expect(parent.quantityOnHand).toBe("0.000000");
    await expect(
      items().partOut({
        inventoryItemId: parent.id,
        children: [{ label: "a piece" }],
      }),
    ).rejects.toThrow(InventoryConflictError);
  });

  it("refuses to part out an item twice", async () => {
    const parent = await items().create({
      label: "double part-out attempt",
      currency: "USD",
    });
    await items().partOut({
      inventoryItemId: parent.id,
      children: [{ label: "piece one" }],
    });
    await expect(
      items().partOut({
        inventoryItemId: parent.id,
        children: [{ label: "piece two" }],
      }),
    ).rejects.toThrow(InventoryImmutableFactError);
  });
});
