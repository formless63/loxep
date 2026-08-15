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

export {
  AppConfigurationError,
  AppError,
  EbayKeysetMissingError,
  EtsyKeysetMissingError,
} from "./errors.ts";

export {
  WOO_ABSOLUTE_MIN_INTERVAL_SECONDS,
  WOO_ADAPTER_CACHE_TTL_MS,
  WOO_CONNECTION_CONFIG_KEY,
  WOO_CONNECTION_PROVIDER,
  WOO_CREDENTIAL_TYPE,
  WOO_PAGES_PER_SYNC,
  WOO_RATE_BUDGET_CAPACITY,
  WOO_RATE_BUDGET_REFILL_PER_SECOND,
  WooCredentialsMissingError,
  createWooAdapterFactory,
  readWooBaseUrl,
  wooRateBudgetIntervalFloorSeconds,
} from "./woo.ts";
export type {
  CreateWooAdapterFactoryOptions,
  WooAdapterConstructor,
  WooAdapterFactory,
  WooConnectionAdapter,
  WooRateBudgetConfig,
} from "./woo.ts";

export {
  MEDUSA_ABSOLUTE_MIN_INTERVAL_SECONDS,
  MEDUSA_ADAPTER_CACHE_TTL_MS,
  MEDUSA_CONNECTION_CONFIG_KEY,
  MEDUSA_CONNECTION_PROVIDER,
  MEDUSA_CREDENTIAL_TYPE,
  MEDUSA_PAGES_PER_SYNC,
  MEDUSA_RATE_BUDGET_CAPACITY,
  MEDUSA_RATE_BUDGET_REFILL_PER_SECOND,
  MedusaCredentialsMissingError,
  createMedusaAdapterFactory,
  medusaRateBudgetIntervalFloorSeconds,
  readMedusaBaseUrl,
} from "./medusa.ts";
export type {
  CreateMedusaAdapterFactoryOptions,
  MedusaAdapterConstructor,
  MedusaAdapterFactory,
  MedusaConnectionAdapter,
  MedusaRateBudgetConfig,
} from "./medusa.ts";

export { createWooOrderPollExecutor } from "./commerce.ts";
export type { CreateWooOrderPollExecutorOptions } from "./commerce.ts";

export {
  createEbayOrderPageIterator,
  createEbayOrderPollExecutor,
} from "./commerce-ebay.ts";
export type { CreateEbayOrderPollExecutorOptions } from "./commerce-ebay.ts";

export {
  createMedusaOrderPageIterator,
  createMedusaOrderPollExecutor,
} from "./commerce-medusa.ts";
export type { CreateMedusaOrderPollExecutorOptions } from "./commerce-medusa.ts";

export { createOrderPayloadRedactors } from "./commerce-retention.ts";

export { buildAppServices } from "./services.ts";
export type { AppServices, BuildAppServicesOptions } from "./services.ts";

export {
  DEFAULT_SETTINGS_TTL_MS,
  createMonitorSettingsReader,
} from "./settings.ts";
export type {
  CreateMonitorSettingsReaderOptions,
  MonitorSettingsReader,
  ResolvedMonitorSettings,
} from "./settings.ts";

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
  ETSY_ABSOLUTE_MIN_INTERVAL_SECONDS,
  ETSY_BUDGET_TARGETS_PER_INSTALLATION,
  ETSY_CONNECTION_CONFIG_KEY,
  ETSY_CONNECTION_PROVIDER,
  ETSY_KEYSET_SECRET_KEY,
  ETSY_OAUTH_CREDENTIAL_TYPE,
  ETSY_RATE_BUDGET_CAPACITY,
  ETSY_RATE_BUDGET_REFILL_PER_SECOND,
  ETSY_SHOP_CONFIG_KEY,
  createEtsyAdapterFactory,
  etsyRateBudgetIntervalFloorSeconds,
  loadEtsyKeyset,
  readEtsyShopId,
} from "./etsy.ts";
export type {
  CreateEtsyAdapterFactoryOptions,
  EtsyAdapterConstructor,
  EtsyAdapterFactory,
  EtsyConnectionAdapter,
  EtsyKeyset,
  EtsyKeysetSource,
  EtsyRateBudgetConfig,
} from "./etsy.ts";

export {
  ETSY_LISTING_OBSERVATION_SOURCE,
  ETSY_SHOP_DEFAULT_MAX_ITEMS,
  ETSY_SHOP_OBSERVATION_SOURCE,
  createEtsyPollExecutor,
} from "./etsy-poll-executor.ts";
export type { CreateEtsyPollExecutorOptions } from "./etsy-poll-executor.ts";

export {
  CLOUDFLARE_ABSOLUTE_MIN_INTERVAL_SECONDS,
  CLOUDFLARE_ADAPTER_CACHE_TTL_MS,
  CLOUDFLARE_CALLS_PER_SYNC,
  CLOUDFLARE_CONNECTION_CONFIG_KEY,
  CLOUDFLARE_CONNECTION_PROVIDER,
  CLOUDFLARE_CREDENTIAL_TYPE,
  CLOUDFLARE_RATE_BUDGET_CAPACITY,
  CLOUDFLARE_RATE_BUDGET_REFILL_PER_SECOND,
  CloudflareCredentialsMissingError,
  cloudflareRateBudgetIntervalFloorSeconds,
  createCloudflareAdapterFactory,
  readCloudflareAccountId,
} from "./cloudflare.ts";
export type {
  CloudflareAdapterConstructor,
  CloudflareAdapterFactory,
  CloudflareConnectionAdapter,
  CloudflareRateBudgetConfig,
  CreateCloudflareAdapterFactoryOptions,
} from "./cloudflare.ts";

export {
  INFRASTRUCTURE_RECONCILE_POLL_MODE,
  INFRASTRUCTURE_RECONCILE_POLL_TRIGGER,
  cloudflareApplyResultRedactor,
  createInfrastructureReconcilePollExecutor,
  providerPortFromCloudflareAdapter,
} from "./infrastructure-poll-executor.ts";
export type { CreateInfrastructureReconcilePollExecutorOptions } from "./infrastructure-poll-executor.ts";

export {
  BESZEL_CONNECTION_PROVIDER,
  BESZEL_CREDENTIAL_TYPE,
  DOCKHAND_CONNECTION_PROVIDER,
  DOCKHAND_CREDENTIAL_TYPE,
  containerHostPortFromDockhandAdapter,
  // loxep-hb7 Milestone B: `apps/web/src/server/admin.ts` needs a live
  // Dockhand adapter for the containers/stacks panel, loaded through this
  // package (dynamically, per that file's own SSR-bundling discipline)
  // rather than declaring a direct `@loxep/integration-dockhand` dependency
  // of its own — `@loxep/app` already owns that dependency and this is its
  // one sanctioned re-export seam.
  createDockhandAdapterFactory,
  // loxep-hb7 Milestone C: `declareContainerHostIntent`
  // (`apps/web/src/server/infrastructure-functions.ts`) needs the SAME
  // origin resolution `fleet-health.ts`'s discovery sweep already applies,
  // so the intent's stored `url` and the discovery-written one can never
  // disagree about what "the instance origin" means for one connection.
  readDockhandBaseUrl,
} from "./fleet.ts";
export type {
  ContainerHostAdapterLike,
  DockhandAdapterFactory,
  DockhandConnectionAdapter,
} from "./fleet.ts";
// Re-exported so `apps/web` never needs its own `@loxep/integration-dockhand`
// dependency just to normalize a pasted base URL into the origin
// `declareContainerHostIntent` stores — the same seam `createDockhandAdapterFactory`
// above uses for the read leg.
export { normalizeDockhandBaseUrl } from "@loxep/integration-dockhand";

export {
  REVERB_ABSOLUTE_MIN_INTERVAL_SECONDS,
  REVERB_ADAPTER_CACHE_TTL_MS,
  REVERB_CONNECTION_PROVIDER,
  REVERB_CREDENTIAL_TYPE,
  REVERB_RATE_BUDGET_CAPACITY,
  REVERB_RATE_BUDGET_REFILL_PER_SECOND,
  ReverbCredentialsMissingError,
  createReverbAdapterFactory,
  reverbRateBudgetIntervalFloorSeconds,
} from "./reverb.ts";
export type {
  CreateReverbAdapterFactoryOptions,
  ReverbAdapterConstructor,
  ReverbAdapterFactory,
  ReverbConnectionAdapter,
  ReverbRateBudgetConfig,
} from "./reverb.ts";

export {
  REVERB_LISTING_OBSERVATION_SOURCE,
  REVERB_SHOP_DEFAULT_MAX_ITEMS,
  REVERB_SHOP_OBSERVATION_SOURCE,
  createReverbPollExecutor,
} from "./reverb-poll-executor.ts";
export type { CreateReverbPollExecutorOptions } from "./reverb-poll-executor.ts";

export {
  LISTING_CONTEXT_CACHE_LIMIT,
  createListingContextCache,
} from "./listing-context.ts";
export type { ListingContext, ListingContextCache } from "./listing-context.ts";

export {
  DISCOVERY_DEFAULT_MAX_ITEMS,
  IGNORED_FILTER_WARNING_ID,
  IGNORED_SORT_WARNING_ID,
  ITEM_OBSERVATION_SOURCE,
  WATCHLIST_MAX_PAGES,
  WATCHLIST_OBSERVATION_SOURCE,
  createArchivedConnectionGate,
  createEbayPollExecutor,
  createRoutedPollExecutor,
} from "./poll-executor.ts";
export type { CreateEbayPollExecutorOptions } from "./poll-executor.ts";

export {
  SEARCH_OBSERVATION_SOURCE,
  SELLER_OBSERVATION_SOURCE,
  summaryToObservation,
} from "./listing-summary.ts";
export type { SummaryObservation } from "./listing-summary.ts";

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

export {
  HEALTH_SWEEP_CRON_MATCH,
  HEALTH_SWEEP_TASK_NAME,
  createHealthSweepTasks,
} from "./health-sweep.ts";
export type { HealthSweepTask, HealthSweepTasks } from "./health-sweep.ts";

export {
  ACCOUNTING_POST_FACTS_CRON_MATCH,
  ACCOUNTING_POST_FACTS_TASK_NAME,
  DEFAULT_POST_FACTS_LIMIT,
  createAccountingPostFactsTasks,
  runAccountingPostFactsSweep,
} from "./accounting-posting.ts";
export type {
  AccountingPostFactsResult,
  AccountingPostFactsTask,
  AccountingPostFactsTasks,
} from "./accounting-posting.ts";

export {
  SYNC_EBAY_PURCHASES_TASK_NAME,
  createEbayPurchasePageIterator,
  createEbayPurchasePollExecutor,
  createInventoryPurchaseSyncTasks,
  ebayPurchaseSyncJobKey,
  enqueueEbayPurchaseSync,
} from "./inventory-ebay.ts";
export type {
  CreateEbayPurchasePollExecutorOptions,
  EbayPurchaseSyncTasks,
  SyncEbayPurchasesTask,
} from "./inventory-ebay.ts";

export {
  GATUS_PUSH_CRON_MATCH,
  GATUS_PUSH_SECRET_KEY,
  GATUS_PUSH_TASK_NAME,
  createGatusPushTasks,
  pushGatusHealth,
  worstHealthStatus,
} from "./gatus-push.ts";
export type {
  GatusPushFetch,
  GatusPushKind,
  GatusPushOutcome,
  GatusPushTask,
  GatusPushTasks,
  PushGatusHealthOptions,
} from "./gatus-push.ts";

export { buildCronItems, buildWorkerRegistry } from "./registry.ts";
export type {
  BuildWorkerRegistryOptions,
  JobsCronItem,
  WorkerComposition,
} from "./registry.ts";
