/**
 * Loxep error taxonomy for the Invoice Ninja integration boundary (ADR-0009).
 *
 * Same shape as the eBay/WooCommerce/Medusa adapters' taxonomies — a small,
 * stable `kind` plus a sanitized `detail` record — so callers can branch on
 * one vocabulary across providers. The taxonomy is deliberately DUPLICATED
 * rather than shared: `@loxep/integration-invoiceninja` must not depend on
 * `@loxep/integration-medusa`/`-woo`/`-ebay`, and a shared
 * `@loxep/integration-core` would make every provider's error surface a
 * shared upgrade hazard.
 *
 * ## The auth failure — LIVE-VERIFIED AND SOURCE-VERIFIED
 *
 * Invoice Ninja v5's API middleware (`App\Http\Middleware\TokenAuth`,
 * `invoiceninja/invoiceninja`, `v5-stable` branch, fetched 2026-08-13:
 * https://github.com/invoiceninja/invoiceninja/blob/v5-stable/app/Http/Middleware/TokenAuth.php)
 * rejects a missing or unrecognized `X-API-TOKEN` header with:
 *
 * ```text
 * HTTP 403   {"message": "Invalid token"}
 * ```
 *
 * before the request reaches any resource controller — so this is the ONE
 * shape every unauthenticated/misauthenticated call produces, regardless of
 * endpoint. A live unauthenticated probe confirmed that representative API
 * endpoints return `HTTP 403 {"message":"Invalid token"}`. Only this
 * auth-failure path is live-verified; every other classification below is
 * sourced from Invoice Ninja's own code and standard Laravel behavior.
 *
 * `App\Models\User::isActive()`/inactive-user and locked-company-user paths
 * in the same middleware return the SAME 403 status with a different
 * `message` (`"User inactive"`, `"User access locked"`) — this adapter
 * classifies all of them as `auth`, since none is something a caller can
 * retry without fixing the credential.
 *
 * ## Everything else — Laravel's own framework conventions (not live-probed)
 *
 * - **404** — Laravel's route-model-binding failure
 *   (`ModelNotFoundException`) renders as JSON because this adapter always
 *   sends `Accept: application/json`, which Laravel's exception handler
 *   treats as `expectsJson()`. Standard shape:
 *   `{"message": "No query results for model [...] <id>."}`.
 * - **422** — a `FormRequest` validation failure (e.g. an invalid `client_id`
 *   on invoice creation) renders `{"message": "The given data was invalid.",
 *   "errors": {"<field>": ["<message>", ...]}}` — Laravel's standard
 *   `invalidJson()` shape. The `errors` object describes the PAYLOAD Loxep
 *   itself submitted (a missing field, a bad enum value), never provider
 *   customer data, so this adapter's `detail.providerErrors` copies the
 *   FIELD NAMES only, never the message text (which could theoretically echo
 *   submitted content back).
 * - **429** — every `/api/v1/*` route Loxep calls sits behind Laravel's
 *   `throttle:api` middleware (confirmed in source:
 *   `routes/api.php`, `v5-stable`, fetched 2026-08-13 —
 *   `Route::group(['middleware' => ['throttle:api', 'token_auth', ...]], ...)`),
 *   so a 429 is a real possible response from a self-hosted instance under
 *   load, even though this adapter's own {@link RateBudget} is meant to make
 *   it rare.
 * - **5xx / network / non-JSON** — `provider_unavailable`, same as every
 *   other adapter in this codebase.
 *
 * CREDENTIAL CONTAINMENT is structural, not filtered:
 *
 * - the API token goes into an `X-API-TOKEN` header ONLY — never in a URL,
 *   query string, or body — so no request-derived string reachable from here
 *   can contain it;
 * - `detail` copies only the HTTP status, the request path, the provider
 *   `message` string, and (for 422) validation FIELD NAMES — never headers,
 *   never the query string, never the raw response body, never a `Request`/
 *   `Response` object.
 */

export const INVOICENINJA_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type InvoiceNinjaErrorKind = (typeof INVOICENINJA_ERROR_KINDS)[number];

export class InvoiceNinjaAdapterError extends Error {
  readonly kind: InvoiceNinjaErrorKind;
  /** Sanitized provider evidence — never headers, query strings, or creds. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: InvoiceNinjaErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "InvoiceNinjaAdapterError";
    this.kind = kind;
    this.detail = detail;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The `{message, errors?}` pair every Invoice Ninja error body carries. */
export interface InvoiceNinjaProviderErrorBody {
  message: string | null;
  /** Field names only (from a 422 `errors` map) — never the message text. */
  errorFields: string[];
}

/**
 * Extract the Invoice Ninja error shape from an already-parsed JSON body.
 * Returns all-empty for any body that is not shaped like one; never throws.
 */
export function readInvoiceNinjaErrorBody(
  body: unknown,
): InvoiceNinjaProviderErrorBody {
  const empty: InvoiceNinjaProviderErrorBody = {
    message: null,
    errorFields: [],
  };
  const record = asRecord(body);
  if (record === null) return empty;
  const errors = asRecord(record["errors"]);
  return {
    message: asString(record["message"]),
    errorFields: errors === null ? [] : Object.keys(errors),
  };
}

export function invoiceNinjaKindFromStatus(
  status: number | undefined,
): InvoiceNinjaErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 400 && status < 500) {
    return "invalid_request";
  }
  return "provider_unavailable";
}

export interface InvoiceNinjaErrorContext {
  /** Adapter operation label, e.g. `invoices.create`. Never a URL. */
  operation: string;
  /** Request path WITHOUT query string, e.g. `/api/v1/invoices`. */
  path: string;
}

/**
 * Build the adapter error for a non-2xx provider response. `body` is the
 * already-parsed JSON payload (or `null` when the body was not JSON).
 */
export function invoiceNinjaErrorFromResponse(
  status: number,
  body: unknown,
  context: InvoiceNinjaErrorContext,
): InvoiceNinjaAdapterError {
  const parsed = readInvoiceNinjaErrorBody(body);
  const kind = invoiceNinjaKindFromStatus(status);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (parsed.message !== null) detail["providerMessage"] = parsed.message;
  if (parsed.errorFields.length > 0) {
    detail["providerErrorFields"] = parsed.errorFields;
  }
  if (parsed.message === null && parsed.errorFields.length === 0) {
    detail["providerBodyShape"] = "not-an-invoiceninja-error";
  }
  return new InvoiceNinjaAdapterError(
    kind,
    `Invoice Ninja API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts,
 * JSON parse failures) into an {@link InvoiceNinjaAdapterError}. Non-Error
 * values and unknown Errors are reduced to name/message/code — their
 * properties (which for `fetch` can include the `Request`, and thus the
 * `X-API-TOKEN` header) are deliberately dropped.
 */
export function normalizeInvoiceNinjaError(
  error: unknown,
  context: InvoiceNinjaErrorContext,
): InvoiceNinjaAdapterError {
  if (error instanceof InvoiceNinjaAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new InvoiceNinjaAdapterError(
        "provider_unavailable",
        "Invoice Ninja request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new InvoiceNinjaAdapterError(
      "provider_unavailable",
      "Invoice Ninja request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new InvoiceNinjaAdapterError(
    "provider_unavailable",
    "Invoice Ninja request failed with a non-Error value",
    base,
  );
}
