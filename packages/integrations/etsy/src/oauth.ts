/**
 * Etsy user-consent OAuth2 + PKCE flow and token lifecycle (loxep-g4t.1).
 *
 * ## The load-bearing divergence from eBay: PKCE is mandatory
 *
 * Per the binding design (`etsy-integration-design.md`, "OAuth2 PKCE flow"),
 * SOURCE-VERIFIED against `anitabyte/etsyv3` (`main` branch, fetched
 * 2026-08-13, `etsyv3/util/auth/auth_helper.py`):
 *
 * ```text
 * 1. Loxep generates a high-entropy code_verifier (43-128 chars,
 *    [A-Za-z0-9._~-]) and derives
 *    code_challenge = base64url(sha256(code_verifier)), no padding.
 * 2. Authorize:  GET https://www.etsy.com/oauth/connect
 *                  ?response_type=code&client_id=<keystring>
 *                  &redirect_uri=<uri>&scope=<space-separated>
 *                  &state=<csrf-binding>&code_challenge=<challenge>
 *                  &code_challenge_method=S256
 * 3. Callback carries `code` + `state`; verified the same way
 *    `verifyConsentState` verifies eBay's (nonce cookie + hashed binding —
 *    that logic is provider-agnostic and is DUPLICATED here verbatim per
 *    ADR-0009's no-cross-integration-dependency rule, not imported).
 * 4. Token exchange: POST https://api.etsy.com/v3/public/oauth/token
 *                  grant_type=authorization_code, client_id, code,
 *                  code_verifier (the ORIGINAL verifier, not the challenge),
 *                  redirect_uri.
 * 5. Refresh: POST the same endpoint, grant_type=refresh_token,
 *                  client_id, refresh_token — no code_verifier needed here.
 * ```
 *
 * eBay's traditional-era `ebay-api` client flow uses NO PKCE at all; this is
 * the one adapter in the codebase that implements RFC 7636.
 *
 * `code_verifier` must be generated and HELD ACROSS the request/callback
 * boundary — it is short-lived, server-side state exactly like eBay's
 * consent nonce, and the design directs it to live alongside the nonce in
 * the same short-lived httpOnly-cookie mechanism at the web layer (see
 * `apps/web/src/server/etsy-oauth.ts`), not be reinvented.
 *
 * ## Scopes and tiers (loxep-ld0's `EbayConsentTier` pattern, reused)
 *
 * Etsy scope-checks EVERY private-auth call (unlike eBay's traditional
 * Trading calls, which use none at all). This maps onto the same tier
 * pattern eBay's `oauth.ts` established:
 *
 * ```text
 * tier      scopes                          unlocks
 * 'shop'    shops_r, listings_r             read the connected shop's full
 *                                            listing set, including
 *                                            drafts/inactive
 * 'orders'  shops_r, listings_r,            + read receipts/transactions
 *           transactions_r                    (loxep-g4t.2, not m1)
 * ```
 *
 * A `'listing_write'` tier (`+listings_w`) is deliberately NOT modeled here —
 * see the design's "Staged milestones" (m5, unscoped).
 *
 * PERSISTENCE: this module is deliberately persistence-free, mirroring
 * `@loxep/integration-ebay/oauth.ts` — see `connection.ts` for the
 * documented credential mapping. {@link refreshTokenBundleIfNeeded} takes and
 * returns a bundle; the caller writes it back.
 */
import { Buffer } from "node:buffer";
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  etsyErrorFromResponse,
  normalizeEtsyError,
  EtsyAdapterError,
  type EtsyErrorContext,
} from "./errors.ts";
import type { RateBudget } from "./rate-budget.ts";
import {
  accessTokenNeedsRefresh,
  bundleFromProviderToken,
  refreshTokenExpired,
  type EtsyUserTokenBundle,
} from "./tokens.ts";

/** Etsy's authorization endpoint — SOURCE-VERIFIED, see the module doc. */
export const ETSY_AUTHORIZE_URL = "https://www.etsy.com/oauth/connect";
/** Etsy's token endpoint — SOURCE-VERIFIED, see the module doc. */
export const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

export const ETSY_SHOP_SCOPES: readonly string[] = ["shops_r", "listings_r"];
export const ETSY_ORDER_SCOPES: readonly string[] = [
  "shops_r",
  "listings_r",
  "transactions_r",
];

export type EtsyConsentTier = "shop" | "orders";

/** The scope set behind each tier. Exhaustive over {@link EtsyConsentTier}. */
export const ETSY_CONSENT_TIER_SCOPES = {
  shop: ETSY_SHOP_SCOPES,
  orders: ETSY_ORDER_SCOPES,
} as const satisfies Record<EtsyConsentTier, readonly string[]>;

/** Tier assumed whenever nothing said otherwise — the narrow, always-grantable one. */
export const DEFAULT_ETSY_CONSENT_TIER: EtsyConsentTier = "shop";

/** Narrow untrusted input (a stored config value, a request field) to a tier. */
export function isEtsyConsentTier(value: unknown): value is EtsyConsentTier {
  return value === "shop" || value === "orders";
}

/** Resolve a tier to the scopes to request. The ONLY sanctioned way outside this module. */
export function consentScopesForTier(tier: EtsyConsentTier): string[] {
  return [...ETSY_CONSENT_TIER_SCOPES[tier]];
}

/**
 * Classify scopes already granted (as recorded on
 * `connections.config.etsyOAuth.scopes`) back into a tier. Anything carrying
 * `transactions_r` is an `orders` connection; everything else — including a
 * missing/unreadable value — reads as `shop`, the conservative answer.
 */
export function consentTierForScopes(
  scopes: readonly string[] | null | undefined,
): EtsyConsentTier {
  return Array.isArray(scopes) && scopes.includes("transactions_r")
    ? "orders"
    : "shop";
}

/** Refresh an access token this many seconds before it actually expires. */
export const DEFAULT_REFRESH_SKEW_SECONDS = 300;

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** RFC 7636 code_verifier length bounds. */
const CODE_VERIFIER_BYTES = 64; // base64url-encodes to 86 chars, inside [43,128].

export interface PkcePair {
  /** Held server-side across the request/callback boundary; never in a URL. */
  codeVerifier: string;
  /** Safe to place in the authorization URL. */
  codeChallenge: string;
}

/**
 * Generate a fresh PKCE pair. `code_verifier` uses base64url's alphabet
 * (`[A-Za-z0-9_-]`), a subset of RFC 7636's allowed `[A-Za-z0-9._~-]`, so no
 * further escaping is needed anywhere this travels.
 */
export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(CODE_VERIFIER_BYTES).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier, "utf8")
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// Redirect URI validation — the documented loopback exception
// ---------------------------------------------------------------------------

/**
 * Validate an OAuth redirect URI: HTTPS in production, with the documented
 * exception for an `http://127.0.0.1` loopback (local development only —
 * per the design's owner-prerequisites item 4). Throws `invalid_request`
 * rather than silently sending a credential-bearing consent request over
 * plain HTTP to a real host.
 */
export function validateEtsyRedirectUri(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new EtsyAdapterError(
      "invalid_request",
      "Etsy redirect URI is not a valid absolute URL",
    );
  }
  if (parsed.protocol === "https:") return uri;
  const isLoopback = parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  if (isLoopback) return uri;
  throw new EtsyAdapterError(
    "invalid_request",
    "Etsy redirect URI must use https:, or http://127.0.0.1 for local development",
    { protocol: parsed.protocol, hostname: parsed.hostname },
  );
}

// ---------------------------------------------------------------------------
// Consent URL
// ---------------------------------------------------------------------------

export interface EtsyConsentUrlInput {
  keystring: string;
  redirectUri: string;
  /** Opaque CSRF/binding value; see {@link buildConsentState}. */
  state: string;
  scopes: readonly string[];
  codeChallenge: string;
}

export interface EtsyConsentUrl {
  url: string;
  scopes: string[];
  state: string;
}

/** Build the Etsy PKCE consent URL. Pure string construction (no network). */
export function buildConsentUrl(input: EtsyConsentUrlInput): EtsyConsentUrl {
  if (input.keystring.trim() === "") {
    throw new EtsyAdapterError(
      "invalid_request",
      "Etsy consent needs a non-empty keystring",
    );
  }
  if (input.state === "") {
    throw new EtsyAdapterError(
      "invalid_request",
      "Etsy consent needs a non-empty state value",
    );
  }
  const scopes = [...input.scopes];
  if (scopes.length === 0) {
    throw new EtsyAdapterError(
      "invalid_request",
      "Etsy consent needs at least one scope",
    );
  }
  const redirectUri = validateEtsyRedirectUri(input.redirectUri);
  const url = new URL(ETSY_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.keystring);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), scopes, state: input.state };
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

export type EtsyOAuthFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

interface OAuthCallInput {
  keystring: string;
  sharedSecret: string;
  body: Record<string, string>;
  operation: string;
  fetchImpl?: EtsyOAuthFetch;
  timeoutMs?: number;
  /**
   * Optional: the shared per-application budget. Web-triggered consent
   * calls (rare, human-interactive) commonly omit this — mirroring how
   * `apps/web/src/server/ebay-oauth-internal.ts` builds an eBay adapter with
   * no shared budget for its own one-off calls — rather than reaching across
   * a process boundary into the worker's in-memory bucket.
   */
  rateBudget?: RateBudget;
}

async function postToken(input: OAuthCallInput): Promise<unknown> {
  const doFetch: EtsyOAuthFetch =
    input.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  if (input.rateBudget !== undefined) {
    await input.rateBudget.acquire(1);
  }
  const context: EtsyErrorContext = {
    operation: input.operation,
    path: "/v3/public/oauth/token",
  };
  let response: Response;
  try {
    response = await doFetch(ETSY_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "x-api-key": `${input.keystring}:${input.sharedSecret}`,
      },
      body: new URLSearchParams(input.body).toString(),
      redirect: "follow",
      signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw normalizeEtsyError(error, context);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const looksJson = contentType.toLowerCase().includes("json");
  let body: unknown = null;
  let parseFailed = false;
  if (looksJson) {
    try {
      body = await response.json();
    } catch {
      parseFailed = true;
    }
  } else {
    await response.text().catch(() => "");
  }

  if (!response.ok) {
    throw etsyErrorFromResponse(
      response.status,
      parseFailed ? null : body,
      context,
      response.headers.get("retry-after"),
    );
  }
  if (!looksJson || parseFailed) {
    throw new EtsyAdapterError(
      "provider_unavailable",
      "Etsy returned a non-JSON body for a successful token response",
      { operation: input.operation, httpStatus: response.status },
    );
  }
  return body;
}

export interface ExchangeConsentCodeInput {
  keystring: string;
  sharedSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: readonly string[];
  fetchImpl?: EtsyOAuthFetch;
  timeoutMs?: number;
  rateBudget?: RateBudget;
}

/**
 * Exchange the `code` Etsy put on the callback URL for a user token bundle.
 */
export async function exchangeConsentCode(
  input: ExchangeConsentCodeInput,
): Promise<EtsyUserTokenBundle> {
  if (input.code === "") {
    throw new EtsyAdapterError(
      "invalid_request",
      "Etsy authorization code is empty",
    );
  }
  const body = await postToken({
    keystring: input.keystring,
    sharedSecret: input.sharedSecret,
    operation: "oauth2.exchangeConsentCode",
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    rateBudget: input.rateBudget,
    body: {
      grant_type: "authorization_code",
      client_id: input.keystring,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    },
  });
  return bundleFromProviderToken(body as Record<string, unknown>, {
    now: new Date(),
    scopes: [...input.scopes],
  });
}

export interface RefreshUserTokenInput {
  keystring: string;
  sharedSecret: string;
  refreshToken: string;
  scopes: readonly string[];
  refreshTokenExpiresAt?: string | null;
  fetchImpl?: EtsyOAuthFetch;
  timeoutMs?: number;
  rateBudget?: RateBudget;
}

/** Exchange a refresh token for a fresh access token (no code_verifier needed). */
export async function refreshUserToken(
  input: RefreshUserTokenInput,
): Promise<EtsyUserTokenBundle> {
  if (input.refreshToken === "") {
    throw new EtsyAdapterError(
      "invalid_request",
      "Etsy refresh token is empty",
    );
  }
  const body = await postToken({
    keystring: input.keystring,
    sharedSecret: input.sharedSecret,
    operation: "oauth2.refreshUserToken",
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    rateBudget: input.rateBudget,
    body: {
      grant_type: "refresh_token",
      client_id: input.keystring,
      refresh_token: input.refreshToken,
    },
  });
  return bundleFromProviderToken(body as Record<string, unknown>, {
    now: new Date(),
    scopes: [...input.scopes],
    previous: {
      refreshToken: input.refreshToken,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
    },
  });
}

export interface RefreshTokenBundleInput {
  bundle: EtsyUserTokenBundle;
  keystring: string;
  sharedSecret: string;
  now?: Date;
  refreshSkewSeconds?: number;
  fetchImpl?: EtsyOAuthFetch;
  timeoutMs?: number;
  rateBudget?: RateBudget;
}

export interface RefreshTokenBundleResult {
  bundle: EtsyUserTokenBundle;
  refreshed: boolean;
}

/**
 * The token-lifecycle decision, free of persistence: refresh when the access
 * token is expired or within the skew window, otherwise return the bundle
 * unchanged. Callers (the durable refresh task, the consent callback) own
 * reading and writing the credential.
 *
 * A dead refresh token raises `auth` — that state is only recoverable by
 * repeating user consent.
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
    throw new EtsyAdapterError(
      "auth",
      "Etsy refresh token has expired; the connection needs user consent again",
      { refreshTokenExpiresAt: input.bundle.refreshTokenExpiresAt },
    );
  }
  const bundle = await refreshUserToken({
    keystring: input.keystring,
    sharedSecret: input.sharedSecret,
    refreshToken: input.bundle.refreshToken,
    scopes: input.bundle.scopes,
    refreshTokenExpiresAt: input.bundle.refreshTokenExpiresAt,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    rateBudget: input.rateBudget,
  });
  return { bundle, refreshed: true };
}

/**
 * Instant a stored credential should be proactively refreshed at — maps
 * straight onto `connection_credential_versions.refresh_after`.
 */
export function tokenRefreshAfter(
  bundle: EtsyUserTokenBundle,
  refreshSkewSeconds: number = DEFAULT_REFRESH_SKEW_SECONDS,
): Date {
  return new Date(
    Date.parse(bundle.accessTokenExpiresAt) - refreshSkewSeconds * 1000,
  );
}

/**
 * The persistence shape for one bundle — see `connection.ts` for the full
 * contract. Splitting secret from non-secret is the point: only the OPAQUE
 * remainder of the access token and the refresh token are encrypted
 * credential material; the Etsy user id, scopes, and refresh-token expiry
 * are ordinary connection metadata.
 */
export interface EtsyCredentialWrite {
  /** Registered `@loxep/domain` purpose reused for the 'etsy_oauth' slot. */
  credentialType: "oauth_tokens";
  payload: { accessToken: string; refreshToken: string };
  /** -> `connection_credential_versions.expires_at` */
  expiresAt: Date;
  /** -> `connection_credential_versions.refresh_after` */
  refreshAfter: Date;
  /** -> `connections.config.etsyOAuth` (non-secret) */
  connectionConfig: {
    etsyUserId: string;
    scopes: string[];
    refreshTokenExpiresAt: string | null;
  };
}

export function credentialWriteForBundle(
  bundle: EtsyUserTokenBundle,
  options: { refreshSkewSeconds?: number } = {},
): EtsyCredentialWrite {
  return {
    credentialType: "oauth_tokens",
    payload: {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
    },
    expiresAt: new Date(bundle.accessTokenExpiresAt),
    refreshAfter: tokenRefreshAfter(bundle, options.refreshSkewSeconds),
    connectionConfig: {
      etsyUserId: bundle.etsyUserId,
      scopes: [...bundle.scopes],
      refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
    },
  };
}

/**
 * Rebuild a bundle from what persistence holds. The inverse of
 * {@link credentialWriteForBundle}; used by the poller/refresh task after
 * reading the encrypted credential and the connection's non-secret config.
 */
export function bundleFromCredential(input: {
  payload: { accessToken: string; refreshToken?: string | undefined };
  expiresAt: Date | string | null;
  etsyUserId: string;
  scopes?: readonly string[] | undefined;
  refreshTokenExpiresAt?: string | null | undefined;
}): EtsyUserTokenBundle {
  if (input.payload.refreshToken === undefined) {
    throw new EtsyAdapterError(
      "auth",
      "stored Etsy credential has no refresh token; the connection needs user consent again",
    );
  }
  if (input.expiresAt === null) {
    throw new EtsyAdapterError(
      "invalid_request",
      "stored Etsy credential has no access-token expiry",
    );
  }
  if (input.etsyUserId.trim() === "") {
    throw new EtsyAdapterError(
      "invalid_request",
      "stored Etsy connection has no etsyUserId on its non-secret config",
    );
  }
  const expiresAt =
    input.expiresAt instanceof Date
      ? input.expiresAt.toISOString()
      : new Date(input.expiresAt).toISOString();
  return {
    etsyUserId: input.etsyUserId,
    accessToken: input.payload.accessToken,
    refreshToken: input.payload.refreshToken,
    accessTokenExpiresAt: expiresAt,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
    scopes: [...(input.scopes ?? ETSY_SHOP_SCOPES)],
  };
}

// ---------------------------------------------------------------------------
// Consent state (CSRF binding) — DUPLICATED from eBay's oauth.ts verbatim.
// The algorithm is provider-agnostic; ADR-0009 forbids sharing it via a
// cross-integration import, so it is re-implemented here rather than reused.
// ---------------------------------------------------------------------------

const NONCE_BYTES = 32;

export interface ConsentState {
  state: string;
  /** Store httpOnly + short-lived; never in a URL, never logged. */
  nonce: string;
  connectionId: string;
}

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
    throw new EtsyAdapterError(
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
 * Validate the `state` Etsy handed back against the nonce cookie. Returns
 * the bound connection id. Comparison is constant-time and every failure is
 * one indistinguishable `invalid_request`.
 */
export function verifyConsentState(
  state: string | undefined | null,
  nonce: string | undefined | null,
): { connectionId: string } {
  const reject = (): never => {
    throw new EtsyAdapterError(
      "invalid_request",
      "Etsy consent state did not match the pending consent request",
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
