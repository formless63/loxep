/**
 * Loxep error taxonomy for the Cloudflare integration boundary (ADR-0009).
 *
 * The same five-kind shape the eBay, WooCommerce, Medusa, Invoice Ninja, and
 * Etsy adapters carry — a small stable `kind` plus a sanitized `detail`
 * record — so callers branch on one vocabulary across providers. The
 * taxonomies are deliberately **DUPLICATED rather than shared**:
 * `@loxep/integration-cloudflare` must not depend on another integration
 * package, and a cross-integration base package would make every provider's
 * error surface a shared upgrade hazard.
 *
 * ## The envelope, and why status alone is not enough
 *
 * Cloudflare's REST API v4 is envelope-shaped. Every documented response
 * carries `success`, `errors`, and `messages`:
 *
 * ```json
 * {"success": false, "errors": [{"code": 6003, "message": "Invalid request headers",
 *   "error_chain": [{"code": 6111, "message": "Invalid format for Authorization header"}]}],
 *  "messages": [], "result": null}
 * ```
 *
 * The design's own warning applies directly: *"An RPC-style API that wraps
 * every response in a success/error envelope means HTTP 200 does not imply
 * success. The adapter must branch on the envelope, not the status code."*
 *
 * VERIFICATION NOTE (checked against developers.cloudflare.com and the
 * official `cloudflare/api-schemas` OpenAPI document, `info.version` 4.0.0,
 * on 2026-08-13): the published schema models 200 as `success: true` and
 * failures as 4xx with `success: false`, and **no documentation sentence
 * confirms that a 200 can carry `success: false`**. This adapter still checks
 * the envelope on every response, because a defensive check costs nothing and
 * the failure mode it prevents — treating an error as a success — is silent.
 * Do not read that as a documented behavior; it is not.
 *
 * `errors[].error_chain` is **observed live but absent from the published
 * schema**, so it is parsed optionally and never required.
 *
 * ## Classification
 *
 * - `auth`                 — HTTP 401 or 403, or an envelope code in
 *                            {@link CLOUDFLARE_AUTH_ERROR_CODES}. Cloudflare's
 *                            documentation assigns 401 to "not sent with the
 *                            proper authentication credentials" and 403 to
 *                            "the token does not have the required
 *                            permissions", but a live probe with a garbage
 *                            token answered **403**, and one with a malformed
 *                            `Authorization` header answered **400** with code
 *                            6003/6111 — so neither status nor code alone is
 *                            sufficient and both are consulted;
 * - `not_found`            — HTTP 404, or envelope code 7003 ("No route for
 *                            the URI");
 * - `rate_limited`         — HTTP 429, or the local rate budget refusing a
 *                            wait longer than `maxWaitMs`
 *                            (`detail.source = "local_rate_budget"`);
 * - `invalid_request`      — other HTTP 4xx, malformed local input/config;
 * - `provider_unavailable` — HTTP 5xx, network/timeout failures, non-JSON
 *                            bodies, an envelope Loxep cannot parse.
 *
 * ## Credential containment is structural, not filtered
 *
 * - the API token goes into an `Authorization: Bearer` header ONLY — never a
 *   URL, query string, or body — so no request-derived string reachable from
 *   this module can structurally contain it;
 * - `detail` copies only the HTTP status, the adapter operation label, the
 *   request PATH (never the query string, never headers, never the
 *   `Request`/`Response` object, never the raw body), and the envelope's
 *   `code` + `message` pairs. `documentation_url` and `source.pointer` are
 *   copied because they are Cloudflare constants; nothing that echoes
 *   caller-supplied values is copied.
 *
 * The one Cloudflare response that contains a long-lived credential is the
 * API-token create response (`result.value`, marked `x-sensitive` in the
 * published schema and returned exactly once). Nothing in this module ever
 * reads `result`, so a token value cannot reach an error detail. See
 * `redact.ts` for the response-summary half of the same rule.
 */

export const CLOUDFLARE_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type CloudflareErrorKind = (typeof CLOUDFLARE_ERROR_KINDS)[number];

export class CloudflareAdapterError extends Error {
  readonly kind: CloudflareErrorKind;
  /** Sanitized provider evidence — never headers, query strings, or creds. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: CloudflareErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CloudflareAdapterError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * Envelope codes that mean "these credentials cannot do this", whatever status
 * accompanies them.
 *
 * `10000` / `10001` appear as the authentication and forbidden examples
 * throughout Cloudflare's published OpenAPI document. `6003` (with its chained
 * `6111`), `9106`, and `9107` were observed live on 2026-08-13: `6003/6111` is
 * a malformed `Authorization` header, and `9106`/`9107` are what the API
 * answers when no token is sent at all — it falls back to expecting the legacy
 * `X-Auth-Email` / `X-Auth-Key` pair, which Loxep never sends.
 */
export const CLOUDFLARE_AUTH_ERROR_CODES: ReadonlySet<number> = new Set([
  10_000, 10_001, 6003, 6111, 9106, 9107,
]);

/** "No route for the URI" — Cloudflare's standard unroutable-path code. */
export const CLOUDFLARE_NO_ROUTE_CODE = 7003;

/**
 * DNS-record codes that mean "this record already exists".
 *
 * **EMPIRICALLY OBSERVED, NOT DOCUMENTED.** Cloudflare publishes no
 * consolidated REST error-code table and neither code appears in the official
 * OpenAPI document (checked 2026-08-13). They are widely reported
 * (81057 = "The record already exists", 81053 = "An A, AAAA or CNAME record
 * already exists with that host") and the reconciler uses them only to make a
 * retried create idempotent — never to decide correctness. If they change,
 * the retry re-reads and converges anyway.
 */
export const CLOUDFLARE_RECORD_EXISTS_CODES: ReadonlySet<number> = new Set([
  81_057, 81_053,
]);

/** One `{code, message}` pair from an envelope's `errors` array. */
export interface CloudflareEnvelopeError {
  code: number;
  message: string;
  /** Present live, absent from the published schema. Parsed optionally. */
  chain: Array<{ code: number; message: string }>;
  documentationUrl: string | null;
}

/**
 * The parsed envelope. `success` is `null` when the body was not shaped like a
 * Cloudflare envelope at all (an HTML block page, a proxy error, an empty
 * body).
 */
export interface CloudflareEnvelope {
  success: boolean | null;
  errors: CloudflareEnvelopeError[];
  result: unknown;
  resultInfo: {
    page: number | null;
    perPage: number | null;
    count: number | null;
    totalCount: number | null;
    totalPages: number | null;
  } | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readErrorList(value: unknown): CloudflareEnvelopeError[] {
  if (!Array.isArray(value)) return [];
  const out: CloudflareEnvelopeError[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const code = asInt(record["code"]);
    const message = record["message"];
    const documentationUrl = record["documentation_url"];
    out.push({
      code: code ?? 0,
      message: typeof message === "string" ? message : "",
      chain: readErrorList(record["error_chain"]).map((chained) => ({
        code: chained.code,
        message: chained.message,
      })),
      documentationUrl:
        typeof documentationUrl === "string" ? documentationUrl : null,
    });
  }
  return out;
}

/**
 * Parse a Cloudflare envelope out of an already-parsed JSON body. Never
 * throws; returns `success: null` for anything that is not envelope-shaped.
 */
export function readCloudflareEnvelope(body: unknown): CloudflareEnvelope {
  const record = asRecord(body);
  if (record === null) {
    return { success: null, errors: [], result: null, resultInfo: null };
  }
  const success = record["success"];
  const info = asRecord(record["result_info"]);
  return {
    success: typeof success === "boolean" ? success : null,
    errors: readErrorList(record["errors"]),
    result: record["result"] ?? null,
    resultInfo:
      info === null
        ? null
        : {
            page: asInt(info["page"]),
            perPage: asInt(info["per_page"]),
            count: asInt(info["count"]),
            totalCount: asInt(info["total_count"]),
            totalPages: asInt(info["total_pages"]),
          },
  };
}

/** Every code in the envelope, including chained ones. */
export function envelopeCodes(envelope: CloudflareEnvelope): number[] {
  const codes: number[] = [];
  for (const error of envelope.errors) {
    codes.push(error.code);
    for (const chained of error.chain) codes.push(chained.code);
  }
  return codes;
}

export function cloudflareKindFromStatus(
  status: number | undefined,
  codes: readonly number[],
): CloudflareErrorKind {
  for (const code of codes) {
    if (CLOUDFLARE_AUTH_ERROR_CODES.has(code)) return "auth";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  for (const code of codes) {
    if (code === CLOUDFLARE_NO_ROUTE_CODE) return "not_found";
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return "invalid_request";
  }
  if (status !== undefined && status >= 200 && status < 300) {
    // An envelope failure on a 2xx. Nothing else is known about it, so it is
    // reported as an invalid request rather than as an outage.
    return "invalid_request";
  }
  return "provider_unavailable";
}

export interface CloudflareErrorContext {
  /** Adapter operation label, e.g. `dns.records.list`. Never a URL. */
  operation: string;
  /** Request path WITHOUT query string, e.g. `/zones/{id}/dns_records`. */
  path: string;
}

/**
 * Build the adapter error for a failed response — either a non-2xx status or a
 * 2xx whose envelope reports `success: false`.
 */
export function cloudflareErrorFromResponse(
  status: number,
  envelope: CloudflareEnvelope,
  context: CloudflareErrorContext,
): CloudflareAdapterError {
  const codes = envelopeCodes(envelope);
  const kind = cloudflareKindFromStatus(status, codes);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (envelope.errors.length > 0) {
    detail["providerErrors"] = envelope.errors.map((error) => ({
      code: error.code,
      message: error.message,
      ...(error.chain.length > 0 ? { chain: error.chain } : {}),
      ...(error.documentationUrl !== null
        ? { documentationUrl: error.documentationUrl }
        : {}),
    }));
  }
  if (envelope.success === null) {
    detail["providerBodyShape"] = "not-a-cloudflare-envelope";
  } else if (envelope.success === false && status >= 200 && status < 300) {
    // The failure mode the design warns about, made visible rather than
    // silently swallowed.
    detail["envelopeFailureOnSuccessStatus"] = true;
  }
  return new CloudflareAdapterError(
    kind,
    `Cloudflare API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts,
 * JSON parse failures) into a {@link CloudflareAdapterError}. Non-Error values
 * and unknown Errors are reduced to name/message/code — their properties
 * (which for `fetch` can include the `Request`, and thus the Authorization
 * header) are deliberately dropped.
 */
export function normalizeCloudflareError(
  error: unknown,
  context: CloudflareErrorContext,
): CloudflareAdapterError {
  if (error instanceof CloudflareAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new CloudflareAdapterError(
        "provider_unavailable",
        "Cloudflare request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new CloudflareAdapterError(
      "provider_unavailable",
      "Cloudflare request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new CloudflareAdapterError(
    "provider_unavailable",
    "Cloudflare request failed with a non-Error value",
    base,
  );
}
