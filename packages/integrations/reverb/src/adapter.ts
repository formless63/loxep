/**
 * Reverb adapter (loxep-g4t.3): a thin Loxep-owned boundary over Reverb's
 * REST API, implemented on native `fetch` with no client dependency
 * (ADR-0009) — Reverb, like Etsy/WooCommerce/Medusa, has no first-party
 * maintained Node/TypeScript SDK.
 *
 * ENDPOINTS AND HEADERS — SOURCE-VERIFIED against Reverb's own developer
 * documentation (fetched 2026-08-13; see the design doc's citations):
 *
 * ```text
 * base           https://api.reverb.com/api
 * auth           Authorization: Bearer <personalAccessToken>   (every call —
 *                there is no separate public/private tier the way Etsy has
 *                one; the token's granted SCOPES gate which calls succeed,
 *                not a different header shape)
 * required       Content-Type / Accept: application/hal+json
 * required       Accept-Version: 3.0
 *
 * get listing (public data)               GET  /listings/{listing_id}
 * my account (whoami)                     GET  /my/account
 * my listings, any/one state (PRIVATE,    GET  /my/listings
 *   needs read_listings)
 * ```
 *
 * https://www.reverb-api.com/docs/updating-your-listing confirms
 * `GET /api/my/listings?sku=[sku]&state=all` and
 * `GET /api/listings/[listing_id]`; https://www.reverb-api.com/docs/http-headers
 * and /docs/getting-started confirm the three headers above.
 * https://www.reverb-api.com/docs/account-details is the source for
 * `GET /api/my/account`. `state` is the one query parameter this survey
 * confirmed on `/my/listings`; deeper pagination (beyond the first page)
 * is handled by following the response's `_links.next.href` VERBATIM
 * (Reverb's own documented HAL convention,
 * https://www.reverb-api.com/docs/getting-started: "You should never
 * construct your own URLs... follow resource links") rather than by
 * guessing a `page`/`per_page` query-parameter naming this survey did not
 * confirm.
 *
 * Boundary rules enforced by this module, matching every sibling adapter:
 * - provider payloads cross as `Record<string, unknown>`; no provider type
 *   is exported;
 * - every request acquires from the injected {@link RateBudget} BEFORE
 *   touching the network — PER CONNECTION, unlike Etsy's shared-per-
 *   application budget (see `rate-budget.ts`'s module doc);
 * - every failure is normalized to {@link ReverbAdapterError} with
 *   credential-free `detail`;
 * - the Personal Access Token lives in a closure and is never re-exposed,
 *   logged, or echoed in an error.
 */
import {
  REVERB_API_BASE_URL,
  REVERB_API_VERSION,
  parseReverbAdapterConfig,
  type ReverbAdapterConfig,
  type ReverbAdapterConfigInput,
} from "./config.ts";
import {
  ReverbAdapterError,
  normalizeReverbError,
  reverbErrorFromResponse,
  type ReverbErrorContext,
} from "./errors.ts";
import { createRateBudget } from "./rate-budget.ts";
import type { RateBudget, RateBudgetStats } from "./rate-budget.ts";

/** Reverb's own listing-state vocabulary (see `observation.ts`). */
export type ReverbListingStateFilter = "all" | "live" | "draft" | "ended" | "sold";

export type ReverbQueryValue = string | number | boolean | undefined | null;
export type ReverbQuery = Readonly<Record<string, ReverbQueryValue>>;

export interface ReverbListPage {
  /** Object entries of the collection's named array; non-objects are dropped. */
  results: Array<Record<string, unknown>>;
  /** `_links.next.href`, followed verbatim by a subsequent call — see the module doc. */
  nextHref: string | null;
}

export interface ReverbAdapterStats {
  rateBudget: RateBudgetStats;
  /** Requests that reached the network (successful or not). */
  requests: number;
}

export interface GetMyListingsInput {
  /** Defaults to `"all"` — otherwise only `live` listings are returned. */
  state?: ReverbListingStateFilter;
  /** Follow a previously returned {@link ReverbListPage.nextHref} verbatim. */
  pageHref?: string;
}

export interface ReverbAccount {
  raw: Record<string, unknown>;
}

export interface ReverbAdapter {
  /** `GET /listings/{listing_id}` — one listing's detail. */
  getListing(listingId: string): Promise<Record<string, unknown>>;
  /**
   * `GET /my/listings` — the connected account's own listings (needs the
   * `read_listings` PAT scope). See `GetMyListingsInput` for pagination.
   */
  getMyListings(input?: GetMyListingsInput): Promise<ReverbListPage>;
  /** `GET /my/account` — the cheapest authenticated call this adapter has a shape for. */
  getAccount(): Promise<ReverbAccount>;
  stats(): ReverbAdapterStats;
}

export type ReverbFetch = (input: string, init: RequestInit) => Promise<Response>;

export type CreateReverbAdapterInput = ReverbAdapterConfigInput & {
  /**
   * Test seam only. Production code leaves this undefined and the adapter
   * uses the runtime's native `fetch`.
   */
  fetchImpl?: ReverbFetch;
};

/** Conservative private default when no budget is injected (matches Woo's contract). */
const DEFAULT_RATE_BUDGET_CAPACITY = 5;
const DEFAULT_RATE_BUDGET_REFILL_PER_SECOND = 1;

function buildQuery(query: ReverbQuery | undefined): string {
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

/** Read `_links.next.href` out of a HAL collection envelope, or `null`. */
function nextHrefFrom(body: Record<string, unknown>): string | null {
  const links = asRecord(body["_links"]);
  if (links === null) return null;
  const next = asRecord(links["next"]);
  if (next === null) return null;
  const href = next["href"];
  return typeof href === "string" && href.length > 0 ? href : null;
}

export function createReverbAdapter(input: CreateReverbAdapterInput): ReverbAdapter {
  const { logger, fetchImpl, rateBudget: injectedRateBudget, ...rest } = input;
  const config: ReverbAdapterConfig = parseReverbAdapterConfig(rest);
  const rateBudget: RateBudget =
    injectedRateBudget ??
    createRateBudget({
      capacity: DEFAULT_RATE_BUDGET_CAPACITY,
      refillPerSecond: DEFAULT_RATE_BUDGET_REFILL_PER_SECOND,
      ...(logger !== undefined ? { logger } : {}),
    });
  const doFetch: ReverbFetch = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  let requests = 0;

  const request = async (
    urlOrPath: string,
    query: ReverbQuery | undefined,
    operation: string,
  ): Promise<unknown> => {
    const isAbsolute = /^https?:\/\//i.test(urlOrPath);
    if (!isAbsolute && !urlOrPath.startsWith("/")) {
      throw new ReverbAdapterError(
        "invalid_request",
        "Reverb request path must start with '/' or be an absolute URL",
        { operation },
      );
    }
    const url = isAbsolute
      ? urlOrPath
      : `${REVERB_API_BASE_URL}${urlOrPath}${buildQuery(query)}`;
    const path = isAbsolute ? new URL(urlOrPath).pathname : urlOrPath;
    const context: ReverbErrorContext = { operation, path };

    await rateBudget.acquire(1);

    let response: Response;
    try {
      requests += 1;
      response = await doFetch(url, {
        method: "GET",
        headers: {
          accept: "application/hal+json",
          "content-type": "application/hal+json",
          "accept-version": REVERB_API_VERSION,
          authorization: `Bearer ${config.personalAccessToken}`,
          "user-agent": "loxep-reverb-adapter",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const normalized = normalizeReverbError(error, context);
      logger?.warn?.(
        { operation, kind: normalized.kind, path },
        "Reverb request failed",
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
      const normalized = reverbErrorFromResponse(
        response.status,
        parseFailed ? null : responseBody,
        context,
      );
      logger?.warn?.(
        { operation, kind: normalized.kind, path, httpStatus: response.status },
        "Reverb API call failed",
      );
      throw normalized;
    }

    if (!looksJson || parseFailed) {
      throw new ReverbAdapterError(
        "provider_unavailable",
        "Reverb returned a non-JSON body for a successful status",
        {
          operation,
          path,
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
  ): Promise<Record<string, unknown>> => {
    const body = await request(path, undefined, operation);
    const record = asRecord(body);
    if (record === null) {
      throw new ReverbAdapterError(
        "provider_unavailable",
        "Reverb endpoint did not return a JSON object",
        { operation, path },
      );
    }
    return record;
  };

  const stats = (): ReverbAdapterStats => ({
    rateBudget: rateBudget.stats(),
    requests,
  });

  return {
    async getListing(listingId) {
      if (listingId.trim() === "") {
        throw new ReverbAdapterError("invalid_request", "listingId is required");
      }
      return getObject(`/listings/${listingId}`, "listings.get");
    },

    async getMyListings(listingsInput = {}) {
      const body =
        listingsInput.pageHref !== undefined
          ? await request(listingsInput.pageHref, undefined, "my.listings")
          : await request(
              "/my/listings",
              { state: listingsInput.state ?? "all" },
              "my.listings",
            );
      const record = asRecord(body);
      if (record === null || !Array.isArray(record["listings"])) {
        throw new ReverbAdapterError(
          "provider_unavailable",
          "Reverb /my/listings did not return a {listings: [...]} envelope",
          { operation: "my.listings" },
        );
      }
      return {
        results: asRecordArray(record["listings"]),
        nextHref: nextHrefFrom(record),
      };
    },

    async getAccount() {
      const raw = await getObject("/my/account", "my.account");
      return { raw };
    },

    stats,
  };
}
