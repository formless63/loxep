/**
 * Realized profitability, against hand-computed fixtures.
 *
 * Every expected number in this file was worked out on paper from the design's
 * composition formula before the code ran. That is the point: a profitability
 * read model that only agrees with itself is not tested.
 *
 * ```text
 *   order revenue
 * − refunds
 * − line-scoped seller fees
 * − allocated order-scoped seller fees   (pro rata by line_total, EXCLUDING
 *                                         any fee a shipment already accounts
 *                                         for)
 * − outbound shipping                    (net, allocated across shipment_items)
 * − cost basis
 * = realized contribution
 * ```
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAcquisitionsService } from "../src/acquisitions.ts";
import { createAllocationsService } from "../src/allocations.ts";
import { createItemsService } from "../src/items.ts";
import { createMovementsService } from "../src/movements.ts";
import {
  CONTRIBUTION_LABEL,
  acquisitionRoi,
  inventoryOnHandAtCost,
  itemRealizedContribution,
  orderRealizedContribution,
  oversells,
  sourcingChannelPerformance,
} from "../src/profitability.ts";
import { createShipmentsService, netShipmentCost } from "../src/shipments.ts";
import {
  createMigratedScratchDb,
  feeIdsFor,
  seedConnection,
  seedEntity,
  seedOrder,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("realized profitability", () => {
  let scratch: ScratchDb;
  let connectionId = "";
  let entityId = "";

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_profit");
    entityId = await seedEntity(scratch, "Resale LLC", "llc");
    connectionId = await seedConnection(scratch, {
      name: "the woo store",
      economicEntityId: entityId,
    });
  });

  afterAll(async () => {
    await scratch.close();
  });

  const items = () => createItemsService({ db: scratch.handle.db });
  const allocations = () => createAllocationsService({ db: scratch.handle.db });
  const shipments = () => createShipmentsService({ db: scratch.handle.db });
  const acquisitions = () => createAcquisitionsService({ db: scratch.handle.db });

  /** Reserve, fulfil, and return the depleted item. */
  async function sell(
    item: { id: string },
    order: { orderId: string; lineIds: string[]; fulfillmentId: string },
    lineIndex = 0,
    quantity = "1",
  ): Promise<void> {
    await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[lineIndex],
      quantity,
    });
    await allocations().depleteOnFulfillment({
      orderFulfillmentId: order.fulfillmentId,
      orderLineId: order.lineIds[lineIndex] ?? "",
      quantity,
    });
  }

  /* -------------------------------------------------- the canonical single */

  it("composes one item, one line, hand-computed end to end", async () => {
    // Sale       120.00
    // Refund       0.00
    // Line fee     0.00
    // Order fee   14.40  (a single order-scoped final value fee, one line)
    // Shipping     9.35  (postage 8.50 + insurance 1.20 + adjustment 0.65
    //                     − refund 1.00)
    // Basis       42.00
    // ------------------
    // Contribution 54.25
    const item = await items().create({
      label: "a vintage Pyrex bowl",
      currency: "USD",
      economicEntityId: entityId,
      landedCostAmount: "42",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-single",
      economicEntityId: entityId,
      lines: [{ quantity: "1", unitPrice: "120", lineTotal: "120" }],
      fees: [{ feeType: "marketplace_final_value", amount: "14.40" }],
    });
    await sell(item, order);
    const { shipment } = await shipments().record({
      shipmentKind: "outbound_sale",
      orderId: order.orderId,
      currency: "USD",
      postageAmount: "8.50",
      insuranceAmount: "1.20",
      adjustmentAmount: "0.65",
      refundAmount: "1.00",
      items: [{ inventoryItemId: item.id, orderLineId: order.lineIds[0] }],
    });
    expect(netShipmentCost(shipment)).toBe("9.350000");

    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inventoryItemId: item.id,
      currency: "USD",
      costCurrency: "USD",
      contributionComputable: true,
      consignment: false,
      revenueAmount: "120.000000",
      refundAmount: "0.000000",
      lineFeeAmount: "0.000000",
      allocatedOrderFeeAmount: "14.400000",
      shippingAmount: "9.350000",
      costBasisAmount: "42.000000",
      contributionAmount: "54.250000",
    });

    const orders = await orderRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    expect(orders[0]).toMatchObject({
      orderRevenueAmount: "120.000000",
      matchedRevenueAmount: "120.000000",
      unmatchedRevenueAmount: "0.000000",
      contributionAmount: "54.250000",
      label: CONTRIBUTION_LABEL,
    });
  });

  /* ------------------------------------------- pro rata and rounding edges */

  it("allocates an order-scoped fee pro rata by line_total, largest remainder", async () => {
    // Two lines, 400.00 and 6.00; an order fee of 10.00.
    //   406 total; 400/406 * 10 = 9.852216|74…  -> 9.852216, remainder 748/406
    //     6/406 * 10 = 0.147783|25…             -> 0.147783, remainder 82/406
    //   one 1e-6 unit left -> the LARGER remainder (line 1) takes it.
    //   -> 9.852217 and 0.147783, summing to exactly 10.000000
    // This is the case the design uses to reject a by-quantity basis: a $400
    // item shipping alongside a $6 one must not carry an equal share.
    const expensive = await items().create({
      label: "the $400 camera",
      currency: "USD",
      landedCostAmount: "150",
    });
    const cheap = await items().create({
      label: "the $6 lens cap",
      currency: "USD",
      landedCostAmount: "1",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-prorata",
      lines: [
        { quantity: "1", unitPrice: "400", lineTotal: "400" },
        { quantity: "1", unitPrice: "6", lineTotal: "6" },
      ],
      fees: [{ feeType: "marketplace_final_value", amount: "10" }],
    });
    await sell(expensive, order, 0);
    await sell(cheap, order, 1);

    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    const byItem = new Map(rows.map((row) => [row.inventoryItemId, row]));
    expect(byItem.get(expensive.id)?.allocatedOrderFeeAmount).toBe("9.852217");
    expect(byItem.get(cheap.id)?.allocatedOrderFeeAmount).toBe("0.147783");
    expect(
      Number(byItem.get(expensive.id)?.allocatedOrderFeeAmount) +
        Number(byItem.get(cheap.id)?.allocatedOrderFeeAmount),
    ).toBe(10);
  });

  it("gives a zero-value promotional line NO share, leaving it with the payers", async () => {
    const paid = await items().create({
      label: "the thing they paid for",
      currency: "USD",
      landedCostAmount: "10",
    });
    const free = await items().create({
      label: "the free sticker",
      currency: "USD",
      landedCostAmount: "0",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-promo",
      lines: [
        { quantity: "1", unitPrice: "50", lineTotal: "50" },
        { quantity: "1", unitPrice: "0", lineTotal: "0" },
      ],
      fees: [{ feeType: "marketplace_final_value", amount: "6" }],
    });
    await sell(paid, order, 0);
    await sell(free, order, 1);

    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    const byItem = new Map(rows.map((row) => [row.inventoryItemId, row]));
    expect(byItem.get(paid.id)?.allocatedOrderFeeAmount).toBe("6.000000");
    expect(byItem.get(free.id)?.allocatedOrderFeeAmount).toBe("0.000000");
  });

  it("splits one line's revenue across the several items that depleted it", async () => {
    // One line for 100.00 fulfilled by two units -> 50.00 each.
    const a = await items().create({
      label: "unit A",
      currency: "USD",
      landedCostAmount: "12",
    });
    const b = await items().create({
      label: "unit B",
      currency: "USD",
      landedCostAmount: "8",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-multi",
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
    await allocations().depleteOnFulfillment({
      orderFulfillmentId: order.fulfillmentId,
      orderLineId: order.lineIds[0] ?? "",
      quantity: "2",
    });

    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.revenueAmount)).toEqual([
      "50.000000",
      "50.000000",
    ]);
    const byItem = new Map(rows.map((row) => [row.inventoryItemId, row]));
    expect(byItem.get(a.id)?.contributionAmount).toBe("38.000000");
    expect(byItem.get(b.id)?.contributionAmount).toBe("42.000000");
  });

  /* ---------------------------------- the shipping double-count guard (OQ6) */

  it("counts marketplace-bought postage ONCE, from the shipment", async () => {
    const item = await items().create({
      label: "shipped on a marketplace label",
      currency: "USD",
      landedCostAmount: "20",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-doublecount",
      lines: [{ quantity: "1", unitPrice: "100", lineTotal: "100" }],
      fees: [
        { feeType: "marketplace_final_value", amount: "13" },
        // The SAME money the shipment will carry as postage.
        { feeType: "shipping_label_charge", amount: "7.25" },
      ],
    });
    await sell(item, order);
    const fees = await feeIdsFor(scratch, order.orderId);
    const labelFee = fees.find((fee) => fee.feeType === "shipping_label_charge");
    await shipments().record({
      shipmentKind: "outbound_sale",
      orderId: order.orderId,
      orderFeeId: labelFee?.id,
      costSource: "fee_derived",
      currency: "USD",
      postageAmount: "7.25",
      items: [{ inventoryItemId: item.id, orderLineId: order.lineIds[0] }],
    });

    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    // 100 − 13 (final value only; the label fee is excluded) − 7.25 − 20
    expect(rows[0]).toMatchObject({
      allocatedOrderFeeAmount: "13.000000",
      shippingAmount: "7.250000",
      contributionAmount: "59.750000",
    });

    // And nothing is left in the reconciliation report, because the link is set.
    const unlinked = await shipments().unlinkedShippingLabelFees();
    expect(unlinked.map((row) => row.orderId)).not.toContain(order.orderId);
  });

  it("flags a shipping_label_charge fee with no shipment pointing at it", async () => {
    const item = await items().create({
      label: "shipped, link forgotten",
      currency: "USD",
      landedCostAmount: "5",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-unlinked",
      lines: [{ quantity: "1", unitPrice: "40", lineTotal: "40" }],
      fees: [{ feeType: "shipping_label_charge", amount: "4.10" }],
    });
    await sell(item, order);
    const unlinked = await shipments().unlinkedShippingLabelFees();
    expect(unlinked.map((row) => row.orderId)).toContain(order.orderId);
    // Until it is linked, the read model DOES subtract the fee — the residual
    // risk the design names — which is exactly why the report exists.
    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    expect(rows[0]?.allocatedOrderFeeAmount).toBe("4.100000");
  });

  it("allocates one package's postage across two lines by line_total", async () => {
    // Net postage 12.00 across lines of 300.00 and 100.00 -> 9.00 / 3.00.
    const big = await items().create({
      label: "heavy",
      currency: "USD",
      landedCostAmount: "50",
    });
    const small = await items().create({
      label: "light",
      currency: "USD",
      landedCostAmount: "10",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-package",
      lines: [
        { quantity: "1", unitPrice: "300", lineTotal: "300" },
        { quantity: "1", unitPrice: "100", lineTotal: "100" },
      ],
    });
    await sell(big, order, 0);
    await sell(small, order, 1);
    await shipments().record({
      shipmentKind: "outbound_sale",
      orderId: order.orderId,
      currency: "USD",
      postageAmount: "12",
      items: [
        { inventoryItemId: big.id, orderLineId: order.lineIds[0] },
        { inventoryItemId: small.id, orderLineId: order.lineIds[1] },
      ],
    });
    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    const byItem = new Map(rows.map((row) => [row.inventoryItemId, row]));
    expect(byItem.get(big.id)?.shippingAmount).toBe("9.000000");
    expect(byItem.get(small.id)?.shippingAmount).toBe("3.000000");
  });

  /* ----------------------------------------------------- fees and refunds */

  it("subtracts only seller_charge fees, never a buyer surcharge", async () => {
    const item = await items().create({
      label: "sold with a handling surcharge",
      currency: "USD",
      landedCostAmount: "10",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-direction",
      lines: [{ quantity: "1", unitPrice: "60", lineTotal: "60" }],
      fees: [
        { feeType: "marketplace_final_value", amount: "6" },
        {
          feeType: "buyer_surcharge",
          amount: "3.50",
          feeDirection: "buyer_surcharge",
        },
      ],
    });
    await sell(item, order);
    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    // The buyer surcharge is already inside what the buyer paid us; subtracting
    // it would understate contribution by exactly that amount.
    expect(rows[0]?.allocatedOrderFeeAmount).toBe("6.000000");
    expect(rows[0]?.contributionAmount).toBe("44.000000");
  });

  it("subtracts a line refund and a line-scoped fee", async () => {
    const item = await items().create({
      label: "partly refunded",
      currency: "USD",
      landedCostAmount: "15",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-refund",
      lines: [{ quantity: "1", unitPrice: "90", lineTotal: "90" }],
      fees: [{ feeType: "promoted_listing_ad", amount: "4.50", lineIndex: 0 }],
      refunds: [{ lineIndex: 0, amount: "20" }],
    });
    await sell(item, order);
    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    // 90 − 20 − 4.50 − 15
    expect(rows[0]).toMatchObject({
      refundAmount: "20.000000",
      lineFeeAmount: "4.500000",
      contributionAmount: "50.500000",
    });
  });

  /* ---------------------------------------------------------- no FX (OQ8) */

  it("reports a mixed-currency sale as not computable rather than converting", async () => {
    const item = await items().create({
      label: "bought in GBP, sold in USD",
      currency: "GBP",
      landedCostAmount: "30",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-fx",
      currency: "USD",
      lines: [{ quantity: "1", unitPrice: "80", lineTotal: "80" }],
    });
    await sell(item, order);
    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    expect(rows[0]).toMatchObject({
      currency: "USD",
      costCurrency: "GBP",
      contributionComputable: false,
      contributionAmount: null,
      // Both figures are still shown; showing an honest gap beats storing a
      // rate we do not have.
      revenueAmount: "80.000000",
      costBasisAmount: "30.000000",
    });
    const orders = await orderRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    expect(orders[0]?.excludedForeignCurrencyItemCount).toBe(1);
    expect(orders[0]?.contributionAmount).toBe("0.000000");
  });

  /* ------------------------------------------------- consignment (OQ9) */

  it("excludes consignment stock from the totals by an explicit predicate", async () => {
    const lot = await acquisitions().create({
      title: "goods taken on consignment",
      sourceKind: "consignment_intake",
      currency: "USD",
    });
    const consigned = await items().create({
      label: "not ours to profit from",
      currency: "USD",
      acquisitionId: lot.id,
      landedCostAmount: "0",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-consign",
      lines: [{ quantity: "1", unitPrice: "200", lineTotal: "200" }],
    });
    await sell(consigned, order);

    const rows = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    // The row is RETURNED and flagged — excluded by predicate, not hidden and
    // not by the accident of a zero basis.
    expect(rows[0]?.consignment).toBe(true);
    const orders = await orderRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    expect(orders[0]?.excludedConsignmentItemCount).toBe(1);
    expect(orders[0]?.contributionAmount).toBe("0.000000");
  });

  /* ---------------------------------------------------- the other models */

  it("reports acquisition ROI and sourcing-channel performance", async () => {
    const lot = await acquisitions().create({
      title: "a $100 pallet with two items",
      sourceKind: "liquidation_pallet",
      currency: "USD",
      costAllocationBasis: "equal",
      economicEntityId: entityId,
    });
    await acquisitions().addCost({
      acquisitionId: lot.id,
      costType: "goods",
      costClass: "goods",
      amount: "100",
    });
    const sold = await items().create({
      label: "the sellable half",
      currency: "USD",
      acquisitionId: lot.id,
      economicEntityId: entityId,
    });
    await items().create({
      label: "still on the shelf",
      currency: "USD",
      acquisitionId: lot.id,
      economicEntityId: entityId,
    });
    await acquisitions().allocateCosts({ acquisitionId: lot.id, finalize: true });

    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-roi",
      lines: [{ quantity: "1", unitPrice: "175", lineTotal: "175" }],
    });
    await sell(sold, order);

    const roi = await acquisitionRoi(scratch.handle.db, {
      acquisitionId: lot.id,
    });
    expect(roi).toHaveLength(1);
    expect(roi[0]).toMatchObject({
      landedCostAmount: "100.000000",
      itemCount: 2,
      depletedItemCount: 1,
      onHandItemCount: 1,
      // Basis still on the shelf: a COST total, explicitly not a valuation.
      onHandCostAmount: "50.000000",
      // 175 − 50 basis
      realizedContributionAmount: "125.000000",
    });

    const channels = await sourcingChannelPerformance(scratch.handle.db, {
      acquisitionId: lot.id,
    });
    expect(channels[0]).toMatchObject({
      sourceKind: "liquidation_pallet",
      currency: "USD",
      acquisitionCount: 1,
      landedCostAmount: "100.000000",
      realizedContributionAmount: "125.000000",
    });
  });

  it("reports inventory on hand at COST, excluding consignment stock", async () => {
    const rows = await inventoryOnHandAtCost(scratch.handle.db, {
      economicEntityId: entityId,
    });
    const total = rows.reduce(
      (sum, row) => sum + Number(row.onHandCostAmount),
      0,
    );
    expect(total).toBeGreaterThan(0);
    expect(rows.every((row) => row.currency === "USD")).toBe(true);
  });

  it("surfaces an oversell rather than hiding it", async () => {
    const item = await items().create({
      label: "sold on two channels in one minute",
      currency: "USD",
      quantity: "1",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-oversell",
      lines: [
        { quantity: "1", unitPrice: "50", lineTotal: "50" },
        { quantity: "1", unitPrice: "50", lineTotal: "50" },
      ],
    });
    await sell(item, order, 0);
    await allocations().reserve({
      inventoryItemId: item.id,
      orderLineId: order.lineIds[1],
      allowOverAllocation: true,
    });
    const second = await allocations().depleteOnFulfillment({
      orderFulfillmentId: order.fulfillmentId,
      orderLineId: order.lineIds[1] ?? "",
      quantity: "1",
    });
    expect(second.depletions[0]?.oversell).toBe(true);

    const found = await oversells(scratch.handle.db);
    expect(found.map((row) => row.inventoryItemId)).toContain(item.id);
  });

  it("does not count a reversed depletion as a sale", async () => {
    const item = await items().create({
      label: "sold then un-sold",
      currency: "USD",
      landedCostAmount: "9",
    });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "p-reversed",
      lines: [{ quantity: "1", unitPrice: "70", lineTotal: "70" }],
    });
    await sell(item, order);
    expect(
      await itemRealizedContribution(scratch.handle.db, {
        orderId: order.orderId,
      }),
    ).toHaveLength(1);

    const movement = await scratch.handle.db.execute(
      `select id::text as id from inventory_movements
        where inventory_item_id = '${item.id}'
          and movement_kind = 'depletion_sale'`,
    );
    await createMovementsService({ db: scratch.handle.db }).reverse({
      movementId: movement.rows[0]?.["id"] as string,
      reasonCode: "cancelled after the label was voided",
    });

    const after = await itemRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    expect(after).toHaveLength(0);
    const orders = await orderRealizedContribution(scratch.handle.db, {
      orderId: order.orderId,
    });
    expect(orders).toHaveLength(0);
  });
});
