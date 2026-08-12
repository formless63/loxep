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
  EbaySellOrdersQuery,
  EbayUserAdapter,
  EbayUserAdapterOptions,
} from "./adapter.ts";

export {
  DECIMAL_STRING,
  MAX_QUOTIENT_SCALE,
  absDecimal,
  amountCurrency,
  amountValue,
  decimalFromNumber,
  decimalFromProvider,
  decimalFromUnknown,
  divideDecimals,
  isDecimalString,
  isZeroDecimal,
  subtractDecimals,
  sumDecimals,
} from "./money.ts";

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
  DEFAULT_EBAY_CONSENT_TIER,
  DEFAULT_REFRESH_SKEW_SECONDS,
  EBAY_BASE_SCOPE,
  EBAY_CONSENT_TIER_SCOPES,
  EBAY_DEFAULT_CONSENT_SCOPES,
  EBAY_ORDER_CONSENT_SCOPES,
  EBAY_SELL_FULFILLMENT_READONLY_SCOPE,
  buildConsentState,
  buildConsentUrl,
  bundleFromCredential,
  consentScopesForTier,
  consentTierForScopes,
  credentialWriteForBundle,
  exchangeConsentCode,
  isEbayConsentTier,
  refreshTokenBundleIfNeeded,
  refreshUserToken,
  tokenRefreshAfter,
  userAdapterFromBundle,
  verifyConsentState,
} from "./oauth.ts";
export type {
  ConsentState,
  EbayConsentTier,
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
  EBAY_BUYING_OPTIONS,
  EBAY_CONDITION_GROUPS,
  EBAY_SEARCH_SORTS,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_OFFSET,
  MAX_SELLERS_PER_FILTER,
  encodeEbaySearchFilters,
  mapSearchSummary,
  nextCursorFrom,
  searchAllListings,
  searchListings,
} from "./search.ts";
export type {
  EbayBuyingOption,
  EbayConditionGroup,
  EbayListingSummary,
  EbaySearchFilters,
  EbaySearchPage,
  EbaySearchSort,
  EbaySearchWarning,
  SearchListingsInput,
} from "./search.ts";

export {
  DEFAULT_SELLER_SORT,
  EBAY_ROOT_CATEGORY_ID,
  SELLER_FILTER_FIELD,
  UNKNOWN_SELLER_WARNING_ID,
  fetchAllSellerListings,
  fetchSellerListings,
  hasUnknownSellerWarning,
} from "./sellers.ts";
export type { FetchSellerListingsInput } from "./sellers.ts";

export {
  EBAY_BUYER_FEE_ID,
  EBAY_CANCELLED_STATE,
  EBAY_FULFILLMENT_STATUSES,
  EBAY_FULFILLMENT_STATUS_MAP,
  EBAY_MARKETPLACE_FEE_ID,
  EBAY_ORDERS_DEFAULT_LIMIT,
  EBAY_ORDERS_MAX_LIMIT,
  EBAY_ORDER_STATUSES,
  EBAY_PAYMENT_STATUSES,
  EBAY_PAYMENT_STATUS_MAP,
  EBAY_REFUND_STATUS_MAP,
  EBAY_UNKNOWN_STATUS_MAPPING,
  buildEbayOrdersFilter,
  buildEbayOrdersQuery,
  ebaySourceAccountKey,
  fetchEbayOrders,
  fetchEbayOrdersPage,
  fetchOrderFulfillments,
  isoFromEbay,
  iterateEbayOrders,
  mapEbayFulfillment,
  mapEbayOrder,
  redactEbayOrderFact,
} from "./orders.ts";
export type {
  EbayFulfillmentFact,
  EbayFulfillmentLineFact,
  EbayFulfillmentStatus,
  EbayOrderFact,
  EbayOrderFeeFact,
  EbayOrderLineFact,
  EbayOrderPage,
  EbayOrderStatus,
  EbayOrderTotals,
  EbayPaymentStatus,
  EbayRawOrderPayload,
  EbayRefundFact,
  EbayRefundLineFact,
  EbayStatusMapping,
  FetchEbayOrdersInput,
  MapEbayOrderOptions,
} from "./orders.ts";

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
