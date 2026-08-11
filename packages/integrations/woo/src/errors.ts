/**
 * Loxep error taxonomy for the WooCommerce integration boundary (ADR-0009).
 *
 * Same shape as the eBay adapter's taxonomy — a small, stable `kind` plus a
 * sanitized `detail` record — so callers can branch on one vocabulary across
 * providers. The two taxonomies are deliberately DUPLICATED rather than
 * shared: `@loxep/integration-woo` must not depend on
 * `@loxep/integration-ebay`, and a cross-integration base package would make
 * every provider's error surface a shared upgrade hazard.
 *
 * WooCommerce speaks the WordPress REST error shape, verified against a live
 * WooCommerce 10.9.3 / WordPress 6.9.6 store:
 *
 * ```json
 * {"code":"woocommerce_rest_cannot_view",
 *  "message":"Sorry, you cannot list resources.",
 *  "data":{"status":401}}
 * ```
 *
 * Classification (statuses observed live unless noted):
 *
 * - `auth`                 — HTTP 401/403, or any `code` in
 *                            {@link AUTH_ERROR_CODES}. A revoked/incorrect
 *                            key pair returns 401 `woocommerce_rest_cannot_view`,
 *                            NOT an "authentication" code, so status is the
 *                            primary signal and code is a widener;
 * - `not_found`            — HTTP 404, or a `*_invalid_id` code (live:
 *                            `woocommerce_rest_shop_order_invalid_id`);
 * - `rate_limited`         — HTTP 429 (WooCommerce core does not throttle, but
 *                            hosts, WAFs, and the Store API rate limiter do),
 *                            or the local rate budget refusing a wait longer
 *                            than `maxWaitMs` (`detail.source =
 *                            "local_rate_budget"`);
 * - `invalid_request`      — other HTTP 4xx (live: 400 `rest_invalid_param`),
 *                            malformed local input/config;
 * - `provider_unavailable` — HTTP 5xx, network/timeout failures, non-JSON
 *                            bodies (a WordPress fatal error or a host's HTML
 *                            block page), unclassifiable errors.
 *
 * CREDENTIAL CONTAINMENT is structural, not filtered:
 *
 * - the adapter puts the consumer key/secret in an `Authorization` header
 *   only — never in a URL, query string, or body — so no request-derived
 *   string reachable from here can contain them;
 * - `detail` copies only `code`, `message`, and `data.status` from the
 *   provider body, plus the HTTP status and the request PATH (never the query
 *   string, never headers, never the `Request`/`Response` object, never the
 *   raw body). `data.params` / `data.details` are deliberately NOT copied:
 *   they echo caller-supplied parameter values back, which is the one place a
 *   provider body can quote our own input.
 */

export const WOO_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type WooErrorKind = (typeof WOO_ERROR_KINDS)[number];

export class WooAdapterError extends Error {
  readonly kind: WooErrorKind;
  /** Sanitized provider evidence — never headers, query strings, or creds. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: WooErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WooAdapterError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * WordPress/WooCommerce error codes that mean "these credentials cannot do
 * this", whatever status accompanies them. `woocommerce_rest_cannot_view` is
 * the code a read-only-but-wrong key pair produces (observed live with 401),
 * and WordPress emits `rest_forbidden*` for capability failures.
 */
const AUTH_ERROR_CODES = new Set([
  "woocommerce_rest_authentication_error",
  "woocommerce_rest_cannot_view",
  "woocommerce_rest_cannot_edit",
  "woocommerce_rest_cannot_create",
  "woocommerce_rest_cannot_delete",
  "woocommerce_rest_cannot_batch",
  "rest_forbidden",
  "rest_forbidden_context",
  "rest_not_logged_in",
  "rest_cannot_view",
]);

/** WordPress signals "you asked for a page past the end" as a 400. */
const PAGE_OUT_OF_RANGE_CODES = new Set([
  "rest_post_invalid_page_number",
  "rest_invalid_page_number",
  "woocommerce_rest_invalid_page_number",
]);

export function isPageOutOfRangeCode(code: string | null): boolean {
  return code !== null && PAGE_OUT_OF_RANGE_CODES.has(code);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The `{code, message, data:{status}}` triple, and nothing else. */
export interface WooProviderErrorBody {
  code: string | null;
  message: string | null;
  status: number | null;
  /** Parameter NAMES only from `data.params` — never their values. */
  invalidParams: string[];
}

/**
 * Extract the WordPress error triple from an already-parsed JSON body.
 * Returns all-null for any body that is not shaped like a WP REST error;
 * never throws, and never returns provider-supplied values beyond the three
 * documented fields plus `data.params` KEYS.
 */
export function readWooErrorBody(body: unknown): WooProviderErrorBody {
  const empty: WooProviderErrorBody = {
    code: null,
    message: null,
    status: null,
    invalidParams: [],
  };
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return empty;
  }
  const record = body as Record<string, unknown>;
  const data =
    typeof record["data"] === "object" &&
    record["data"] !== null &&
    !Array.isArray(record["data"])
      ? (record["data"] as Record<string, unknown>)
      : null;
  const status = data?.["status"];
  const params = data?.["params"];
  return {
    code: asString(record["code"]),
    message: asString(record["message"]),
    status: typeof status === "number" ? status : null,
    invalidParams:
      typeof params === "object" && params !== null && !Array.isArray(params)
        ? Object.keys(params as Record<string, unknown>)
        : [],
  };
}

export function wooKindFromStatus(
  status: number | undefined,
  code: string | null,
): WooErrorKind {
  if (code !== null && AUTH_ERROR_CODES.has(code)) return "auth";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (code !== null && code.endsWith("_invalid_id")) return "not_found";
  if (status !== undefined && status >= 400 && status < 500) {
    return "invalid_request";
  }
  return "provider_unavailable";
}

export interface WooErrorContext {
  /** Adapter operation label, e.g. `orders.list`. Never a URL. */
  operation: string;
  /** Request path WITHOUT query string, e.g. `/wp-json/wc/v3/orders`. */
  path: string;
}

/**
 * Build the adapter error for a non-2xx provider response. `body` is the
 * already-parsed JSON payload (or `null` when the body was not JSON).
 */
export function wooErrorFromResponse(
  status: number,
  body: unknown,
  context: WooErrorContext,
): WooAdapterError {
  const parsed = readWooErrorBody(body);
  const kind = wooKindFromStatus(status, parsed.code);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (parsed.code !== null) detail["providerCode"] = parsed.code;
  if (parsed.message !== null) detail["providerMessage"] = parsed.message;
  if (parsed.status !== null && parsed.status !== status) {
    detail["providerStatus"] = parsed.status;
  }
  if (parsed.invalidParams.length > 0) {
    detail["invalidParams"] = parsed.invalidParams;
  }
  if (parsed.code === null && parsed.message === null) {
    detail["providerBodyShape"] = "not-a-wp-rest-error";
  }
  return new WooAdapterError(
    kind,
    `WooCommerce API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts,
 * JSON parse failures) into a {@link WooAdapterError}. Non-Error values and
 * unknown Errors are reduced to name/message/code — their properties (which
 * for `fetch` can include the `Request`, and thus the Authorization header)
 * are deliberately dropped.
 */
export function normalizeWooError(
  error: unknown,
  context: WooErrorContext,
): WooAdapterError {
  if (error instanceof WooAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new WooAdapterError(
        "provider_unavailable",
        "WooCommerce request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new WooAdapterError(
      "provider_unavailable",
      "WooCommerce request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        // `fetch` failures carry the useful detail on `cause` (ENOTFOUND,
        // ECONNREFUSED, CERT_HAS_EXPIRED, …). Message text is safe: it never
        // contains request headers.
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new WooAdapterError(
    "provider_unavailable",
    "WooCommerce request failed with a non-Error value",
    base,
  );
}
