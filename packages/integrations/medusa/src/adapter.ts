/**
 * Medusa adapter (loxep-xh9.4): a Loxep-owned boundary over the Medusa v2
 * Admin REST API, implemented on **native `fetch`** with no client
 * dependency (ADR-0009), mirroring `packages/integrations/woo/src/adapter.ts`.
 *
 * Why no library: `@medusajs/js-sdk` exists but is built for the Medusa
 * Admin dashboard's own interactive, cookie/JWT-authenticated usage
 * (`baseUrl` + browser session), not for a server holding one long-lived
 * secret API key against one deployment. The protocol work it would save —
 * an `Authorization` header and query-string building — is a few dozen
 * lines, and pulling in a client built around a different auth model to
 * save them is a poor trade, the same call the WooCommerce adapter made
 * against `@woocommerce/woocommerce-rest-api`.
 *
 * NO LIVE MEDUSA INSTANCE EXISTS IN THIS ENVIRONMENT. Every fact this
 * module encodes was verified against Medusa's own GitHub source
 * (`medusajs/medusa`, `develop` branch, fetched 2026-08-11) and the
 * `docs.medusajs.com` narrative pages that were fetchable, because Medusa's
 * generated API-reference pages did not yield concrete JSON shapes through
 * the tool available here (see the module doc / commerce-schema-design.md
 * live-verification gap for the citation trail). Live verification against
 * a real Medusa v2 backend is tracked as a follow-up.
 *
 * ## What is structurally different from the WooCommerce adapter
 *
 * - **Pagination lives in the response BODY, not headers.** Every Admin API
 *   list response is `{ <resultKey>: T[], count, offset, limit }`
 *   (verified: `GET /admin/orders` →
 *   https://github.com/medusajs/medusa/blob/develop/packages/medusa/src/api/admin/orders/route.ts
 *   returns `{ orders, count, offset: metadata.skip, limit: metadata.take }`;
 *   `GET /admin/products` →
 *   https://github.com/medusajs/medusa/blob/develop/packages/medusa/src/api/admin/products/route.ts
 *   returns the same shape keyed `products`). There is no `X-WP-Total`
 *   analogue, so `list()` here takes an explicit `resultKey` naming which
 *   body property holds the array, and pagination advances by
 *   `offset += limit` rather than `page += 1`.
 * - **No "page past the end" error.** WooCommerce's `page`-based pagination
 *   returns HTTP 400 for a page beyond the last; Medusa's `offset`-based
 *   pagination is ordinary SQL `OFFSET`, which returns an empty array with
 *   HTTP 200 past the end. `paginate()` therefore has one fewer stop
 *   condition to special-case than the WooCommerce adapter's.
 * - **No documented maximum for `limit`.** WooCommerce's REST API rejects
 *   `per_page` outside 1..100 with HTTP 400 (confirmed live). No such
 *   server-enforced ceiling for Medusa's `limit` was found in the source
 *   reviewed for this adapter (`prepareListQuery` in
 *   https://github.com/medusajs/medusa/blob/develop/packages/core/framework/src/http/utils/get-query-config.ts
 *   applies no upper clamp). {@link MEDUSA_MAX_LIMIT} below is therefore
 *   Loxep's OWN conservative ceiling, not a provider-enforced one — flagged
 *   explicitly so a future maintainer does not mistake it for verified
 *   provider behavior.
 *
 * Boundary rules enforced here, same as the WooCommerce adapter:
 * - the secret API token goes into an `Authorization` header ONLY. It is
 *   never placed in a URL or query string, so no error, log field, or
 *   thrown value reachable from this module can structurally contain it;
 * - every request acquires from the per-connection {@link RateBudget}
 *   BEFORE touching the network;
 * - every failure is normalized to {@link MedusaAdapterError} with
 *   credential-free `detail`;
 * - responses cross this boundary as `Record<string, unknown>`; provider
 *   shapes are normalized into Loxep-owned types by `orders.ts` /
 *   `products.ts`.
 */
import {
  MEDUSA_ADMIN_PATH,
  parseMedusaAdapterConfig,
  medusaSourceAccountKey,
  type MedusaAdapterConfig,
  type MedusaAdapterConfigInput,
} from "./config.ts";
import {
  MedusaAdapterError,
  medusaErrorFromResponse,
  normalizeMedusaError,
  type MedusaErrorContext,
} from "./errors.ts";
import {
  createRateBudget,
  type RateBudget,
  type RateBudgetStats,
  type MedusaAdapterLogger,
} from "./rate-budget.ts";

/** Query values the adapter knows how to serialize. */
export type MedusaQueryValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number>
  | undefined
  | null;

export type MedusaQuery = Readonly<Record<string, MedusaQueryValue>>;

export interface MedusaPageInfo {
  /** 0-based offset actually requested (or reported by the response body). */
  offset: number;
  limit: number;
  /** Total matching rows, or null when the response body omits `count`. */
  count: number | null;
  /** True when `offset + items.length < count`, or a fallback heuristic. */
  hasNextPage: boolean;
}

export interface MedusaResponse {
  /** Parsed JSON body — provider-shaped, deliberately untyped. */
  data: Record<string, unknown>;
}

export interface MedusaListPage {
  /** Object entries of `data[resultKey]`; non-objects are dropped. */
  items: Array<Record<string, unknown>>;
  page: MedusaPageInfo;
}

export interface MedusaPaginateOptions {
  query?: MedusaQuery;
  /** Loxep's own default (matches Medusa's products-list server default). */
  limit?: number;
  /** 0-based. Default 0. */
  startOffset?: number;
  /** Safety bound on how many pages one iteration may walk. Default 100. */
  maxPages?: number;
}

export interface MedusaAdapterStats {
  baseUrl: string;
  sourceAccountKey: string;
  rateBudget: RateBudgetStats;
  /** Requests that reached the network (successful or not). */
  requests: number;
}

export interface MedusaAdapter {
  readonly baseUrl: string;
  /** `medusa:<baseUrl>` — the design's `orders.source_account_key`. */
  readonly sourceAccountKey: string;
  /** Single GET against an admin-relative path (`/orders`, `/orders/ord_1`). */
  get(
    path: string,
    query?: MedusaQuery,
    options?: { operation?: string },
  ): Promise<MedusaResponse>;
  /** GET a collection page; throws `provider_unavailable` if `resultKey` is not an array. */
  list(
    path: string,
    resultKey: string,
    query?: MedusaQuery,
    options?: { operation?: string },
  ): Promise<MedusaListPage>;
  /** Async iterator over collection pages, driven by the body's offset/limit/count. */
  paginate(
    path: string,
    resultKey: string,
    options?: MedusaPaginateOptions,
  ): AsyncGenerator<MedusaListPage, void, undefined>;
  stats(): MedusaAdapterStats;
}

/** Conservative default per-connection budget (see rate-budget.ts). */
const DEFAULT_BUDGET = { capacity: 5, refillPerSecond: 2 } as const;

/** Loxep's own default page size — no provider-documented default applies to a generic client. */
export const MEDUSA_DEFAULT_LIMIT = 50;
/** Loxep's own conservative ceiling — NOT a Medusa-enforced maximum; see the module doc. */
export const MEDUSA_MAX_LIMIT = 200;

const DEFAULT_MAX_PAGES = 100;

export type MedusaFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreateMedusaAdapterInput = MedusaAdapterConfigInput & {
  /**
   * Test seam only. Production code leaves this undefined and the adapter
   * uses the runtime's native `fetch`.
   */
  fetchImpl?: MedusaFetch;
};

function buildQuery(query: MedusaQuery | undefined): string {
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

export function createMedusaAdapter(
  input: CreateMedusaAdapterInput,
): MedusaAdapter {
  const { logger, rateBudget, fetchImpl, ...rest } = input;
  const config: MedusaAdapterConfig = parseMedusaAdapterConfig(rest);
  const budget: RateBudget =
    rateBudget ?? createRateBudget({ ...DEFAULT_BUDGET, logger });
  const doFetch: MedusaFetch =
    fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const sourceAccountKey = medusaSourceAccountKey(config.baseUrl);

  // Computed once and held in this closure. It is never read back out, never
  // logged, and never attached to an error or a stats object. See config.ts
  // for why this is `Basic <token>` and NOT base64("user:pass").
  const authorization = `Basic ${config.apiToken}`;

  const prefix = `${config.baseUrl}${MEDUSA_ADMIN_PATH}`;
  let requests = 0;

  const request = async (
    path: string,
    query: MedusaQuery | undefined,
    operation: string,
  ): Promise<unknown> => {
    if (!path.startsWith("/")) {
      throw new MedusaAdapterError(
        "invalid_request",
        "Medusa request path must start with '/'",
        { operation },
      );
    }
    const adminPath = `${MEDUSA_ADMIN_PATH}${path}`;
    const context: MedusaErrorContext = { operation, path: adminPath };

    await budget.acquire(1);

    let response: Response;
    try {
      requests += 1;
      response = await doFetch(`${prefix}${path}${buildQuery(query)}`, {
        method: "GET",
        headers: {
          authorization,
          accept: "application/json",
          "user-agent": "loxep-medusa-adapter",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const normalized = normalizeMedusaError(error, context);
      logger?.warn?.(
        { operation, kind: normalized.kind, path: adminPath },
        "Medusa request failed",
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
      // Drain without retaining: a reverse-proxy error page or a WAF block
      // page is HTML we must not copy into an error or a log line.
      await response.text().catch(() => "");
    }

    if (!response.ok) {
      const normalized = medusaErrorFromResponse(
        response.status,
        parseFailed ? null : body,
        context,
      );
      logger?.warn?.(
        {
          operation,
          kind: normalized.kind,
          path: adminPath,
          httpStatus: response.status,
        },
        "Medusa API call failed",
      );
      throw normalized;
    }

    if (!looksJson || parseFailed) {
      throw new MedusaAdapterError(
        "provider_unavailable",
        "Medusa returned a non-JSON body for a successful status",
        {
          operation,
          path: adminPath,
          httpStatus: response.status,
          contentType: contentType.split(";")[0] ?? "",
        },
      );
    }

    return body;
  };

  const get = async (
    path: string,
    query?: MedusaQuery,
    options?: { operation?: string },
  ): Promise<MedusaResponse> => {
    const operation = options?.operation ?? `get${path}`;
    const body = await request(path, query, operation);
    const record = asRecord(body);
    if (record === null) {
      throw new MedusaAdapterError(
        "provider_unavailable",
        "Medusa endpoint did not return a JSON object",
        {
          operation,
          path: `${MEDUSA_ADMIN_PATH}${path}`,
          receivedType: body === null ? "null" : typeof body,
        },
      );
    }
    return { data: record };
  };

  const list = async (
    path: string,
    resultKey: string,
    query?: MedusaQuery,
    options?: { operation?: string },
  ): Promise<MedusaListPage> => {
    const operation = options?.operation ?? `list${path}`;
    const response = await get(path, query, { operation });
    const raw = response.data[resultKey];
    if (!Array.isArray(raw)) {
      throw new MedusaAdapterError(
        "provider_unavailable",
        `Medusa collection endpoint did not return an array at "${resultKey}"`,
        {
          operation,
          path: `${MEDUSA_ADMIN_PATH}${path}`,
          resultKey,
          receivedType: raw === undefined ? "undefined" : typeof raw,
        },
      );
    }
    const items = asRecordArray(raw);

    const requestedOffset = Number(query?.["offset"] ?? 0);
    const requestedLimit = Number(query?.["limit"] ?? MEDUSA_DEFAULT_LIMIT);
    const count = asNumberOrNull(response.data["count"]);
    const offset = asNumberOrNull(response.data["offset"]) ?? requestedOffset;
    const limit = asNumberOrNull(response.data["limit"]) ?? requestedLimit;

    // Two stop conditions: the body's own `count` when present (the strong
    // signal), and — when it is absent — "we got a full page, there may be
    // more" as a conservative fallback. `paginate`'s `maxPages` is the
    // ultimate backstop against a provider that never terminates cleanly.
    const hasNextPage =
      count !== null
        ? offset + items.length < count
        : items.length > 0 && items.length >= limit;

    return { items, page: { offset, limit, count, hasNextPage } };
  };

  const adapter: MedusaAdapter = {
    baseUrl: config.baseUrl,
    sourceAccountKey,

    get,
    list,

    async *paginate(path, resultKey, options) {
      const limit = Math.min(
        Math.max(1, options?.limit ?? MEDUSA_DEFAULT_LIMIT),
        MEDUSA_MAX_LIMIT,
      );
      const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
      let offset = Math.max(0, options?.startOffset ?? 0);
      let walked = 0;

      while (walked < maxPages) {
        const result = await list(
          path,
          resultKey,
          { ...options?.query, offset, limit },
          { operation: `paginate${path}` },
        );

        walked += 1;
        yield result;

        if (result.items.length === 0) return;
        if (!result.page.hasNextPage) return;
        offset += limit;
      }
    },

    stats() {
      return {
        baseUrl: config.baseUrl,
        sourceAccountKey,
        rateBudget: budget.stats(),
        requests,
      };
    },
  };

  return adapter;
}
