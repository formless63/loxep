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
// Re-exported so the Cloudflare estate browser (loxep-47o.2) can read the
// adapter's own pagination ceilings and name-mapping helper without
// `apps/web` taking a direct dependency on `@loxep/integration-cloudflare` —
// provider SDK shapes stop at the integration boundary; `@loxep/app` is
// already that boundary's composition root for Cloudflare (`cloudflare.ts`
// above depends on the package directly), the same role it plays for every
// other fleet-adapter re-export in this file.
export {
  CLOUDFLARE_RECORDS_DEFAULT_PER_PAGE,
  CLOUDFLARE_ZONES_DEFAULT_PER_PAGE,
  toProviderName as cloudflareToProviderName,
} from "@loxep/integration-cloudflare";

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
  // loxep-4ah: `apps/web/src/server/admin.ts` needs a live Termix adapter
  // for the fleet-detail per-session panel — the same re-export seam as
  // Dockhand's above, for the same reason (no direct
  // `@loxep/integration-termix` dependency in `apps/web`).
  TERMIX_CONNECTION_PROVIDER,
  TERMIX_CREDENTIAL_TYPE,
  createTermixAdapterFactory,
  // loxep-47o.6/loxep-47o.7: the Tailscale and Beszel estate browsers need a
  // live adapter reachable from `apps/web/src/server/admin.ts`, the same
  // re-export seam as Dockhand/Termix/Pangolin/Cloudflare/Purelymail above —
  // `@loxep/app` is already the composition root that depends on
  // `@loxep/integration-tailscale`/`@loxep/integration-beszel` directly, so
  // `apps/web` takes no direct dependency of its own.
  TAILSCALE_CONNECTION_PROVIDER,
  TAILSCALE_CREDENTIAL_TYPE,
  createTailscaleAdapterFactory,
  // `BESZEL_CONNECTION_PROVIDER`/`BESZEL_CREDENTIAL_TYPE` are already
  // exported above (Dockhand's containers-panel re-export block) — only the
  // FACTORY is new here.
  createBeszelAdapterFactory,
} from "./fleet.ts";
export type {
  ContainerHostAdapterLike,
  DockhandAdapterFactory,
  DockhandConnectionAdapter,
  TermixAdapterFactory,
  TermixConnectionAdapter,
  TailscaleAdapterFactory,
  TailscaleConnectionAdapter,
  BeszelAdapterFactory,
  BeszelConnectionAdapter,
} from "./fleet.ts";
// Re-exported so `apps/web` never needs its own `@loxep/integration-dockhand`
// dependency just to normalize a pasted base URL into the origin
// `declareContainerHostIntent` stores — the same seam `createDockhandAdapterFactory`
// above uses for the read leg.
export { normalizeDockhandBaseUrl } from "@loxep/integration-dockhand";

// loxep-pq2 (Pangolin estate browser): `apps/web/src/server/admin.ts` needs a
// live Pangolin READ adapter for the per-connection estate page, loaded
// through this package the same way {@link createDockhandAdapterFactory}
// above is — `pangolin.ts` was previously reached only by this package's own
// worker-side `services.ts`, so this is its first re-export out to
// `apps/web`. No write-shaped export added here: `PangolinAdapter` itself
// (from `@loxep/integration-pangolin`, not re-exported by this module at
// all) is where the four tier-1/POST writes live, and `apps/web` reaches
// them only through the ALREADY-BUILT `retireProxyResourceRule`/
// `enableProxyResourceRule` job-enqueueing server functions, never directly.
export { createPangolinAdapterFactory } from "./pangolin.ts";
export type { PangolinAdapterFactory, PangolinConnectionAdapter } from "./pangolin.ts";

// loxep-47o.3 (Purelymail estate browser): the same re-export shape as
// Pangolin's above — `apps/web/src/server/admin.ts` needs a live READ
// adapter for the per-connection estate page, loaded through this package
// the same way. `purelymail.ts` was previously reached only by this
// package's own worker-side `infrastructure-mail.ts`. `mailProviderPortFromPurelymailAdapter`
// and `purelymailResultRedactor` are re-exported too so `apps/web` can mount
// the ALREADY-GATED `runMailDomainSync`/`runMailboxSync` service calls
// (`@loxep/infrastructure`'s `mail-sync.ts`) as manual-trigger admin
// actions — the estate page's write affordances (design §3.2, owner ruling
// 2026-08-16 #3: mount existing service-layer paths, policy-blocked, rather
// than a per-verb whitelist). No new adapter verb, no new payload shape —
// P10.
export {
  createPurelymailAdapterFactory,
  PURELYMAIL_CONNECTION_PROVIDER,
  PURELYMAIL_LIST_USER_LIMIT,
} from "./purelymail.ts";
export type {
  PurelymailAdapterFactory,
  PurelymailConnectionAdapter,
} from "./purelymail.ts";
export {
  createMailSyncForDomain,
  mailProviderPortFromPurelymailAdapter,
  purelymailResultRedactor,
} from "./infrastructure-mail.ts";

// loxep-47o.5 (Gatus estate browser): the same re-export shape as
// Purelymail's above — `apps/web/src/server/admin.ts` needs a live READ
// adapter for the per-connection estate page, loaded through this package
// the same way. `fleet.ts`'s Gatus factory was previously reached only by
// this package's own worker-side `services.ts` (`health.sweep`'s
// discovery); this is its first re-export out to `apps/web`. No write-shaped
// export added here — Gatus's own adapter has none (config is files-only).
export {
  GATUS_CONNECTION_PROVIDER,
  GATUS_CREDENTIAL_TYPE,
  createGatusAdapterFactory,
} from "./fleet.ts";
export type { GatusAdapterFactory, GatusConnectionAdapter } from "./fleet.ts";
// Estate Browsers Design §3.7's mandatory exclusion: the Gatus estate page's
// endpoint list must exclude `gatusPushSetting.endpointKey` and its five
// derived fact keys in EVERY posture — `apps/web` reuses this SHARED
// derivation rather than re-deriving it, so the estate page's quarantine can
// never drift from what `gatus-push.ts` actually pushes to (fleet-health.ts's
// own module doc on {@link gatusPushQuarantinedKeys}).
export { gatusPushQuarantinedKeys } from "./fleet-health.ts";

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
  pushGatusHealthFacts,
  worstHealthStatus,
} from "./gatus-push.ts";
export type {
  GatusPushFactOutcome,
  GatusPushFetch,
  GatusPushKind,
  GatusPushOutcome,
  GatusPushTask,
  GatusPushTasks,
  PushGatusHealthFactsOptions,
  PushGatusHealthOptions,
} from "./gatus-push.ts";

export {
  ENABLE_PROXY_RESOURCE_RULE_TASK,
  RETIRE_IP_ALIAS_FAN_OUT_RULE_TASK,
  RETIRE_PROXY_RESOURCE_RULE_TASK,
  createInfrastructureProxyTasks,
  proxyProviderPortFromPangolinAdapter,
  proxyResultRedactor,
  resolveProxyProviderForHostingTarget,
  resolveProxyWriteAuthorization,
} from "./infrastructure-proxy.ts";
export type {
  InfrastructureProxyTasks,
  ProxyPangolinAdapterLike,
} from "./infrastructure-proxy.ts";

export {
  IP_ALIAS_DETECTION_CRON_MATCH,
  IP_ALIAS_DETECTION_TASK_NAME,
  createIpAliasDetectionTasks,
  extractAddressFromPangolinEndpoint,
  runIpAliasDetectionSweep,
} from "./ip-alias-detection.ts";
export type {
  DnsResolver,
  IpAliasDetectionOutcome,
  IpAliasDetectionTask,
  IpAliasDetectionTasks,
  RunIpAliasDetectionSweepOptions,
} from "./ip-alias-detection.ts";

export {
  FLEET_EVIDENCE_INGEST_TASK,
  createFleetEvidenceTasks,
  fleetEvidenceIngestJobKey,
  receiveFleetEvidence,
  verifyFleetIngestToken,
} from "./fleet-evidence.ts";
export type {
  FleetEvidenceTasks,
  ReceiveFleetEvidenceOptions,
  ReceiveFleetEvidenceResult,
  VerifyFleetIngestTokenOptions,
  VerifyFleetIngestTokenResult,
} from "./fleet-evidence.ts";

export {
  DOCUMENTS_EXTRACT_TEXT_TASK_NAME,
  createDefaultParserRegistry,
  createDocumentsExtractionTasks,
  documentsExtractTextJobKey,
  enqueueDocumentTextExtraction,
  runDocumentsExtractTextJob,
} from "./documents-extraction.ts";
export type {
  CreateDocumentsExtractionTasksOptions,
  DocumentsExtractionTasks,
  DocumentsExtractTextEnqueueExecutor,
  DocumentsExtractTextPayload,
  DocumentsExtractTextResult,
  DocumentsExtractTextTask,
} from "./documents-extraction.ts";

export { buildCronItems, buildWorkerRegistry } from "./registry.ts";
export type {
  BuildWorkerRegistryOptions,
  JobsCronItem,
  WorkerComposition,
} from "./registry.ts";
