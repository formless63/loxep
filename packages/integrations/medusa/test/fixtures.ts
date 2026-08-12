/**
 * Fixture payloads for the Medusa v2 Admin API. Originally constructed from
 * the source-verified DTOs (`medusajs/medusa`, `develop`, fetched
 * 2026-08-11); the SHAPES were subsequently checked against a real Medusa
 * 2.18.0 backend (loxep-xh9.4.1) and reconciled where they differed.
 *
 * The reconciliation worth knowing about: these fixtures always populated
 * `payment_collections[].payments[]` with `amount`/`captured_at`, because the
 * DTO says a payment has them. A live response only includes them if the
 * request's `fields` list asks for the intermediate `payments` level — which
 * the adapter's list did not, until loxep-xh9.4.1 fixed it. The fixtures were
 * right about the entity and wrong about what arrives by default, which is
 * precisely the class of error fixtures cannot catch. `test/live-store.test.ts`
 * now guards it.
 *
 * ALL DATA HERE IS FAKE. No value in this file corresponds to any real
 * Medusa deployment.
 */

export interface FixtureOverrides {
  [key: string]: unknown;
}

/**
 * A captured, unfulfilled USD order with one line item — the ordinary case.
 * Field names follow `BaseOrder`/`BaseOrderLineItem`
 * (packages/core/types/src/http/order/common.ts).
 */
export function capturedOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return {
    id: "order_01FIXTURE0001",
    display_id: 1001,
    status: "pending",
    currency_code: "usd",
    email: "fixture@example.invalid",
    customer_id: "cus_01FIXTURE0001",
    created_at: "2026-07-01T13:15:00.000Z",
    updated_at: "2026-07-03T15:00:00.000Z",
    total: 48.15,
    // Live-observed pairing: `total` is the CURRENT total and `original_total`
    // the as-placed one. They match until a refund lands (see
    // partiallyRefundedOrderFixture).
    original_total: 48.15,
    subtotal: 45,
    tax_total: 3.2,
    discount_total: 5,
    shipping_total: 9.95,
    payment_status: "captured",
    fulfillment_status: "not_fulfilled",
    items: [
      {
        id: "orli_01FIXTURE0001",
        title: "Fixture Widget",
        product_id: "prod_01FIXTURE0001",
        variant_id: "variant_01FIXTURE0001",
        variant_sku: "FIX-WIDGET-01",
        quantity: 2,
        unit_price: 22.5,
        subtotal: 45,
        total: 40,
        tax_total: 3.2,
        discount_total: 5,
        detail: {
          quantity: 2,
          fulfilled_quantity: 0,
          shipped_quantity: 0,
          delivered_quantity: 0,
        },
      },
    ],
    payment_collections: [
      {
        id: "pay_col_01FIXTURE0001",
        payments: [
          {
            id: "pay_01FIXTURE0001",
            amount: 48.15,
            currency_code: "usd",
            captured_at: "2026-07-01T13:15:03.000Z",
            refunds: [],
          },
        ],
      },
    ],
    fulfillments: [],
    ...overrides,
  };
}

/** Guest checkout — no `customer_id`, no `email`. */
export function guestOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  const { customer_id: _dropCustomer, email: _dropEmail, ...base } =
    capturedOrderFixture();
  return {
    ...base,
    id: "order_01FIXTURE0002",
    display_id: 1002,
    total: 19.99,
    original_total: 19.99,
    subtotal: 19.99,
    tax_total: 0,
    discount_total: 0,
    shipping_total: 0,
    items: [
      {
        id: "orli_01FIXTURE0002",
        title: "Fixture Download",
        product_id: "prod_01FIXTURE0002",
        variant_id: "variant_01FIXTURE0002",
        variant_sku: null,
        quantity: 1,
        unit_price: 19.99,
        subtotal: 19.99,
        total: 19.99,
        tax_total: 0,
        discount_total: 0,
        detail: {
          quantity: 1,
          fulfilled_quantity: 0,
          shipped_quantity: 0,
          delivered_quantity: 0,
        },
      },
    ],
    payment_collections: [],
    ...overrides,
  };
}

/**
 * A fully delivered order — non-empty `fulfillments[]` with tracking labels
 * and a `delivered_at` timestamp.
 */
export function deliveredOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return capturedOrderFixture({
    id: "order_01FIXTURE0003",
    display_id: 1003,
    status: "completed",
    fulfillment_status: "delivered",
    fulfillments: [
      {
        id: "ful_01FIXTURE0003",
        packed_at: "2026-07-02T10:00:00.000Z",
        shipped_at: "2026-07-02T18:00:00.000Z",
        delivered_at: "2026-07-05T12:00:00.000Z",
        canceled_at: null,
        labels: [
          {
            id: "ful_label_01FIXTURE0003",
            tracking_number: "FIXTURE-TRACK-0001",
            tracking_url: "https://carrier.example.invalid/track/FIXTURE-TRACK-0001",
            label_url: "https://carrier.example.invalid/label/FIXTURE-TRACK-0001.pdf",
          },
        ],
        delivery_address: {
          country_code: "us",
          province: "NY",
        },
      },
    ],
    ...overrides,
  });
}

/**
 * A partially refunded order — two refunds under one payment.
 *
 * `total` is 12.50 BELOW `original_total`, mirroring live Medusa 2.18.0
 * behavior: issuing a refund lowers the order's `total` while
 * `original_total` and `subtotal` stay put. Do not "fix" this to match
 * `original_total` — a consumer that computes `total - refunded` from this
 * payload is double-counting, which is exactly what this fixture exists to
 * make visible.
 */
export function partiallyRefundedOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return capturedOrderFixture({
    id: "order_01FIXTURE0004",
    display_id: 1004,
    total: 35.65,
    original_total: 48.15,
    payment_status: "partially_refunded",
    payment_collections: [
      {
        id: "pay_col_01FIXTURE0004",
        payments: [
          {
            id: "pay_01FIXTURE0004",
            amount: 48.15,
            currency_code: "usd",
            captured_at: "2026-07-01T13:15:03.000Z",
            refunds: [
              {
                id: "ref_01FIXTURE0004",
                amount: 10,
                note: null,
                created_at: "2026-07-06T09:00:00.000Z",
                refund_reason: { id: "rr_01", label: "Damaged in transit" },
              },
              {
                id: "ref_01FIXTURE0005",
                amount: 2.5,
                note: "customer request",
                created_at: "2026-07-06T09:05:00.000Z",
                refund_reason: null,
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  });
}

/** A canceled order. */
export function canceledOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return capturedOrderFixture({
    id: "order_01FIXTURE0006",
    display_id: 1006,
    status: "canceled",
    payment_status: "canceled",
    fulfillment_status: "canceled",
    ...overrides,
  });
}

/**
 * A JPY order — JPY is 0-decimal-digit in Medusa's own currency table
 * (`MEDUSA_CURRENCY_DECIMAL_DIGITS.JPY === 0`), so its `total` etc. arrive
 * as whole numbers with no fractional part at all.
 */
export function jpyOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return capturedOrderFixture({
    id: "order_01FIXTURE0007",
    display_id: 1007,
    currency_code: "jpy",
    total: 5000,
    original_total: 5000,
    subtotal: 5000,
    tax_total: 0,
    discount_total: 0,
    shipping_total: 0,
    items: [
      {
        id: "orli_01FIXTURE0007",
        title: "Fixture Widget (JPY)",
        product_id: "prod_01FIXTURE0001",
        variant_id: "variant_01FIXTURE0001",
        variant_sku: "FIX-WIDGET-01",
        quantity: 1,
        unit_price: 5000,
        subtotal: 5000,
        total: 5000,
        tax_total: 0,
        discount_total: 0,
        detail: {
          quantity: 1,
          fulfilled_quantity: 0,
          shipped_quantity: 0,
          delivered_quantity: 0,
        },
      },
    ],
    payment_collections: [],
    ...overrides,
  });
}

/**
 * An order whose `tax_total` carries MORE fractional digits than USD's
 * nominal 2 — reproducing the documented upstream precision defect
 * (https://github.com/medusajs/medusa/issues/14818) that `money.ts`
 * deliberately does not round away.
 */
export function excessPrecisionOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return capturedOrderFixture({
    id: "order_01FIXTURE0008",
    display_id: 1008,
    tax_total: 3.199999,
    ...overrides,
  });
}

export function productFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return {
    id: "prod_01FIXTURE0001",
    title: "Fixture Widget",
    status: "published",
    handle: "fixture-widget",
    thumbnail: "https://cdn.example.invalid/fixture-widget.png",
    updated_at: "2026-06-02T14:00:00.000Z",
    variants: [
      {
        id: "variant_01FIXTURE0001",
        title: "Default",
        sku: "FIX-WIDGET-01",
        prices: [
          { id: "price_01", currency_code: "usd", amount: 22.5 },
          { id: "price_02", currency_code: "eur", amount: 20.99 },
        ],
      },
    ],
    ...overrides,
  };
}

/** A product with multiple variants — a real Medusa shape, unlike a WooCommerce simple product. */
export function multiVariantProductFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return productFixture({
    id: "prod_01FIXTURE0002",
    title: "Fixture Shirt",
    variants: [
      {
        id: "variant_01FIXTURE0002",
        title: "Small / Blue",
        sku: "FIX-SHIRT-S-BLUE",
        prices: [{ id: "price_03", currency_code: "usd", amount: 19.99 }],
      },
      {
        id: "variant_01FIXTURE0003",
        title: "Large / Blue",
        sku: "FIX-SHIRT-L-BLUE",
        prices: [{ id: "price_04", currency_code: "usd", amount: 21.99 }],
      },
    ],
    ...overrides,
  });
}

/** The Medusa error envelope, exactly as `error-handler.ts` builds it. */
export function medusaErrorBody(
  type: string,
  message: string,
  code?: string,
): Record<string, unknown> {
  return code === undefined ? { type, message } : { type, message, code };
}
