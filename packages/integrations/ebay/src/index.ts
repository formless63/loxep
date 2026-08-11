/**
 * @loxep/integration-ebay — Loxep's eBay integration boundary (ADR-0009).
 *
 * hendt/ebay-api v10 does the protocol work (OAuth2 client-credentials and
 * authorization-code token management, Buy Browse REST group, Trading XML
 * group); this package owns the boundary: typed config, error taxonomy,
 * per-connection rate budget, user-consent/token lifecycle, and mapping into
 * Loxep-owned snapshot/observation/watchlist shapes. Provider SDK types
 * deliberately do NOT appear in any exported type below — including the
 * provider client itself, which is reachable only through the
 * boundary-internal `adapterInternals()` handle in `adapter.ts`.
 */

export {
  EBAY_ERROR_KINDS,
  EbayAdapterError,
  normalizeEbayError,
} from "./errors.ts";
export type { EbayErrorKind } from "./errors.ts";

export {
  EBAY_ENVIRONMENTS,
  ebayAdapterConfigSchema,
  parseEbayAdapterConfig,
} from "./config.ts";
export type {
  EbayAdapterConfig,
  EbayAdapterConfigInput,
  EbayEnvironment,
} from "./config.ts";

export { createRateBudget } from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  EbayAdapterLogger,
  RateBudget,
  RateBudgetStats,
} from "./rate-budget.ts";

export {
  defaultSandboxEnvFilePath,
  defaultSandboxUserTokenFilePath,
  loadSandboxCredentialsFromEnvFile,
  loadSandboxUserTokenFromFile,
} from "./credentials.ts";
export type { EbaySandboxCredentials } from "./credentials.ts";

export { createEbayAdapter } from "./adapter.ts";
export type {
  EbayAdapter,
  EbayAdapterStats,
  EbayApplicationTokenInfo,
  EbayBrowseSearchInput,
  EbayBrowseSearchResult,
  EbayUserAdapter,
  EbayUserAdapterOptions,
} from "./adapter.ts";

export {
  accessTokenNeedsRefresh,
  bundleFromProviderToken,
  ebayUserTokenBundleSchema,
  parseEbayUserTokenBundle,
  providerTokenFromBundle,
  refreshTokenExpired,
} from "./tokens.ts";
export type { EbayUserTokenBundle } from "./tokens.ts";

export {
  DEFAULT_REFRESH_SKEW_SECONDS,
  EBAY_BASE_SCOPE,
  EBAY_DEFAULT_CONSENT_SCOPES,
  buildConsentState,
  buildConsentUrl,
  bundleFromCredential,
  credentialWriteForBundle,
  exchangeConsentCode,
  refreshTokenBundleIfNeeded,
  refreshUserToken,
  tokenRefreshAfter,
  userAdapterFromBundle,
  verifyConsentState,
} from "./oauth.ts";
export type {
  ConsentState,
  EbayConsentUrl,
  EbayConsentUrlInput,
  EbayCredentialWrite,
  RefreshTokenBundleInput,
  RefreshTokenBundleResult,
} from "./oauth.ts";

export {
  DEFAULT_WATCHLIST_ENTRIES_PER_PAGE,
  WATCHLIST_CALL_NAME,
  fetchAllWatchlistEntries,
  fetchWatchlist,
  mapWatchlistItem,
  mapWatchlistResponse,
} from "./watchlist.ts";
export type {
  EbayWatchlistEntry,
  EbayWatchlistPage,
  FetchWatchlistInput,
} from "./watchlist.ts";

export {
  fetchItemSnapshot,
  fetchItemSnapshotByLegacyId,
  mapItemToSnapshot,
} from "./snapshot.ts";
export type { EbayItemSnapshot, EbayMoney } from "./snapshot.ts";

export {
  OBSERVATION_HASH_FIELDS,
  observationStateHash,
  snapshotToObservation,
} from "./observation.ts";
export type {
  EbayMarketplaceItemIdentity,
  EbayObservation,
  EbayObservationContext,
  EbayObservationItem,
} from "./observation.ts";
