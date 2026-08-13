/**
 * Etsy adapter (loxep-g4t.1): a thin Loxep-owned boundary over Etsy Open API
 * v3, implemented on native `fetch` with no client dependency (ADR-0009) —
 * Etsy publishes an OpenAPI spec but has no first-party maintained Node/
 * TypeScript SDK, so this mirrors the choice already made for WooCommerce,
 * Medusa, and Invoice Ninja rather than adopting eBay's `ebay-api` pattern.
 *
 * ENDPOINTS AND HEADERS — SOURCE-VERIFIED against `anitabyte/etsyv3`
 * (`main` branch, fetched 2026-08-13, `etsyv3/etsy_api.py`):
 *
 * ```text
 * base           https://api.etsy.com/v3/application
 * public auth    x-api-key: <keystring>:<sharedSecret>            (every call)
 * private auth   Authorization: Bearer <userId>.<accessToken>     (adds to public)
 *
 * ping                                    GET  /openapi-ping
 * get listing                             GET  /listings/{listing_id}
 * get shop                                GET  /shops/{shop_id}
 * shop's ACTIVE listings (public)         GET  /shops/{shop_id}/listings/active
 * shop's listings, any state (PRIVATE)    GET  /shops/{shop_id}/listings
 * ```
 *
 * `find_all_active_listings_by_shop`/`get_listing`/`get_shop`/`ping` and the
 * base URL are exactly as declared in that file; the private
 * `get_listings_by_shop` additionally accepts a `state` filter (`active`,
 * `inactive`, `draft`, `expired`, `sold_out`) — the design's documented
 * reason `etsy_shop`'s 'shop' consent tier exists: public auth only ever
 * sees `active`.
 *
 * Boundary rules enforced by this module, matching every sibling adapter:
 * - provider payloads cross as `Record<string, unknown>`; no provider type
 *   is exported;
 * - every request acquires from the injected {@link RateBudget} BEFORE
 *   touching the network — and that budget is SHARED PER APPLICATION (see
 *   `rate-budget.ts`'s module doc), never created privately per adapter
 *   instance the way eBay's per-connection default is;
 * - every failure is normalized to {@link EtsyAdapterError} with
 *   credential-free `detail`;
 * - the keyset and any bearer token live in a closure and are never
 *   re-exposed, logged, or echoed in an error.
 */
import {
  ETSY_API_BASE_URL,
  parseEtsyAdapterConfig,
  type EtsyAdapterConfig,
  type EtsyAdapterConfigInput,
} from "./config.ts";
import {
  EtsyAdapterError,
  etsyErrorFromResponse,
  normalizeEtsyError,
  type EtsyErrorContext,
} from "./errors.ts";
import type { RateBudget, RateBudgetStats } from "./rate-budget.ts";
import { providerBearerToken, type EtsyUserTokenBundle } from "./tokens.ts";

export type EtsySortOn = "created" | "price" | "updated" | "score";
export type EtsySortOrder = "asc" | "ascending" | "desc" | "descending" | "up" | "down";

export type EtsyQueryValue = string | number | boolean | undefined | null;
export type EtsyQuery = Readonly<Record<string, EtsyQueryValue>>;

export interface EtsyListPage {
  /** Object entries of `results[]`; non-objects are dropped. */
  results: Array<Record<string, unknown>>;
  /** Etsy's reported total match count (may exceed `results.length`). */
  count: number | null;
}

export interface EtsyAdapterStats {
  rateBudget: RateBudgetStats;
  /** Requests that reached the network (successful or not). */
  requests: number;
}

export interface GetShopListingsActiveInput {
  shopId: string;
  limit?: number;
  offset?: number;
  keywords?: string;
  sortOn?: EtsySortOn;
  sortOrder?: EtsySortOrder;
}

export interface GetShopListingsInput extends GetShopListingsActiveInput {
  state?: "active" | "inactive" | "draft" | "expired" | "sold_out";
}

/** Public-auth operations — available from either adapter shape. */
interface EtsyPublicOperations {
  /** `GET /openapi-ping` — the cheapest call this adapter has a shape for. */
  ping(): Promise<{ applicationId: number | null }>;
  /** `GET /listings/{listing_id}` — a single listing's public detail. */
  getListing(listingId: string): Promise<Record<string, unknown>>;
  /** `GET /shops/{shop_id}` — a shop's public profile. */
  getShop(shopId: string): Promise<Record<string, unknown>>;
  /** `GET /shops/{shop_id}/listings/active` — public, active listings only. */
  getShopListingsActive(input: GetShopListingsActiveInput): Promise<EtsyListPage>;
}

export interface EtsyAdapter extends EtsyPublicOperations {
  /** Bind a user's OAuth token bundle, returning a private-auth adapter. */
  withUserToken(bundle: EtsyUserTokenBundle): EtsyUserAdapter;
  stats(): EtsyAdapterStats;
}

export interface EtsyUserAdapter extends EtsyPublicOperations {
  /**
   * `GET /shops/{shop_id}/listings` — private auth, any listing state
   * (`state` narrows it; omitted returns every state Etsy will show this
   * token). Requires the 'shop' consent tier (`shops_r`, `listings_r`).
   */
  getShopListings(input: GetShopListingsInput): Promise<EtsyListPage>;
}

export type EtsyFetch = (input: string, init: RequestInit) => Promise<Response>;

export type CreateEtsyAdapterInput = EtsyAdapterConfigInput & {
  /**
   * Test seam only. Production code leaves this undefined and the adapter
   * uses the runtime's native `fetch`.
   */
  fetchImpl?: EtsyFetch;
};

function buildQuery(query: EtsyQuery | undefined): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const serialized = params.toString();
  return serialized === "" ? "" : `?${serialized}`;
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

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const activeListingsQuery = (input: GetShopListingsActiveInput): EtsyQuery => ({
  limit: input.limit,
  offset: input.offset,
  keywords: input.keywords,
  sort_on: input.sortOn,
  sort_order: input.sortOrder,
});

export function createEtsyAdapter(input: CreateEtsyAdapterInput): EtsyAdapter {
  const { logger, rateBudget, fetchImpl, ...rest } = input;
  const config: EtsyAdapterConfig = parseEtsyAdapterConfig(rest);
  const doFetch: EtsyFetch = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  let requests = 0;

  const request = async (
    path: string,
    query: EtsyQuery | undefined,
    operation: string,
    authorization: string | undefined,
  ): Promise<unknown> => {
    if (!path.startsWith("/")) {
      throw new EtsyAdapterError(
        "invalid_request",
        "Etsy request path must start with '/'",
        { operation },
      );
    }
    const apiPath = path;
    const context: EtsyErrorContext = { operation, path: apiPath };

    await rateBudget.acquire(1);

    let response: Response;
    try {
      requests += 1;
      response = await doFetch(`${ETSY_API_BASE_URL}${path}${buildQuery(query)}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-api-key": `${config.keystring}:${config.sharedSecret}`,
          ...(authorization !== undefined ? { authorization } : {}),
          "user-agent": "loxep-etsy-adapter",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const normalized = normalizeEtsyError(error, context);
      logger?.warn?.(
        { operation, kind: normalized.kind, path: apiPath },
        "Etsy request failed",
      );
      throw normalized;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const looksJson = contentType.toLowerCase().includes("json");
    let responseBody: unknown = null;
    let parseFailed = false;
    if (looksJson) {
      try {
        responseBody = await response.json();
      } catch {
        parseFailed = true;
      }
    } else {
      // Drain without retaining: a reverse-proxy/WAF error page is HTML that
      // must never be copied into an error or a log line.
      await response.text().catch(() => "");
    }

    if (!response.ok) {
      const normalized = etsyErrorFromResponse(
        response.status,
        parseFailed ? null : responseBody,
        context,
        response.headers.get("retry-after"),
      );
      logger?.warn?.(
        { operation, kind: normalized.kind, path: apiPath, httpStatus: response.status },
        "Etsy API call failed",
      );
      throw normalized;
    }

    if (!looksJson || parseFailed) {
      throw new EtsyAdapterError(
        "provider_unavailable",
        "Etsy returned a non-JSON body for a successful status",
        {
          operation,
          path: apiPath,
          httpStatus: response.status,
          contentType: contentType.split(";")[0] ?? "",
        },
      );
    }
    return responseBody;
  };

  const getObject = async (
    path: string,
    operation: string,
    authorization: string | undefined,
  ): Promise<Record<string, unknown>> => {
    const body = await request(path, undefined, operation, authorization);
    const record = asRecord(body);
    if (record === null) {
      throw new EtsyAdapterError(
        "provider_unavailable",
        "Etsy endpoint did not return a JSON object",
        { operation, path },
      );
    }
    return record;
  };

  const listPage = async (
    path: string,
    query: EtsyQuery,
    operation: string,
    authorization: string | undefined,
  ): Promise<EtsyListPage> => {
    const body = await request(path, query, operation, authorization);
    const record = asRecord(body);
    if (record === null || !Array.isArray(record["results"])) {
      throw new EtsyAdapterError(
        "provider_unavailable",
        "Etsy collection endpoint did not return a {count, results: [...]} envelope",
        { operation, path },
      );
    }
    return {
      results: asRecordArray(record["results"]),
      count: asNumberOrNull(record["count"]),
    };
  };

  function publicOperations(authorization: string | undefined): EtsyPublicOperations {
    return {
      async ping() {
        const body = await getObject("/openapi-ping", "ping", authorization);
        return { applicationId: asNumberOrNull(body["application_id"]) };
      },
      async getListing(listingId) {
        if (listingId.trim() === "") {
          throw new EtsyAdapterError("invalid_request", "listingId is required");
        }
        return getObject(`/listings/${listingId}`, "listings.get", authorization);
      },
      async getShop(shopId) {
        if (shopId.trim() === "") {
          throw new EtsyAdapterError("invalid_request", "shopId is required");
        }
        return getObject(`/shops/${shopId}`, "shops.get", authorization);
      },
      async getShopListingsActive(listingsInput) {
        if (listingsInput.shopId.trim() === "") {
          throw new EtsyAdapterError("invalid_request", "shopId is required");
        }
        return listPage(
          `/shops/${listingsInput.shopId}/listings/active`,
          activeListingsQuery(listingsInput),
          "shops.listingsActive",
          authorization,
        );
      },
    };
  }

  const stats = (): EtsyAdapterStats => ({
    rateBudget: rateBudget.stats(),
    requests,
  });

  const adapter: EtsyAdapter = {
    ...publicOperations(undefined),

    withUserToken(bundle) {
      const authorization = `Bearer ${providerBearerToken(bundle)}`;
      return {
        ...publicOperations(authorization),
        async getShopListings(listingsInput) {
          if (listingsInput.shopId.trim() === "") {
            throw new EtsyAdapterError("invalid_request", "shopId is required");
          }
          return listPage(
            `/shops/${listingsInput.shopId}/listings`,
            { ...activeListingsQuery(listingsInput), state: listingsInput.state },
            "shops.listings",
            authorization,
          );
        },
      };
    },

    stats,
  };

  return adapter;
}
