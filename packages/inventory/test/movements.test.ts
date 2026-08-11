/**
 * The movement ledger and the cached `quantity_on_hand` it maintains.
 *
 * The cache is the design's open question 3, and its whole justification is
 * "there is exactly one writer". These tests check the two halves of that
 * claim: that the writer keeps the cache exact through every kind of movement,
 * and that reconciliation FINDS drift when something writes around the writer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createItemsService } from "../src/items.ts";
import {
  createMovementsService,
  deriveItemStatus,
  movementKeys,
} from "../src/movements.ts";
import { createMigratedScratchDb } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("movements", () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_movements");
  });

  afterAll(async () => {
    await scratch.close();
  });

  const items = () => createItemsService({ db: scratch.handle.db });
  const movements = () => createMovementsService({ db: scratch.handle.db });

  it("puts stock on hand with the receipt movement created alongside the item", async () => {
    const item = await items().create({
      label: "case of 100 phone cases",
      currency: "USD",
      quantity: "100",
    });
    expect(item.quantityOnHand).toBe("100.000000");
    expect(item.status).toBe("available");
    expect(await movements().ledgerBalance(item.id)).toBe("100.000000");
  });

  it("keeps the cache equal to the ledger through a sequence of movements", async () => {
    const item = await items().create({
      label: "a box of Pyrex",
      currency: "USD",
      quantity: "10",
    });
    const service = movements();
    await service.record({
      inventoryItemId: item.id,
      movementKind: "shrinkage",
      quantity: "-3",
      deduplicationKey: movementKeys.event("shrink", "s1", item.id),
    });
    await service.record({
      inventoryItemId: item.id,
      movementKind: "adjustment_in",
      quantity: "1.5",
      deduplicationKey: movementKeys.adjustment("count-1", item.id),
    });
    const after = await service.record({
      inventoryItemId: item.id,
      movementKind: "disposal",
      quantity: "-0.5",
      deduplicationKey: movementKeys.event("disposal", "d1", item.id),
    });
    expect(after.quantityOnHand).toBe("8.000000");
    expect(await service.ledgerBalance(item.id)).toBe("8.000000");
    const reloaded = await items().get(item.id);
    expect(reloaded.quantityOnHand).toBe("8.000000");
    expect(reloaded.status).toBe("partially_depleted");
  });

  it("is idempotent on the deduplication key: a double-fired job moves stock once", async () => {
    const item = await items().create({
      label: "a Game Boy",
      currency: "USD",
      quantity: "1",
    });
    const service = movements();
    const input = {
      inventoryItemId: item.id,
      movementKind: "adjustment_out" as const,
      quantity: "-1",
      deduplicationKey: "adj:double-fire:item",
    };
    const first = await service.record(input);
    const second = await service.record(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.movement.id).toBe(first.movement.id);
    // Depleted once, not twice: the whole point of the deduplication key.
    expect(await service.ledgerBalance(item.id)).toBe("0.000000");
  });

  it("records an oversell rather than refusing it, and says so", async () => {
    const item = await items().create({
      label: "the one-of-a-kind lamp that sold twice",
      currency: "USD",
      quantity: "1",
    });
    const service = movements();
    await service.record({
      inventoryItemId: item.id,
      movementKind: "depletion_sale",
      quantity: "-1",
      deduplicationKey: "oversell:1",
    });
    const second = await service.record({
      inventoryItemId: item.id,
      movementKind: "depletion_sale",
      quantity: "-1",
      deduplicationKey: "oversell:2",
    });
    expect(second.oversell).toBe(true);
    expect(second.quantityOnHand).toBe("-1.000000");
    // Operational facts before accounting: the write SUCCEEDED.
    expect(second.created).toBe(true);
  });

  it("freezes cost basis at the first depletion_sale and never re-freezes", async () => {
    const item = await items().create({
      label: "a vintage Pyrex bowl",
      currency: "USD",
      quantity: "2",
      landedCostAmount: "40",
    });
    const service = movements();
    await service.record({
      inventoryItemId: item.id,
      movementKind: "depletion_sale",
      quantity: "-1",
      deduplicationKey: "freeze:1",
    });
    const afterFirst = await items().get(item.id);
    expect(afterFirst.costBasisLockedAt).not.toBeNull();

    await service.record({
      inventoryItemId: item.id,
      movementKind: "depletion_sale",
      quantity: "-1",
      deduplicationKey: "freeze:2",
    });
    const afterSecond = await items().get(item.id);
    expect(afterSecond.costBasisLockedAt?.getTime()).toBe(
      afterFirst.costBasisLockedAt?.getTime(),
    );
  });

  it("sets depleted_at at zero and CLEARS it when stock comes back", async () => {
    const item = await items().create({
      label: "a returned jacket",
      currency: "USD",
      quantity: "1",
    });
    const service = movements();
    await service.record({
      inventoryItemId: item.id,
      movementKind: "depletion_sale",
      quantity: "-1",
      deduplicationKey: "restock:out",
    });
    expect((await items().get(item.id)).depletedAt).not.toBeNull();

    await service.record({
      inventoryItemId: item.id,
      movementKind: "return_in",
      quantity: "1",
      deduplicationKey: "restock:in",
    });
    const restocked = await items().get(item.id);
    expect(restocked.depletedAt).toBeNull();
    expect(restocked.quantityOnHand).toBe("1.000000");
    expect(restocked.status).toBe("available");
  });

  it("corrects a movement with a reversal, never an UPDATE", async () => {
    const item = await items().create({
      label: "miscounted stock",
      currency: "USD",
      quantity: "5",
    });
    const service = movements();
    const wrong = await service.record({
      inventoryItemId: item.id,
      movementKind: "shrinkage",
      quantity: "-5",
      deduplicationKey: "wrong-shrinkage",
    });
    expect(wrong.quantityOnHand).toBe("0.000000");

    const reversal = await service.reverse({
      movementId: wrong.movement.id,
      reasonCode: "miscount",
    });
    expect(reversal.movement.movementKind).toBe("reversal");
    expect(reversal.movement.reversesMovementId).toBe(wrong.movement.id);
    expect(reversal.quantityOnHand).toBe("5.000000");
    // Both rows survive: the ledger records what happened, including the
    // mistake.
    const all = await scratch.handle.db.execute(
      `select count(*)::int as n from inventory_movements
        where inventory_item_id = '${item.id}'`,
    );
    expect(Number(all.rows[0]?.["n"])).toBe(3);
  });

  it("is idempotent on a reversal too", async () => {
    const item = await items().create({
      label: "double-reversed stock",
      currency: "USD",
      quantity: "2",
    });
    const service = movements();
    const wrong = await service.record({
      inventoryItemId: item.id,
      movementKind: "disposal",
      quantity: "-2",
      deduplicationKey: "double-reverse",
    });
    await service.reverse({ movementId: wrong.movement.id });
    const again = await service.reverse({ movementId: wrong.movement.id });
    expect(again.created).toBe(false);
    expect(await service.ledgerBalance(item.id)).toBe("2.000000");
  });

  /* -------------------------------------------------------- reconciliation */

  describe("reconciliation", () => {
    it("finds no drift when every movement went through the writer", async () => {
      const result = await movements().reconcile();
      expect(result.drift).toHaveLength(0);
      expect(result.itemsChecked).toBeGreaterThan(0);
    });

    it("CATCHES drift induced by writing around the single writer", async () => {
      const item = await items().create({
        label: "an item whose cache someone poked",
        currency: "USD",
        quantity: "7",
      });
      // Exactly the failure the design's nightly job exists to detect: the
      // cache is written by something that is not the movement service.
      await scratch.handle.pool.query(
        "update inventory_items set quantity_on_hand = '99' where id = $1",
        [item.id],
      );

      const found = await movements().reconcile({ inventoryItemId: item.id });
      expect(found.drift).toHaveLength(1);
      expect(found.drift[0]).toMatchObject({
        inventoryItemId: item.id,
        cachedQuantityOnHand: "99.000000",
        ledgerQuantityOnHand: "7.000000",
        difference: "-92.000000",
      });
      // Read-only by default: the drift is still there, because a silent repair
      // would hide the write path that caused it.
      expect(found.repaired).toBe(false);
      const stillWrong = await items().get(item.id);
      expect(stillWrong.quantityOnHand).toBe("99.000000");
    });

    it("repairs from the ledger only when explicitly asked", async () => {
      const drifted = await movements().reconcile();
      expect(drifted.drift.length).toBeGreaterThan(0);
      const repaired = await movements().reconcile({ apply: true });
      expect(repaired.repaired).toBe(true);
      const after = await movements().reconcile();
      expect(after.drift).toHaveLength(0);
    });
  });

  /* --------------------------------------------------------- status policy */

  describe("deriveItemStatus", () => {
    it("never stomps a decision", () => {
      expect(deriveItemStatus("written_off", "0", "1")).toBe("written_off");
      expect(deriveItemStatus("archived", "5", "5")).toBe("archived");
    });

    it("preserves a channel state while stock remains", () => {
      expect(deriveItemStatus("listed", "1", "1")).toBe("listed");
      expect(deriveItemStatus("reserved", "1", "1")).toBe("reserved");
    });

    it("still depletes a listed item that ran out", () => {
      expect(deriveItemStatus("listed", "0", "1")).toBe("depleted");
    });

    it("moves intake to available on receipt", () => {
      expect(deriveItemStatus("intake", "1", "1")).toBe("available");
    });

    it("reports a partial balance as partially_depleted", () => {
      expect(deriveItemStatus("available", "4", "10")).toBe(
        "partially_depleted",
      );
    });
  });
});
