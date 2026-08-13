/**
 * Inventory items: location moves, splits, and the entity-transfer rule that
 * keeps Phase 4 consistent with Phase 3's "attribution, once written, is never
 * rewritten".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InventoryConflictError, InventoryValidationError } from "../src/errors.ts";
import { createItemsService } from "../src/items.ts";
import { createLocationsService } from "../src/locations.ts";
import { createMovementsService } from "../src/movements.ts";
import { createMigratedScratchDb, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("inventory items", () => {
  let scratch: ScratchDb;
  let personalId = "";
  let llcId = "";
  let garageId = "";
  let shelfId = "";
  let binId = "";

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_items");
    personalId = await seedEntity(scratch, "Personal", "sole_proprietor");
    llcId = await seedEntity(scratch, "Resale LLC", "llc");
    const locations = createLocationsService({ db: scratch.handle.db });
    const home = await locations.create({
      code: "HOME",
      name: "Home",
      kind: "site",
    });
    const garage = await locations.create({
      code: "GARAGE",
      name: "Garage",
      kind: "room",
      parentLocationId: home.id,
    });
    garageId = garage.id;
    const shelf = await locations.create({
      code: "SHELF-3",
      name: "Shelf 3",
      kind: "shelf",
      parentLocationId: garage.id,
    });
    shelfId = shelf.id;
    const bin = await locations.create({
      code: "BIN-12",
      name: "Bin 12",
      kind: "bin",
      parentLocationId: shelf.id,
    });
    binId = bin.id;
  });

  afterAll(async () => {
    await scratch.close();
  });

  const items = () => createItemsService({ db: scratch.handle.db });
  const movements = () => createMovementsService({ db: scratch.handle.db });

  /* ------------------------------------------------------------ locations */

  it("builds the path cache as a slash-joined ancestor chain", async () => {
    const locations = createLocationsService({ db: scratch.handle.db });
    const bin = await locations.get(binId);
    expect(bin.path).toBe("HOME/GARAGE/SHELF-3/BIN-12");
    expect(bin.depth).toBe(3);
    const subtree = await locations.subtree(garageId);
    expect(subtree.map((row) => row.code)).toEqual([
      "GARAGE",
      "SHELF-3",
      "BIN-12",
    ]);
  });

  it("refuses a re-parent that would create a cycle", async () => {
    const locations = createLocationsService({ db: scratch.handle.db });
    await expect(
      locations.setParent({ locationId: garageId, parentLocationId: binId }),
    ).rejects.toThrow(InventoryConflictError);
  });

  it("reports no path drift after normal operation", async () => {
    const locations = createLocationsService({ db: scratch.handle.db });
    const result = await locations.reconcilePaths();
    expect(result.mismatched).toHaveLength(0);
  });

  /* ------------------------------------------------------- location moves */

  it("moves a whole item with a transfer pair on the same row", async () => {
    const item = await items().create({
      label: "a brass lamp",
      currency: "USD",
      quantity: "1",
      locationId: shelfId,
    });
    const result = await items().moveToLocation({
      inventoryItemId: item.id,
      toLocationId: binId,
    });

    expect(result.destinationItem.id).toBe(item.id);
    expect(result.destinationItem.locationId).toBe(binId);
    // Net zero on-hand: the two halves cancel, which is what makes per-location
    // balance a plain sum with a where.
    expect(result.destinationItem.quantityOnHand).toBe("1.000000");

    const pair = await scratch.handle.db.execute(
      `select movement_kind, quantity::text as q, location_id::text as loc
         from inventory_movements
        where transfer_group_id = '${result.transferGroupId}'
        order by movement_kind`,
    );
    expect(pair.rows).toHaveLength(2);
    expect(pair.rows.map((row) => row["movement_kind"])).toEqual([
      "transfer_in",
      "transfer_out",
    ]);
    expect(pair.rows[0]?.["loc"]).toBe(binId);
    expect(pair.rows[1]?.["loc"]).toBe(shelfId);
    expect(pair.rows[0]?.["q"]).toBe("1.000000");
    expect(pair.rows[1]?.["q"]).toBe("-1.000000");
  });

  it("splits the row on a partial move and divides the basis", async () => {
    const item = await items().create({
      label: "a case of 100 phone cases",
      currency: "USD",
      quantity: "100",
      landedCostAmount: "250",
      locationId: shelfId,
    });
    const result = await items().moveToLocation({
      inventoryItemId: item.id,
      toLocationId: binId,
      quantity: "40",
    });

    expect(result.destinationItem.id).not.toBe(item.id);
    expect(result.destinationItem.originItemId).toBe(item.id);
    expect(result.destinationItem.quantity).toBe("40.000000");
    expect(result.destinationItem.quantityOnHand).toBe("40.000000");
    expect(result.destinationItem.landedCostAmount).toBe("100.000000");
    expect(result.sourceItem.quantityOnHand).toBe("60.000000");
    expect(result.sourceItem.landedCostAmount).toBe("150.000000");
    // Neither half invented or lost a cent.
    expect(
      Number(result.sourceItem.landedCostAmount) +
        Number(result.destinationItem.landedCostAmount),
    ).toBe(250);
  });

  it("refuses to move more than is on hand", async () => {
    const item = await items().create({
      label: "one lamp",
      currency: "USD",
      quantity: "1",
      locationId: shelfId,
    });
    await expect(
      items().moveToLocation({
        inventoryItemId: item.id,
        toLocationId: binId,
        quantity: "3",
      }),
    ).rejects.toThrow(InventoryConflictError);
  });

  /* -------------------------------------------------- entity transfer rule */

  it("transfers ownership WITHOUT rewriting the original's attribution", async () => {
    const item = await items().create({
      label: "goods contributed to the LLC",
      currency: "USD",
      quantity: "1",
      landedCostAmount: "60",
      economicEntityId: personalId,
      locationId: shelfId,
    });
    expect(item.economicEntityId).toBe(personalId);
    expect(item.entityAttributionSource).toBe("manual");

    const result = await items().transferEntity({
      inventoryItemId: item.id,
      toEconomicEntityId: llcId,
      basisTreatment: "carryover",
    });

    // The rule: the ORIGINAL row keeps its entity, its basis, and its history.
    expect(result.sourceItem.id).toBe(item.id);
    expect(result.sourceItem.economicEntityId).toBe(personalId);
    expect(result.sourceItem.quantityOnHand).toBe("0.000000");
    expect(result.sourceItem.landedCostAmount).toBe("0.000000");

    // The RECEIVING row is new, owned by the receiving entity, and points back.
    expect(result.destinationItem.id).not.toBe(item.id);
    expect(result.destinationItem.economicEntityId).toBe(llcId);
    expect(result.destinationItem.originItemId).toBe(item.id);
    expect(result.destinationItem.landedCostAmount).toBe("60.000000");
    expect(result.destinationItem.quantityOnHand).toBe("1.000000");

    // And the ledger contains the transfer as an EVENT, so "when did this leave
    // personal ownership" is a query.
    const pair = await scratch.handle.db.execute(
      `select movement_kind, reason_code, inventory_item_id::text as item
         from inventory_movements
        where transfer_group_id = '${result.transferGroupId}'
        order by movement_kind`,
    );
    expect(pair.rows).toHaveLength(2);
    expect(pair.rows.every((row) => row["reason_code"] === "entity_transfer"))
      .toBe(true);
  });

  it("restates basis at fair market value only when told to, and only with a value", async () => {
    const item = await items().create({
      label: "personal property converted to stock",
      currency: "USD",
      quantity: "1",
      landedCostAmount: "500",
      economicEntityId: personalId,
    });
    await expect(
      items().transferEntity({
        inventoryItemId: item.id,
        toEconomicEntityId: llcId,
        basisTreatment: "fair_market_value",
      }),
    ).rejects.toThrow(InventoryValidationError);

    const result = await items().transferEntity({
      inventoryItemId: item.id,
      toEconomicEntityId: llcId,
      basisTreatment: "fair_market_value",
      fairMarketValueAmount: "120",
    });
    expect(result.destinationItem.landedCostAmount).toBe("120.000000");
    // The original's basis is untouched history, not netted away.
    expect(result.sourceItem.landedCostAmount).toBe("0.000000");
  });

  it("refuses a transfer to the entity that already owns the item", async () => {
    const item = await items().create({
      label: "already the LLC's",
      currency: "USD",
      economicEntityId: llcId,
    });
    await expect(
      items().transferEntity({
        inventoryItemId: item.id,
        toEconomicEntityId: llcId,
        basisTreatment: "carryover",
      }),
    ).rejects.toThrow(InventoryValidationError);
  });

  /* ---------------------------------------------------- bulk re-attribution */

  it("bulk re-attribution never rewrites a manual row", async () => {
    const chosen = await items().create({
      label: "an item a human attributed",
      currency: "USD",
      economicEntityId: personalId,
    });
    const defaulted = await items().create({
      label: "an item that took the installation default",
      currency: "USD",
      installationDefaultEntityId: personalId,
    });
    const unattributed = await items().create({
      label: "an item nobody attributed",
      currency: "USD",
    });
    expect(chosen.entityAttributionSource).toBe("manual");
    expect(defaulted.entityAttributionSource).toBe("installation_default");
    expect(unattributed.entityAttributionSource).toBe("unattributed");

    await items().reattribute({ economicEntityId: llcId });

    expect((await items().get(chosen.id)).economicEntityId).toBe(personalId);
    expect((await items().get(defaulted.id)).economicEntityId).toBe(llcId);
    expect((await items().get(unattributed.id)).economicEntityId).toBe(llcId);
    // A rewritten row becomes `manual`, so a second bulk run cannot move it
    // again.
    expect((await items().get(defaulted.id)).entityAttributionSource).toBe(
      "manual",
    );
  });

  /* -------------------------------------------------- condition and grading */

  it("records condition and grading, and refuses a grade with no authority", async () => {
    const item = await items().create({
      label: "a graded card",
      currency: "USD",
    });
    const graded = await items().setCondition({
      inventoryItemId: item.id,
      conditionCode: "like_new",
      gradingAuthority: "PSA",
      gradeLabel: "PSA 9",
      gradeNumeric: "9.0",
      certificateNumber: "12345678",
    });
    expect(graded.conditionCode).toBe("like_new");
    expect(graded.gradeLabel).toBe("PSA 9");
    // The label survives verbatim beside the numeric, because half-grades and
    // qualifiers do not survive a lossy numeric conversion.
    expect(graded.gradeNumeric).toBe("9.0");

    const other = await items().create({ label: "ungraded", currency: "USD" });
    await expect(
      items().setCondition({
        inventoryItemId: other.id,
        gradeLabel: "VG+",
      }),
    ).rejects.toThrow(InventoryValidationError);
  });

  /* ------------------------------------------------------- intake review */

  it("completes intake review (intake -> available) and refuses when the item is not in intake", async () => {
    const item = await items().create({
      label: "a boxed lot find",
      currency: "USD",
    });
    // The create-time default receipt movement must NOT have promoted this
    // past intake — the bug `deriveItemStatus`'s intake-preservation rule
    // fixes (found live by the first `/inventory` e2e run).
    expect(item.status).toBe("intake");

    const reviewed = await items().completeIntakeReview(item.id);
    expect(reviewed.status).toBe("available");
    // Quantities are untouched: review is a status-only transition, never a
    // movement — quantities and movements remain the sole authority.
    expect(reviewed.quantityOnHand).toBe(item.quantityOnHand);

    await expect(items().completeIntakeReview(item.id)).rejects.toThrow(
      InventoryValidationError,
    );
  });

  it("leaves the ledger and the cache in agreement after every operation above", async () => {
    const result = await movements().reconcile();
    expect(result.drift).toHaveLength(0);
  });
});
