/**
 * Invoice Ninja adapter (loxep-v5r.4): a Loxep-owned boundary over the
 * self-hosted Invoice Ninja v5 REST API, implemented on **native `fetch`**
 * with no client dependency (ADR-0009), mirroring
 * `packages/integrations/medusa/src/adapter.ts` — the structurally closest
 * reference (a self-hosted REST API authenticated with a single long-lived
 * token, JSON-number money).
 *
 * SOURCE-VERIFIED against `invoiceninja/invoiceninja`, `v5-stable` branch,
 * fetched 2026-08-13 (`routes/api.php`, `app/Http/Middleware/TokenAuth.php`,
 * `app/Http/Controllers/BaseController.php`,
 * `app/Transformers/{Client,Invoice}Transformer.php`). LIVE-PROBED
 * (unauthenticated only — no write credential existed in this environment)
 * against a real self-hosted instance running on this host (container
 * `invoiceninja-web`, image `invoiceninja/invoiceninja-debian`,
 * `X-APP-VERSION: 5.13.24`), reachable only via its Docker bridge-network IP
 * since no host port is published — see `errors.ts` for the exact probe
 * evidence.
 *
 * ## What is structurally different from the Medusa/WooCommerce adapters
 *
 * - **Auth header is `X-API-TOKEN`, not `Authorization`.** No Basic/Bearer
 *   wrapping at all — the raw company token goes in its own header
 *   (`TokenAuth::handle()`, source above).
 * - **This adapter WRITES.** Unlike the read-only Medusa/WooCommerce
 *   adapters, the billing design's round-trip needs `POST`/`PUT` (create/
 *   update a client, push an invoice draft) alongside `GET`, so `request()`
 *   here takes a `method` and an optional JSON `body`.
 * - **Pagination is a Fractal `ArraySerializer` envelope, source-verified
 *   against `thephpleague/fractal`'s own `ArraySerializer::paginator()`**
 *   (`master` branch, fetched 2026-08-13):
 *   `{ data: T[], meta: { pagination: { total, count, per_page,
 *   current_page, total_pages, links: { previous?, next? } } } }`. A single-
 *   item response is `{ data: T }`. This is the OPPOSITE shape from
 *   Medusa's flat `{ <resultKey>: T[], count, offset, limit }` body, and
 *   pagination advances by PAGE NUMBER (`page` query param), not by offset —
 *   confirmed in `BaseController::resolveQueryLimit()`
 *   (`per_page`, default 20, capped at 5000; Laravel's own `paginate()`
 *   drives `page`).
 * - **IDs are opaque hashed strings, not raw integers.** Every transformer
 *   passes `id` through `$this->encodePrimaryKey($model->id)` (a hashids
 *   encoding) — this adapter therefore never assumes an id is numeric or
 *   sequential; it is carried as an opaque string end to end, matching how
 *   Loxep already treats every OTHER provider's external id.
 *
 * Boundary rules enforced here, same as the WooCommerce/Medusa adapters:
 * - the API token goes into an `X-API-TOKEN` header ONLY. It is never placed
 *   in a URL or query string, so no error, log field, or thrown value
 *   reachable from this module can structurally contain it;
 * - every request acquires from the per-connection {@link RateBudget} BEFORE
 *   touching the network;
 * - every failure is normalized to {@link InvoiceNinjaAdapterError} with
 *   credential-free `detail`;
 * - responses cross this boundary as `Record<string, unknown>`; provider
 *   shapes are normalized into Loxep-owned types by `clients.ts`/
 *   `invoices.ts`.
 */
import {
  INVOICENINJA_API_PATH,
  parseInvoiceNinjaAdapterConfig,
  invoiceNinjaSourceAccountKey,
  type InvoiceNinjaAdapterConfig,
  type InvoiceNinjaAdapterConfigInput,
} from "./config.ts";
import {
  InvoiceNinjaAdapterError,
  invoiceNinjaErrorFromResponse,
  normalizeInvoiceNinjaError,
  type InvoiceNinjaErrorContext,
} from "./errors.ts";
import {
  createRateBudget,
  type RateBudget,
  type RateBudgetStats,
  type InvoiceNinjaAdapterLogger,
} from "./rate-budget.ts";

export type InvoiceNinjaHttpMethod = "GET" | "POST" | "PUT";

export type InvoiceNinjaQueryValue = string | number | boolean | undefined | null;
export type InvoiceNinjaQuery = Readonly<Record<string, InvoiceNinjaQueryValue>>;

export interface InvoiceNinjaResponse {
  /** The unwrapped `data` object — provider-shaped, deliberately untyped. */
  data: Record<string, unknown>;
}

export interface InvoiceNinjaPageInfo {
  total: number | null;
  count: number;
  perPage: number;
  currentPage: number;
  totalPages: number | null;
  hasNextPage: boolean;
}

export interface InvoiceNinjaListPage {
  /** Object entries of `data[]`; non-objects are dropped. */
  items: Array<Record<string, unknown>>;
  page: InvoiceNinjaPageInfo;
}

export interface InvoiceNinjaPaginateOptions {
  query?: InvoiceNinjaQuery;
  /** Loxep's own default. Invoice Ninja's own server default is also 20. */
  perPage?: number;
  /** 1-based. Default 1. */
  startPage?: number;
  /** Safety bound on how many pages one iteration may walk. Default 100. */
  maxPages?: number;
}

export interface InvoiceNinjaAdapterStats {
  baseUrl: string;
  sourceAccountKey: string;
  rateBudget: RateBudgetStats;
  /** Requests that reached the network (successful or not). */
  requests: number;
}

export interface InvoiceNinjaAdapter {
  readonly baseUrl: string;
  /** `invoiceninja:<baseUrl>` — see `config.ts`. */
  readonly sourceAccountKey: string;
  /** Single GET against an API-relative path (`/clients`, `/clients/<id>`). */
  get(
    path: string,
    query?: InvoiceNinjaQuery,
    options?: { operation?: string },
  ): Promise<InvoiceNinjaResponse>;
  /** GET a collection page, unwrapping the Fractal `{data, meta.pagination}` envelope. */
  list(
    path: string,
    query?: InvoiceNinjaQuery,
    options?: { operation?: string },
  ): Promise<InvoiceNinjaListPage>;
  /** POST a JSON body, unwrapping a single-item `{data}` envelope. */
  post(
    path: string,
    body: Record<string, unknown>,
    options?: { operation?: string },
  ): Promise<InvoiceNinjaResponse>;
  /** PUT a JSON body, unwrapping a single-item `{data}` envelope. */
  put(
    path: string,
    body: Record<string, unknown>,
    options?: { operation?: string },
  ): Promise<InvoiceNinjaResponse>;
  /** Async iterator over collection pages, driven by `meta.pagination`. */
  paginate(
    path: string,
    options?: InvoiceNinjaPaginateOptions,
  ): AsyncGenerator<InvoiceNinjaListPage, void, undefined>;
  stats(): InvoiceNinjaAdapterStats;
}

/** Conservative default per-connection budget (see rate-budget.ts). */
const DEFAULT_BUDGET = { capacity: 5, refillPerSecond: 2 } as const;

/** Loxep's own default page size — matches Invoice Ninja's own server default. */
export const INVOICENINJA_DEFAULT_PER_PAGE = 20;
/**
 * Loxep's own conservative ceiling — Invoice Ninja's OWN server-side cap is
 * 5000 (`BaseController::resolveQueryLimit()`, source-verified); this is
 * Loxep's client-side courtesy limit under that, not a provider-enforced one.
 */
export const INVOICENINJA_MAX_PER_PAGE = 500;

const DEFAULT_MAX_PAGES = 100;

export type InvoiceNinjaFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreateInvoiceNinjaAdapterInput = InvoiceNinjaAdapterConfigInput & {
  /**
   * Test seam only. Production code leaves this undefined and the adapter
   * uses the runtime's native `fetch`.
   */
  fetchImpl?: InvoiceNinjaFetch;
};

function buildQuery(query: InvoiceNinjaQuery | undefined): string {
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

export function createInvoiceNinjaAdapter(
  input: CreateInvoiceNinjaAdapterInput,
): InvoiceNinjaAdapter {
  const { logger, rateBudget, fetchImpl, ...rest } = input;
  const config: InvoiceNinjaAdapterConfig = parseInvoiceNinjaAdapterConfig(rest);
  const budget: RateBudget =
    rateBudget ?? createRateBudget({ ...DEFAULT_BUDGET, logger });
  const doFetch: InvoiceNinjaFetch =
    fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const sourceAccountKey = invoiceNinjaSourceAccountKey(config.baseUrl);

  // Computed once and held in this closure. It is never read back out, never
  // logged, and never attached to an error or a stats object.
  const apiToken = config.apiToken;

  const prefix = `${config.baseUrl}${INVOICENINJA_API_PATH}`;
  let requests = 0;

  const request = async (
    method: InvoiceNinjaHttpMethod,
    path: string,
    query: InvoiceNinjaQuery | undefined,
    body: Record<string, unknown> | undefined,
    operation: string,
  ): Promise<unknown> => {
    if (!path.startsWith("/")) {
      throw new InvoiceNinjaAdapterError(
        "invalid_request",
        "Invoice Ninja request path must start with '/'",
        { operation },
      );
    }
    const apiPath = `${INVOICENINJA_API_PATH}${path}`;
    const context: InvoiceNinjaErrorContext = { operation, path: apiPath };

    await budget.acquire(1);

    let response: Response;
    try {
      requests += 1;
      response = await doFetch(`${prefix}${path}${buildQuery(query)}`, {
        method,
        headers: {
          "x-api-token": apiToken,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          "user-agent": "loxep-invoiceninja-adapter",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "follow",
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const normalized = normalizeInvoiceNinjaError(error, context);
      logger?.warn?.(
        { operation, kind: normalized.kind, path: apiPath },
        "Invoice Ninja request failed",
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
      // Drain without retaining: a reverse-proxy error page or a WAF block
      // page is HTML we must not copy into an error or a log line.
      await response.text().catch(() => "");
    }

    if (!response.ok) {
      const normalized = invoiceNinjaErrorFromResponse(
        response.status,
        parseFailed ? null : responseBody,
        context,
      );
      logger?.warn?.(
        {
          operation,
          kind: normalized.kind,
          path: apiPath,
          httpStatus: response.status,
        },
        "Invoice Ninja API call failed",
      );
      throw normalized;
    }

    if (!looksJson || parseFailed) {
      throw new InvoiceNinjaAdapterError(
        "provider_unavailable",
        "Invoice Ninja returned a non-JSON body for a successful status",
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

  const unwrapItem = (
    body: unknown,
    operation: string,
    path: string,
  ): InvoiceNinjaResponse => {
    const record = asRecord(body);
    const data = record === null ? null : asRecord(record["data"]);
    if (data === null) {
      throw new InvoiceNinjaAdapterError(
        "provider_unavailable",
        "Invoice Ninja endpoint did not return a {data: {...}} envelope",
        {
          operation,
          path,
          receivedType: body === null ? "null" : typeof body,
        },
      );
    }
    return { data };
  };

  const get = async (
    path: string,
    query?: InvoiceNinjaQuery,
    options?: { operation?: string },
  ): Promise<InvoiceNinjaResponse> => {
    const operation = options?.operation ?? `get${path}`;
    const body = await request("GET", path, query, undefined, operation);
    return unwrapItem(body, operation, `${INVOICENINJA_API_PATH}${path}`);
  };

  const post = async (
    path: string,
    payload: Record<string, unknown>,
    options?: { operation?: string },
  ): Promise<InvoiceNinjaResponse> => {
    const operation = options?.operation ?? `post${path}`;
    const body = await request("POST", path, undefined, payload, operation);
    return unwrapItem(body, operation, `${INVOICENINJA_API_PATH}${path}`);
  };

  const put = async (
    path: string,
    payload: Record<string, unknown>,
    options?: { operation?: string },
  ): Promise<InvoiceNinjaResponse> => {
    const operation = options?.operation ?? `put${path}`;
    const body = await request("PUT", path, undefined, payload, operation);
    return unwrapItem(body, operation, `${INVOICENINJA_API_PATH}${path}`);
  };

  const list = async (
    path: string,
    query?: InvoiceNinjaQuery,
    options?: { operation?: string },
  ): Promise<InvoiceNinjaListPage> => {
    const operation = options?.operation ?? `list${path}`;
    const apiPath = `${INVOICENINJA_API_PATH}${path}`;
    const raw = await request("GET", path, query, undefined, operation);
    const record = asRecord(raw);
    const rawItems = record?.["data"];
    if (!Array.isArray(rawItems)) {
      throw new InvoiceNinjaAdapterError(
        "provider_unavailable",
        "Invoice Ninja collection endpoint did not return a {data: [...]} envelope",
        {
          operation,
          path: apiPath,
          receivedType: rawItems === undefined ? "undefined" : typeof rawItems,
        },
      );
    }
    const items = asRecordArray(rawItems);

    const meta = record === null ? null : asRecord(record["meta"]);
    const pagination = meta === null ? null : asRecord(meta["pagination"]);
    const requestedPerPage = Number(
      query?.["per_page"] ?? INVOICENINJA_DEFAULT_PER_PAGE,
    );
    const requestedPage = Number(query?.["page"] ?? 1);

    const total = pagination === null ? null : asNumberOrNull(pagination["total"]);
    const count = pagination === null ? items.length : (asNumberOrNull(pagination["count"]) ?? items.length);
    const perPage =
      pagination === null
        ? requestedPerPage
        : (asNumberOrNull(pagination["per_page"]) ?? requestedPerPage);
    const currentPage =
      pagination === null
        ? requestedPage
        : (asNumberOrNull(pagination["current_page"]) ?? requestedPage);
    const totalPages =
      pagination === null ? null : asNumberOrNull(pagination["total_pages"]);
    const links = pagination === null ? null : asRecord(pagination["links"]);

    // Two stop conditions, matching the Medusa adapter's pattern: the
    // envelope's own signal when present (a `links.next` URL, or a known
    // `total_pages`), and — when absent — "we got a full page, there may be
    // more" as a conservative fallback.
    const hasNextPage =
      links !== null && typeof links["next"] === "string"
        ? true
        : totalPages !== null
          ? currentPage < totalPages
          : items.length > 0 && items.length >= perPage;

    return {
      items,
      page: { total, count, perPage, currentPage, totalPages, hasNextPage },
    };
  };

  const adapter: InvoiceNinjaAdapter = {
    baseUrl: config.baseUrl,
    sourceAccountKey,

    get,
    list,
    post,
    put,

    async *paginate(path, options) {
      const perPage = Math.min(
        Math.max(1, options?.perPage ?? INVOICENINJA_DEFAULT_PER_PAGE),
        INVOICENINJA_MAX_PER_PAGE,
      );
      const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
      let page = Math.max(1, options?.startPage ?? 1);
      let walked = 0;

      while (walked < maxPages) {
        const result = await list(
          path,
          { ...options?.query, page, per_page: perPage },
          { operation: `paginate${path}` },
        );

        walked += 1;
        yield result;

        if (result.items.length === 0) return;
        if (!result.page.hasNextPage) return;
        page += 1;
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
