/**
 * @loxep/app — the Loxep composition root.
 *
 * This is where the Phase 1 parts become a running system: `@loxep/db` +
 * `@loxep/domain` services, the `@loxep/integration-ebay` boundary, the
 * `@loxep/market` scheduler/observation/event path, and the
 * `@loxep/notifications` delivery pipeline are assembled into ONE
 * `@loxep/jobs` task registry that the worker runtime starts.
 *
 * Only worker-capable modes load this package: `bin/loxep.ts` lazily imports
 * it for `LOXEP_MODE=all|worker`, and `LOXEP_MODE=web` never does.
 */

export { AppConfigurationError, AppError, EbayKeysetMissingError } from "./errors.ts";

export { buildAppServices } from "./services.ts";
export type { AppServices, BuildAppServicesOptions } from "./services.ts";

export {
  EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
  EBAY_BUDGET_TARGETS_PER_CONNECTION,
  EBAY_CONNECTION_CONFIG_KEY,
  EBAY_CONNECTION_PROVIDER,
  EBAY_KEYSET_SECRET_KEY,
  EBAY_OAUTH_CREDENTIAL_TYPE,
  EBAY_RATE_BUDGET_CAPACITY,
  EBAY_RATE_BUDGET_REFILL_PER_SECOND,
  createEbayAdapterFactory,
  loadEbayKeyset,
  rateBudgetIntervalFloorSeconds,
} from "./ebay.ts";
export type {
  CreateEbayAdapterFactoryOptions,
  EbayAdapterConstructor,
  EbayAdapterFactory,
  EbayConnectionAdapter,
  EbayKeyset,
  EbayKeysetSource,
} from "./ebay.ts";

export {
  LISTING_CONTEXT_CACHE_LIMIT,
  createListingContextCache,
} from "./listing-context.ts";
export type { ListingContext, ListingContextCache } from "./listing-context.ts";

export {
  ITEM_OBSERVATION_SOURCE,
  WATCHLIST_MAX_ITEMS_PER_POLL,
  WATCHLIST_MAX_PAGES,
  WATCHLIST_OBSERVATION_SOURCE,
  createEbayPollExecutor,
} from "./poll-executor.ts";
export type { CreateEbayPollExecutorOptions } from "./poll-executor.ts";

export {
  REFRESH_TOKENS_CRON_MATCH,
  REFRESH_TOKENS_TASK_NAME,
  createEbayTokenRefreshTasks,
} from "./refresh-tokens.ts";
export type {
  AppCronItem,
  EbayTokenRefreshTasks,
  RefreshTokensTask,
} from "./refresh-tokens.ts";

export { buildCronItems, buildWorkerRegistry } from "./registry.ts";
export type {
  BuildWorkerRegistryOptions,
  JobsCronItem,
  WorkerComposition,
} from "./registry.ts";
