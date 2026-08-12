/**
 * eBay order-fact fixtures for the @loxep/commerce suite.
 *
 * These are `EbayOrderFactLike` values built by hand rather than produced by
 * `@loxep/integration-ebay`'s `mapEbayOrder`, and that is deliberate on two
 * counts:
 *
 * 1. `@loxep/commerce` takes no dependency on the eBay integration package
 *    (see `src/ebay.ts`), so it could not import the mapper even if it wanted
 *    to. The adapter's own mapping is covered by fixtures in
 *    `packages/integrations/ebay/test/orders.test.ts`.
 * 2. The structural-compatibility claim — that a REAL `EbayOrderFact` is
 *    assignable to `EbayOrderFactLike` — is proved where both packages are
 *    legitimately available: `packages/app`'s eBay order-sync test passes a
 *    real adapter fact straight through the translator.
 *
 * `raw` deliberately carries a small PII-shaped block so an ingestion test can
 * assert that none of it reaches a domain column.
 */
import type { EbayOrderFactLike } from "../src/ebay.ts";

export interface EbayOrderFactOverrides {
  externalOrderId?: string;
  sourceAccountKey?: string;
  status?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  providerStatusRaw?: string;
  updatedAt?: string | null;
  placedAt?: string;
  cancelledAt?: string | null;
  total?: string;
  fee?: string;
  refunded?: string;
  lineItems?: EbayOrderFactLike["lineItems"];
  fees?: EbayOrderFactLike["fees"];
  refunds?: EbayOrderFactLike["refunds"];
  fulfillments?: EbayOrderFactLike["fulfillments"];
  buyerDisplayName?: string | null;
  marketplace?: string | null;
}

export function ebayLineFact(
  overrides: Partial<EbayOrderFactLike["lineItems"][number]> = {},
): EbayOrderFactLike["lineItems"][number] {
  return {
    externalLineId: "10101010",
    lineNumber: 1,
    sku: "SKU-ALPHA",
    name: "Alpha widget",
    externalItemId: "110485231234",
    externalVariationId: null,
    quantity: "2",
    unitPrice: "25",
    lineSubtotal: "50.00",
    lineTotal: "45.00",
    discount: "5.00",
    lineTax: "4.00",
    lineShipping: "5.00",
    lineRefunded: "0.00",
    ...overrides,
  };
}

export function ebayOrderFact(
  overrides: EbayOrderFactOverrides = {},
): EbayOrderFactLike {
  const lineItems = overrides.lineItems ?? [ebayLineFact()];
  return {
    externalOrderId: overrides.externalOrderId ?? "18-11223-44556",
    orderNumber: "8241",
    sourceAccountKey: overrides.sourceAccountKey ?? "ebay:sandbox-seller-01",
    marketplace:
      overrides.marketplace === undefined ? "EBAY_US" : overrides.marketplace,
    status: overrides.status ?? "completed",
    paymentStatus: overrides.paymentStatus ?? "paid",
    fulfillmentStatus: overrides.fulfillmentStatus ?? "fulfilled",
    providerStatusRaw: overrides.providerStatusRaw ?? "PAID/FULFILLED",
    currency: "USD",
    totals: {
      total: overrides.total ?? "74.60",
      subtotal: "70.00",
      shipping: "5.00",
      tax: "5.60",
      discount: "6.00",
      fee: overrides.fee ?? "9.87",
      refunded: overrides.refunded ?? "0.00",
    },
    placedAt: overrides.placedAt ?? "2026-08-01T12:00:00.000Z",
    updatedAt:
      overrides.updatedAt === undefined
        ? "2026-08-01T12:30:00.000Z"
        : overrides.updatedAt,
    cancelledAt: overrides.cancelledAt ?? null,
    buyerExternalId: "sandbox-buyer-01",
    buyerDisplayName:
      overrides.buyerDisplayName === undefined
        ? "sandbox-buyer-01"
        : overrides.buyerDisplayName,
    destinationCountry: "US",
    destinationRegion: "NY",
    lineItems,
    fees: overrides.fees ?? [
      {
        externalFeeId: "ebay:total-marketplace-fee",
        feeType: "marketplace_final_value",
        feeDirection: "seller_charge",
        providerFeeCode: "totalMarketplaceFee",
        description: "eBay marketplace fees (aggregate)",
        currency: "USD",
        amount: overrides.fee ?? "9.87",
      },
    ],
    refunds: overrides.refunds ?? [],
    fulfillments:
      overrides.fulfillments === undefined ? null : overrides.fulfillments,
    // The retained payload MOVES with the fact, the way a real one does:
    // provenance is hash-deduplicated on `raw`, so a fixture whose payload
    // never changed would make every re-sync look unchanged regardless of the
    // fact's contents.
    raw: {
      orderId: overrides.externalOrderId ?? "18-11223-44556",
      lastModifiedDate:
        overrides.updatedAt === undefined
          ? "2026-08-01T12:30:00.000Z"
          : overrides.updatedAt,
      orderFulfillmentStatus: (overrides.fulfillmentStatus ?? "fulfilled")
        .toUpperCase(),
      orderPaymentStatus: (overrides.paymentStatus ?? "paid").toUpperCase(),
      // Deliberately PII-shaped: an ingestion test asserts none of it lands
      // in a domain column, only in `provider_objects`.
      buyer: {
        username: "sandbox-buyer-01",
        buyerRegistrationAddress: {
          fullName: "Fixture Person",
          email: "fixture.person@example.invalid",
          contactAddress: { addressLine1: "1 Fixture Way", countryCode: "US" },
        },
      },
    },
  };
}
