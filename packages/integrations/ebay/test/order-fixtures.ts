/**
 * eBay Sell Fulfillment order payload fixtures.
 *
 * ## Provenance — DESIGN-DERIVED, NOT LIVE-VERIFIED
 *
 * Container and field names are taken from the OpenAPI types bundled with the
 * INSTALLED client (`ebay-api@10.0.0`,
 * `lib/types/restful/specs/sell_fulfillment_v1_oas3.d.ts`: `Order`,
 * `LineItem`, `PricingSummary`, `PaymentSummary`, `OrderRefund`,
 * `LineItemRefund`, `Amount`, `CancelStatus`, `Buyer`,
 * `FulfillmentStartInstruction`, `ShippingFulfillment`). Status VALUES
 * (`PAID`, `FULFILLED`, `CANCELED`, …) are plain `string` in that schema and
 * come from eBay's published documentation, so they are design-derived and
 * awaiting confirmation from the live sandbox leg (`live-orders.test.ts`).
 *
 * No fixture carries real personal data. The buyer/ship-to blocks are
 * deliberately populated with obviously-fake values because
 * `redactEbayOrderFact` has to be provably able to keep them out of anything
 * printable — a fixture with an empty `buyer` would test nothing.
 */

export interface EbayOrderFixtureInput {
  orderId?: string;
  sellerId?: string;
  creationDate?: string;
  lastModifiedDate?: string;
  orderPaymentStatus?: string;
  orderFulfillmentStatus?: string;
  cancelState?: string;
  cancelledDate?: string;
  /** `pricingSummary.total.value`. */
  total?: string;
  /** `totalMarketplaceFee.value`; omitted when null. */
  marketplaceFee?: string | null;
  /** `pricingSummary.fee.value`; omitted when null. */
  buyerFee?: string | null;
  /** `paymentSummary.refunds[]`. */
  refunds?: Array<{
    refundId: string;
    amount: string;
    refundStatus?: string;
    refundDate?: string;
  }>;
  /** Per-line refunds, keyed by the line item id. */
  lineRefunds?: Record<string, Array<{ refundId: string; amount: string }>>;
  /** Second line item, for multi-line cases. */
  secondLine?: boolean;
}

/** The buyer PII containers a real eBay payload carries. All fake. */
const FAKE_BUYER = {
  username: "sandbox-buyer-01",
  buyerRegistrationAddress: {
    fullName: "Fixture Person",
    email: "fixture.person@example.invalid",
    primaryPhone: { phoneNumber: "555-0100" },
    contactAddress: {
      addressLine1: "1 Fixture Way",
      city: "Testville",
      stateOrProvince: "NY",
      postalCode: "10001",
      countryCode: "US",
    },
  },
  taxAddress: {
    city: "Testville",
    stateOrProvince: "NY",
    postalCode: "10001",
    countryCode: "US",
  },
  taxIdentifier: {
    taxpayerId: "FAKE-TAXPAYER-ID",
    taxIdentifierType: "VAT",
    issuingCountry: "US",
  },
} as const;

export function ebayOrderPayload(
  input: EbayOrderFixtureInput = {},
): Record<string, unknown> {
  const orderId = input.orderId ?? "18-11223-44556";
  const lineRefunds = input.lineRefunds ?? {};
  const lineItems: Array<Record<string, unknown>> = [
    {
      lineItemId: "10101010",
      legacyItemId: "110485231234",
      legacyVariationId: "0",
      title: "Alpha widget",
      sku: "SKU-ALPHA",
      quantity: 2,
      soldFormat: "FIXED_PRICE",
      listingMarketplaceId: "EBAY_US",
      purchaseMarketplaceId: "EBAY_US",
      lineItemFulfillmentStatus: input.orderFulfillmentStatus ?? "FULFILLED",
      lineItemCost: { value: "50.00", currency: "USD" },
      discountedLineItemCost: { value: "45.00", currency: "USD" },
      deliveryCost: {
        shippingCost: { value: "5.00", currency: "USD" },
        handlingCost: { value: "0.00", currency: "USD" },
      },
      taxes: [
        {
          taxType: "STATE_SALES_TAX",
          amount: { value: "4.00", currency: "USD" },
        },
      ],
      appliedPromotions: [
        {
          promotionId: "PROMO-1",
          description: "Seller discount",
          discountAmount: { value: "5.00", currency: "USD" },
        },
      ],
      giftDetails: {
        recipientEmail: "gift.recipient@example.invalid",
        senderName: "Fixture Person",
        message: "enjoy",
      },
      refunds: (lineRefunds["10101010"] ?? []).map((refund) => ({
        refundId: refund.refundId,
        refundReferenceId: `REF-${refund.refundId}`,
        refundDate: "2026-08-02T09:00:00.000Z",
        amount: { value: refund.amount, currency: "USD" },
      })),
    },
  ];

  if (input.secondLine === true) {
    lineItems.push({
      lineItemId: "20202020",
      legacyItemId: "110485235678",
      title: "Beta gadget",
      sku: "SKU-BETA",
      quantity: 1,
      listingMarketplaceId: "EBAY_US",
      lineItemFulfillmentStatus: "NOT_STARTED",
      lineItemCost: { value: "20.00", currency: "USD" },
      deliveryCost: { shippingCost: { value: "0.00", currency: "USD" } },
      // Marketplace-facilitator shape: `taxes` absent, eBay-collected present.
      ebayCollectAndRemitTaxes: [
        {
          taxType: "STATE_SALES_TAX",
          collectionMethod: "NET",
          amount: { value: "1.60", currency: "USD" },
        },
      ],
      refunds: (lineRefunds["20202020"] ?? []).map((refund) => ({
        refundId: refund.refundId,
        refundReferenceId: `REF-${refund.refundId}`,
        refundDate: "2026-08-02T09:00:00.000Z",
        amount: { value: refund.amount, currency: "USD" },
      })),
    });
  }

  const payload: Record<string, unknown> = {
    orderId,
    legacyOrderId: "110485231234-2345678901",
    creationDate: input.creationDate ?? "2026-08-01T12:00:00.000Z",
    lastModifiedDate: input.lastModifiedDate ?? "2026-08-01T12:30:00.000Z",
    orderFulfillmentStatus: input.orderFulfillmentStatus ?? "FULFILLED",
    orderPaymentStatus: input.orderPaymentStatus ?? "PAID",
    sellerId: input.sellerId ?? "sandbox-seller-01",
    salesRecordReference: "8241",
    buyerCheckoutNotes: "please leave at the side door",
    buyer: FAKE_BUYER,
    pricingSummary: {
      priceSubtotal: { value: "70.00", currency: "USD" },
      priceDiscount: { value: "5.00", currency: "USD" },
      deliveryCost: { value: "5.00", currency: "USD" },
      deliveryDiscount: { value: "1.00", currency: "USD" },
      tax: { value: "5.60", currency: "USD" },
      total: { value: input.total ?? "74.60", currency: "USD" },
      ...(input.buyerFee === undefined || input.buyerFee === null
        ? {}
        : { fee: { value: input.buyerFee, currency: "USD" } }),
    },
    paymentSummary: {
      totalDueSeller: { value: "74.60", currency: "USD" },
      payments: [
        {
          paymentMethod: "EBAY_PAYMENT",
          paymentReferenceId: "PAY-1",
          paymentDate: "2026-08-01T12:05:00.000Z",
          amount: { value: "74.60", currency: "USD" },
          paymentStatus: "PAID",
        },
      ],
      refunds: (input.refunds ?? []).map((refund) => ({
        refundId: refund.refundId,
        refundReferenceId: `REF-${refund.refundId}`,
        refundDate: refund.refundDate ?? "2026-08-02T09:00:00.000Z",
        refundStatus: refund.refundStatus ?? "REFUNDED",
        amount: { value: refund.amount, currency: "USD" },
      })),
    },
    fulfillmentStartInstructions: [
      {
        fulfillmentInstructionsType: "SHIP_TO",
        minEstimatedDeliveryDate: "2026-08-04T07:00:00.000Z",
        maxEstimatedDeliveryDate: "2026-08-06T07:00:00.000Z",
        ebaySupportedFulfillment: false,
        shippingStep: {
          shippingCarrierCode: "USPS",
          shippingServiceCode: "USPSPriority",
          shipTo: {
            fullName: "Fixture Person",
            email: "fixture.person@example.invalid",
            primaryPhone: { phoneNumber: "555-0100" },
            contactAddress: {
              addressLine1: "1 Fixture Way",
              city: "Testville",
              stateOrProvince: "NY",
              postalCode: "10001",
              countryCode: "US",
            },
          },
        },
      },
    ],
    fulfillmentHrefs: [
      `https://api.ebay.com/sell/fulfillment/v1/order/${orderId}/shipping_fulfillment/1`,
    ],
    lineItems,
    totalFeeBasisAmount: { value: "74.60", currency: "USD" },
  };

  if (input.marketplaceFee !== null) {
    payload["totalMarketplaceFee"] = {
      value: input.marketplaceFee ?? "9.87",
      currency: "USD",
    };
  }

  if (input.cancelState !== undefined) {
    payload["cancelStatus"] = {
      cancelState: input.cancelState,
      ...(input.cancelledDate === undefined
        ? {}
        : { cancelledDate: input.cancelledDate }),
      cancelRequests: [],
    };
  }

  return payload;
}

/** `OrderSearchPagedCollection` around a list of order payloads. */
export function ebayOrdersResponse(
  orders: Array<Record<string, unknown>>,
  options: {
    limit?: number;
    offset?: number;
    total?: number;
    next?: string;
  } = {},
): Record<string, unknown> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  return {
    href: `https://api.ebay.com/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}`,
    limit,
    offset,
    total: options.total ?? orders.length,
    ...(options.next === undefined ? {} : { next: options.next }),
    orders,
    warnings: [],
  };
}

/** `ShippingFulfillmentPagedCollection`. */
export function ebayFulfillmentsResponse(
  fulfillments: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return { fulfillments, total: fulfillments.length, warnings: [] };
}

export function ebayFulfillmentPayload(
  input: {
    fulfillmentId?: string;
    trackingNumber?: string | null;
    carrierCode?: string | null;
    shippedDate?: string;
    lines?: Array<{ lineItemId: string; quantity: number }>;
  } = {},
): Record<string, unknown> {
  return {
    fulfillmentId: input.fulfillmentId ?? "9405511899223197428490",
    shipmentTrackingNumber:
      input.trackingNumber === null
        ? undefined
        : (input.trackingNumber ?? "9405511899223197428490"),
    shippingCarrierCode:
      input.carrierCode === null ? undefined : (input.carrierCode ?? "USPS"),
    shippedDate: input.shippedDate ?? "2026-08-01T18:00:00.000Z",
    lineItems: input.lines ?? [{ lineItemId: "10101010", quantity: 2 }],
  };
}
