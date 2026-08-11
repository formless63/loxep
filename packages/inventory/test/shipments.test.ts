/**
 * Shipments, shipment items, and the opportunity-to-outcome linkage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAcquisitionsService } from "../src/acquisitions.ts";
import { InventoryValidationError } from "../src/errors.ts";
import { createItemsService } from "../src/items.ts";
import { createLocationsService } from "../src/locations.ts";
import { createOpportunityLinksService } from "../src/opportunity-links.ts";
import { createShipmentsService, netShipmentCost } from "../src/shipments.ts";
import {
  createMigratedScratchDb,
  seedConnection,
  seedOrder,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("shipments", () => {
  let scratch: ScratchDb;
  let connectionId = "";

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_shipments");
    connectionId = await seedConnection(scratch, { name: "the woo store" });
  });

  afterAll(async () => {
    await scratch.close();
  });

  const shipments = () => createShipmentsService({ db: scratch.handle.db });
  const items = () => createItemsService({ db: scratch.handle.db });

  it("records a shipment with its contents", async () => {
    const item = await items().create({ label: "in the box", currency: "USD" });
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "s-1",
      lines: [{ quantity: "1", unitPrice: "40", lineTotal: "40" }],
    });
    const { shipment, items: contents } = await shipments().record({
      shipmentKind: "outbound_sale",
      orderId: order.orderId,
      orderFulfillmentId: order.fulfillmentId,
      carrierCode: "usps",
      trackingNumber: "9400100000000000000000",
      currency: "USD",
      postageAmount: "6.75",
      items: [{ inventoryItemId: item.id, orderLineId: order.lineIds[0] }],
    });
    expect(shipment.packageCount).toBe(1);
    expect(contents).toHaveLength(1);
    expect(await shipments().netCost(shipment.id)).toBe("6.750000");
  });

  it("accumulates a carrier post-audit reweigh charge", async () => {
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "s-reweigh",
      lines: [{ quantity: "1", unitPrice: "40", lineTotal: "40" }],
    });
    const { shipment } = await shipments().record({
      shipmentKind: "outbound_sale",
      orderId: order.orderId,
      currency: "USD",
      postageAmount: "8.00",
      items: [{ orderLineId: order.lineIds[0] }],
    });
    // Four days later the carrier reweighs the parcel. Twice.
    await shipments().recordCostAdjustment({
      shipmentId: shipment.id,
      adjustmentAmount: "2.15",
    });
    const after = await shipments().recordCostAdjustment({
      shipmentId: shipment.id,
      adjustmentAmount: "0.85",
    });
    expect(after.adjustmentAmount).toBe("3.000000");
    expect(netShipmentCost(after)).toBe("11.000000");
  });

  it("refuses to half-record the double-count guard", async () => {
    const order = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "s-guard",
      lines: [{ quantity: "1", unitPrice: "40", lineTotal: "40" }],
    });
    await expect(
      shipments().record({
        shipmentKind: "outbound_sale",
        orderId: order.orderId,
        costSource: "fee_derived",
        currency: "USD",
        postageAmount: "5",
      }),
    ).rejects.toThrow(InventoryValidationError);
  });

  it("records a shipment with no order at all", async () => {
    const locations = createLocationsService({ db: scratch.handle.db });
    const home = await locations.create({
      code: "HOME",
      name: "Home",
      kind: "site",
    });
    const { shipment } = await shipments().record({
      shipmentKind: "return_to_vendor",
      status: "shipped",
      currency: "USD",
      originLocationId: home.id,
      postageAmount: "22.40",
      items: [{ orderLineId: null, inventoryItemId: null } as never].slice(0, 0),
    });
    expect(shipment.orderId).toBeNull();
    expect(shipment.shipmentKind).toBe("return_to_vendor");
  });

  it("refuses an outbound sale with no order", async () => {
    await expect(
      shipments().record({
        shipmentKind: "outbound_sale",
        currency: "USD",
        postageAmount: "5",
      }),
    ).rejects.toThrow(InventoryValidationError);
  });

  it("scopes tracking uniqueness to the order, so a recycled number is legal", async () => {
    const first = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "s-track-1",
      lines: [{ quantity: "1", unitPrice: "10", lineTotal: "10" }],
    });
    const second = await seedOrder(scratch, {
      connectionId,
      externalOrderId: "s-track-2",
      lines: [{ quantity: "1", unitPrice: "10", lineTotal: "10" }],
    });
    const tracking = "1Z999AA10123456784";
    await shipments().record({
      shipmentKind: "outbound_sale",
      orderId: first.orderId,
      carrierCode: "ups",
      trackingNumber: tracking,
      currency: "USD",
    });
    // Eighteen months later the carrier hands out the same string again.
    await expect(
      shipments().record({
        shipmentKind: "outbound_sale",
        orderId: second.orderId,
        carrierCode: "ups",
        trackingNumber: tracking,
        currency: "USD",
      }),
    ).resolves.toBeTruthy();
    // The same number twice on ONE order is still a duplicate. Drizzle wraps
    // the driver error, so the constraint name is on the cause.
    const duplicate = await shipments()
      .record({
        shipmentKind: "outbound_sale",
        orderId: first.orderId,
        carrierCode: "ups",
        trackingNumber: tracking,
        currency: "USD",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(duplicate).not.toBeNull();
    const cause = (duplicate as { cause?: { constraint?: string } }).cause;
    expect(cause?.constraint).toBe("shipments_order_carrier_tracking_uq");
  });
});

describe("opportunity linkage", () => {
  let scratch: ScratchDb;
  let marketplaceItemId = "";

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_inv_opportunity");
    const row = await scratch.handle.pool.query<{ id: string }>(
      `insert into marketplace_items
         (provider, marketplace, external_item_id, title,
          first_seen_at, last_seen_at, current_state)
       values ('ebay', 'EBAY_US', 'v1|1234|0', 'a box of Pyrex',
               now(), now(), 'active')
       returning id`,
    );
    marketplaceItemId = row.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await scratch.close();
  });

  const links = () => createOpportunityLinksService({ db: scratch.handle.db });

  it("records why we bought the box, with the score FROZEN", async () => {
    const lot = await createAcquisitionsService({
      db: scratch.handle.db,
    }).create({
      title: "the box we bought because of that listing",
      sourceKind: "online_marketplace",
      currency: "USD",
    });
    const link = await links().link({
      linkKind: "sourced_from",
      acquisitionId: lot.id,
      marketplaceItemId,
      // An unenforced historical stamp: deleting the rule must never rewrite
      // recorded history.
      opportunityRuleId: crypto.randomUUID(),
      scoreAtLink: "0.8125",
      targetCurrency: "USD",
      targetPriceAmount: "240",
    });
    expect(link.linkKind).toBe("sourced_from");
    expect(link.scoreAtLink).toBe("0.8125");
    expect(link.targetPriceAmount).toBe("240.000000");

    const found = await links().listForAcquisition(lot.id);
    expect(found).toHaveLength(1);
  });

  it("requires a subject and evidence", async () => {
    await expect(
      links().link({ linkKind: "comparable", marketplaceItemId }),
    ).rejects.toThrow(InventoryValidationError);
  });

  it("requires a currency alongside a target price", async () => {
    const lot = await createAcquisitionsService({
      db: scratch.handle.db,
    }).create({
      title: "another lot",
      sourceKind: "auction_lot",
      currency: "USD",
    });
    await expect(
      links().link({
        linkKind: "evaluated_against",
        acquisitionId: lot.id,
        marketplaceItemId,
        targetPriceAmount: "50",
      }),
    ).rejects.toThrow(InventoryValidationError);
  });

  it("unlinks", async () => {
    const lot = await createAcquisitionsService({
      db: scratch.handle.db,
    }).create({
      title: "a mistaken link",
      sourceKind: "auction_lot",
      currency: "USD",
    });
    const link = await links().link({
      linkKind: "comparable",
      acquisitionId: lot.id,
      marketplaceItemId,
    });
    expect(await links().unlink(link.id)).toEqual({ removed: true });
    expect(await links().listForAcquisition(lot.id)).toHaveLength(0);
  });
});
