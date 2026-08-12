/**
 * Order read adapter: Medusa v2 Admin API `/admin/orders` normalized into
 * Loxep-owned facts aligned to the Commerce Schema Design's `orders`,
 * `order_lines`, and `order_refunds` sketches.
 *
 * NO PERSISTENCE. This module produces values; it writes nothing. The Phase 3
 * commerce tables do not exist yet and are deliberately not created here,
 * matching `packages/integrations/woo/src/orders.ts`.
 *
 * LIVE-VERIFIED against Medusa **2.18.0** on 2026-08-12 (loxep-xh9.4.1) — a
 * throwaway local backend with real Store-API-placed orders (captured,
 * partially refunded, fulfilled). The mappings below started as readings of
 * Medusa's GitHub source (`medusajs/medusa`, `develop`, fetched 2026-08-11) —
 * principally
 * https://github.com/medusajs/medusa/blob/develop/packages/core/types/src/http/order/common.ts
 * (the `BaseOrder` / `BaseOrderLineItem` / `BaseOrderFulfillment` HTTP-layer
 * DTOs) and
 * https://github.com/medusajs/medusa/blob/develop/packages/core/types/src/order/common.ts
 * (the `OrderStatus` / `PaymentStatus` / `FulfillmentStatus` enums) — and the
 * places where a running backend DISAGREED with that reading are called out
 * inline below and in `test/live-store.test.ts`.
 *
 * ## Why the field list matters here more than it did for WooCommerce
 *
 * `fields` is not optional for this adapter, but NOT for the reason the
 * source reading suggested.
 *
 * The pre-live reading of
 * https://github.com/medusajs/medusa/blob/develop/packages/medusa/src/api/admin/orders/query-config.ts
 * concluded that `payment_status` and `fulfillment_status` are absent from
 * `GET /admin/orders`'s defaults. **That is wrong on 2.18.0.** A live
 * fields-less `GET /admin/orders` returns exactly:
 * `created_at, custom_display_id, display_id, fulfillment_status, id, items,
 * locale, metadata, payment_status, status, summary, total, updated_at,
 * version` — i.e. both statuses AND `items` AND `summary` are already there
 * (`defaultAdminOrderFields` is not the whole story; the order list decorates
 * its rows with computed status/totals afterwards).
 *
 * What IS genuinely missing from the default, and what the explicit list
 * exists for, is the money/provenance detail: `currency_code`, `subtotal`,
 * `tax_total`, `discount_total`, `shipping_total`, `original_total`,
 * `customer_id`, `email`, `payment_collections`, and `fulfillments`. So the
 * adapter still ALWAYS sends {@link MEDUSA_DEFAULT_ORDER_FIELDS} — it just
 * does so to obtain the totals and the payment/fulfillment relations, not to
 * rescue the two status fields.
 *
 * ## `fields` FAILS OPEN, and so do filters — live-observed, load-bearing
 *
 * Medusa 2.18.0 does not validate `fields` or filter keys. Live:
 * `fields=id,not_a_real_field` returns HTTP 200 (the unknown name is
 * silently dropped), and — far more dangerous for incremental sync —
 * `updated_at[$nope]=…` and `not_a_field[$gte]=…` BOTH return HTTP 200 with
 * `count` equal to the UNFILTERED total. A typo in a watermark filter does
 * not error; it silently degrades to a full scan. Anything built on
 * {@link FetchMedusaOrdersInput.updatedAfter} must therefore treat the filter
 * as best-effort and stay idempotent, which Loxep's at-least-once job
 * contract already requires.
 *
 * One more live quirk: `order=<not a column>` returns HTTP **500**
 * (`{"code":"unknown_error","type":"unknown_error"}`), not a 4xx, so a bad
 * sort key normalizes to `provider_unavailable` rather than
 * `invalid_request`.
 *
 * `GET /admin/orders` also filters `is_draft_order: false` unconditionally
 * (same source file) — Medusa's draft-order feature lives at a separate
 * `/admin/draft-orders` endpoint this adapter does not call. So although the
 * `draft` value is a documented `OrderStatus` member, this adapter's
 * `fetchOrders` should never actually observe it; the mapping below still
 * handles it defensively rather than assuming.
 *
 * ## Field sources
 *
 * ```text
 * externalOrderId      ← id                      Medusa's own id, a prefixed
 *                                                  string like "order_01…",
 *                                                  not a small integer
 * orderNumber          ← display_id               per-store sequential integer,
 *                                                  the human-facing order number
 * providerStatusRaw    ← status                   verbatim OrderStatus value
 * currency             ← currency_code             UPPERCASED — Medusa's own
 *                                                  doc example shows lowercase
 *                                                  ("usd"); Loxep's design uses
 *                                                  char(3) ISO 4217, uppercase
 * totals.total          ← total                   LIVE WARNING: this is the
 *                                                  CURRENT order total, NET of
 *                                                  refunds — see "total moves"
 *                                                  below
 * totals.originalTotal   ← original_total          the total as placed, before
 *                                                  refunds/edits
 * totals.subtotal        ← subtotal                Medusa reports this DIRECTLY —
 *                                                  unlike WooCommerce, no
 *                                                  line-sum derivation needed.
 *                                                  LIVE: it INCLUDES shipping
 *                                                  (subtotal = item_subtotal +
 *                                                  shipping_subtotal)
 * totals.shipping        ← shipping_total
 * totals.tax              ← tax_total
 * totals.discount         ← discount_total
 * totals.refunded         ← DERIVED: exact sum of every
 *                                                  payment_collections[].payments[].refunds[].amount
 *                                                  — Medusa's refund amounts
 *                                                  are already positive
 *                                                  magnitudes (unlike
 *                                                  WooCommerce's negative
 *                                                  convention), so no sign
 *                                                  flip is needed
 * placedAt              ← created_at              standard ISO instant WITH a
 *                                                  zone designator — Medusa
 *                                                  has no WooCommerce-style
 *                                                  zone-less `*_gmt` landmine
 * updatedAt             ← updated_at
 * buyerExternalId        ← customer_id             null for a guest — Medusa
 *                                                  simply omits the field
 *                                                  rather than WooCommerce's
 *                                                  sentinel `0`
 * lineItems[]            ← items[]
 * refunds[]               ← payment_collections[].payments[].refunds[], flattened
 * fulfillments[]          ← fulfillments[]
 * ```
 *
 * ## `total` MOVES after a refund — the most consequential live finding
 *
 * A Medusa order's `total` is not the immutable "amount of the sale" a
 * ledger wants; it is the CURRENT order total, recomputed as the order
 * changes. Live-observed on 2.18.0, one order, before and after a €5 refund
 * against a €30 captured order:
 *
 * ```text
 *                       placed      after the €5 refund
 * total                  30                25
 * original_total         30                30
 * subtotal               30                30      (item 20 + shipping 10)
 * summary.paid_total     30                30
 * summary.refunded_total  0                 5
 * summary.credit_line_total 0               5
 * summary.current_order_total  30          25
 * summary.original_order_total 30          30
 * payment_status     "captured"  "partially_refunded"
 * ```
 *
 * Two consequences a consumer MUST respect:
 *
 * 1. `totals.total` is a moving value. Persisting it as the design's
 *    `orders.total` means the stored amount changes on re-sync after a
 *    refund. {@link MedusaOrderTotals.originalTotal} (`original_total`) is
 *    the stable as-placed amount, and is the better source for an order's
 *    face value.
 * 2. **Do not compute `total - refunded`.** `totals.refunded` is the exact
 *    sum of the refund rows, and Medusa has ALREADY subtracted it from
 *    `total`. Subtracting again double-counts. (`subtotal` does NOT move.)
 *
 * The `summary` object is requested and retained in {@link
 * MedusaOrderFact.raw} for exactly this reason: `paid_total`,
 * `refunded_total`, `current_order_total`, and `original_order_total` are the
 * accounting-grade numbers, and their `raw_*` twins carry Medusa's own
 * `{value, precision}` decimal representation.
 *
 * ## No fee concept at all — stronger than WooCommerce's finding
 *
 * WooCommerce at least reports buyer-facing `fee_lines` (surcharges the
 * merchant adds, already inside `orders.total`) even though it has no
 * seller-side platform fee. Medusa's Admin API order object has NO fee-like
 * concept whatsoever in the fields verified here — no buyer surcharge line,
 * no seller platform fee. Medusa is a self-hosted commerce engine, not a
 * marketplace; whatever a payment provider (Stripe, etc.) charges lives in
 * that provider's own system, not in Medusa's order data. `MedusaOrderFact`
 * therefore carries no fee-shaped field at all, and the design's
 * `order_fees` has no Medusa source until a payment-provider integration is
 * added downstream — a stronger version of the same gap the WooCommerce
 * adapter's module doc records.
 *
 * ## Two honest gaps in the timestamp/status mapping
 *
 * 1. **No order-level `cancelled_at`.** The HTTP-layer `BaseOrder` type
 *    exposes no cancellation timestamp — only individual
 *    `fulfillments[].canceled_at`. The internal `OrderDTO` (module layer, not
 *    what the Admin API returns) does carry one, but this adapter only sees
 *    what the Admin API sends. `MedusaOrderFact.cancelledAt` is therefore
 *    always `null`; a service consuming this adapter cannot populate the
 *    design's `orders.cancelled_at` from this field alone. This is a real
 *    verification gap, not an oversight — see the follow-up bead.
 * 2. **`paidAt` is derived, not provider-reported.** No order-level
 *    "paid at" field exists either. This adapter derives it as the EARLIEST
 *    non-null `payment_collections[].payments[].captured_at` across every
 *    payment collection, which is a reasonable proxy but not a fact Medusa
 *    states directly. It is offered as a diagnostic convenience — the
 *    design's `orders` table has no `paid_at` column at all, so nothing
 *    downstream depends on this being exact.
 *
 *    **This was silently broken until live verification.** Medusa's `*a.b.c`
 *    selector expands the LEAF relation only — it does not select the
 *    intermediate entity's own scalar columns. With the original field list
 *    (`*payment_collections.payments.refunds` alone), every live payment came
 *    back as `{id, refunds}`: no `captured_at`, no `amount`. `derivePaidAt`
 *    could therefore only ever return `null`, and no fixture caught it
 *    because the fixtures were written from the DTO type rather than from a
 *    response. {@link MEDUSA_DEFAULT_ORDER_FIELDS} now also requests
 *    `*payment_collections` and `*payment_collections.payments`, which live
 *    returns with `amount`, `captured_at`, `canceled_at`, `provider_id`, and
 *    the collection's own `status`/`authorized_amount`/`captured_amount`/
 *    `refunded_amount`. The general rule this teaches: **request every level
 *    of a nested path whose scalars you intend to read.**
 *
 * ## Status: three native lifecycles, still lossy in translation
 *
 * Medusa, unlike WooCommerce, already tracks `status` / `payment_status` /
 * `fulfillment_status` as three independent enums — matching the design's
 * shape more closely than WooCommerce's single collapsed status did. The
 * translation into the design's own (differently-named) three-way union is
 * still lossy in specific, documented ways; see {@link MEDUSA_STATUS_MAP},
 * {@link MEDUSA_PAYMENT_STATUS_MAP}, and {@link MEDUSA_FULFILLMENT_STATUS_MAP}.
 */
import type { MedusaAdapter, MedusaQuery } from "./adapter.ts";
import { MEDUSA_DEFAULT_LIMIT, MEDUSA_MAX_LIMIT } from "./adapter.ts";
import { MedusaAdapterError } from "./errors.ts";
import {
  absDecimal,
  decimalFromUnknown,
  isZeroDecimal,
  normalizeMedusaCurrencyCode,
  sumDecimals,
} from "./money.ts";

/* ------------------------------------------------------------------ types */

/** Medusa's own native `status` enum, verified from `order/common.ts`. */
export const MEDUSA_NATIVE_ORDER_STATUSES = [
  "pending",
  "completed",
  "draft",
  "archived",
  "canceled",
  "requires_action",
] as const;
export type MedusaNativeOrderStatus =
  (typeof MEDUSA_NATIVE_ORDER_STATUSES)[number];

/** Medusa's own native `payment_status` enum. */
export const MEDUSA_NATIVE_PAYMENT_STATUSES = [
  "not_paid",
  "awaiting",
  "authorized",
  "partially_authorized",
  "captured",
  "partially_captured",
  "partially_refunded",
  "refunded",
  "canceled",
  "requires_action",
] as const;
export type MedusaNativePaymentStatus =
  (typeof MEDUSA_NATIVE_PAYMENT_STATUSES)[number];

/** Medusa's own native `fulfillment_status` enum. */
export const MEDUSA_NATIVE_FULFILLMENT_STATUSES = [
  "not_fulfilled",
  "partially_fulfilled",
  "fulfilled",
  "partially_shipped",
  "shipped",
  "partially_delivered",
  "delivered",
  "canceled",
] as const;
export type MedusaNativeFulfillmentStatus =
  (typeof MEDUSA_NATIVE_FULFILLMENT_STATUSES)[number];

/** Design candidate union for `orders.status` (same vocabulary as Woo's). */
export const MEDUSA_ORDER_STATUSES = [
  "pending",
  "open",
  "completed",
  "cancelled",
] as const;
export type MedusaOrderStatus = (typeof MEDUSA_ORDER_STATUSES)[number];

/** Design candidate union for `orders.payment_status`. */
export const MEDUSA_PAYMENT_STATUSES = [
  "unpaid",
  "partially_paid",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
] as const;
export type MedusaPaymentStatus = (typeof MEDUSA_PAYMENT_STATUSES)[number];

/** Design candidate union for `orders.fulfillment_status`. */
export const MEDUSA_FULFILLMENT_STATUSES = [
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
  "cancelled",
] as const;
export type MedusaFulfillmentStatus =
  (typeof MEDUSA_FULFILLMENT_STATUSES)[number];

/**
 * `status` translation. `draft` should never actually arrive (see the
 * module doc — `/admin/orders` filters `is_draft_order: false`); handled
 * defensively. `archived` and `requires_action` are documented Medusa enum
 * members with no elaboration found in the source reviewed here — the
 * mappings below are this adapter's best-effort reading, flagged as such,
 * not confirmed against observed payloads.
 */
export const MEDUSA_STATUS_MAP: Readonly<
  Record<MedusaNativeOrderStatus, MedusaOrderStatus>
> = {
  pending: "pending",
  // No elaboration found for "requires_action" beyond its name; read as "the
  // order needs a manual step before it can be considered placed/settled",
  // which is closer to the design's "pending" than "open" or "completed".
  requires_action: "pending",
  completed: "completed",
  // Not expected via this endpoint (is_draft_order is filtered server-side);
  // defensive floor only.
  draft: "pending",
  // No elaboration found; read as "a completed order that has been filed
  // away", by analogy with the common admin-UI sense of "archive" (closed,
  // not voided) — NOT confirmed against an observed payload.
  archived: "completed",
  canceled: "cancelled",
};

/**
 * `payment_status` translation. The design's union has no "authorized but
 * not captured" concept, so `authorized`/`partially_authorized` — funds
 * held, not yet settled to the merchant — map to `unpaid` rather than
 * `paid`, to avoid overstating settlement.
 */
export const MEDUSA_PAYMENT_STATUS_MAP: Readonly<
  Record<MedusaNativePaymentStatus, MedusaPaymentStatus>
> = {
  not_paid: "unpaid",
  awaiting: "unpaid",
  authorized: "unpaid",
  partially_authorized: "unpaid",
  captured: "paid",
  partially_captured: "partially_paid",
  partially_refunded: "partially_refunded",
  refunded: "refunded",
  // A canceled payment collection means no successful payment was captured
  // for it — the closest design member is "failed", matching the
  // WooCommerce adapter's reading of Woo's own `failed` status.
  canceled: "failed",
  requires_action: "unpaid",
};

/**
 * `fulfillment_status` translation. Medusa's native lifecycle is finer than
 * the design's (it distinguishes packed/fulfilled from shipped from
 * delivered); the design's union stops at `fulfilled` and relies on
 * `order_fulfillments.shipped_at`/`delivered_at` for the finer timestamps.
 * Every "whole order" terminal state at or beyond `fulfilled` collapses to
 * `fulfilled`; every "some but not all" state collapses to
 * `partially_fulfilled`.
 */
export const MEDUSA_FULFILLMENT_STATUS_MAP: Readonly<
  Record<MedusaNativeFulfillmentStatus, MedusaFulfillmentStatus>
> = {
  not_fulfilled: "unfulfilled",
  partially_fulfilled: "partially_fulfilled",
  fulfilled: "fulfilled",
  partially_shipped: "partially_fulfilled",
  shipped: "fulfilled",
  partially_delivered: "partially_fulfilled",
  delivered: "fulfilled",
  canceled: "cancelled",
};

export interface MedusaOrderTotals {
  /**
   * Provider `total` — the CURRENT total, which Medusa reduces when a refund
   * is issued (live-verified; see the module doc). Prefer
   * {@link MedusaOrderTotals.originalTotal} for an order's as-placed face
   * value, and never compute `total - refunded`.
   */
  total: string;
  /**
   * Provider `original_total` — the as-placed amount, unaffected by refunds.
   * Falls back to `total` when a payload omits it.
   */
  originalTotal: string;
  /**
   * Provider `subtotal` — reported directly, unlike WooCommerce. LIVE:
   * INCLUDES shipping (`item_subtotal + shipping_subtotal`), and does not
   * move when a refund lands.
   */
  subtotal: string;
  /** Provider `shipping_total`. */
  shipping: string;
  /** Provider `tax_total`. */
  tax: string;
  /** Provider `discount_total`. */
  discount: string;
  /** DERIVED — exact sum of every refund's `amount` (already positive). */
  refunded: string;
}

export interface MedusaOrderLineFact {
  /** `items[].id`, stable across re-syncs → design `external_line_id`. */
  externalLineId: string;
  /** 1-based position → design `order_lines.line_number`. */
  lineNumber: number;
  /** `variant_sku`. */
  sku: string | null;
  /** `title`. */
  name: string;
  /** `product_id`. */
  externalItemId: string | null;
  /** `variant_id`. */
  externalVariationId: string | null;
  /** Decimal string — design stores quantity as `numeric(20,6)`. */
  quantity: string;
  /** `unit_price` — a JS number in major units; see money.ts. */
  unitPrice: string | null;
  /** `subtotal` — pre-discount, excluding tax. */
  lineSubtotal: string;
  /** `total` — post-discount, including tax → design `order_lines.line_total`. */
  lineTotal: string;
  /** `tax_total` → design `order_lines.tax_amount`. */
  lineTax: string;
  /** `discount_total` — reported directly, unlike WooCommerce's derived value. */
  discount: string;
}

export interface MedusaRefundFact {
  /** → design `order_refunds.external_refund_id`. */
  externalRefundId: string;
  /** `refund_reason.label`, else `note`, else null. */
  reason: string | null;
  /** Already a positive magnitude — no sign flip needed (contrast WooCommerce). */
  amount: string;
  createdAt: string | null;
}

/**
 * A Medusa fulfillment. `status` here is DERIVED by this adapter from the
 * presence of `canceled_at`/`delivered_at`/`shipped_at`/`packed_at` —
 * Medusa's `BaseOrderFulfillment` carries no single `status` string field of
 * its own (verified: no such field on the type).
 *
 * `trackingNumbers`/`trackingUrls` come from `labels[]`
 * (`FulfillmentLabelDTO`); a fulfillment with no tracking number is normal
 * (digital goods, local pickup), matching the WooCommerce adapter's note.
 *
 * KNOWN GAP: no per-fulfillment, per-line quantity breakdown was found on
 * `BaseOrderFulfillment` (contrast the design's `order_fulfillment_lines`,
 * which wants exactly that). Only aggregate per-LINE
 * `detail.fulfilled_quantity`/`shipped_quantity`/`delivered_quantity` exist
 * on `BaseOrderLineItem`, which cannot be attributed back to a specific
 * fulfillment when an order has more than one. This adapter therefore does
 * not attempt to populate fulfillment-line quantities; a service needing
 * them will need a source this research did not find (possibly a dedicated
 * fulfillment-detail endpoint) — flagged for the follow-up bead.
 */
export interface MedusaFulfillmentFact {
  /** → design `order_fulfillments.external_fulfillment_id`. */
  externalFulfillmentId: string;
  /** DERIVED — see the type doc. `pending | packed | shipped | delivered | canceled`. */
  status: "pending" | "packed" | "shipped" | "delivered" | "canceled";
  trackingNumbers: string[];
  trackingUrls: string[];
  shippedAt: string | null;
  deliveredAt: string | null;
  canceledAt: string | null;
  /** `delivery_address.country_code`, uppercased. */
  destinationCountry: string | null;
  /** `delivery_address.province`. */
  destinationRegion: string | null;
}

/**
 * Provider payload retained verbatim for provenance (ADR-0009 #3), destined
 * for `provider_objects` — never for a domain column.
 *
 * **THIS VALUE MAY CONTAIN PERSONAL DATA.** With the `fields` list this
 * adapter requests, a Medusa order payload carries `shipping_address` /
 * `billing_address` (name, address, phone) and `email` when those fields are
 * included. Do not log it, do not put it in a snapshot fixture, do not
 * include it in an error, and do not assert on it in a test that can print a
 * diff. Use {@link redactMedusaOrderFact} for anything that might be
 * displayed.
 */
export type MedusaRawOrderPayload = Readonly<Record<string, unknown>>;

export interface MedusaOrderFact {
  /** Medusa's own id (`order_01…`) → design `orders.external_order_id`. */
  externalOrderId: string;
  /** `display_id` → design `orders.external_order_number`. */
  orderNumber: string | null;
  /** `medusa:<baseUrl>` → design `orders.source_account_key`. */
  sourceAccountKey: string;
  status: MedusaOrderStatus;
  paymentStatus: MedusaPaymentStatus;
  fulfillmentStatus: MedusaFulfillmentStatus;
  /** Medusa's own `status` verbatim → design `orders.provider_status_raw`. */
  providerStatusRaw: string;
  /** Medusa's own `payment_status` verbatim — beyond the design's minimum, kept for diagnosis. */
  providerPaymentStatusRaw: string;
  /** Medusa's own `fulfillment_status` verbatim — same reasoning. */
  providerFulfillmentStatusRaw: string;
  /** False only if a raw status fell outside every known Medusa enum (defensive; not expected). */
  statusRecognized: boolean;
  /** Uppercased ISO 4217. */
  currency: string;
  totals: MedusaOrderTotals;
  /** ISO-8601 UTC → design `orders.placed_at`. */
  placedAt: string;
  /** ISO-8601 UTC → design `orders.provider_updated_at` (sync watermark). */
  updatedAt: string | null;
  /** DERIVED diagnostic — see the module doc. Not a design column. */
  paidAt: string | null;
  /** Always null — see the module doc's "no order-level cancelled_at" gap. */
  cancelledAt: string | null;
  /** `customer_id`; absent for a guest → null (no WooCommerce-style `"0"` sentinel). */
  buyerExternalId: string | null;
  lineItems: MedusaOrderLineFact[];
  refunds: MedusaRefundFact[];
  fulfillments: MedusaFulfillmentFact[];
  /** Provenance payload. MAY CONTAIN PERSONAL DATA — see {@link MedusaRawOrderPayload}. */
  raw: MedusaRawOrderPayload;
}

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

function isNativeOrderStatus(value: string): value is MedusaNativeOrderStatus {
  return (MEDUSA_NATIVE_ORDER_STATUSES as readonly string[]).includes(value);
}

function isNativePaymentStatus(
  value: string,
): value is MedusaNativePaymentStatus {
  return (MEDUSA_NATIVE_PAYMENT_STATUSES as readonly string[]).includes(value);
}

function isNativeFulfillmentStatus(
  value: string,
): value is MedusaNativeFulfillmentStatus {
  return (MEDUSA_NATIVE_FULFILLMENT_STATUSES as readonly string[]).includes(
    value,
  );
}

/**
 * Medusa's `created_at`/`updated_at`/etc. serialize as ordinary ISO-8601
 * instants WITH a zone designator (standard `Date` → JSON serialization).
 * Unlike WooCommerce's zone-less `*_gmt` fields, no `Z`-appending workaround
 * is needed here — this is a straight parse-and-reformat.
 */
export function isoFromMedusa(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const ZERO = "0.00";

/* ---------------------------------------------------------------- mapping */

function deriveFulfillmentStatus(
  fulfillment: Record<string, unknown>,
): MedusaFulfillmentFact["status"] {
  if (asText(fulfillment["canceled_at"]) !== null) return "canceled";
  if (asText(fulfillment["delivered_at"]) !== null) return "delivered";
  if (asText(fulfillment["shipped_at"]) !== null) return "shipped";
  if (asText(fulfillment["packed_at"]) !== null) return "packed";
  return "pending";
}

function mapFulfillment(
  raw: Record<string, unknown>,
): MedusaFulfillmentFact {
  const labels = asRecordArray(raw["labels"]);
  const address = asRecord(raw["delivery_address"]);
  return {
    externalFulfillmentId: asText(raw["id"]) ?? "",
    status: deriveFulfillmentStatus(raw),
    trackingNumbers: labels
      .map((label) => asText(label["tracking_number"]))
      .filter((value): value is string => value !== null),
    trackingUrls: labels
      .map((label) => asText(label["tracking_url"]))
      .filter((value): value is string => value !== null),
    shippedAt: isoFromMedusa(raw["shipped_at"]),
    deliveredAt: isoFromMedusa(raw["delivered_at"]),
    canceledAt: isoFromMedusa(raw["canceled_at"]),
    destinationCountry:
      address === null
        ? null
        : (asText(address["country_code"])?.toUpperCase() ?? null),
    destinationRegion: address === null ? null : asText(address["province"]),
  };
}

/** Flatten `payment_collections[].payments[].refunds[]` into one list. */
function extractRefunds(raw: Record<string, unknown>): MedusaRefundFact[] {
  const refunds: MedusaRefundFact[] = [];
  for (const collection of asRecordArray(raw["payment_collections"])) {
    for (const payment of asRecordArray(collection["payments"])) {
      for (const refund of asRecordArray(payment["refunds"])) {
        const reasonRecord = asRecord(refund["refund_reason"]);
        refunds.push({
          externalRefundId: asText(refund["id"]) ?? "",
          reason:
            (reasonRecord !== null ? asText(reasonRecord["label"]) : null) ??
            asText(refund["note"]),
          amount: decimalFromUnknown(refund["amount"]) ?? ZERO,
          createdAt: isoFromMedusa(refund["created_at"]),
        });
      }
    }
  }
  return refunds;
}

/** Earliest `captured_at` across every payment collection's payments, or null. */
function derivePaidAt(raw: Record<string, unknown>): string | null {
  let earliest: string | null = null;
  for (const collection of asRecordArray(raw["payment_collections"])) {
    for (const payment of asRecordArray(collection["payments"])) {
      const capturedAt = isoFromMedusa(payment["captured_at"]);
      if (capturedAt !== null && (earliest === null || capturedAt < earliest)) {
        earliest = capturedAt;
      }
    }
  }
  return earliest;
}

export interface MapMedusaOrderOptions {
  /** `medusa:<baseUrl>` — usually `adapter.sourceAccountKey`. */
  sourceAccountKey: string;
}

/** Pure mapping from a raw Medusa order payload to the Loxep-owned fact. */
export function mapMedusaOrder(
  raw: Record<string, unknown>,
  options: MapMedusaOrderOptions,
): MedusaOrderFact {
  const externalOrderId = asText(raw["id"]);
  if (externalOrderId === null) {
    throw new MedusaAdapterError(
      "provider_unavailable",
      "Medusa order payload has no id; refusing to build an order fact",
    );
  }

  const providerStatusRaw = asText(raw["status"]) ?? "";
  const providerPaymentStatusRaw = asText(raw["payment_status"]) ?? "";
  const providerFulfillmentStatusRaw = asText(raw["fulfillment_status"]) ?? "";

  const statusEntry = isNativeOrderStatus(providerStatusRaw)
    ? MEDUSA_STATUS_MAP[providerStatusRaw]
    : undefined;
  const paymentEntry = isNativePaymentStatus(providerPaymentStatusRaw)
    ? MEDUSA_PAYMENT_STATUS_MAP[providerPaymentStatusRaw]
    : undefined;
  const fulfillmentEntry = isNativeFulfillmentStatus(
    providerFulfillmentStatusRaw,
  )
    ? MEDUSA_FULFILLMENT_STATUS_MAP[providerFulfillmentStatusRaw]
    : undefined;
  const statusRecognized =
    statusEntry !== undefined &&
    paymentEntry !== undefined &&
    fulfillmentEntry !== undefined;

  const lineItems = asRecordArray(raw["items"]).map(
    (item, index): MedusaOrderLineFact => ({
      externalLineId: asText(item["id"]) ?? `index:${index + 1}`,
      lineNumber: index + 1,
      sku: asText(item["variant_sku"]),
      name: asText(item["title"]) ?? "",
      externalItemId: asText(item["product_id"]),
      externalVariationId: asText(item["variant_id"]),
      quantity: decimalFromUnknown(item["quantity"]) ?? "1",
      unitPrice: decimalFromUnknown(item["unit_price"]),
      lineSubtotal: decimalFromUnknown(item["subtotal"]) ?? ZERO,
      lineTotal: decimalFromUnknown(item["total"]) ?? ZERO,
      lineTax: decimalFromUnknown(item["tax_total"]) ?? ZERO,
      discount: decimalFromUnknown(item["discount_total"]) ?? ZERO,
    }),
  );

  const refunds = extractRefunds(raw);
  const refundedTotal = sumDecimals(
    refunds.map((refund) => refund.amount),
    ZERO,
  );

  const placedAt = isoFromMedusa(raw["created_at"]);
  if (placedAt === null) {
    throw new MedusaAdapterError(
      "provider_unavailable",
      "Medusa order payload has no usable creation date",
      { externalOrderId },
    );
  }

  return {
    externalOrderId,
    orderNumber:
      typeof raw["display_id"] === "number"
        ? String(raw["display_id"])
        : asText(raw["display_id"]),
    sourceAccountKey: options.sourceAccountKey,
    status: statusEntry ?? "pending",
    paymentStatus: paymentEntry ?? "unpaid",
    fulfillmentStatus: fulfillmentEntry ?? "unfulfilled",
    providerStatusRaw,
    providerPaymentStatusRaw,
    providerFulfillmentStatusRaw,
    statusRecognized,
    currency: normalizeMedusaCurrencyCode(raw["currency_code"]),
    totals: {
      total: decimalFromUnknown(raw["total"]) ?? ZERO,
      originalTotal:
        decimalFromUnknown(raw["original_total"]) ??
        decimalFromUnknown(raw["total"]) ??
        ZERO,
      subtotal: decimalFromUnknown(raw["subtotal"]) ?? ZERO,
      shipping: decimalFromUnknown(raw["shipping_total"]) ?? ZERO,
      tax: decimalFromUnknown(raw["tax_total"]) ?? ZERO,
      discount: decimalFromUnknown(raw["discount_total"]) ?? ZERO,
      refunded: isZeroDecimal(refundedTotal) ? ZERO : refundedTotal,
    },
    placedAt,
    updatedAt: isoFromMedusa(raw["updated_at"]),
    paidAt: derivePaidAt(raw),
    // Always null — see the module doc's documented gap.
    cancelledAt: null,
    buyerExternalId: asText(raw["customer_id"]),
    lineItems,
    refunds,
    fulfillments: asRecordArray(raw["fulfillments"]).map(mapFulfillment),
    raw,
  };
}

/**
 * Everything about an order fact EXCEPT `raw`. Use this for logging, health
 * surfaces, and any test output that could be printed.
 */
export function redactMedusaOrderFact(
  fact: MedusaOrderFact,
): Omit<MedusaOrderFact, "raw"> & { raw: "[redacted]" } {
  const { raw: _raw, ...rest } = fact;
  return { ...rest, raw: "[redacted]" };
}

/* ---------------------------------------------------------------- fetching */

/**
 * The `fields` list this adapter sends on every order fetch — see the module
 * doc for why (the totals and the payment/fulfillment relations, NOT the two
 * status fields, which 2.18.0 returns by default).
 *
 * LIVE-VERIFIED as a whole string against Medusa 2.18.0 (HTTP 200, every
 * requested relation populated). Two rules this list encodes, both learned
 * from a running backend rather than from the docs:
 *
 * 1. **Every level of a nested path must be requested if you read its own
 *    columns.** `*payment_collections.payments.refunds` alone yields
 *    `payments: [{id, refunds}]` — the intermediate `payments` entity keeps
 *    only its id. `*payment_collections` and `*payment_collections.payments`
 *    are therefore listed explicitly (see the `paidAt` gap in the module
 *    doc).
 * 2. **Unknown names are silently ignored** (`fields=id,not_a_real_field` →
 *    HTTP 200), so a typo here degrades data quietly instead of failing.
 *
 * `items` and `version` come back whether or not they are requested.
 */
const MEDUSA_ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "currency_code",
  "email",
  "customer_id",
  "created_at",
  "updated_at",
  "total",
  // The as-placed amount. `total` moves when a refund lands; this does not.
  "original_total",
  "subtotal",
  "tax_total",
  "discount_total",
  "shipping_total",
  // Accounting-grade provenance (paid_total / refunded_total /
  // current_order_total / original_order_total) — raw payload only.
  "summary",
  "payment_status",
  "fulfillment_status",
  "*items",
  "*items.detail",
  "*payment_collections",
  "*payment_collections.payments",
  "*payment_collections.payments.refunds",
  "*payment_collections.payments.refunds.refund_reason",
  "*fulfillments",
  "*fulfillments.labels",
  "*fulfillments.delivery_address",
] as const;

export const MEDUSA_DEFAULT_ORDER_FIELDS = MEDUSA_ORDER_FIELDS.join(",");

export interface FetchMedusaOrdersInput {
  /**
   * Incremental-sync watermark. Serialized as `updated_at[$gte]=<ISO>`,
   * following the `$gte`/`$lte`/… operator-key convention confirmed in
   * Medusa's own filter-operator source
   * (https://github.com/medusajs/medusa/blob/develop/packages/core/utils/src/common/filter-operator-map.ts)
   * and the `OperatorMap<string>` typing of `AdminOrderFilters.updated_at`
   * (https://github.com/medusajs/medusa/blob/develop/packages/core/types/src/http/order/admin/queries.ts).
   *
   * LIVE-VERIFIED on 2.18.0 (loxep-xh9.4.1), both halves of the question:
   *
   * - **Encoding.** The adapter builds its query with `URLSearchParams`,
   *   which percent-encodes the brackets — the wire form is
   *   `updated_at%5B%24gte%5D=<ISO>`. Medusa parses that identically to
   *   literal `updated_at[$gte]=<ISO>`: both returned the same filtered
   *   `count`. No manual bracket handling is needed.
   * - **Inclusivity.** `$gte` is INCLUSIVE of the boundary instant. Filtering
   *   at exactly a known order's `updated_at` returned that order; `$gt` at
   *   the same instant excluded it. A watermark carried forward as
   *   `updated_at[$gte]=<last seen>` therefore re-delivers the boundary row
   *   on every poll — correct for at-least-once ingestion with idempotent
   *   handlers, and the reason to advance a cursor by row identity rather
   *   than by assuming the timestamp excludes what was already seen.
   *
   * Timestamps come back as full ISO-8601 with milliseconds and a `Z`
   * designator (e.g. `2026-08-12T13:23:35.142Z`), so the boundary compares
   * exactly.
   */
  updatedAfter?: Date | string;
  /** 0-based. Default 0. */
  offset?: number;
  /** Default {@link MEDUSA_DEFAULT_LIMIT}. */
  limit?: number;
  /** Filter by Medusa's native `status` value(s). Omit for every status. */
  status?: string | readonly string[];
  /** Comma-separated Medusa `fields` string. Defaults to {@link MEDUSA_DEFAULT_ORDER_FIELDS}. */
  fields?: string;
  /** `-created_at` (default, newest first) or any Medusa `order` value. */
  order?: string;
}

export interface MedusaOrderPage {
  orders: MedusaOrderFact[];
  page: {
    offset: number;
    limit: number;
    count: number | null;
    hasNextPage: boolean;
  };
}

function toIsoInstant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MedusaAdapterError(
      "invalid_request",
      "Medusa date filter is not a valid instant",
    );
  }
  return date.toISOString();
}

export function buildMedusaOrdersQuery(
  input: FetchMedusaOrdersInput = {},
): MedusaQuery {
  const limit = Math.min(
    Math.max(1, input.limit ?? MEDUSA_DEFAULT_LIMIT),
    MEDUSA_MAX_LIMIT,
  );
  const query: Record<string, string | number | readonly string[]> = {
    offset: Math.max(0, input.offset ?? 0),
    limit,
    fields: input.fields ?? MEDUSA_DEFAULT_ORDER_FIELDS,
    // Walking a watermark wants oldest-changed-first; a plain listing wants
    // newest first — same ordering discipline as the WooCommerce adapter.
    order: input.order ?? (input.updatedAfter !== undefined ? "updated_at" : "-created_at"),
  };
  if (input.status !== undefined) {
    query["status"] = input.status;
  }
  if (input.updatedAfter !== undefined) {
    query["updated_at[$gte]"] = toIsoInstant(input.updatedAfter);
  }
  return query;
}

/** One page of orders plus the pagination info. */
export async function fetchOrdersPage(
  adapter: MedusaAdapter,
  input: FetchMedusaOrdersInput = {},
): Promise<MedusaOrderPage> {
  const result = await adapter.list(
    "/orders",
    "orders",
    buildMedusaOrdersQuery(input),
    { operation: "orders.list" },
  );
  return {
    orders: result.items.map((item) =>
      mapMedusaOrder(item, { sourceAccountKey: adapter.sourceAccountKey }),
    ),
    page: {
      offset: result.page.offset,
      limit: result.page.limit,
      count: result.page.count,
      hasNextPage: result.page.hasNextPage,
    },
  };
}

/** One page of normalized orders. */
export async function fetchOrders(
  adapter: MedusaAdapter,
  input: FetchMedusaOrdersInput = {},
): Promise<MedusaOrderFact[]> {
  return (await fetchOrdersPage(adapter, input)).orders;
}

/**
 * Walk every page of orders matching the filter, using the adapter's
 * body-driven pagination. Yields one page of facts at a time so a caller
 * can persist incrementally rather than buffering a whole backfill.
 */
export async function* iterateMedusaOrders(
  adapter: MedusaAdapter,
  input: FetchMedusaOrdersInput = {},
  options: { maxPages?: number } = {},
): AsyncGenerator<MedusaOrderPage, void, undefined> {
  const { offset: _offset, limit, ...filter } = input;
  const query = buildMedusaOrdersQuery({ ...filter, limit });
  const { offset: _o, limit: _l, ...rest } = query as Record<string, unknown>;
  for await (const result of adapter.paginate("/orders", "orders", {
    query: rest as MedusaQuery,
    limit: limit ?? MEDUSA_DEFAULT_LIMIT,
    startOffset: input.offset ?? 0,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  })) {
    yield {
      orders: result.items.map((item) =>
        mapMedusaOrder(item, { sourceAccountKey: adapter.sourceAccountKey }),
      ),
      page: {
        offset: result.page.offset,
        limit: result.page.limit,
        count: result.page.count,
        hasNextPage: result.page.hasNextPage,
      },
    };
  }
}
