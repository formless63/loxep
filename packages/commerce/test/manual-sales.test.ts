/**
 * Manual sale recording integration tests against real PostgreSQL (design
 * 4a, open question 7, loxep-dgf.6).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecordingNotificationEnqueue } from "@loxep/domain";
import { createCatalogService } from "../src/catalog.ts";
import type { CatalogService, CatalogItemRow } from "../src/catalog.ts";
import { CommerceConflictError, CommerceValidationError } from "../src/errors.ts";
import {
  MANUAL_SOURCE_ACCOUNT_KEY,
  createManualSalesService,
} from "../src/manual-sales.ts";
import type { ManualSalesService } from "../src/manual-sales.ts";
import { createMigratedScratchDb, seedConnection } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("manual sale recording", () => {
  let scratch: ScratchDb;
  let catalog: CatalogService;
  let sales: ManualSalesService;
  let catalogItem: CatalogItemRow;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_manual_sales");
    catalog = createCatalogService({ db: scratch.handle.db });
    sales = createManualSalesService({ db: scratch.handle.db });
    catalogItem = await catalog.createCatalogItem({
      sku: "ITM-SALE1",
      name: "Sellable widget",
    });
  });

  afterAll(async () => {
    await scratch.close();
  });

  it("records the sale as a notification event and routes it (ADR-0023)", async () => {
    // Detection and delivery stay separate: the ledger row is written inside
    // the sale's own transaction, and routing only happens because a rule
    // named the `sale` class.
    const endpoint = await scratch.handle.db.execute<{ id: string }>(
      `insert into notification_endpoints (provider, name, config)
       values ('ntfy', 'sales', '{}'::jsonb) returning id`,
    );
    const endpointId = String(endpoint.rows[0]!["id"]);
    await scratch.handle.db.execute(
      `insert into notification_rules (name, event_class, endpoint_id)
       values ('any sale', 'sale', '${endpointId}')`,
    );
    const enqueue = createRecordingNotificationEnqueue();
    const notifying = createManualSalesService({
      db: scratch.handle.db,
      enqueue,
    });
    const listing = await catalog.createManualListing({
      catalogItemId: catalogItem.id,
      channel: "facebook_marketplace",
      status: "active",
      currency: "USD",
    });

    const result = await notifying.recordManualSale({
      channelListingId: listing.id,
      quantity: "1",
      unitPrice: "31.50",
    });

    const events = await scratch.handle.db.query.notificationEvents.findMany({
      where: (table, { eq }) =>
        eq(table.deduplicationKey, `order:${result.orderId}:manual_sale_recorded`),
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventClass).toBe("sale");
    expect(events[0]!.subjectType).toBe("order");
    expect(events[0]!.subjectId).toBe(result.orderId);
    expect((events[0]!.payload as Record<string, unknown>)["totalAmount"]).toBe(
      "31.500000",
    );
    expect(enqueue.calls).toHaveLength(1);
    expect(enqueue.calls[0]!.taskName).toBe("notifications.deliver");
  });

  it("records a sale: writes a manual order + line and marks the listing sold_out", async () => {
    const listing = await catalog.createManualListing({
      catalogItemId: catalogItem.id,
      channel: "facebook_marketplace",
      status: "active",
      currency: "USD",
    });

    const result = await sales.recordManualSale({
      channelListingId: listing.id,
      quantity: "1",
      unitPrice: "45.00",
    });

    expect(result.listingStatus).toBe("sold_out");
    expect(result.catalogItemId).toBe(catalogItem.id);

    const order = await scratch.handle.db.query.orders.findFirst({
      where: (table, { eq }) => eq(table.id, result.orderId),
    });
    expect(order?.provider).toBe("manual");
    expect(order?.connectionId).toBeNull();
    expect(order?.sourceAccountKey).toBe(MANUAL_SOURCE_ACCOUNT_KEY);
    expect(order?.status).toBe("completed");
    expect(order?.paymentStatus).toBe("paid");
    expect(order?.fulfillmentStatus).toBe("fulfilled");
    expect(order?.totalAmount).toBe("45.000000");

    const line = await scratch.handle.db.query.orderLines.findFirst({
      where: (table, { eq }) => eq(table.id, result.orderLineId),
    });
    expect(line?.channelListingId).toBe(listing.id);
    expect(line?.catalogItemId).toBe(catalogItem.id);
    expect(line?.unitPrice).toBe("45.000000");

    const refreshed = await catalog.getChannelListing(listing.id);
    expect(refreshed.status).toBe("sold_out");
    expect(refreshed.quantityAvailable).toBe(0);
    expect(refreshed.endedAt).not.toBeNull();
  });

  it("refuses a connector-synced listing — the manual recorder is manual-only", async () => {
    const connectionId = await seedConnection(scratch, { name: "store" });
    const connected = await catalog.upsertChannelListing({
      catalogItemId: catalogItem.id,
      connectionId,
      provider: "woocommerce",
      channel: "woocommerce",
      externalListingId: "5000",
    });
    await expect(
      sales.recordManualSale({
        channelListingId: connected.id,
        unitPrice: "10.00",
      }),
    ).rejects.toBeInstanceOf(CommerceValidationError);
  });

  it("refuses a listing that is already sold_out", async () => {
    const listing = await catalog.createManualListing({
      catalogItemId: catalogItem.id,
      channel: "craigslist",
      status: "active",
    });
    await sales.recordManualSale({ channelListingId: listing.id, unitPrice: "5.00" });
    await expect(
      sales.recordManualSale({ channelListingId: listing.id, unitPrice: "5.00" }),
    ).rejects.toBeInstanceOf(CommerceConflictError);
  });

  it("mints a fresh, unique external_order_id per manual sale", async () => {
    const first = await catalog.createManualListing({
      catalogItemId: catalogItem.id,
      channel: "in_person",
      status: "active",
    });
    const second = await catalog.createManualListing({
      catalogItemId: catalogItem.id,
      channel: "in_person",
      status: "active",
    });
    const a = await sales.recordManualSale({
      channelListingId: first.id,
      unitPrice: "12.00",
    });
    const b = await sales.recordManualSale({
      channelListingId: second.id,
      unitPrice: "12.00",
    });
    const orderA = await scratch.handle.db.query.orders.findFirst({
      where: (table, { eq }) => eq(table.id, a.orderId),
    });
    const orderB = await scratch.handle.db.query.orders.findFirst({
      where: (table, { eq }) => eq(table.id, b.orderId),
    });
    expect(orderA?.externalOrderId).not.toBe(orderB?.externalOrderId);
  });
});
