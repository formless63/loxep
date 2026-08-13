/**
 * Loxep error taxonomy for the Termix integration boundary (ADR-0009).
 *
 * The same five-kind shape every sibling integration package carries — a
 * small stable `kind` plus a sanitized `detail` record. **Duplicated rather
 * than shared**: this package must not depend on another integration
 * package.
 *
 * ## The envelope, verified 2026-08-13
 *
 * Termix publishes a machine-readable OpenAPI 3.0.3 document
 * (`Termix-SSH/Docs`, `static/openapi.json`, last regenerated 2026-08-06 for
 * "API docs for 2.6.1" — this is what backs
 * https://docs.termix.site/api/termix-api/) — but **no error response body
 * is ever given a `content` schema anywhere in it**. Every 4xx/5xx response
 * across all 274 documented operations is description-text only (`"Invalid
 * userId."`, `"Login failed."`, and so on). There is therefore no confirmed
 * JSON error envelope to parse, unlike Beszel's PocketBase `{status,
 * message, data}` or Tailscale's `{message}`.
 *
 * This module classifies purely from the HTTP status — the one thing every
 * operation's spec entry does give consistently and by example:
 *
 * ```text
 * auth                  401 ("Invalid username or password.", "Not
 *                       authenticated.", "Session expired - please log in
 *                       again."), 403 ("Password authentication is
 *                       currently disabled.")
 * rate_limited          429 ("Too many login attempts." — confirmed on
 *                       /users/login; no numeric threshold is published),
 *                       or the local rate budget (detail.source =
 *                       'local_rate_budget')
 * not_found             404 ("SSH host not found.", "Status not available.")
 * invalid_request       other HTTP 4xx (e.g. 400 "Invalid userId."),
 *                       malformed local input/config, a response body that
 *                       fails boundary validation
 * provider_unavailable  HTTP 5xx (e.g. 500 "Failed to fetch SSH data."),
 *                       network/timeout failures, non-JSON bodies
 * ```
 *
 * `readTermixErrorEnvelope` still opportunistically reads a `message` or
 * `error` string field when the body happens to carry one (several
 * hand-written route handlers in Termix do send one even though the spec
 * never formalizes it), but its absence is expected and never itself an
 * error. `detail` copies only the HTTP status, the adapter operation label,
 * the request PATH (no query string), and that opportunistic message.
 * Never headers, never the raw body, never a credential.
 */

export const TERMIX_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type TermixErrorKind = (typeof TERMIX_ERROR_KINDS)[number];

export class TermixAdapterError extends Error {
  readonly kind: TermixErrorKind;
  /** Sanitized provider evidence — never headers, bodies, or credentials. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: TermixErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TermixAdapterError";
    this.detail = detail;
    this.kind = kind;
  }
}

export interface TermixErrorEnvelope {
  message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Opportunistic only — no error body schema is published. See module doc. */
export function readTermixErrorEnvelope(body: unknown): TermixErrorEnvelope {
  const record = asRecord(body);
  const message = record?.["message"] ?? record?.["error"];
  return { message: typeof message === "string" ? message : null };
}

export function termixKindFromStatus(status: number): TermixErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

export interface TermixErrorContext {
  /** Adapter operation label, e.g. `hosts.list`. Never a URL. */
  operation: string;
  /** Request path, e.g. `/host/db/host`. No query string. */
  path: string;
}

export function termixErrorFromResponse(
  status: number,
  envelope: TermixErrorEnvelope,
  context: TermixErrorContext,
): TermixAdapterError {
  const kind = termixKindFromStatus(status);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (envelope.message !== null) detail["providerMessage"] = envelope.message;
  return new TermixAdapterError(
    kind,
    `Termix API error (${kind}, HTTP ${status})`,
    detail,
  );
}

export function normalizeTermixError(
  error: unknown,
  context: TermixErrorContext,
): TermixAdapterError {
  if (error instanceof TermixAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new TermixAdapterError(
        "provider_unavailable",
        "Termix request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new TermixAdapterError(
      "provider_unavailable",
      "Termix request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new TermixAdapterError(
    "provider_unavailable",
    "Termix request failed with a non-Error value",
    base,
  );
}
