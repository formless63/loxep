import { describe, expect, it } from "vitest";
import {
  DECIMAL_STRING,
  WOO_FULFILLMENT_STATUSES,
  WOO_ORDER_STATUSES,
  WOO_PAYMENT_STATUSES,
  WOO_STATUS_MAP,
  WooAdapterError,
  buildWooOrdersQuery,
  createWooAdapter,
  fetchOrders,
  fetchOrdersPage,
  isoFromWooGmt,
  iterateWooOrders,
  mapWooOrder,
  normalizeWooStatusSlug,
  redactWooOrderFact,
} from "../src/index.ts";
import type { WooOrderFact } from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_KEY,
  TEST_SECRET,
  createFetchStub,
  type FetchStub,
} from "./http.ts";
import {
  completedOrderFixture,
  feeLineOrderFixture,
  guestOrderFixture,
  multiLineOrderFixture,
  partiallyRefundedOrderFixture,
} from "./fixtures.ts";

const ACCOUNT = "woocommerce:https://shop.example.invalid";
const map = (raw: Record<string, unknown>): WooOrderFact =>
  mapWooOrder(raw, { sourceAccountKey: ACCOUNT });

function makeAdapter(stub: FetchStub) {
  return createWooAdapter({
    baseUrl: TEST_BASE_URL,
    consumerKey: TEST_KEY,
    consumerSecret: TEST_SECRET,
    fetchImpl: stub.impl,
  });
}

describe("mapWooOrder — identity and provenance", () => {
  it("maps the ordinary completed order", () => {
    const fact = map(completedOrderFixture());
    expect(fact.externalOrderId).toBe("1042");
    expect(fact.orderNumber).toBe("1042");
    expect(fact.sourceAccountKey).toBe(ACCOUNT);
    expect(fact.currency).toBe("USD");
    expect(fact.buyerExternalId).toBe("77");
    expect(fact.statusRecognized).toBe(true);
    expect(fact.raw["id"]).toBe(1042);
  });

  it("keeps plugin-injected top-level keys in raw without choking", () => {
    const fact = map(completedOrderFixture());
    expect(fact.raw["wpo_wcpdf_invoice_number"]).toBe("INV-1042");
  });

  it("treats customer_id 0 as a guest (null), not as user zero", () => {
    expect(map(guestOrderFixture()).buyerExternalId).toBeNull();
  });

  it("treats variation_id 0 as 'not a variation'", () => {
    const [line] = map(guestOrderFixture()).lineItems;
    expect(line?.externalVariationId).toBeNull();
    expect(line?.externalItemId).toBe("910");
  });

  it("refuses to build a fact without an id", () => {
    expect(() => map(completedOrderFixture({ id: null }))).toThrowError(
      WooAdapterError,
    );
  });

  it("refuses to build a fact without a usable creation date", () => {
    expect(() =>
      map(completedOrderFixture({ date_created_gmt: null, date_created: null })),
    ).toThrowError(WooAdapterError);
  });
});

describe("mapWooOrder — timestamps", () => {
  it("reads the zone-less *_gmt fields as UTC, not local time", () => {
    const fact = map(completedOrderFixture());
    expect(fact.placedAt).toBe("2026-07-01T13:15:00.000Z");
    expect(fact.updatedAt).toBe("2026-07-03T15:00:00.000Z");
    expect(fact.paidAt).toBe("2026-07-01T13:15:03.000Z");
    expect(fact.completedAt).toBe("2026-07-03T15:00:00.000Z");
  });

  it("does not shift a value that already carries a zone", () => {
    expect(isoFromWooGmt("2026-07-01T13:15:00Z")).toBe(
      "2026-07-01T13:15:00.000Z",
    );
    expect(isoFromWooGmt("2026-07-01T13:15:00+02:00")).toBe(
      "2026-07-01T11:15:00.000Z",
    );
  });

  it("returns null for absent or unparseable dates", () => {
    expect(isoFromWooGmt(null)).toBeNull();
    expect(isoFromWooGmt("")).toBeNull();
    expect(isoFromWooGmt("not-a-date")).toBeNull();
    expect(map(guestOrderFixture()).completedAt).toBeNull();
  });
});

describe("mapWooOrder — status matrix (one Woo lifecycle → three design ones)", () => {
  const cases: Array<
    [string, string, string, string]
  > = [
    ["pending", "pending", "unpaid", "unfulfilled"],
    ["checkout-draft", "pending", "unpaid", "unfulfilled"],
    ["on-hold", "pending", "unpaid", "unfulfilled"],
    ["processing", "open", "paid", "unfulfilled"],
    ["completed", "completed", "paid", "fulfilled"],
    ["refunded", "completed", "refunded", "unknown"],
    ["cancelled", "cancelled", "unpaid", "cancelled"],
    ["failed", "cancelled", "failed", "unfulfilled"],
    ["trash", "cancelled", "unpaid", "cancelled"],
  ];

  it.each(cases)(
    "%s → status=%s payment=%s fulfillment=%s",
    (wooStatus, status, paymentStatus, fulfillmentStatus) => {
      const fact = map(completedOrderFixture({ status: wooStatus }));
      expect(fact.status).toBe(status);
      expect(fact.paymentStatus).toBe(paymentStatus);
      expect(fact.fulfillmentStatus).toBe(fulfillmentStatus);
      expect(fact.providerStatusRaw).toBe(wooStatus);
      expect(fact.statusRecognized).toBe(true);
    },
  );

  it("covers every documented Woo status plus checkout-draft", () => {
    expect(Object.keys(WOO_STATUS_MAP).sort()).toEqual(
      [
        "cancelled",
        "checkout-draft",
        "completed",
        "failed",
        "on-hold",
        "pending",
        "processing",
        "refunded",
        "trash",
      ].sort(),
    );
  });

  it("only ever emits values from the design's candidate unions", () => {
    for (const wooStatus of Object.keys(WOO_STATUS_MAP)) {
      const fact = map(completedOrderFixture({ status: wooStatus }));
      expect(WOO_ORDER_STATUSES).toContain(fact.status);
      expect(WOO_PAYMENT_STATUSES).toContain(fact.paymentStatus);
      expect(WOO_FULFILLMENT_STATUSES).toContain(fact.fulfillmentStatus);
    }
  });

  it("degrades a plugin-invented status to the floor and flags it", () => {
    const fact = map(completedOrderFixture({ status: "awaiting-shipment" }));
    expect(fact.status).toBe("pending");
    expect(fact.paymentStatus).toBe("unpaid");
    // Unrecognized statuses degrade to `unknown` fulfillment IN THE ADAPTER
    // (WOO_UNKNOWN_STATUS_MAPPING) rather than asserting `unfulfilled`.
    expect(fact.fulfillmentStatus).toBe("unknown");
    expect(fact.statusRecognized).toBe(false);
    // The truth survives for diagnosis (design: `provider_status_raw`).
    expect(fact.providerStatusRaw).toBe("awaiting-shipment");
  });

  it("maps 'refunded' to 'unknown' fulfillment IN THE ADAPTER, not downstream", () => {
    const fact = map(completedOrderFixture({ status: "refunded" }));
    expect(fact.fulfillmentStatus).toBe("unknown");
    expect(fact.statusRecognized).toBe(true);
  });

  it("strips WooCommerce's internal wc- post-status prefix", () => {
    expect(normalizeWooStatusSlug("wc-completed")).toBe("completed");
    const fact = map(completedOrderFixture({ status: "wc-completed" }));
    expect(fact.status).toBe("completed");
    expect(fact.statusRecognized).toBe(true);
  });

  it("derives partially_refunded, which is not a Woo status", () => {
    const fact = map(partiallyRefundedOrderFixture());
    expect(fact.providerStatusRaw).toBe("completed");
    expect(fact.paymentStatus).toBe("partially_refunded");
    expect(fact.totals.refunded).toBe("12.50");
  });

  it("does not downgrade a fully refunded order to partially_refunded", () => {
    const fact = map(
      partiallyRefundedOrderFixture({ status: "refunded" }),
    );
    expect(fact.paymentStatus).toBe("refunded");
  });

  it("ignores a zero-value refund array when deriving payment status", () => {
    const fact = map(
      completedOrderFixture({
        refunds: [{ id: 1, reason: "", total: "-0.00" }],
      }),
    );
    expect(fact.paymentStatus).toBe("paid");
  });
});

describe("mapWooOrder — money is always a decimal string", () => {
  it("passes provider totals through verbatim", () => {
    const { totals } = map(completedOrderFixture());
    expect(totals.total).toBe("48.15");
    expect(totals.shipping).toBe("9.95");
    expect(totals.tax).toBe("3.20");
    expect(totals.discount).toBe("5.00");
  });

  it("derives the order subtotal Woo does not report, exactly", () => {
    expect(map(completedOrderFixture()).totals.subtotal).toBe("45.00");
    // 10.10 + 0.20 + 0.001 — mixed scales, no float rounding.
    expect(map(multiLineOrderFixture()).totals.subtotal).toBe("10.301");
  });

  it("defaults a missing amount to 0.00 rather than to a JS number", () => {
    const fact = map(
      completedOrderFixture({
        total: null,
        shipping_total: "",
        total_tax: undefined,
        discount_total: "n/a",
        line_items: [],
      }),
    );
    expect(fact.totals).toEqual({
      total: "0.00",
      subtotal: "0.00",
      shipping: "0.00",
      tax: "0.00",
      discount: "0.00",
      refunded: "0.00",
    });
  });

  it("emits decimal strings for every money field of every fixture", () => {
    const fixtures = [
      completedOrderFixture(),
      guestOrderFixture(),
      partiallyRefundedOrderFixture(),
      feeLineOrderFixture(),
      multiLineOrderFixture(),
    ];
    for (const raw of fixtures) {
      const fact = map(raw);
      for (const value of Object.values(fact.totals)) {
        expect(value).toMatch(DECIMAL_STRING);
      }
      for (const line of fact.lineItems) {
        for (const value of [
          line.quantity,
          line.lineSubtotal,
          line.lineTotal,
          line.lineTax,
          line.lineSubtotalTax,
          line.discount,
        ]) {
          expect(value).toMatch(DECIMAL_STRING);
        }
        if (line.unitPrice !== null) {
          expect(line.unitPrice).toMatch(DECIMAL_STRING);
        }
      }
      for (const fee of fact.feeLines) {
        expect(fee.total).toMatch(DECIMAL_STRING);
        expect(fee.totalTax).toMatch(DECIMAL_STRING);
      }
      for (const refund of fact.refunds) {
        expect(refund.amount).toMatch(DECIMAL_STRING);
        expect(refund.providerTotal).toMatch(DECIMAL_STRING);
      }
    }
  });
});

describe("mapWooOrder — line items", () => {
  it("maps the ordinary line, including the derived discount", () => {
    const [line] = map(completedOrderFixture()).lineItems;
    expect(line).toEqual({
      externalLineId: "501",
      lineNumber: 1,
      sku: "FIX-WIDGET-01",
      name: "Fixture Widget",
      externalItemId: "900",
      externalVariationId: "901",
      quantity: "2",
      unitPrice: "22.5",
      lineSubtotal: "45.00",
      lineTotal: "40.00",
      lineTax: "3.20",
      lineSubtotalTax: "3.60",
      discount: "5.00",
      taxClass: null,
    });
  });

  it("converts the float `price` field WooCommerce actually sends", () => {
    const line = map(
      completedOrderFixture({
        line_items: [
          { id: 1, name: "x", quantity: 1, subtotal: "179.99", total: "179.99", price: 179.99 },
        ],
      }),
    ).lineItems[0];
    expect(line?.unitPrice).toBe("179.99");
  });

  it("accepts a string `price` too, in case a store or version differs", () => {
    const line = map(
      completedOrderFixture({
        line_items: [
          { id: 1, name: "x", quantity: 1, subtotal: "5.00", total: "5.00", price: "5.00" },
        ],
      }),
    ).lineItems[0];
    expect(line?.unitPrice).toBe("5.00");
  });

  it("reports unitPrice null rather than an approximation", () => {
    const line = map(
      completedOrderFixture({
        line_items: [
          { id: 1, name: "x", quantity: 1, subtotal: "0.00", total: "0.00", price: 1e-9 },
        ],
      }),
    ).lineItems[0];
    expect(line?.unitPrice).toBeNull();
  });

  it("numbers lines positionally and falls back when a line id is missing", () => {
    const lines = map(multiLineOrderFixture()).lineItems;
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
    const fallback = map(
      completedOrderFixture({
        line_items: [{ name: "no id", quantity: 1, subtotal: "1.00", total: "1.00" }],
      }),
    ).lineItems[0];
    expect(fallback?.externalLineId).toBe("index:1");
  });

  it("keeps quantity as a decimal string (design stores numeric(20,6))", () => {
    const line = map(
      completedOrderFixture({
        line_items: [
          { id: 1, name: "by weight", quantity: 2.5, subtotal: "5.00", total: "5.00" },
        ],
      }),
    ).lineItems[0];
    expect(line?.quantity).toBe("2.5");
  });

  it("maps an empty SKU to null, not to an empty string", () => {
    expect(map(guestOrderFixture()).lineItems[0]?.sku).toBeNull();
  });

  it("tolerates a missing line_items array", () => {
    expect(map(completedOrderFixture({ line_items: undefined })).lineItems).toEqual(
      [],
    );
  });
});

describe("mapWooOrder — fee lines and refunds", () => {
  it("reports Woo fee_lines faithfully (buyer-facing surcharges)", () => {
    const fact = map(feeLineOrderFixture());
    expect(fact.feeLines).toEqual([
      {
        externalFeeId: "801",
        name: "Handling",
        taxStatus: "taxable",
        taxClass: null,
        total: "5.00",
        totalTax: "0.40",
      },
      {
        externalFeeId: "802",
        name: "Gift wrap",
        taxStatus: "none",
        taxClass: null,
        total: "3.00",
        totalTax: "0.00",
      },
    ]);
  });

  it("normalizes Woo's negative refund totals to positive magnitudes", () => {
    const fact = map(partiallyRefundedOrderFixture());
    expect(fact.refunds).toEqual([
      {
        externalRefundId: "1101",
        reason: "Damaged in transit",
        amount: "10.00",
        providerTotal: "-10.00",
      },
      {
        externalRefundId: "1102",
        reason: null,
        amount: "2.50",
        providerTotal: "-2.50",
      },
    ]);
  });

  it("handles a positive refund total from a differently-behaved store", () => {
    const fact = map(
      completedOrderFixture({ refunds: [{ id: 5, reason: "x", total: "4.00" }] }),
    );
    expect(fact.refunds[0]?.amount).toBe("4.00");
    expect(fact.totals.refunded).toBe("4.00");
  });
});

describe("redactWooOrderFact", () => {
  it("removes the PII-bearing raw payload while keeping every other field", () => {
    const fact = map(completedOrderFixture());
    const redacted = redactWooOrderFact(fact);
    expect(redacted.raw).toBe("[redacted]");
    expect(redacted.externalOrderId).toBe(fact.externalOrderId);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("fixture@example.invalid");
    expect(serialized).not.toContain("Placeholder Way");
    expect(serialized).not.toContain("203.0.113.7");
  });
});

describe("buildWooOrdersQuery", () => {
  it("defaults to every status, newest first", () => {
    expect(buildWooOrdersQuery()).toEqual({
      page: 1,
      per_page: 20,
      orderby: "date",
      order: "desc",
      status: "any",
    });
  });

  it("switches to an ascending modified walk when a watermark is given", () => {
    const query = buildWooOrdersQuery({
      modifiedAfter: new Date("2026-08-05T00:00:00.000Z"),
    });
    expect(query["orderby"]).toBe("modified");
    expect(query["order"]).toBe("asc");
    expect(query["modified_after"]).toBe("2026-08-05T00:00:00.000Z");
    expect(query["dates_are_gmt"]).toBe("true");
  });

  it("accepts a string watermark and a placedAfter filter", () => {
    const query = buildWooOrdersQuery({
      placedAfter: "2026-01-01T00:00:00Z",
    });
    expect(query["after"]).toBe("2026-01-01T00:00:00.000Z");
    expect(query["dates_are_gmt"]).toBe("true");
  });

  it("clamps per_page to WooCommerce's range and page to >= 1", () => {
    expect(buildWooOrdersQuery({ perPage: 1000 })["per_page"]).toBe(100);
    expect(buildWooOrdersQuery({ perPage: -3 })["per_page"]).toBe(1);
    expect(buildWooOrdersQuery({ page: 0 })["page"]).toBe(1);
  });

  it("normalizes status slugs, singly and as a list", () => {
    expect(buildWooOrdersQuery({ status: "wc-completed" })["status"]).toBe(
      "completed",
    );
    expect(
      buildWooOrdersQuery({ status: ["wc-completed", "processing"] })["status"],
    ).toEqual(["completed", "processing"]);
  });

  it("rejects an unparseable date filter", () => {
    expect(() => buildWooOrdersQuery({ modifiedAfter: "nope" })).toThrowError(
      WooAdapterError,
    );
  });
});

describe("fetchOrders / fetchOrdersPage / iterateWooOrders", () => {
  it("fetches and maps one page", async () => {
    const stub = createFetchStub([
      {
        body: [completedOrderFixture(), guestOrderFixture()],
        headers: { "x-wp-total": "2", "x-wp-totalpages": "1" },
      },
    ]);
    const orders = await fetchOrders(makeAdapter(stub), { perPage: 2 });
    expect(orders.map((o) => o.externalOrderId)).toEqual(["1042", "1043"]);
    expect(stub.pathOf(0)).toBe("/wp-json/wc/v3/orders");
    expect(stub.queryOf(0)["per_page"]).toEqual(["2"]);
  });

  it("returns the pagination headers alongside the facts", async () => {
    const stub = createFetchStub([
      {
        body: [completedOrderFixture()],
        headers: { "x-wp-total": "562", "x-wp-totalpages": "281" },
      },
    ]);
    const result = await fetchOrdersPage(makeAdapter(stub), { perPage: 2 });
    expect(result.page.total).toBe(562);
    expect(result.page.totalPages).toBe(281);
    expect(result.orders).toHaveLength(1);
  });

  it("iterates every page, carrying the filter and not the page cursor", async () => {
    const stub = createFetchStub((index) => ({
      body: [completedOrderFixture({ id: 2000 + index })],
      headers: {
        "x-wp-total": "3",
        "x-wp-totalpages": "3",
        ...(index < 2 ? { link: '<https://x/?page=2>; rel="next"' } : {}),
      },
    }));
    const ids: string[] = [];
    for await (const page of iterateWooOrders(makeAdapter(stub), {
      perPage: 1,
      modifiedAfter: "2026-08-05T00:00:00Z",
    })) {
      ids.push(...page.orders.map((o) => o.externalOrderId));
    }
    expect(ids).toEqual(["2000", "2001", "2002"]);
    expect(stub.queryOf(0)["modified_after"]).toEqual([
      "2026-08-05T00:00:00.000Z",
    ]);
    expect(stub.queryOf(2)["modified_after"]).toEqual([
      "2026-08-05T00:00:00.000Z",
    ]);
    expect(stub.queryOf(2)["page"]).toEqual(["3"]);
    expect(stub.queryOf(2)["orderby"]).toEqual(["modified"]);
  });
});
