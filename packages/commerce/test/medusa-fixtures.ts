/**
 * Medusa order-fact fixtures for the @loxep/commerce suite.
 *
 * These are `MedusaOrderFactLike` values built by hand rather than produced
 * by `@loxep/integration-medusa`'s `mapMedusaOrder`, and that is deliberate
 * on two counts — the same reasoning `ebay-fixtures.ts` documents:
 *
 * 1. `@loxep/commerce` takes no dependency on the Medusa integration package
 *    (see `src/medusa.ts`), so it could not import the mapper even if it
 *    wanted to. The adapter's own mapping is covered by fixtures in
 *    `packages/integrations/medusa/test/orders.test.ts` (and live-verified
 *    against a real 2.18.0 backend).
 * 2. The structural-compatibility claim — that a REAL `MedusaOrderFact` is
 *    assignable to `MedusaOrderFactLike` — is proved where both packages are
 *    legitimately available: `packages/app`'s Medusa order-sync test passes
 *    a real adapter fact straight through the translator.
 *
 * `totals` defaults to the EXACT live-observed numbers the adapter's module
 * doc records for a €30 order after a €5 refund (`total` moves to 25,
 * `original_total` stays 30, `subtotal` stays 30 and includes 10 of
 * shipping) — the fixture that pins mapping #1 and #2 is this file's default,
 * not a special case a test has to construct.
 *
 * `raw` deliberately carries a small PII-shaped block so an ingestion test can
 * assert that none of it reaches a domain column.
 */
import type { MedusaOrderFactLike } from "../src/medusa.ts";

export interface MedusaOrderFactOverrides {
  externalOrderId?: string;
  sourceAccountKey?: string;
  status?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  providerStatusRaw?: string;
  statusRecognized?: boolean;
  updatedAt?: string | null;
  placedAt?: string;
  total?: string;
  originalTotal?: string;
  subtotal?: string;
  shipping?: string;
  tax?: string;
  discount?: string;
  refunded?: string;
  buyerExternalId?: string | null;
  lineItems?: MedusaOrderFactLike["lineItems"];
  refunds?: MedusaOrderFactLike["refunds"];
  fulfillments?: MedusaOrderFactLike["fulfillments"];
}

export function medusaLineFact(
  overrides: Partial<MedusaOrderFactLike["lineItems"][number]> = {},
): MedusaOrderFactLike["lineItems"][number] {
  return {
    externalLineId: "item_01ALPHAWIDGET",
    lineNumber: 1,
    sku: "SKU-ALPHA",
    name: "Alpha widget",
    externalItemId: "prod_01ALPHAWIDGET",
    externalVariationId: "variant_01ALPHAWIDGET",
    quantity: "2",
    unitPrice: "10",
    lineSubtotal: "20.00",
    lineTotal: "20.00",
    lineTax: "0.00",
    discount: "0.00",
    ...overrides,
  };
}

export function medusaRefundFact(
  overrides: Partial<MedusaOrderFactLike["refunds"][number]> = {},
): MedusaOrderFactLike["refunds"][number] {
  return {
    externalRefundId: "ref_01REFUND",
    reason: "customer_changed_mind",
    amount: "5.00",
    createdAt: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

export function medusaFulfillmentFact(
  overrides: Partial<MedusaOrderFactLike["fulfillments"][number]> = {},
): MedusaOrderFactLike["fulfillments"][number] {
  return {
    externalFulfillmentId: "ful_01SHIPMENT",
    status: "shipped",
    trackingNumbers: ["1Z999AA10123456784"],
    trackingUrls: ["https://carrier.example.invalid/track/1Z999AA10123456784"],
    shippedAt: "2026-08-01T18:00:00.000Z",
    deliveredAt: null,
    canceledAt: null,
    destinationCountry: "US",
    destinationRegion: "NY",
    ...overrides,
  };
}

export function medusaOrderFact(
  overrides: MedusaOrderFactOverrides = {},
): MedusaOrderFactLike {
  const lineItems = overrides.lineItems ?? [medusaLineFact()];
  const status = overrides.status ?? "completed";
  const paymentStatus = overrides.paymentStatus ?? "partially_refunded";
  const fulfillmentStatus = overrides.fulfillmentStatus ?? "fulfilled";
  const updatedAt =
    overrides.updatedAt === undefined
      ? "2026-08-02T09:30:00.000Z"
      : overrides.updatedAt;
  return {
    externalOrderId: overrides.externalOrderId ?? "order_01JAAABBBCCCDDD",
    orderNumber: "1042",
    sourceAccountKey:
      overrides.sourceAccountKey ?? "medusa:https://shop.example.test",
    status,
    paymentStatus,
    fulfillmentStatus,
    providerStatusRaw: overrides.providerStatusRaw ?? status,
    providerPaymentStatusRaw: paymentStatus,
    providerFulfillmentStatusRaw: fulfillmentStatus,
    statusRecognized: overrides.statusRecognized ?? true,
    currency: "USD",
    totals: {
      // The live-observed shape (module doc, medusa/src/orders.ts): a €30
      // order after a €5 refund. `total` moves; `original_total` and
      // `subtotal` do not.
      total: overrides.total ?? "25.00",
      originalTotal: overrides.originalTotal ?? "30.00",
      subtotal: overrides.subtotal ?? "30.00",
      shipping: overrides.shipping ?? "10.00",
      tax: overrides.tax ?? "0.00",
      discount: overrides.discount ?? "0.00",
      refunded: overrides.refunded ?? "5.00",
    },
    placedAt: overrides.placedAt ?? "2026-08-01T12:00:00.000Z",
    updatedAt,
    paidAt: "2026-08-01T12:05:00.000Z",
    // Always null — see medusa.ts mapping #4.
    cancelledAt: null,
    buyerExternalId:
      overrides.buyerExternalId === undefined
        ? "cus_01BUYERFIXTURE"
        : overrides.buyerExternalId,
    lineItems,
    refunds: overrides.refunds ?? [],
    fulfillments: overrides.fulfillments ?? [],
    // The retained payload MOVES with the fact, the way a real one does:
    // provenance is hash-deduplicated on `raw`, so a fixture whose payload
    // never changed would make every re-sync look unchanged regardless of
    // the fact's contents.
    raw: {
      id: overrides.externalOrderId ?? "order_01JAAABBBCCCDDD",
      updated_at: updatedAt,
      status,
      // Deliberately PII-shaped: an ingestion test asserts none of it lands
      // in a domain column, only in `provider_objects`.
      email: "fixture.person@example.invalid",
      shipping_address: {
        first_name: "Fixture",
        last_name: "Person",
        address_1: "1 Fixture Way",
        country_code: "us",
      },
    },
  };
}
