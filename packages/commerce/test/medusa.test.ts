/**
 * Medusa translation, ingestion idempotency, and incremental sync — against a
 * real PostgreSQL + TimescaleDB scratch database (never a SQLite
 * substitute). Mirrors `ebay.test.ts`'s structure exactly (loxep-xxz), with
 * the translator block pinning the five non-mechanical money mappings
 * `medusa.ts`'s module doc calls out — above all `originalTotal`-not-`total`
 * and the shipping subtraction, both load-bearing live findings from
 * `packages/integrations/medusa/src/orders.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEDUSA_DEFAULT_CHANNEL,
  MEDUSA_ORDER_OBJECT_TYPE,
  MEDUSA_PROVIDER,
  medusaOrderFactToCommerceFact,
} from "../src/medusa.ts";
import {
  DEFAULT_MEDUSA_SYNC_PER_PAGE,
  MEDUSA_ORDERS_TARGET_TYPE,
  createMedusaOrderSync,
  ensureMedusaOrderSyncTarget,
  readMedusaOrderSyncCursor,
} from "../src/medusa-sync.ts";
import type {
  MedusaOrderPageIterator,
  MedusaOrderPageLike,
} from "../src/medusa-sync.ts";
import { writeOrderSyncCursor } from "../src/sync.ts";
import { createOrderIngestionService } from "../src/orders.ts";
import type { OrderIngestionService } from "../src/orders.ts";
import { COMMERCE_SYNC_CONFIG_KEY, CURSOR_OVERLAP_SECONDS } from "../src/sync.ts";
import {
  SYNC_MEDUSA_ORDERS_TASK_NAME,
  createCommerceTasks,
  medusaOrderSyncJobKey,
} from "../src/tasks.ts";
import {
  medusaFulfillmentFact,
  medusaLineFact,
  medusaOrderFact,
  medusaRefundFact,
} from "./medusa-fixtures.ts";
import { createMigratedScratchDb, seedConnection, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

/* -------------------------------------------------------------- translator */

describe("medusaOrderFactToCommerceFact", () => {
  it("maps the provider-neutral identity columns", () => {
    const fact = medusaOrderFactToCommerceFact(medusaOrderFact());
    expect(fact.provider).toBe(MEDUSA_PROVIDER);
    expect(fact.channel).toBe(MEDUSA_DEFAULT_CHANNEL);
    // Medusa is self-hosted single-storefront — no sub-market to carry,
    // unlike eBay.
    expect(fact.marketplace).toBeNull();
    expect(fact.providerObjectType).toBe(MEDUSA_ORDER_OBJECT_TYPE);
    expect(fact.sourceAccountKey).toBe("medusa:https://shop.example.test");
    expect(fact.externalOrderNumber).toBe("1042");
  });

  it("honours a channel override", () => {
    const fact = medusaOrderFactToCommerceFact(medusaOrderFact(), {
      channel: "medusa-wholesale",
    });
    expect(fact.channel).toBe("medusa-wholesale");
  });

  it("copies the adapter's status projection through verbatim", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({
        status: "pending",
        paymentStatus: "unpaid",
        fulfillmentStatus: "unfulfilled",
        providerStatusRaw: "pending",
      }),
    );
    expect(fact.status).toBe("pending");
    expect(fact.paymentStatus).toBe("unpaid");
    expect(fact.fulfillmentStatus).toBe("unfulfilled");
    expect(fact.providerStatusRaw).toBe("pending");
  });

  /* ---- MAPPING #1: totalAmount <- originalTotal, never total ------------ */

  it("MAPPING #1: totalAmount is originalTotal, NEVER the refund-reduced total", () => {
    // Live-observed shape: a 30.00 order after a 5.00 refund reads
    // total=25.00, original_total=30.00. The fixture's default IS this case.
    const fact = medusaOrderFactToCommerceFact(medusaOrderFact());
    expect(fact.totalAmount).toBe("30.000000");
    // Not the moving `total`...
    expect(fact.totalAmount).not.toBe("25.000000");
    // ...and NEVER `total - refunded` (25.00 - 5.00 = 20.00), which would
    // double-count a subtraction Medusa already performed.
    expect(fact.totalAmount).not.toBe("20.000000");
  });

  it("MAPPING #1: refundedAmount is totals.refunded verbatim, no sign flip", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({ refunded: "5.00" }),
    );
    expect(fact.refundedAmount).toBe("5.000000");
  });

  /* ---- MAPPING #2: subtotalAmount = subtotal - shipping ------------------ */

  it("MAPPING #2: subtotalAmount subtracts shipping out of Medusa's shipping-inclusive subtotal", () => {
    // subtotal (30.00) INCLUDES shipping (10.00); CommerceOrderFact wants the
    // two as independent facts a read model sums itself.
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({ subtotal: "30.00", shipping: "10.00" }),
    );
    expect(fact.subtotalAmount).toBe("20.000000");
    expect(fact.shippingAmount).toBe("10.000000");
    // The naive (wrong) mapping would have left subtotal at 30.00, double
    // counting shipping when a read model adds subtotal + shipping.
    expect(fact.subtotalAmount).not.toBe("30.000000");
  });

  it("MAPPING #2: a zero-shipping order leaves subtotal untouched", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({ subtotal: "20.00", shipping: "0.00" }),
    );
    expect(fact.subtotalAmount).toBe("20.000000");
  });

  /* ---- MAPPING #3: no fee concept at all ---------------------------------- */

  it("MAPPING #3: feeAmount is an honest zero and fees is empty", () => {
    const fact = medusaOrderFactToCommerceFact(medusaOrderFact());
    expect(fact.feeAmount).toBe("0.000000");
    expect(fact.fees).toEqual([]);
  });

  /* ---- MAPPING #4: cancelledAt always null -------------------------------- */

  it("MAPPING #4: cancelledAt is always null, even for a cancelled order", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({
        status: "cancelled",
        paymentStatus: "failed",
        fulfillmentStatus: "cancelled",
      }),
    );
    expect(fact.status).toBe("cancelled");
    // Never substituted from `updatedAt` — that would fabricate a fact the
    // Admin API never states.
    expect(fact.cancelledAt).toBeNull();
  });

  /* ---- MAPPING #5: buyerDisplayName always null --------------------------- */

  it("MAPPING #5: buyerDisplayName is always null; buyerExternalId carries customer_id", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({ buyerExternalId: "cus_01BUYERFIXTURE" }),
    );
    expect(fact.buyerExternalId).toBe("cus_01BUYERFIXTURE");
    expect(fact.buyerDisplayName).toBeNull();
  });

  it("MAPPING #5: a guest order (no customer_id) still has a null buyerDisplayName", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({ buyerExternalId: null }),
    );
    expect(fact.buyerExternalId).toBeNull();
    expect(fact.buyerDisplayName).toBeNull();
  });

  /* ------------------------------------------------------------- sub-facts */

  it("maps a line: sku/name/tax/discount, and a flat unitPrice fallback", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({
        lineItems: [
          medusaLineFact({
            sku: "SKU-BETA",
            name: "Beta gadget",
            lineTax: "1.50",
            discount: "2.00",
          }),
        ],
      }),
    );
    expect(fact.lines[0]).toMatchObject({
      channelSku: "SKU-BETA",
      title: "Beta gadget",
      taxAmount: "1.500000",
      discountAmount: "2.000000",
    });
  });

  it("falls back to a flat zero unit price, never a derived quotient", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({
        lineItems: [medusaLineFact({ unitPrice: null })],
      }),
    );
    expect(fact.lines[0]?.unitPrice).toBe("0.000000");
  });

  it("lines carry zero shipping and zero refunded — Medusa reports neither per line", () => {
    const fact = medusaOrderFactToCommerceFact(medusaOrderFact());
    expect(fact.lines[0]?.shippingAmount).toBe("0.000000");
    expect(fact.lines[0]?.refundedAmount).toBe("0.000000");
  });

  it("maps a refund as a settled 'refund' with no per-line breakdown", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({
        refunds: [
          medusaRefundFact({
            externalRefundId: "ref_01ABC",
            reason: "damaged_in_transit",
            amount: "5.00",
            createdAt: "2026-08-02T09:00:00.000Z",
          }),
        ],
      }),
    );
    expect(fact.refunds).toHaveLength(1);
    expect(fact.refunds[0]).toMatchObject({
      externalRefundId: "ref_01ABC",
      // Every Medusa refund row is already settled — there is no
      // adapter-reported partial/full split to preserve.
      kind: "refund",
      status: "completed",
      reasonCode: "damaged_in_transit",
      currency: "USD",
      amount: "5.000000",
      refundedAt: "2026-08-02T09:00:00.000Z",
      lines: [],
    });
  });

  it("maps a fulfillment: status verbatim, and truncates to the first tracking label", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({
        fulfillments: [
          medusaFulfillmentFact({
            trackingNumbers: ["TRACK-A", "TRACK-B"],
            trackingUrls: ["https://a.example.invalid", "https://b.example.invalid"],
          }),
        ],
      }),
    );
    expect(fact.fulfillments).toHaveLength(1);
    expect(fact.fulfillments[0]).toMatchObject({
      status: "shipped",
      carrierCode: null,
      carrierName: null,
      serviceCode: null,
      // TRUNCATION: Medusa allows several labels; only the first is kept.
      trackingNumber: "TRACK-A",
      trackingUrl: "https://a.example.invalid",
      destinationCountry: "US",
      destinationRegion: "NY",
      // Documented adapter gap: no per-fulfillment, per-line quantities.
      lines: [],
    });
  });

  it("a fulfillment with no tracking label maps to null, not an empty string", () => {
    const fact = medusaOrderFactToCommerceFact(
      medusaOrderFact({
        fulfillments: [
          medusaFulfillmentFact({ trackingNumbers: [], trackingUrls: [] }),
        ],
      }),
    );
    expect(fact.fulfillments[0]?.trackingNumber).toBeNull();
    expect(fact.fulfillments[0]?.trackingUrl).toBeNull();
  });

  it("drops the retained payload when asked", () => {
    const fact = medusaOrderFactToCommerceFact(medusaOrderFact(), {
      retainRawPayload: false,
    });
    expect(fact.rawPayload).toBeNull();
  });
});

/* -------------------------------------------------------------- ingestion */

describe("medusa order ingestion", () => {
  let scratch: ScratchDb;
  let service: OrderIngestionService;
  let entityId: string;
  let connectionId: string;
  let secondConnectionId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_medusa");
    service = createOrderIngestionService({ db: scratch.handle.db });
    entityId = await seedEntity(scratch, "Syracuse Synergy LLC");
    connectionId = await seedConnection(scratch, {
      name: "medusa store",
      provider: "medusa",
      kind: "store",
      economicEntityId: entityId,
    });
    secondConnectionId = await seedConnection(scratch, {
      name: "medusa store (re-authorized)",
      provider: "medusa",
      kind: "store",
    });
  });

  afterAll(async () => {
    await scratch.close();
  });

  async function countRows(table: string, orderId: string): Promise<number> {
    const result = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n from ${table} where order_id = $1`,
      [orderId],
    );
    return Number(result.rows[0]?.n ?? "0");
  }

  it("creates an order with a line and a provenance link, fee_amount honest zero", async () => {
    const result = await service.ingestMedusaOrder({
      connectionId,
      fact: medusaOrderFact({ externalOrderId: "M-1001" }),
    });
    expect(result.created).toBe(true);
    expect(result.lineCount).toBe(1);
    expect(result.feeCount).toBe(0);
    expect(result.providerObjectId).not.toBeNull();
    expect(result.economicEntityId).toBe(entityId);
    expect(result.entityAttributionSource).toBe("connection_default");
    expect(await countRows("order_source_links", result.orderId)).toBe(1);

    const row = await scratch.handle.pool.query<{
      provider: string;
      marketplace: string | null;
      fee_amount: string;
      total_amount: string;
      buyer_display_name: string | null;
    }>(
      `select provider, marketplace, fee_amount, total_amount, buyer_display_name
         from orders where id = $1`,
      [result.orderId],
    );
    expect(row.rows[0]?.provider).toBe("medusa");
    expect(row.rows[0]?.marketplace).toBeNull();
    expect(Number(row.rows[0]?.fee_amount)).toBe(0);
    expect(Number(row.rows[0]?.total_amount)).toBeCloseTo(30, 6);
    expect(row.rows[0]?.buyer_display_name).toBeNull();
  });

  it("is idempotent: the same fact twice creates no duplicates", async () => {
    const fact = medusaOrderFact({ externalOrderId: "M-1002" });
    const first = await service.ingestMedusaOrder({ connectionId, fact });
    const second = await service.ingestMedusaOrder({ connectionId, fact });

    expect(second.orderId).toBe(first.orderId);
    expect(second.created).toBe(false);
    expect(second.effect).toBe("unchanged");
    expect(await countRows("order_lines", first.orderId)).toBe(1);
    // One payload hash -> one retained provider object, linked once.
    expect(second.providerObjectId).toBe(first.providerObjectId);
    expect(await countRows("order_source_links", first.orderId)).toBe(1);
  });

  it("attribution is written once and never rewritten by a later sync", async () => {
    const first = await service.ingestMedusaOrder({
      connectionId,
      fact: medusaOrderFact({ externalOrderId: "M-1003" }),
    });
    const second = await service.ingestMedusaOrder({
      connectionId,
      fact: medusaOrderFact({ externalOrderId: "M-1003", originalTotal: "80.00" }),
      economicEntityId: null,
    });
    expect(second.economicEntityId).toBe(first.economicEntityId);
    expect(second.entityAttributionSource).toBe("connection_default");
  });

  it("delete-and-replaces refunds and fulfillments, so a reversal disappears", async () => {
    const withAttachments = medusaOrderFact({
      externalOrderId: "M-1004",
      refunds: [medusaRefundFact()],
      fulfillments: [medusaFulfillmentFact()],
    });
    const first = await service.ingestMedusaOrder({
      connectionId,
      fact: withAttachments,
    });
    expect(first.refundCount).toBe(1);
    expect(first.fulfillmentCount).toBe(1);

    // A later sync reports the refund and shipment gone (a correction).
    const second = await service.ingestMedusaOrder({
      connectionId,
      fact: medusaOrderFact({
        externalOrderId: "M-1004",
        updatedAt: "2026-08-03T09:00:00.000Z",
        refunds: [],
        fulfillments: [],
      }),
    });
    expect(second.refundCount).toBe(0);
    expect(second.fulfillmentCount).toBe(0);
    expect(await countRows("order_refunds", first.orderId)).toBe(0);
    expect(await countRows("order_fulfillments", first.orderId)).toBe(0);
  });

  it("detects the same sale ingested through two connections", async () => {
    const fact = medusaOrderFact({ externalOrderId: "M-1005" });
    const first = await service.ingestMedusaOrder({ connectionId, fact });
    const second = await service.ingestMedusaOrder({
      connectionId: secondConnectionId,
      fact,
    });
    expect(second.orderId).not.toBe(first.orderId);
    expect(second.duplicateOfOrderId).toBe(first.orderId);

    const candidates = await service.findDuplicateOrderCandidates({
      provider: "medusa",
    });
    expect(
      candidates.some((row) => row.externalOrderId === "M-1005"),
    ).toBe(true);
  });

  it("puts no buyer PII in a domain column", async () => {
    const result = await service.ingestMedusaOrder({
      connectionId,
      fact: medusaOrderFact({ externalOrderId: "M-1006" }),
    });
    const row = await scratch.handle.pool.query<Record<string, unknown>>(
      `select * from orders where id = $1`,
      [result.orderId],
    );
    const serialized = JSON.stringify(row.rows[0]);
    for (const secret of [
      "fixture.person@example.invalid",
      "1 Fixture Way",
      "Fixture Person",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // …and the full payload IS recoverable from provenance.
    const payload = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n
         from provider_objects po
         join order_source_links l on l.provider_object_id = po.id
        where l.order_id = $1 and po.object_type = $2`,
      [result.orderId, MEDUSA_ORDER_OBJECT_TYPE],
    );
    expect(Number(payload.rows[0]?.n)).toBe(1);
  });
});

/* ------------------------------------------------------------------- sync */

describe("medusa order sync", () => {
  let scratch: ScratchDb;
  let connectionId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_medusa_sync");
    connectionId = await seedConnection(scratch, {
      name: "medusa store",
      provider: "medusa",
      kind: "store",
    });
  });

  afterAll(async () => {
    await scratch.close();
  });

  /** Canned pages plus a record of what the sync asked for. */
  function pageIterator(pagesByRun: Array<MedusaOrderPageLike[]>): {
    iterate: MedusaOrderPageIterator;
    calls: Array<{ modifiedAfter: Date | null; perPage: number; maxPages: number }>;
  } {
    const calls: Array<{
      modifiedAfter: Date | null;
      perPage: number;
      maxPages: number;
    }> = [];
    let run = 0;
    const iterate: MedusaOrderPageIterator = (input) => {
      calls.push({
        modifiedAfter: input.modifiedAfter,
        perPage: input.perPage,
        maxPages: input.maxPages,
      });
      const pages = pagesByRun[run] ?? [];
      run += 1;
      return (async function* () {
        for (const page of pages) yield page;
      })();
    };
    return { iterate, calls };
  }

  it("creates exactly one `medusa_orders` monitor target per connection", async () => {
    const first = await ensureMedusaOrderSyncTarget(scratch.handle.db, {
      connectionId,
    });
    const second = await ensureMedusaOrderSyncTarget(scratch.handle.db, {
      connectionId,
    });
    expect(second.monitorTargetId).toBe(first.monitorTargetId);

    const rows = await scratch.handle.pool.query<{
      n: string;
      target_type: string;
      name: string;
    }>(
      `select count(*)::text as n, min(target_type) as target_type, min(name) as name
         from monitor_targets where connection_id = $1`,
      [connectionId],
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
    expect(rows.rows[0]?.target_type).toBe(MEDUSA_ORDERS_TARGET_TYPE);
    expect(rows.rows[0]?.name).toContain("Medusa orders");
  });

  it("stores the cursor under the shared `commerceSync` namespace", async () => {
    const { iterate } = pageIterator([
      [
        {
          orders: [
            medusaOrderFact({
              externalOrderId: "S-1",
              updatedAt: "2026-08-01T12:00:00.000Z",
            }),
            medusaOrderFact({
              externalOrderId: "S-2",
              updatedAt: "2026-08-01T12:30:00.000Z",
            }),
          ],
        },
      ],
    ]);
    const sync = createMedusaOrderSync({
      db: scratch.handle.db,
      iterateOrders: iterate,
    });
    const result = await sync.syncConnection({ connectionId });

    expect(result.ordersSeen).toBe(2);
    expect(result.created).toBe(2);
    expect(result.currencies).toEqual(["USD"]);
    // High watermark, rewound by the shared overlap so a same-instant tie
    // across a page boundary is re-read rather than lost.
    expect(result.nextModifiedAfter?.toISOString()).toBe(
      new Date(
        Date.parse("2026-08-01T12:30:00.000Z") - CURSOR_OVERLAP_SECONDS * 1000,
      ).toISOString(),
    );

    const row = await scratch.handle.pool.query<{ config: unknown }>(
      `select config from monitor_targets
        where connection_id = $1 and target_type = $2`,
      [connectionId, MEDUSA_ORDERS_TARGET_TYPE],
    );
    const config = row.rows[0]?.config as Record<string, Record<string, unknown>>;
    expect(config[COMMERCE_SYNC_CONFIG_KEY]?.["lastOrderCount"]).toBe(2);
    expect(config[COMMERCE_SYNC_CONFIG_KEY]?.["modifiedAfter"]).toBe(
      result.nextModifiedAfter?.toISOString(),
    );
  });

  it("re-reads a cursor whose stored watermark is null (zero-order first sync)", async () => {
    // Regression (live eBay orders, 2026-08-13, and the reason
    // `commerceSyncStateSchema` is nullable): a first sync that saw no
    // orders persists `modifiedAfter: null`. The read path — the one the
    // executor validates through — must accept it for every commerce
    // provider, Medusa included.
    const cursor = await ensureMedusaOrderSyncTarget(scratch.handle.db, {
      connectionId,
    });
    await writeOrderSyncCursor(scratch.handle.db, cursor.monitorTargetId, {
      modifiedAfter: null,
    });
    const reread = await readMedusaOrderSyncCursor(scratch.handle.db, connectionId);
    expect(reread).not.toBeNull();
    expect(reread?.modifiedAfter).toBeNull();
    // And a second sync through the same cursor must not throw.
    const { iterate: iterate2 } = pageIterator([[{ orders: [] }]]);
    const sync2 = createMedusaOrderSync({
      db: scratch.handle.db,
      iterateOrders: iterate2,
    });
    await expect(sync2.syncConnection({ connectionId })).resolves.toMatchObject({
      ordersSeen: 0,
    });
  });

  it("hands the stored watermark to the next run, with Medusa's own defaults", async () => {
    const { iterate, calls } = pageIterator([[{ orders: [] }]]);
    const sync = createMedusaOrderSync({
      db: scratch.handle.db,
      iterateOrders: iterate,
    });
    const cursor = await readMedusaOrderSyncCursor(scratch.handle.db, connectionId);
    await sync.syncConnection({ connectionId });
    expect(calls[0]?.modifiedAfter?.toISOString()).toBe(
      cursor?.modifiedAfter?.toISOString(),
    );
    expect(calls[0]?.perPage).toBe(DEFAULT_MEDUSA_SYNC_PER_PAGE);
  });

  it("counts a re-sync of the same orders as unchanged (idempotent re-run)", async () => {
    const page: MedusaOrderPageLike = {
      orders: [
        medusaOrderFact({
          externalOrderId: "S-3",
          updatedAt: "2026-08-02T09:00:00.000Z",
        }),
      ],
    };
    const { iterate } = pageIterator([[page], [page]]);
    const sync = createMedusaOrderSync({
      db: scratch.handle.db,
      iterateOrders: iterate,
    });
    const first = await sync.syncConnection({ connectionId });
    const second = await sync.syncConnection({ connectionId });
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("honours a dry run by leaving the cursor untouched", async () => {
    const before = await readMedusaOrderSyncCursor(scratch.handle.db, connectionId);
    const { iterate } = pageIterator([
      [
        {
          orders: [
            medusaOrderFact({
              externalOrderId: "S-4",
              updatedAt: "2026-09-01T09:00:00.000Z",
            }),
          ],
        },
      ],
    ]);
    const sync = createMedusaOrderSync({
      db: scratch.handle.db,
      iterateOrders: iterate,
    });
    await sync.syncConnection({ connectionId, persistCursor: false });
    const after = await readMedusaOrderSyncCursor(scratch.handle.db, connectionId);
    expect(after?.modifiedAfter?.toISOString()).toBe(
      before?.modifiedAfter?.toISOString(),
    );
  });

  it("propagates a thrown fail-open canary rather than swallowing it", async () => {
    // The composition root binds `iterateMedusaOrders`, whose
    // `assertWatermarkHonored` canary throws when Medusa's filter fails
    // open. This sync service must not catch it.
    const iterate: MedusaOrderPageIterator = () => {
      throw new Error("provider_unavailable: watermark not honoured");
    };
    const sync = createMedusaOrderSync({ db: scratch.handle.db, iterateOrders: iterate });
    await expect(sync.syncConnection({ connectionId })).rejects.toThrow(
      /watermark not honoured/,
    );
  });
});

describe("medusa commerce task registration", () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_medusa_tasks");
  });

  afterAll(async () => {
    await scratch.close();
  });

  it("omits the Medusa task when the composition root binds no page iterator", () => {
    const commerce = createCommerceTasks({
      db: scratch.handle.db,
      adapterFactory: () => {
        throw new Error("not used");
      },
    });
    expect(commerce.medusaSync).toBeNull();
    expect(commerce.syncMedusaOrdersTask).toBeNull();
    expect(commerce.tasks.map((task) => task.name)).toEqual([
      "commerce.sync-woo-orders",
      "commerce.redact-order-payloads",
    ]);
  });

  it("registers `commerce.sync-medusa-orders` when the seam is supplied", () => {
    const commerce = createCommerceTasks({
      db: scratch.handle.db,
      adapterFactory: () => {
        throw new Error("not used");
      },
      iterateMedusaOrders: () =>
        (async function* () {
          // no pages
        })(),
    });
    expect(commerce.medusaSync).not.toBeNull();
    expect(commerce.tasks.map((task) => task.name)).toEqual([
      "commerce.sync-woo-orders",
      SYNC_MEDUSA_ORDERS_TASK_NAME,
      "commerce.redact-order-payloads",
    ]);
  });

  it("registers all three optional-leg tasks together, in a stable order", () => {
    const commerce = createCommerceTasks({
      db: scratch.handle.db,
      adapterFactory: () => {
        throw new Error("not used");
      },
      iterateEbayOrders: () =>
        (async function* () {
          // no pages
        })(),
      iterateMedusaOrders: () =>
        (async function* () {
          // no pages
        })(),
    });
    expect(commerce.tasks.map((task) => task.name)).toEqual([
      "commerce.sync-woo-orders",
      "commerce.sync-ebay-orders",
      SYNC_MEDUSA_ORDERS_TASK_NAME,
      "commerce.redact-order-payloads",
    ]);
  });

  it("keys one queued sync per connection", () => {
    expect(medusaOrderSyncJobKey("c-1")).toContain(SYNC_MEDUSA_ORDERS_TASK_NAME);
    expect(medusaOrderSyncJobKey("c-1")).not.toBe(medusaOrderSyncJobKey("c-2"));
  });
});
