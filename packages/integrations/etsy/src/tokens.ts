/**
 * Loxep-owned Etsy user-token bundle (loxep-g4t.1) and the pure mapping
 * between it and Etsy's OAuth2 token response.
 *
 * The bundle is the ONLY token shape that crosses this package's boundary,
 * mirroring `@loxep/integration-ebay/tokens.ts`'s discipline: timestamps are
 * absolute ISO strings rather than the provider's relative `expires_in`
 * seconds, and nothing in this module ever puts token material into an
 * error message, error `detail`, or log field.
 *
 * ## The `<userId>.<accessToken>` split — SOURCE-VERIFIED
 *
 * Etsy's identity endpoint (`POST /v3/public/oauth/token`) returns a
 * standard OAuth2 token response (`access_token`, `token_type`,
 * `expires_in`, `refresh_token`), but the `access_token` VALUE it returns is
 * itself already shaped `<etsyUserId>.<opaque>` — confirmed against
 * `anitabyte/etsyv3` (`main` branch, fetched 2026-08-13,
 * `etsyv3/etsy_api.py`: `self.user_id = token.split(".")[0]` on the raw
 * access token). The binding design
 * (`etsy-integration-design.md`, "Auth: two tiers") frames this as Etsy's
 * user id belonging on non-secret `connections.config.etsyOAuth` rather than
 * inside the encrypted secret payload — this module implements that split
 * literally: {@link bundleFromProviderToken} PARSES the raw `access_token`
 * into `etsyUserId` (everything before the first `.`) and `accessToken`
 * (everything after it, the opaque remainder actually worth encrypting), and
 * {@link providerBearerToken} reassembles the exact original string for the
 * `Authorization: Bearer <value>` header. Splitting and reassembling is
 * lossless by construction (the boundary is the first `.`), so this never
 * invents an id Etsy did not supply.
 */
import { z } from "zod";
import { EtsyAdapterError } from "./errors.ts";

/** Loxep-owned user (authorization-code grant) token bundle. */
export interface EtsyUserTokenBundle {
  /** The numeric Etsy user id — non-secret, the part before the first `.`. */
  etsyUserId: string;
  /** The opaque remainder after the first `.` — the part worth encrypting. */
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 UTC instant the access token stops being usable. */
  accessTokenExpiresAt: string;
  /** ISO-8601 UTC instant the refresh token expires; null when unknown (Etsy's grant does not report one). */
  refreshTokenExpiresAt: string | null;
  /** Scopes the consent was granted for (what Loxep asked for). */
  scopes: string[];
}

const isoDateTime = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  { error: "must be an ISO-8601 date-time" },
);

export const etsyUserTokenBundleSchema = z.strictObject({
  etsyUserId: z.string().min(1),
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
export function parseEtsyUserTokenBundle(input: unknown): EtsyUserTokenBundle {
  const result = etsyUserTokenBundleSchema.safeParse(input);
  if (!result.success) {
    throw new EtsyAdapterError(
      "invalid_request",
      "invalid Etsy user token bundle",
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

/** Etsy's `POST /v3/public/oauth/token` response shape (structural). */
export interface ProviderTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  refresh_token?: unknown;
}

/** Etsy's documented access-token lifetime is one hour; used only as a fallback. */
const FALLBACK_ACCESS_TOKEN_TTL_SECONDS = 3600;

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

/** Split a raw `<userId>.<opaque>` access token. Throws on a malformed shape. */
export function splitEtsyAccessToken(raw: string): {
  etsyUserId: string;
  accessToken: string;
} {
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) {
    throw new EtsyAdapterError(
      "provider_unavailable",
      "Etsy access token was not shaped <userId>.<token>",
    );
  }
  return { etsyUserId: raw.slice(0, dot), accessToken: raw.slice(dot + 1) };
}

/** Reassemble the exact original access-token string for the Bearer header. */
export function providerBearerToken(bundle: EtsyUserTokenBundle): string {
  return `${bundle.etsyUserId}.${bundle.accessToken}`;
}

/**
 * Map a provider token response into a Loxep bundle.
 *
 * `previous` supplies what a REFRESH response may omit: Etsy's refresh grant
 * is documented to return a fresh access AND refresh token pair (unlike
 * eBay's, which omits the refresh token on refresh) — but this still
 * defensively carries the previous refresh token forward if one is somehow
 * missing, rather than crashing the refresh path.
 */
export function bundleFromProviderToken(
  token: ProviderTokenResponse,
  options: {
    now: Date;
    scopes: string[];
    previous?: Pick<
      EtsyUserTokenBundle,
      "refreshToken" | "refreshTokenExpiresAt"
    >;
  },
): EtsyUserTokenBundle {
  const rawAccessToken = nonEmptyString(token.access_token);
  if (rawAccessToken === null) {
    throw new EtsyAdapterError(
      "provider_unavailable",
      "Etsy token response contained no access_token",
    );
  }
  const { etsyUserId, accessToken } = splitEtsyAccessToken(rawAccessToken);
  const refreshToken =
    nonEmptyString(token.refresh_token) ?? options.previous?.refreshToken ?? null;
  if (refreshToken === null) {
    throw new EtsyAdapterError(
      "auth",
      "Etsy token response contained no refresh_token and none was carried forward",
    );
  }
  const expiresIn =
    positiveSeconds(token.expires_in) ?? FALLBACK_ACCESS_TOKEN_TTL_SECONDS;

  return {
    etsyUserId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: isoFromNow(options.now, expiresIn),
    // Etsy's docs do not promise a refresh-token expiry field; carry forward
    // whatever was previously known (null on a first exchange).
    refreshTokenExpiresAt: options.previous?.refreshTokenExpiresAt ?? null,
    scopes: [...options.scopes],
  };
}

/** True when `at` is at or past the access-token expiry minus `skewSeconds`. */
export function accessTokenNeedsRefresh(
  bundle: EtsyUserTokenBundle,
  at: Date,
  skewSeconds: number,
): boolean {
  return (
    Date.parse(bundle.accessTokenExpiresAt) - skewSeconds * 1000 <= at.getTime()
  );
}

/** True when the refresh token itself is known to have expired at `at`. */
export function refreshTokenExpired(
  bundle: EtsyUserTokenBundle,
  at: Date,
): boolean {
  return (
    bundle.refreshTokenExpiresAt !== null &&
    Date.parse(bundle.refreshTokenExpiresAt) <= at.getTime()
  );
}
