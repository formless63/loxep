/**
 * eBay user-consent OAuth flow and token lifecycle (loxep-62y.1.2).
 *
 * VERIFIED against ebay-api@10.0.0 (`dist/auth/oAuth2.js`) — none of this
 * re-implements the protocol, it only owns the boundary:
 *
 * - `OAuth2.generateAuthUrl(ruName, scope, state)` builds
 *   `https://auth{.sandbox}.ebay.com/oauth2/authorize?client_id=…&
 *   redirect_uri=<RuName>&response_type=code&state=…&scope=…`. `redirect_uri`
 *   is the eBay **RuName** ("eBay Redirect URL name"), NOT the callback URL;
 *   the actual https callback is configured on the keyset in eBay's developer
 *   portal and eBay resolves the RuName to it.
 * - `OAuth2.getToken(code)` POSTs `grant_type=authorization_code` to the
 *   identity endpoint with HTTP-Basic `appId:certId` and returns
 *   `{access_token, expires_in, refresh_token, refresh_token_expires_in,
 *   token_type}`. It does NOT store the token (that is `obtainToken`), which
 *   is exactly what Loxep wants: the bundle is persisted, not cached in a
 *   process.
 * - `OAuth2.refreshUserAccessToken()` POSTs `grant_type=refresh_token` with
 *   the client's configured scope and merges the response over the previous
 *   token — eBay's refresh response carries no refresh_token, so the refresh
 *   token and its expiry carry forward.
 *
 * SCOPES: Trading (GetMyeBayBuying, the watchlist source) is a *traditional*
 * API and, per eBay's "Using OAuth with the eBay traditional APIs", traditional
 * APIs do not use OAuth scopes at all — the User access token is presented in
 * the `X-EBAY-API-IAF-TOKEN` header and authorizes on the app+user identity.
 * The default consent set is therefore the base scope
 * `https://api.ebay.com/oauth/api_scope`, which every keyset has and which the
 * authorization-code grant accepts. Requesting scopes a keyset was not granted
 * makes eBay reject the consent with `invalid_scope`, so extra scopes are
 * opt-in per call rather than defaulted.
 *
 * STATE/CSRF: {@link buildConsentState} / {@link verifyConsentState} implement
 * the binding used by the web layer — a random nonce lives in a short-lived
 * httpOnly cookie, and the `state` parameter carries
 * `<sha256(nonce.connectionId)>.<connectionId>`. The state is public (it
 * travels through eBay, browser history, and referrer headers) so it carries
 * only a HASH, never the nonce; possession of the cookie is what proves the
 * callback belongs to the browser that started the flow, and hashing the
 * connection id alongside the nonce stops a tampered state from retargeting
 * the consent at a different connection.
 *
 * PERSISTENCE: this module is deliberately persistence-free — see
 * `tokens.ts` for the documented credential mapping ('ebay_oauth' slot stored
 * under the registered `oauth_tokens` purpose). {@link refreshTokenBundleIfNeeded}
 * takes and returns a bundle; the caller writes it back.
 */
import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  adapterInternals,
  type EbayAdapter,
  type EbayUserAdapter,
} from "./adapter.ts";
import { EbayAdapterError } from "./errors.ts";
import {
  accessTokenNeedsRefresh,
  bundleFromProviderToken,
  refreshTokenExpired,
  type EbayUserTokenBundle,
} from "./tokens.ts";

/**
 * Base scope — the only scope needed for the traditional Trading calls the
 * watchlist vertical uses, and the one scope every keyset holds.
 */
export const EBAY_BASE_SCOPE = "https://api.ebay.com/oauth/api_scope";

export const EBAY_DEFAULT_CONSENT_SCOPES: readonly string[] = [
  EBAY_BASE_SCOPE,
];

/**
 * Read-only Sell Fulfillment scope — required by `GET /sell/fulfillment/v1/
 * order`, the source of Phase 3 eBay order ingestion (`orders.ts`). RESTful
 * Sell APIs, unlike the traditional Trading calls, DO enforce OAuth scopes.
 *
 * It is deliberately NOT in {@link EBAY_DEFAULT_CONSENT_SCOPES}: requesting a
 * scope a keyset was not granted makes eBay reject the whole consent with
 * `invalid_scope`, which would break watchlist connections that need nothing
 * beyond the base scope. A connection that intends to ingest orders consents
 * with {@link EBAY_ORDER_CONSENT_SCOPES} instead, and a bundle stored before
 * that (base scope only) gets an `auth` error from `sellGetOrders` — the
 * correct, diagnosable outcome, not a silent empty result.
 */
export const EBAY_SELL_FULFILLMENT_READONLY_SCOPE =
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly";

/** Consent set a connection needs for order ingestion. */
export const EBAY_ORDER_CONSENT_SCOPES: readonly string[] = [
  EBAY_BASE_SCOPE,
  EBAY_SELL_FULFILLMENT_READONLY_SCOPE,
];

/** Refresh an access token this many seconds before it actually expires. */
export const DEFAULT_REFRESH_SKEW_SECONDS = 300;

/** Placeholder "already expired" instant for refresh-only token bundles. */
const EPOCH_ISO = new Date(0).toISOString();

export interface EbayConsentUrlInput {
  /** Opaque CSRF/binding value; see {@link buildConsentState}. */
  state: string;
  /** Defaults to {@link EBAY_DEFAULT_CONSENT_SCOPES}. */
  scopes?: readonly string[];
}

export interface EbayConsentUrl {
  url: string;
  /** Scopes actually requested — persist these with the bundle. */
  scopes: string[];
  state: string;
}

/**
 * Build the eBay consent URL. Pure string construction (no network, no rate
 * budget): the library's `generateAuthUrl` only formats a URL.
 */
export function buildConsentUrl(
  adapter: EbayAdapter,
  input: EbayConsentUrlInput,
): EbayConsentUrl {
  const internals = adapterInternals(adapter);
  if (internals.config.ruName === undefined) {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay consent needs a configured RuName (eBay Redirect URL name)",
      { environment: internals.config.environment },
    );
  }
  if (input.state === "") {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay consent needs a non-empty state value",
    );
  }
  const scopes = [...(input.scopes ?? EBAY_DEFAULT_CONSENT_SCOPES)];
  if (scopes.length === 0) {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay consent needs at least one scope",
    );
  }
  const url = internals.client.OAuth2.generateAuthUrl(
    internals.config.ruName,
    scopes,
    input.state,
  );
  return { url, scopes, state: input.state };
}

/**
 * Exchange the `code` eBay put on the callback URL for a user token bundle.
 * Consumes one rate-budget token like every other provider call.
 */
export async function exchangeConsentCode(
  adapter: EbayAdapter,
  input: { code: string; scopes?: readonly string[] },
): Promise<EbayUserTokenBundle> {
  const internals = adapterInternals(adapter);
  if (input.code === "") {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay authorization code is empty",
    );
  }
  const scopes = [...(input.scopes ?? EBAY_DEFAULT_CONSENT_SCOPES)];
  return internals.call("oauth2.exchangeConsentCode", async () => {
    const token = await internals.client.OAuth2.getToken(input.code);
    return bundleFromProviderToken(token as Record<string, unknown>, {
      now: new Date(),
      scopes,
    });
  });
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * `scopes` must be the scopes the consent was granted for (eBay requires the
 * refresh grant's scope to be a subset); pass the stored bundle's scopes.
 * `refreshTokenExpiresAt` carries forward because eBay's refresh response
 * does not repeat it.
 */
export async function refreshUserToken(
  adapter: EbayAdapter,
  input: {
    refreshToken: string;
    scopes?: readonly string[];
    refreshTokenExpiresAt?: string | null;
  },
): Promise<EbayUserTokenBundle> {
  if (input.refreshToken === "") {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay refresh token is empty",
    );
  }
  const scopes = [...(input.scopes ?? EBAY_DEFAULT_CONSENT_SCOPES)];
  // A user-context adapter owns the only refresh implementation: it holds a
  // dedicated client (setting credentials on the shared adapter's client
  // would re-authorize its application-scoped Browse calls) with the granted
  // scopes set, which eBay requires on the refresh_token grant.
  const user = adapter.withUserToken({
    // Deliberate placeholder: the refresh grant reads only the refresh token.
    accessToken: "",
    accessTokenExpiresAt: EPOCH_ISO,
    refreshToken: input.refreshToken,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
    scopes,
  });
  return user.refreshUserToken();
}

export interface RefreshTokenBundleInput {
  bundle: EbayUserTokenBundle;
  adapter: EbayAdapter;
  now?: Date;
  /** Refresh this many seconds early. Default {@link DEFAULT_REFRESH_SKEW_SECONDS}. */
  refreshSkewSeconds?: number;
}

export interface RefreshTokenBundleResult {
  bundle: EbayUserTokenBundle;
  refreshed: boolean;
}

/**
 * The token-lifecycle decision, free of persistence: refresh when the access
 * token is expired or within the skew window, otherwise return the bundle
 * unchanged. Callers (the durable refresh task, the watchlist poller, the
 * callback route) own reading and writing the credential.
 *
 * A dead refresh token raises `auth` — that state is only recoverable by
 * repeating user consent, and callers should surface it as such rather than
 * retrying.
 */
export async function refreshTokenBundleIfNeeded(
  input: RefreshTokenBundleInput,
): Promise<RefreshTokenBundleResult> {
  const now = input.now ?? new Date();
  const skew = input.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS;
  if (!accessTokenNeedsRefresh(input.bundle, now, skew)) {
    return { bundle: input.bundle, refreshed: false };
  }
  if (refreshTokenExpired(input.bundle, now)) {
    throw new EbayAdapterError(
      "auth",
      "eBay refresh token has expired; the connection needs user consent again",
      { refreshTokenExpiresAt: input.bundle.refreshTokenExpiresAt },
    );
  }
  const bundle = await refreshUserToken(input.adapter, {
    refreshToken: input.bundle.refreshToken,
    scopes: input.bundle.scopes,
    refreshTokenExpiresAt: input.bundle.refreshTokenExpiresAt,
  });
  return { bundle, refreshed: true };
}

/**
 * Instant a stored credential should be proactively refreshed at — maps
 * straight onto `connection_credential_versions.refresh_after`.
 */
export function tokenRefreshAfter(
  bundle: EbayUserTokenBundle,
  refreshSkewSeconds: number = DEFAULT_REFRESH_SKEW_SECONDS,
): Date {
  return new Date(
    Date.parse(bundle.accessTokenExpiresAt) - refreshSkewSeconds * 1000,
  );
}

/**
 * The persistence shape for one bundle, in the vocabulary of
 * `@loxep/domain`'s connection-credentials service (no import — this package
 * has no domain dependency by design; see `tokens.ts` for the mapping table).
 *
 * Splitting secret from non-secret is the point: only the two token strings
 * are encrypted credential material. Scopes and the refresh-token expiry are
 * ordinary connection metadata and belong on `connections.config`, where
 * they can be read without decrypting anything.
 */
export interface EbayCredentialWrite {
  /** Registered `@loxep/domain` purpose for the 'ebay_oauth' slot. */
  credentialType: "oauth_tokens";
  payload: { accessToken: string; refreshToken: string };
  /** → `connection_credential_versions.expires_at` */
  expiresAt: Date;
  /** → `connection_credential_versions.refresh_after` */
  refreshAfter: Date;
  /** → `connections.config.ebayOAuth` (non-secret) */
  connectionConfig: {
    scopes: string[];
    refreshTokenExpiresAt: string | null;
  };
}

export function credentialWriteForBundle(
  bundle: EbayUserTokenBundle,
  options: { refreshSkewSeconds?: number } = {},
): EbayCredentialWrite {
  return {
    credentialType: "oauth_tokens",
    payload: {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
    },
    expiresAt: new Date(bundle.accessTokenExpiresAt),
    refreshAfter: tokenRefreshAfter(bundle, options.refreshSkewSeconds),
    connectionConfig: {
      scopes: [...bundle.scopes],
      refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
    },
  };
}

/**
 * Rebuild a bundle from what persistence holds. The inverse of
 * {@link credentialWriteForBundle}; used by the poller/refresh task after
 * reading the encrypted credential and the connection's config.
 */
export function bundleFromCredential(input: {
  payload: { accessToken: string; refreshToken?: string | undefined };
  expiresAt: Date | string | null;
  scopes?: readonly string[] | undefined;
  refreshTokenExpiresAt?: string | null | undefined;
}): EbayUserTokenBundle {
  if (input.payload.refreshToken === undefined) {
    throw new EbayAdapterError(
      "auth",
      "stored eBay credential has no refresh token; the connection needs user consent again",
    );
  }
  if (input.expiresAt === null) {
    throw new EbayAdapterError(
      "invalid_request",
      "stored eBay credential has no access-token expiry",
    );
  }
  const expiresAt =
    input.expiresAt instanceof Date
      ? input.expiresAt.toISOString()
      : new Date(input.expiresAt).toISOString();
  return {
    accessToken: input.payload.accessToken,
    refreshToken: input.payload.refreshToken,
    accessTokenExpiresAt: expiresAt,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
    scopes: [...(input.scopes ?? EBAY_DEFAULT_CONSENT_SCOPES)],
  };
}

/** Convenience: bind a stored bundle to a user-context adapter. */
export function userAdapterFromBundle(
  adapter: EbayAdapter,
  bundle: EbayUserTokenBundle,
): EbayUserAdapter {
  return adapter.withUserToken(bundle);
}

// ---------------------------------------------------------------------------
// Consent state (CSRF binding)
// ---------------------------------------------------------------------------

/** Bytes of entropy in a consent nonce. */
const NONCE_BYTES = 32;

export interface ConsentState {
  state: string;
  /** Store httpOnly + short-lived; never in a URL, never logged. */
  nonce: string;
  connectionId: string;
}

/**
 * The binding covers the connection id as well as the nonce, so a tampered
 * `state` cannot redirect a consent onto a different connection.
 */
function stateBinding(nonce: string, connectionId: string): string {
  return createHash("sha256")
    .update(`${nonce}.${connectionId}`, "utf8")
    .digest("base64url");
}

/**
 * Fresh nonce + `state` for one consent attempt. `state` is safe to place in
 * a URL: it carries a hash over the nonce, not the nonce.
 */
export function buildConsentState(connectionId: string): ConsentState {
  if (connectionId === "" || connectionId.includes(".")) {
    throw new EbayAdapterError(
      "invalid_request",
      "consent state needs a non-empty connection id without '.'",
    );
  }
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  return {
    state: `${stateBinding(nonce, connectionId)}.${connectionId}`,
    nonce,
    connectionId,
  };
}

/**
 * Validate the `state` eBay handed back against the nonce cookie. Returns the
 * bound connection id. Comparison is constant-time and every failure is one
 * indistinguishable `invalid_request` — a state check must not tell an
 * attacker WHICH half was wrong.
 */
export function verifyConsentState(
  state: string | undefined | null,
  nonce: string | undefined | null,
): { connectionId: string } {
  const reject = (): never => {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay consent state did not match the pending consent request",
    );
  };
  if (typeof state !== "string" || typeof nonce !== "string") return reject();
  const separator = state.indexOf(".");
  if (separator <= 0 || separator === state.length - 1) return reject();
  const presented = state.slice(0, separator);
  const connectionId = state.slice(separator + 1);
  if (nonce === "") return reject();

  const expected = Buffer.from(stateBinding(nonce, connectionId), "utf8");
  const actual = Buffer.from(presented, "utf8");
  if (expected.length !== actual.length) return reject();
  if (!timingSafeEqual(expected, actual)) return reject();
  return { connectionId };
}
