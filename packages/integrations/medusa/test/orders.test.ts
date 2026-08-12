import { describe, expect, it } from "vitest";
import {
  DECIMAL_STRING,
  MEDUSA_FULFILLMENT_STATUSES,
  MEDUSA_FULFILLMENT_STATUS_MAP,
  MEDUSA_NATIVE_FULFILLMENT_STATUSES,
  MEDUSA_NATIVE_ORDER_STATUSES,
  MEDUSA_NATIVE_PAYMENT_STATUSES,
  MEDUSA_ORDER_STATUSES,
  MEDUSA_PAYMENT_STATUSES,
  MEDUSA_PAYMENT_STATUS_MAP,
  MEDUSA_STATUS_MAP,
  MedusaAdapterError,
  buildMedusaOrdersQuery,
  createMedusaAdapter,
  fetchOrders,
  fetchOrdersPage,
  isoFromMedusa,
  iterateMedusaOrders,
  mapMedusaOrder,
  redactMedusaOrderFact,
  subtractDecimals,
} from "../src/index.ts";
import type { MedusaOrderFact } from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_TOKEN,
  createFetchStub,
  rejection,
  type FetchStub,
} from "./http.ts";
import {
  canceledOrderFixture,
  capturedOrderFixture,
  deliveredOrderFixture,
  excessPrecisionOrderFixture,
  guestOrderFixture,
  jpyOrderFixture,
  partiallyRefundedOrderFixture,
} from "./fixtures.ts";

const ACCOUNT = "medusa:https://commerce.example.invalid";
const map = (raw: Record<string, unknown>): MedusaOrderFact =>
  mapMedusaOrder(raw, { sourceAccountKey: ACCOUNT });

function makeAdapter(stub: FetchStub) {
  return createMedusaAdapter({
    baseUrl: TEST_BASE_URL,
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
  });
}

describe("mapMedusaOrder — identity and provenance", () => {
  it("maps the ordinary captured order", () => {
    const fact = map(capturedOrderFixture());
    expect(fact.externalOrderId).toBe("order_01FIXTURE0001");
    expect(fact.orderNumber).toBe("1001");
    expect(fact.sourceAccountKey).toBe(ACCOUNT);
    expect(fact.currency).toBe("USD");
    expect(fact.buyerExternalId).toBe("cus_01FIXTURE0001");
    expect(fact.statusRecognized).toBe(true);
    expect(fact.raw["id"]).toBe("order_01FIXTURE0001");
  });

  it("treats an absent customer_id as a guest (null) — no WooCommerce-style sentinel", () => {
    expect(map(guestOrderFixture()).buyerExternalId).toBeNull();
  });

  it("refuses to build a fact without an id", () => {
    expect(() => map(capturedOrderFixture({ id: null }))).toThrowError(
      MedusaAdapterError,
    );
  });

  it("refuses to build a fact without a usable creation date", () => {
    expect(() =>
      map(capturedOrderFixture({ created_at: null })),
    ).toThrowError(MedusaAdapterError);
  });

  it("uses display_id as orderNumber, not the id", () => {
    const fact = map(capturedOrderFixture({ display_id: 42 }));
    expect(fact.orderNumber).toBe("42");
    expect(fact.orderNumber).not.toBe(fact.externalOrderId);
  });
});

describe("mapMedusaOrder — timestamps", () => {
  it("parses ordinary zoned ISO instants — no Woo-style Z-appending workaround needed", () => {
    const fact = map(capturedOrderFixture());
    expect(fact.placedAt).toBe("2026-07-01T13:15:00.000Z");
    expect(fact.updatedAt).toBe("2026-07-03T15:00:00.000Z");
  });

  it("isoFromMedusa returns null for absent or unparseable dates", () => {
    expect(isoFromMedusa(null)).toBeNull();
    expect(isoFromMedusa("")).toBeNull();
    expect(isoFromMedusa("not-a-date")).toBeNull();
  });

  it("cancelledAt is always null — the documented Admin API gap", () => {
    expect(map(canceledOrderFixture()).cancelledAt).toBeNull();
  });

  it("derives paidAt as the earliest captured_at across payment collections", () => {
    expect(map(capturedOrderFixture()).paidAt).toBe(
      "2026-07-01T13:15:03.000Z",
    );
  });

  it("paidAt is null when there is no payment collection (e.g. a guest order fixture)", () => {
    expect(map(guestOrderFixture()).paidAt).toBeNull();
  });
});

describe("mapMedusaOrder — status matrix (three native lifecycles → design's three)", () => {
  const statusCases: Array<[string, string]> = [
    ["pending", "pending"],
    ["requires_action", "pending"],
    ["completed", "completed"],
    ["draft", "pending"],
    ["archived", "completed"],
    ["canceled", "cancelled"],
  ];

  it.each(statusCases)("status %s → design %s", (native, design) => {
    const fact = map(capturedOrderFixture({ status: native }));
    expect(fact.status).toBe(design);
    expect(fact.providerStatusRaw).toBe(native);
  });

  const paymentCases: Array<[string, string]> = [
    ["not_paid", "unpaid"],
    ["awaiting", "unpaid"],
    ["authorized", "unpaid"],
    ["partially_authorized", "unpaid"],
    ["captured", "paid"],
    ["partially_captured", "partially_paid"],
    ["partially_refunded", "partially_refunded"],
    ["refunded", "refunded"],
    ["canceled", "failed"],
    ["requires_action", "unpaid"],
  ];

  it.each(paymentCases)("payment_status %s → design %s", (native, design) => {
    const fact = map(capturedOrderFixture({ payment_status: native }));
    expect(fact.paymentStatus).toBe(design);
    expect(fact.providerPaymentStatusRaw).toBe(native);
  });

  const fulfillmentCases: Array<[string, string]> = [
    ["not_fulfilled", "unfulfilled"],
    ["partially_fulfilled", "partially_fulfilled"],
    ["fulfilled", "fulfilled"],
    ["partially_shipped", "partially_fulfilled"],
    ["shipped", "fulfilled"],
    ["partially_delivered", "partially_fulfilled"],
    ["delivered", "fulfilled"],
    ["canceled", "cancelled"],
  ];

  it.each(fulfillmentCases)(
    "fulfillment_status %s → design %s",
    (native, design) => {
      const fact = map(capturedOrderFixture({ fulfillment_status: native }));
      expect(fact.fulfillmentStatus).toBe(design);
      expect(fact.providerFulfillmentStatusRaw).toBe(native);
    },
  );

  it("covers every documented native Medusa status/payment_status/fulfillment_status", () => {
    expect(Object.keys(MEDUSA_STATUS_MAP).sort()).toEqual(
      [...MEDUSA_NATIVE_ORDER_STATUSES].sort(),
    );
    expect(Object.keys(MEDUSA_PAYMENT_STATUS_MAP).sort()).toEqual(
      [...MEDUSA_NATIVE_PAYMENT_STATUSES].sort(),
    );
    expect(Object.keys(MEDUSA_FULFILLMENT_STATUS_MAP).sort()).toEqual(
      [...MEDUSA_NATIVE_FULFILLMENT_STATUSES].sort(),
    );
  });

  it("only ever emits values from the design's candidate unions", () => {
    for (const status of MEDUSA_NATIVE_ORDER_STATUSES) {
      expect(MEDUSA_ORDER_STATUSES).toContain(
        map(capturedOrderFixture({ status })).status,
      );
    }
    for (const paymentStatus of MEDUSA_NATIVE_PAYMENT_STATUSES) {
      expect(MEDUSA_PAYMENT_STATUSES).toContain(
        map(capturedOrderFixture({ payment_status: paymentStatus })).paymentStatus,
      );
    }
    for (const fulfillmentStatus of MEDUSA_NATIVE_FULFILLMENT_STATUSES) {
      expect(MEDUSA_FULFILLMENT_STATUSES).toContain(
        map(capturedOrderFixture({ fulfillment_status: fulfillmentStatus }))
          .fulfillmentStatus,
      );
    }
  });

  it("degrades an unrecognized status to the floor and flags it", () => {
    const fact = map(capturedOrderFixture({ status: "invented_by_a_plugin" }));
    expect(fact.status).toBe("pending");
    expect(fact.statusRecognized).toBe(false);
    expect(fact.providerStatusRaw).toBe("invented_by_a_plugin");
  });
});

describe("mapMedusaOrder — money is always a decimal string, and Medusa's own major-unit format", () => {
  it("passes provider totals through verbatim, already in major units", () => {
    const { totals } = map(capturedOrderFixture());
    expect(totals.total).toBe("48.15");
    expect(totals.subtotal).toBe("45");
    expect(totals.shipping).toBe("9.95");
    expect(totals.tax).toBe("3.2");
    expect(totals.discount).toBe("5");
  });

  it("reports subtotal directly from the provider — no line-sum derivation needed (contrast WooCommerce)", () => {
    const raw = capturedOrderFixture({ subtotal: 999 });
    expect(map(raw).totals.subtotal).toBe("999");
  });

  it("does not round away excess precision from the documented upstream defect", () => {
    const fact = map(excessPrecisionOrderFixture());
    expect(fact.totals.tax).toBe("3.199999");
  });

  it("handles a 0-decimal-digit currency (JPY) with a whole-number amount", () => {
    const fact = map(jpyOrderFixture());
    expect(fact.currency).toBe("JPY");
    expect(fact.totals.total).toBe("5000");
    expect(fact.lineItems[0]?.unitPrice).toBe("5000");
  });

  it("defaults a missing/unusable amount to 0.00", () => {
    const fact = map(
      capturedOrderFixture({
        total: null,
        shipping_total: undefined,
        tax_total: Number.NaN,
        discount_total: "n/a",
        items: [],
        payment_collections: [],
      }),
    );
    expect(fact.totals).toEqual({
      total: "0.00",
      // `original_total` is left at the fixture default in this override set,
      // which is the point: it does not follow `total` down.
      originalTotal: "48.15",
      subtotal: "45", // subtotal left at the fixture default in this override set
      shipping: "0.00",
      tax: "0.00",
      discount: "0.00",
      refunded: "0.00",
    });
  });

  it("keeps originalTotal above total once a refund has moved total (live behavior)", () => {
    const fact = map(partiallyRefundedOrderFixture());
    expect(fact.totals.total).toBe("35.65");
    expect(fact.totals.originalTotal).toBe("48.15");
    expect(fact.totals.refunded).toBe("12.5");
    // The trap this guards: total is ALREADY net of refunds, so
    // total - refunded double-counts. originalTotal - refunded is the identity
    // that actually holds.
    expect(
      subtractDecimals(fact.totals.originalTotal, fact.totals.refunded),
    ).toBe("35.65");
  });

  it("falls back to total when a payload omits original_total", () => {
    const fact = map(capturedOrderFixture({ original_total: undefined }));
    expect(fact.totals.originalTotal).toBe("48.15");
    expect(fact.totals.originalTotal).toBe(fact.totals.total);
  });

  it("emits decimal strings for every money field of every fixture", () => {
    const fixtures = [
      capturedOrderFixture(),
      guestOrderFixture(),
      deliveredOrderFixture(),
      partiallyRefundedOrderFixture(),
      jpyOrderFixture(),
      excessPrecisionOrderFixture(),
    ];
    for (const raw of fixtures) {
      const fact = map(raw);
      for (const value of Object.values(fact.totals)) {
        expect(value).toMatch(DECIMAL_STRING);
      }
      for (const line of fact.lineItems) {
        expect(line.quantity).toMatch(DECIMAL_STRING);
        expect(line.lineSubtotal).toMatch(DECIMAL_STRING);
        expect(line.lineTotal).toMatch(DECIMAL_STRING);
        expect(line.lineTax).toMatch(DECIMAL_STRING);
        expect(line.discount).toMatch(DECIMAL_STRING);
        if (line.unitPrice !== null) {
          expect(line.unitPrice).toMatch(DECIMAL_STRING);
        }
      }
      for (const refund of fact.refunds) {
        expect(refund.amount).toMatch(DECIMAL_STRING);
      }
    }
  });
});

describe("mapMedusaOrder — line items", () => {
  it("maps the ordinary line, using the provider-reported discount directly", () => {
    const [line] = map(capturedOrderFixture()).lineItems;
    expect(line).toEqual({
      externalLineId: "orli_01FIXTURE0001",
      lineNumber: 1,
      sku: "FIX-WIDGET-01",
      name: "Fixture Widget",
      externalItemId: "prod_01FIXTURE0001",
      externalVariationId: "variant_01FIXTURE0001",
      quantity: "2",
      unitPrice: "22.5",
      lineSubtotal: "45",
      lineTotal: "40",
      lineTax: "3.2",
      discount: "5",
    });
  });

  it("maps a null variant_sku to null, not to an empty string", () => {
    expect(map(guestOrderFixture()).lineItems[0]?.sku).toBeNull();
  });

  it("numbers lines positionally and falls back when a line id is missing", () => {
    const fallback = map(
      capturedOrderFixture({
        items: [{ title: "no id", quantity: 1, subtotal: 1, total: 1 }],
      }),
    ).lineItems[0];
    expect(fallback?.externalLineId).toBe("index:1");
    expect(fallback?.lineNumber).toBe(1);
  });

  it("keeps quantity as a decimal string (design stores numeric(20,6))", () => {
    const line = map(
      capturedOrderFixture({
        items: [
          {
            id: "orli_x",
            title: "by weight",
            quantity: 2.5,
            subtotal: 5,
            total: 5,
          },
        ],
      }),
    ).lineItems[0];
    expect(line?.quantity).toBe("2.5");
  });

  it("tolerates a missing items array", () => {
    expect(map(capturedOrderFixture({ items: undefined })).lineItems).toEqual(
      [],
    );
  });
});

describe("mapMedusaOrder — refunds (flattened from payment_collections[].payments[].refunds[])", () => {
  it("reports refunds as positive magnitudes with no sign flip (contrast WooCommerce)", () => {
    const fact = map(partiallyRefundedOrderFixture());
    expect(fact.refunds).toEqual([
      {
        externalRefundId: "ref_01FIXTURE0004",
        reason: "Damaged in transit",
        amount: "10",
        createdAt: "2026-07-06T09:00:00.000Z",
      },
      {
        externalRefundId: "ref_01FIXTURE0005",
        reason: "customer request",
        amount: "2.5",
        createdAt: "2026-07-06T09:05:00.000Z",
      },
    ]);
  });

  it("uses the refund_reason label when present, falling back to note", () => {
    const fact = map(partiallyRefundedOrderFixture());
    expect(fact.refunds[0]?.reason).toBe("Damaged in transit");
    expect(fact.refunds[1]?.reason).toBe("customer request");
  });

  it("derives totals.refunded as the exact sum of refund amounts", () => {
    expect(map(partiallyRefundedOrderFixture()).totals.refunded).toBe("12.5");
  });

  it("reports no refunds and a zero refunded total when there are none", () => {
    const fact = map(capturedOrderFixture());
    expect(fact.refunds).toEqual([]);
    expect(fact.totals.refunded).toBe("0.00");
  });

  it("flattens refunds across multiple payment collections/payments", () => {
    const fact = map(
      capturedOrderFixture({
        payment_collections: [
          {
            id: "pc1",
            payments: [
              {
                id: "p1",
                captured_at: "2026-07-01T00:00:00.000Z",
                refunds: [{ id: "r1", amount: 1, created_at: "2026-07-02T00:00:00.000Z" }],
              },
            ],
          },
          {
            id: "pc2",
            payments: [
              {
                id: "p2",
                captured_at: "2026-07-01T00:00:00.000Z",
                refunds: [{ id: "r2", amount: 2, created_at: "2026-07-03T00:00:00.000Z" }],
              },
            ],
          },
        ],
      }),
    );
    expect(fact.refunds.map((r) => r.externalRefundId)).toEqual(["r1", "r2"]);
    expect(fact.totals.refunded).toBe("3");
  });
});

describe("mapMedusaOrder — fulfillments", () => {
  it("derives a status from timestamp presence and maps tracking labels", () => {
    const [fulfillment] = map(deliveredOrderFixture()).fulfillments;
    expect(fulfillment).toEqual({
      externalFulfillmentId: "ful_01FIXTURE0003",
      status: "delivered",
      trackingNumbers: ["FIXTURE-TRACK-0001"],
      trackingUrls: [
        "https://carrier.example.invalid/track/FIXTURE-TRACK-0001",
      ],
      shippedAt: "2026-07-02T18:00:00.000Z",
      deliveredAt: "2026-07-05T12:00:00.000Z",
      canceledAt: null,
      destinationCountry: "US",
      destinationRegion: "NY",
    });
  });

  it("derives 'shipped' when shipped_at is set but not delivered_at", () => {
    const fact = map(
      deliveredOrderFixture({
        fulfillments: [
          {
            id: "ful_x",
            packed_at: "2026-07-02T10:00:00.000Z",
            shipped_at: "2026-07-02T18:00:00.000Z",
            delivered_at: null,
            canceled_at: null,
            labels: [],
            delivery_address: null,
          },
        ],
      }),
    );
    expect(fact.fulfillments[0]?.status).toBe("shipped");
  });

  it("derives 'pending' when no lifecycle timestamp is set", () => {
    const fact = map(
      deliveredOrderFixture({
        fulfillments: [
          {
            id: "ful_y",
            packed_at: null,
            shipped_at: null,
            delivered_at: null,
            canceled_at: null,
            labels: [],
            delivery_address: null,
          },
        ],
      }),
    );
    expect(fact.fulfillments[0]?.status).toBe("pending");
  });

  it("reports no fulfillments for an unfulfilled order", () => {
    expect(map(capturedOrderFixture()).fulfillments).toEqual([]);
  });

  it("tolerates a fulfillment with no tracking label (digital goods, local pickup)", () => {
    const fact = map(
      deliveredOrderFixture({
        fulfillments: [
          {
            id: "ful_z",
            packed_at: "2026-07-02T10:00:00.000Z",
            shipped_at: null,
            delivered_at: null,
            canceled_at: null,
            labels: [],
            delivery_address: null,
          },
        ],
      }),
    );
    expect(fact.fulfillments[0]?.trackingNumbers).toEqual([]);
    expect(fact.fulfillments[0]?.status).toBe("packed");
  });
});

describe("redactMedusaOrderFact", () => {
  it("removes the raw payload while keeping every other field", () => {
    const fact = map(capturedOrderFixture());
    const redacted = redactMedusaOrderFact(fact);
    expect(redacted.raw).toBe("[redacted]");
    expect(redacted.externalOrderId).toBe(fact.externalOrderId);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("fixture@example.invalid");
  });
});

describe("buildMedusaOrdersQuery", () => {
  it("defaults offset 0, sends the full default fields list, newest first", () => {
    const query = buildMedusaOrdersQuery();
    expect(query["offset"]).toBe(0);
    expect(query["order"]).toBe("-created_at");
    expect(typeof query["fields"]).toBe("string");
    expect((query["fields"] as string).length).toBeGreaterThan(0);
  });

  it("switches to an updated_at-ascending walk and adds the operator-key filter when a watermark is given", () => {
    const query = buildMedusaOrdersQuery({
      updatedAfter: new Date("2026-08-05T00:00:00.000Z"),
    });
    expect(query["order"]).toBe("updated_at");
    expect(query["updated_at[$gte]"]).toBe("2026-08-05T00:00:00.000Z");
  });

  it("accepts a string watermark", () => {
    const query = buildMedusaOrdersQuery({
      updatedAfter: "2026-01-01T00:00:00Z",
    });
    expect(query["updated_at[$gte]"]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("clamps limit to Loxep's own bounds and offset to >= 0", () => {
    expect(buildMedusaOrdersQuery({ limit: 100_000 })["limit"]).toBeLessThanOrEqual(
      200,
    );
    expect(buildMedusaOrdersQuery({ limit: -3 })["limit"]).toBe(1);
    expect(buildMedusaOrdersQuery({ offset: -5 })["offset"]).toBe(0);
  });

  it("passes a status filter through", () => {
    expect(buildMedusaOrdersQuery({ status: "completed" })["status"]).toBe(
      "completed",
    );
    expect(
      buildMedusaOrdersQuery({ status: ["completed", "canceled"] })["status"],
    ).toEqual(["completed", "canceled"]);
  });

  it("rejects an unparseable date filter", () => {
    expect(() => buildMedusaOrdersQuery({ updatedAfter: "nope" })).toThrowError(
      MedusaAdapterError,
    );
  });
});

describe("fetchOrders / fetchOrdersPage / iterateMedusaOrders", () => {
  it("fetches and maps one page from the body envelope", async () => {
    const stub = createFetchStub([
      {
        body: {
          orders: [capturedOrderFixture(), guestOrderFixture()],
          count: 2,
          offset: 0,
          limit: 2,
        },
      },
    ]);
    const orders = await fetchOrders(makeAdapter(stub), { limit: 2 });
    expect(orders.map((o) => o.externalOrderId)).toEqual([
      "order_01FIXTURE0001",
      "order_01FIXTURE0002",
    ]);
    expect(stub.pathOf(0)).toBe("/admin/orders");
    expect(stub.queryOf(0)["limit"]).toEqual(["2"]);
  });

  it("returns the pagination info alongside the facts", async () => {
    const stub = createFetchStub([
      {
        body: { orders: [capturedOrderFixture()], count: 562, offset: 0, limit: 2 },
      },
    ]);
    const result = await fetchOrdersPage(makeAdapter(stub), { limit: 2 });
    expect(result.page.count).toBe(562);
    expect(result.page.hasNextPage).toBe(true);
    expect(result.orders).toHaveLength(1);
  });

  it("iterates every page, carrying the filter and not the offset cursor", async () => {
    const stub = createFetchStub((index) => ({
      body: {
        orders: [
          capturedOrderFixture({
            id: `order_${2000 + index}`,
            // Must honor the watermark below (2026-08-05) — the fail-open
            // canary rejects a page containing an older updated_at.
            updated_at: "2026-08-06T00:00:00.000Z",
          }),
        ],
        count: 3,
        offset: index,
        limit: 1,
      },
    }));
    const ids: string[] = [];
    for await (const page of iterateMedusaOrders(makeAdapter(stub), {
      limit: 1,
      updatedAfter: "2026-08-05T00:00:00Z",
    })) {
      ids.push(...page.orders.map((o) => o.externalOrderId));
    }
    expect(ids).toEqual(["order_2000", "order_2001", "order_2002"]);
    expect(stub.queryOf(0)["updated_at[$gte]"]).toEqual([
      "2026-08-05T00:00:00.000Z",
    ]);
    expect(stub.queryOf(2)["updated_at[$gte]"]).toEqual([
      "2026-08-05T00:00:00.000Z",
    ]);
    expect(stub.queryOf(2)["offset"]).toEqual(["2"]);
  });

  it("stops cleanly on an empty page (offset walked past the end)", async () => {
    const stub = createFetchStub([
      { body: { orders: [capturedOrderFixture()], count: 2, offset: 0, limit: 1 } },
      { body: { orders: [], count: 2, offset: 1, limit: 1 } },
    ]);
    const ids: string[] = [];
    for await (const page of iterateMedusaOrders(makeAdapter(stub), {
      limit: 1,
    })) {
      ids.push(...page.orders.map((o) => o.externalOrderId));
    }
    expect(ids).toEqual(["order_01FIXTURE0001"]);
    expect(stub.calls).toHaveLength(2);
  });
});

describe("watermark wire serialization (loxep-pyg) — pins the exact percent-encoded query string", () => {
  it("emits updated_at%5B%24gte%5D=<ISO> on the wire, unchanged by refactors to buildQuery", async () => {
    const stub = createFetchStub([
      { body: { orders: [], count: 0, offset: 0, limit: 50 } },
    ]);
    await fetchOrdersPage(makeAdapter(stub), {
      updatedAfter: new Date("2026-08-05T00:00:00.000Z"),
    });
    // Asserted against the RAW recorded URL (not a re-parsed URLSearchParams)
    // so this test fails loudly if serialization ever stops percent-encoding
    // the operator-key brackets the way Medusa 2.18.0 was live-verified to
    // accept (see orders.ts's FetchMedusaOrdersInput.updatedAfter doc).
    expect(stub.calls[0]?.url).toContain(
      "updated_at%5B%24gte%5D=2026-08-05T00%3A00%3A00.000Z",
    );
  });
});

describe("watermark fail-open canary (loxep-pyg)", () => {
  it("throws a provider_unavailable error when fetchOrdersPage returns an order older than the watermark", async () => {
    const stub = createFetchStub([
      {
        body: {
          // Medusa 2.18.0 live-verified to fail OPEN like this on a typo'd
          // filter key/operator: HTTP 200, `count` and rows unfiltered.
          orders: [
            capturedOrderFixture({ updated_at: "2026-01-01T00:00:00.000Z" }),
          ],
          count: 1,
          offset: 0,
          limit: 50,
        },
      },
    ]);
    const error = await rejection(
      fetchOrdersPage(makeAdapter(stub), {
        updatedAfter: new Date("2026-08-05T00:00:00.000Z"),
      }),
    );
    expect(error).toBeInstanceOf(MedusaAdapterError);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.message).toMatch(/fail open|fail OPEN/i);
    expect(error.detail["watermark"]).toBe("2026-08-05T00:00:00.000Z");
    expect(error.detail["orderUpdatedAt"]).toBe("2026-01-01T00:00:00.000Z");
    expect(error.detail["externalOrderId"]).toBe("order_01FIXTURE0001");
  });

  it("throws mid-iteration when a later page in iterateMedusaOrders violates the watermark", async () => {
    const stub = createFetchStub([
      {
        body: {
          orders: [
            capturedOrderFixture({
              id: "order_ok",
              updated_at: "2026-08-06T00:00:00.000Z",
            }),
          ],
          count: 2,
          offset: 0,
          limit: 1,
        },
      },
      {
        body: {
          // Second page fails open — this is exactly the "first poisoned
          // page" the canary exists to catch immediately.
          orders: [
            capturedOrderFixture({
              id: "order_poisoned",
              updated_at: "2026-01-01T00:00:00.000Z",
            }),
          ],
          count: 2,
          offset: 1,
          limit: 1,
        },
      },
    ]);
    const ids: string[] = [];
    await expect(async () => {
      for await (const page of iterateMedusaOrders(makeAdapter(stub), {
        limit: 1,
        updatedAfter: "2026-08-05T00:00:00Z",
      })) {
        ids.push(...page.orders.map((o) => o.externalOrderId));
      }
    }).rejects.toBeInstanceOf(MedusaAdapterError);
    expect(ids).toEqual(["order_ok"]);
  });

  it("does not check the invariant when no watermark was supplied", async () => {
    const stub = createFetchStub([
      {
        body: {
          orders: [
            capturedOrderFixture({ updated_at: "2020-01-01T00:00:00.000Z" }),
          ],
          count: 1,
          offset: 0,
          limit: 50,
        },
      },
    ]);
    const result = await fetchOrdersPage(makeAdapter(stub));
    expect(result.orders).toHaveLength(1);
  });
});
