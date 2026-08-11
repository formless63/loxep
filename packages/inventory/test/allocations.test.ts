/**
 * The allocation lifecycle: reserve → deplete → basis frozen, the release path,
 * over-allocation refusal, and the unmatched-depletion backlog that must never
 * raise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAllocationsService } from "../src/allocations.ts";
import { InventoryAllocationError } from "../src/errors.ts";
import { createItemsService } from "../src/items.ts";
import { createMovementsService } from "../src/movements.ts";
import { unmatchedDepletions } from "../src/profitability.ts";
import {
  createMigratedScratchDb,
  seedConnection,
  seedOrder,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("allocation and depletion", () => {
  let scratch: ScratchDb;
  let connectionId = "";

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_allocations");
    connectionId = await seedConnection(scratch, { name: "the woo store" });
  });

  afterAll(async () => {
    await scratch.close();
  });

  const items = () => createItemsService({ db: scratch.handle.db });
  const allocations = () => createAllocationsService({ db: scratch.handle.db });

  it("reserves without writing anything to the ledger", async () => {
    const item = await items().create({
      label: "a lamp somebody bought",
      currency: "USD",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "res-1",
      lines: [{ quantity: "1", unitPrice: "80", lineTotal: "80" }],
    });
    const allocation = await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
    });
    expect(allocation.status).toBe("reserved");

    // Allocation is NOT a movement: the ledger still has only the receipt.
    const ledger = await scratch.handle.db.execute(
      `select movement_kind from inventory_movements
        where inventory_item_id = '${item.id}'`,
    );
    expect(ledger.rows.map((row) => row["movement_kind"])).toEqual(["found"]);

    // On-hand is unchanged; available-to-sell is what moved.
    expect((await items().get(item.id)).quantityOnHand).toBe("1.000000");
    expect(await items().availableToSell(item.id)).toBe("0.000000");
    expect(await allocations().reservedQuantity(item.id)).toBe("1.000000");
  });

  it("is idempotent per (line, item) while the hold is open", async () => {
    const item = await items().create({ label: "retried", currency: "USD" });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "res-retry",
      lines: [{ quantity: "1", unitPrice: "10", lineTotal: "10" }],
    });
    const first = await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
    });
    const second = await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
    });
    expect(second.id).toBe(first.id);
  });

  it("REJECTS over-allocation against available-to-sell", async () => {
    const item = await items().create({
      label: "one of these exists",
      currency: "USD",
      quantity: "1",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "over-1",
      lines: [
        { quantity: "1", unitPrice: "10", lineTotal: "10" },
        { quantity: "1", unitPrice: "10", lineTotal: "10" },
      ],
    });
    await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
    });
    await expect(
      allocations().reserve({
        inventoryItemId: item.id,
        orderLineId: order.lineIds[1],
      }),
    ).rejects.toThrow(InventoryAllocationError);
  });

  it("allows an explicit over-allocation when the operator insists", async () => {
    const item = await items().create({
      label: "the operator can see it on the shelf",
      currency: "USD",
      quantity: "1",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "over-2",
      lines: [{ quantity: "5", unitPrice: "10", lineTotal: "50" }],
    });
    const allocation = await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
      quantity: "5",
      allowOverAllocation: true,
    });
    expect(allocation.quantity).toBe("5.000000");
  });

  it("releases a hold and frees the partial unique for a later one", async () => {
    const item = await items().create({ label: "released", currency: "USD" });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "rel-1",
      lines: [{ quantity: "1", unitPrice: "10", lineTotal: "10" }],
    });
    const first = await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
    });
    const released = await allocations().release({
      allocationId: first.id,
      reason: "buyer changed their mind",
    });
    expect(released.status).toBe("released");
    expect(released.releasedAt).not.toBeNull();
    expect(await items().availableToSell(item.id)).toBe("1.000000");

    // The partial unique's `where status in ('reserved','fulfilled')` is what
    // makes this legal.
    const second = await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
    });
    expect(second.id).not.toBe(first.id);
  });

  it("refuses to release an allocation that is already fulfilled", async () => {
    const item = await items().create({ label: "sold", currency: "USD" });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "rel-2",
      lines: [{ quantity: "1", unitPrice: "10", lineTotal: "10" }],
    });
    const allocation = await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
    });
    await allocations().depleteOnFulfillment({
      orderFulfillmentId: order.fulfillmentId,
      orderLineId: order.lineIds[0] ?? "",
      quantity: "1",
    });
    await expect(
      allocations().release({ allocationId: allocation.id }),
    ).rejects.toThrow(InventoryAllocationError);
  });

  /* -------------------------------------------------------- the full path */

  it("reserve -> deplete: movement written, allocation fulfilled, basis frozen", async () => {
    const item = await items().create({
      label: "the headline path",
      currency: "USD",
      landedCostAmount: "42",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "path-1",
      lines: [{ quantity: "1", unitPrice: "120", lineTotal: "120" }],
    });
    const allocation = await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
    });

    const result = await allocations().depleteOnFulfillment({
      orderFulfillmentId: order.fulfillmentId,
      orderLineId: order.lineIds[0] ?? "",
      quantity: "1",
    });

    expect(result.unmatched).toBe(false);
    expect(result.depletions).toHaveLength(1);
    expect(result.depletions[0]).toMatchObject({
      allocationId: allocation.id,
      inventoryItemId: item.id,
      quantity: "1.000000",
      created: true,
      oversell: false,
    });

    const depleted = await items().get(item.id);
    expect(depleted.quantityOnHand).toBe("0.000000");
    expect(depleted.status).toBe("depleted");
    expect(depleted.depletedAt).not.toBeNull();
    // OQ5: the basis is now frozen, because it has fed a realized figure.
    expect(depleted.costBasisLockedAt).not.toBeNull();

    const movement = await scratch.handle.db.execute(
      `select movement_kind, quantity::text as q, deduplication_key,
              order_fulfillment_id::text as f, inventory_allocation_id::text as a
         from inventory_movements
        where inventory_item_id = '${item.id}'
          and movement_kind = 'depletion_sale'`,
    );
    expect(movement.rows).toHaveLength(1);
    expect(movement.rows[0]?.["q"]).toBe("-1.000000");
    expect(movement.rows[0]?.["deduplication_key"]).toBe(
      `ffl:${order.fulfillmentId}:${order.lineIds[0]}:alloc:${allocation.id}`,
    );
  });

  it("a double-fired fulfillment depletes exactly once", async () => {
    const item = await items().create({
      label: "double-fired",
      currency: "USD",
      quantity: "1",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "path-2",
      lines: [{ quantity: "1", unitPrice: "10", lineTotal: "10" }],
    });
    await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
    });
    const input = {
      orderFulfillmentId: order.fulfillmentId,
      orderLineId: order.lineIds[0] ?? "",
      quantity: "1",
    };
    const first = await allocations().depleteOnFulfillment(input);
    const second = await allocations().depleteOnFulfillment(input);
    expect(first.depletions[0]?.created).toBe(true);
    // The allocation is `fulfilled` after the first pass, so the second finds
    // no reserved allocation at all — and writes nothing either way.
    expect(second.depletions).toHaveLength(0);
    expect(
      await createMovementsService({ db: scratch.handle.db }).ledgerBalance(
        item.id,
      ),
    ).toBe("0.000000");
  });

  it("splits one fulfilled line across several reserved items, oldest first", async () => {
    const a = await items().create({ label: "unit A", currency: "USD" });
    const b = await items().create({ label: "unit B", currency: "USD" });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "path-3",
      lines: [{ quantity: "2", unitPrice: "50", lineTotal: "100" }],
    });
    await allocations().reserve({
      inventoryItemId: a.id,
      orderLineId: order.lineIds[0],
    });
    await allocations().reserve({
      inventoryItemId: b.id,
      orderLineId: order.lineIds[0],
    });
    const result = await allocations().depleteOnFulfillment({
      orderFulfillmentId: order.fulfillmentId,
      orderLineId: order.lineIds[0] ?? "",
      quantity: "2",
    });
    expect(result.depletions.map((row) => row.inventoryItemId)).toEqual([
      a.id,
      b.id,
    ]);
    expect(result.unmatchedQuantity).toBe("0.000000");
  });

  it("keeps a partially consumed reservation open across two fulfillments", async () => {
    const item = await items().create({
      label: "a case shipped in two boxes",
      currency: "USD",
      quantity: "10",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "path-4",
      lines: [{ quantity: "10", unitPrice: "5", lineTotal: "50" }],
    });
    const allocation = await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[0],
      quantity: "10",
    });
    const first = await allocations().depleteOnFulfillment({
      orderFulfillmentId: order.fulfillmentId,
      orderLineId: order.lineIds[0] ?? "",
      quantity: "4",
    });
    expect(first.depletions[0]?.quantity).toBe("4.000000");
    const stillOpen = await scratch.handle.db.execute(
      `select status from inventory_allocations where id = '${allocation.id}'`,
    );
    expect(stillOpen.rows[0]?.["status"]).toBe("reserved");

    // A SECOND fulfillment carries a different deduplication key, so the
    // remaining six deplete rather than being swallowed as a retry.
    const secondFulfillment = await scratch.handle.pool.query<{ id: string }>(
      `insert into order_fulfillments (order_id, status)
       values ($1, 'shipped') returning id`,
      [order.orderId],
    );
    const second = await allocations().depleteOnFulfillment({
      orderFulfillmentId: secondFulfillment.rows[0]?.id ?? "",
      orderLineId: order.lineIds[0] ?? "",
      quantity: "6",
    });
    expect(second.depletions[0]?.quantity).toBe("6.000000");
    const closed = await scratch.handle.db.execute(
      `select status from inventory_allocations where id = '${allocation.id}'`,
    );
    expect(closed.rows[0]?.["status"]).toBe("fulfilled");
    expect((await items().get(item.id)).quantityOnHand).toBe("0.000000");
  });

  /* ------------------------------------------------- the unmatched backlog */

  it("NEVER raises when a fulfilled line has no allocation", async () => {
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "unmatched-1",
      lines: [{ quantity: "1", unitPrice: "30", lineTotal: "30" }],
    });
    const result = await allocations().depleteOnFulfillment({
      orderFulfillmentId: order.fulfillmentId,
      orderLineId: order.lineIds[0] ?? "",
      quantity: "1",
    });
    expect(result.unmatched).toBe(true);
    expect(result.depletions).toHaveLength(0);
    expect(result.unmatchedQuantity).toBe("1.000000");

    // It becomes a visible backlog, exactly as an unattributed order does.
    const backlog = await unmatchedDepletions(scratch.handle.db);
    expect(backlog.map((row) => row.orderLineId)).toContain(order.lineIds[0]);
  });

  it("expires a stale manual hold but never an order-line allocation", async () => {
    const held = await items().create({ label: "on hold", currency: "USD" });
    const sold = await items().create({ label: "reserved", currency: "USD" });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "expire-1",
      lines: [{ quantity: "1", unitPrice: "10", lineTotal: "10" }],
    });
    await allocations().reserve({
      inventoryItemId: held.id,
      allocationKind: "manual_hold",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    await allocations().reserve({
      inventoryItemId: sold.id,
      orderLineId: order.lineIds[0],
    });

    const swept = await allocations().expireStaleHolds(
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(swept.expired).toBe(1);
    expect(await items().availableToSell(held.id)).toBe("1.000000");
    expect(await items().availableToSell(sold.id)).toBe("0.000000");
  });

  it("leaves the ledger and the cache in agreement", async () => {
    const result = await createMovementsService({
      db: scratch.handle.db,
    }).reconcile();
    expect(result.drift).toHaveLength(0);
  });
});
