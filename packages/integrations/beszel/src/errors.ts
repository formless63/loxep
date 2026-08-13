/**
 * Loxep error taxonomy for the Beszel integration boundary (ADR-0009).
 *
 * The same five-kind shape the eBay, WooCommerce, Medusa, Invoice Ninja, Etsy,
 * Cloudflare, and Purelymail adapters carry — a small stable `kind` plus a
 * sanitized `detail` record — so callers branch on one vocabulary across
 * providers. The taxonomies are deliberately **DUPLICATED rather than shared**:
 * `@loxep/integration-beszel` must not depend on another integration package,
 * and a cross-integration base package would make every provider's error
 * surface a shared upgrade hazard.
 *
 * ## The envelope, verified 2026-08-13
 *
 * Beszel's REST guide states plainly: *"Because Beszel is built on PocketBase,
 * you can use the PocketBase web APIs and client-side SDKs to read or update
 * data from outside Beszel itself"* (https://beszel.dev/guide/rest-api). So the
 * wire contract is PocketBase's, and PocketBase's published Records API
 * (https://pocketbase.io/docs/api-records/) documents both halves:
 *
 * ```text
 * success   { page, perPage, totalItems, totalPages, items: [...] }
 * failure   { status: <code>, message: "<description>", data: {} }
 * ```
 *
 * Unlike Purelymail, **the HTTP status here is honest**: PocketBase reports
 * failures with the matching 4xx/5xx and repeats the code inside `status`. This
 * module still reads the body first and treats the header status as the
 * tiebreaker, for one reason — a reverse proxy in front of a self-hosted hub is
 * the normal deployment, and a proxy's 502 page must not be mistaken for a
 * provider refusal.
 *
 * ## Classification
 *
 * ```text
 * auth                  HTTP 401/403. For this adapter that most often means
 *                       the stored readonly login was changed or disabled, or
 *                       the short-lived auth token expired mid-run.
 * rate_limited          HTTP 429 (PocketBase ships a configurable rate
 *                       limiter), or the local rate budget refusing a wait
 *                       longer than maxWaitMs (detail.source =
 *                       'local_rate_budget')
 * not_found             HTTP 404 — an unknown collection name, or a record the
 *                       readonly user was never granted sight of. PocketBase
 *                       deliberately does not distinguish those two, and
 *                       neither does this adapter.
 * invalid_request       other HTTP 4xx, malformed local input/config, a
 *                       response body that fails boundary validation
 * provider_unavailable  HTTP 5xx, network/timeout failures, non-JSON bodies, a
 *                       body that is not PocketBase-shaped at all
 * ```
 *
 * **A 404 is `not_found`, never `auth`, even though a sharing mistake is the
 * likeliest cause.** Upstream documents that a readonly user *"can view any
 * system shared with them by an admin"*
 * (https://beszel.dev/guide/user-accounts); a system that was never shared is
 * simply absent from that user's view. Reporting it as an authentication
 * failure would send an operator to rotate a working credential.
 *
 * ## Credential containment is structural, not filtered
 *
 * - the auth token goes into the `Authorization` header ONLY, and the
 *   email/password pair appears in exactly one request body — the login
 *   exchange — which nothing in this module reads;
 * - `detail` copies only the HTTP status, the adapter operation label, the
 *   request PATH, and PocketBase's own `message`. Never headers, never the
 *   `Request`/`Response` object, never the raw body, never `data`.
 *
 * `data` is excluded on purpose: PocketBase echoes per-field validation context
 * there, and for the login route that context is keyed by `identity`. Copying
 * it would put an account email into an error detail that a run step renders.
 */

export const BESZEL_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type BeszelErrorKind = (typeof BESZEL_ERROR_KINDS)[number];

export class BeszelAdapterError extends Error {
  readonly kind: BeszelErrorKind;
  /** Sanitized provider evidence — never headers, bodies, or credentials. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: BeszelErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BeszelAdapterError";
    this.detail = detail;
    this.kind = kind;
  }
}

/**
 * The parsed PocketBase error envelope.
 *
 * `status` is `null` when the body was not shaped like a PocketBase error at
 * all — an HTML proxy page, an empty body, a gateway error.
 */
export interface BeszelErrorEnvelope {
  status: number | null;
  message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a PocketBase error envelope out of an already-parsed JSON body. Never
 * throws; returns `status: null` for anything that is not envelope-shaped.
 *
 * `data` is read to decide whether the body *looks* like PocketBase, and then
 * discarded — see the module doc for why its contents never reach a detail.
 */
export function readBeszelErrorEnvelope(body: unknown): BeszelErrorEnvelope {
  const record = asRecord(body);
  if (record === null) return { status: null, message: null };
  const status = record["status"];
  const message = record["message"];
  const looksLikePocketBase =
    typeof status === "number" || typeof message === "string";
  if (!looksLikePocketBase) return { status: null, message: null };
  return {
    status: typeof status === "number" ? status : null,
    message: typeof message === "string" ? message : null,
  };
}

export function beszelKindFromStatus(status: number): BeszelErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  // A 2xx that reached the failure path: the body was not what it claimed.
  return "provider_unavailable";
}

export interface BeszelErrorContext {
  /** Adapter operation label, e.g. `systems.list`. Never a URL. */
  operation: string;
  /** Request path, e.g. `/api/collections/systems/records`. No query string. */
  path: string;
}

/**
 * Build the adapter error for a failed call.
 *
 * The HEADER status wins over the envelope's `status` when they disagree, and
 * the disagreement is recorded. They agree in every documented PocketBase
 * response; a mismatch means something between Loxep and the hub rewrote one of
 * them, which is a fact an operator debugging a proxy needs to see.
 */
export function beszelErrorFromResponse(
  status: number,
  envelope: BeszelErrorEnvelope,
  context: BeszelErrorContext,
): BeszelAdapterError {
  const kind = beszelKindFromStatus(status);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (envelope.message !== null) detail["providerMessage"] = envelope.message;
  if (envelope.status === null) {
    detail["providerBodyShape"] = "not-a-pocketbase-envelope";
  } else if (envelope.status !== status) {
    detail["envelopeStatusMismatch"] = envelope.status;
  }
  return new BeszelAdapterError(
    kind,
    `Beszel API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts, JSON
 * parse failures) into a {@link BeszelAdapterError}. Non-Error values and
 * unknown Errors are reduced to name/message/code — their properties (which for
 * `fetch` can include the `Request`, and thus the login body) are deliberately
 * dropped.
 */
export function normalizeBeszelError(
  error: unknown,
  context: BeszelErrorContext,
): BeszelAdapterError {
  if (error instanceof BeszelAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new BeszelAdapterError(
        "provider_unavailable",
        "Beszel request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new BeszelAdapterError(
      "provider_unavailable",
      "Beszel request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new BeszelAdapterError(
    "provider_unavailable",
    "Beszel request failed with a non-Error value",
    base,
  );
}
