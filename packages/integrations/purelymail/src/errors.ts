/**
 * Loxep error taxonomy for the Purelymail integration boundary (ADR-0009).
 *
 * The same five-kind shape the eBay, WooCommerce, Medusa, Invoice Ninja, Etsy,
 * and Cloudflare adapters carry — a small stable `kind` plus a sanitized
 * `detail` record — so callers branch on one vocabulary across providers. The
 * taxonomies are deliberately **DUPLICATED rather than shared**:
 * `@loxep/integration-purelymail` must not depend on another integration
 * package, and a cross-integration base package would make every provider's
 * error surface a shared upgrade hazard.
 *
 * ## The envelope, and why HTTP status here is nearly useless
 *
 * The infrastructure design warns: *"An RPC-style API that wraps every response
 * in a success/error envelope means HTTP 200 does not imply success. The
 * adapter must branch on the envelope, not the status code."* For Cloudflare
 * that warning was defensive — the published schema models failures as 4xx.
 *
 * **For Purelymail it is literal, and it is LIVE-VERIFIED.** Two unauthenticated
 * probes against `POST https://purelymail.com/api/v0/checkAccountCredit` on
 * 2026-08-13 both answered **HTTP 200**:
 *
 * ```json
 * {"type":"error","code":"invalidToken","message":"Token not valid."}
 * {"type":"error","code":"invalidToken",
 *  "message":"Token must be supplied in Purelymail-Api-Token header"}
 * ```
 *
 * An adapter that branched on `response.ok` would treat a completely
 * unauthenticated call as a success and then fail on a missing field somewhere
 * downstream. Every response is therefore classified from `type` first, and
 * status is consulted only as a tiebreaker.
 *
 * The envelope is **not in the published OpenAPI document**, which models each
 * 200 as `{result: ...}` and defines an unreferenced `Error` schema of
 * `{code, message}`. The `type` discriminator is confirmed from two independent
 * sources: the live probes above, and Raycast's published Purelymail extension,
 * whose client branches on `response.type === "success"` and otherwise surfaces
 * `response.code` / `response.message`. Both are recorded here because the
 * document alone would have led to the wrong implementation.
 *
 * ## Classification
 *
 * ```text
 * auth                  envelope code in PURELYMAIL_AUTH_ERROR_CODES
 *                       ('invalidToken', live-verified), or HTTP 401/403
 * rate_limited          HTTP 429, or the local rate budget refusing a wait
 *                       longer than maxWaitMs (detail.source = 'local_rate_budget')
 * not_found             HTTP 404 (an unknown operation name answers 404 with an
 *                       HTML page — live-verified), or a code in
 *                       PURELYMAIL_NOT_FOUND_ERROR_CODES
 * invalid_request       any other envelope error, malformed local input/config,
 *                       other HTTP 4xx
 * provider_unavailable  HTTP 5xx, network/timeout failures, non-JSON bodies, a
 *                       body that is not envelope-shaped at all
 * ```
 *
 * **An envelope error whose code is unrecognized is `invalid_request`, not
 * `provider_unavailable`.** The provider answered, understood the request, and
 * refused it; calling that an outage would make the reconciler retry a call
 * that will never succeed.
 *
 * ## Credential containment is structural, not filtered
 *
 * - the API token goes into the `Purelymail-Api-Token` header ONLY — never a
 *   URL, query string, or body — so no request-derived string reachable from
 *   this module can structurally contain it;
 * - `detail` copies only the HTTP status, the adapter operation label, the
 *   request PATH, and the envelope's `code` + `message`. Never headers, never
 *   the `Request`/`Response` object, never the raw body.
 *
 * The one Purelymail request that contains a credential is `createUser`, whose
 * `password` field is a value Loxep MINTED. Nothing in this module reads a
 * request body, so a mailbox password cannot reach an error detail. See
 * `redact.ts` for the summary half of the same rule.
 */

export const PURELYMAIL_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type PurelymailErrorKind = (typeof PURELYMAIL_ERROR_KINDS)[number];

export class PurelymailAdapterError extends Error {
  readonly kind: PurelymailErrorKind;
  /** Sanitized provider evidence — never headers, bodies, or credentials. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: PurelymailErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PurelymailAdapterError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * Envelope codes meaning "these credentials cannot do this".
 *
 * `invalidToken` is **LIVE-VERIFIED** (2026-08-13): it is what Purelymail
 * answers for both a garbage token and a missing header, in each case with HTTP
 * 200. Purelymail publishes no consolidated error-code table, so this set is
 * deliberately small and widened only from observed responses — never from a
 * guess. The live leg's standing job is to record any other code the API
 * actually returns.
 */
export const PURELYMAIL_AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalidToken",
]);

/**
 * Envelope codes meaning "no such object".
 *
 * **UNVERIFIED.** No code in this set has been observed against a live account;
 * they are the names the API would plausibly use and are consulted only to
 * classify an error more precisely than `invalid_request`. Nothing depends on
 * them for correctness: an unrecognized code still classifies as
 * `invalid_request`, and the read-back paths that care about absence
 * (`findDomainByName`, `listUsers`) answer from a LIST call rather than by
 * interpreting an error code. Confirm or delete each entry against a live
 * account; do not add to this set from memory.
 */
export const PURELYMAIL_NOT_FOUND_ERROR_CODES: ReadonlySet<string> = new Set([
  "noSuchUser",
  "noSuchDomain",
]);

/**
 * Envelope codes meaning "the object already exists", which for an
 * at-least-once retry is CONVERGENCE rather than failure.
 *
 * **UNVERIFIED**, and unlike Cloudflare's equivalent set this one is not used
 * to swallow an error. A duplicate `addDomain` or `createUser` is resolved by
 * READING the provider back through `provider_operations` (the design's open
 * question 4), because a mailbox create is billable and "already exists" is not
 * a claim worth trusting an unverified code string with. The set exists so a
 * run step can say *why* a retry converged, and it is safe if every entry is
 * wrong.
 */
export const PURELYMAIL_ALREADY_EXISTS_ERROR_CODES: ReadonlySet<string> =
  new Set(["userExists", "domainExists"]);

/**
 * The parsed response envelope.
 *
 * `type` is `null` when the body was not shaped like a Purelymail envelope at
 * all — an HTML 404 page (live-verified for an unknown operation name), a proxy
 * error, an empty body.
 */
export interface PurelymailEnvelope {
  type: "success" | "error" | null;
  code: string | null;
  message: string | null;
  result: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a Purelymail envelope out of an already-parsed JSON body. Never throws;
 * returns `type: null` for anything that is not envelope-shaped.
 *
 * A body carrying `result` but no `type` is read as a success, because that is
 * exactly the shape the published OpenAPI document describes for every 200. The
 * live API sends `type` as well; tolerating both means a future removal of the
 * discriminator degrades to the documented contract instead of failing every
 * call.
 */
export function readPurelymailEnvelope(body: unknown): PurelymailEnvelope {
  const record = asRecord(body);
  if (record === null) {
    return { type: null, code: null, message: null, result: null };
  }
  const rawType = record["type"];
  const code = record["code"];
  const message = record["message"];
  const hasResult = Object.hasOwn(record, "result");

  let type: PurelymailEnvelope["type"] = null;
  if (rawType === "success" || rawType === "error") {
    type = rawType;
  } else if (rawType === undefined && hasResult) {
    // The published document's shape, without the live discriminator.
    type = "success";
  }

  return {
    type,
    code: typeof code === "string" ? code : null,
    message: typeof message === "string" ? message : null,
    result: hasResult ? record["result"] : null,
  };
}

export function purelymailKindFromEnvelope(
  status: number | undefined,
  envelope: PurelymailEnvelope,
): PurelymailErrorKind {
  const code = envelope.code;
  if (code !== null) {
    if (PURELYMAIL_AUTH_ERROR_CODES.has(code)) return "auth";
    if (PURELYMAIL_NOT_FOUND_ERROR_CODES.has(code)) return "not_found";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (envelope.type === "error") {
    // The provider understood the request and refused it. Not an outage — a
    // retry would fail identically, so it must not look transient.
    return "invalid_request";
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return "invalid_request";
  }
  if (status !== undefined && status >= 500) return "provider_unavailable";
  // A 2xx whose body is not an envelope: an HTML page, an empty body, a proxy
  // interposing. Nothing about the request is known to be wrong.
  return "provider_unavailable";
}

export interface PurelymailErrorContext {
  /** Adapter operation label, e.g. `domain.add`. Never a URL. */
  operation: string;
  /** Request path, e.g. `/api/v0/addDomain`. No query string is ever sent. */
  path: string;
}

/**
 * Build the adapter error for a failed call — a non-2xx status, an envelope
 * reporting `type: "error"` (usually at HTTP 200), or a body that is not an
 * envelope at all.
 */
export function purelymailErrorFromResponse(
  status: number,
  envelope: PurelymailEnvelope,
  context: PurelymailErrorContext,
): PurelymailAdapterError {
  const kind = purelymailKindFromEnvelope(status, envelope);
  const detail: Record<string, unknown> = {
    httpStatus: status,
    operation: context.operation,
    path: context.path,
  };
  if (envelope.code !== null) detail["providerCode"] = envelope.code;
  if (envelope.message !== null) detail["providerMessage"] = envelope.message;
  if (envelope.type === null) {
    detail["providerBodyShape"] = "not-a-purelymail-envelope";
  } else if (envelope.type === "error" && status >= 200 && status < 300) {
    // The failure mode the design warns about, and the one Purelymail actually
    // exhibits. Recorded positively so a run step shows the status was a lie.
    detail["envelopeFailureOnSuccessStatus"] = true;
  }
  return new PurelymailAdapterError(
    kind,
    `Purelymail API error (${kind}, HTTP ${status}${
      envelope.code === null ? "" : `, ${envelope.code}`
    })`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts, JSON
 * parse failures) into a {@link PurelymailAdapterError}. Non-Error values and
 * unknown Errors are reduced to name/message/code — their properties (which for
 * `fetch` can include the `Request`, and thus the token header) are deliberately
 * dropped.
 */
export function normalizePurelymailError(
  error: unknown,
  context: PurelymailErrorContext,
): PurelymailAdapterError {
  if (error instanceof PurelymailAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new PurelymailAdapterError(
        "provider_unavailable",
        "Purelymail request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new PurelymailAdapterError(
      "provider_unavailable",
      "Purelymail request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new PurelymailAdapterError(
    "provider_unavailable",
    "Purelymail request failed with a non-Error value",
    base,
  );
}
