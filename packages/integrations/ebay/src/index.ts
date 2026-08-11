/**
 * @loxep/integration-ebay — Loxep's eBay integration boundary (ADR-0009).
 *
 * hendt/ebay-api v10 does the protocol work (OAuth2 client-credentials
 * token management, Buy Browse API group); this package owns the boundary:
 * typed config, error taxonomy, per-connection rate budget, and mapping into
 * Loxep-owned snapshot/observation shapes. Provider SDK types deliberately
 * do NOT appear in any exported type below.
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
  loadSandboxCredentialsFromEnvFile,
} from "./credentials.ts";
export type { EbaySandboxCredentials } from "./credentials.ts";

export { createEbayAdapter } from "./adapter.ts";
export type {
  EbayAdapter,
  EbayAdapterStats,
  EbayApplicationTokenInfo,
  EbayBrowseSearchInput,
  EbayBrowseSearchResult,
} from "./adapter.ts";

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
