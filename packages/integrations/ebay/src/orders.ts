/**
 * Order read adapter: eBay **Sell Fulfillment API v1** (`GET /sell/
 * fulfillment/v1/order`) normalized into Loxep-owned facts aligned to the
 * Commerce Schema Design's `orders`, `order_lines`, `order_fees`,
 * `order_refunds`, and `order_fulfillments` tables.
 *
 * NO PERSISTENCE. This module produces values; it writes nothing.
 *
 * ## Provenance of the shapes below — READ THIS BEFORE TRUSTING A MAPPING
 *
 * Every field name, container name, and enumeration value used here was read
 * out of the **installed** client's bundled OpenAPI types, not from memory:
 *
 * ```text
 * ebay-api@10.0.0
 *   lib/api/restful/sell/fulfillment/index.d.ts      (the call surface)
 *   lib/types/restful/specs/sell_fulfillment_v1_oas3.d.ts
 *                                                    (Order, LineItem, Amount,
 *                                                     PricingSummary,
 *                                                     PaymentSummary,
 *                                                     OrderRefund,
 *                                                     LineItemRefund,
 *                                                     ShippingFulfillment,
 *                                                     CancelStatus, Buyer,
 *                                                     FulfillmentStartInstruction)
 * ```
 *
 * The OpenAPI schema names every container and its types but **does not
 * enumerate the status strings** (`orderPaymentStatus`, `orderFulfillmentStatus`,
 * `cancelState`, `refundStatus` are all plain `string`). Those vocabularies —
 * and the range/bracket syntax of the `filter` query parameter — come from
 * eBay's published Sell Fulfillment documentation and are therefore
 * **DESIGN-DERIVED, NOT LIVE-VERIFIED**. The adapter is written so that being
 * wrong about them degrades rather than breaks: an unrecognized status maps to
 * the floor mapping and sets `statusRecognized: false`, and
 * `providerStatusRaw` keeps the provider's own strings verbatim, which is
 * exactly the diagnosable evidence the design intends `provider_status_raw`
 * to be. The live sandbox leg (`test/live-orders.test.ts`) exists to close
 * this out and skips cleanly until a user token with the Sell Fulfillment
 * scope exists.
 *
 * ## Field sources
 *
 * ```text
 * externalOrderId    ← orderId
 * orderNumber        ← salesRecordReference   (eBay's "sales record number")
 * sourceAccountKey   ← `ebay:<sellerId>`      (design's documented eBay form)
 * marketplace        ← lineItems[0].listingMarketplaceId, else the adapter's
 * currency           ← pricingSummary.total.currency
 * totals.total       ← pricingSummary.total.value
 * totals.subtotal    ← pricingSummary.priceSubtotal.value
 *                      (eBay DOES report a subtotal, unlike WooCommerce;
 *                       falls back to the exact sum of lineItemCost)
 * totals.shipping    ← pricingSummary.deliveryCost.value
 * totals.tax         ← pricingSummary.tax.value
 * totals.discount    ← DERIVED |priceDiscount| + |deliveryDiscount|
 * totals.fee         ← totalMarketplaceFee.value   (SELLER-side; see fees)
 * totals.refunded    ← DERIVED sum of |paymentSummary.refunds[].amount|
 * placedAt           ← creationDate
 * updatedAt          ← lastModifiedDate            (the sync watermark)
 * paidAt             ← latest paymentSummary.payments[].paymentDate whose
 *                      paymentStatus is PAID
 * cancelledAt        ← cancelStatus.cancelledDate
 * buyerExternalId    ← buyer.username
 * buyerDisplayName   ← buyer.username   (a channel-native HANDLE — exactly
 *                      what the design's display-name column is for)
 * lineItems[]        ← lineItems[]
 * fees[]             ← totalMarketplaceFee + pricingSummary.fee (see below)
 * refunds[]          ← paymentSummary.refunds[] + lineItems[].refunds[]
 * fulfillments[]     ← getShippingFulfillments(orderId), when requested
 * destination*       ← fulfillmentStartInstructions[].shippingStep.shipTo
 *                        .contactAddress.{countryCode, stateOrProvince}
 * ```
 *
 * ## Status: eBay's THREE lifecycles onto the design's three
 *
 * Unlike WooCommerce, eBay genuinely reports payment and fulfillment
 * separately — plus cancellation as a third axis. What it does **not** report
 * is an overall order status, so `orders.status` is DERIVED here:
 *
 * ```text
 * cancelStatus.cancelState = CANCELED           → cancelled
 * orderFulfillmentStatus   = FULFILLED          → completed
 * orderPaymentStatus       = PAID | *_REFUNDED  → open
 * everything else                               → pending
 * ```
 *
 * `providerStatusRaw` is therefore a COMPOSITE of the strings eBay actually
 * sent (`"<payment>/<fulfillment>"`, plus `"/<cancelState>"` when a
 * cancellation is in play) rather than a single provider field, because there
 * is no single provider field to quote.
 *
 * The `unknown` fulfillment member (Commerce Schema Design open question 3)
 * is produced **in this adapter**, not downstream: the WooCommerce leg put
 * that projection in `@loxep/commerce`'s translator only because the Woo
 * package was outside that change's write fence, and loxep-xh9.7.3 prescribes
 * the adapter as its correct home for new code.
 *
 * ## Fees: eBay reports ONE aggregate seller charge, not itemized fees
 *
 * `Order.totalMarketplaceFee` is the total eBay charges the SELLER for the
 * order. It is an **aggregate** — predominantly the final value fee, but it
 * may also absorb per-order regulatory/insertion components — and the
 * Fulfillment API offers no breakdown. Itemization requires the **Finances**
 * API (`getTransactions`), which is Phase 5 payout territory and deliberately
 * out of scope here.
 *
 * So one `seller_charge` row is written with
 * `feeType = 'marketplace_final_value'` and
 * `providerFeeCode = 'totalMarketplaceFee'`. The type is the closest member of
 * the design's union and the provider code keeps the evidence that it is an
 * aggregate; a reviewer who wants a distinct `marketplace_aggregate` member
 * can add one without touching data, since `fee_type` is `text` with no
 * `CHECK`. This is a flagged reviewer-pushback item, recorded in the design
 * document.
 *
 * `pricingSummary.fee` is the opposite polarity — a fee charged to the BUYER,
 * already inside `pricingSummary.total` — so it becomes a `buyer_surcharge`
 * row, the same treatment WooCommerce `fee_lines` get. Neither row is ever
 * synthesized when its amount is absent or zero.
 *
 * Neither fee has a provider id, so both get deterministic natural keys
 * ({@link EBAY_MARKETPLACE_FEE_ID}, {@link EBAY_BUYER_FEE_ID}) exactly as the
 * design prescribes for providers that report no `external_fee_id`.
 *
 * ## PERSONAL DATA
 *
 * An eBay order payload carries considerably more buyer PII than a WooCommerce
 * one: `buyer.buyerRegistrationAddress` (full name, email, phone, street
 * address), `buyer.taxAddress`, `buyer.taxIdentifier.taxpayerId`,
 * `fulfillmentStartInstructions[].shippingStep.shipTo` (full name, email,
 * phone, street address), `lineItems[].giftDetails` (recipient email, sender
 * name, free-text message), and `buyerCheckoutNotes`. Use
 * {@link redactEbayOrderFact} for anything that could be displayed, logged, or
 * printed by a failing assertion (ADR-0021).
 */
import type { EbaySellOrdersQuery, EbayUserAdapter } from "./adapter.ts";
import { EbayAdapterError } from "./errors.ts";
import {
  absDecimal,
  amountCurrency,
  amountValue,
  decimalFromNumber,
  decimalFromUnknown,
  divideDecimals,
  isZeroDecimal,
  subtractDecimals,
  sumDecimals,
} from "./money.ts";

/* ------------------------------------------------------------------ types */

/** Design union for `orders.status`. */
export const EBAY_ORDER_STATUSES = [
  "pending",
  "open",
  "completed",
  "cancelled",
] as const;
export type EbayOrderStatus = (typeof EBAY_ORDER_STATUSES)[number];

/** Design union for `orders.payment_status`. */
export const EBAY_PAYMENT_STATUSES = [
  "unpaid",
  "partially_paid",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
] as const;
export type EbayPaymentStatus = (typeof EBAY_PAYMENT_STATUSES)[number];

/**
 * Design union for `orders.fulfillment_status`, INCLUDING the `unknown`
 * member added by the Phase 3 implementation. Produced here rather than
 * downstream — see the module doc.
 */
export const EBAY_FULFILLMENT_STATUSES = [
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
  "cancelled",
  "unknown",
] as const;
export type EbayFulfillmentStatus = (typeof EBAY_FULFILLMENT_STATUSES)[number];

/**
 * Provider payload retained verbatim for provenance (ADR-0009 #3), destined
 * for `provider_objects` — never for a domain column.
 *
 * **THIS VALUE CONTAINS PERSONAL DATA** — see the module doc for the exact
 * containers. Do not log it, do not put it in a snapshot fixture, do not
 * include it in an error, and do not assert on it in a test that can print a
 * diff. Use {@link redactEbayOrderFact} for anything that might be displayed.
 */
export type EbayRawOrderPayload = Readonly<Record<string, unknown>>;

export interface EbayOrderTotals {
  /** `pricingSummary.total`. */
  total: string;
  /** `pricingSummary.priceSubtotal`, or the exact sum of `lineItemCost`. */
  subtotal: string;
  /** `pricingSummary.deliveryCost`. */
  shipping: string;
  /** `pricingSummary.tax`. */
  tax: string;
  /** DERIVED — |priceDiscount| + |deliveryDiscount|, a positive magnitude. */
  discount: string;
  /** `totalMarketplaceFee` — a SELLER-side magnitude. */
  fee: string;
  /** DERIVED — exact sum of refund magnitudes. */
  refunded: string;
}

export interface EbayOrderLineFact {
  /** `lineItems[].lineItemId`, stable → design `external_line_id`. */
  externalLineId: string;
  /** 1-based position → design `order_lines.line_number`. */
  lineNumber: number;
  sku: string | null;
  name: string;
  /** `legacyItemId` — the numeric Trading-era listing id. */
  externalItemId: string | null;
  /** `legacyVariationId`. */
  externalVariationId: string | null;
  /** Decimal string — design stores quantity as `numeric(20,6)`. */
  quantity: string;
  /** DERIVED — the EXACT `lineItemCost / quantity`; null when it does not
   *  terminate (eBay reports no unit price). */
  unitPrice: string | null;
  /** `lineItemCost` — before discounts → design `line_subtotal`. */
  lineSubtotal: string;
  /** `discountedLineItemCost` when present, else `lineItemCost`. */
  lineTotal: string;
  /** DERIVED — `lineItemCost - discountedLineItemCost`. */
  discount: string;
  /** Sum of `taxes[]`, falling back to `ebayCollectAndRemitTaxes[]`. */
  lineTax: string;
  /** `deliveryCost.shippingCost`. */
  lineShipping: string;
  /** DERIVED — exact sum of |`refunds[].amount`| on this line. */
  lineRefunded: string;
  /** `lineItemFulfillmentStatus`, verbatim. */
  fulfillmentStatusRaw: string | null;
  /** `listingMarketplaceId`, verbatim. */
  marketplaceId: string | null;
}

/**
 * One provider-reported fee. `direction` carries the schema's PROVISIONAL
 * `fee_direction` semantic: `seller_charge` is a deduction from proceeds,
 * `buyer_surcharge` is already inside the order total and must never be
 * subtracted from them.
 */
export interface EbayOrderFeeFact {
  /** Deterministic natural key — eBay reports no fee id. */
  externalFeeId: string;
  feeType: string;
  feeDirection: "seller_charge" | "buyer_surcharge";
  /** The provider container this came from, verbatim. */
  providerFeeCode: string;
  description: string;
  currency: string;
  /** Positive magnitude, as reported. */
  amount: string;
}

/** Which line a refund touched, and for how much. */
export interface EbayRefundLineFact {
  /** `lineItems[].lineItemId`. */
  externalLineId: string;
  amount: string;
}

export interface EbayRefundFact {
  /** `paymentSummary.refunds[].refundId`. */
  externalRefundId: string;
  /** `refundStatus`, projected onto `pending | completed | failed`. */
  status: string;
  /** `refundStatus`, verbatim. */
  providerStatusRaw: string | null;
  currency: string;
  /** Positive magnitude — design: positive means money returned to the buyer. */
  amount: string;
  refundedAt: string | null;
  /** Matched from `lineItems[].refunds[]` by `refundId`. */
  lines: EbayRefundLineFact[];
}

export interface EbayFulfillmentLineFact {
  externalLineId: string;
  quantity: string;
}

/** One `ShippingFulfillment` — what the SELLER told eBay was shipped. */
export interface EbayFulfillmentFact {
  /** `fulfillmentId`. */
  externalFulfillmentId: string;
  /** `shipped` — a ShippingFulfillment record exists only once created. */
  status: string;
  /** `shippingCarrierCode`. */
  carrierCode: string | null;
  /** `shipmentTrackingNumber`. */
  trackingNumber: string | null;
  /** `shippedDate`. */
  shippedAt: string | null;
  lines: EbayFulfillmentLineFact[];
}

export interface EbayOrderFact {
  /** `orderId` → design `orders.external_order_id`. */
  externalOrderId: string;
  /** `salesRecordReference` → design `orders.external_order_number`. */
  orderNumber: string | null;
  /** `ebay:<sellerId>` → design `orders.source_account_key`. */
  sourceAccountKey: string;
  /** `sellerId`, verbatim — the input to `sourceAccountKey`. */
  sellerExternalId: string | null;
  /** `EBAY_US` etc → design `orders.marketplace`. */
  marketplace: string | null;
  status: EbayOrderStatus;
  paymentStatus: EbayPaymentStatus;
  fulfillmentStatus: EbayFulfillmentStatus;
  /** COMPOSITE of eBay's own status strings — see the module doc. */
  providerStatusRaw: string;
  /** False when eBay reported a status this adapter has no mapping for. */
  statusRecognized: boolean;
  currency: string;
  totals: EbayOrderTotals;
  /** ISO-8601 UTC → design `orders.placed_at`. */
  placedAt: string;
  /** ISO-8601 UTC → design `orders.provider_updated_at` (sync watermark). */
  updatedAt: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  /** `buyer.username` — a channel-native handle, never an email or a name. */
  buyerExternalId: string | null;
  /** The same handle; the design's display-name column is for handles. */
  buyerDisplayName: string | null;
  /** ISO-3166-1 alpha-2 from the ship-to address; the rest stays in `raw`. */
  destinationCountry: string | null;
  destinationRegion: string | null;
  lineItems: EbayOrderLineFact[];
  fees: EbayOrderFeeFact[];
  refunds: EbayRefundFact[];
  /**
   * Shipments read from `getShippingFulfillments`, or **null** when this fetch
   * did not ask for them. Null and `[]` are deliberately different: `[]` means
   * "eBay reported no shipments", null means "we did not look", and a
   * translator must not write an empty fulfillment set for the second case.
   */
  fulfillments: EbayFulfillmentFact[] | null;
  /** Provenance payload. CONTAINS PERSONAL DATA — see {@link EbayRawOrderPayload}. */
  raw: EbayRawOrderPayload;
}

/* ------------------------------------------------------------ status table */

export interface EbayStatusMapping {
  paymentStatus: EbayPaymentStatus;
  fulfillmentStatus: EbayFulfillmentStatus;
}

/**
 * `orderPaymentStatus` → the design's payment union.
 *
 * eBay's `OrderPaymentStatusEnum` (`FAILED`, `FULLY_REFUNDED`, `PAID`,
 * `PARTIALLY_REFUNDED`, `PENDING`) is documented, not present in the bundled
 * OpenAPI types — see the provenance note in the module doc.
 */
export const EBAY_PAYMENT_STATUS_MAP: Readonly<
  Record<string, EbayPaymentStatus>
> = {
  PAID: "paid",
  PENDING: "unpaid",
  FAILED: "failed",
  PARTIALLY_REFUNDED: "partially_refunded",
  FULLY_REFUNDED: "refunded",
};

/**
 * `orderFulfillmentStatus` → the design's fulfillment union.
 *
 * `IN_PROGRESS` means at least one but not all line items have been
 * fulfilled, which is precisely `partially_fulfilled` — the state WooCommerce
 * could never reach.
 */
export const EBAY_FULFILLMENT_STATUS_MAP: Readonly<
  Record<string, EbayFulfillmentStatus>
> = {
  NOT_STARTED: "unfulfilled",
  IN_PROGRESS: "partially_fulfilled",
  FULFILLED: "fulfilled",
};

/** `cancelStatus.cancelState` values that mean the order was cancelled. */
export const EBAY_CANCELLED_STATE = "CANCELED";

/** `refundStatus` → the design's `order_refunds.status` union. */
export const EBAY_REFUND_STATUS_MAP: Readonly<Record<string, string>> = {
  REFUNDED: "completed",
  PENDING: "pending",
  FAILED: "failed",
};

/**
 * Floor for statuses eBay invented (or omitted). `providerStatusRaw` keeps the
 * truth; `fulfillmentStatus` degrades to `unknown` rather than claiming the
 * order did not ship, which is the whole reason that member exists.
 */
export const EBAY_UNKNOWN_STATUS_MAPPING: EbayStatusMapping = {
  paymentStatus: "unpaid",
  fulfillmentStatus: "unknown",
};

/* --------------------------------------------------------- natural fee keys */

/** Deterministic `external_fee_id` for the aggregate seller-side eBay fee. */
export const EBAY_MARKETPLACE_FEE_ID = "ebay:total-marketplace-fee";
/** Deterministic `external_fee_id` for the buyer-facing `pricingSummary.fee`. */
export const EBAY_BUYER_FEE_ID = "ebay:pricing-summary-fee";

/* ---------------------------------------------------------------- helpers */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record !== null) out.push(record);
  }
  return out;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function asId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return asText(value);
}

/**
 * eBay serializes instants as ISO-8601 UTC WITH the `Z` designator
 * (`"2026-08-11T05:23:15.511Z"`), so — unlike WooCommerce's `*_gmt` fields —
 * nothing has to be repaired here. Anything unparseable becomes null rather
 * than a silently shifted timestamp.
 */
export function isoFromEbay(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** ISO-3166-1 alpha-2, uppercased; anything else is discarded. */
function asCountryCode(value: unknown): string | null {
  const text = asText(value);
  return text !== null && /^[A-Za-z]{2}$/.test(text) ? text.toUpperCase() : null;
}

const ZERO = "0.00";

/** `ebay:<sellerId>` — the design's documented eBay `source_account_key`. */
export function ebaySourceAccountKey(sellerId: string): string {
  return `ebay:${sellerId}`;
}

/* ---------------------------------------------------------------- mapping */

export interface MapEbayOrderOptions {
  /**
   * Used when the payload carries no `sellerId`. `source_account_key` is
   * `not null`, and a fact with no account scope cannot participate in
   * cross-connection duplicate detection at all, so a fallback is required
   * rather than optional — normally `ebay:<marketplaceId>` from the adapter.
   */
  fallbackSourceAccountKey: string;
  /** The adapter's marketplace, used when no line names one. */
  marketplaceId?: string;
  /** Shipments already read from `getShippingFulfillments`, when available. */
  fulfillments?: EbayFulfillmentFact[] | null;
}

/** Sum of the `taxes[]` container, falling back to eBay-collected taxes. */
function lineTaxAmount(item: Record<string, unknown>): string {
  const taxes = asRecordArray(item["taxes"])
    .map((tax) => amountValue(tax["amount"]))
    .filter((value): value is string => value !== null);
  if (taxes.length > 0) return sumDecimals(taxes, ZERO);
  // Marketplace-facilitator jurisdictions frequently report the tax ONLY in
  // `ebayCollectAndRemitTaxes`, leaving `taxes` empty. Summing both would
  // double-count where both are populated, so this is a fallback, never an
  // addition. DESIGN-DERIVED: confirm against a live payload.
  const collected = asRecordArray(item["ebayCollectAndRemitTaxes"])
    .map((tax) => amountValue(tax["amount"]))
    .filter((value): value is string => value !== null);
  return sumDecimals(collected, ZERO);
}

function mapLine(
  item: Record<string, unknown>,
  index: number,
): EbayOrderLineFact {
  const lineSubtotal = amountValue(item["lineItemCost"]) ?? ZERO;
  const discounted = amountValue(item["discountedLineItemCost"]);
  const lineTotal = discounted ?? lineSubtotal;
  const quantity = decimalFromNumber(item["quantity"]) ??
    decimalFromUnknown(item["quantity"]) ??
    "1";
  const deliveryCost = asRecord(item["deliveryCost"]);
  const refunds = asRecordArray(item["refunds"])
    .map((refund) => amountValue(refund["amount"]))
    .filter((value): value is string => value !== null)
    .map(absDecimal);
  return {
    externalLineId: asId(item["lineItemId"]) ?? `index:${index + 1}`,
    lineNumber: index + 1,
    sku: asText(item["sku"]),
    name: asText(item["title"]) ?? "",
    externalItemId: asId(item["legacyItemId"]),
    externalVariationId: asId(item["legacyVariationId"]),
    quantity,
    unitPrice: divideDecimals(lineSubtotal, quantity),
    lineSubtotal,
    lineTotal,
    discount: subtractDecimals(lineSubtotal, lineTotal),
    lineTax: lineTaxAmount(item),
    lineShipping:
      deliveryCost === null
        ? ZERO
        : (amountValue(deliveryCost["shippingCost"]) ?? ZERO),
    lineRefunded: sumDecimals(refunds, ZERO),
    fulfillmentStatusRaw: asText(item["lineItemFulfillmentStatus"]),
    marketplaceId: asText(item["listingMarketplaceId"]),
  };
}

/** Line-level refund amounts, grouped by the order-level `refundId`. */
function lineRefundsByRefundId(
  lineItems: Array<Record<string, unknown>>,
  lines: readonly EbayOrderLineFact[],
): Map<string, EbayRefundLineFact[]> {
  const byRefundId = new Map<string, EbayRefundLineFact[]>();
  lineItems.forEach((item, index) => {
    const externalLineId = lines[index]?.externalLineId;
    if (externalLineId === undefined) return;
    for (const refund of asRecordArray(item["refunds"])) {
      const refundId = asId(refund["refundId"]);
      const amount = amountValue(refund["amount"]);
      if (refundId === null || amount === null) continue;
      const bucket = byRefundId.get(refundId) ?? [];
      bucket.push({ externalLineId, amount: absDecimal(amount) });
      byRefundId.set(refundId, bucket);
    }
  });
  return byRefundId;
}

function mapRefunds(
  raw: Record<string, unknown>,
  lineItems: Array<Record<string, unknown>>,
  lines: readonly EbayOrderLineFact[],
  orderCurrency: string,
): EbayRefundFact[] {
  const paymentSummary = asRecord(raw["paymentSummary"]);
  if (paymentSummary === null) return [];
  const byRefundId = lineRefundsByRefundId(lineItems, lines);
  return asRecordArray(paymentSummary["refunds"]).map(
    (refund, index): EbayRefundFact => {
      const refundId = asId(refund["refundId"]) ?? `index:${index + 1}`;
      const amount = amountValue(refund["amount"]) ?? ZERO;
      const statusRaw = asText(refund["refundStatus"]);
      return {
        externalRefundId: refundId,
        status:
          statusRaw === null
            ? "completed"
            : (EBAY_REFUND_STATUS_MAP[statusRaw] ?? "completed"),
        providerStatusRaw: statusRaw,
        currency: amountCurrency(refund["amount"]) ?? orderCurrency,
        amount: absDecimal(amount),
        refundedAt: isoFromEbay(refund["refundDate"]),
        lines: byRefundId.get(refundId) ?? [],
      };
    },
  );
}

function mapFees(
  raw: Record<string, unknown>,
  currency: string,
): EbayOrderFeeFact[] {
  const fees: EbayOrderFeeFact[] = [];

  const marketplaceFee = amountValue(raw["totalMarketplaceFee"]);
  if (marketplaceFee !== null && !isZeroDecimal(marketplaceFee)) {
    fees.push({
      externalFeeId: EBAY_MARKETPLACE_FEE_ID,
      // The closest member of the design's union; the AGGREGATE nature is
      // recorded in `providerFeeCode` and in the module doc.
      feeType: "marketplace_final_value",
      feeDirection: "seller_charge",
      providerFeeCode: "totalMarketplaceFee",
      description: "eBay marketplace fees (aggregate)",
      currency: amountCurrency(raw["totalMarketplaceFee"]) ?? currency,
      amount: marketplaceFee,
    });
  }

  const pricingSummary = asRecord(raw["pricingSummary"]);
  const buyerFee =
    pricingSummary === null ? null : amountValue(pricingSummary["fee"]);
  if (buyerFee !== null && !isZeroDecimal(buyerFee)) {
    fees.push({
      externalFeeId: EBAY_BUYER_FEE_ID,
      feeType: "buyer_surcharge",
      feeDirection: "buyer_surcharge",
      providerFeeCode: "pricingSummary.fee",
      description: "Buyer-paid fee",
      currency:
        (pricingSummary === null
          ? null
          : amountCurrency(pricingSummary["fee"])) ?? currency,
      amount: buyerFee,
    });
  }

  return fees;
}

/** The latest `paymentDate` among payments eBay says are `PAID`. */
function paidAtFrom(raw: Record<string, unknown>): string | null {
  const paymentSummary = asRecord(raw["paymentSummary"]);
  if (paymentSummary === null) return null;
  let latest: string | null = null;
  for (const payment of asRecordArray(paymentSummary["payments"])) {
    if (asText(payment["paymentStatus"]) !== "PAID") continue;
    const paidAt = isoFromEbay(payment["paymentDate"]);
    if (paidAt === null) continue;
    if (latest === null || Date.parse(paidAt) > Date.parse(latest)) {
      latest = paidAt;
    }
  }
  return latest;
}

/** Ship-to country/region, the only address fields the design normalizes. */
function destinationFrom(raw: Record<string, unknown>): {
  country: string | null;
  region: string | null;
} {
  for (const instruction of asRecordArray(raw["fulfillmentStartInstructions"])) {
    const shippingStep = asRecord(instruction["shippingStep"]);
    const shipTo = shippingStep === null ? null : asRecord(shippingStep["shipTo"]);
    const address = shipTo === null ? null : asRecord(shipTo["contactAddress"]);
    if (address === null) continue;
    const country = asCountryCode(address["countryCode"]);
    const region = asText(address["stateOrProvince"]);
    if (country !== null || region !== null) return { country, region };
  }
  return { country: null, region: null };
}

/** Pure mapping from a raw eBay order payload to the Loxep-owned fact. */
export function mapEbayOrder(
  raw: Record<string, unknown>,
  options: MapEbayOrderOptions,
): EbayOrderFact {
  const externalOrderId = asId(raw["orderId"]);
  if (externalOrderId === null) {
    throw new EbayAdapterError(
      "provider_unavailable",
      "eBay order payload has no orderId; refusing to build an order fact",
    );
  }

  const placedAt = isoFromEbay(raw["creationDate"]);
  if (placedAt === null) {
    throw new EbayAdapterError(
      "provider_unavailable",
      "eBay order payload has no usable creationDate",
      { externalOrderId },
    );
  }

  const paymentRaw = asText(raw["orderPaymentStatus"]);
  const fulfillmentRaw = asText(raw["orderFulfillmentStatus"]);
  const cancelStatus = asRecord(raw["cancelStatus"]);
  const cancelStateRaw =
    cancelStatus === null ? null : asText(cancelStatus["cancelState"]);

  const mappedPayment =
    paymentRaw === null ? undefined : EBAY_PAYMENT_STATUS_MAP[paymentRaw];
  const mappedFulfillment =
    fulfillmentRaw === null
      ? undefined
      : EBAY_FULFILLMENT_STATUS_MAP[fulfillmentRaw];
  const statusRecognized =
    mappedPayment !== undefined && mappedFulfillment !== undefined;

  const cancelled = cancelStateRaw === EBAY_CANCELLED_STATE;
  const paymentStatus =
    mappedPayment ?? EBAY_UNKNOWN_STATUS_MAPPING.paymentStatus;
  const fulfillmentStatus: EbayFulfillmentStatus = cancelled
    ? "cancelled"
    : (mappedFulfillment ?? EBAY_UNKNOWN_STATUS_MAPPING.fulfillmentStatus);

  // eBay reports no overall order status; this is the documented derivation.
  const status: EbayOrderStatus = cancelled
    ? "cancelled"
    : mappedFulfillment === "fulfilled"
      ? "completed"
      : paymentStatus === "paid" ||
          paymentStatus === "partially_refunded" ||
          paymentStatus === "refunded"
        ? "open"
        : "pending";

  const providerStatusRaw =
    `${paymentRaw ?? "-"}/${fulfillmentRaw ?? "-"}` +
    (cancelStateRaw !== null && cancelStateRaw !== "NONE_REQUESTED"
      ? `/${cancelStateRaw}`
      : "");

  const pricingSummary = asRecord(raw["pricingSummary"]) ?? {};
  const currency =
    amountCurrency(pricingSummary["total"]) ??
    amountCurrency(raw["totalMarketplaceFee"]) ??
    "";

  const rawLineItems = asRecordArray(raw["lineItems"]);
  const lineItems = rawLineItems.map(mapLine);
  const refunds = mapRefunds(raw, rawLineItems, lineItems, currency);

  const priceDiscount = amountValue(pricingSummary["priceDiscount"]);
  const deliveryDiscount = amountValue(pricingSummary["deliveryDiscount"]);
  const discount = sumDecimals(
    [priceDiscount, deliveryDiscount]
      .filter((value): value is string => value !== null)
      .map(absDecimal),
    ZERO,
  );

  const destination = destinationFrom(raw);
  const sellerId = asId(raw["sellerId"]);

  return {
    externalOrderId,
    orderNumber: asId(raw["salesRecordReference"]),
    sourceAccountKey:
      sellerId === null
        ? options.fallbackSourceAccountKey
        : ebaySourceAccountKey(sellerId),
    sellerExternalId: sellerId,
    marketplace:
      lineItems.find((line) => line.marketplaceId !== null)?.marketplaceId ??
      options.marketplaceId ??
      null,
    status,
    paymentStatus,
    fulfillmentStatus,
    providerStatusRaw,
    statusRecognized,
    currency,
    totals: {
      total: amountValue(pricingSummary["total"]) ?? ZERO,
      subtotal:
        amountValue(pricingSummary["priceSubtotal"]) ??
        sumDecimals(
          lineItems.map((line) => line.lineSubtotal),
          ZERO,
        ),
      shipping: amountValue(pricingSummary["deliveryCost"]) ?? ZERO,
      tax: amountValue(pricingSummary["tax"]) ?? ZERO,
      discount,
      fee: absDecimal(amountValue(raw["totalMarketplaceFee"]) ?? ZERO),
      refunded: sumDecimals(
        refunds.map((refund) => refund.amount),
        ZERO,
      ),
    },
    placedAt,
    updatedAt: isoFromEbay(raw["lastModifiedDate"]),
    paidAt: paidAtFrom(raw),
    cancelledAt:
      cancelStatus === null ? null : isoFromEbay(cancelStatus["cancelledDate"]),
    buyerExternalId: (() => {
      const buyer = asRecord(raw["buyer"]);
      return buyer === null ? null : asText(buyer["username"]);
    })(),
    buyerDisplayName: (() => {
      const buyer = asRecord(raw["buyer"]);
      return buyer === null ? null : asText(buyer["username"]);
    })(),
    destinationCountry: destination.country,
    destinationRegion: destination.region,
    lineItems,
    fees: mapFees(raw, currency),
    refunds,
    fulfillments: options.fulfillments ?? null,
    raw,
  };
}

/** Map one `ShippingFulfillment` payload. */
export function mapEbayFulfillment(
  raw: Record<string, unknown>,
  index: number,
): EbayFulfillmentFact {
  const lines: EbayFulfillmentLineFact[] = [];
  for (const reference of asRecordArray(raw["lineItems"])) {
    const externalLineId = asId(reference["lineItemId"]);
    if (externalLineId === null) continue;
    lines.push({
      externalLineId,
      quantity:
        decimalFromNumber(reference["quantity"]) ??
        decimalFromUnknown(reference["quantity"]) ??
        "1",
    });
  }
  return {
    externalFulfillmentId: asId(raw["fulfillmentId"]) ?? `index:${index + 1}`,
    // A ShippingFulfillment exists only once the seller creates one, and eBay
    // reports no state on it. `shipped` is the fact it records.
    status: "shipped",
    carrierCode: asText(raw["shippingCarrierCode"]),
    trackingNumber: asText(raw["shipmentTrackingNumber"]),
    shippedAt: isoFromEbay(raw["shippedDate"]),
    lines,
  };
}

/**
 * Everything about an order fact EXCEPT `raw` (ADR-0021). Use this for
 * logging, health surfaces, and any test output that could be printed — it is
 * the difference between a diff that shows order totals and one that shows a
 * buyer's home address, email, phone, and taxpayer id.
 *
 * The retained fields are deliberately safe: `buyerExternalId` /
 * `buyerDisplayName` are the eBay USERNAME (a channel-native handle, which is
 * exactly what the design's buyer columns are for), and the only address data
 * that survives is the ship-to country/region the design normalizes.
 */
export function redactEbayOrderFact(
  fact: EbayOrderFact,
): Omit<EbayOrderFact, "raw"> & { raw: "[redacted]" } {
  const { raw: _raw, ...rest } = fact;
  return { ...rest, raw: "[redacted]" };
}

/* ---------------------------------------------------------------- fetching */

/** eBay caps `getOrders` paging; documented default 50. */
export const EBAY_ORDERS_DEFAULT_LIMIT = 50;
export const EBAY_ORDERS_MAX_LIMIT = 200;

export interface FetchEbayOrdersInput {
  /**
   * Incremental-sync watermark → `filter=lastmodifieddate:[<iso>..]`.
   *
   * eBay's range brackets are INCLUSIVE (`[`), unlike WooCommerce's exclusive
   * `modified_after`, so passing the last watermark SEEN re-reads the boundary
   * order rather than skipping it. Ingestion is idempotent, so that is the
   * safe direction.
   */
  modifiedAfter?: Date | string;
  /** `filter=lastmodifieddate:[..<iso>]` — the exclusive upper bound. */
  modifiedBefore?: Date | string;
  /** `filter=creationdate:[<iso>..]`. */
  placedAfter?: Date | string;
  /** `filter=orderfulfillmentstatus:{A|B}`. */
  fulfillmentStatuses?: readonly string[];
  /** Page size; eBay defaults to 50 and caps at 200. */
  limit?: number;
  /** 0-based record offset. */
  offset?: number;
  /**
   * Read each order's shipments through `getShippingFulfillments`. That is ONE
   * EXTRA CALL PER ORDER against the connection's rate budget, so it is opt-in
   * and skipped for orders eBay says have not started fulfillment.
   */
  includeFulfillments?: boolean;
}

export interface EbayOrderPage {
  orders: EbayOrderFact[];
  page: {
    limit: number;
    offset: number;
    total: number | null;
    hasNextPage: boolean;
  };
}

function toIsoInstant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay date filter is not a valid instant",
    );
  }
  return date.toISOString();
}

/**
 * Build the `filter` query value.
 *
 * Grammar (eBay Sell Fulfillment `getOrders`): comma-separated
 * `field:value` pairs, where a date range is `[from..to]` with either side
 * omittable and a set is `{A|B}`. DESIGN-DERIVED from eBay's published field
 * reference — see the module doc's provenance note.
 */
export function buildEbayOrdersFilter(
  input: FetchEbayOrdersInput = {},
): string | undefined {
  const parts: string[] = [];
  if (input.modifiedAfter !== undefined || input.modifiedBefore !== undefined) {
    const from =
      input.modifiedAfter === undefined ? "" : toIsoInstant(input.modifiedAfter);
    const to =
      input.modifiedBefore === undefined
        ? ""
        : toIsoInstant(input.modifiedBefore);
    parts.push(`lastmodifieddate:[${from}..${to}]`);
  }
  if (input.placedAfter !== undefined) {
    parts.push(`creationdate:[${toIsoInstant(input.placedAfter)}..]`);
  }
  if (
    input.fulfillmentStatuses !== undefined &&
    input.fulfillmentStatuses.length > 0
  ) {
    parts.push(
      `orderfulfillmentstatus:{${input.fulfillmentStatuses.join("|")}}`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(",");
}

export function buildEbayOrdersQuery(
  input: FetchEbayOrdersInput = {},
): EbaySellOrdersQuery {
  const limit = Math.min(
    Math.max(1, input.limit ?? EBAY_ORDERS_DEFAULT_LIMIT),
    EBAY_ORDERS_MAX_LIMIT,
  );
  const filter = buildEbayOrdersFilter(input);
  return {
    limit,
    offset: Math.max(0, input.offset ?? 0),
    ...(filter === undefined ? {} : { filter }),
  };
}

/** Read one order's shipments and normalize them. */
export async function fetchOrderFulfillments(
  adapter: EbayUserAdapter,
  orderId: string,
): Promise<EbayFulfillmentFact[]> {
  const response = await adapter.sellGetShippingFulfillments(orderId);
  return asRecordArray(response["fulfillments"]).map(mapEbayFulfillment);
}

/** One page of orders plus the pagination facts. */
export async function fetchEbayOrdersPage(
  adapter: EbayUserAdapter,
  input: FetchEbayOrdersInput = {},
): Promise<EbayOrderPage> {
  const query = buildEbayOrdersQuery(input);
  const response = await adapter.sellGetOrders(query);
  const rawOrders = asRecordArray(response["orders"]);
  const limit =
    typeof response["limit"] === "number"
      ? response["limit"]
      : (query.limit ?? EBAY_ORDERS_DEFAULT_LIMIT);
  const offset =
    typeof response["offset"] === "number"
      ? response["offset"]
      : (query.offset ?? 0);
  const total = typeof response["total"] === "number" ? response["total"] : null;

  const fallbackSourceAccountKey = ebaySourceAccountKey(adapter.marketplaceId);
  const orders: EbayOrderFact[] = [];
  for (const rawOrder of rawOrders) {
    let fulfillments: EbayFulfillmentFact[] | null = null;
    if (input.includeFulfillments === true) {
      const orderId = asId(rawOrder["orderId"]);
      const notStarted =
        asText(rawOrder["orderFulfillmentStatus"]) === "NOT_STARTED";
      // Skip the extra call for an order eBay says has no shipments: the
      // answer is knowable without spending a rate-budget token, and `[]` is
      // the honest result rather than null.
      fulfillments =
        orderId === null
          ? null
          : notStarted
            ? []
            : await fetchOrderFulfillments(adapter, orderId);
    }
    orders.push(
      mapEbayOrder(rawOrder, {
        fallbackSourceAccountKey,
        marketplaceId: adapter.marketplaceId,
        fulfillments,
      }),
    );
  }

  return {
    orders,
    page: {
      limit,
      offset,
      total,
      // `next` is eBay's own "there is another page" signal; the total
      // comparison is the fallback when it is absent.
      hasNextPage:
        asText(response["next"]) !== null ||
        (total !== null && offset + rawOrders.length < total),
    },
  };
}

/** One page of normalized orders. */
export async function fetchEbayOrders(
  adapter: EbayUserAdapter,
  input: FetchEbayOrdersInput = {},
): Promise<EbayOrderFact[]> {
  return (await fetchEbayOrdersPage(adapter, input)).orders;
}

/**
 * Walk every page of orders matching the filter, using eBay's offset
 * pagination. Yields one page of facts at a time so a caller can persist
 * incrementally rather than buffering a whole backfill.
 */
export async function* iterateEbayOrders(
  adapter: EbayUserAdapter,
  input: FetchEbayOrdersInput = {},
  options: { maxPages?: number } = {},
): AsyncGenerator<EbayOrderPage, void, undefined> {
  const maxPages = Math.max(1, options.maxPages ?? 10);
  let offset = input.offset ?? 0;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchEbayOrdersPage(adapter, { ...input, offset });
    yield result;
    if (!result.page.hasNextPage || result.orders.length === 0) return;
    offset += result.orders.length;
  }
}
