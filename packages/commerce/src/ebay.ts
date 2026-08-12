/**
 * eBay → Loxep translation: the eBay adapter's order fact (the integration
 * boundary's shape) onto `CommerceOrderFact` (the shape the database sees).
 *
 * This is the sibling of `woo.ts`, and it is the whole cost of adding a second
 * provider: `orders.ts` — idempotency, attachment rewriting, attribution,
 * provenance, duplicate detection — is untouched, exactly as `facts.ts`
 * promised.
 *
 * ## Why the fact types are RE-DECLARED rather than imported
 *
 * `@loxep/commerce` deliberately does **not** depend on
 * `@loxep/integration-ebay`. That is the same discipline `@loxep/market`
 * applies to eBay's search-filter shape and that this package already applies
 * to decimal arithmetic (`decimal.ts` re-declares rather than imports
 * `@loxep/integration-woo/money`): the scheduler and the domain must not take
 * a provider integration as a dependency, or every provider becomes an
 * upgrade hazard for the domain.
 *
 * The Woo translator predates that rule being applied consistently and imports
 * `WooOrderFact` directly. For eBay the interfaces below are structural
 * re-declarations of the adapter's exported types, so `@loxep/app` — which
 * legitimately depends on both — hands the real `EbayOrderFact` straight to
 * {@link ebayOrderFactToCommerceFact} with no cast and no adapter. TypeScript's
 * structural typing does the checking; the duplication is guarded by the app's
 * routing test, which passes a real adapter fact through this function.
 *
 * ## Translation decisions (all PROVISIONAL, pending the same review)
 *
 * 1. **`totalMarketplaceFee` is a `seller_charge`.** It is what eBay charges
 *    the SELLER, so unlike WooCommerce — where the only fee rows are buyer
 *    surcharges and `orders.fee_amount` is 0 — the eBay leg populates
 *    `feeAmount` with a real seller-side magnitude, and profitability actually
 *    subtracts something. `pricingSummary.fee` is the buyer-facing counterpart
 *    and stays a `buyer_surcharge` that is never subtracted.
 *
 * 2. **The status projection lives in the ADAPTER, not here.** The Woo leg put
 *    its `unknown` re-mapping in this package only because
 *    `packages/integrations/woo` was outside that change's write fence;
 *    loxep-xh9.7.3 records that the adapter is the correct home. This
 *    translator therefore copies `fact.fulfillmentStatus` through verbatim —
 *    if it ever needs to "fix" a status, that is a bug in the adapter.
 *
 * 3. **Fulfillments are never synthesized.** eBay has real
 *    `ShippingFulfillment` objects, so `fact.fulfillments === null` ("this
 *    fetch did not ask") produces NO rows, and `[]` ("eBay reported none")
 *    also produces none — the difference matters to the caller, not to the
 *    database. A `completed` eBay order with no shipment read is not turned
 *    into an invented shipment the way a `completed` Woo order is, because
 *    for eBay the real record is fetchable and inventing one would compete
 *    with it on the next sync.
 *
 * 4. **`buyer_display_name` IS populated** — with the eBay username. This is
 *    the case the design's open question 8 explicitly names: "display name"
 *    means a channel-native handle, and an eBay username is exactly that. The
 *    Woo translator leaves it null because Woo has only a legal name on a
 *    billing address; eBay does not have that problem.
 *
 * 5. **`unit_price` falls back the same way Woo's does.** eBay reports no unit
 *    price at all; the adapter computes the EXACT `lineItemCost / quantity`
 *    and returns null rather than rounding. The fallback chain here is the
 *    adapter's value → the exact quotient → that quotient rounded to
 *    `numeric(20,6)`. Only the last step rounds, and nothing is derived from
 *    it: every order and line TOTAL comes from the provider.
 */
import { divideDecimals, toMoneyString } from "./decimal.ts";
import type {
  CommerceOrderFact,
  CommerceOrderFeeFact,
  CommerceOrderFulfillmentFact,
  CommerceOrderFulfillmentLineFact,
  CommerceOrderLineFact,
  CommerceOrderRefundFact,
  CommerceOrderRefundLineFact,
} from "./facts.ts";

/** `orders.provider` for this adapter family. */
export const EBAY_PROVIDER = "ebay";

/** Default `orders.channel`. The sub-market lands in `marketplace`. */
export const EBAY_DEFAULT_CHANNEL = "ebay";

/** `provider_objects.object_type` / `source_events.event_type` for eBay orders. */
export const EBAY_ORDER_OBJECT_TYPE = "ebay.order";

/* -------------------------------------------- structural adapter fact shapes */

/** Structural mirror of the adapter's `EbayOrderTotals`. */
export interface EbayOrderTotalsLike {
  total: string;
  subtotal: string;
  shipping: string;
  tax: string;
  discount: string;
  fee: string;
  refunded: string;
}

/** Structural mirror of the adapter's `EbayOrderLineFact`. */
export interface EbayOrderLineFactLike {
  externalLineId: string;
  lineNumber: number;
  sku: string | null;
  name: string;
  externalItemId: string | null;
  externalVariationId: string | null;
  quantity: string;
  unitPrice: string | null;
  lineSubtotal: string;
  lineTotal: string;
  discount: string;
  lineTax: string;
  lineShipping: string;
  lineRefunded: string;
}

/** Structural mirror of the adapter's `EbayOrderFeeFact`. */
export interface EbayOrderFeeFactLike {
  externalFeeId: string;
  feeType: string;
  feeDirection: "seller_charge" | "buyer_surcharge";
  providerFeeCode: string;
  description: string;
  currency: string;
  amount: string;
}

/** Structural mirror of the adapter's `EbayRefundFact`. */
export interface EbayRefundFactLike {
  externalRefundId: string;
  status: string;
  currency: string;
  amount: string;
  refundedAt: string | null;
  lines: readonly { externalLineId: string; amount: string }[];
}

/** Structural mirror of the adapter's `EbayFulfillmentFact`. */
export interface EbayFulfillmentFactLike {
  externalFulfillmentId: string;
  status: string;
  carrierCode: string | null;
  trackingNumber: string | null;
  shippedAt: string | null;
  lines: readonly { externalLineId: string; quantity: string }[];
}

/** Structural mirror of the adapter's `EbayOrderFact`. */
export interface EbayOrderFactLike {
  externalOrderId: string;
  orderNumber: string | null;
  sourceAccountKey: string;
  marketplace: string | null;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  providerStatusRaw: string;
  currency: string;
  totals: EbayOrderTotalsLike;
  placedAt: string;
  updatedAt: string | null;
  cancelledAt: string | null;
  buyerExternalId: string | null;
  buyerDisplayName: string | null;
  destinationCountry: string | null;
  destinationRegion: string | null;
  lineItems: readonly EbayOrderLineFactLike[];
  fees: readonly EbayOrderFeeFactLike[];
  refunds: readonly EbayRefundFactLike[];
  fulfillments: readonly EbayFulfillmentFactLike[] | null;
  raw: Readonly<Record<string, unknown>>;
}

export interface EbayTranslationOptions {
  /** Override `orders.channel` when an installation names the surface itself. */
  channel?: string;
  /** Retain the raw payload for `provider_objects` (default true). */
  retainRawPayload?: boolean;
}

/* ---------------------------------------------------------------- helpers */

function nullIfEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `unit_price` is `not null` in the schema, but eBay reports no unit price at
 * all and the adapter returns null rather than rounding a non-terminating
 * quotient. Same fallback chain as `woo.ts`, for the same reason, and the
 * rounded value is likewise never an input to anything.
 */
function resolveUnitPrice(line: EbayOrderLineFactLike): string {
  if (line.unitPrice !== null) return toMoneyString(line.unitPrice);
  return divideDecimals(line.lineSubtotal, line.quantity).value;
}

function translateLine(line: EbayOrderLineFactLike): CommerceOrderLineFact {
  return {
    lineNumber: line.lineNumber,
    externalLineId: line.externalLineId,
    externalItemId: line.externalItemId,
    externalVariationId: line.externalVariationId,
    channelSku: nullIfEmpty(line.sku),
    title: nullIfEmpty(line.name),
    quantity: toMoneyString(line.quantity),
    unitPrice: resolveUnitPrice(line),
    lineSubtotal: toMoneyString(line.lineSubtotal),
    discountAmount: toMoneyString(line.discount),
    taxAmount: toMoneyString(line.lineTax),
    // eBay DOES apportion delivery cost per line, unlike WooCommerce.
    shippingAmount: toMoneyString(line.lineShipping),
    refundedAmount: toMoneyString(line.lineRefunded),
    lineTotal: toMoneyString(line.lineTotal),
  };
}

function translateFee(fee: EbayOrderFeeFactLike): CommerceOrderFeeFact {
  return {
    externalFeeId: fee.externalFeeId,
    // eBay reports both of its fee facts at ORDER granularity; the design
    // forbids synthesizing a per-line allocation at ingest.
    feeScope: "order",
    lineNumber: null,
    feeDirection: fee.feeDirection,
    feeType: fee.feeType,
    providerFeeCode: nullIfEmpty(fee.providerFeeCode),
    description: nullIfEmpty(fee.description),
    currency: fee.currency,
    amount: toMoneyString(fee.amount),
    // The Fulfillment API dates payments and refunds but not fees; the
    // Finances API does, and it is Phase 5.
    chargedAt: null,
  };
}

function translateRefund(
  refund: EbayRefundFactLike,
  lineNumberByExternalId: ReadonlyMap<string, number>,
  fullyRefunded: boolean,
): CommerceOrderRefundFact {
  const lines: CommerceOrderRefundLineFact[] = refund.lines.map((line) => ({
    // An unmatched line id becomes an order-level refund line rather than a
    // dropped fact: `order_line_id` is nullable exactly for this case.
    lineNumber: lineNumberByExternalId.get(line.externalLineId) ?? null,
    quantity: null,
    amount: toMoneyString(line.amount),
  }));
  return {
    externalRefundId: refund.externalRefundId,
    kind: fullyRefunded ? "refund" : "partial_refund",
    status: refund.status,
    // eBay's `OrderRefund` carries no reason; the Fulfillment API only accepts
    // one on the way in (`issueRefund`), and Loxep never writes.
    reasonCode: null,
    currency: refund.currency,
    amount: toMoneyString(refund.amount),
    refundedAt: refund.refundedAt,
    lines,
  };
}

function translateFulfillment(
  fulfillment: EbayFulfillmentFactLike,
  lineNumberByExternalId: ReadonlyMap<string, number>,
  fact: EbayOrderFactLike,
): CommerceOrderFulfillmentFact {
  const lines: CommerceOrderFulfillmentLineFact[] = [];
  for (const line of fulfillment.lines) {
    const lineNumber = lineNumberByExternalId.get(line.externalLineId);
    // `order_fulfillment_lines.order_line_id` is NOT NULL, so a shipment
    // naming a line this order does not have is dropped rather than
    // fabricated. It would mean the two payloads disagree — a reconciliation
    // finding, not something to invent a line for.
    if (lineNumber === undefined) continue;
    lines.push({ lineNumber, quantity: toMoneyString(line.quantity) });
  }
  return {
    externalFulfillmentId: fulfillment.externalFulfillmentId,
    status: fulfillment.status,
    carrierCode: nullIfEmpty(fulfillment.carrierCode),
    // eBay reports a carrier CODE only; the display name is not in the payload
    // and guessing one from the code would invent a fact.
    carrierName: null,
    serviceCode: null,
    trackingNumber: nullIfEmpty(fulfillment.trackingNumber),
    // eBay returns no tracking URL; building one per carrier is a UI concern.
    trackingUrl: null,
    shippedAt: fulfillment.shippedAt,
    // The Fulfillment API reports no delivery confirmation.
    deliveredAt: null,
    destinationCountry: fact.destinationCountry,
    destinationRegion: fact.destinationRegion,
    lines,
  };
}

/** Translate one eBay order fact into the provider-neutral shape. */
export function ebayOrderFactToCommerceFact(
  fact: EbayOrderFactLike,
  options: EbayTranslationOptions = {},
): CommerceOrderFact {
  const lines = fact.lineItems.map(translateLine);
  const lineNumberByExternalId = new Map<string, number>(
    fact.lineItems.map((line) => [line.externalLineId, line.lineNumber]),
  );
  const fullyRefunded = fact.paymentStatus === "refunded";

  return {
    provider: EBAY_PROVIDER,
    channel: options.channel ?? EBAY_DEFAULT_CHANNEL,
    // eBay HAS a sub-market, unlike a single-storefront Woo installation.
    marketplace: fact.marketplace,
    sourceAccountKey: fact.sourceAccountKey,
    externalOrderId: fact.externalOrderId,
    externalOrderNumber: fact.orderNumber,
    status: fact.status,
    paymentStatus: fact.paymentStatus,
    // PROVISIONAL #2 — copied through; the projection is the adapter's job.
    fulfillmentStatus: fact.fulfillmentStatus,
    providerStatusRaw: fact.providerStatusRaw,
    currency: fact.currency,
    subtotalAmount: toMoneyString(fact.totals.subtotal),
    shippingAmount: toMoneyString(fact.totals.shipping),
    discountAmount: toMoneyString(fact.totals.discount),
    taxAmount: toMoneyString(fact.totals.tax),
    // PROVISIONAL #1 — a REAL seller-side magnitude, unlike the Woo leg's 0.
    feeAmount: toMoneyString(fact.totals.fee),
    refundedAmount: toMoneyString(fact.totals.refunded),
    totalAmount: toMoneyString(fact.totals.total),
    buyerExternalId: fact.buyerExternalId,
    // PROVISIONAL #4 — the eBay USERNAME, a channel-native handle.
    buyerDisplayName: fact.buyerDisplayName,
    placedAt: fact.placedAt,
    providerUpdatedAt: fact.updatedAt,
    cancelledAt: fact.cancelledAt,
    lines,
    fees: fact.fees.map(translateFee),
    refunds: fact.refunds.map((refund) =>
      translateRefund(refund, lineNumberByExternalId, fullyRefunded),
    ),
    // PROVISIONAL #3 — null ("did not look") and [] ("none reported") both
    // yield no rows; nothing is ever synthesized.
    fulfillments: (fact.fulfillments ?? []).map((fulfillment) =>
      translateFulfillment(fulfillment, lineNumberByExternalId, fact),
    ),
    rawPayload:
      options.retainRawPayload === false
        ? null
        : (fact.raw as Record<string, unknown>),
    providerObjectType: EBAY_ORDER_OBJECT_TYPE,
  };
}
