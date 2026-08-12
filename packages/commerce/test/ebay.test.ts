/**
 * eBay translation, ingestion idempotency, and incremental sync — against a
 * real PostgreSQL + TimescaleDB scratch database (never a SQLite substitute).
 *
 * Same four idempotency obligations the design document imposes on every
 * ingestion path, applied to the second provider: the same payload twice, an
 * out-of-order update, an attachment rewrite, and cross-connection duplicate
 * detection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EBAY_DEFAULT_CHANNEL,
  EBAY_ORDER_OBJECT_TYPE,
  EBAY_PROVIDER,
  ebayOrderFactToCommerceFact,
} from "../src/ebay.ts";
import {
  DEFAULT_EBAY_SYNC_PER_PAGE,
  EBAY_ORDERS_TARGET_TYPE,
  createEbayOrderSync,
  ensureEbayOrderSyncTarget,
  readEbayOrderSyncCursor,
} from "../src/ebay-sync.ts";
import type {
  EbayOrderPageIterator,
  EbayOrderPageLike,
} from "../src/ebay-sync.ts";
import { createOrderIngestionService } from "../src/orders.ts";
import type { OrderIngestionService } from "../src/orders.ts";
import {
  COMMERCE_SYNC_CONFIG_KEY,
  CURSOR_OVERLAP_SECONDS,
} from "../src/sync.ts";
import {
  SYNC_EBAY_ORDERS_TASK_NAME,
  createCommerceTasks,
  ebayOrderSyncJobKey,
} from "../src/tasks.ts";
import { ebayLineFact, ebayOrderFact } from "./ebay-fixtures.ts";
import { createMigratedScratchDb, seedConnection, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

/* -------------------------------------------------------------- translator */

describe("ebayOrderFactToCommerceFact", () => {
  it("maps the provider-neutral identity columns", () => {
    const fact = ebayOrderFactToCommerceFact(ebayOrderFact());
    expect(fact.provider).toBe(EBAY_PROVIDER);
    expect(fact.channel).toBe(EBAY_DEFAULT_CHANNEL);
    // eBay HAS a sub-market, unlike a single-storefront Woo installation.
    expect(fact.marketplace).toBe("EBAY_US");
    expect(fact.providerObjectType).toBe(EBAY_ORDER_OBJECT_TYPE);
    expect(fact.sourceAccountKey).toBe("ebay:sandbox-seller-01");
    expect(fact.externalOrderNumber).toBe("8241");
  });

  it("honours a channel override without touching the marketplace", () => {
    const fact = ebayOrderFactToCommerceFact(ebayOrderFact(), {
      channel: "ebay-motors",
    });
    expect(fact.channel).toBe("ebay-motors");
    expect(fact.marketplace).toBe("EBAY_US");
  });

  it("puts a REAL seller-side magnitude in fee_amount, unlike the Woo leg", () => {
    const fact = ebayOrderFactToCommerceFact(ebayOrderFact());
    expect(fact.feeAmount).toBe("9.870000");
    expect(fact.fees).toHaveLength(1);
    expect(fact.fees[0]).toMatchObject({
      feeDirection: "seller_charge",
      feeType: "marketplace_final_value",
      providerFeeCode: "totalMarketplaceFee",
      feeScope: "order",
      lineNumber: null,
      amount: "9.870000",
    });
  });

  it("keeps a buyer surcharge out of the seller-fee rollup", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({
        fees: [
          {
            externalFeeId: "ebay:pricing-summary-fee",
            feeType: "buyer_surcharge",
            feeDirection: "buyer_surcharge",
            providerFeeCode: "pricingSummary.fee",
            description: "Buyer-paid fee",
            currency: "USD",
            amount: "1.50",
          },
        ],
        fee: "0.00",
      }),
    );
    expect(fact.feeAmount).toBe("0.000000");
    expect(fact.fees[0]?.feeDirection).toBe("buyer_surcharge");
  });

  it("copies the adapter's status projection through verbatim", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({
        status: "open",
        paymentStatus: "partially_refunded",
        fulfillmentStatus: "partially_fulfilled",
        providerStatusRaw: "PARTIALLY_REFUNDED/IN_PROGRESS",
      }),
    );
    expect(fact.status).toBe("open");
    expect(fact.paymentStatus).toBe("partially_refunded");
    // The `unknown`/`partially_fulfilled` decision belongs to the ADAPTER;
    // this translator must never "fix" a status (loxep-xh9.7.3).
    expect(fact.fulfillmentStatus).toBe("partially_fulfilled");
    expect(fact.providerStatusRaw).toBe("PARTIALLY_REFUNDED/IN_PROGRESS");
  });

  it("passes `unknown` through untouched", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({ fulfillmentStatus: "unknown" }),
    );
    expect(fact.fulfillmentStatus).toBe("unknown");
  });

  it("populates buyer_display_name with the eBay USERNAME", () => {
    const fact = ebayOrderFactToCommerceFact(ebayOrderFact());
    expect(fact.buyerExternalId).toBe("sandbox-buyer-01");
    // Design open question 8 names exactly this case: a channel-native handle
    // is what the column is for. Woo leaves it null; eBay does not have to.
    expect(fact.buyerDisplayName).toBe("sandbox-buyer-01");
  });

  it("apportions shipping per line — eBay reports deliveryCost per line", () => {
    const fact = ebayOrderFactToCommerceFact(ebayOrderFact());
    expect(fact.lines[0]?.shippingAmount).toBe("5.000000");
  });

  it("falls back to the exact quotient when the adapter reports no unit price", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({
        lineItems: [
          ebayLineFact({ unitPrice: null, lineSubtotal: "10.00", quantity: "4" }),
        ],
      }),
    );
    expect(fact.lines[0]?.unitPrice).toBe("2.500000");
  });

  it("rounds only as a last resort, and never derives a total from it", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({
        lineItems: [
          ebayLineFact({
            unitPrice: null,
            lineSubtotal: "10.00",
            quantity: "3",
            lineTotal: "10.00",
          }),
        ],
      }),
    );
    expect(fact.lines[0]?.unitPrice).toBe("3.333333");
    // The provider's own total is untouched by the rounded unit price.
    expect(fact.lines[0]?.lineTotal).toBe("10.000000");
  });

  it("matches refund lines onto line numbers", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({
        paymentStatus: "partially_refunded",
        refunded: "20.00",
        refunds: [
          {
            externalRefundId: "5001",
            status: "completed",
            currency: "USD",
            amount: "20.00",
            refundedAt: "2026-08-02T09:00:00.000Z",
            lines: [{ externalLineId: "10101010", amount: "20.00" }],
          },
        ],
      }),
    );
    expect(fact.refunds[0]?.kind).toBe("partial_refund");
    expect(fact.refunds[0]?.lines).toEqual([
      { lineNumber: 1, quantity: null, amount: "20.000000" },
    ]);
  });

  it("keeps an unmatched refund line as an order-level refund line", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({
        refunds: [
          {
            externalRefundId: "5002",
            status: "completed",
            currency: "USD",
            amount: "1.00",
            refundedAt: null,
            lines: [{ externalLineId: "not-on-this-order", amount: "1.00" }],
          },
        ],
      }),
    );
    // `order_refund_lines.order_line_id` is nullable exactly for this.
    expect(fact.refunds[0]?.lines[0]?.lineNumber).toBeNull();
  });

  it("calls a fully refunded order's refund a `refund`, not a partial", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({
        paymentStatus: "refunded",
        refunds: [
          {
            externalRefundId: "5003",
            status: "completed",
            currency: "USD",
            amount: "74.60",
            refundedAt: null,
            lines: [],
          },
        ],
      }),
    );
    expect(fact.refunds[0]?.kind).toBe("refund");
  });

  it("writes NO fulfillment rows when the fetch did not read them", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({ fulfillments: null }),
    );
    // null means "we did not look" — nothing is ever synthesized for eBay,
    // unlike the Woo leg's `completed` order.
    expect(fact.fulfillments).toEqual([]);
  });

  it("maps a real shipment with its per-line quantities and destination", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({
        fulfillments: [
          {
            externalFulfillmentId: "9405511899223197428490",
            status: "shipped",
            carrierCode: "USPS",
            trackingNumber: "9405511899223197428490",
            shippedAt: "2026-08-01T18:00:00.000Z",
            lines: [{ externalLineId: "10101010", quantity: "2" }],
          },
        ],
      }),
    );
    expect(fact.fulfillments).toHaveLength(1);
    expect(fact.fulfillments[0]).toMatchObject({
      externalFulfillmentId: "9405511899223197428490",
      status: "shipped",
      carrierCode: "USPS",
      // eBay reports no carrier display name and no tracking URL; guessing
      // either would invent a fact.
      carrierName: null,
      trackingUrl: null,
      deliveredAt: null,
      destinationCountry: "US",
      destinationRegion: "NY",
    });
    expect(fact.fulfillments[0]?.lines).toEqual([
      { lineNumber: 1, quantity: "2.000000" },
    ]);
  });

  it("drops a shipment line naming a line this order does not have", () => {
    const fact = ebayOrderFactToCommerceFact(
      ebayOrderFact({
        fulfillments: [
          {
            externalFulfillmentId: "F1",
            status: "shipped",
            carrierCode: null,
            trackingNumber: null,
            shippedAt: null,
            lines: [
              { externalLineId: "10101010", quantity: "2" },
              { externalLineId: "ghost", quantity: "1" },
            ],
          },
        ],
      }),
    );
    // `order_fulfillment_lines.order_line_id` is NOT NULL; the disagreement is
    // a reconciliation finding, not something to fabricate a line for.
    expect(fact.fulfillments[0]?.lines).toEqual([
      { lineNumber: 1, quantity: "2.000000" },
    ]);
  });

  it("drops the retained payload when asked", () => {
    const fact = ebayOrderFactToCommerceFact(ebayOrderFact(), {
      retainRawPayload: false,
    });
    expect(fact.rawPayload).toBeNull();
  });
});

/* -------------------------------------------------------------- ingestion */

describe("ebay order ingestion", () => {
  let scratch: ScratchDb;
  let service: OrderIngestionService;
  let entityId: string;
  let connectionId: string;
  let secondConnectionId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_ebay");
    service = createOrderIngestionService({ db: scratch.handle.db });
    entityId = await seedEntity(scratch, "Syracuse Synergy LLC");
    connectionId = await seedConnection(scratch, {
      name: "ebay seller",
      provider: "ebay",
      kind: "marketplace",
      economicEntityId: entityId,
    });
    secondConnectionId = await seedConnection(scratch, {
      name: "ebay seller (re-authorized)",
      provider: "ebay",
      kind: "marketplace",
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

  it("creates an order with lines, a fee, and a provenance link", async () => {
    const result = await service.ingestEbayOrder({
      connectionId,
      fact: ebayOrderFact({ externalOrderId: "E-1001" }),
    });
    expect(result.created).toBe(true);
    expect(result.lineCount).toBe(1);
    expect(result.feeCount).toBe(1);
    expect(result.providerObjectId).not.toBeNull();
    expect(result.economicEntityId).toBe(entityId);
    expect(result.entityAttributionSource).toBe("connection_default");
    expect(await countRows("order_source_links", result.orderId)).toBe(1);

    const row = await scratch.handle.pool.query<{
      provider: string;
      marketplace: string | null;
      fee_amount: string;
      buyer_display_name: string | null;
      provider_status_raw: string | null;
    }>(
      `select provider, marketplace, fee_amount, buyer_display_name, provider_status_raw
         from orders where id = $1`,
      [result.orderId],
    );
    expect(row.rows[0]?.provider).toBe("ebay");
    expect(row.rows[0]?.marketplace).toBe("EBAY_US");
    expect(Number(row.rows[0]?.fee_amount)).toBeCloseTo(9.87, 6);
    expect(row.rows[0]?.buyer_display_name).toBe("sandbox-buyer-01");
    expect(row.rows[0]?.provider_status_raw).toBe("PAID/FULFILLED");
  });

  it("is idempotent: the same fact twice creates no duplicates", async () => {
    const fact = ebayOrderFact({ externalOrderId: "E-1002" });
    const first = await service.ingestEbayOrder({ connectionId, fact });
    const second = await service.ingestEbayOrder({ connectionId, fact });

    expect(second.orderId).toBe(first.orderId);
    expect(second.created).toBe(false);
    expect(second.effect).toBe("unchanged");
    expect(await countRows("order_lines", first.orderId)).toBe(1);
    expect(await countRows("order_fees", first.orderId)).toBe(1);
    // One payload hash → one retained provider object, linked once.
    expect(second.providerObjectId).toBe(first.providerObjectId);
    expect(await countRows("order_source_links", first.orderId)).toBe(1);
  });

  it("records a second provenance link when the payload actually changed", async () => {
    const first = await service.ingestEbayOrder({
      connectionId,
      fact: ebayOrderFact({
        externalOrderId: "E-1003",
        fulfillmentStatus: "unfulfilled",
        status: "open",
        updatedAt: "2026-08-01T12:00:00.000Z",
      }),
    });
    const second = await service.ingestEbayOrder({
      connectionId,
      fact: ebayOrderFact({
        externalOrderId: "E-1003",
        fulfillmentStatus: "fulfilled",
        status: "completed",
        updatedAt: "2026-08-01T13:00:00.000Z",
      }),
    });
    expect(second.orderId).toBe(first.orderId);
    expect(second.effect).toBe("updated");
    expect(second.providerObjectId).not.toBe(first.providerObjectId);
    expect(await countRows("order_source_links", first.orderId)).toBe(2);
  });

  it("attribution is written once and never rewritten by a later sync", async () => {
    const first = await service.ingestEbayOrder({
      connectionId,
      fact: ebayOrderFact({ externalOrderId: "E-1004" }),
    });
    const second = await service.ingestEbayOrder({
      connectionId,
      fact: ebayOrderFact({ externalOrderId: "E-1004", total: "80.00" }),
      economicEntityId: null,
    });
    expect(second.economicEntityId).toBe(first.economicEntityId);
    expect(second.entityAttributionSource).toBe("connection_default");
  });

  it("rewrites attachments in place across a line renumbering", async () => {
    const two = [
      ebayLineFact({ externalLineId: "L-A", lineNumber: 1 }),
      ebayLineFact({
        externalLineId: "L-B",
        lineNumber: 2,
        sku: "SKU-BETA",
        name: "Beta gadget",
      }),
    ];
    const first = await service.ingestEbayOrder({
      connectionId,
      fact: ebayOrderFact({ externalOrderId: "E-1005", lineItems: two }),
    });
    expect(first.lineCount).toBe(2);
    const lineIdsBefore = await scratch.handle.pool.query<{
      id: string;
      external_line_id: string;
    }>(
      `select id, external_line_id from order_lines where order_id = $1 order by line_number`,
      [first.orderId],
    );

    // eBay drops the first line and renumbers: L-B becomes line 1.
    const second = await service.ingestEbayOrder({
      connectionId,
      fact: ebayOrderFact({
        externalOrderId: "E-1005",
        updatedAt: "2026-08-02T12:00:00.000Z",
        lineItems: [
          ebayLineFact({
            externalLineId: "L-B",
            lineNumber: 1,
            sku: "SKU-BETA",
            name: "Beta gadget",
          }),
        ],
      }),
    });
    expect(second.lineCount).toBe(1);
    const lineIdsAfter = await scratch.handle.pool.query<{
      id: string;
      external_line_id: string;
    }>(`select id, external_line_id from order_lines where order_id = $1`, [
      first.orderId,
    ]);
    expect(lineIdsAfter.rows).toHaveLength(1);
    // The surviving line KEEPS its id, so refund/fulfillment references hold.
    const before = lineIdsBefore.rows.find(
      (row) => row.external_line_id === "L-B",
    );
    expect(lineIdsAfter.rows[0]?.id).toBe(before?.id);
  });

  it("delete-and-replaces refunds and fulfillments, so a reversal disappears", async () => {
    const withAttachments = ebayOrderFact({
      externalOrderId: "E-1006",
      paymentStatus: "partially_refunded",
      refunded: "20.00",
      refunds: [
        {
          externalRefundId: "R-1",
          status: "completed",
          currency: "USD",
          amount: "20.00",
          refundedAt: "2026-08-02T09:00:00.000Z",
          lines: [{ externalLineId: "10101010", amount: "20.00" }],
        },
      ],
      fulfillments: [
        {
          externalFulfillmentId: "F-1",
          status: "shipped",
          carrierCode: "USPS",
          trackingNumber: "TRACK-1",
          shippedAt: "2026-08-01T18:00:00.000Z",
          lines: [{ externalLineId: "10101010", quantity: "2" }],
        },
      ],
    });
    const first = await service.ingestEbayOrder({
      connectionId,
      fact: withAttachments,
    });
    expect(first.refundCount).toBe(1);
    expect(first.fulfillmentCount).toBe(1);
    const refundLines = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n
         from order_refund_lines rl
         join order_refunds r on r.id = rl.order_refund_id
        where r.order_id = $1`,
      [first.orderId],
    );
    expect(Number(refundLines.rows[0]?.n)).toBe(1);

    // eBay reverses the refund and the shipment on a later sync.
    const second = await service.ingestEbayOrder({
      connectionId,
      fact: ebayOrderFact({
        externalOrderId: "E-1006",
        updatedAt: "2026-08-03T09:00:00.000Z",
        fulfillments: [],
      }),
    });
    expect(second.refundCount).toBe(0);
    expect(second.fulfillmentCount).toBe(0);
    expect(await countRows("order_refunds", first.orderId)).toBe(0);
    expect(await countRows("order_fulfillments", first.orderId)).toBe(0);
  });

  it("survives out-of-order delivery of the same order", async () => {
    const newer = ebayOrderFact({
      externalOrderId: "E-1007",
      status: "completed",
      updatedAt: "2026-08-05T12:00:00.000Z",
      total: "99.00",
    });
    const older = ebayOrderFact({
      externalOrderId: "E-1007",
      status: "open",
      fulfillmentStatus: "unfulfilled",
      updatedAt: "2026-08-04T12:00:00.000Z",
      total: "74.60",
    });
    const first = await service.ingestEbayOrder({ connectionId, fact: newer });
    const second = await service.ingestEbayOrder({ connectionId, fact: older });
    // At-least-once delivery can replay an older payload; the row must remain
    // ONE order and stay consistent with whatever arrived last.
    expect(second.orderId).toBe(first.orderId);
    expect(await countRows("order_lines", first.orderId)).toBe(1);
    const orders = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n from orders where external_order_id = $1`,
      ["E-1007"],
    );
    expect(Number(orders.rows[0]?.n)).toBe(1);
  });

  it("detects the same sale ingested through two connections", async () => {
    const fact = ebayOrderFact({ externalOrderId: "E-1008" });
    const first = await service.ingestEbayOrder({ connectionId, fact });
    const second = await service.ingestEbayOrder({
      connectionId: secondConnectionId,
      fact,
    });
    expect(second.orderId).not.toBe(first.orderId);
    // Detect, do not constrain: the later row points at the canonical one.
    expect(second.duplicateOfOrderId).toBe(first.orderId);

    const candidates = await service.findDuplicateOrderCandidates({
      provider: "ebay",
    });
    expect(
      candidates.some((row) => row.externalOrderId === "E-1008"),
    ).toBe(true);
  });

  it("puts no buyer PII in a domain column", async () => {
    const result = await service.ingestEbayOrder({
      connectionId,
      fact: ebayOrderFact({ externalOrderId: "E-1009" }),
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
      [result.orderId, EBAY_ORDER_OBJECT_TYPE],
    );
    expect(Number(payload.rows[0]?.n)).toBe(1);
  });
});

/* ------------------------------------------------------------------- sync */

describe("ebay order sync", () => {
  let scratch: ScratchDb;
  let connectionId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_ebay_sync");
    connectionId = await seedConnection(scratch, {
      name: "ebay seller",
      provider: "ebay",
      kind: "marketplace",
    });
  });

  afterAll(async () => {
    await scratch.close();
  });

  /** Canned pages plus a record of what the sync asked for. */
  function pageIterator(
    pagesByRun: Array<EbayOrderPageLike[]>,
  ): {
    iterate: EbayOrderPageIterator;
    calls: Array<{
      modifiedAfter: Date | null;
      perPage: number;
      maxPages: number;
      includeFulfillments: boolean;
    }>;
  } {
    const calls: Array<{
      modifiedAfter: Date | null;
      perPage: number;
      maxPages: number;
      includeFulfillments: boolean;
    }> = [];
    let run = 0;
    const iterate: EbayOrderPageIterator = (input) => {
      calls.push({
        modifiedAfter: input.modifiedAfter,
        perPage: input.perPage,
        maxPages: input.maxPages,
        includeFulfillments: input.includeFulfillments,
      });
      const pages = pagesByRun[run] ?? [];
      run += 1;
      return (async function* () {
        for (const page of pages) yield page;
      })();
    };
    return { iterate, calls };
  }

  it("creates exactly one `ebay_orders` monitor target per connection", async () => {
    const first = await ensureEbayOrderSyncTarget(scratch.handle.db, {
      connectionId,
    });
    const second = await ensureEbayOrderSyncTarget(scratch.handle.db, {
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
    expect(rows.rows[0]?.target_type).toBe(EBAY_ORDERS_TARGET_TYPE);
    expect(rows.rows[0]?.name).toContain("eBay orders");
  });

  it("stores the cursor under the shared `commerceSync` namespace", async () => {
    const { iterate } = pageIterator([
      [
        {
          orders: [
            ebayOrderFact({
              externalOrderId: "S-1",
              updatedAt: "2026-08-01T12:00:00.000Z",
            }),
            ebayOrderFact({
              externalOrderId: "S-2",
              updatedAt: "2026-08-01T12:30:00.000Z",
            }),
          ],
        },
      ],
    ]);
    const sync = createEbayOrderSync({ db: scratch.handle.db, iterateOrders: iterate });
    const result = await sync.syncConnection({ connectionId });

    expect(result.ordersSeen).toBe(2);
    expect(result.created).toBe(2);
    expect(result.currencies).toEqual(["USD"]);
    // High watermark, rewound by the overlap so a same-instant tie across a
    // page boundary is re-read rather than lost.
    expect(result.nextModifiedAfter?.toISOString()).toBe(
      new Date(
        Date.parse("2026-08-01T12:30:00.000Z") - CURSOR_OVERLAP_SECONDS * 1000,
      ).toISOString(),
    );

    const row = await scratch.handle.pool.query<{ config: unknown }>(
      `select config from monitor_targets
        where connection_id = $1 and target_type = $2`,
      [connectionId, EBAY_ORDERS_TARGET_TYPE],
    );
    const config = row.rows[0]?.config as Record<string, Record<string, unknown>>;
    expect(config[COMMERCE_SYNC_CONFIG_KEY]?.["lastOrderCount"]).toBe(2);
    expect(config[COMMERCE_SYNC_CONFIG_KEY]?.["modifiedAfter"]).toBe(
      result.nextModifiedAfter?.toISOString(),
    );
  });

  it("hands the stored watermark to the next run", async () => {
    const { iterate, calls } = pageIterator([[{ orders: [] }]]);
    const sync = createEbayOrderSync({ db: scratch.handle.db, iterateOrders: iterate });
    const cursor = await readEbayOrderSyncCursor(scratch.handle.db, connectionId);
    await sync.syncConnection({ connectionId });
    expect(calls[0]?.modifiedAfter?.toISOString()).toBe(
      cursor?.modifiedAfter?.toISOString(),
    );
    expect(calls[0]?.perPage).toBe(DEFAULT_EBAY_SYNC_PER_PAGE);
    // Shipments are read by default: eBay has REAL fulfillment objects, and
    // the alternative is a `fulfilled` order with no shipment behind it.
    expect(calls[0]?.includeFulfillments).toBe(true);
  });

  it("counts a re-sync of the same orders as unchanged", async () => {
    const page: EbayOrderPageLike = {
      orders: [
        ebayOrderFact({
          externalOrderId: "S-3",
          updatedAt: "2026-08-02T09:00:00.000Z",
        }),
      ],
    };
    const { iterate } = pageIterator([[page], [page]]);
    const sync = createEbayOrderSync({ db: scratch.handle.db, iterateOrders: iterate });
    const first = await sync.syncConnection({ connectionId });
    const second = await sync.syncConnection({ connectionId });
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("surfaces unrecognized provider statuses instead of swallowing them", async () => {
    const { iterate } = pageIterator([
      [
        {
          orders: [
            ebayOrderFact({
              externalOrderId: "S-4",
              fulfillmentStatus: "unknown",
              providerStatusRaw: "PAID/SHIPPED_ON_A_TUESDAY",
              updatedAt: "2026-08-03T09:00:00.000Z",
            }),
          ],
        },
      ],
    ]);
    const sync = createEbayOrderSync({ db: scratch.handle.db, iterateOrders: iterate });
    const result = await sync.syncConnection({ connectionId });
    expect(result.unrecognizedStatuses).toEqual(["PAID/SHIPPED_ON_A_TUESDAY"]);
  });

  it("honours a dry run by leaving the cursor untouched", async () => {
    const before = await readEbayOrderSyncCursor(scratch.handle.db, connectionId);
    const { iterate } = pageIterator([
      [
        {
          orders: [
            ebayOrderFact({
              externalOrderId: "S-5",
              updatedAt: "2026-09-01T09:00:00.000Z",
            }),
          ],
        },
      ],
    ]);
    const sync = createEbayOrderSync({ db: scratch.handle.db, iterateOrders: iterate });
    await sync.syncConnection({ connectionId, persistCursor: false });
    const after = await readEbayOrderSyncCursor(scratch.handle.db, connectionId);
    expect(after?.modifiedAfter?.toISOString()).toBe(
      before?.modifiedAfter?.toISOString(),
    );
  });
});

describe("commerce task registration", () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_ebay_tasks");
  });

  afterAll(async () => {
    await scratch.close();
  });

  it("omits the eBay task when the composition root binds no page iterator", () => {
    const commerce = createCommerceTasks({
      db: scratch.handle.db,
      adapterFactory: () => {
        throw new Error("not used");
      },
    });
    expect(commerce.ebaySync).toBeNull();
    expect(commerce.syncEbayOrdersTask).toBeNull();
    expect(commerce.tasks.map((task) => task.name)).toEqual([
      "commerce.sync-woo-orders",
    ]);
  });

  it("registers `commerce.sync-ebay-orders` when the seam is supplied", () => {
    const commerce = createCommerceTasks({
      db: scratch.handle.db,
      adapterFactory: () => {
        throw new Error("not used");
      },
      iterateEbayOrders: () =>
        (async function* () {
          // no pages
        })(),
    });
    expect(commerce.ebaySync).not.toBeNull();
    expect(commerce.tasks.map((task) => task.name)).toEqual([
      "commerce.sync-woo-orders",
      SYNC_EBAY_ORDERS_TASK_NAME,
    ]);
  });

  it("keys one queued sync per connection", () => {
    expect(ebayOrderSyncJobKey("c-1")).toContain(SYNC_EBAY_ORDERS_TASK_NAME);
    expect(ebayOrderSyncJobKey("c-1")).not.toBe(ebayOrderSyncJobKey("c-2"));
  });
});
