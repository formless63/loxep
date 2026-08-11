/**
 * Product read adapter: Medusa v2 Admin API `/admin/products` normalized
 * into a deliberately MINIMAL Loxep-owned fact, matching the scope
 * discipline of `packages/integrations/woo/src/products.ts` — Phase 3's
 * `catalog_items` / `channel_listings` matcher is a later child issue.
 *
 * NO LIVE MEDUSA INSTANCE EXISTS IN THIS ENVIRONMENT — see `orders.ts` and
 * the module doc for the verification trail and the follow-up bead.
 *
 * ## A structurally different shape from WooCommerce, and why
 *
 * A WooCommerce product (simple, non-variable) has ONE sku and ONE price. A
 * Medusa product ALWAYS has one or more VARIANTS, and each variant carries
 * its OWN sku and a LIST of prices — one per currency/region a price has
 * been set for
 * (https://github.com/medusajs/medusa/blob/develop/packages/core/types/src/pricing/common/price.ts:
 * `PriceDTO { id, currency_code, amount }`). There is no single "the price"
 * at the product level the way WooCommerce's `price` field is. Forcing a
 * single top-level `price`/`sku` onto `MedusaProductFact` the way
 * `WooProductFact` does would either pick an arbitrary variant/currency or
 * silently drop every variant but the first — this adapter instead reports
 * `variants[]` faithfully, matching what a future channel-listing matcher
 * actually needs (Medusa's channel-listing identity resolves at the VARIANT
 * level via `variant.sku`, analogous to a WooCommerce simple product or one
 * of its variations).
 *
 * ## Field sources
 *
 * ```text
 * externalProductId  ← id
 * title              ← title
 * status             ← status              draft | proposed | published | rejected
 *                                          (verified: product/common.ts)
 * handle             ← handle
 * thumbnail          ← thumbnail
 * updatedAt          ← updated_at          ordinary ISO instant, no zone
 *                                          workaround needed (see orders.ts)
 * variants[].sku      ← variants[].sku
 * variants[].title    ← variants[].title
 * variants[].prices[] ← variants[].prices[] {currency_code, amount}
 * ```
 *
 * Unlike a WooCommerce order payload, neither a Medusa product nor its
 * variants carry personal data, so `raw` here is safe to log — it is still
 * marked as provenance-only because provider shapes must not become domain
 * types (ADR-0009 #5).
 *
 * ## Fields default to Medusa's own — the opposite of orders.ts
 *
 * Medusa's own product LIST default already includes `*variants` and
 * `*variants.prices`
 * (https://github.com/medusajs/medusa/blob/develop/packages/medusa/src/api/admin/products/query-config.ts,
 * `defaultAdminProductFields`), unlike the narrow order-list default. This
 * adapter therefore does NOT override `fields` by default for products —
 * only `fetchOrders` needs the explicit override documented in `orders.ts`.
 */
import type { MedusaAdapter, MedusaQuery } from "./adapter.ts";
import { MEDUSA_DEFAULT_LIMIT, MEDUSA_MAX_LIMIT } from "./adapter.ts";
import { MedusaAdapterError } from "./errors.ts";
import { decimalFromUnknown, normalizeMedusaCurrencyCode } from "./money.ts";
import { isoFromMedusa } from "./orders.ts";

/** Provider payload retained for provenance. No personal data, unlike orders. */
export type MedusaRawProductPayload = Readonly<Record<string, unknown>>;

/** Verified: `product/common.ts` — `export type ProductStatus`. */
export const MEDUSA_PRODUCT_STATUSES = [
  "draft",
  "proposed",
  "published",
  "rejected",
] as const;
export type MedusaProductStatus = (typeof MEDUSA_PRODUCT_STATUSES)[number];

export interface MedusaVariantPriceFact {
  /** Uppercased ISO 4217. */
  currencyCode: string;
  /** Decimal string — see money.ts for the major-unit/precision discussion. */
  amount: string;
}

export interface MedusaProductVariantFact {
  /** `variants[].id` → future `channel_listings.external_variation_id`. */
  externalVariantId: string;
  /** → future `order_lines.channel_sku` / `catalog_items.sku` matcher input. */
  sku: string | null;
  title: string | null;
  prices: MedusaVariantPriceFact[];
}

export interface MedusaProductFact {
  /** `id` → future `channel_listings.external_listing_id`. */
  externalProductId: string;
  title: string;
  /**
   * Provider status verbatim. Typed as the documented union widened with
   * `string` in case a future Medusa release adds a value this package has
   * not seen — same defensive typing as `WooProductFact.status`.
   */
  status: MedusaProductStatus | string;
  handle: string | null;
  thumbnail: string | null;
  variants: MedusaProductVariantFact[];
  updatedAt: string | null;
  raw: MedusaRawProductPayload;
}

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

function mapVariant(raw: Record<string, unknown>): MedusaProductVariantFact {
  return {
    externalVariantId: asText(raw["id"]) ?? "",
    sku: asText(raw["sku"]),
    title: asText(raw["title"]),
    prices: asRecordArray(raw["prices"]).map(
      (price): MedusaVariantPriceFact => ({
        currencyCode: normalizeMedusaCurrencyCode(price["currency_code"]),
        amount: decimalFromUnknown(price["amount"]) ?? "0.00",
      }),
    ),
  };
}

/** Pure mapping from a raw Medusa product payload to the Loxep-owned fact. */
export function mapMedusaProduct(
  raw: Record<string, unknown>,
): MedusaProductFact {
  const externalProductId = asText(raw["id"]);
  if (externalProductId === null) {
    throw new MedusaAdapterError(
      "provider_unavailable",
      "Medusa product payload has no id; refusing to build a product fact",
    );
  }
  return {
    externalProductId,
    title: asText(raw["title"]) ?? "",
    status: asText(raw["status"]) ?? "",
    handle: asText(raw["handle"]),
    thumbnail: asText(raw["thumbnail"]),
    variants: asRecordArray(raw["variants"]).map(mapVariant),
    updatedAt: isoFromMedusa(raw["updated_at"]),
    raw,
  };
}

export interface FetchMedusaProductsInput {
  updatedAfter?: Date | string;
  offset?: number;
  limit?: number;
  status?: string | readonly string[];
  /** Exact SKU lookup — the cheapest channel-listing resolution path. */
  q?: string;
  /** Comma-separated Medusa `fields` string. Defaults to Medusa's own list default. */
  fields?: string;
  order?: string;
}

export interface MedusaProductPage {
  products: MedusaProductFact[];
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

export function buildMedusaProductsQuery(
  input: FetchMedusaProductsInput = {},
): MedusaQuery {
  const limit = Math.min(
    Math.max(1, input.limit ?? MEDUSA_DEFAULT_LIMIT),
    MEDUSA_MAX_LIMIT,
  );
  const query: Record<string, string | number | readonly string[]> = {
    offset: Math.max(0, input.offset ?? 0),
    limit,
    order: input.order ?? "-created_at",
  };
  if (input.fields !== undefined) query["fields"] = input.fields;
  if (input.status !== undefined) query["status"] = input.status;
  if (input.q !== undefined) query["q"] = input.q;
  if (input.updatedAfter !== undefined) {
    query["updated_at[$gte]"] = toIsoInstant(input.updatedAfter);
  }
  return query;
}

/** One page of products plus the pagination info. */
export async function fetchProductsPage(
  adapter: MedusaAdapter,
  input: FetchMedusaProductsInput = {},
): Promise<MedusaProductPage> {
  const result = await adapter.list(
    "/products",
    "products",
    buildMedusaProductsQuery(input),
    { operation: "products.list" },
  );
  return {
    products: result.items.map(mapMedusaProduct),
    page: {
      offset: result.page.offset,
      limit: result.page.limit,
      count: result.page.count,
      hasNextPage: result.page.hasNextPage,
    },
  };
}

/** One page of normalized products. */
export async function fetchProducts(
  adapter: MedusaAdapter,
  input: FetchMedusaProductsInput = {},
): Promise<MedusaProductFact[]> {
  return (await fetchProductsPage(adapter, input)).products;
}

/** Walk every page of products matching the filter. */
export async function* iterateMedusaProducts(
  adapter: MedusaAdapter,
  input: FetchMedusaProductsInput = {},
  options: { maxPages?: number } = {},
): AsyncGenerator<MedusaProductPage, void, undefined> {
  const { offset: _offset, limit, ...filter } = input;
  const query = buildMedusaProductsQuery({ ...filter, limit });
  const { offset: _o, limit: _l, ...rest } = query as Record<string, unknown>;
  for await (const result of adapter.paginate("/products", "products", {
    query: rest as MedusaQuery,
    limit: limit ?? MEDUSA_DEFAULT_LIMIT,
    startOffset: input.offset ?? 0,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  })) {
    yield {
      products: result.items.map(mapMedusaProduct),
      page: {
        offset: result.page.offset,
        limit: result.page.limit,
        count: result.page.count,
        hasNextPage: result.page.hasNextPage,
      },
    };
  }
}
