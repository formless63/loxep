/**
 * WooCommerce adapter (loxep-xh9.3): a Loxep-owned boundary over the
 * WooCommerce REST API v3, implemented on **native `fetch`** with no client
 * dependency (ADR-0009).
 *
 * Why no library: the protocol work a client would save is (a) base64 Basic
 * Auth, (b) query-string building, (c) reading two response headers. That is
 * ~40 lines. The official `@woocommerce/woocommerce-rest-api` is an axios
 * wrapper whose main value is the OAuth 1.0a one-legged signer for
 * plain-HTTP stores — exactly the mode this package refuses to support (see
 * `config.ts`). Adding axios to buy a signer we will not call is a poor trade.
 *
 * Verified against the current WooCommerce REST API docs and a live
 * WooCommerce 10.9.3 / WordPress 6.9.6 store:
 *
 * - base path `<site>/wp-json/wc/v3`; the namespace index `GET /wp-json/wc/v3`
 *   answers with `{namespace, routes, _links}` for a read-only key pair;
 * - authentication over HTTPS is HTTP Basic Auth, consumer key as username and
 *   consumer secret as password;
 * - collection responses carry `X-WP-Total` and `X-WP-TotalPages` headers plus
 *   a `Link` header with `rel="next"` / `rel="prev"` / `rel="first"` /
 *   `rel="last"`; `page` is 1-based and `per_page` is capped at 100
 *   (HTTP 400 `rest_invalid_param` beyond it);
 * - errors are `{code, message, data:{status}}`.
 *
 * Boundary rules enforced here:
 * - credentials go into an `Authorization` header ONLY. They are never placed
 *   in a URL or query string, so no error, log field, or thrown value
 *   reachable from this module can structurally contain them;
 * - every request acquires from the per-connection {@link RateBudget} BEFORE
 *   touching the network;
 * - every failure is normalized to {@link WooAdapterError} with
 *   credential-free `detail`;
 * - responses cross this boundary as `Record<string, unknown>`; provider
 *   shapes are normalized into Loxep-owned types by `orders.ts` / `products.ts`.
 */
import {
  parseWooAdapterConfig,
  wooSourceAccountKey,
  type WooAdapterConfig,
  type WooAdapterConfigInput,
} from "./config.ts";
import {
  isPageOutOfRangeCode,
  normalizeWooError,
  readWooErrorBody,
  WooAdapterError,
  wooErrorFromResponse,
  type WooErrorContext,
} from "./errors.ts";
import {
  createRateBudget,
  type RateBudget,
  type RateBudgetStats,
  type WooAdapterLogger,
} from "./rate-budget.ts";

/** Query values the adapter knows how to serialize. */
export type WooQueryValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number>
  | undefined
  | null;

export type WooQuery = Readonly<Record<string, WooQueryValue>>;

export interface WooPageInfo {
  /** 1-based page actually requested. */
  page: number;
  perPage: number;
  /** `X-WP-Total`, or null when the endpoint sends no totals. */
  total: number | null;
  /** `X-WP-TotalPages`, or null when the endpoint sends no totals. */
  totalPages: number | null;
  /** True when a `Link` `rel="next"` exists or `page < totalPages`. */
  hasNextPage: boolean;
}

export interface WooResponse {
  /** Parsed JSON body — provider-shaped, deliberately untyped. */
  data: unknown;
  page: WooPageInfo;
}

export interface WooListPage {
  /** Object entries of a collection response; non-objects are dropped. */
  items: Array<Record<string, unknown>>;
  page: WooPageInfo;
}

export interface WooPaginateOptions {
  query?: WooQuery;
  /** WooCommerce caps this at 100. Default 20. */
  perPage?: number;
  /** 1-based. Default 1. */
  startPage?: number;
  /** Safety bound on how many pages one iteration may walk. Default 100. */
  maxPages?: number;
}

export interface WooAdapterStats {
  baseUrl: string;
  namespace: string;
  sourceAccountKey: string;
  rateBudget: RateBudgetStats;
  /** Requests that reached the network (successful or not). */
  requests: number;
}

export interface WooAdapter {
  readonly baseUrl: string;
  readonly namespace: string;
  /** `woocommerce:<siteUrl>` — the design's `orders.source_account_key`. */
  readonly sourceAccountKey: string;
  /** Single GET against a namespace-relative path (`/orders`, `/orders/1`). */
  get(
    path: string,
    query?: WooQuery,
    options?: { operation?: string },
  ): Promise<WooResponse>;
  /** GET a collection page; throws `provider_unavailable` if it is not an array. */
  list(
    path: string,
    query?: WooQuery,
    options?: { operation?: string },
  ): Promise<WooListPage>;
  /** Async iterator over collection pages, driven by the header totals. */
  paginate(
    path: string,
    options?: WooPaginateOptions,
  ): AsyncGenerator<WooListPage, void, undefined>;
  stats(): WooAdapterStats;
}

/** Conservative default per-store budget (see rate-budget.ts). */
const DEFAULT_BUDGET = { capacity: 5, refillPerSecond: 2 } as const;

/** WooCommerce rejects `per_page` outside 1..100 with HTTP 400. */
export const WOO_MAX_PER_PAGE = 100;
export const WOO_DEFAULT_PER_PAGE = 20;

const DEFAULT_MAX_PAGES = 100;

export type WooFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreateWooAdapterInput = WooAdapterConfigInput & {
  /**
   * Test seam only. Production code leaves this undefined and the adapter
   * uses the runtime's native `fetch`.
   */
  fetchImpl?: WooFetch;
};

function buildQuery(query: WooQuery | undefined): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(`${key}[]`, String(entry));
      continue;
    }
    params.append(key, String(value));
  }
  const serialized = params.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

function readIntHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when the `Link` header advertises a next page. */
export function linkHeaderHasNext(link: string | null): boolean {
  if (link === null) return false;
  return /;\s*rel\s*=\s*"?next"?/i.test(link);
}

function pageInfo(
  headers: Headers,
  page: number,
  perPage: number,
): WooPageInfo {
  const total = readIntHeader(headers, "x-wp-total");
  const totalPages = readIntHeader(headers, "x-wp-totalpages");
  const hasNextPage =
    linkHeaderHasNext(headers.get("link")) ||
    (totalPages !== null && page < totalPages);
  return { page, perPage, total, totalPages, hasNextPage };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createWooAdapter(input: CreateWooAdapterInput): WooAdapter {
  const { logger, rateBudget, fetchImpl, ...rest } = input;
  const config: WooAdapterConfig = parseWooAdapterConfig(rest);
  const budget: RateBudget =
    rateBudget ?? createRateBudget({ ...DEFAULT_BUDGET, logger });
  const doFetch: WooFetch =
    fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const sourceAccountKey = wooSourceAccountKey(config.baseUrl);

  // Computed once and held in this closure. It is never read back out, never
  // logged, and never attached to an error or a stats object.
  const authorization = `Basic ${Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`,
    "utf8",
  ).toString("base64")}`;

  const prefix = `${config.baseUrl}${config.restRoot}/${config.namespace}`;
  let requests = 0;

  const request = async (
    path: string,
    query: WooQuery | undefined,
    operation: string,
    perPageHint: number,
    pageHint: number,
  ): Promise<WooResponse> => {
    if (!path.startsWith("/")) {
      throw new WooAdapterError(
        "invalid_request",
        "WooCommerce request path must start with '/'",
        { operation },
      );
    }
    const restPath = `${config.restRoot}/${config.namespace}${path}`;
    const context: WooErrorContext = { operation, path: restPath };

    await budget.acquire(1);

    let response: Response;
    try {
      requests += 1;
      response = await doFetch(`${prefix}${path}${buildQuery(query)}`, {
        method: "GET",
        headers: {
          authorization,
          accept: "application/json",
          "user-agent": "loxep-woo-adapter",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const normalized = normalizeWooError(error, context);
      logger?.warn?.(
        { operation, kind: normalized.kind, path: restPath },
        "WooCommerce request failed",
      );
      throw normalized;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const looksJson = contentType.toLowerCase().includes("json");
    let body: unknown = null;
    let parseFailed = false;
    if (looksJson) {
      try {
        body = await response.json();
      } catch {
        parseFailed = true;
      }
    } else {
      // Drain without retaining: a WordPress fatal, a login wall, or a WAF
      // block page is HTML we must not copy into an error or a log line.
      await response.text().catch(() => "");
    }

    if (!response.ok) {
      const normalized = wooErrorFromResponse(
        response.status,
        parseFailed ? null : body,
        context,
      );
      logger?.warn?.(
        {
          operation,
          kind: normalized.kind,
          path: restPath,
          httpStatus: response.status,
        },
        "WooCommerce API call failed",
      );
      throw normalized;
    }

    if (!looksJson || parseFailed) {
      throw new WooAdapterError(
        "provider_unavailable",
        "WooCommerce returned a non-JSON body for a successful status",
        {
          operation,
          path: restPath,
          httpStatus: response.status,
          contentType: contentType.split(";")[0] ?? "",
        },
      );
    }

    return {
      data: body,
      page: pageInfo(response.headers, pageHint, perPageHint),
    };
  };

  const list = async (
    path: string,
    query?: WooQuery,
    options?: { operation?: string },
  ): Promise<WooListPage> => {
    const operation = options?.operation ?? `list${path}`;
    const perPage = Number(query?.["per_page"] ?? WOO_DEFAULT_PER_PAGE);
    const page = Number(query?.["page"] ?? 1);
    const response = await request(path, query, operation, perPage, page);
    if (!Array.isArray(response.data)) {
      throw new WooAdapterError(
        "provider_unavailable",
        "WooCommerce collection endpoint did not return an array",
        {
          operation,
          path: `${config.restRoot}/${config.namespace}${path}`,
          receivedType: response.data === null ? "null" : typeof response.data,
        },
      );
    }
    const items: Array<Record<string, unknown>> = [];
    for (const entry of response.data) {
      const record = asRecord(entry);
      if (record !== null) items.push(record);
    }
    return { items, page: response.page };
  };

  const adapter: WooAdapter = {
    baseUrl: config.baseUrl,
    namespace: config.namespace,
    sourceAccountKey,

    async get(path, query, options) {
      const operation = options?.operation ?? `get${path}`;
      const perPage = Number(query?.["per_page"] ?? WOO_DEFAULT_PER_PAGE);
      const page = Number(query?.["page"] ?? 1);
      return request(path, query, operation, perPage, page);
    },

    list,

    async *paginate(path, options) {
      const perPage = Math.min(
        Math.max(1, options?.perPage ?? WOO_DEFAULT_PER_PAGE),
        WOO_MAX_PER_PAGE,
      );
      const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
      let page = Math.max(1, options?.startPage ?? 1);
      let walked = 0;

      while (walked < maxPages) {
        let result: WooListPage;
        try {
          result = await list(
            path,
            { ...options?.query, page, per_page: perPage },
            { operation: `paginate${path}` },
          );
        } catch (error) {
          // Asking for a page past the end is a 400, not an empty array.
          // Walking off the end is a normal terminal condition, not a fault.
          if (
            error instanceof WooAdapterError &&
            error.kind === "invalid_request" &&
            isPageOutOfRangeCode(
              typeof error.detail["providerCode"] === "string"
                ? error.detail["providerCode"]
                : null,
            )
          ) {
            return;
          }
          throw error;
        }

        walked += 1;
        yield result;

        // Three independent stop conditions: an empty page (a store that
        // reports no totals), the header totals, and the Link header.
        if (result.items.length === 0) return;
        if (!result.page.hasNextPage) return;
        page += 1;
      }
    },

    stats() {
      return {
        baseUrl: config.baseUrl,
        namespace: config.namespace,
        sourceAccountKey,
        rateBudget: budget.stats(),
        requests,
      };
    },
  };

  return adapter;
}

/** Re-exported for callers that need to recognize a WP REST error body. */
export { readWooErrorBody };
