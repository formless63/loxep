/**
 * Loxep error taxonomy for the Dockhand integration boundary (ADR-0009).
 *
 * The same five-kind shape every sibling adapter carries — a small stable
 * `kind` plus a sanitized `detail` record — so callers branch on one vocabulary
 * across providers. The taxonomies are deliberately **DUPLICATED rather than
 * shared**: `@loxep/integration-dockhand` must not depend on another
 * integration package, and a cross-integration base package would make every
 * provider's error surface a shared upgrade hazard.
 *
 * ## The envelope, verified 2026-08-13
 *
 * From Dockhand's API overview (https://finsys-dockhand.mintlify.app/api/overview):
 *
 * ```text
 * success   {"success": true, "id": "abc123"}   (200 / 201)
 * failure   {"error": "Human-readable message", "details": "Additional context"}
 * ```
 *
 * with the note that *"List endpoints return arrays directly without wrapping"*.
 *
 * **That last sentence is contradicted by Dockhand's own endpoint pages**, and
 * the contradiction is recorded rather than resolved: the list-containers page
 * documents a response with a `containers` array field, while the list-stacks
 * page documents a bare array of stack objects. Both shapes are therefore
 * accepted at this boundary (see `adapter.ts`), because an adapter that picked
 * one would be broken against half the API and the documentation cannot say
 * which half. This is the concrete form of the fleet-observability design's
 * warning that Dockhand has *"no OpenAPI"* and that undocumented shapes must be
 * *"treated as unverified until checked against the running provider"*.
 *
 * ## Classification
 *
 * ```text
 * auth                  HTTP 401/403. Dockhand documents 403 for a permission
 *                       failure on nearly every endpoint, so 403 is the common
 *                       case, not 401.
 * rate_limited          HTTP 429 — documented ONLY for authentication, after
 *                       "5 failed attempts per IP/username combination", with
 *                       an "exponential backoff (5-60 seconds)" lockout. Also
 *                       the local rate budget refusing a wait longer than
 *                       maxWaitMs (detail.source = 'local_rate_budget').
 * not_found             HTTP 404 — documented for an unknown environment id.
 * invalid_request       other HTTP 4xx, malformed local input/config, a
 *                       response that fails boundary validation
 * provider_unavailable  HTTP 5xx, network/timeout failures, non-JSON bodies
 * ```
 *
 * **A 429 on the login path is special and is marked as such.** `detail.lockout`
 * is set when the failure came from `/api/auth/login`, because the operator
 * remedy is different in kind: waiting out a lockout, not slowing a poll. A
 * worker that treated it as ordinary backpressure and retried would extend the
 * lockout against a credential that may already be valid again.
 *
 * ## Credential containment is structural, not filtered
 *
 * - the session token travels in a `Cookie` header ONLY — never a URL, query
 *   string, or body — and the username/password pair appears in exactly one
 *   request body, the login exchange, which nothing in this module reads;
 * - `detail` copies only the HTTP status, the adapter operation label, the
 *   request PATH, and Dockhand's own `error` string. Never headers, never the
 *   `Request`/`Response` object, never the raw body.
 *
 * **`details` is deliberately excluded** even though `error` is kept. Upstream
 * describes it only as *"Additional context"* with no schema and no bound, so
 * it is the field most likely to echo a submitted value back — and a failed
 * environment create submits a TLS private key.
 */

export const DOCKHAND_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type DockhandErrorKind = (typeof DOCKHAND_ERROR_KINDS)[number];

export class DockhandAdapterError extends Error {
  readonly kind: DockhandErrorKind;
  /** Sanitized provider evidence — never headers, bodies, or credentials. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: DockhandErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DockhandAdapterError";
    this.detail = detail;
    this.kind = kind;
  }
}

/**
 * The parsed Dockhand error envelope.
 *
 * `error` is `null` when the body was not shaped like a Dockhand failure at all
 * — an HTML proxy page, an empty body, a gateway error. `details` is read only
 * to decide whether the body looks like Dockhand, and is then discarded; see
 * the module doc.
 */
export interface DockhandErrorEnvelope {
  error: string | null;
  /** Whether upstream's undocumented `details` field was present. Not its value. */
  hasDetails: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readDockhandErrorEnvelope(
  body: unknown,
): DockhandErrorEnvelope {
  const record = asRecord(body);
  if (record === null) return { error: null, hasDetails: false };
  const error = record["error"];
  return {
    error: typeof error === "string" ? error : null,
    hasDetails: Object.hasOwn(record, "details"),
  };
}

export function dockhandKindFromStatus(status: number): DockhandErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

export interface DockhandErrorContext {
  /** Adapter operation label, e.g. `hosts.list`. Never a URL. */
  operation: string;
  /** Request path, e.g. `/api/environments`. Never the query string. */
  path: string;
}

export function dockhandErrorFromResponse(
  status: number,
  envelope: DockhandErrorEnvelope,
  context: DockhandErrorContext,
): DockhandAdapterError {
  const kind = dockhandKindFromStatus(status);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (envelope.error !== null) detail["providerError"] = envelope.error;
  if (envelope.error === null) {
    detail["providerBodyShape"] = "not-a-dockhand-envelope";
  }
  // `details` is never copied — only the fact that upstream sent one, so a
  // reader knows evidence exists on the Dockhand side without it landing here.
  if (envelope.hasDetails) detail["providerDetailsOmitted"] = true;
  if (status === 429 && context.operation.startsWith("auth.")) {
    // Documented: "5 failed attempts per IP/username", "exponential backoff
    // (5-60 seconds)". The remedy is to WAIT, not to slow the poll.
    detail["lockout"] = true;
  }
  return new DockhandAdapterError(
    kind,
    `Dockhand API error (${kind}, HTTP ${status})`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts, JSON
 * parse failures) into a {@link DockhandAdapterError}. Non-Error values and
 * unknown Errors are reduced to name/message/code — their properties (which for
 * `fetch` can include the `Request`, and thus the session cookie) are
 * deliberately dropped.
 */
export function normalizeDockhandError(
  error: unknown,
  context: DockhandErrorContext,
): DockhandAdapterError {
  if (error instanceof DockhandAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new DockhandAdapterError(
        "provider_unavailable",
        "Dockhand request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new DockhandAdapterError(
      "provider_unavailable",
      "Dockhand request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new DockhandAdapterError(
    "provider_unavailable",
    "Dockhand request failed with a non-Error value",
    base,
  );
}
