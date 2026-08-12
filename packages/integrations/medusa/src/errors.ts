/**
 * Loxep error taxonomy for the Medusa integration boundary (ADR-0009).
 *
 * Same shape as the eBay and WooCommerce adapters' taxonomies — a small,
 * stable `kind` plus a sanitized `detail` record — so callers can branch on
 * one vocabulary across providers. The taxonomy is deliberately DUPLICATED
 * rather than shared: `@loxep/integration-medusa` must not depend on
 * `@loxep/integration-woo` or `@loxep/integration-ebay`, and a shared
 * `@loxep/integration-core` would make every provider's error surface a
 * shared upgrade hazard.
 *
 * Medusa v2's Admin API error envelope is **not uniform**. The three shapes
 * below were observed live against Medusa 2.18.0 (loxep-xh9.4.1), and they
 * are the reason this module classifies primarily by HTTP STATUS and treats
 * `type`/`code` as optional wideners:
 *
 * ```text
 * 401 bad/absent secret key   {"message": "…"}                         ← no type, NO code
 * 404 unknown order id        {"type":"not_found","message":"…"}       ← no code
 * 500 bad `order=` sort key   {"code":"unknown_error","type":"unknown_error","message":"…"}
 * ```
 *
 * The 401 is the important one: it is emitted by the authenticate middleware
 * BEFORE the `errorHandler` that builds `{code, type, message}`, so an auth
 * failure carries a bare `message` and nothing else. Any consumer that
 * branches on `detail.providerCode` for an auth error will find it absent —
 * `detail.httpStatus` is the reliable signal. (The bearer-token rejection is
 * a genuinely useful message, though: *"A secret API key was passed as a
 * Bearer token. Secret API keys must be sent using HTTP Basic authentication
 * instead (Authorization: Basic <secret-api-key>)."*)
 *
 * The framework-source reading that produced the original single-shape claim
 * follows; it describes the `errorHandler` branch only:
 *
 * Source: `errorHandler()` in
 * https://github.com/medusajs/medusa/blob/develop/packages/core/framework/src/http/middlewares/error-handler.ts
 * (fetched against the `develop` branch, 2026-08-11). The handler maps
 * `MedusaError.Types` to HTTP status and an `errObj = { code, type, message }`
 * body:
 *
 * ```text
 * MedusaError.Types.UNAUTHORIZED          → 401
 * MedusaError.Types.FORBIDDEN             → 403
 * MedusaError.Types.NOT_FOUND             → 404
 * MedusaError.Types.CONFLICT              → 409 (code: invalid_state_error)
 * MedusaError.Types.DUPLICATE_ERROR       → 422 (code: invalid_request_error)
 * MedusaError.Types.NOT_ALLOWED           → 400
 * MedusaError.Types.INVALID_DATA          → 400
 * MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR → 422
 * MedusaError.Types.DB_ERROR              → 500 (code: api_error)
 * (unmatched)                             → 500, type/code "unknown_error"
 * ```
 *
 * Body-parser-level failures (malformed JSON, oversized body) go through a
 * separate branch that emits `{ message, type }` with no `code`, at whatever
 * HTTP status `http-errors` assigned.
 *
 * Classification here is primary-by-HTTP-STATUS — a choice the live run
 * vindicated, since `type` and `code` are both absent from the one error a
 * connection surface cares most about (401) — with `type` as a widener:
 *
 * - `auth`                 — HTTP 401/403, or `type` in
 *                            {@link AUTH_ERROR_TYPES};
 * - `not_found`            — HTTP 404, or `type === "not_found"`;
 * - `rate_limited`         — HTTP 429 (no Medusa core error type maps here in
 *                            the source above; a reverse proxy/CDN in front
 *                            of a self-hosted deployment is the realistic
 *                            source), or the local rate budget refusing a
 *                            wait longer than `maxWaitMs`
 *                            (`detail.source = "local_rate_budget"`);
 * - `invalid_request`      — other HTTP 4xx (400/409/422 — invalid_data,
 *                            conflict, duplicate_error, not_allowed),
 *                            malformed local input/config;
 * - `provider_unavailable` — HTTP 5xx, network/timeout failures, non-JSON
 *                            bodies, unclassifiable errors; ALSO the kind
 *                            `orders.ts`'s watermark fail-open canary throws
 *                            when a `updated_at[$gte]`-filtered response
 *                            contains an order older than the watermark — a
 *                            live-verified case of the provider silently
 *                            returning unfiltered results as if they were
 *                            filtered, which this package treats the same as
 *                            any other "cannot trust this response" failure.
 *
 * CREDENTIAL CONTAINMENT is structural, not filtered:
 *
 * - the adapter puts the secret API token in an `Authorization` header only
 *   — never in a URL, query string, or body — so no request-derived string
 *   reachable from here can contain it;
 * - `detail` copies only `type`, `message`, and `code` from the provider
 *   body, plus the HTTP status and the request PATH (never the query string,
 *   never headers, never the `Request`/`Response` object, never the raw
 *   body).
 */

export const MEDUSA_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type MedusaErrorKind = (typeof MEDUSA_ERROR_KINDS)[number];

export class MedusaAdapterError extends Error {
  readonly kind: MedusaErrorKind;
  /** Sanitized provider evidence — never headers, query strings, or creds. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: MedusaErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MedusaAdapterError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * Medusa `MedusaError.Types` values that mean "this credential cannot do
 * this", independent of the status Loxep also checks. `forbidden` is not in
 * the enum documented on the `Error` schema's `type` field but the source's
 * `switch` sets HTTP 403 for `MedusaError.Types.FORBIDDEN`; the emitted
 * `err.type` for that case is whatever the thrower set, commonly
 * `"forbidden"` — included defensively.
 */
const AUTH_ERROR_TYPES = new Set(["unauthorized", "forbidden"]);

/** Medusa error `type` values that are ordinary invalid-request 4xx. */
const INVALID_REQUEST_TYPES = new Set([
  "invalid_data",
  "not_allowed",
  "conflict",
  "duplicate_error",
  "invalid_state_error",
  "invalid_request_error",
  "payment_authorization_error",
]);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The `{type, message, code}` triple, and nothing else. */
export interface MedusaProviderErrorBody {
  type: string | null;
  message: string | null;
  code: string | null;
}

/**
 * Extract the Medusa error triple from an already-parsed JSON body. Returns
 * all-null for any body that is not shaped like a Medusa error; never
 * throws, and never returns provider-supplied values beyond the three
 * documented fields.
 */
export function readMedusaErrorBody(body: unknown): MedusaProviderErrorBody {
  const empty: MedusaProviderErrorBody = {
    type: null,
    message: null,
    code: null,
  };
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return empty;
  }
  const record = body as Record<string, unknown>;
  return {
    type: asString(record["type"]),
    message: asString(record["message"]),
    code: asString(record["code"]),
  };
}

export function medusaKindFromStatus(
  status: number | undefined,
  type: string | null,
): MedusaErrorKind {
  if (type !== null && AUTH_ERROR_TYPES.has(type)) return "auth";
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || type === "not_found") return "not_found";
  if (status === 429) return "rate_limited";
  if (type !== null && INVALID_REQUEST_TYPES.has(type)) return "invalid_request";
  if (status !== undefined && status >= 400 && status < 500) {
    return "invalid_request";
  }
  return "provider_unavailable";
}

export interface MedusaErrorContext {
  /** Adapter operation label, e.g. `orders.list`. Never a URL. */
  operation: string;
  /** Request path WITHOUT query string, e.g. `/admin/orders`. */
  path: string;
}

/**
 * Build the adapter error for a non-2xx provider response. `body` is the
 * already-parsed JSON payload (or `null` when the body was not JSON).
 */
export function medusaErrorFromResponse(
  status: number,
  body: unknown,
  context: MedusaErrorContext,
): MedusaAdapterError {
  const parsed = readMedusaErrorBody(body);
  const kind = medusaKindFromStatus(status, parsed.type);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (parsed.type !== null) detail["providerType"] = parsed.type;
  if (parsed.code !== null) detail["providerCode"] = parsed.code;
  if (parsed.message !== null) detail["providerMessage"] = parsed.message;
  if (parsed.type === null && parsed.message === null) {
    detail["providerBodyShape"] = "not-a-medusa-error";
  }
  return new MedusaAdapterError(
    kind,
    `Medusa API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts,
 * JSON parse failures) into a {@link MedusaAdapterError}. Non-Error values
 * and unknown Errors are reduced to name/message/code — their properties
 * (which for `fetch` can include the `Request`, and thus the Authorization
 * header) are deliberately dropped.
 */
export function normalizeMedusaError(
  error: unknown,
  context: MedusaErrorContext,
): MedusaAdapterError {
  if (error instanceof MedusaAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new MedusaAdapterError(
        "provider_unavailable",
        "Medusa request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new MedusaAdapterError(
      "provider_unavailable",
      "Medusa request failed before a provider response was classified",
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
  return new MedusaAdapterError(
    "provider_unavailable",
    "Medusa request failed with a non-Error value",
    base,
  );
}
