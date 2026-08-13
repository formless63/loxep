/**
 * Loxep error taxonomy for the Reverb integration boundary (ADR-0009).
 *
 * Same shape as the eBay/WooCommerce/Medusa/Etsy/Invoice Ninja adapters'
 * taxonomies — a small, stable `kind` plus a sanitized `detail` record — so
 * callers can branch on one vocabulary across providers. The taxonomy is
 * deliberately DUPLICATED rather than shared: `@loxep/integration-reverb`
 * must not depend on any sibling integration package, and a shared
 * `@loxep/integration-core` would make every provider's error surface a
 * shared upgrade hazard.
 *
 * ## Reverb's error envelope — SOURCE-VERIFIED
 *
 * Per the binding design
 * (`apps/docs/src/content/docs/architecture/reverb-integration-design.md`,
 * "Error shape", sourced from
 * https://www.reverb-api.com/docs/error-handling, fetched 2026-08-13):
 * `{"message": "<human summary>", "errors": {"<field>": ["<message>", ...]}}`.
 * `errors` is present only for field-level validation failures; `message`
 * is always present. There is no structured error-code enum, so
 * classification is HTTP-STATUS-FIRST, matching `@loxep/integration-etsy`'s
 * discipline for a provider with no richer envelope:
 *
 * ```text
 * 400                          -> invalid_request
 * 401                          -> auth
 * 403                          -> auth   (undocumented split from 401;
 *                                         both collapse to the same kind)
 * 404                          -> not_found
 * 412                          -> invalid_request (Reverb singles this out
 *                                         for a missing required parameter)
 * 429                          -> rate_limited
 * other 4xx                    -> invalid_request
 * 5xx / network / unparseable  -> provider_unavailable
 * ```
 *
 * Reverb documents no `Retry-After` header on its 429, unlike Etsy — a
 * `rate_limited` error's `detail` therefore never claims a
 * `retryAfterSeconds` the way Etsy's does; a caller that needs a wait hint
 * falls back to the local rate budget's own backoff.
 *
 * CREDENTIAL CONTAINMENT is structural, not filtered: the Personal Access
 * Token goes into the `Authorization` header ONLY — never a URL, query
 * string, or body — so no request-derived string reachable from here can
 * contain it. `detail` copies only the HTTP status, the request path, and
 * Reverb's own `message`/`errors` fields — never headers, never the query
 * string, never a `Request`/`Response` object.
 */

export const REVERB_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type ReverbErrorKind = (typeof REVERB_ERROR_KINDS)[number];

export class ReverbAdapterError extends Error {
  readonly kind: ReverbErrorKind;
  /** Sanitized provider evidence — never headers, query strings, or creds. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: ReverbErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ReverbAdapterError";
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

function asFieldErrors(value: unknown): Record<string, string[]> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const out: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(record)) {
    if (!Array.isArray(messages)) continue;
    const strings = messages.filter((entry): entry is string => typeof entry === "string");
    if (strings.length > 0) out[field] = strings;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The fields Reverb's error envelope carries. */
export interface ReverbProviderErrorBody {
  message: string | null;
  errors: Record<string, string[]> | null;
}

/**
 * Extract Reverb's `{message, errors}` shape from an already-parsed JSON
 * body. Returns nulls for any body that is not shaped like one; never
 * throws.
 */
export function readReverbErrorBody(body: unknown): ReverbProviderErrorBody {
  const record = asRecord(body);
  if (record === null) return { message: null, errors: null };
  return {
    message: asString(record["message"]),
    errors: asFieldErrors(record["errors"]),
  };
}

export function reverbKindFromStatus(status: number | undefined): ReverbErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 400 && status < 500) {
    return "invalid_request";
  }
  return "provider_unavailable";
}

export interface ReverbErrorContext {
  /** Adapter operation label, e.g. `listings.get`. Never a URL. */
  operation: string;
  /** Request path WITHOUT query string, e.g. `/listings/123`. */
  path: string;
}

/**
 * Build the adapter error for a non-2xx provider response. `body` is the
 * already-parsed JSON payload (or `null` when the body was not JSON).
 */
export function reverbErrorFromResponse(
  status: number,
  body: unknown,
  context: ReverbErrorContext,
): ReverbAdapterError {
  const parsed = readReverbErrorBody(body);
  const kind = reverbKindFromStatus(status);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (parsed.message !== null) detail["providerMessage"] = parsed.message;
  if (parsed.errors !== null) detail["providerFieldErrors"] = parsed.errors;
  if (parsed.message === null && parsed.errors === null) {
    detail["providerBodyShape"] = "not-a-reverb-error";
  }
  return new ReverbAdapterError(
    kind,
    `Reverb API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts,
 * JSON parse failures) into a {@link ReverbAdapterError}. Non-Error values
 * and unknown Errors are reduced to name/message/code — their properties
 * (which for `fetch` can include the `Request`, and thus the
 * `Authorization` header) are deliberately dropped.
 */
export function normalizeReverbError(
  error: unknown,
  context: ReverbErrorContext,
): ReverbAdapterError {
  if (error instanceof ReverbAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new ReverbAdapterError(
        "provider_unavailable",
        "Reverb request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new ReverbAdapterError(
      "provider_unavailable",
      "Reverb request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new ReverbAdapterError(
    "provider_unavailable",
    "Reverb request failed with a non-Error value",
    base,
  );
}
