/**
 * Loxep error taxonomy for the Tailscale integration boundary (ADR-0009).
 *
 * The same five-kind shape the eBay, WooCommerce, Medusa, Cloudflare,
 * Purelymail, Beszel, and Dockhand adapters carry — a small stable `kind`
 * plus a sanitized `detail` record — so callers branch on one vocabulary
 * across providers. **Duplicated rather than shared**: this package must not
 * depend on another integration package.
 *
 * ## The envelope, verified 2026-08-13
 *
 * The Tailscale API reference (mirrored at
 * https://gitea.codinget.me/webnet/tailscale/src/commit/41db1d7bba31ab3667187871dc48e220bb7a77f4/api.md,
 * the same historically-published `api.md` https://tailscale.com/docs/reference/tailscale-api
 * now redirects readers to) documents a single flat error shape:
 *
 * ```json
 * { "message": "additional error information" }
 * ```
 *
 * and states that the API "follows standard HTTP conventions" for status
 * codes, pointing readers at the generic MDN status reference rather than a
 * Tailscale-specific table. That is the same posture Dockhand's unversioned
 * API takes, so this module classifies purely from the HTTP status.
 *
 * ## Classification
 *
 * ```text
 * auth                  HTTP 401/403 — an invalid, revoked, or EXPIRED access
 *                       token. Tailscale access tokens expire on a fixed
 *                       1-90 day schedule the operator chose at generation
 *                       (or in one hour, if minted from an OAuth client) —
 *                       this is the ordinary, expected way this adapter
 *                       eventually fails and needs a fresh credential.
 * rate_limited          HTTP 429, or the local rate budget refusing a wait
 *                       longer than maxWaitMs (detail.source =
 *                       'local_rate_budget'). Tailscale publishes no
 *                       numeric API rate limit (a still-open request as of
 *                       2026-08-13: github.com/tailscale/tailscale#14328),
 *                       so a 429 is unconfirmed by upstream but still
 *                       classified this way if one is ever seen.
 * not_found             HTTP 404 — an unknown tailnet or device id.
 * invalid_request       other HTTP 4xx, malformed local input/config, a
 *                       response body that fails boundary validation
 * provider_unavailable  HTTP 5xx, network/timeout failures, non-JSON bodies
 * ```
 *
 * `detail` copies only the HTTP status, the adapter operation label, the
 * request PATH (no query string), and the provider's own `message`. Never
 * headers, never the raw body, never the access token.
 */

export const TAILSCALE_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type TailscaleErrorKind = (typeof TAILSCALE_ERROR_KINDS)[number];

export class TailscaleAdapterError extends Error {
  readonly kind: TailscaleErrorKind;
  /** Sanitized provider evidence — never headers, bodies, or credentials. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: TailscaleErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TailscaleAdapterError";
    this.detail = detail;
    this.kind = kind;
  }
}

/** The parsed `{ message }` error envelope. `null` when the body was not shaped like one. */
export interface TailscaleErrorEnvelope {
  message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readTailscaleErrorEnvelope(
  body: unknown,
): TailscaleErrorEnvelope {
  const record = asRecord(body);
  const message = record?.["message"];
  return { message: typeof message === "string" ? message : null };
}

export function tailscaleKindFromStatus(status: number): TailscaleErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

export interface TailscaleErrorContext {
  /** Adapter operation label, e.g. `devices.list`. Never a URL. */
  operation: string;
  /** Request path, e.g. `/api/v2/tailnet/-/devices`. No query string. */
  path: string;
}

export function tailscaleErrorFromResponse(
  status: number,
  envelope: TailscaleErrorEnvelope,
  context: TailscaleErrorContext,
): TailscaleAdapterError {
  const kind = tailscaleKindFromStatus(status);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (envelope.message !== null) detail["providerMessage"] = envelope.message;
  return new TailscaleAdapterError(
    kind,
    `Tailscale API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts,
 * JSON parse failures) into a {@link TailscaleAdapterError}.
 */
export function normalizeTailscaleError(
  error: unknown,
  context: TailscaleErrorContext,
): TailscaleAdapterError {
  if (error instanceof TailscaleAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new TailscaleAdapterError(
        "provider_unavailable",
        "Tailscale request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new TailscaleAdapterError(
      "provider_unavailable",
      "Tailscale request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new TailscaleAdapterError(
    "provider_unavailable",
    "Tailscale request failed with a non-Error value",
    base,
  );
}
