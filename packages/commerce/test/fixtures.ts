/**
 * Order fact fixtures.
 *
 * Two flavours:
 *
 * - {@link commerceOrderFact} builds a provider-neutral `CommerceOrderFact`
 *   directly, which is how the refund-line, fulfillment-line, seller-fee, and
 *   multi-currency paths get exercised without pretending a provider reports
 *   things it does not;
 * - {@link wooOrderPayload} builds a raw WooCommerce payload shaped like the
 *   live store's, so `mapWooOrder` → `wooOrderFactToCommerceFact` → ingestion
 *   is tested end to end through the real adapter code.
 *
 * **No fixture carries real personal data.** The Woo payloads here use
 * obviously synthetic values, and no test asserts on a payload's contents.
 */
import type {
  CommerceOrderFact,
  CommerceOrderFeeFact,
  CommerceOrderFulfillmentFact,
  CommerceOrderLineFact,
  CommerceOrderRefundFact,
} from "../src/facts.ts";

export interface OrderFactOverrides {
  externalOrderId?: string;
  sourceAccountKey?: string;
  currency?: string;
  status?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  providerStatusRaw?: string | null;
  subtotalAmount?: string;
  shippingAmount?: string;
  discountAmount?: string;
  taxAmount?: string;
  feeAmount?: string;
  refundedAmount?: string;
  totalAmount?: string;
  placedAt?: string;
  providerUpdatedAt?: string | null;
  lines?: CommerceOrderLineFact[];
  fees?: CommerceOrderFeeFact[];
  refunds?: CommerceOrderRefundFact[];
  fulfillments?: CommerceOrderFulfillmentFact[];
  rawPayload?: Record<string, unknown> | null;
}

export function commerceOrderLine(
  overrides: Partial<CommerceOrderLineFact> = {},
): CommerceOrderLineFact {
  return {
    lineNumber: 1,
    externalLineId: "line-1",
    externalItemId: "prod-1",
    externalVariationId: null,
    channelSku: "SKU-ALPHA",
    title: "Alpha widget",
    quantity: "2.000000",
    unitPrice: "25.000000",
    lineSubtotal: "50.000000",
    discountAmount: "0.000000",
    taxAmount: "4.000000",
    shippingAmount: "0.000000",
    refundedAmount: "0.000000",
    lineTotal: "50.000000",
    ...overrides,
  };
}

export function commerceOrderFact(
  overrides: OrderFactOverrides = {},
): CommerceOrderFact {
  const lines = overrides.lines ?? [commerceOrderLine()];
  return {
    provider: "woocommerce",
    channel: "woocommerce",
    marketplace: null,
    sourceAccountKey:
      overrides.sourceAccountKey ?? "woocommerce:https://shop.example.test",
    externalOrderId: overrides.externalOrderId ?? "1001",
    externalOrderNumber: overrides.externalOrderId ?? "1001",
    status: overrides.status ?? "completed",
    paymentStatus: overrides.paymentStatus ?? "paid",
    fulfillmentStatus: overrides.fulfillmentStatus ?? "fulfilled",
    providerStatusRaw:
      overrides.providerStatusRaw === undefined
        ? "completed"
        : overrides.providerStatusRaw,
    currency: overrides.currency ?? "USD",
    subtotalAmount: overrides.subtotalAmount ?? "50.000000",
    shippingAmount: overrides.shippingAmount ?? "5.000000",
    discountAmount: overrides.discountAmount ?? "0.000000",
    taxAmount: overrides.taxAmount ?? "4.000000",
    feeAmount: overrides.feeAmount ?? "0.000000",
    refundedAmount: overrides.refundedAmount ?? "0.000000",
    totalAmount: overrides.totalAmount ?? "59.000000",
    buyerExternalId: "cust-9",
    buyerDisplayName: null,
    placedAt: overrides.placedAt ?? "2026-08-01T12:00:00.000Z",
    providerUpdatedAt:
      overrides.providerUpdatedAt === undefined
        ? "2026-08-01T12:05:00.000Z"
        : overrides.providerUpdatedAt,
    cancelledAt: null,
    lines,
    fees: overrides.fees ?? [],
    refunds: overrides.refunds ?? [],
    fulfillments: overrides.fulfillments ?? [],
    rawPayload:
      overrides.rawPayload === undefined
        ? { id: Number(overrides.externalOrderId ?? "1001"), synthetic: true }
        : overrides.rawPayload,
    providerObjectType: "woocommerce.order",
  };
}

/* ------------------------------------------------------------ woo payloads */

export interface WooPayloadOverrides {
  id?: number;
  status?: string;
  currency?: string;
  total?: string;
  totalTax?: string;
  shippingTotal?: string;
  discountTotal?: string;
  dateModifiedGmt?: string;
  dateCreatedGmt?: string;
  dateCompletedGmt?: string | null;
  customerId?: number;
  lineItems?: Array<Record<string, unknown>>;
  feeLines?: Array<Record<string, unknown>>;
  refunds?: Array<Record<string, unknown>>;
  shippingCountry?: string;
  shippingState?: string;
}

/**
 * A raw WooCommerce order payload with the live store's quirks reproduced:
 * `number` is a STRING, `line_items[].price` is a JSON FLOAT while its
 * siblings are strings, `*_gmt` timestamps carry no zone designator, and a
 * plugin-injected top-level key is present.
 */
export function wooOrderPayload(
  overrides: WooPayloadOverrides = {},
): Record<string, unknown> {
  const id = overrides.id ?? 5001;
  return {
    id,
    // Documented as an integer; the live store returns a string.
    number: String(id),
    status: overrides.status ?? "completed",
    currency: overrides.currency ?? "USD",
    total: overrides.total ?? "59.00",
    total_tax: overrides.totalTax ?? "4.00",
    shipping_total: overrides.shippingTotal ?? "5.00",
    discount_total: overrides.discountTotal ?? "0.00",
    // No zone designator — the adapter must append the Z.
    date_created_gmt: overrides.dateCreatedGmt ?? "2026-08-01T12:00:00",
    date_modified_gmt: overrides.dateModifiedGmt ?? "2026-08-01T12:05:00",
    date_paid_gmt: "2026-08-01T12:01:00",
    date_completed_gmt:
      overrides.dateCompletedGmt === undefined
        ? "2026-08-01T12:04:00"
        : overrides.dateCompletedGmt,
    customer_id: overrides.customerId ?? 9,
    shipping: {
      country: overrides.shippingCountry ?? "US",
      state: overrides.shippingState ?? "NY",
      city: "Somewhere",
      address_1: "1 Synthetic Way",
      postcode: "00000",
    },
    line_items: overrides.lineItems ?? [
      {
        id: 41,
        name: "Alpha widget",
        product_id: 700,
        variation_id: 0,
        quantity: 2,
        sku: "SKU-ALPHA",
        // The payload's only float money field.
        price: 25,
        subtotal: "50.00",
        subtotal_tax: "4.00",
        total: "50.00",
        total_tax: "4.00",
        tax_class: "",
      },
    ],
    fee_lines: overrides.feeLines ?? [],
    refunds: overrides.refunds ?? [],
    // Plugin-injected key: mapping must be key-driven, never shape-exhaustive.
    wpo_wcpdf_invoice_number: `INV-${id}`,
  };
}
