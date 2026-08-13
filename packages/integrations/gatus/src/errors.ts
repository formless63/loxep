/**
 * Loxep error taxonomy for the Gatus integration boundary (ADR-0009).
 *
 * The same five-kind shape every sibling adapter carries — a small stable
 * `kind` plus a sanitized `detail` record. Duplicated rather than shared, for
 * the same reason `packages/integrations/beszel/src/errors.ts` documents:
 * integration packages must not depend on each other.
 *
 * ## The envelope, verified 2026-08-13 against `github.com/TwiN/gatus` v5.36.0
 *
 * Gatus is **not** PocketBase's `{status, message, data}` shape. Its
 * `api/*.go` handlers answer failures with `c.Status(code).SendString(...)` —
 * a bare TEXT body, not JSON — except `api/config.go`'s marshal-failure path,
 * which is the one place a JSON `{"error": "..."}` body appears:
 *
 * ```go
 * // api/endpoint_status.go
 * return c.Status(500).SendString(err.Error())
 * if errors.Is(err, common.ErrEndpointNotFound) {
 *     return c.Status(404).SendString(err.Error())
 * }
 * // api/raw.go
 * default:
 *     return c.Status(400).SendString("Durations supported: 30d, 7d, 24h, 1h")
 * // security/config.go — Basic auth rejection
 * ctx.Set("WWW-Authenticate", "Basic")
 * return ctx.Status(401).SendString("Unauthorized")
 * ```
 *
 * So this module reads the body as text FIRST, and only tries to parse it as
 * JSON to see whether it is `config.go`'s `{"error": "..."}` shape; every
 * other case uses the raw text (trimmed, length-capped) as the message.
 *
 * ## Classification
 *
 * ```text
 * auth                  HTTP 401/403 — a Basic-secured Gatus rejected the
 *                       stored credential, or (should it ever reach this far)
 *                       an OIDC gate rejected an unauthenticated request.
 * rate_limited          HTTP 429, or the local rate budget refusing a wait
 *                       longer than maxWaitMs (detail.source =
 *                       'local_rate_budget'). Gatus's own route table and
 *                       middleware stack (recover + compress only) document
 *                       NO built-in request limiter on this API — a 429 is
 *                       therefore attributed to something in front of Gatus
 *                       (a reverse proxy), not Gatus itself.
 * not_found             HTTP 404 — an endpoint key the caller supplied is
 *                       unknown to this Gatus (`common.ErrEndpointNotFound`).
 * invalid_request       other HTTP 4xx (a malformed `duration`, a bad key
 *                       encoding, `common.ErrInvalidTimeRange`), malformed
 *                       local input/config, a response body that fails
 *                       boundary validation.
 * provider_unavailable  HTTP 5xx, network/timeout failures, a 2xx response
 *                       that is not shaped the way the endpoint promises
 *                       (bad JSON where JSON was expected, unparseable text
 *                       where a bare number was expected).
 * ```
 *
 * ## Credential containment is structural, not filtered
 *
 * Unlike Beszel, there is no login exchange and therefore no response ever
 * carries a server-issued token to guard against. The ONLY credential
 * material in this whole package is the `Authorization: Basic
 * base64(username:password)` header this module's callers attach — never
 * read back here, never copied into a `detail`. `detail` copies only the
 * HTTP status, the adapter operation label, the request PATH (no query
 * string beyond what the operation itself needed, and never a header), and
 * Gatus's own response text.
 */

export const GATUS_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type GatusErrorKind = (typeof GATUS_ERROR_KINDS)[number];

export class GatusAdapterError extends Error {
  readonly kind: GatusErrorKind;
  /** Sanitized provider evidence — never headers, bodies beyond text, or credentials. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: GatusErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "GatusAdapterError";
    this.detail = detail;
    this.kind = kind;
  }
}

const MAX_MESSAGE_LENGTH = 500;

/**
 * Extract a human-readable message from a Gatus error body. Gatus's error
 * bodies are ordinarily plain text (see the module doc); the one JSON shape —
 * `api/config.go`'s `{"error": "..."}` — is also handled. Never throws.
 */
export function readGatusErrorMessage(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)["error"] === "string"
    ) {
      return ((parsed as Record<string, unknown>)["error"] as string).slice(
        0,
        MAX_MESSAGE_LENGTH,
      );
    }
  } catch {
    // Not JSON — the ordinary case. Fall through to the raw text.
  }
  return trimmed.slice(0, MAX_MESSAGE_LENGTH);
}

export function gatusKindFromStatus(status: number): GatusErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  // A 2xx that reached the failure path: the body was not what it claimed.
  return "provider_unavailable";
}

export interface GatusErrorContext {
  /** Adapter operation label, e.g. `endpoints.statuses`. Never a URL. */
  operation: string;
  /** Request path, e.g. `/api/v1/endpoints/statuses`. No query string. */
  path: string;
}

/** Build the adapter error for a failed (non-2xx) HTTP response. */
export function gatusErrorFromResponse(
  status: number,
  rawText: string,
  context: GatusErrorContext,
): GatusAdapterError {
  const kind = gatusKindFromStatus(status);
  const message = readGatusErrorMessage(rawText);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (message !== null) detail["providerMessage"] = message;
  return new GatusAdapterError(
    kind,
    `Gatus API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts,
 * parse failures) into a {@link GatusAdapterError}. Non-Error values and
 * unknown Errors are reduced to name/message/code — their properties (which
 * for `fetch` can include the `Request`, and thus an `Authorization` header)
 * are deliberately dropped.
 */
export function normalizeGatusError(
  error: unknown,
  context: GatusErrorContext,
): GatusAdapterError {
  if (error instanceof GatusAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new GatusAdapterError(
        "provider_unavailable",
        "Gatus request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new GatusAdapterError(
      "provider_unavailable",
      "Gatus request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new GatusAdapterError(
    "provider_unavailable",
    "Gatus request failed with a non-Error value",
    base,
  );
}
