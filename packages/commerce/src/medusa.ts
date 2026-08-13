/**
 * Medusa → Loxep translation: the Medusa adapter's order fact (the
 * integration boundary's shape) onto `CommerceOrderFact` (the shape the
 * database sees).
 *
 * This is the third sibling of `woo.ts`/`ebay.ts` — `orders.ts` gains one
 * four-line entry point (`ingestMedusaOrder`) and nothing else changes, which
 * is `facts.ts`'s "adding a provider is a translator plus a status table"
 * claim being cashed a second time (loxep-xxz).
 *
 * ## Why the fact types are RE-DECLARED rather than imported
 *
 * `@loxep/commerce` deliberately does **not** depend on
 * `@loxep/integration-medusa` — the same boundary `ebay.ts` documents at
 * length. {@link MedusaOrderFactLike} and its nested shapes are structural
 * re-declarations of `@loxep/integration-medusa`'s exported types, so
 * `@loxep/app` — which legitimately depends on both — hands the real
 * `MedusaOrderFact` straight to {@link medusaOrderFactToCommerceFact} with no
 * cast and no adapter. TypeScript's structural typing does the checking.
 *
 * ## Five mappings that are NOT mechanical
 *
 * All five are forced by the live findings recorded in
 * `packages/integrations/medusa/src/orders.ts` (Medusa 2.18.0,
 * 2026-08-12/13), and each has a fixture in `medusa.test.ts` pinning it.
 *
 * 1. **`totalAmount` ← `totals.originalTotal`, NEVER `totals.total`.**
 *    Medusa's `total` is the CURRENT total and Medusa already subtracts
 *    refunds from it — live-verified: a €30 order read €25 after a €5
 *    refund, while `original_total` stayed €30. Persisting `total` would make
 *    `orders.total_amount` change on re-sync, which a ledger amount must
 *    never do. `refundedAmount` ← `totals.refunded`, which is already a
 *    positive magnitude (unlike WooCommerce's negative convention) — no sign
 *    flip. **Never compute `total - refunded`**: Medusa already performed
 *    that subtraction, so doing it again double-counts the refund.
 * 2. **`subtotalAmount` = `totals.subtotal − totals.shipping`.** Medusa's
 *    `subtotal` INCLUDES shipping (`item_subtotal + shipping_subtotal`,
 *    live-verified), but `CommerceOrderFact` carries `subtotalAmount` and
 *    `shippingAmount` as INDEPENDENT facts that every read model sums
 *    independently. Mapping `subtotal` straight across would double-count
 *    shipping in every aggregate that adds the two together. This is the
 *    translator's one derived amount, computed with `subtractDecimals` —
 *    exact `BigInt` arithmetic, never a JS `number` — because money is
 *    PostgreSQL `numeric` and never floating point.
 * 3. **`feeAmount = "0"`, `fees: []`.** Medusa has no fee concept at all — not
 *    even WooCommerce's buyer-surcharge lines. That is a FACT, not a gap:
 *    `orders.fee_amount` gets an honest zero so Phase 3's "revenue minus
 *    provider-reported fees" reads correctly for a Medusa order. Do not
 *    synthesize a payment-processor fee; the real fees live in Stripe (or
 *    whichever gateway), outside Medusa's order data.
 * 4. **`cancelledAt: null` ALWAYS**, even when `status` maps to `cancelled`.
 *    The Admin API's order object exposes no order-level cancellation
 *    timestamp — only `fulfillments[].canceled_at`. Do NOT substitute
 *    `updatedAt`: that would fabricate a fact the provider never stated. The
 *    adapter's honest null is kept as-is.
 * 5. **`buyerDisplayName: null`.** Medusa reports `customer_id` (→
 *    `buyerExternalId`) and `email`; email is PII and the fact contract
 *    forbids it in a domain column (see `facts.ts`). Unlike eBay's username,
 *    Medusa has no channel-native handle to offer instead, so this column
 *    stays null — the same reasoning the Woo leg already applies.
 *
 * ## Sub-fact mappings
 *
 * **Lines**: `sku → channelSku`, `name → title`, `lineTax → taxAmount`,
 * `discount → discountAmount`, `unitPrice ?? "0"` (Medusa reports no
 * unit-price fallback quotient the way eBay/Woo's adapters do — a missing
 * `unit_price` is stored as a flat zero rather than derived). Both
 * `shippingAmount` and `refundedAmount` are `"0"` per line: Medusa reports
 * neither at line granularity.
 *
 * **Refunds**: every row Medusa exposes is already settled (the Admin API
 * has no notion of a pending refund at this level), so `kind` is always
 * `"refund"` and `status` is always the literal `"completed"` — there is no
 * adapter-reported refund status to copy through. `reasonCode ← reason`.
 * `lines: []` always: Medusa's refund objects carry no per-line breakdown, so
 * every refund becomes the "order-level refund naming no line" case
 * `CommerceOrderRefundLineFact` already models via a nullable `lineNumber`.
 * `currency` is the ORDER's currency (Medusa refunds carry no currency of
 * their own; an order and its refunds are always the same currency).
 *
 * **Fulfillments**: the adapter's derived
 * `pending | packed | shipped | delivered | canceled` status passes through
 * verbatim — the status projection is the adapter's job, not this
 * translator's (same rule `ebay.ts` states). `trackingNumbers[0]` /
 * `trackingUrls[0]` become `trackingNumber` / `trackingUrl` — a documented
 * TRUNCATION, because Medusa allows several shipping labels per fulfillment
 * and the design's shape carries only one of each. `lines: []` always: the
 * adapter's own module doc records that Medusa exposes no per-fulfillment,
 * per-line quantity breakdown (only aggregate per-LINE
 * `detail.fulfilled_quantity`, which cannot be attributed back to a specific
 * fulfillment when an order has more than one). `carrierCode`/`serviceCode`
 * are always null: Medusa's fulfillment object carries neither.
 *
 * **Never mapped to a column**: `providerPaymentStatusRaw`,
 * `providerFulfillmentStatusRaw`, `statusRecognized`, and `paidAt` all exist
 * on the adapter's fact for diagnosis but have no `CommerceOrderFact` field —
 * they stay in the retained `rawPayload` only. `statusRecognized === false`
 * is the composition root's signal to log a warning (see `@loxep/app`'s
 * Medusa poll executor), not something this translator or `orders.ts` acts
 * on.
 */
import { subtractDecimals, toMoneyString } from "./decimal.ts";
import type {
  CommerceOrderFact,
  CommerceOrderFulfillmentFact,
  CommerceOrderFulfillmentLineFact,
  CommerceOrderLineFact,
  CommerceOrderRefundFact,
} from "./facts.ts";

/** `orders.provider` for this adapter family. */
export const MEDUSA_PROVIDER = "medusa";

/** Default `orders.channel`. Medusa is single-storefront, unlike eBay's marketplaces. */
export const MEDUSA_DEFAULT_CHANNEL = "medusa";

/** `provider_objects.object_type` / `source_events.event_type` for Medusa orders. */
export const MEDUSA_ORDER_OBJECT_TYPE = "medusa.order";

/* -------------------------------------------- structural adapter fact shapes */

/** Structural mirror of the adapter's `MedusaOrderTotals`. */
export interface MedusaOrderTotalsLike {
  /** The CURRENT total; Medusa reduces it as refunds land. Never persisted. */
  total: string;
  /** The as-placed amount, unaffected by refunds — what `totalAmount` uses. */
  originalTotal: string;
  /** INCLUDES shipping — see mapping #2 above. */
  subtotal: string;
  shipping: string;
  tax: string;
  discount: string;
  /** Already a positive magnitude — no sign flip needed. */
  refunded: string;
}

/** Structural mirror of the adapter's `MedusaOrderLineFact`. */
export interface MedusaOrderLineFactLike {
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
  lineTax: string;
  discount: string;
}

/** Structural mirror of the adapter's `MedusaRefundFact`. */
export interface MedusaRefundFactLike {
  externalRefundId: string;
  reason: string | null;
  amount: string;
  createdAt: string | null;
}

/** Structural mirror of the adapter's `MedusaFulfillmentFact`. */
export interface MedusaFulfillmentFactLike {
  externalFulfillmentId: string;
  status: "pending" | "packed" | "shipped" | "delivered" | "canceled";
  trackingNumbers: readonly string[];
  trackingUrls: readonly string[];
  shippedAt: string | null;
  deliveredAt: string | null;
  canceledAt: string | null;
  destinationCountry: string | null;
  destinationRegion: string | null;
}

/** Structural mirror of the adapter's `MedusaOrderFact`. */
export interface MedusaOrderFactLike {
  externalOrderId: string;
  orderNumber: string | null;
  sourceAccountKey: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  providerStatusRaw: string;
  /** Diagnostic only — no `CommerceOrderFact` column. Stays in `raw`. */
  providerPaymentStatusRaw: string;
  /** Diagnostic only — no `CommerceOrderFact` column. Stays in `raw`. */
  providerFulfillmentStatusRaw: string;
  /** Diagnostic only — the composition root logs on `false`, not this module. */
  statusRecognized: boolean;
  currency: string;
  totals: MedusaOrderTotalsLike;
  placedAt: string;
  updatedAt: string | null;
  /** Diagnostic only ("paid at" derived by the adapter) — no design column. */
  paidAt: string | null;
  /** Always null — the Admin API exposes no order-level cancellation timestamp. */
  cancelledAt: string | null;
  buyerExternalId: string | null;
  lineItems: readonly MedusaOrderLineFactLike[];
  refunds: readonly MedusaRefundFactLike[];
  fulfillments: readonly MedusaFulfillmentFactLike[];
  raw: Readonly<Record<string, unknown>>;
}

export interface MedusaTranslationOptions {
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

function translateLine(line: MedusaOrderLineFactLike): CommerceOrderLineFact {
  return {
    lineNumber: line.lineNumber,
    externalLineId: line.externalLineId,
    externalItemId: line.externalItemId,
    externalVariationId: line.externalVariationId,
    channelSku: nullIfEmpty(line.sku),
    title: nullIfEmpty(line.name),
    quantity: toMoneyString(line.quantity),
    // Design mapping: a flat fallback, not a derived quotient — Medusa's
    // adapter does not compute one the way eBay's/Woo's do.
    unitPrice: toMoneyString(line.unitPrice ?? "0"),
    lineSubtotal: toMoneyString(line.lineSubtotal),
    discountAmount: toMoneyString(line.discount),
    taxAmount: toMoneyString(line.lineTax),
    // Medusa reports neither shipping nor refunds at line granularity.
    shippingAmount: "0.000000",
    refundedAmount: "0.000000",
    lineTotal: toMoneyString(line.lineTotal),
  };
}

function translateRefund(
  refund: MedusaRefundFactLike,
  currency: string,
): CommerceOrderRefundFact {
  return {
    externalRefundId: refund.externalRefundId,
    // Medusa exposes only SETTLED refunds at this level — there is no
    // adapter-reported partial/full distinction to preserve, unlike eBay's
    // paymentStatus-derived split.
    kind: "refund",
    status: "completed",
    reasonCode: nullIfEmpty(refund.reason),
    // Medusa's refund objects carry no currency of their own; an order and
    // its refunds always share the order's currency.
    currency,
    amount: toMoneyString(refund.amount),
    refundedAt: refund.createdAt,
    // Medusa's refund objects carry no per-line breakdown — the "order-level
    // refund naming no line" case the fact type already models.
    lines: [],
  };
}

function translateFulfillment(
  fulfillment: MedusaFulfillmentFactLike,
): CommerceOrderFulfillmentFact {
  // Documented adapter gap: no per-fulfillment, per-line quantity breakdown
  // exists on the Medusa payload, so every fulfillment yields no lines rather
  // than a guessed allocation.
  const lines: readonly CommerceOrderFulfillmentLineFact[] = [];
  return {
    externalFulfillmentId: fulfillment.externalFulfillmentId,
    // The status projection is the adapter's job; passed through verbatim.
    status: fulfillment.status,
    // Medusa's fulfillment object carries neither a carrier code nor a
    // service code.
    carrierCode: null,
    carrierName: null,
    serviceCode: null,
    // TRUNCATION: Medusa allows several shipping labels per fulfillment;
    // the design's shape carries only the first of each.
    trackingNumber: fulfillment.trackingNumbers[0] ?? null,
    trackingUrl: fulfillment.trackingUrls[0] ?? null,
    shippedAt: fulfillment.shippedAt,
    deliveredAt: fulfillment.deliveredAt,
    destinationCountry: fulfillment.destinationCountry,
    destinationRegion: fulfillment.destinationRegion,
    lines,
  };
}

/** Translate one Medusa order fact into the provider-neutral shape. */
export function medusaOrderFactToCommerceFact(
  fact: MedusaOrderFactLike,
  options: MedusaTranslationOptions = {},
): CommerceOrderFact {
  const lines = fact.lineItems.map(translateLine);

  return {
    provider: MEDUSA_PROVIDER,
    channel: options.channel ?? MEDUSA_DEFAULT_CHANNEL,
    // Medusa is a self-hosted single-storefront engine, unlike eBay's
    // sub-markets — no marketplace concept to carry.
    marketplace: null,
    sourceAccountKey: fact.sourceAccountKey,
    externalOrderId: fact.externalOrderId,
    externalOrderNumber: fact.orderNumber,
    status: fact.status,
    paymentStatus: fact.paymentStatus,
    fulfillmentStatus: fact.fulfillmentStatus,
    providerStatusRaw: fact.providerStatusRaw,
    currency: fact.currency,
    // MAPPING #2 — `subtotal` INCLUDES shipping; independent facts must not
    // double-count it. Exact BigInt subtraction, never a JS `number`.
    subtotalAmount: subtractDecimals(
      toMoneyString(fact.totals.subtotal),
      toMoneyString(fact.totals.shipping),
    ),
    shippingAmount: toMoneyString(fact.totals.shipping),
    discountAmount: toMoneyString(fact.totals.discount),
    taxAmount: toMoneyString(fact.totals.tax),
    // MAPPING #3 — Medusa has no fee concept at all; an honest zero.
    feeAmount: "0.000000",
    refundedAmount: toMoneyString(fact.totals.refunded),
    // MAPPING #1 — the AS-PLACED amount, never the refund-reduced `total`.
    totalAmount: toMoneyString(fact.totals.originalTotal),
    buyerExternalId: fact.buyerExternalId,
    // MAPPING #5 — email is PII and the fact contract forbids it here; Medusa
    // offers no channel-native handle the way eBay's username does.
    buyerDisplayName: null,
    placedAt: fact.placedAt,
    providerUpdatedAt: fact.updatedAt,
    // MAPPING #4 — always null, even for a cancelled order; never substitute
    // `updatedAt`, which would fabricate a fact the provider never stated.
    cancelledAt: null,
    lines,
    // Medusa has no fee concept at all — see MAPPING #3.
    fees: [],
    refunds: fact.refunds.map((refund) =>
      translateRefund(refund, fact.currency),
    ),
    fulfillments: fact.fulfillments.map((fulfillment) =>
      translateFulfillment(fulfillment),
    ),
    rawPayload:
      options.retainRawPayload === false
        ? null
        : (fact.raw as Record<string, unknown>),
    providerObjectType: MEDUSA_ORDER_OBJECT_TYPE,
  };
}
