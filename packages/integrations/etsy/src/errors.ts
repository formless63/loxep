/**
 * Loxep error taxonomy for the Etsy integration boundary (ADR-0009).
 *
 * Same shape as the eBay/WooCommerce/Medusa/Invoice Ninja adapters'
 * taxonomies — a small, stable `kind` plus a sanitized `detail` record — so
 * callers can branch on one vocabulary across providers. The taxonomy is
 * deliberately DUPLICATED rather than shared: `@loxep/integration-etsy` must
 * not depend on any sibling integration package, and a shared
 * `@loxep/integration-core` would make every provider's error surface a
 * shared upgrade hazard.
 *
 * ## Etsy's error envelope
 *
 * Per the binding design
 * (`apps/docs/src/content/docs/architecture/etsy-integration-design.md`,
 * "Error shape"): Etsy Open API v3 returns `{"error": "<message>"}` on every
 * non-2xx response, with no structured `errorCode` enum comparable to eBay's
 * Browse `errorId` or WooCommerce's `code` field. Classification is therefore
 * HTTP-STATUS-FIRST, the same discipline the skill recommends for a provider
 * with no richer envelope (closer to Medusa/Invoice Ninja's taxonomies than
 * eBay's exception-class-based one):
 *
 * ```text
 * 401                          -> auth
 * 403                          -> auth   (Etsy uses 403 for scope/permission
 *                                         failures too, not only 401 — both
 *                                         map to the same kind, so this is
 *                                         safe either way; confirm the exact
 *                                         split during live verification)
 * 404                          -> not_found
 * 429                          -> rate_limited (detail.retryAfterSeconds from
 *                                         the `retry-after` header, per the
 *                                         design)
 * other 4xx                    -> invalid_request
 * 5xx / network / unparseable  -> provider_unavailable
 * ```
 *
 * CREDENTIAL CONTAINMENT is structural, not filtered: the application keyset
 * goes into the `x-api-key` header ONLY and the OAuth bearer goes into
 * `Authorization` ONLY — never a URL, query string, or body — so no
 * request-derived string reachable from here can contain either. `detail`
 * copies only the HTTP status, the request path, and the provider's own
 * `error` message string — never headers, never the query string, never a
 * `Request`/`Response` object.
 */

export const ETSY_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type EtsyErrorKind = (typeof ETSY_ERROR_KINDS)[number];

export class EtsyAdapterError extends Error {
  readonly kind: EtsyErrorKind;
  /** Sanitized provider evidence — never headers, query strings, or creds. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: EtsyErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EtsyAdapterError";
    this.kind = kind;
    this.detail = detail;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The one field Etsy's error envelope carries. */
export interface EtsyProviderErrorBody {
  message: string | null;
}

/**
 * Extract Etsy's `{error: "..."}` shape from an already-parsed JSON body.
 * Returns `message: null` for any body that is not shaped like one; never
 * throws.
 */
export function readEtsyErrorBody(body: unknown): EtsyProviderErrorBody {
  const record = asRecord(body);
  if (record === null) return { message: null };
  return { message: asString(record["error"]) };
}

export function etsyKindFromStatus(status: number | undefined): EtsyErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 400 && status < 500) {
    return "invalid_request";
  }
  return "provider_unavailable";
}

export interface EtsyErrorContext {
  /** Adapter operation label, e.g. `listings.get`. Never a URL. */
  operation: string;
  /** Request path WITHOUT query string, e.g. `/v3/application/listings/123`. */
  path: string;
}

/** Parse a `retry-after` header value into whole seconds, or `null`. */
export function parseRetryAfterSeconds(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  // RFC 7231 also allows an HTTP-date form; Etsy's docs promise seconds, but
  // parse defensively rather than silently dropping evidence.
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return null;
  const deltaMs = asDate - Date.now();
  return deltaMs > 0 ? Math.ceil(deltaMs / 1000) : 0;
}

/**
 * Build the adapter error for a non-2xx provider response. `body` is the
 * already-parsed JSON payload (or `null` when the body was not JSON).
 */
export function etsyErrorFromResponse(
  status: number,
  body: unknown,
  context: EtsyErrorContext,
  retryAfterHeader?: string | null,
): EtsyAdapterError {
  const parsed = readEtsyErrorBody(body);
  const kind = etsyKindFromStatus(status);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (parsed.message !== null) detail["providerMessage"] = parsed.message;
  if (parsed.message === null) {
    detail["providerBodyShape"] = "not-an-etsy-error";
  }
  if (kind === "rate_limited") {
    const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader ?? null);
    if (retryAfterSeconds !== null) {
      detail["retryAfterSeconds"] = retryAfterSeconds;
    }
  }
  return new EtsyAdapterError(
    kind,
    `Etsy API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts,
 * JSON parse failures) into an {@link EtsyAdapterError}. Non-Error values and
 * unknown Errors are reduced to name/message/code — their properties (which
 * for `fetch` can include the `Request`, and thus the `x-api-key`/
 * `Authorization` headers) are deliberately dropped.
 */
export function normalizeEtsyError(
  error: unknown,
  context: EtsyErrorContext,
): EtsyAdapterError {
  if (error instanceof EtsyAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new EtsyAdapterError(
        "provider_unavailable",
        "Etsy request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new EtsyAdapterError(
      "provider_unavailable",
      "Etsy request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new EtsyAdapterError(
    "provider_unavailable",
    "Etsy request failed with a non-Error value",
    base,
  );
}
