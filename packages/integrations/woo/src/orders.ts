/**
 * Order read adapter: WooCommerce REST v3 `/orders` normalized into
 * Loxep-owned facts aligned to the Commerce Schema Design's `orders`,
 * `order_lines`, `order_fees`, and `order_refunds` sketches.
 *
 * NO PERSISTENCE. This module produces values; it writes nothing. The Phase 3
 * commerce tables do not exist yet and are deliberately not created here.
 *
 * ## Field sources (verified against the WooCommerce REST API docs AND a live
 * WooCommerce 10.9.3 store — the two disagree in three places, noted below)
 *
 * ```text
 * externalOrderId    ← String(id)
 * orderNumber        ← number            DOC SAYS integer, LIVE RETURNS string
 * providerStatusRaw  ← status            verbatim, `wc-` prefix stripped
 * currency           ← currency          ISO-4217
 * totals.total       ← total
 * totals.tax         ← total_tax
 * totals.shipping    ← shipping_total
 * totals.discount    ← discount_total
 * totals.subtotal    ← DERIVED: exact sum of line_items[].subtotal
 *                      (WooCommerce reports no order-level subtotal at all)
 * totals.refunded    ← DERIVED: exact sum of |refunds[].total|
 * placedAt           ← date_created_gmt   (+"Z" — Woo omits the zone marker)
 * updatedAt          ← date_modified_gmt
 * paidAt             ← date_paid_gmt
 * completedAt        ← date_completed_gmt
 * buyerExternalId    ← String(customer_id), "0" (guest) → null
 * lineItems[]        ← line_items[]
 * feeLines[]         ← fee_lines[]        SEE THE WARNING BELOW
 * refunds[]          ← refunds[]          {id, reason, total} summary refs
 * ```
 *
 * ## Three documentation-vs-reality divergences found live
 *
 * 1. `number` is a JSON **string** (`"5165"`), not the documented integer.
 * 2. `line_items[].price` is a JSON **number** (`179.99`) while every sibling
 *    money field is a string (`"179.99"`). It is the only float money field in
 *    the payload. `unitPrice` is converted through
 *    {@link decimalFromNumber} and is `null` rather than approximate when the
 *    value cannot be written exactly in plain decimal notation.
 * 3. Payloads carry plugin-injected top-level keys (the live store adds
 *    `wpo_wcpdf_invoice_number`). Mapping must be key-driven, never
 *    shape-exhaustive — which is also why `raw` is retained.
 *
 * ## Status: one Woo lifecycle into the design's three
 *
 * The design models `status` / `payment_status` / `fulfillment_status` as
 * three independent lifecycles because "providers move them independently".
 * **WooCommerce core has exactly one.** The mapping in {@link WOO_STATUS_MAP}
 * is therefore a projection, and it is lossy in a specific, documented way:
 *
 * - Woo has no fulfillment concept. Only `completed` licenses `fulfilled`;
 *   `cancelled`/`trash` map to `cancelled`; everything else degrades to
 *   `unfulfilled`. `partially_fulfilled` is UNREACHABLE from Woo core.
 * - Woo's `refunded` status REPLACES the previous status, so a fully refunded
 *   order no longer says whether it shipped. It maps to
 *   `fulfillment_status = 'unfulfilled'` — the design's union has no
 *   `unknown` member, and claiming `fulfilled` would invent a fact.
 * - `partially_refunded` is not a Woo status. It is derived: a non-empty
 *   `refunds` array on an order whose status is not `refunded`.
 * - Unknown statuses (plugins register custom ones freely) map to the
 *   pending/unpaid/unfulfilled floor and set `statusRecognized: false`.
 *   `providerStatusRaw` is the diagnosable evidence, exactly as the design
 *   intends `provider_status_raw` to be used.
 */
import type { WooAdapter, WooQuery } from "./adapter.ts";
import { WOO_MAX_PER_PAGE, WOO_DEFAULT_PER_PAGE } from "./adapter.ts";
import { WooAdapterError } from "./errors.ts";
import {
  absDecimal,
  decimalFromNumber,
  decimalFromProvider,
  decimalFromUnknown,
  isZeroDecimal,
  subtractDecimals,
  sumDecimals,
} from "./money.ts";

/* ------------------------------------------------------------------ types */

/** Design candidate union for `orders.status`. */
export const WOO_ORDER_STATUSES = [
  "pending",
  "open",
  "completed",
  "cancelled",
] as const;
export type WooOrderStatus = (typeof WOO_ORDER_STATUSES)[number];

/** Design candidate union for `orders.payment_status`. */
export const WOO_PAYMENT_STATUSES = [
  "unpaid",
  "partially_paid",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
] as const;
export type WooPaymentStatus = (typeof WOO_PAYMENT_STATUSES)[number];

/** Design candidate union for `orders.fulfillment_status`. */
export const WOO_FULFILLMENT_STATUSES = [
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
  "cancelled",
] as const;
export type WooFulfillmentStatus = (typeof WOO_FULFILLMENT_STATUSES)[number];

/**
 * Provider payload retained verbatim for provenance (ADR-0009 #3), destined
 * for `provider_objects` — never for a domain column.
 *
 * **THIS VALUE CONTAINS PERSONAL DATA.** A WooCommerce order payload carries
 * `billing` and `shipping` objects (name, company, street address, city,
 * postcode, country, email, phone), plus `customer_ip_address` and
 * `customer_user_agent`. Do not log it, do not put it in a snapshot fixture,
 * do not include it in an error, and do not assert on it in a test that can
 * print a diff. Use {@link redactWooOrderFact} for anything that might be
 * displayed.
 */
export type WooRawOrderPayload = Readonly<Record<string, unknown>>;

export interface WooOrderTotals {
  /** Provider `total`. */
  total: string;
  /** DERIVED — exact sum of `line_items[].subtotal`; Woo reports no subtotal. */
  subtotal: string;
  /** Provider `shipping_total`. */
  shipping: string;
  /** Provider `total_tax`. */
  tax: string;
  /** Provider `discount_total`. */
  discount: string;
  /** DERIVED — exact sum of refund magnitudes (design: positive deduction). */
  refunded: string;
}

export interface WooOrderLineFact {
  /** `line_items[].id`, stable across re-syncs → design `external_line_id`. */
  externalLineId: string;
  /** 1-based position → design `order_lines.line_number`. */
  lineNumber: number;
  sku: string | null;
  name: string;
  /** `product_id`; Woo uses 0 for "no product" → null. */
  externalItemId: string | null;
  /** `variation_id`; 0 means "not a variation" → null. */
  externalVariationId: string | null;
  /** Decimal string — design stores quantity as `numeric(20,6)`. */
  quantity: string;
  /** From the float `price`; null when it cannot be represented exactly. */
  unitPrice: string | null;
  /** `subtotal` — before discounts. */
  lineSubtotal: string;
  /** `total` — after discounts → design `order_lines.line_total`. */
  lineTotal: string;
  /** `total_tax` → design `order_lines.tax_amount`. */
  lineTax: string;
  /** `subtotal_tax` — pre-discount tax; kept for reconciliation. */
  lineSubtotalTax: string;
  /** DERIVED — `subtotal - total`. */
  discount: string;
  taxClass: string | null;
}

/**
 * A WooCommerce `fee_line`.
 *
 * **NOT a design `order_fees` row in the marketplace sense.** The design's
 * `order_fees` are amounts the provider charges the SELLER (positive = a
 * deduction from proceeds: final value fees, payment processing, ad spend).
 * A Woo `fee_line` is the opposite: a surcharge the merchant adds to the
 * BUYER's cart (handling, small-order, COD, gift wrap), already included in
 * `orders.total`.
 *
 * WooCommerce core reports **no seller-side fees at all** — payment processor
 * charges live inside the gateway plugin, not on the order. Whoever writes the
 * ingestion service must decide whether these become `order_fees` rows with an
 * inverted sign, a separate charge concept, or nothing. This adapter reports
 * them faithfully and refuses to guess. See the report in the closeout notes.
 */
export interface WooFeeLineFact {
  /** `fee_lines[].id` → design `order_fees.external_fee_id`. */
  externalFeeId: string;
  name: string | null;
  /** `taxable` | `none`. */
  taxStatus: string | null;
  taxClass: string | null;
  /** `total`, verbatim decimal string. Positive = charged to the BUYER. */
  total: string;
  /** `total_tax`, verbatim decimal string. */
  totalTax: string;
}

/**
 * Summary reference to a refund, as embedded on the order
 * (`{id, reason, total}` — the full refund object needs
 * `GET /orders/<id>/refunds`, which this adapter does not call).
 */
export interface WooRefundRef {
  /** → design `order_refunds.external_refund_id`. */
  externalRefundId: string;
  reason: string | null;
  /** Positive magnitude — design: positive means money returned to the buyer. */
  amount: string;
  /** Verbatim provider string; WooCommerce prefixes a `-`. */
  providerTotal: string;
}

export interface WooOrderFact {
  /** `String(id)` → design `orders.external_order_id`. */
  externalOrderId: string;
  /** → design `orders.external_order_number`. */
  orderNumber: string | null;
  /** `woocommerce:<siteUrl>` → design `orders.source_account_key`. */
  sourceAccountKey: string;
  status: WooOrderStatus;
  paymentStatus: WooPaymentStatus;
  fulfillmentStatus: WooFulfillmentStatus;
  /** Woo's own status verbatim → design `orders.provider_status_raw`. */
  providerStatusRaw: string;
  /** False when Woo reported a status this adapter has no mapping for. */
  statusRecognized: boolean;
  currency: string;
  totals: WooOrderTotals;
  /** ISO-8601 UTC → design `orders.placed_at`. */
  placedAt: string;
  /** ISO-8601 UTC → design `orders.provider_updated_at` (sync watermark). */
  updatedAt: string | null;
  paidAt: string | null;
  completedAt: string | null;
  /** `String(customer_id)`; guests (`0`) → null. Channel-native reference only. */
  buyerExternalId: string | null;
  lineItems: WooOrderLineFact[];
  feeLines: WooFeeLineFact[];
  refunds: WooRefundRef[];
  /** Provenance payload. CONTAINS PERSONAL DATA — see {@link WooRawOrderPayload}. */
  raw: WooRawOrderPayload;
}

/* ------------------------------------------------------------ status table */

export interface WooStatusMapping {
  status: WooOrderStatus;
  paymentStatus: WooPaymentStatus;
  fulfillmentStatus: WooFulfillmentStatus;
}

/**
 * Woo's documented status vocabulary (`pending`, `processing`, `on-hold`,
 * `completed`, `cancelled`, `refunded`, `failed`, `trash`) plus
 * `checkout-draft`, the WooCommerce Blocks draft status that the docs omit.
 */
export const WOO_STATUS_MAP: Readonly<Record<string, WooStatusMapping>> = {
  pending: {
    status: "pending",
    paymentStatus: "unpaid",
    fulfillmentStatus: "unfulfilled",
  },
  "checkout-draft": {
    status: "pending",
    paymentStatus: "unpaid",
    fulfillmentStatus: "unfulfilled",
  },
  "on-hold": {
    status: "pending",
    paymentStatus: "unpaid",
    fulfillmentStatus: "unfulfilled",
  },
  processing: {
    // Woo sets `processing` only after payment is captured for physical goods.
    status: "open",
    paymentStatus: "paid",
    fulfillmentStatus: "unfulfilled",
  },
  completed: {
    status: "completed",
    paymentStatus: "paid",
    fulfillmentStatus: "fulfilled",
  },
  refunded: {
    // Fully refunded. Woo overwrote whatever came before, so shipment is
    // unknowable; the design's union has no `unknown`, so it degrades down.
    status: "completed",
    paymentStatus: "refunded",
    fulfillmentStatus: "unfulfilled",
  },
  cancelled: {
    status: "cancelled",
    paymentStatus: "unpaid",
    fulfillmentStatus: "cancelled",
  },
  failed: {
    // Payment failed or was declined — terminal, and never fulfilled.
    status: "cancelled",
    paymentStatus: "failed",
    fulfillmentStatus: "unfulfilled",
  },
  trash: {
    status: "cancelled",
    paymentStatus: "unpaid",
    fulfillmentStatus: "cancelled",
  },
};

/** Floor for statuses a plugin invented. `providerStatusRaw` keeps the truth. */
export const WOO_UNKNOWN_STATUS_MAPPING: WooStatusMapping = {
  status: "pending",
  paymentStatus: "unpaid",
  fulfillmentStatus: "unfulfilled",
};

/** Strip WooCommerce's internal `wc-` post-status prefix if a caller sends it. */
export function normalizeWooStatusSlug(value: string): string {
  return value.startsWith("wc-") ? value.slice(3) : value;
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

/**
 * WooCommerce's `*_gmt` fields are UTC instants serialized WITHOUT a zone
 * designator (`"2026-08-11T05:23:15"`, verified live). Parsing that with
 * `new Date()` yields LOCAL time, which silently shifts every timestamp by the
 * server's offset — so the `Z` is appended before parsing. A value that
 * already carries a zone is left alone.
 */
export function isoFromWooGmt(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const date = new Date(hasZone ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Woo uses integer 0 for "no id here" (guest customer, non-variation line). */
function externalIdOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value === 0 ? null : String(value);
  }
  const text = asText(value);
  if (text === null) return null;
  return text === "0" ? null : text;
}

function requiredId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return asText(value);
}

const ZERO = "0.00";

/* ---------------------------------------------------------------- mapping */

export interface MapWooOrderOptions {
  /** `woocommerce:<siteUrl>` — usually `adapter.sourceAccountKey`. */
  sourceAccountKey: string;
}

/** Pure mapping from a raw Woo order payload to the Loxep-owned fact. */
export function mapWooOrder(
  raw: Record<string, unknown>,
  options: MapWooOrderOptions,
): WooOrderFact {
  const externalOrderId = requiredId(raw["id"]);
  if (externalOrderId === null) {
    throw new WooAdapterError(
      "provider_unavailable",
      "WooCommerce order payload has no id; refusing to build an order fact",
    );
  }

  const providerStatusRaw = normalizeWooStatusSlug(
    asText(raw["status"]) ?? "",
  );
  const mapped = WOO_STATUS_MAP[providerStatusRaw];
  const statusRecognized = mapped !== undefined;
  const statuses = mapped ?? WOO_UNKNOWN_STATUS_MAPPING;

  const lineItems = asRecordArray(raw["line_items"]).map(
    (item, index): WooOrderLineFact => {
      const lineSubtotal = decimalFromProvider(item["subtotal"]) ?? ZERO;
      const lineTotal = decimalFromProvider(item["total"]) ?? ZERO;
      const quantity =
        decimalFromUnknown(item["quantity"]) ?? "1";
      return {
        externalLineId: requiredId(item["id"]) ?? `index:${index + 1}`,
        lineNumber: index + 1,
        sku: asText(item["sku"]),
        name: asText(item["name"]) ?? "",
        externalItemId: externalIdOrNull(item["product_id"]),
        externalVariationId: externalIdOrNull(item["variation_id"]),
        quantity,
        // The one float money field in the payload (see module doc).
        unitPrice:
          decimalFromNumber(item["price"]) ??
          decimalFromProvider(item["price"]),
        lineSubtotal,
        lineTotal,
        lineTax: decimalFromProvider(item["total_tax"]) ?? ZERO,
        lineSubtotalTax: decimalFromProvider(item["subtotal_tax"]) ?? ZERO,
        discount: subtractDecimals(lineSubtotal, lineTotal),
        taxClass: asText(item["tax_class"]),
      };
    },
  );

  const feeLines = asRecordArray(raw["fee_lines"]).map(
    (fee, index): WooFeeLineFact => ({
      externalFeeId: requiredId(fee["id"]) ?? `index:${index + 1}`,
      name: asText(fee["name"]),
      taxStatus: asText(fee["tax_status"]),
      taxClass: asText(fee["tax_class"]),
      total: decimalFromProvider(fee["total"]) ?? ZERO,
      totalTax: decimalFromProvider(fee["total_tax"]) ?? ZERO,
    }),
  );

  const refunds = asRecordArray(raw["refunds"]).map(
    (refund, index): WooRefundRef => {
      const providerTotal = decimalFromUnknown(refund["total"]) ?? ZERO;
      return {
        externalRefundId: requiredId(refund["id"]) ?? `index:${index + 1}`,
        reason: asText(refund["reason"]),
        amount: absDecimal(providerTotal),
        providerTotal,
      };
    },
  );

  const placedAt =
    isoFromWooGmt(raw["date_created_gmt"]) ?? isoFromWooGmt(raw["date_created"]);
  if (placedAt === null) {
    throw new WooAdapterError(
      "provider_unavailable",
      "WooCommerce order payload has no usable creation date",
      { externalOrderId },
    );
  }

  const refundedTotal = sumDecimals(
    refunds.map((refund) => refund.amount),
    ZERO,
  );
  // `partially_refunded` is not a Woo status: it exists only as "this order
  // has refunds but Woo has not flipped it to `refunded`".
  const paymentStatus: WooPaymentStatus =
    statuses.paymentStatus !== "refunded" &&
    refunds.length > 0 &&
    !isZeroDecimal(refundedTotal)
      ? "partially_refunded"
      : statuses.paymentStatus;

  return {
    externalOrderId,
    orderNumber: asText(raw["number"]) ?? requiredId(raw["number"]),
    sourceAccountKey: options.sourceAccountKey,
    status: statuses.status,
    paymentStatus,
    fulfillmentStatus: statuses.fulfillmentStatus,
    providerStatusRaw,
    statusRecognized,
    currency: asText(raw["currency"]) ?? "",
    totals: {
      total: decimalFromProvider(raw["total"]) ?? ZERO,
      subtotal: sumDecimals(
        lineItems.map((line) => line.lineSubtotal),
        ZERO,
      ),
      shipping: decimalFromProvider(raw["shipping_total"]) ?? ZERO,
      tax: decimalFromProvider(raw["total_tax"]) ?? ZERO,
      discount: decimalFromProvider(raw["discount_total"]) ?? ZERO,
      refunded: refundedTotal,
    },
    placedAt,
    updatedAt: isoFromWooGmt(raw["date_modified_gmt"]),
    paidAt: isoFromWooGmt(raw["date_paid_gmt"]),
    completedAt: isoFromWooGmt(raw["date_completed_gmt"]),
    buyerExternalId: externalIdOrNull(raw["customer_id"]),
    lineItems,
    feeLines,
    refunds,
    raw,
  };
}

/**
 * Everything about an order fact EXCEPT `raw`. Use this for logging, health
 * surfaces, and any test output that could be printed — it is the difference
 * between a diff that shows order totals and one that shows a customer's home
 * address.
 */
export function redactWooOrderFact(
  fact: WooOrderFact,
): Omit<WooOrderFact, "raw"> & { raw: "[redacted]" } {
  const { raw: _raw, ...rest } = fact;
  return { ...rest, raw: "[redacted]" };
}

/* ---------------------------------------------------------------- fetching */

export interface FetchWooOrdersInput {
  /**
   * Incremental-sync watermark → `modified_after` + `dates_are_gmt=true`
   * (verified live: a `Z`-suffixed ISO instant filters on `date_modified_gmt`).
   * NOTE: WordPress's date query is EXCLUSIVE, so an order modified at exactly
   * this instant is not returned — pass the last seen watermark, not
   * watermark+1ms.
   */
  modifiedAfter?: Date | string;
  /** `after` — filters on creation date. */
  placedAfter?: Date | string;
  /** 1-based. Default 1. */
  page?: number;
  /** Default 20; WooCommerce caps at 100. */
  perPage?: number;
  /**
   * Woo-native status slugs, or `"any"`. Default `"any"` — ingestion must see
   * cancellations and failures, not only the happy path.
   */
  status?: string | readonly string[];
  /** `date` | `modified` | `id` | `include` | `title` | `slug`. */
  orderBy?: string;
  order?: "asc" | "desc";
}

export interface WooOrderPage {
  orders: WooOrderFact[];
  page: {
    page: number;
    perPage: number;
    total: number | null;
    totalPages: number | null;
    hasNextPage: boolean;
  };
}

function toIsoInstant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new WooAdapterError(
      "invalid_request",
      "WooCommerce date filter is not a valid instant",
    );
  }
  return date.toISOString();
}

export function buildWooOrdersQuery(input: FetchWooOrdersInput = {}): WooQuery {
  const perPage = Math.min(
    Math.max(1, input.perPage ?? WOO_DEFAULT_PER_PAGE),
    WOO_MAX_PER_PAGE,
  );
  const status = input.status ?? "any";
  const query: Record<string, string | number | readonly string[]> = {
    page: Math.max(1, input.page ?? 1),
    per_page: perPage,
    // Walking a watermark wants ascending modification order; a plain listing
    // wants newest first.
    orderby: input.orderBy ?? (input.modifiedAfter !== undefined ? "modified" : "date"),
    order: input.order ?? (input.modifiedAfter !== undefined ? "asc" : "desc"),
    status: Array.isArray(status)
      ? (status as readonly string[]).map(normalizeWooStatusSlug)
      : normalizeWooStatusSlug(status as string),
  };
  if (input.modifiedAfter !== undefined) {
    query["modified_after"] = toIsoInstant(input.modifiedAfter);
    query["dates_are_gmt"] = "true";
  }
  if (input.placedAfter !== undefined) {
    query["after"] = toIsoInstant(input.placedAfter);
    query["dates_are_gmt"] = "true";
  }
  return query;
}

/** One page of orders plus the pagination headers. */
export async function fetchOrdersPage(
  adapter: WooAdapter,
  input: FetchWooOrdersInput = {},
): Promise<WooOrderPage> {
  const result = await adapter.list("/orders", buildWooOrdersQuery(input), {
    operation: "orders.list",
  });
  return {
    orders: result.items.map((item) =>
      mapWooOrder(item, { sourceAccountKey: adapter.sourceAccountKey }),
    ),
    page: result.page,
  };
}

/** One page of normalized orders. */
export async function fetchOrders(
  adapter: WooAdapter,
  input: FetchWooOrdersInput = {},
): Promise<WooOrderFact[]> {
  return (await fetchOrdersPage(adapter, input)).orders;
}

/**
 * Walk every page of orders matching the filter, using the adapter's
 * header-driven pagination. Yields one page of facts at a time so a caller
 * can persist incrementally rather than buffering a whole backfill.
 */
export async function* iterateWooOrders(
  adapter: WooAdapter,
  input: FetchWooOrdersInput = {},
  options: { maxPages?: number } = {},
): AsyncGenerator<WooOrderPage, void, undefined> {
  const { page: _page, perPage, ...filter } = input;
  const query = buildWooOrdersQuery({ ...filter, perPage });
  const { page: _p, per_page: _pp, ...rest } = query as Record<string, unknown>;
  for await (const result of adapter.paginate("/orders", {
    query: rest as WooQuery,
    perPage: perPage ?? WOO_DEFAULT_PER_PAGE,
    startPage: input.page ?? 1,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  })) {
    yield {
      orders: result.items.map((item) =>
        mapWooOrder(item, { sourceAccountKey: adapter.sourceAccountKey }),
      ),
      page: result.page,
    };
  }
}
