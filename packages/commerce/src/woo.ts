/**
 * WooCommerce → Loxep translation: `WooOrderFact` (the integration boundary's
 * shape) onto `CommerceOrderFact` (the shape the database sees).
 *
 * This is the only module in @loxep/commerce that knows WooCommerce exists.
 * Adding eBay or Medusa means adding a sibling, not touching `orders.ts`.
 *
 * ## PROVISIONAL decisions taken here
 *
 * Every one of these follows from the design document's "Provider reality
 * findings (WooCommerce)" and is marked PROVISIONAL pending owner review.
 *
 * 1. **`fee_lines` become `buyer_surcharge` fees, not seller charges.** A Woo
 *    `fee_line` is a surcharge the merchant adds to the BUYER's cart
 *    (handling, small-order, COD, gift wrap) and is already inside
 *    `orders.total`. WooCommerce core reports NO seller-side fees at all —
 *    gateway charges live in the payment plugin, outside the REST API. So the
 *    rows are written with `fee_direction = 'buyer_surcharge'` and
 *    `orders.fee_amount` stays `0`: it is defined as the magnitude of
 *    SELLER-side deductions, and summing buyer surcharges into it would make
 *    every Woo contribution figure wrong by the surcharge.
 *
 * 2. **`fulfillment_status` gains `unknown`, and Woo uses it.** Woo's
 *    `refunded` status REPLACES whatever came before, so a fully refunded
 *    order no longer says whether it shipped. The adapter (correctly, given
 *    the union it was written against) degrades that to `unfulfilled`, which
 *    asserts a fact nobody observed. This translator re-maps it — and any
 *    status the adapter did not recognize — to `unknown`.
 *
 *    This re-mapping lives HERE rather than in the adapter only because
 *    `packages/integrations/woo` was outside this change's write fence; the
 *    correct long-term home is `WOO_STATUS_MAP`. See the filed follow-up bead.
 *
 * 3. **A `completed` order yields one synthesized fulfillment.** Woo has no
 *    fulfillment objects, but `completed` IS the channel stating the order
 *    went out, so one `order_fulfillments` row covering every line at full
 *    quantity is a faithful record of what the channel said — with no carrier,
 *    no tracking, and no invented shipment. Any other status yields none:
 *    "the channel reported nothing" must not become an empty shipment record.
 *
 * 4. **`buyer_display_name` stays null.** Woo exposes no channel-native
 *    handle; the only name in the payload is the buyer's real name on a
 *    billing address. The design's display-name column is for handles (an eBay
 *    username), and copying a legal name into a domain column would defeat the
 *    data-minimization line open question 8 draws. The billing block remains
 *    recoverable from `provider_objects`.
 *
 * 5. **`subtotal_amount` is the adapter's DERIVED subtotal.** WooCommerce
 *    reports no order-level subtotal at all; the adapter computes the exact
 *    scaled-integer sum of `line_items[].subtotal`. Stored not-null, with the
 *    provenance recorded here and in the design doc, rather than made nullable
 *    — every reader would otherwise have to re-derive the same sum.
 */
import type {
  WooFeeLineFact,
  WooOrderFact,
  WooOrderLineFact,
  WooRefundRef,
} from "@loxep/integration-woo";
import { divideDecimals, toMoneyString } from "./decimal.ts";
import type {
  CommerceOrderFact,
  CommerceOrderFeeFact,
  CommerceOrderFulfillmentFact,
  CommerceOrderLineFact,
  CommerceOrderRefundFact,
} from "./facts.ts";

/** `orders.provider` for this adapter family. */
export const WOO_PROVIDER = "woocommerce";

/** Default `orders.channel`. A Woo store is its own single selling surface. */
export const WOO_DEFAULT_CHANNEL = "woocommerce";

/** `provider_objects.object_type` / `source_events.event_type` for Woo orders. */
export const WOO_ORDER_OBJECT_TYPE = "woocommerce.order";

/**
 * Synthetic `external_fulfillment_id` for the fulfillment implied by a
 * `completed` order. Deterministic, so a re-sync updates the same row instead
 * of appending a second one.
 */
export const WOO_COMPLETED_FULFILLMENT_ID = "woo:order-completed";

export interface WooTranslationOptions {
  /** Override `orders.channel` when an installation names the surface itself. */
  channel?: string;
  /** Retain the raw payload for `provider_objects` (default true). */
  retainRawPayload?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `unit_price` is `not null` in the schema, but Woo's `line_items[].price` is
 * the payload's one float money field and the adapter returns null rather than
 * approximate when it cannot be written exactly in plain decimal notation.
 *
 * Fallback chain: the adapter's value → the EXACT quotient of the line
 * subtotal by the quantity → that quotient rounded to `numeric(20,6)`. Only
 * the last step rounds, it is the sole rounded value anywhere in this package,
 * and nothing is ever derived from it: every order and line TOTAL comes from
 * the provider.
 */
function resolveUnitPrice(line: WooOrderLineFact): string {
  if (line.unitPrice !== null) return toMoneyString(line.unitPrice);
  const quotient = divideDecimals(line.lineSubtotal, line.quantity);
  return quotient.value;
}

function translateLine(line: WooOrderLineFact): CommerceOrderLineFact {
  return {
    lineNumber: line.lineNumber,
    externalLineId: line.externalLineId,
    externalItemId: line.externalItemId,
    externalVariationId: line.externalVariationId,
    channelSku: line.sku,
    title: asText(line.name),
    quantity: toMoneyString(line.quantity),
    unitPrice: resolveUnitPrice(line),
    lineSubtotal: toMoneyString(line.lineSubtotal),
    discountAmount: toMoneyString(line.discount),
    taxAmount: toMoneyString(line.lineTax),
    // Woo apportions no shipping to lines; shipping_total is order-level.
    shippingAmount: "0.000000",
    // Woo's refund summary names no lines, so no per-line rollup is available.
    refundedAmount: "0.000000",
    lineTotal: toMoneyString(line.lineTotal),
  };
}

function translateFee(
  fee: WooFeeLineFact,
  currency: string,
): CommerceOrderFeeFact {
  return {
    externalFeeId: fee.externalFeeId,
    feeScope: "order",
    lineNumber: null,
    // PROVISIONAL #1 — see the module doc.
    feeDirection: "buyer_surcharge",
    feeType: "buyer_surcharge",
    providerFeeCode: null,
    description: fee.name,
    currency,
    // The fee's own tax is excluded here on purpose: WooCommerce's
    // `total_tax` already includes it, so adding it again would double-count
    // the order's tax.
    amount: toMoneyString(fee.total),
    chargedAt: null,
  };
}

function translateRefund(
  refund: WooRefundRef,
  currency: string,
  fullyRefunded: boolean,
): CommerceOrderRefundFact {
  return {
    externalRefundId: refund.externalRefundId,
    kind: fullyRefunded ? "refund" : "partial_refund",
    // The embedded summary only exists once the refund has been made.
    status: "completed",
    reasonCode: refund.reason,
    currency,
    amount: toMoneyString(refund.amount),
    // `GET /orders/<id>/refunds` carries the date; the embedded summary
    // ({id, reason, total}) does not, and inventing one would be a lie.
    refundedAt: null,
    // Woo's summary names no lines.
    lines: [],
  };
}

/**
 * PROVISIONAL #2: project the adapter's four-member fulfillment status onto
 * the five-member union, so "Woo stopped telling us" stops being reported as
 * "we know it did not ship".
 */
export function resolveWooFulfillmentStatus(fact: WooOrderFact): string {
  if (!fact.statusRecognized) return "unknown";
  if (fact.providerStatusRaw === "refunded") return "unknown";
  return fact.fulfillmentStatus;
}

/**
 * PROVISIONAL #3: the fulfillment a `completed` Woo order implies, or none.
 *
 * `destination_country` / `destination_region` are read from the payload's
 * shipping block. They are the two fields Phase 4 shipping-cost analysis and
 * Phase 5 tax context group by and are not meaningfully personal data; the
 * street address, name, and contact details are deliberately left in
 * `provider_objects`.
 */
function translateFulfillments(
  fact: WooOrderFact,
  lines: readonly CommerceOrderLineFact[],
): CommerceOrderFulfillmentFact[] {
  if (resolveWooFulfillmentStatus(fact) !== "fulfilled") return [];
  const shipping = asRecord(fact.raw["shipping"]);
  const country = shipping === null ? null : asText(shipping["country"]);
  const region = shipping === null ? null : asText(shipping["state"]);
  return [
    {
      externalFulfillmentId: WOO_COMPLETED_FULFILLMENT_ID,
      status: "shipped",
      carrierCode: null,
      carrierName: null,
      serviceCode: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: fact.completedAt ?? fact.updatedAt,
      deliveredAt: null,
      destinationCountry: country,
      destinationRegion: region,
      lines: lines.map((line) => ({
        lineNumber: line.lineNumber,
        quantity: line.quantity,
      })),
    },
  ];
}

/** Translate one WooCommerce order fact into the provider-neutral shape. */
export function wooOrderFactToCommerceFact(
  fact: WooOrderFact,
  options: WooTranslationOptions = {},
): CommerceOrderFact {
  const currency = fact.currency;
  const lines = fact.lineItems.map(translateLine);
  const fullyRefunded = fact.paymentStatus === "refunded";
  return {
    provider: WOO_PROVIDER,
    channel: options.channel ?? WOO_DEFAULT_CHANNEL,
    // A Woo store is a single-market storefront; there is no sub-market.
    marketplace: null,
    sourceAccountKey: fact.sourceAccountKey,
    externalOrderId: fact.externalOrderId,
    externalOrderNumber: fact.orderNumber,
    status: fact.status,
    paymentStatus: fact.paymentStatus,
    fulfillmentStatus: resolveWooFulfillmentStatus(fact),
    providerStatusRaw: fact.providerStatusRaw,
    currency,
    // PROVISIONAL #5 — derived by exact summation at the adapter boundary.
    subtotalAmount: toMoneyString(fact.totals.subtotal),
    shippingAmount: toMoneyString(fact.totals.shipping),
    discountAmount: toMoneyString(fact.totals.discount),
    taxAmount: toMoneyString(fact.totals.tax),
    // PROVISIONAL #1 — Woo core reports no seller-side fees whatsoever.
    feeAmount: "0.000000",
    refundedAmount: toMoneyString(fact.totals.refunded),
    totalAmount: toMoneyString(fact.totals.total),
    buyerExternalId: fact.buyerExternalId,
    // PROVISIONAL #4 — see the module doc.
    buyerDisplayName: null,
    placedAt: fact.placedAt,
    providerUpdatedAt: fact.updatedAt,
    cancelledAt: fact.status === "cancelled" ? fact.updatedAt : null,
    lines,
    fees: fact.feeLines.map((fee) => translateFee(fee, currency)),
    refunds: fact.refunds.map((refund) =>
      translateRefund(refund, currency, fullyRefunded),
    ),
    fulfillments: translateFulfillments(fact, lines),
    rawPayload:
      options.retainRawPayload === false
        ? null
        : (fact.raw as Record<string, unknown>),
    providerObjectType: WOO_ORDER_OBJECT_TYPE,
  };
}
