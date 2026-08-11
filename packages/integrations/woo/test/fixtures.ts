/**
 * Fixture payloads constructed from the DOCUMENTED WooCommerce REST v3 shapes
 * (plus the three documentation-vs-reality divergences confirmed against a
 * live store: `number` is a string, `line_items[].price` is a float, and
 * plugins inject unknown top-level keys).
 *
 * ALL DATA HERE IS FAKE. No value in this file was copied from the live store,
 * and the "personal" fields carry obvious placeholders on purpose — a fixture
 * that looks like a real customer is a fixture someone will eventually paste
 * into an issue.
 */

export interface FixtureOverrides {
  [key: string]: unknown;
}

/**
 * A completed, paid, single-line order with shipping and tax — the ordinary
 * case. Field names and types follow the docs; `number` is a string and
 * `line_items[].price` is a JSON number, matching observed reality.
 */
export function completedOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return {
    id: 1042,
    parent_id: 0,
    number: "1042",
    order_key: "wc_order_FAKEKEY000",
    created_via: "checkout",
    version: "10.9.3",
    status: "completed",
    currency: "USD",
    currency_symbol: "$",
    date_created: "2026-07-01T09:15:00",
    date_created_gmt: "2026-07-01T13:15:00",
    date_modified: "2026-07-03T11:00:00",
    date_modified_gmt: "2026-07-03T15:00:00",
    discount_total: "5.00",
    discount_tax: "0.00",
    shipping_total: "9.95",
    shipping_tax: "0.00",
    cart_tax: "3.20",
    total: "48.15",
    total_tax: "3.20",
    prices_include_tax: false,
    customer_id: 77,
    customer_ip_address: "203.0.113.7",
    customer_user_agent: "fixture-agent",
    customer_note: "",
    billing: {
      first_name: "Fixture",
      last_name: "Buyer",
      address_1: "1 Placeholder Way",
      city: "Testville",
      state: "NY",
      postcode: "00000",
      country: "US",
      email: "fixture@example.invalid",
      phone: "+1-555-0100",
    },
    shipping: {
      first_name: "Fixture",
      last_name: "Buyer",
      address_1: "1 Placeholder Way",
      city: "Testville",
      state: "NY",
      postcode: "00000",
      country: "US",
    },
    payment_method: "fixture_gateway",
    payment_method_title: "Fixture Gateway",
    transaction_id: "txn_FAKE_0001",
    date_paid: "2026-07-01T09:15:03",
    date_paid_gmt: "2026-07-01T13:15:03",
    date_completed: "2026-07-03T11:00:00",
    date_completed_gmt: "2026-07-03T15:00:00",
    cart_hash: "0000000000000000",
    line_items: [
      {
        id: 501,
        name: "Fixture Widget",
        product_id: 900,
        variation_id: 901,
        quantity: 2,
        tax_class: "",
        // Pre-discount line subtotal; `total` is post-discount.
        subtotal: "45.00",
        subtotal_tax: "3.60",
        total: "40.00",
        total_tax: "3.20",
        taxes: [],
        meta_data: [],
        sku: "FIX-WIDGET-01",
        // DIVERGENCE: a JSON number, unlike every sibling money field.
        price: 22.5,
      },
    ],
    tax_lines: [
      {
        id: 601,
        rate_code: "US-NY-1",
        rate_id: 1,
        label: "NY Tax",
        compound: false,
        tax_total: "3.20",
        shipping_tax_total: "0.00",
      },
    ],
    shipping_lines: [
      {
        id: 701,
        method_title: "Flat rate",
        method_id: "flat_rate",
        total: "9.95",
        total_tax: "0.00",
      },
    ],
    fee_lines: [],
    coupon_lines: [],
    refunds: [],
    meta_data: [],
    // A plugin-injected top-level key, as seen on the live store.
    wpo_wcpdf_invoice_number: "INV-1042",
    ...overrides,
  };
}

/** Guest checkout (`customer_id: 0`), no variation, no SKU, quantity 1. */
export function guestOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return completedOrderFixture({
    id: 1043,
    number: "1043",
    status: "processing",
    customer_id: 0,
    total: "19.99",
    total_tax: "0.00",
    cart_tax: "0.00",
    shipping_total: "0.00",
    discount_total: "0.00",
    date_completed_gmt: null,
    date_completed: null,
    line_items: [
      {
        id: 502,
        name: "Fixture Download",
        product_id: 910,
        variation_id: 0,
        quantity: 1,
        tax_class: "",
        subtotal: "19.99",
        subtotal_tax: "0.00",
        total: "19.99",
        total_tax: "0.00",
        taxes: [],
        meta_data: [],
        sku: "",
        price: 19.99,
      },
    ],
    tax_lines: [],
    ...overrides,
  });
}

/**
 * Partially refunded: Woo keeps the status (`completed` here) and reports the
 * refund in the embedded `refunds` array with a NEGATIVE total.
 */
export function partiallyRefundedOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return completedOrderFixture({
    id: 1044,
    number: "1044",
    status: "completed",
    refunds: [
      { id: 1101, reason: "Damaged in transit", total: "-10.00" },
      { id: 1102, reason: "", total: "-2.50" },
    ],
    ...overrides,
  });
}

/** An order carrying buyer-facing fee lines (handling + gift wrap). */
export function feeLineOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return completedOrderFixture({
    id: 1045,
    number: "1045",
    total: "56.15",
    fee_lines: [
      {
        id: 801,
        name: "Handling",
        tax_class: "",
        tax_status: "taxable",
        total: "5.00",
        total_tax: "0.40",
        taxes: [],
        meta_data: [],
      },
      {
        id: 802,
        name: "Gift wrap",
        tax_class: "",
        tax_status: "none",
        total: "3.00",
        total_tax: "0.00",
        taxes: [],
        meta_data: [],
      },
    ],
    ...overrides,
  });
}

/** Multi-line order used for the derived-subtotal check. */
export function multiLineOrderFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return completedOrderFixture({
    id: 1046,
    number: "1046",
    line_items: [
      {
        id: 510,
        name: "Line A",
        product_id: 920,
        variation_id: 0,
        quantity: 1,
        tax_class: "",
        subtotal: "10.10",
        subtotal_tax: "0.00",
        total: "10.10",
        total_tax: "0.00",
        taxes: [],
        meta_data: [],
        sku: "A",
        price: 10.1,
      },
      {
        id: 511,
        name: "Line B",
        product_id: 921,
        variation_id: 0,
        quantity: 3,
        tax_class: "",
        subtotal: "0.20",
        subtotal_tax: "0.00",
        total: "0.20",
        total_tax: "0.00",
        taxes: [],
        meta_data: [],
        sku: "B",
        price: 0.2,
      },
      {
        id: 512,
        name: "Line C",
        product_id: 922,
        variation_id: 0,
        quantity: 1,
        tax_class: "reduced-rate",
        subtotal: "0.001",
        subtotal_tax: "0.00",
        total: "0.001",
        total_tax: "0.00",
        taxes: [],
        meta_data: [],
        sku: "C",
        price: 0.001,
      },
    ],
    ...overrides,
  });
}

export function productFixture(
  overrides: FixtureOverrides = {},
): Record<string, unknown> {
  return {
    id: 900,
    name: "Fixture Widget",
    slug: "fixture-widget",
    permalink: "https://shop.example.invalid/product/fixture-widget/",
    date_created: "2026-01-02T10:00:00",
    date_created_gmt: "2026-01-02T15:00:00",
    date_modified: "2026-06-02T10:00:00",
    date_modified_gmt: "2026-06-02T14:00:00",
    type: "simple",
    status: "publish",
    featured: false,
    catalog_visibility: "visible",
    description: "",
    short_description: "",
    sku: "FIX-WIDGET-01",
    // Products DO report price as a string, unlike order line items.
    price: "22.50",
    regular_price: "25.00",
    sale_price: "22.50",
    stock_status: "instock",
    stock_quantity: 12,
    images: [],
    attributes: [],
    variations: [],
    meta_data: [],
    ...overrides,
  };
}

/** The WordPress REST error envelope, exactly as observed. */
export function wpErrorBody(
  code: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { code, message, data: { status, ...extra } };
}
