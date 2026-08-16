/**
 * The estate-browser shell's shared section-result envelope (loxep-47o.1).
 *
 * A section's server function returns this DIRECTLY as its resolved data —
 * it never throws for a CLASSIFIABLE provider failure (an `auth`/
 * `rate_limited`/`not_found`/`invalid_request`/`provider_unavailable` kind
 * from the adapter's own error taxonomy). This is the same shape
 * `ebay-oauth.ts`'s `{ ok: false, message, errorKind }` validation result
 * already established for exactly the same reason: a thrown `Error`'s extra
 * properties (`.kind`, `.detail`) do not survive the server-function
 * boundary, so a caller that needs to render a KIND-specific sentence
 * (Rule P13) must receive it as data, not as a caught exception.
 *
 * A section's `useQuery` can still fail at the OUTER layer (Loxep's own
 * server unreachable, session expired, a genuine bug) — that is a normal
 * `isError` from `useQuery` and renders through `EstateSection`'s own
 * transport-error branch, distinct from this envelope's `'error'` status.
 */
import type { EstateErrorKind } from './error-taxonomy';

export type EstateSectionResult<T> =
  | { status: 'ok'; readAt: string; data: T }
  /** Rule P13 "Blocked": Loxep refused to try — render the reason verbatim, never guess. */
  | { status: 'blocked'; readAt: string; reason: string }
  /** Rule P13 "Error": the provider or transport failed — the kind's own sentence, plus the provider's message. */
  | {
      status: 'error';
      readAt: string;
      kind: EstateErrorKind | 'unknown';
      message: string;
      /** `true` when Loxep's OWN rate budget refused, never the provider — Rule P13's own example of why this is a different sentence. */
      localRateBudget: boolean;
    };

export function estateOk<T>(data: T, readAt: string): EstateSectionResult<T> {
  return { status: 'ok', readAt, data };
}

export function estateBlocked<T>(reason: string, readAt: string): EstateSectionResult<T> {
  return { status: 'blocked', readAt, reason };
}

export function estateError<T>(
  info: { kind: EstateErrorKind | 'unknown'; message: string; localRateBudget: boolean },
  readAt: string
): EstateSectionResult<T> {
  return {
    status: 'error',
    readAt,
    kind: info.kind,
    message: info.message,
    localRateBudget: info.localRateBudget
  };
}
