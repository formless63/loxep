/**
 * @loxep/integration-etsy — Loxep's Etsy integration boundary (ADR-0009,
 * loxep-g4t.1). Etsy Open API v3 has no first-party maintained Node/
 * TypeScript SDK, so this package calls it directly with native `fetch`
 * (like `@loxep/integration-woo`/`-medusa`/`-invoiceninja`), never
 * `@loxep/integration-ebay`'s `ebay-api` pattern. Provider payloads cross
 * this boundary as `Record<string, unknown>`; no provider type is exported.
 *
 * Design: `apps/docs/src/content/docs/architecture/etsy-integration-design.md`.
 * m1 scope: config, error taxonomy, the per-APPLICATION (not per-connection)
 * rate budget, dev credentials, OAuth2+PKCE consent, money conversion,
 * public-auth listing/shop reads, and observation mapping. Orders
 * (`orders.ts`) are m2, deliberately not in this package yet.
 */

export {
  ETSY_ERROR_KINDS,
  EtsyAdapterError,
  etsyErrorFromResponse,
  normalizeEtsyError,
  parseRetryAfterSeconds,
  readEtsyErrorBody,
  etsyKindFromStatus,
} from "./errors.ts";
export type {
  EtsyErrorContext,
  EtsyErrorKind,
  EtsyProviderErrorBody,
} from "./errors.ts";

export { createRateBudget } from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  EtsyAdapterLogger,
  RateBudget,
  RateBudgetStats,
} from "./rate-budget.ts";

export {
  ETSY_API_BASE_URL,
  etsyAdapterConfigSchema,
  etsySourceAccountKey,
  parseEtsyAdapterConfig,
} from "./config.ts";
export type { EtsyAdapterConfig, EtsyAdapterConfigInput } from "./config.ts";

export {
  defaultDevEnvFilePath,
  defaultDevUserTokenFilePath,
  loadDevKeysetFromEnvFile,
  loadDevUserTokenFromFile,
} from "./credentials.ts";
export type { EtsyDevKeyset } from "./credentials.ts";

export {
  accessTokenNeedsRefresh,
  bundleFromProviderToken,
  etsyUserTokenBundleSchema,
  parseEtsyUserTokenBundle,
  providerBearerToken,
  refreshTokenExpired,
  splitEtsyAccessToken,
} from "./tokens.ts";
export type {
  EtsyUserTokenBundle,
  ProviderTokenResponse,
} from "./tokens.ts";

export {
  MAX_QUOTIENT_SCALE,
  decimalFromEtsyMoney,
  etsyMoneyCurrency,
  normalizeEtsyMoney,
  requireEtsyMoney,
} from "./money.ts";
export type { EtsyMoney } from "./money.ts";

export {
  DEFAULT_ETSY_CONSENT_TIER,
  DEFAULT_REFRESH_SKEW_SECONDS,
  ETSY_AUTHORIZE_URL,
  ETSY_CONSENT_TIER_SCOPES,
  ETSY_ORDER_SCOPES,
  ETSY_SHOP_SCOPES,
  ETSY_TOKEN_URL,
  buildConsentState,
  buildConsentUrl,
  bundleFromCredential,
  consentScopesForTier,
  consentTierForScopes,
  credentialWriteForBundle,
  exchangeConsentCode,
  generatePkcePair,
  isEtsyConsentTier,
  refreshTokenBundleIfNeeded,
  refreshUserToken,
  tokenRefreshAfter,
  validateEtsyRedirectUri,
  verifyConsentState,
} from "./oauth.ts";
export type {
  ConsentState,
  EtsyConsentTier,
  EtsyConsentUrl,
  EtsyConsentUrlInput,
  EtsyCredentialWrite,
  EtsyOAuthFetch,
  ExchangeConsentCodeInput,
  PkcePair,
  RefreshTokenBundleInput,
  RefreshTokenBundleResult,
  RefreshUserTokenInput,
} from "./oauth.ts";

export { createEtsyAdapter } from "./adapter.ts";
export type {
  CreateEtsyAdapterInput,
  EtsyAdapter,
  EtsyAdapterStats,
  EtsyFetch,
  EtsyListPage,
  EtsyQuery,
  EtsyQueryValue,
  EtsySortOn,
  EtsySortOrder,
  EtsyUserAdapter,
  GetShopListingsActiveInput,
  GetShopListingsInput,
} from "./adapter.ts";

export {
  ETSY_LISTING_STATES,
  ETSY_LISTING_STATE_MAP,
  ETSY_MARKETPLACE,
  OBSERVATION_HASH_FIELDS,
  mapEtsyListingState,
  mapListingToSnapshot,
  observationStateHash,
  snapshotToObservation,
} from "./observation.ts";
export type {
  EtsyListingSnapshot,
  EtsyListingState,
  EtsyMarketplaceItemIdentity,
  EtsyObservation,
  EtsyObservationContext,
  EtsyObservationItem,
} from "./observation.ts";

export { probeConnection } from "./probe.ts";
export type { EtsyProbeResult } from "./probe.ts";
