/**
 * Loxep error taxonomy for the Pangolin integration boundary (ADR-0009).
 *
 * The same five-kind shape every sibling adapter carries — a small stable
 * `kind` plus a sanitized `detail` record — so callers branch on one
 * vocabulary across providers. **Duplicated rather than shared**: this
 * package must not depend on another integration package.
 *
 * ## The envelope, verified against source AND live, 2026-08-15
 *
 * `apps/docs/.../architecture/pangolin-chain-design.md` records the binding
 * fact: every response is wrapped `{data, success, error, message, status}`,
 * and an RPC-style envelope means **HTTP 200 does not imply success** — the
 * same warning `@loxep/integration-purelymail` already lives by, where an
 * unauthenticated call answers HTTP 200 with `{"type":"error",...}`.
 *
 * For Pangolin the envelope shape is confirmed two ways:
 *
 * 1. **Source.** `fosrl/pangolin@main`'s `server/lib/response.ts`-shaped
 *    helper is used by every router this adapter reads from — e.g.
 *    `server/routers/resource/listResourceRules.ts`'s own registered
 *    OpenAPI response schema literally types the wrapper as
 *    `{data: record|null, success: boolean, error: boolean, message: string,
 *    status: number}`. `error` is a **boolean flag**, not a code string —
 *    Pangolin publishes no per-domain error-code table the way Purelymail
 *    does, so this module classifies primarily from HTTP status, using the
 *    envelope's own `status` field as a tiebreaker when it and the transport
 *    status disagree.
 * 2. **Live**, 2026-08-15, against the owner's instance
 *    (`pangolin.example.com`): an unauthenticated request answered
 *    `HTTP 401` with body
 *    `{"data":null,"success":false,"error":true,"message":"Unauthorized","stack":null}` —
 *    the exact shape source predicts, `stack: null` included. This confirms
 *    the envelope shape live even though the standalone bearer-authenticated
 *    Integration API server (port 3003, prefix `/v1`) itself could not be
 *    reached from this network — see `adapter.ts`'s module doc for the full
 *    reachability finding. The probed response came from the dashboard
 *    app's own internal `/api/v1` route (session-cookie gated), which
 *    shares the same response-wrapper code, not from the Integration API
 *    proper.
 *
 * ## Classification
 *
 * ```text
 * auth                  HTTP 401/403 (transport or envelope `status`), or the
 *                       envelope reporting failure with no informative
 *                       status at all is NOT classified auth — only a
 *                       confirmed 401/403 is.
 * rate_limited          HTTP 429, or the local rate budget refusing a wait
 *                       longer than maxWaitMs (detail.source =
 *                       'local_rate_budget'). No rate limit is documented or
 *                       present in source for the Integration API server
 *                       (`server/integrationApiServer.ts` installs no
 *                       rate-limit middleware) — see rate-budget.ts.
 * not_found             HTTP 404 (transport or envelope `status`).
 * invalid_request       any other envelope failure (`success === false` or
 *                       `error === true`), other HTTP 4xx, malformed local
 *                       input/config, a response body that fails boundary
 *                       validation
 * provider_unavailable  HTTP 5xx, network/timeout failures, non-JSON bodies,
 *                       a 2xx body that is not envelope-shaped at all
 * ```
 *
 * `detail` copies only the HTTP status, the envelope's own `status` field
 * (flagging a mismatch when the two disagree — the tell that a proxy or a
 * different route answered), the adapter operation label, the request PATH
 * (no query string), and the provider's own `message`. Never headers, never
 * the raw body, never the API key.
 */

export const PANGOLIN_ERROR_KINDS = [
  "auth",
  "rate_limited",
  "not_found",
  "invalid_request",
  "provider_unavailable",
] as const;

export type PangolinErrorKind = (typeof PANGOLIN_ERROR_KINDS)[number];

export class PangolinAdapterError extends Error {
  readonly kind: PangolinErrorKind;
  /** Sanitized provider evidence — never headers, bodies, or credentials. */
  readonly detail: Record<string, unknown>;

  constructor(
    kind: PangolinErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PangolinAdapterError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * The parsed `{data, success, error, message, status}` envelope. Every field
 * is `null` when the body was not shaped like one at all (an HTML page, an
 * empty body, a proxy interposing).
 */
export interface PangolinEnvelope {
  success: boolean | null;
  /** The envelope's own failure flag — a boolean, never a code string. */
  error: boolean | null;
  message: string | null;
  /** The envelope's own `status` field, which may disagree with the HTTP status. */
  status: number | null;
  data: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse a Pangolin envelope out of an already-parsed JSON body. Never throws. */
export function readPangolinEnvelope(body: unknown): PangolinEnvelope {
  const record = asRecord(body);
  if (record === null) {
    return { success: null, error: null, message: null, status: null, data: null };
  }
  const success = record["success"];
  const error = record["error"];
  const message = record["message"];
  const status = record["status"];
  return {
    success: typeof success === "boolean" ? success : null,
    error: typeof error === "boolean" ? error : null,
    message: typeof message === "string" ? message : null,
    status: typeof status === "number" ? status : null,
    data: Object.hasOwn(record, "data") ? record["data"] : null,
  };
}

function kindFromStatus(status: number): PangolinErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

export function pangolinKindFromEnvelope(
  httpStatus: number,
  envelope: PangolinEnvelope,
): PangolinErrorKind {
  // The envelope's own status is the more authoritative one when present —
  // the design's binding warning is that the TRANSPORT status can lie.
  const effectiveStatus = envelope.status ?? httpStatus;
  if (effectiveStatus === 401 || effectiveStatus === 403) return "auth";
  if (effectiveStatus === 429) return "rate_limited";
  if (effectiveStatus === 404) return "not_found";
  const envelopeFailed = envelope.success === false || envelope.error === true;
  if (envelopeFailed) {
    if (effectiveStatus >= 500) return "provider_unavailable";
    // The provider answered and refused the request; not an outage.
    return "invalid_request";
  }
  if (httpStatus >= 400 && httpStatus < 500) return "invalid_request";
  if (httpStatus >= 500) return "provider_unavailable";
  // A 2xx whose body was not envelope-shaped at all.
  return "provider_unavailable";
}

export interface PangolinErrorContext {
  /** Adapter operation label, e.g. `sites.list`. Never a URL. */
  operation: string;
  /** Request path, e.g. `/v1/org/home-lab/sites`. No query string. */
  path: string;
}

export function pangolinErrorFromResponse(
  httpStatus: number,
  envelope: PangolinEnvelope,
  context: PangolinErrorContext,
): PangolinAdapterError {
  const kind = pangolinKindFromEnvelope(httpStatus, envelope);
  const detail: Record<string, unknown> = {
    httpStatus,
    operation: context.operation,
    path: context.path,
  };
  if (envelope.status !== null && envelope.status !== httpStatus) {
    detail["envelopeStatus"] = envelope.status;
    detail["statusMismatch"] = true;
  }
  if (envelope.message !== null) detail["providerMessage"] = envelope.message;
  const envelopeFailed = envelope.success === false || envelope.error === true;
  if (envelopeFailed && httpStatus >= 200 && httpStatus < 300) {
    // The exact failure mode the design warns about: the provider answered
    // 2xx and lied about success in the body. Recorded positively so a run
    // step shows the status was not trustworthy on its own.
    detail["envelopeFailureOnSuccessStatus"] = true;
  }
  return new PangolinAdapterError(
    kind,
    `Pangolin API error (${kind}, HTTP ${httpStatus}${
      envelope.message === null ? "" : `, ${envelope.message}`
    })`,
    detail,
  );
}

/**
 * Normalize anything thrown beneath the adapter (fetch rejections, aborts,
 * JSON parse failures) into a {@link PangolinAdapterError}.
 */
export function normalizePangolinError(
  error: unknown,
  context: PangolinErrorContext,
): PangolinAdapterError {
  if (error instanceof PangolinAdapterError) return error;
  const base = { operation: context.operation, path: context.path };
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new PangolinAdapterError(
        "provider_unavailable",
        "Pangolin request timed out or was aborted",
        { ...base, errorName: error.name },
      );
    }
    const code = (error as { code?: unknown }).code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    return new PangolinAdapterError(
      "provider_unavailable",
      "Pangolin request failed before a provider response was classified",
      {
        ...base,
        errorName: error.name,
        errorMessage: error.message,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(typeof causeCode === "string" ? { causeCode } : {}),
      },
    );
  }
  return new PangolinAdapterError(
    "provider_unavailable",
    "Pangolin request failed with a non-Error value",
    base,
  );
}
