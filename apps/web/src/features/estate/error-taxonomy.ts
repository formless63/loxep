/**
 * The estate-browser program's ONE generic error-kind mapping (Estate
 * Browsers Design §1.1: "every adapter shares one five-member error
 * taxonomy… an estate page can therefore map error kind to an honesty state
 * once, generically, for every provider").
 *
 * Every `@loxep/integration-*` package throws its OWN error class
 * (deliberately duplicated per ADR-0009, never a shared base class), but
 * every one of them carries the same shape: a `kind` from the five-member
 * union below plus a sanitized `detail` record. `classifyCaughtProviderError`
 * reads that shape off a caught `unknown` value the same way
 * `ebay-oauth.ts`'s validation handler already does
 * (`(error as { kind?: unknown })?.kind`) — the established, shipped pattern
 * for surfacing a provider error's kind to a server function's caller
 * without each estate server function re-deriving it.
 *
 * `detail.source === 'local_rate_budget'` is the one detail worth reading
 * out: "Loxep throttled itself" and "the provider said no" are different
 * sentences (Rule P13's own example), and every adapter's rate-budget
 * refusal sets that same `detail.source` string.
 */

/** The taxonomy every `@loxep/integration-*` package's error class shares. */
export const ESTATE_ERROR_KINDS = [
  'auth',
  'rate_limited',
  'not_found',
  'invalid_request',
  'provider_unavailable'
] as const;

export type EstateErrorKind = (typeof ESTATE_ERROR_KINDS)[number];

function isKnownKind(value: unknown): value is EstateErrorKind {
  return typeof value === 'string' && (ESTATE_ERROR_KINDS as readonly string[]).includes(value);
}

export interface EstateErrorInfo {
  kind: EstateErrorKind | 'unknown';
  message: string;
  /** `true` when the refusal came from Loxep's own token bucket, never the provider. */
  localRateBudget: boolean;
}

/**
 * Reads `.kind`/`.detail` off a caught adapter error server-side, before it
 * crosses the server-function boundary — the same shape
 * `ebay-oauth.ts`/`etsy-oauth.ts` already extract. Call this INSIDE a
 * server function's `catch`, never on the client (a serialized error loses
 * these extra properties).
 */
export function classifyCaughtProviderError(
  error: unknown,
  fallbackMessage: string
): EstateErrorInfo {
  const rawKind = (error as { kind?: unknown } | undefined)?.kind;
  const kind = isKnownKind(rawKind) ? rawKind : 'unknown';
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  const source =
    typeof detail === 'object' && detail !== null
      ? (detail as Record<string, unknown>).source
      : undefined;
  return {
    kind,
    message: error instanceof Error ? error.message : fallbackMessage,
    localRateBudget: source === 'local_rate_budget'
  };
}

/**
 * The honesty-state "error kind's own sentence" (Rule P13) — a short,
 * operator-facing prefix distinguishing *why* the read failed, prepended to
 * the provider's own message rather than replacing it (the message is kept
 * verbatim per Rule P3; this only adds the classification).
 */
export function estateErrorSentence(info: EstateErrorInfo): string {
  if (info.localRateBudget) {
    return 'Loxep throttled itself reading this provider (its own rate budget, not the provider) — try again in a moment.';
  }
  switch (info.kind) {
    case 'auth':
      return "The provider rejected this connection's credential.";
    case 'rate_limited':
      return 'The provider is rate-limiting this connection.';
    case 'not_found':
      return 'The provider could not find what was asked for.';
    case 'invalid_request':
      return 'Loxep sent a request the provider rejected as invalid.';
    case 'provider_unavailable':
      return 'The provider was unreachable or returned an unrecognizable response.';
    default:
      return 'Could not read this provider.';
  }
}
