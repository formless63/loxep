/**
 * Acquisitions and the lot cost allocation engine.
 *
 * Every expected figure here is hand-computed. The engine's contract is that
 * the allocated shares SUM TO the pool exactly with no residual cent left over
 * or invented, so most assertions check a total as well as the parts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAcquisitionsService } from "../src/acquisitions.ts";
import {
  InventoryConflictError,
  InventoryImmutableFactError,
  InventoryValidationError,
} from "../src/errors.ts";
import { createItemsService } from "../src/items.ts";
import { createMovementsService } from "../src/movements.ts";
import { costReconciliation, openLots } from "../src/profitability.ts";
import { createMigratedScratchDb, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("acquisitions and cost allocation", () => {
  let scratch: ScratchDb;
  let entityId = "";

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_acquisitions");
    entityId = await seedEntity(scratch, "Resale LLC", "llc");
  });

  afterAll(async () => {
    await scratch.close();
  });

  const acquisitions = () => createAcquisitionsService({ db: scratch.handle.db });
  const items = () => createItemsService({ db: scratch.handle.db });

  it("generates a scannable reference code and attributes the lot", async () => {
    const lot = await acquisitions().create({
      title: "estate auction, box of glassware",
      sourceKind: "auction_lot",
      currency: "USD",
      economicEntityId: entityId,
      acquiredAt: new Date("2026-02-14T10:00:00Z"),
    });
    expect(lot.referenceCode).toMatch(/^ACQ-2026-\d{4}$/);
    expect(lot.economicEntityId).toBe(entityId);
    expect(lot.entityAttributionSource).toBe("manual");
    expect(lot.costAllocationStatus).toBe("pending");
  });

  it("falls back to the installation default, and marks it as a default", async () => {
    const lot = await acquisitions().create({
      title: "thrift run",
      sourceKind: "thrift_retail",
      currency: "USD",
      installationDefaultEntityId: entityId,
    });
    expect(lot.economicEntityId).toBe(entityId);
    expect(lot.entityAttributionSource).toBe("installation_default");
  });

  it("records an unattributed lot rather than refusing it", async () => {
    const lot = await acquisitions().create({
      title: "found in the attic",
      sourceKind: "found_stock",
      currency: "USD",
    });
    expect(lot.economicEntityId).toBeNull();
    expect(lot.entityAttributionSource).toBe("unattributed");
  });

  /* ------------------------------------------------------ relative_value */

  it("allocates a lot by relative value with no residual cent", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "$250 auction lot, 3 items",
      sourceKind: "auction_lot",
      currency: "USD",
      costAllocationBasis: "relative_value",
      economicEntityId: entityId,
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "250",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "buyers_premium",
      costClass: "ancillary",
      amount: "45",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "fuel_mileage",
      costClass: "ancillary",
      amount: "18",
      capitalize: false, // OQ10: kept, attached, excluded from basis.
    });

    const created = [];
    for (const [label, value] of [
      ["Pyrex bowl", "100"],
      ["brass lamp", "60"],
      ["box of forks", "40"],
    ] as const) {
      created.push(
        await items().create({
          label,
          currency: "USD",
          acquisitionId: lot.id,
          estimatedValueAmount: value,
        }),
      );
    }

    const outcome = await service.allocateCosts({
      acquisitionId: lot.id,
      finalize: true,
    });

    // Pool is 295 (250 goods + 45 ancillary); the mileage row is NOT in it.
    expect(outcome.lotPoolAmount).toBe("295.000000");
    expect(outcome.allocatablePoolAmount).toBe("295.000000");
    expect(outcome.unallocatedAmount).toBe("0.000000");
    expect(outcome.costAllocationStatus).toBe("final");

    // Goods 250 by 100/60/40 -> 125 / 75 / 50.
    // Ancillary 45 by 100/60/40 -> 22.50 / 13.50 / 9.00.
    expect(outcome.allocations.map((a) => a.landedCostAmount)).toEqual([
      "147.500000",
      "88.500000",
      "59.000000",
    ]);
    expect(outcome.allocations.map((a) => a.acquisitionCostAmount)).toEqual([
      "125.000000",
      "75.000000",
      "50.000000",
    ]);
    const total = outcome.allocations.reduce(
      (sum, a) => sum + Number(a.landedCostAmount),
      0,
    );
    expect(total).toBe(295);

    // And the landed cost report separates capitalized from not.
    const landed = await service.landedCost(lot.id);
    expect(landed).toEqual([
      {
        currency: "USD",
        goodsAmount: "250.000000",
        ancillaryAmount: "45.000000",
        landedCostAmount: "295.000000",
        nonCapitalizedAmount: "18.000000",
      },
    ]);

    // The invariant the design refused to make a CHECK now holds, and the
    // reconciliation report says so by finding nothing.
    const reconciliation = await costReconciliation(scratch.handle.db);
    expect(
      reconciliation.filter((row) => row.acquisitionId === lot.id),
    ).toHaveLength(0);
    void created;
  });

  it("distributes an indivisible remainder with largest-remainder rounding", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "a lot that does not divide by three",
      sourceKind: "estate_sale",
      currency: "USD",
      costAllocationBasis: "equal",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "100",
    });
    for (const label of ["a", "b", "c"]) {
      await items().create({
        label,
        currency: "USD",
        acquisitionId: lot.id,
      });
    }
    const outcome = await service.allocateCosts({ acquisitionId: lot.id });
    expect(outcome.allocations.map((a) => a.landedCostAmount)).toEqual([
      "33.333334",
      "33.333333",
      "33.333333",
    ]);
    const total = outcome.allocations.reduce(
      (sum, a) => sum + Number(a.landedCostAmount),
      0,
    );
    expect(total).toBeCloseTo(100, 6);
  });

  it("weights `equal` by quantity, so a case of 100 takes 100 units of cost", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "supplies",
      sourceKind: "wholesale_purchase",
      currency: "USD",
      costAllocationBasis: "equal",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "101",
    });
    await items().create({
      label: "case of 100 mailers",
      currency: "USD",
      acquisitionId: lot.id,
      quantity: "100",
    });
    await items().create({
      label: "one tape gun",
      currency: "USD",
      acquisitionId: lot.id,
      quantity: "1",
    });
    const outcome = await service.allocateCosts({ acquisitionId: lot.id });
    expect(outcome.allocations.map((a) => a.landedCostAmount)).toEqual([
      "100.000000",
      "1.000000",
    ]);
  });

  /* --------------------------------------------------------- direct basis */

  it("books item-scoped costs directly and refuses a lot pool under `direct`", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "retail arbitrage receipt",
      sourceKind: "retail_arbitrage",
      currency: "USD",
      costAllocationBasis: "direct",
    });
    const first = await items().create({
      label: "clearance blender",
      currency: "USD",
      acquisitionId: lot.id,
    });
    const second = await items().create({
      label: "clearance kettle",
      currency: "USD",
      acquisitionId: lot.id,
    });
    await service.addCost({
      acquisitionId: lot.id,
      inventoryItemId: first.id,
      costType: "goods",
      costClass: "goods",
      amount: "19.99",
    });
    await service.addCost({
      acquisitionId: lot.id,
      inventoryItemId: second.id,
      costType: "goods",
      costClass: "goods",
      amount: "8.50",
    });

    const outcome = await service.allocateCosts({ acquisitionId: lot.id });
    expect(outcome.lotPoolAmount).toBe("0.000000");
    expect(outcome.allocations.map((a) => a.landedCostAmount)).toEqual([
      "19.990000",
      "8.500000",
    ]);

    // Adding a lot-scoped cost under `direct` is a contradiction, not a rounding
    // problem, and the engine says so.
    await service.addCost({
      acquisitionId: lot.id,
      costType: "sales_tax",
      costClass: "ancillary",
      amount: "2.28",
    });
    await expect(
      service.allocateCosts({ acquisitionId: lot.id }),
    ).rejects.toThrow(InventoryConflictError);
  });

  /* ---------------------------------------------------- basis freeze (OQ5) */

  it("re-allocates only the unlocked remainder once an item has sold", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "a lot half sold before it was finished",
      sourceKind: "liquidation_pallet",
      currency: "USD",
      costAllocationBasis: "equal",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "300",
    });
    const sold = await items().create({
      label: "the one that sold first",
      currency: "USD",
      acquisitionId: lot.id,
    });
    const kept = await items().create({
      label: "still on the shelf",
      currency: "USD",
      acquisitionId: lot.id,
    });
    await service.allocateCosts({ acquisitionId: lot.id });
    expect((await items().get(sold.id)).landedCostAmount).toBe("150.000000");

    // The first sale freezes that item's basis.
    await createMovementsService({ db: scratch.handle.db }).record({
      inventoryItemId: sold.id,
      movementKind: "depletion_sale",
      quantity: "-1",
      deduplicationKey: "freeze-lot:1",
    });
    expect((await items().get(sold.id)).costBasisLockedAt).not.toBeNull();

    // A third item is unpacked later; only the UNLOCKED remainder moves.
    const found = await items().create({
      label: "found at the bottom of the pallet",
      currency: "USD",
      acquisitionId: lot.id,
    });
    const outcome = await service.allocateCosts({ acquisitionId: lot.id });
    expect(outcome.lockedAmount).toBe("150.000000");
    expect(outcome.allocatablePoolAmount).toBe("150.000000");
    expect(outcome.lockedItems.map((row) => row.inventoryItemId)).toEqual([
      sold.id,
    ]);
    expect((await items().get(sold.id)).landedCostAmount).toBe("150.000000");
    expect((await items().get(kept.id)).landedCostAmount).toBe("75.000000");
    expect((await items().get(found.id)).landedCostAmount).toBe("75.000000");
  });

  it("REFUSES a re-allocation whose pool went negative, rather than clamping", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "a mis-costed lot",
      sourceKind: "auction_lot",
      currency: "USD",
      costAllocationBasis: "equal",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "400",
    });
    const sold = await items().create({
      label: "sold at the old basis",
      currency: "USD",
      acquisitionId: lot.id,
    });
    await service.allocateCosts({ acquisitionId: lot.id });
    await createMovementsService({ db: scratch.handle.db }).record({
      inventoryItemId: sold.id,
      movementKind: "depletion_sale",
      quantity: "-1",
      deduplicationKey: "negative-pool:1",
    });

    // The operator discovers the lot actually cost less than was recorded.
    await service.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "-250", // a seller refund, positive-is-spend convention
    });
    await items().create({
      label: "another item",
      currency: "USD",
      acquisitionId: lot.id,
    });
    await expect(
      service.allocateCosts({ acquisitionId: lot.id }),
    ).rejects.toThrow(/refused/i);
  });

  /* ----------------------------------------------------- manual and no-FX */

  it("checks only the total under a manual basis", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "operator typed the basis",
      sourceKind: "estate_sale",
      currency: "USD",
      costAllocationBasis: "manual",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "200",
    });
    const a = await items().create({
      label: "the good one",
      currency: "USD",
      acquisitionId: lot.id,
    });
    const b = await items().create({
      label: "the filler",
      currency: "USD",
      acquisitionId: lot.id,
    });

    await expect(
      service.allocateCosts({
        acquisitionId: lot.id,
        manualAmounts: [
          { inventoryItemId: a.id, landedCostAmount: "180" },
          { inventoryItemId: b.id, landedCostAmount: "30" },
        ],
      }),
    ).rejects.toThrow(InventoryConflictError);

    const outcome = await service.allocateCosts({
      acquisitionId: lot.id,
      manualAmounts: [
        { inventoryItemId: a.id, landedCostAmount: "180" },
        { inventoryItemId: b.id, landedCostAmount: "20" },
      ],
    });
    expect(outcome.allocations.map((row) => row.landedCostAmount)).toEqual([
      "180.000000",
      "20.000000",
    ]);
    await expect(
      service.allocateCosts({ acquisitionId: lot.id, manualAmounts: [] }),
    ).rejects.toThrow(InventoryValidationError);
  });

  it("excludes a foreign-currency cost rather than converting it", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "a GBP lot with a USD freight charge",
      sourceKind: "online_marketplace",
      currency: "GBP",
      costAllocationBasis: "equal",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "100",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "inbound_freight",
      costClass: "ancillary",
      amount: "35",
      currency: "USD",
    });
    await items().create({
      label: "the GBP item",
      currency: "GBP",
      acquisitionId: lot.id,
    });

    const outcome = await service.allocateCosts({ acquisitionId: lot.id });
    // No FX anywhere in Phase 4: the USD charge is REPORTED, never folded in.
    expect(outcome.currency).toBe("GBP");
    expect(outcome.lotPoolAmount).toBe("100.000000");
    expect(outcome.foreignCurrencyCostCount).toBe(1);
    expect(outcome.allocations[0]?.landedCostAmount).toBe("100.000000");
  });

  it("refuses to finalize a lot whose pool has no weight to land on", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "a lot with no estimated values",
      sourceKind: "auction_lot",
      currency: "USD",
      costAllocationBasis: "relative_value",
    });
    await service.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "80",
    });
    await items().create({
      label: "no idea what it is worth",
      currency: "USD",
      acquisitionId: lot.id,
    });
    const provisional = await service.allocateCosts({ acquisitionId: lot.id });
    expect(provisional.unallocatedAmount).toBe("80.000000");
    expect(provisional.costAllocationStatus).toBe("provisional");
    await expect(
      service.allocateCosts({ acquisitionId: lot.id, finalize: true }),
    ).rejects.toThrow(InventoryConflictError);
  });

  it("surfaces stale open lots", async () => {
    const service = acquisitions();
    const lot = await service.create({
      title: "opened in January and never finished",
      sourceKind: "liquidation_pallet",
      currency: "USD",
      acquiredAt: new Date("2026-01-05T00:00:00Z"),
    });
    const stale = await openLots(scratch.handle.db, { staleAfterDays: 14 });
    expect(stale.map((row) => row.acquisitionId)).toContain(lot.id);
  });
});

describe("audited per-item basis correction", () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_basis_fix");
  });

  afterAll(async () => {
    await scratch.close();
  });

  it("is the only path that rewrites a frozen basis, and it writes an audit event", async () => {
    const items = createItemsService({ db: scratch.handle.db });
    const item = await items.create({
      label: "mis-costed, and already sold",
      currency: "USD",
      landedCostAmount: "150",
    });
    await createMovementsService({ db: scratch.handle.db }).record({
      inventoryItemId: item.id,
      movementKind: "depletion_sale",
      quantity: "-1",
      deduplicationKey: "basis-fix:1",
    });
    expect((await items.get(item.id)).costBasisLockedAt).not.toBeNull();

    // An unexplained correction is indistinguishable from a bug.
    await expect(
      items.correctCostBasis({
        inventoryItemId: item.id,
        landedCostAmount: "90",
        reason: "   ",
      }),
    ).rejects.toThrow(/reason/);

    const corrected = await items.correctCostBasis({
      inventoryItemId: item.id,
      landedCostAmount: "90",
      reason: "the auction house re-issued the invoice at the hammer price",
    });
    expect(corrected.landedCostAmount).toBe("90.000000");

    const audit = await scratch.handle.db.execute(
      `select action, resource_id::text as resource_id, metadata
         from audit_events
        where action = 'inventory.item.cost_basis_corrected'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.["resource_id"]).toBe(item.id);
    expect(
      (audit.rows[0]?.["metadata"] as { reason?: string }).reason,
    ).toContain("hammer price");
  });

  it("refuses to re-cost a locked item through a manual lot run", async () => {
    const acquisitionsService = createAcquisitionsService({
      db: scratch.handle.db,
    });
    const items = createItemsService({ db: scratch.handle.db });
    const lot = await acquisitionsService.create({
      title: "a lot with one sold item",
      sourceKind: "auction_lot",
      currency: "USD",
      costAllocationBasis: "manual",
    });
    await acquisitionsService.addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "100",
    });
    const sold = await items.create({
      label: "sold",
      currency: "USD",
      acquisitionId: lot.id,
      landedCostAmount: "60",
    });
    await createMovementsService({ db: scratch.handle.db }).record({
      inventoryItemId: sold.id,
      movementKind: "depletion_sale",
      quantity: "-1",
      deduplicationKey: "basis-fix:lot",
    });

    await expect(
      acquisitionsService.allocateCosts({
        acquisitionId: lot.id,
        manualAmounts: [{ inventoryItemId: sold.id, landedCostAmount: "40" }],
      }),
    ).rejects.toThrow(InventoryImmutableFactError);
  });
});
