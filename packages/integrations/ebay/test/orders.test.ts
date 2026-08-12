/**
 * Sell Fulfillment order mapping, filter building, paging, and redaction.
 *
 * Pure: no network. The provider seam is `EbayUserAdapter.sellGetOrders` /
 * `sellGetShippingFulfillments`, stubbed with the fixtures in
 * `order-fixtures.ts` — whose provenance note explains which parts of the
 * shape are library-verified and which are design-derived.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { EbaySellOrdersQuery, EbayUserAdapter } from "../src/adapter.ts";
import {
  EBAY_BUYER_FEE_ID,
  EBAY_MARKETPLACE_FEE_ID,
  buildEbayOrdersFilter,
  buildEbayOrdersQuery,
  ebaySourceAccountKey,
  fetchEbayOrdersPage,
  isoFromEbay,
  iterateEbayOrders,
  mapEbayFulfillment,
  mapEbayOrder,
  redactEbayOrderFact,
} from "../src/orders.ts";
import type { EbayOrderFact } from "../src/orders.ts";
import {
  ebayFulfillmentPayload,
  ebayFulfillmentsResponse,
  ebayOrderPayload,
  ebayOrdersResponse,
} from "./order-fixtures.ts";

const MAP_OPTIONS = {
  fallbackSourceAccountKey: "ebay:EBAY_US",
  marketplaceId: "EBAY_US",
} as const;

function mapFixture(
  input: Parameters<typeof ebayOrderPayload>[0] = {},
): EbayOrderFact {
  return mapEbayOrder(ebayOrderPayload(input), MAP_OPTIONS);
}

/* --------------------------------------------------------------- stub seam */

interface StubState {
  pages: Array<Record<string, unknown>>;
  fulfillments: Record<string, Record<string, unknown>>;
  queries: EbaySellOrdersQuery[];
  fulfillmentCalls: string[];
}

function stubAdapter(state: StubState): EbayUserAdapter {
  let pageIndex = 0;
  return {
    environment: "sandbox",
    marketplaceId: "EBAY_US",
    sellGetOrders: async (query: EbaySellOrdersQuery = {}) => {
      state.queries.push(query);
      const page = state.pages[pageIndex] ?? ebayOrdersResponse([]);
      pageIndex += 1;
      return page;
    },
    sellGetShippingFulfillments: async (orderId: string) => {
      state.fulfillmentCalls.push(orderId);
      return state.fulfillments[orderId] ?? ebayFulfillmentsResponse([]);
    },
  } as unknown as EbayUserAdapter;
}

function stubState(overrides: Partial<StubState> = {}): StubState {
  return {
    pages: [],
    fulfillments: {},
    queries: [],
    fulfillmentCalls: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ mapping */

describe("mapEbayOrder — identity and totals", () => {
  it("maps the design's identity columns from the documented containers", () => {
    const fact = mapFixture();
    expect(fact.externalOrderId).toBe("18-11223-44556");
    expect(fact.orderNumber).toBe("8241");
    expect(fact.sellerExternalId).toBe("sandbox-seller-01");
    expect(fact.sourceAccountKey).toBe("ebay:sandbox-seller-01");
    expect(fact.marketplace).toBe("EBAY_US");
    expect(fact.currency).toBe("USD");
    expect(fact.placedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(fact.updatedAt).toBe("2026-08-01T12:30:00.000Z");
    expect(fact.paidAt).toBe("2026-08-01T12:05:00.000Z");
    expect(fact.cancelledAt).toBeNull();
  });

  it("computes source_account_key deterministically from sellerId", () => {
    expect(ebaySourceAccountKey("sandbox-seller-01")).toBe(
      "ebay:sandbox-seller-01",
    );
    const twice = [mapFixture(), mapFixture()].map((f) => f.sourceAccountKey);
    expect(new Set(twice).size).toBe(1);
  });

  it("falls back to the adapter's account key when sellerId is absent", () => {
    const raw = ebayOrderPayload();
    delete raw["sellerId"];
    const fact = mapEbayOrder(raw, MAP_OPTIONS);
    expect(fact.sourceAccountKey).toBe("ebay:EBAY_US");
    expect(fact.sellerExternalId).toBeNull();
  });

  it("reads the provider's own subtotal and derives the discount magnitude", () => {
    const fact = mapFixture();
    expect(fact.totals).toEqual({
      total: "74.60",
      // eBay DOES report priceSubtotal — unlike WooCommerce.
      subtotal: "70.00",
      shipping: "5.00",
      tax: "5.60",
      // priceDiscount 5.00 + deliveryDiscount 1.00, as positive magnitudes.
      discount: "6.00",
      fee: "9.87",
      refunded: "0.00",
    });
  });

  it("derives the subtotal by exact summation when eBay omits priceSubtotal", () => {
    const raw = ebayOrderPayload({ secondLine: true });
    const pricing = raw["pricingSummary"] as Record<string, unknown>;
    delete pricing["priceSubtotal"];
    const fact = mapEbayOrder(raw, MAP_OPTIONS);
    expect(fact.totals.subtotal).toBe("70.00");
  });

  it("never produces a JavaScript number for any amount", () => {
    const fact = mapFixture({ secondLine: true });
    const amounts = [
      ...Object.values(fact.totals),
      ...fact.lineItems.flatMap((line) => [
        line.quantity,
        line.lineSubtotal,
        line.lineTotal,
        line.discount,
        line.lineTax,
        line.lineShipping,
        line.lineRefunded,
      ]),
      ...fact.fees.map((fee) => fee.amount),
    ];
    for (const amount of amounts) {
      expect(typeof amount).toBe("string");
      expect(amount).toMatch(/^-?\d+(\.\d+)?$/);
    }
  });
});

describe("mapEbayOrder — lines", () => {
  it("maps a discounted line and computes an EXACT unit price", () => {
    const [line] = mapFixture().lineItems;
    expect(line).toMatchObject({
      externalLineId: "10101010",
      lineNumber: 1,
      sku: "SKU-ALPHA",
      name: "Alpha widget",
      externalItemId: "110485231234",
      quantity: "2",
      // 50.00 / 2, exactly. eBay reports no unit price at all.
      unitPrice: "25",
      lineSubtotal: "50.00",
      lineTotal: "45.00",
      discount: "5.00",
      lineTax: "4.00",
      lineShipping: "5.00",
      lineRefunded: "0.00",
      fulfillmentStatusRaw: "FULFILLED",
      marketplaceId: "EBAY_US",
    });
  });

  it("returns a null unit price rather than rounding a non-terminating quotient", () => {
    const raw = ebayOrderPayload();
    const line = (raw["lineItems"] as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >;
    line["quantity"] = 3;
    line["lineItemCost"] = { value: "10.00", currency: "USD" };
    const fact = mapEbayOrder(raw, MAP_OPTIONS);
    expect(fact.lineItems[0]?.unitPrice).toBeNull();
  });

  it("falls back to ebayCollectAndRemitTaxes when `taxes` is empty", () => {
    const fact = mapFixture({ secondLine: true });
    expect(fact.lineItems[0]?.lineTax).toBe("4.00");
    // Marketplace-facilitator shape: the only tax evidence on line 2.
    expect(fact.lineItems[1]?.lineTax).toBe("1.60");
  });

  it("keeps line numbers 1-based and positional", () => {
    const fact = mapFixture({ secondLine: true });
    expect(fact.lineItems.map((line) => line.lineNumber)).toEqual([1, 2]);
  });
});

describe("mapEbayOrder — status projection", () => {
  it("PAID/FULFILLED becomes completed + paid + fulfilled", () => {
    const fact = mapFixture();
    expect(fact.status).toBe("completed");
    expect(fact.paymentStatus).toBe("paid");
    expect(fact.fulfillmentStatus).toBe("fulfilled");
    expect(fact.providerStatusRaw).toBe("PAID/FULFILLED");
    expect(fact.statusRecognized).toBe(true);
  });

  it("IN_PROGRESS reaches partially_fulfilled — the state Woo cannot express", () => {
    const fact = mapFixture({ orderFulfillmentStatus: "IN_PROGRESS" });
    expect(fact.fulfillmentStatus).toBe("partially_fulfilled");
    expect(fact.status).toBe("open");
  });

  it("PENDING payment with NOT_STARTED fulfillment stays pending/unpaid", () => {
    const fact = mapFixture({
      orderPaymentStatus: "PENDING",
      orderFulfillmentStatus: "NOT_STARTED",
    });
    expect(fact.status).toBe("pending");
    expect(fact.paymentStatus).toBe("unpaid");
    expect(fact.fulfillmentStatus).toBe("unfulfilled");
  });

  it("maps the refund payment states", () => {
    expect(mapFixture({ orderPaymentStatus: "PARTIALLY_REFUNDED" }).paymentStatus).toBe(
      "partially_refunded",
    );
    expect(mapFixture({ orderPaymentStatus: "FULLY_REFUNDED" }).paymentStatus).toBe(
      "refunded",
    );
    expect(mapFixture({ orderPaymentStatus: "FAILED" }).paymentStatus).toBe(
      "failed",
    );
  });

  it("a CANCELED cancelState overrides both derived statuses", () => {
    const fact = mapFixture({
      cancelState: "CANCELED",
      cancelledDate: "2026-08-03T10:00:00.000Z",
    });
    expect(fact.status).toBe("cancelled");
    expect(fact.fulfillmentStatus).toBe("cancelled");
    expect(fact.cancelledAt).toBe("2026-08-03T10:00:00.000Z");
    expect(fact.providerStatusRaw).toBe("PAID/FULFILLED/CANCELED");
  });

  it("NONE_REQUESTED is not appended to the composite raw status", () => {
    const fact = mapFixture({ cancelState: "NONE_REQUESTED" });
    expect(fact.providerStatusRaw).toBe("PAID/FULFILLED");
    expect(fact.status).toBe("completed");
  });

  it("an unrecognized fulfillment status degrades to `unknown`, not `unfulfilled`", () => {
    const fact = mapFixture({ orderFulfillmentStatus: "SHIPPED_ON_A_TUESDAY" });
    expect(fact.fulfillmentStatus).toBe("unknown");
    expect(fact.statusRecognized).toBe(false);
    expect(fact.providerStatusRaw).toBe("PAID/SHIPPED_ON_A_TUESDAY");
  });

  it("an unrecognized payment status floors to unpaid and flags the fact", () => {
    const fact = mapFixture({ orderPaymentStatus: "ESCROWED" });
    expect(fact.paymentStatus).toBe("unpaid");
    expect(fact.statusRecognized).toBe(false);
    // Fulfillment was still readable, so it is not degraded along with it.
    expect(fact.fulfillmentStatus).toBe("fulfilled");
  });

  it("a payload with no status containers at all is still a valid fact", () => {
    const raw = ebayOrderPayload();
    delete raw["orderPaymentStatus"];
    delete raw["orderFulfillmentStatus"];
    const fact = mapEbayOrder(raw, MAP_OPTIONS);
    expect(fact.statusRecognized).toBe(false);
    expect(fact.fulfillmentStatus).toBe("unknown");
    expect(fact.providerStatusRaw).toBe("-/-");
  });
});

describe("mapEbayOrder — fees", () => {
  it("totalMarketplaceFee is a SELLER charge with a deterministic natural key", () => {
    const fees = mapFixture().fees;
    expect(fees).toHaveLength(1);
    expect(fees[0]).toEqual({
      externalFeeId: EBAY_MARKETPLACE_FEE_ID,
      feeType: "marketplace_final_value",
      feeDirection: "seller_charge",
      providerFeeCode: "totalMarketplaceFee",
      description: "eBay marketplace fees (aggregate)",
      currency: "USD",
      amount: "9.87",
    });
  });

  it("pricingSummary.fee is a BUYER surcharge, the opposite polarity", () => {
    const fees = mapFixture({ buyerFee: "1.50" }).fees;
    expect(fees).toHaveLength(2);
    const buyerFee = fees.find((fee) => fee.externalFeeId === EBAY_BUYER_FEE_ID);
    expect(buyerFee).toMatchObject({
      feeDirection: "buyer_surcharge",
      feeType: "buyer_surcharge",
      providerFeeCode: "pricingSummary.fee",
      amount: "1.50",
    });
  });

  it("synthesizes no fee row when the amount is absent or zero", () => {
    expect(mapFixture({ marketplaceFee: null }).fees).toEqual([]);
    expect(mapFixture({ marketplaceFee: "0.00" }).fees).toEqual([]);
    expect(mapFixture({ marketplaceFee: null, buyerFee: "0.00" }).fees).toEqual(
      [],
    );
  });

  it("orders.fee_amount stays a seller-side magnitude", () => {
    const fact = mapFixture({ buyerFee: "1.50" });
    // The buyer surcharge is inside `total`, never in the seller-fee rollup.
    expect(fact.totals.fee).toBe("9.87");
  });
});

describe("mapEbayOrder — refunds", () => {
  it("maps order refunds and attaches the line refunds that share a refundId", () => {
    const fact = mapFixture({
      orderPaymentStatus: "PARTIALLY_REFUNDED",
      refunds: [{ refundId: "5001", amount: "20.00" }],
      lineRefunds: { "10101010": [{ refundId: "5001", amount: "20.00" }] },
    });
    expect(fact.refunds).toHaveLength(1);
    expect(fact.refunds[0]).toMatchObject({
      externalRefundId: "5001",
      status: "completed",
      providerStatusRaw: "REFUNDED",
      currency: "USD",
      amount: "20.00",
      refundedAt: "2026-08-02T09:00:00.000Z",
    });
    expect(fact.refunds[0]?.lines).toEqual([
      { externalLineId: "10101010", amount: "20.00" },
    ]);
    expect(fact.lineItems[0]?.lineRefunded).toBe("20.00");
    expect(fact.totals.refunded).toBe("20.00");
  });

  it("projects refundStatus onto the design's three-member union", () => {
    const pending = mapFixture({
      refunds: [{ refundId: "5002", amount: "1.00", refundStatus: "PENDING" }],
    });
    expect(pending.refunds[0]?.status).toBe("pending");
    const failed = mapFixture({
      refunds: [{ refundId: "5003", amount: "1.00", refundStatus: "FAILED" }],
    });
    expect(failed.refunds[0]?.status).toBe("failed");
  });

  it("sums several refunds exactly", () => {
    const fact = mapFixture({
      refunds: [
        { refundId: "a", amount: "10.05" },
        { refundId: "b", amount: "0.95" },
      ],
    });
    expect(fact.totals.refunded).toBe("11.00");
  });
});

describe("mapEbayOrder — buyer and destination", () => {
  it("normalizes only the eBay USERNAME and the ship-to country/region", () => {
    const fact = mapFixture();
    expect(fact.buyerExternalId).toBe("sandbox-buyer-01");
    expect(fact.buyerDisplayName).toBe("sandbox-buyer-01");
    expect(fact.destinationCountry).toBe("US");
    expect(fact.destinationRegion).toBe("NY");
  });

  it("puts no email, phone, street address, or taxpayer id in a fact column", () => {
    const fact = mapFixture();
    const columns = inspect(redactEbayOrderFact(fact), { depth: null });
    for (const secret of [
      "fixture.person@example.invalid",
      "gift.recipient@example.invalid",
      "555-0100",
      "1 Fixture Way",
      "FAKE-TAXPAYER-ID",
      "Fixture Person",
      "please leave at the side door",
    ]) {
      expect(columns).not.toContain(secret);
    }
  });
});

describe("redactEbayOrderFact (ADR-0021)", () => {
  it("replaces the retained payload and keeps every other field", () => {
    const fact = mapFixture();
    const redacted = redactEbayOrderFact(fact);
    expect(redacted.raw).toBe("[redacted]");
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(fact).sort());
    expect(redacted.totals).toEqual(fact.totals);
    expect(redacted.externalOrderId).toBe(fact.externalOrderId);
  });

  it("is the only thing safe to serialize — the unredacted fact is not", () => {
    const fact = mapFixture();
    expect(inspect(fact, { depth: null })).toContain("FAKE-TAXPAYER-ID");
    expect(inspect(redactEbayOrderFact(fact), { depth: null })).not.toContain(
      "FAKE-TAXPAYER-ID",
    );
  });

  it("is idempotent in shape — redacting twice changes nothing further", () => {
    const once = redactEbayOrderFact(mapFixture());
    const twice = redactEbayOrderFact(once as unknown as EbayOrderFact);
    expect(twice).toEqual(once);
  });
});

describe("mapEbayFulfillment", () => {
  it("maps a shipment with tracking and per-line quantities", () => {
    const fulfillment = mapEbayFulfillment(ebayFulfillmentPayload(), 0);
    expect(fulfillment).toEqual({
      externalFulfillmentId: "9405511899223197428490",
      status: "shipped",
      carrierCode: "USPS",
      trackingNumber: "9405511899223197428490",
      shippedAt: "2026-08-01T18:00:00.000Z",
      lines: [{ externalLineId: "10101010", quantity: "2" }],
    });
  });

  it("tolerates a shipment with no carrier and no tracking", () => {
    const fulfillment = mapEbayFulfillment(
      ebayFulfillmentPayload({ carrierCode: null, trackingNumber: null }),
      0,
    );
    expect(fulfillment.carrierCode).toBeNull();
    expect(fulfillment.trackingNumber).toBeNull();
    expect(fulfillment.status).toBe("shipped");
  });
});

describe("timestamps", () => {
  it("parses eBay's Z-suffixed instants without repair", () => {
    expect(isoFromEbay("2026-08-01T12:00:00.000Z")).toBe(
      "2026-08-01T12:00:00.000Z",
    );
    expect(isoFromEbay("2026-08-01T12:00:00.511Z")).toBe(
      "2026-08-01T12:00:00.511Z",
    );
  });

  it("returns null rather than a shifted instant for junk", () => {
    expect(isoFromEbay("not-a-date")).toBeNull();
    expect(isoFromEbay("")).toBeNull();
    expect(isoFromEbay(undefined)).toBeNull();
  });
});

describe("query building", () => {
  it("builds an inclusive lastmodifieddate range for the sync watermark", () => {
    expect(
      buildEbayOrdersFilter({ modifiedAfter: "2026-08-01T12:00:00.000Z" }),
    ).toBe("lastmodifieddate:[2026-08-01T12:00:00.000Z..]");
  });

  it("builds a bounded range, a creation filter, and a status set", () => {
    expect(
      buildEbayOrdersFilter({
        modifiedAfter: new Date("2026-08-01T00:00:00.000Z"),
        modifiedBefore: new Date("2026-08-02T00:00:00.000Z"),
        placedAfter: new Date("2026-07-01T00:00:00.000Z"),
        fulfillmentStatuses: ["NOT_STARTED", "IN_PROGRESS"],
      }),
    ).toBe(
      "lastmodifieddate:[2026-08-01T00:00:00.000Z..2026-08-02T00:00:00.000Z]," +
        "creationdate:[2026-07-01T00:00:00.000Z..]," +
        "orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}",
    );
  });

  it("omits `filter` entirely when nothing is filtered", () => {
    expect(buildEbayOrdersFilter()).toBeUndefined();
    expect(buildEbayOrdersQuery()).toEqual({ limit: 50, offset: 0 });
  });

  it("clamps the page size to eBay's documented bounds", () => {
    expect(buildEbayOrdersQuery({ limit: 5000 }).limit).toBe(200);
    expect(buildEbayOrdersQuery({ limit: 0 }).limit).toBe(1);
  });

  it("rejects an unparseable date filter with `invalid_request`", () => {
    expect(() => buildEbayOrdersFilter({ modifiedAfter: "nope" })).toThrow(
      /not a valid instant/,
    );
  });
});

/* ----------------------------------------------------------------- fetching */

describe("fetchEbayOrdersPage", () => {
  it("maps a paged collection and reports eBay's pagination facts", async () => {
    const state = stubState({
      pages: [
        ebayOrdersResponse([ebayOrderPayload()], {
          limit: 50,
          offset: 0,
          total: 1,
        }),
      ],
    });
    const page = await fetchEbayOrdersPage(stubAdapter(state), {
      modifiedAfter: "2026-08-01T00:00:00.000Z",
    });
    expect(page.orders).toHaveLength(1);
    expect(page.page).toEqual({
      limit: 50,
      offset: 0,
      total: 1,
      hasNextPage: false,
    });
    expect(state.queries[0]?.filter).toBe(
      "lastmodifieddate:[2026-08-01T00:00:00.000Z..]",
    );
  });

  it("does NOT fetch fulfillments unless asked (one extra call per order)", async () => {
    const state = stubState({
      pages: [ebayOrdersResponse([ebayOrderPayload()])],
    });
    const page = await fetchEbayOrdersPage(stubAdapter(state));
    expect(state.fulfillmentCalls).toEqual([]);
    // null means "we did not look" — distinct from "eBay reported none".
    expect(page.orders[0]?.fulfillments).toBeNull();
  });

  it("attaches shipments when asked", async () => {
    const state = stubState({
      pages: [ebayOrdersResponse([ebayOrderPayload()])],
      fulfillments: {
        "18-11223-44556": ebayFulfillmentsResponse([ebayFulfillmentPayload()]),
      },
    });
    const page = await fetchEbayOrdersPage(stubAdapter(state), {
      includeFulfillments: true,
    });
    expect(state.fulfillmentCalls).toEqual(["18-11223-44556"]);
    expect(page.orders[0]?.fulfillments).toEqual([
      {
        externalFulfillmentId: "9405511899223197428490",
        status: "shipped",
        carrierCode: "USPS",
        trackingNumber: "9405511899223197428490",
        shippedAt: "2026-08-01T18:00:00.000Z",
        lines: [{ externalLineId: "10101010", quantity: "2" }],
      },
    ]);
  });

  it("spends no call on an order eBay says has not started fulfillment", async () => {
    const state = stubState({
      pages: [
        ebayOrdersResponse([
          ebayOrderPayload({ orderFulfillmentStatus: "NOT_STARTED" }),
        ]),
      ],
    });
    const page = await fetchEbayOrdersPage(stubAdapter(state), {
      includeFulfillments: true,
    });
    expect(state.fulfillmentCalls).toEqual([]);
    // `[]` — knowable without asking, and NOT the same as null.
    expect(page.orders[0]?.fulfillments).toEqual([]);
  });
});

describe("iterateEbayOrders", () => {
  it("walks offset pages until eBay stops offering a next link", async () => {
    const state = stubState({
      pages: [
        ebayOrdersResponse([ebayOrderPayload({ orderId: "A" })], {
          limit: 1,
          offset: 0,
          total: 2,
          next: "https://api.ebay.com/sell/fulfillment/v1/order?offset=1",
        }),
        ebayOrdersResponse([ebayOrderPayload({ orderId: "B" })], {
          limit: 1,
          offset: 1,
          total: 2,
        }),
      ],
    });
    const seen: string[] = [];
    for await (const page of iterateEbayOrders(stubAdapter(state), { limit: 1 })) {
      seen.push(...page.orders.map((order) => order.externalOrderId));
    }
    expect(seen).toEqual(["A", "B"]);
    expect(state.queries.map((query) => query.offset)).toEqual([0, 1]);
  });

  it("stops at maxPages and leaves the rest for the next run", async () => {
    const nextPage = (offset: number) =>
      ebayOrdersResponse([ebayOrderPayload({ orderId: `O${offset}` })], {
        limit: 1,
        offset,
        total: 99,
        next: "https://api.ebay.com/sell/fulfillment/v1/order?offset=next",
      });
    const state = stubState({
      pages: [nextPage(0), nextPage(1), nextPage(2), nextPage(3)],
    });
    let pages = 0;
    for await (const _page of iterateEbayOrders(
      stubAdapter(state),
      { limit: 1 },
      { maxPages: 2 },
    )) {
      pages += 1;
    }
    expect(pages).toBe(2);
    expect(state.queries).toHaveLength(2);
  });

  it("stops immediately on an empty page", async () => {
    const state = stubState({ pages: [ebayOrdersResponse([])] });
    let pages = 0;
    for await (const _page of iterateEbayOrders(stubAdapter(state))) pages += 1;
    expect(pages).toBe(1);
    expect(state.queries).toHaveLength(1);
  });
});

describe("malformed payloads", () => {
  it("refuses to build a fact without an orderId", () => {
    const raw = ebayOrderPayload();
    delete raw["orderId"];
    expect(() => mapEbayOrder(raw, MAP_OPTIONS)).toThrow(/orderId/);
  });

  it("refuses to build a fact without a usable creationDate", () => {
    const raw = ebayOrderPayload();
    raw["creationDate"] = "not-a-date";
    expect(() => mapEbayOrder(raw, MAP_OPTIONS)).toThrow(/creationDate/);
  });

  it("tolerates missing optional containers", () => {
    const raw: Record<string, unknown> = {
      orderId: "bare",
      creationDate: "2026-08-01T12:00:00.000Z",
      orderPaymentStatus: "PAID",
      orderFulfillmentStatus: "NOT_STARTED",
      sellerId: "s",
    };
    const fact = mapEbayOrder(raw, MAP_OPTIONS);
    expect(fact.lineItems).toEqual([]);
    expect(fact.fees).toEqual([]);
    expect(fact.refunds).toEqual([]);
    expect(fact.currency).toBe("");
    expect(fact.totals.total).toBe("0.00");
    expect(fact.buyerExternalId).toBeNull();
    expect(fact.destinationCountry).toBeNull();
  });
});
