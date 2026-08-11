/**
 * Product read adapter: WooCommerce REST v3 `/products` normalized into a
 * deliberately MINIMAL Loxep-owned fact.
 *
 * Scope discipline: Phase 3's `catalog_items` / `channel_listings` matcher is
 * a later child issue, and the Commerce Schema Design is explicit that a
 * WooCommerce product page "is not a marketplace listing in the intelligence
 * sense" — so this returns only what a future channel-listing linkage needs
 * to resolve identity (`external_listing_id`, `channel_sku`, title, status,
 * price) and nothing else. Stock, categories, images, attributes, and
 * variations are recoverable from `raw` when someone actually needs them.
 *
 * Field sources (docs + live WooCommerce 10.9.3):
 *
 * ```text
 * externalProductId ← String(id)
 * sku               ← sku                 "" → null
 * name              ← name
 * status            ← status              draft | pending | private | publish
 * price             ← price               decimal STRING here (unlike order
 *                                         line_items[].price, which is a float)
 * type              ← type                simple | grouped | external | variable
 * permalink         ← permalink
 * updatedAt         ← date_modified_gmt   (+"Z")
 * ```
 *
 * Unlike orders, a product payload carries no personal data, so `raw` here is
 * safe to log — it is still marked as provenance-only because provider shapes
 * must not become domain types (ADR-0009 #5).
 */
import type { WooAdapter, WooQuery } from "./adapter.ts";
import { WOO_DEFAULT_PER_PAGE, WOO_MAX_PER_PAGE } from "./adapter.ts";
import { WooAdapterError } from "./errors.ts";
import { decimalFromUnknown } from "./money.ts";
import { isoFromWooGmt } from "./orders.ts";

/** Provider payload retained for provenance. No personal data, unlike orders. */
export type WooRawProductPayload = Readonly<Record<string, unknown>>;

/** WordPress post statuses WooCommerce documents for products. */
export const WOO_PRODUCT_STATUSES = [
  "draft",
  "pending",
  "private",
  "publish",
] as const;
export type WooProductStatus = (typeof WOO_PRODUCT_STATUSES)[number];

export interface WooProductFact {
  /** `String(id)` → future `channel_listings.external_listing_id`. */
  externalProductId: string;
  /** → future `order_lines.channel_sku` / `catalog_items.sku` matcher input. */
  sku: string | null;
  name: string;
  /**
   * Provider status verbatim. Typed as the documented union widened with
   * `string`, because WordPress post statuses are plugin-extensible and this
   * package must not fail on one it has not seen.
   */
  status: WooProductStatus | string;
  /** Decimal string; null when absent (variable parents report `""`). */
  price: string | null;
  /** `simple` | `grouped` | `external` | `variable`, or a plugin's own. */
  type: string | null;
  permalink: string | null;
  updatedAt: string | null;
  raw: WooRawProductPayload;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Pure mapping from a raw Woo product payload to the Loxep-owned fact. */
export function mapWooProduct(
  raw: Record<string, unknown>,
): WooProductFact {
  const id = raw["id"];
  const externalProductId =
    typeof id === "number" && Number.isSafeInteger(id)
      ? String(id)
      : asText(id);
  if (externalProductId === null) {
    throw new WooAdapterError(
      "provider_unavailable",
      "WooCommerce product payload has no id; refusing to build a product fact",
    );
  }
  return {
    externalProductId,
    sku: asText(raw["sku"]),
    name: asText(raw["name"]) ?? "",
    status: asText(raw["status"]) ?? "",
    price: decimalFromUnknown(raw["price"]),
    type: asText(raw["type"]),
    permalink: asText(raw["permalink"]),
    updatedAt: isoFromWooGmt(raw["date_modified_gmt"]),
    raw,
  };
}

export interface FetchWooProductsInput {
  /** `modified_after` + `dates_are_gmt=true`; WordPress date queries are exclusive. */
  modifiedAfter?: Date | string;
  page?: number;
  perPage?: number;
  /** `any` or a WordPress post status. Default `any`. */
  status?: string;
  /** Exact SKU lookup — the cheapest channel-listing resolution path. */
  sku?: string;
  search?: string;
  orderBy?: string;
  order?: "asc" | "desc";
}

export interface WooProductPage {
  products: WooProductFact[];
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

export function buildWooProductsQuery(
  input: FetchWooProductsInput = {},
): WooQuery {
  const perPage = Math.min(
    Math.max(1, input.perPage ?? WOO_DEFAULT_PER_PAGE),
    WOO_MAX_PER_PAGE,
  );
  const query: Record<string, string | number> = {
    page: Math.max(1, input.page ?? 1),
    per_page: perPage,
    status: input.status ?? "any",
    orderby: input.orderBy ?? "date",
    order: input.order ?? "desc",
  };
  if (input.sku !== undefined) query["sku"] = input.sku;
  if (input.search !== undefined) query["search"] = input.search;
  if (input.modifiedAfter !== undefined) {
    query["modified_after"] = toIsoInstant(input.modifiedAfter);
    query["dates_are_gmt"] = "true";
  }
  return query;
}

/** One page of products plus the pagination headers. */
export async function fetchProductsPage(
  adapter: WooAdapter,
  input: FetchWooProductsInput = {},
): Promise<WooProductPage> {
  const result = await adapter.list("/products", buildWooProductsQuery(input), {
    operation: "products.list",
  });
  return { products: result.items.map(mapWooProduct), page: result.page };
}

/** One page of normalized products. */
export async function fetchProducts(
  adapter: WooAdapter,
  input: FetchWooProductsInput = {},
): Promise<WooProductFact[]> {
  return (await fetchProductsPage(adapter, input)).products;
}

/** Walk every page of products matching the filter. */
export async function* iterateWooProducts(
  adapter: WooAdapter,
  input: FetchWooProductsInput = {},
  options: { maxPages?: number } = {},
): AsyncGenerator<WooProductPage, void, undefined> {
  const { page: _page, perPage, ...filter } = input;
  const query = buildWooProductsQuery({ ...filter, perPage });
  const { page: _p, per_page: _pp, ...rest } = query as Record<string, unknown>;
  for await (const result of adapter.paginate("/products", {
    query: rest as WooQuery,
    perPage: perPage ?? WOO_DEFAULT_PER_PAGE,
    startPage: input.page ?? 1,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  })) {
    yield { products: result.items.map(mapWooProduct), page: result.page };
  }
}
