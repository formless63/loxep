/**
 * Loxep error taxonomy for the eBay integration boundary (ADR-0009).
 *
 * Every error leaving this package is an {@link EbayAdapterError} with a
 * small, stable `kind`. Provider evidence is retained in `detail`, but the
 * normalizer structurally excludes anything that can carry credential
 * material: request/response headers, request config, and raw response
 * bodies are never copied into `detail` — only the extracted provider error
 * message/description/code, HTTP status, and the provider's own first error
 * object (an error body, which by construction contains no keyset values).
 *
 * Classification (verified against ebay-api@10.0.0 `dist/errors`):
 *
 * - `auth` — the library's token/grant/scope error classes
 *   (EBayAccessDenied, EBayInvalidGrant, EBayInvalidAccessToken,
 *   EBayInvalidScope, EBayIAFTokenExpired, EBayIAFTokenInvalid,
 *   EBayAuthTokenIsInvalid, EBayAuthTokenIsHardExpired, EBayTokenRequired)
 *   or HTTP 401/403;
 * - `not_found` — EBayNotFound, Browse errorId 11001, or HTTP 404;
 * - `rate_limited` — HTTP 429, or the local rate budget refusing a wait
 *   longer than `maxWaitMs` (detail.source = "local_rate_budget");
 * - `invalid_request` — other HTTP 4xx, malformed local input;
 * - `provider_unavailable` — HTTP 5xx, network failures, unclassifiable
 *   errors, unusable provider payloads.
 */
import { errors as ebayErrors } from "ebay-api";

export const EBAY_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type EbayErrorKind = (typeof EBAY_ERROR_KINDS)[number];

export class EbayAdapterError extends Error {
  readonly kind: EbayErrorKind;
  /** Sanitized provider evidence — never headers, request config, or creds. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: EbayErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EbayAdapterError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** Browse "item not found" errorId (EBayNotFound.code in ebay-api). */
const NOT_FOUND_ERROR_ID = 11001;

/**
 * RFC 6749 error codes eBay's identity endpoint returns for credential,
 * grant, and consent failures — all of them mean "the token/keyset is not
 * usable", i.e. Loxep's `auth` kind, whatever HTTP status accompanies them.
 */
const OAUTH_AUTH_ERROR_CODES = new Set([
  "invalid_client",
  "invalid_grant",
  "invalid_scope",
  "unauthorized_client",
  "access_denied",
  "insufficient_scope",
]);

const AUTH_ERROR_CLASSES = [
  ebayErrors.EBayAccessDenied,
  ebayErrors.EBayInvalidGrant,
  ebayErrors.EBayInvalidAccessToken,
  ebayErrors.EBayInvalidScope,
  ebayErrors.EBayIAFTokenExpired,
  ebayErrors.EBayIAFTokenInvalid,
  ebayErrors.EBayAuthTokenIsInvalid,
  ebayErrors.EBayAuthTokenIsHardExpired,
  ebayErrors.EBayTokenRequired,
] as const;

function httpStatusOf(error: InstanceType<typeof ebayErrors.EBayError>): {
  status: number | undefined;
  statusText: string | undefined;
} {
  const meta = error.meta as { res?: { status?: number; statusText?: string } };
  return { status: meta?.res?.status, statusText: meta?.res?.statusText };
}

/**
 * Copy only structurally credential-free provider evidence. `firstError` is
 * the provider's own parsed error body entry (message/longMessage/errorId or
 * OAuth error/error_description) — never request material.
 */
function sanitizedDetail(
  error: InstanceType<typeof ebayErrors.EbayApiError>,
): Record<string, unknown> {
  const { status, statusText } = httpStatusOf(error);
  const detail: Record<string, unknown> = {
    providerMessage: error.message,
  };
  if (error.description) detail["providerDescription"] = error.description;
  if (error.errorCode !== undefined) {
    detail["providerErrorCode"] = error.errorCode;
  }
  if (status !== undefined) detail["httpStatus"] = status;
  if (statusText !== undefined) detail["httpStatusText"] = statusText;
  if (error.firstError !== undefined) {
    detail["firstError"] = structuredClone(error.firstError);
  }
  return detail;
}

function kindFromStatus(
  status: number | undefined,
  errorCode: number | undefined,
): EbayErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || errorCode === NOT_FOUND_ERROR_ID) return "not_found";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 400 && status < 500) {
    return "invalid_request";
  }
  return "provider_unavailable";
}

/**
 * Normalize any error thrown by the ebay-api client (or the transport
 * beneath it) into an {@link EbayAdapterError}. Non-library errors are
 * reduced to name/code/message only — their properties (axios config,
 * headers, tokens) are deliberately dropped.
 */
export function normalizeEbayError(error: unknown): EbayAdapterError {
  if (error instanceof EbayAdapterError) {
    return error;
  }
  if (error instanceof ebayErrors.EbayApiError) {
    if (AUTH_ERROR_CLASSES.some((authClass) => error instanceof authClass)) {
      return new EbayAdapterError(
        "auth",
        "eBay rejected the request credentials/token",
        sanitizedDetail(error),
      );
    }
    if (error instanceof ebayErrors.EBayNotFound) {
      return new EbayAdapterError(
        "not_found",
        "eBay reports the requested resource does not exist",
        sanitizedDetail(error),
      );
    }
    const { status } = httpStatusOf(error);
    const kind = kindFromStatus(status, error.errorCode);
    return new EbayAdapterError(
      kind,
      `eBay API error (${kind})`,
      sanitizedDetail(error),
    );
  }
  if (error instanceof ebayErrors.EBayError) {
    // EBayNoCallError / ApiEnvError / plain EBayError: local misuse.
    return new EbayAdapterError("invalid_request", error.message, {
      providerMessage: error.message,
      ...(error.description ? { providerDescription: error.description } : {}),
    });
  }
  if (error instanceof Error) {
    // The library's OAuth mint path (verified in ebay-api@10.0.0
    // dist/auth/oAuth2.js) rethrows the RAW transport error without
    // wrapping it. Classify by HTTP status when one is present; the OAuth
    // error body's `error`/`error_description` strings are the only
    // response fields copied (never headers, config, or full bodies).
    const response = (
      error as { response?: { status?: unknown; data?: unknown } }
    ).response;
    if (typeof response?.status === "number") {
      const status = response.status;
      const data = response.data as
        | { error?: unknown; error_description?: unknown }
        | undefined;
      // eBay's identity endpoint reports grant/scope failures as HTTP 400
      // with an RFC 6749 `error` code. Those are credential problems, not
      // malformed requests: an expired refresh token must surface as `auth`
      // so callers re-request consent instead of retrying forever.
      const kind =
        typeof data?.error === "string" && OAUTH_AUTH_ERROR_CODES.has(data.error)
          ? "auth"
          : kindFromStatus(status, undefined);
      return new EbayAdapterError(kind, `eBay HTTP ${status} (${kind})`, {
        httpStatus: status,
        ...(typeof data?.error === "string"
          ? { providerMessage: data.error }
          : {}),
        ...(typeof data?.error_description === "string"
          ? { providerDescription: data.error_description }
          : {}),
      });
    }
    const code = (error as { code?: unknown }).code;
    return new EbayAdapterError(
      "provider_unavailable",
      "eBay request failed before a provider response was classified",
      {
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
      },
    );
  }
  return new EbayAdapterError(
    "provider_unavailable",
    "eBay request failed with a non-Error value",
    {},
  );
}
