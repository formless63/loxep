/**
 * Loxep-owned eBay user-token bundle (loxep-62y.1.2) and the pure mapping
 * between it and hendt/ebay-api's `AuthToken`.
 *
 * The bundle is the ONLY token shape that crosses this package's boundary:
 * provider token types (`Token`/`AuthToken` from `ebay-api`) never appear in
 * an exported signature, and timestamps are absolute ISO strings rather than
 * the provider's relative `expires_in` seconds — a relative lifetime is
 * meaningless once a token has been persisted and re-read minutes later.
 *
 * PERSISTENCE MAPPING (implemented by the web/pipeline layer, documented
 * here because this package owns the shape):
 *
 * | bundle field            | storage location                                   |
 * | ----------------------- | -------------------------------------------------- |
 * | accessToken             | `connection_credentials` bundle `accessToken`       |
 * | refreshToken            | `connection_credentials` bundle `refreshToken`      |
 * | accessTokenExpiresAt    | credential version `expires_at`                     |
 * | (expiry − refresh skew) | credential version `refresh_after`                  |
 * | refreshTokenExpiresAt   | non-secret `connections.config.ebayOAuth`           |
 * | scopes                  | non-secret `connections.config.ebayOAuth`           |
 *
 * The credential slot is conceptually "ebay_oauth"; it is stored under the
 * registered `@loxep/domain` secret purpose **`oauth_tokens`**
 * (`{accessToken, refreshToken?}`, ADR-0019) because credential types must be
 * registered purposes and that purpose already describes exactly this shape.
 * `refreshTokenExpiresAt`/`scopes` are NOT secret material, so they ride on
 * the connection's non-secret config rather than forcing a new purpose.
 *
 * ABSOLUTE RULE: nothing in this module ever puts token material into an
 * error message, error `detail`, or log field.
 */
import { z } from "zod";
import { EbayAdapterError } from "./errors.ts";

/** Loxep-owned user (authorization-code grant) token bundle. */
export interface EbayUserTokenBundle {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 UTC instant the access token stops being usable. */
  accessTokenExpiresAt: string;
  /** ISO-8601 UTC instant the refresh token expires; null when unknown. */
  refreshTokenExpiresAt: string | null;
  /** Scopes the consent was granted for (what Loxep asked for). */
  scopes: string[];
}

const isoDateTime = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  { error: "must be an ISO-8601 date-time" },
);

export const ebayUserTokenBundleSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: isoDateTime,
  refreshTokenExpiresAt: isoDateTime.nullable(),
  scopes: z.array(z.string().min(1)).min(1),
});

/**
 * Validate an untrusted bundle (e.g. one just read back out of storage).
 * Zod issues are reported as paths + codes only — never values, which are
 * token material.
 */
export function parseEbayUserTokenBundle(input: unknown): EbayUserTokenBundle {
  const result = ebayUserTokenBundleSchema.safeParse(input);
  if (!result.success) {
    throw new EbayAdapterError(
      "invalid_request",
      "invalid eBay user token bundle",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  return result.data;
}

/**
 * Provider token response shape (structural, so no provider type is
 * imported): eBay's identity endpoint returns `access_token`, `expires_in`,
 * `token_type`, and — on the authorization-code grant only — `refresh_token`
 * and `refresh_token_expires_in`.
 */
export interface ProviderTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
}

/**
 * eBay always returns `expires_in`; this fallback matches the library's own
 * assumption in `OAuth2.setCredentials(string)` and keeps a malformed
 * response from producing an infinite-lifetime token.
 */
const FALLBACK_ACCESS_TOKEN_TTL_SECONDS = 7200;

function positiveSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoFromNow(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

/**
 * Map a provider token response into a Loxep bundle.
 *
 * `previous` supplies what a REFRESH response legitimately omits: eBay's
 * refresh_token grant returns only a new access token, so the refresh token
 * and its expiry carry forward from the bundle being refreshed.
 */
export function bundleFromProviderToken(
  token: ProviderTokenResponse,
  options: {
    now: Date;
    scopes: string[];
    previous?: Pick<
      EbayUserTokenBundle,
      "refreshToken" | "refreshTokenExpiresAt"
    >;
  },
): EbayUserTokenBundle {
  const accessToken = nonEmptyString(token.access_token);
  if (accessToken === null) {
    throw new EbayAdapterError(
      "provider_unavailable",
      "eBay token response contained no access_token",
    );
  }
  const refreshToken =
    nonEmptyString(token.refresh_token) ?? options.previous?.refreshToken ?? null;
  if (refreshToken === null) {
    throw new EbayAdapterError(
      "auth",
      "eBay token response contained no refresh_token and none was carried forward",
    );
  }
  const expiresIn =
    positiveSeconds(token.expires_in) ?? FALLBACK_ACCESS_TOKEN_TTL_SECONDS;
  const refreshExpiresIn = positiveSeconds(token.refresh_token_expires_in);

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: isoFromNow(options.now, expiresIn),
    refreshTokenExpiresAt:
      refreshExpiresIn !== null
        ? isoFromNow(options.now, refreshExpiresIn)
        : (options.previous?.refreshTokenExpiresAt ?? null),
    scopes: [...options.scopes],
  };
}

/**
 * Map a Loxep bundle back into the provider's `AuthToken` shape so the
 * library can authorize calls with it. `expires_in` is recomputed as the
 * REMAINING lifetime (never negative) because the library treats it as a
 * relative value measured from "now".
 */
export function providerTokenFromBundle(
  bundle: EbayUserTokenBundle,
  now: Date = new Date(),
): {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  token_type: string;
} {
  const remaining = (iso: string): number =>
    Math.max(0, Math.floor((Date.parse(iso) - now.getTime()) / 1000));
  return {
    access_token: bundle.accessToken,
    refresh_token: bundle.refreshToken,
    expires_in: remaining(bundle.accessTokenExpiresAt),
    ...(bundle.refreshTokenExpiresAt !== null
      ? { refresh_token_expires_in: remaining(bundle.refreshTokenExpiresAt) }
      : {}),
    token_type: "User Access Token",
  };
}

/** True when `at` is at or past the access-token expiry minus `skewSeconds`. */
export function accessTokenNeedsRefresh(
  bundle: EbayUserTokenBundle,
  at: Date,
  skewSeconds: number,
): boolean {
  return (
    Date.parse(bundle.accessTokenExpiresAt) - skewSeconds * 1000 <= at.getTime()
  );
}

/** True when the refresh token itself is known to have expired at `at`. */
export function refreshTokenExpired(
  bundle: EbayUserTokenBundle,
  at: Date,
): boolean {
  return (
    bundle.refreshTokenExpiresAt !== null &&
    Date.parse(bundle.refreshTokenExpiresAt) <= at.getTime()
  );
}
