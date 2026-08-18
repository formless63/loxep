/**
 * `buildWorkerRegistry` — the composition root proper (loxep-62y.2).
 *
 * Everything the Loxep worker runs is assembled here, once, from the
 * packages that own each concern:
 *
 * | task                        | owner                | what it does                    |
 * | --------------------------- | -------------------- | ------------------------------- |
 * | `maintenance.heartbeat`     | @loxep/jobs          | proves the job → DB write path  |
 * | `market.dispatch-due-monitors` | @loxep/market     | claims due targets (1/min cron) |
 * | `market.poll-target`        | @loxep/market        | runs the routed poll executor   |
 * | `notifications.deliver`     | @loxep/notifications | sends one rendered message      |
 * | `ebay.refresh-tokens`       | @loxep/app           | keeps user tokens warm (15 min) |
 * | `commerce.sync-woo-orders`  | @loxep/commerce      | on-demand order sync for one connection |
 * | `commerce.sync-ebay-orders` | @loxep/commerce      | the same, for an eBay seller account |
 * | `commerce.sync-medusa-orders` | @loxep/commerce    | the same, for a self-hosted Medusa backend |
 * | `commerce.redact-order-payloads` | @loxep/commerce | ADR-0021 retention sweep (daily) |
 * | `health.sweep`               | @loxep/app (mechanics in @loxep/domain) | Phase 8 m1 integration_health probe (5 min) |
 * | `infrastructure.gatus-push`  | @loxep/app            | Phase 8 m2 outward Gatus health push (5 min) |
 * | `accounting.post-facts`      | @loxep/app (mechanics in @loxep/accounting) | loxep-6fm posting-engine sweep, PROVISIONAL cadence (5 min) |
 * | `inventory.sync-ebay-purchases` | @loxep/app (mechanics in @loxep/inventory) | on-demand eBay purchase-history sync for one connection |
 * | `infrastructure.sync-token-policy` | @loxep/app (mechanics in @loxep/infrastructure) | Phase 7 m3 DNS-token zone-scope policy rebuild (on-demand, scope-change-triggered) |
 * | `integration-health.project-ingest-evidence` | @loxep/app | Phase 8 m7 fleet evidence webhook projection into integration_health (on-demand) |
 * | `documents.extract-text` | @loxep/app (mechanics in @loxep/documents) | loxep-cd3.4 M4 OCR tier A text extraction, enqueued transactionally at upload (on-demand) |
 * | `infrastructure.materialize-records` | @loxep/app (mechanics in @loxep/infrastructure) | loxep-vdt: intent -> `dns_records`, then chains the sync (on-demand) |
 * | `infrastructure.sync-records` | @loxep/app (mechanics in @loxep/infrastructure) | loxep-vdt: the reconcile run behind "Sync now"/"Retry" and the materialize chain (on-demand) |
 * | `storage.migrate-object`     | @loxep/storage       | loxep-vdt: one resumable local->S3 object copy+verify+cutover (on-demand) |
 *
 * ## The three names that were enqueued with no handler (loxep-vdt)
 *
 * `infrastructure.materialize-records`, `infrastructure.sync-records`, and
 * `storage.migrate-object` were all reachable from product code — the first
 * two from `@loxep/infrastructure`'s own `domains.ts`/`mail-sync.ts` and
 * `apps/web`'s domain-detail buttons, the third from
 * `StorageMigrationService.startMigration` — while none of the three was ever
 * passed to `createTaskRegistry`. Graphile Worker cannot resolve an
 * unregistered identifier, so each enqueue burned its retry budget and died
 * silently behind a success toast. All three are registered below, and
 * `test/registry-completeness.test.ts` now asserts the general property
 * (every exported `*_TASK`/`*_TASK_NAME` constant in the workspace has a
 * registered handler) so the class of bug cannot recur.
 *
 * `infrastructure.sync-proxy-resource` (Phase 7 m3's OTHER reserved task
 * name, `@loxep/infrastructure`'s `tasks.ts`) is NOW REGISTERED — the
 * Pangolin chain design's milestone 2 (`loxep-acj.2`). `@loxep/integration-
 * pangolin` (milestone 1) supplies the read-only adapter;
 * `infrastructure-proxy.ts` supplies `proxyProviderPortFromPangolinAdapter`
 * and resolves, per `proxy_resources` row, WHICH Pangolin connection to
 * reconcile against from `hosting_targets.proxy_connection_id` — the column
 * this milestone finally drives, dormant since migration `0012`. The
 * service behind it (`@loxep/infrastructure`'s `proxy.ts`) is CHECK MODE
 * ONLY: it structurally refuses `mode: 'apply'` until the write-authorization
 * gate (milestone 3, `loxep-acj.3`) ships. No poll-executor route or
 * `monitor_targets` registration yet — see `infrastructure-proxy.ts`'s own
 * module doc for why that mirrors `RECONCILE_CONTAINER_HOST_TASK`'s own
 * base-milestone precedent rather than `infrastructure_domain_reconcile`'s.
 *
 * Cron: `maintenance.heartbeat` (@loxep/jobs' defaults),
 * `market.dispatch-due-monitors` (every minute), `ebay.refresh-tokens`
 * (every 15 minutes), `commerce.redact-order-payloads` (daily),
 * `health.sweep` (every 5 minutes), `infrastructure.gatus-push` (every 5
 * minutes, piggybacking on `health.sweep`'s own cadence — see
 * `gatus-push.ts`'s module doc), `accounting.post-facts` (every 5 minutes,
 * PROVISIONAL — see `accounting-posting.ts`'s module doc for why the design
 * names no cadence and a sweep was chosen over event-driven posting).
 *
 * @loxep/commerce's ORDER SYNC deliberately defines no cron item — that
 * scheduled work is a `woo_orders` / `ebay_orders` monitor target claimed by
 * the market dispatcher, which is the whole point of registering a target type
 * instead of adding a second scheduler (see the routing note below). The
 * retention sweep is the one commerce job that genuinely is cron-driven: a
 * retention window is a wall-clock fact about stored rows, not something any
 * connection polls, and it takes no provider call at all.
 *
 * ## The ADR-0021 redaction seam
 *
 * `commerce.redact-order-payloads` rewrites order-class `provider_objects`
 * payloads into their redacted form after the configured window
 * (`commerce.order_payload_retention`, default 180 days). @loxep/commerce owns
 * the sweep but not the knowledge of what a provider's redacted payload looks
 * like, so the `object_type` → redactor map is injected here, from
 * `commerce-retention.ts` — the same discipline as the eBay page iterator, and
 * the only module in the wiring that imports an adapter's redaction helper.
 *
 * ## Poll routing (Phase 3)
 *
 * `market.poll-target` takes one executor, and two domains now register
 * target types against the shared `monitor_targets` model, so the executor it
 * gets is a ROUTER (`createRoutedPollExecutor`):
 *
 * ```text
 * ebay_item | ebay_watchlist | ebay_search | ebay_seller → createEbayPollExecutor
 * woo_orders                                            → createWooOrderPollExecutor
 * ebay_orders                                           → createEbayOrderPollExecutor
 * medusa_orders                                         → createMedusaOrderPollExecutor
 * etsy_listing | etsy_shop                              → createEtsyPollExecutor
 * reverb_listing | reverb_shop                          → createReverbPollExecutor
 * ebay_purchases                                        → createEbayPurchasePollExecutor
 * infrastructure_domain_reconcile                       → createInfrastructureReconcilePollExecutor
 * ```
 *
 * Each branch is built by the domain that owns the type and joined here,
 * which is Domain Boundaries' PROVISIONAL rule that "the executor for a
 * target type belongs to the domain that registered it, wired in the
 * composition root — never in the scheduling package".
 *
 * REGISTRATION CAVEAT (CLOSED, loxep-itn): `woo_orders` and `ebay_orders` are
 * BOTH in `@loxep/market`'s `MONITOR_TARGET_TYPES` and
 * `monitorTargetConfigSchemas` today — `ebay_orders`'s gap (it shipped
 * outside loxep-xh9.2's write fence) was closed by loxep-itn, so
 * `createMonitorService`'s CRUD covers both target types, the same as every
 * type below. `medusa_orders` (loxep-xxz) deliberately did NOT repeat that
 * gap: it was registered in `@loxep/market`'s `MONITOR_TARGET_TYPES` AND
 * `monitorTargetConfigSchemas` from the start, in the same change that added
 * `medusa-sync.ts` — see that module's doc. Nothing about polling ever
 * depended on this list — `claimDueTargets`, `recordPollSuccess`, and
 * `recordPollFailure` read `target_type` as text — but leaving a stale
 * warning next to a THIRD clean registration is how the split-registration
 * gap gets repeated, so this note is corrected rather than left to rot.
 *
 * `etsy_listing`/`etsy_shop` (loxep-g4t.1) deliberately do NOT repeat that
 * gap: both are in `@loxep/market`'s `MONITOR_TARGET_TYPES` AND
 * `monitorTargetConfigSchemas` from the same change that adds this route, so
 * `createMonitorService`'s CRUD accepts them immediately — no follow-up bead
 * needed the way `ebay_orders` still has one.
 *
 * REVERB-REGISTRATION-NOTE(loxep-g4t.3): `reverb_listing`/`reverb_shop`
 * follow the same discipline — both in `@loxep/market`'s
 * `MONITOR_TARGET_TYPES` AND `monitorTargetConfigSchemas` from the same
 * change that adds this route.
 *
 * `infrastructure_domain_reconcile` (Phase 7 milestone 1, loxep-lmy.1) is the
 * THIRD registrant against the shared scheduling model and, like
 * `etsy_listing`/`etsy_shop`, was registered in `@loxep/market`'s
 * `MONITOR_TARGET_TYPES` AND `monitorTargetConfigSchemas` in the same change
 * that shipped the rest of the milestone — this route is the one piece that
 * change could not land, because `@loxep/infrastructure`'s manifest did not
 * exist yet for `@loxep/app` to depend on. See `createInfrastructureReconcilePollExecutor`'s
 * module doc for the full wiring and why its mode is hard-coded to `'check'`.
 *
 * `createEtsyPollExecutor`'s adapter dependency is the ONE place in this
 * file's wiring where a shared, installation-wide resource (not a
 * per-connection one) feeds a poll route — see `services.ts`/`etsy.ts`'s
 * module docs for why Etsy's rate limit forces that shape.
 *
 * EBAY-PURCHASES-ROUTE(loxep-dgf.5): `ebay_purchases` (Flipping milestone 5)
 * is registered in `@loxep/market`'s `MONITOR_TARGET_TYPES` AND
 * `monitorTargetConfigSchemas`, the same discipline the Etsy/Reverb/
 * infrastructure blocks above establish — but its route here shipped in a
 * LATER change than its registration, for the same reason
 * `infrastructure_domain_reconcile`'s did: `@loxep/app`'s `package.json` did
 * not yet declare `@loxep/inventory`, the domain package that owns the type,
 * as a dependency. That gap is now closed and this is the route. See
 * `inventory-ebay.ts`'s module doc for the full account and why its
 * `SYNC_EBAY_PURCHASES_TASK_NAME` on-demand task is defined THERE rather
 * than in `@loxep/inventory` (which takes no `@loxep/jobs` dependency,
 * mirroring `health.sweep`/`infrastructure.gatus-push`).
 *
 * The `commerce.sync-*-orders` TASKS are registered alongside the routes and
 * share the very same sync service instances. They are not how scheduled
 * syncs run — the dispatcher/poll path above is — they are the on-demand
 * entry points (a backfill, a "sync now" button, a script), which is why each
 * keeps its own job-key-per-connection and its own Graphile retry budget.
 *
 * The registry is a plain value: nothing starts, connects, or polls until
 * `startWorkerRuntime` receives it. `apps/web` must never import this module
 * — `LOXEP_MODE=web` is exactly the mode that does not run jobs, and pulling
 * graphile-worker plus the provider integrations into the request process
 * would break that (ADR-0013/ADR-0018).
 *
 * ## Notification rendering
 *
 * The delivery pipeline is wired with the ENRICHED renderer from
 * `packages/notifications/src/render.ts` (per-event-type title/body plus the
 * canonical listing URL), not `deliver.ts`'s plain Phase 0 fallback. Listing
 * context reaches that renderer through `listing-context.ts` — read its
 * module doc for why the synchronous `renderMessage` seam needs it and how it
 * degrades.
 *
 * WIRING CAVEAT (mirrors `apps/web/src/server/ebay-oauth.ts`'s): the render
 * module is not on `@loxep/notifications`'s `exports` map, so it is reached
 * through a workspace-relative import. Replacing the specifier with a package
 * subpath once `./render` is exported is a one-line change; nothing else
 * about the wiring depends on it.
 */
import type { BootstrapConfig } from "@loxep/config";
import {
  EBAY_ORDERS_TARGET_TYPE,
  MEDUSA_ORDERS_TARGET_TYPE,
  WOO_ORDERS_TARGET_TYPE,
  createCommerceTasks,
} from "@loxep/commerce";
import type { CommerceCronItem } from "@loxep/commerce";
import type {
  CommerceTasks,
  EbayOrderPageIterator,
  MedusaOrderPageIterator,
  OrderPayloadRedactors,
} from "@loxep/commerce";
import {
  addJob as standaloneAddJob,
  createTaskRegistry,
  defaultCronItems,
  heartbeatTask,
} from "@loxep/jobs";
import type { AddJob, JobsLogger, TaskRegistry } from "@loxep/jobs";
import { createMarketTasks } from "@loxep/market";
import type { PollExecutor } from "@loxep/market";
import { EBAY_PURCHASES_TARGET_TYPE } from "@loxep/inventory";
import type { EbayPurchasePageIterator } from "@loxep/inventory";
import { INFRASTRUCTURE_DOMAIN_RECONCILE_TARGET_TYPE } from "@loxep/infrastructure";
import {
  createDeliveryPipeline,
  createNtfyTransport,
} from "@loxep/notifications";
import type {
  DeliverableMarketEvent,
  NotificationMessage,
  NotificationTransport,
} from "@loxep/notifications";
// See the WIRING CAVEAT in this module's doc comment.
import { renderMarketEventMessage as renderEnrichedMarketEventMessage } from "@loxep/notifications/render";
import { createWooOrderPollExecutor } from "./commerce.ts";
import {
  createEbayOrderPageIterator,
  createEbayOrderPollExecutor,
} from "./commerce-ebay.ts";
import {
  createMedusaOrderPageIterator,
  createMedusaOrderPollExecutor,
} from "./commerce-medusa.ts";
import { createOrderPayloadRedactors } from "./commerce-retention.ts";
import { createEtsyPollExecutor } from "./etsy-poll-executor.ts";
import { createAccountingPostFactsTasks } from "./accounting-posting.ts";
import { createDocumentsExtractionTasks } from "./documents-extraction.ts";
import { createFleetEvidenceTasks } from "./fleet-evidence.ts";
import { createGatusPushTasks } from "./gatus-push.ts";
import { createHealthSweepTasks } from "./health-sweep.ts";
import { createInfrastructureContainerHostTasks } from "./infrastructure-container-host.ts";
import { createInfrastructureDomainTasks } from "./infrastructure-domains.ts";
import { createInfrastructureMailTasks } from "./infrastructure-mail.ts";
import { createInfrastructureProvisioningTasks } from "./infrastructure-provisioning.ts";
import { createInfrastructureProxyTasks } from "./infrastructure-proxy.ts";
import { createInfrastructureReconcilePollExecutor } from "./infrastructure-poll-executor.ts";
import { createInfrastructureTokenTasks } from "./infrastructure-token.ts";
import { createIpAliasDetectionTasks } from "./ip-alias-detection.ts";
import {
  createEbayPurchasePollExecutor,
  createInventoryPurchaseSyncTasks,
} from "./inventory-ebay.ts";
import { createListingContextCache } from "./listing-context.ts";
import type { ListingContextCache } from "./listing-context.ts";
import {
  createArchivedConnectionGate,
  createEbayPollExecutor,
  createRoutedPollExecutor,
} from "./poll-executor.ts";
import type { CreateEbayPollExecutorOptions } from "./poll-executor.ts";
import { createEbayTokenRefreshTasks } from "./refresh-tokens.ts";
import type { AppCronItem } from "./refresh-tokens.ts";
import { createReverbPollExecutor } from "./reverb-poll-executor.ts";
import { createStorageMigrationTasks } from "./storage-migration.ts";
import { buildAppServices } from "./services.ts";
import type { AppServices } from "./services.ts";

/** graphile-worker's `CronItem`, reached without a direct dependency. */
export type JobsCronItem = (typeof defaultCronItems)[number];

export interface BuildWorkerRegistryOptions {
  config: BootstrapConfig;
  logger?: JobsLogger;
  /** Reuse an already-built service graph (tests, embedded callers). */
  services?: AppServices;
  /** Notification transport; defaults to ntfy over the global `fetch`. */
  transport?: NotificationTransport;
  /** Max monitor targets one dispatcher run claims (default 100). */
  dispatchBatchLimit?: number;
  /** Per-connection eBay token bucket override (tests). */
  ebayRateBudget?: { capacity: number; refillPerSecond: number };
  /** Per-connection WooCommerce token bucket override (tests). */
  wooRateBudget?: { capacity: number; refillPerSecond: number };
  /** Per-connection Medusa token bucket override (tests, and a gentle live run). */
  medusaRateBudget?: { capacity: number; refillPerSecond: number };
  /**
   * Provider seam for the `ebay_search`/`ebay_seller` paging calls — see
   * {@link CreateEbayPollExecutorOptions.discovery} for why it exists.
   */
  discovery?: CreateEbayPollExecutorOptions["discovery"];
  /**
   * Provider seam for `ebay_orders`. Defaults to
   * `createEbayOrderPageIterator(services)`, which binds
   * `@loxep/integration-ebay`'s `iterateEbayOrders` to this composition's
   * adapter factory. A test supplies canned pages here instead of stubbing
   * the Sell Fulfillment HTTP surface.
   */
  ebayOrders?: EbayOrderPageIterator;
  /**
   * Provider seam for `medusa_orders`. Defaults to
   * `createMedusaOrderPageIterator(services)`, which binds
   * `@loxep/integration-medusa`'s `iterateMedusaOrders` to this composition's
   * adapter factory. A test supplies canned pages here instead of stubbing
   * the Medusa Admin API surface.
   */
  medusaOrders?: MedusaOrderPageIterator;
  /**
   * ADR-0021 redaction seam for `commerce.redact-order-payloads`. Defaults to
   * `createOrderPayloadRedactors()`, which binds each order adapter's
   * `redact*OrderFact` helper. A test supplies a stub here instead of feeding
   * the sweep real provider payloads.
   */
  orderPayloadRedactors?: OrderPayloadRedactors;
  /**
   * Provider seam for `ebay_purchases` (loxep-dgf.5). Defaults to
   * `createEbayPurchasePageIterator(services)`, which binds
   * `@loxep/integration-ebay`'s `fetchAllWonPurchases` to this composition's
   * adapter factory. A test supplies canned pages here instead of stubbing
   * `GetMyeBayBuying`.
   */
  ebayPurchases?: EbayPurchasePageIterator;
}

export interface WorkerComposition {
  registry: TaskRegistry;
  cronItems: readonly JobsCronItem[];
  services: AppServices;
  listings: ListingContextCache;
  /**
   * The composed commerce tasks and the ONE sync service both the
   * `woo_orders` poll route and `commerce.sync-woo-orders` share. Exposed so
   * a caller can create/inspect a connection's sync target without rebuilding
   * the service graph.
   */
  commerce: CommerceTasks;
  /** Release anything the composition owns (the database pool). */
  close: () => Promise<void>;
}

/**
 * Cron schedules paired with a registry. `startWorkerRuntime` takes cron
 * separately from the task list and skips entries whose task is not
 * registered, so this stays a plain list.
 */
export function buildCronItems(input: {
  marketDispatch: AppCronItem;
  ebayRefreshTokens: AppCronItem;
  redactOrderPayloads: CommerceCronItem;
  healthSweep: AppCronItem;
  gatusPush: AppCronItem;
  accountingPostFacts: AppCronItem;
  ipAliasDetection: AppCronItem;
}): readonly JobsCronItem[] {
  return [
    // @loxep/jobs' own defaults (heartbeat) stay first so the maintenance
    // path is scheduled even if a later item is misconfigured.
    ...defaultCronItems,
    input.marketDispatch,
    input.ebayRefreshTokens,
    input.redactOrderPayloads,
    input.healthSweep,
    input.gatusPush,
    input.accountingPostFacts,
    input.ipAliasDetection,
  ];
}

export function buildWorkerRegistry(
  options: BuildWorkerRegistryOptions,
): WorkerComposition {
  const { config, logger } = options;
  const ownsServices = options.services === undefined;
  const services =
    options.services ??
    buildAppServices({
      config,
      ...(logger !== undefined ? { logger } : {}),
      ...(options.ebayRateBudget !== undefined
        ? { ebayRateBudget: options.ebayRateBudget }
        : {}),
      ...(options.wooRateBudget !== undefined
        ? { wooRateBudget: options.wooRateBudget }
        : {}),
      ...(options.medusaRateBudget !== undefined
        ? { medusaRateBudget: options.medusaRateBudget }
        : {}),
    });

  const listings = createListingContextCache();

  // --- notifications --------------------------------------------------
  const renderMessage = (
    event: DeliverableMarketEvent,
  ): NotificationMessage =>
    renderEnrichedMarketEventMessage({
      ...event,
      listing: listings.get(event.marketplaceItemId),
    });

  const delivery = createDeliveryPipeline({
    db: services.db,
    secrets: services.secrets,
    transport: options.transport ?? createNtfyTransport(),
    renderMessage,
  });

  // Deliveries are enqueued from inside the poll executor, which has no
  // Graphile job helpers of its own; the standalone typed enqueue works
  // against the shared pool (the runner in this process owns the schema).
  const enqueue: AddJob = (task, payload, enqueueOptions) =>
    standaloneAddJob(services.handle.pool, task, payload, enqueueOptions);

  // --- commerce -------------------------------------------------------
  // Built before the market tasks because its sync services are what the
  // `woo_orders` / `ebay_orders` poll routes run; each task and its route
  // share one instance.
  const commerce = createCommerceTasks({
    db: services.db,
    adapterFactory: async ({ connectionId }) =>
      (await services.getWooAdapterForConnection(connectionId)).adapter,
    iterateEbayOrders:
      options.ebayOrders ?? createEbayOrderPageIterator(services),
    iterateMedusaOrders:
      options.medusaOrders ??
      createMedusaOrderPageIterator(services, { logger }),
    // ADR-0021: the only place in the wiring that knows a provider's redacted
    // payload shape. See `commerce-retention.ts`.
    orderPayloadRedactors:
      options.orderPayloadRedactors ?? createOrderPayloadRedactors(),
  });

  // --- inventory (Flipping M5, loxep-dgf.5) ----------------------------
  // Same "built before the market tasks" reasoning as commerce above: its
  // sync service is what the `ebay_purchases` poll route and the
  // `inventory.sync-ebay-purchases` on-demand task share.
  const inventoryPurchases = createInventoryPurchaseSyncTasks({
    services,
    ...(options.ebayPurchases !== undefined
      ? { fetchPurchases: options.ebayPurchases }
      : {}),
  });

  // --- market ---------------------------------------------------------
  const ebayPollExecutor = createEbayPollExecutor({
    services,
    enqueueDeliveriesForEvent: delivery.enqueueDeliveriesForEvent,
    addJob: enqueue,
    listings,
    ...(options.discovery !== undefined
      ? { discovery: options.discovery }
      : {}),
  });
  const wooOrderPollExecutor = createWooOrderPollExecutor({
    services,
    sync: commerce.sync,
  });
  // `commerce.ebaySync` is non-null because `iterateEbayOrders` was supplied
  // above; the guard keeps the route out of the table rather than registering
  // a branch that would throw when claimed.
  const ebayOrderPollExecutor =
    commerce.ebaySync === null
      ? null
      : createEbayOrderPollExecutor({ services, sync: commerce.ebaySync });
  // `commerce.medusaSync` is non-null because `iterateMedusaOrders` was
  // supplied above; the guard keeps the route out of the table rather than
  // registering a branch that would throw when claimed — the same rule
  // `ebayOrderPollExecutor` follows.
  const medusaOrderPollExecutor =
    commerce.medusaSync === null
      ? null
      : createMedusaOrderPollExecutor({ services, sync: commerce.medusaSync });
  // Flipping M5 (loxep-dgf.5): `ebay_purchases`, sharing the ONE purchase-
  // sync service instance the `inventory.sync-ebay-purchases` task also
  // runs — see `inventory-ebay.ts`'s module doc.
  const ebayPurchasePollExecutor = createEbayPurchasePollExecutor({
    services,
    sync: inventoryPurchases.sync,
  });
  // Etsy (loxep-g4t.1): one executor serves both m1 target types. Its
  // adapter dependency (`services.getEtsyAdapterForConnection`) is backed by
  // the SHARED, installation-wide rate budget — see `etsy.ts`'s module doc.
  const etsyPollExecutor = createEtsyPollExecutor({
    services,
    enqueueDeliveriesForEvent: delivery.enqueueDeliveriesForEvent,
    addJob: enqueue,
    listings,
  });
  // Phase 7 milestone 1 (loxep-lmy.1): the third registrant against the
  // shared scheduling model. No provider-seam override option here — unlike
  // `ebayOrders`/`discovery`, a test overrides the Cloudflare adapter through
  // `services.getCloudflareAdapterForConnection`, exactly the pattern
  // `commerce-ebay-sync.test.ts` uses for `getEbayAdapterForConnection`.
  const infrastructureReconcilePollExecutor =
    createInfrastructureReconcilePollExecutor({ services });
  // REVERB-ROUTE(loxep-g4t.3): one executor serves both m1 target types. Its
  // adapter dependency (`services.getReverbAdapterForConnection`) is
  // PER-CONNECTION, unlike Etsy's shared budget — see `reverb.ts`'s module
  // doc. Registered in BOTH `@loxep/market`'s closed list AND this route in
  // the same change, learning from the `ebay_orders` split-registration gap
  // noted above the same way `etsy_listing`/`etsy_shop` already did.
  const reverbPollExecutor = createReverbPollExecutor({
    services,
    enqueueDeliveriesForEvent: delivery.enqueueDeliveriesForEvent,
    addJob: enqueue,
    listings,
  });
  // The archived-connection gate wraps the ROUTER, so every target type
  // inherits it (loxep-o7h) — see `createArchivedConnectionGate`.
  const pollExecutor: PollExecutor = createArchivedConnectionGate({
    services,
    executor: createRoutedPollExecutor({
      routes: {
        [WOO_ORDERS_TARGET_TYPE]: wooOrderPollExecutor,
        ...(ebayOrderPollExecutor === null
          ? {}
          : { [EBAY_ORDERS_TARGET_TYPE]: ebayOrderPollExecutor }),
        ...(medusaOrderPollExecutor === null
          ? {}
          : { [MEDUSA_ORDERS_TARGET_TYPE]: medusaOrderPollExecutor }),
        etsy_listing: etsyPollExecutor,
        etsy_shop: etsyPollExecutor,
        reverb_listing: reverbPollExecutor,
        reverb_shop: reverbPollExecutor,
        [EBAY_PURCHASES_TARGET_TYPE]: ebayPurchasePollExecutor,
        [INFRASTRUCTURE_DOMAIN_RECONCILE_TARGET_TYPE]:
          infrastructureReconcilePollExecutor,
      },
      fallback: ebayPollExecutor,
    }),
  });
  const market = createMarketTasks({
    db: services.db,
    pollExecutor,
    ...(options.dispatchBatchLimit !== undefined
      ? { dispatchBatchLimit: options.dispatchBatchLimit }
      : {}),
  });

  // --- eBay token lifecycle -------------------------------------------
  const refresh = createEbayTokenRefreshTasks({ services });

  // --- infrastructure mail (Phase 7 milestone 2, loxep-lmy.2) ----------
  // Three TASKS and no poll-executor route, deliberately: ownership
  // verification is a bounded, self-terminating poll, which the design's
  // "Where recurring cadence lives" section classifies as NOT scheduling. See
  // `infrastructure-mail.ts`'s module doc for why no fourth `monitor_targets`
  // target type is registered here.
  const infrastructureMail = createInfrastructureMailTasks({ services });

  // --- infrastructure managed-domain records (loxep-vdt) -----------------
  // `infrastructure.materialize-records` + `infrastructure.sync-records` —
  // the design's job-graph pair that has been ENQUEUED since Phase 7
  // milestone 1 (`domains.ts`'s create/updateIntent, `mail-sync.ts`'s
  // ownership-code step, and `apps/web`'s "Sync now"/"Retry") with no
  // handler on either name. No cron item and no poll route: materialize is
  // event-driven and sync is chained from it (the RECURRING drift sweep is
  // `infrastructure_domain_reconcile`, wired above, and stays `check`-only).
  // See `infrastructure-domains.ts`'s module doc for why the chained sync
  // runs `mode: 'apply'` while the sweep never does, and for the zone gate.
  const infrastructureDomains = createInfrastructureDomainTasks({ services });

  // --- infrastructure DNS-token policy sync (Phase 7 milestone 3, loxep-lmy.3)
  // One on-demand task, no poll-executor route and no cron item — it is
  // enqueued transactionally by `@loxep/infrastructure`'s `tokens.ts`
  // (`setZones` / `mint` with initial zones), never claimed by the
  // dispatcher. `mint`/`roll` are NOT wired here — see
  // `infrastructure-token.ts`'s module doc for the HARD CONSTRAINT that
  // keeps them a request-scoped `apps/web` action instead.
  const infrastructureTokens = createInfrastructureTokenTasks({ services });

  // --- infrastructure container-host reconciler (loxep-hb7 Milestone C) ---
  // One task, enqueued transactionally by `@loxep/infrastructure`'s
  // `declareIntent` (an intent change) and manually from the fleet-detail
  // registration panel's Reconcile/Check-now buttons — never a poll-executor
  // route or a `monitor_targets` row. Milestone D's drift cadence calls the
  // SAME underlying `ContainerHostsService.reconcile` directly from
  // `health-sweep.ts`'s Dockhand connection probe rather than through this
  // task, so it costs no extra job per target — see `fleet-health.ts`'s
  // module doc.
  const infrastructureContainerHosts = createInfrastructureContainerHostTasks({
    services,
  });

  // --- infrastructure proxy resource reconciler (Pangolin chain design M2,
  // loxep-acj.2) ---------------------------------------------------------
  // One task, CHECK MODE ONLY. Lands the reserved `SYNC_PROXY_RESOURCE_TASK`
  // contract `tasks.ts` has carried since Phase 7 milestone 3 — see this
  // file's own module doc and `infrastructure-proxy.ts`'s for the full
  // account of what is, and is not, wired yet.
  const infrastructureProxy = createInfrastructureProxyTasks({ services });

  // --- the provisioning-template engine's driver (Pangolin chain design M6,
  // loxep-acj.6) ----------------------------------------------------------
  // One on-demand task, `infrastructure.run-provisioning-template`, enqueued
  // transactionally by `@loxep/infrastructure`'s `ProvisioningTemplatesService
  // .startRun` and re-enqueued (same job key, `preserve_run_at`) by an
  // operator's "Resume run" click — never a poll or a sweep. See
  // `infrastructure-provisioning.ts`'s own module doc for the three provider
  // resolvers it reuses, unchanged, from the mail/DNS/proxy wiring above.
  const infrastructureProvisioning = createInfrastructureProvisioningTasks({
    services,
  });

  // --- dynamic-IP named-alias detection (Pangolin chain design M5,
  // loxep-acj.5) -----------------------------------------------------
  // One recurring sweep: detect (dns/pangolin_site), update the alias,
  // fan out to every referencing rule (add-only, gated by the connection's
  // write-policy tier and wouldLockOut, same as a manual apply), and notify
  // once per genuine change. See ip-alias-detection.ts's own module doc.
  const ipAliasDetection = createIpAliasDetectionTasks({ services });

  // --- fleet health (Phase 8 milestone 1, loxep-ovj.1) -----------------
  // One recurring sweep, no monitor_targets row — see health-sweep.ts's
  // module doc. `@loxep/domain` owns the registry/mechanics; this is only
  // the Graphile Worker wrapper, the same shape `ebay.refresh-tokens` uses.
  const health = createHealthSweepTasks({ services });

  // --- Gatus outward push (Phase 8 milestone 2, loxep-ovj.2) ------------
  // Publishes Loxep's own overall health to the operator's Gatus instance —
  // the ONE mutating call this composition ever makes to a fleet tool, and
  // the direction runs opposite every other integration here. See
  // gatus-push.ts's module doc.
  const gatusPush = createGatusPushTasks({ services });

  // --- accounting posting-engine sweep (loxep-6fm) ----------------------
  // Wires `@loxep/accounting`'s posting engine into the runtime for the
  // first time — WEAVE AUDIT finding 1. See accounting-posting.ts's module
  // doc for the trigger-mechanics decision (cadence sweep, PROVISIONAL) and
  // the idempotency/books-gating contract it relies on.
  const accountingPostFacts = createAccountingPostFactsTasks({ services });

  // --- fleet evidence ingestion (Phase 8 milestone 7, loxep-ovj.7) ------
  // One on-demand task, enqueued transactionally by `fleet-evidence.ts`'s
  // `receiveFleetEvidence` from the (unauthenticated-by-session) inbound
  // webhook route — no cron item, matching
  // `infrastructure.sync-token-policy`'s shape.
  const fleetEvidence = createFleetEvidenceTasks({ services });

  // --- documents text extraction (loxep-cd3.4 M4) ------------------------
  // One on-demand task, no cron item, enqueued transactionally by
  // `apps/web/src/server/documents-media.ts`'s `handleDocumentUpload` in the
  // same transaction that inserts the `documents` row — the same
  // "enqueue inside the write that creates the fact" shape as
  // `infrastructureTokens`/`fleetEvidence` above. `createDocumentsExtractionTasks`'s
  // default parser registry (no override passed here) carries BOTH
  // `manualParser` and `ocr_tesseract` — the latter's media reads bound to a
  // real `MediaService`, built the same way `apps/web`'s `getMediaService()`
  // is (`documents-extraction.ts`'s own module doc). See that module's doc
  // for why a structural extraction failure (an unregistered parser id, or a
  // storage-layer failure resolving a media object) is recorded on the
  // `documents` row rather than rethrown.
  const documentsExtraction = createDocumentsExtractionTasks({ services });

  // --- storage migration (ADR-0012/ADR-0014, registered by loxep-vdt) -----
  // `@loxep/storage` built `storage.migrate-object` with `defineTask` and
  // told this file to register it; nothing ever did. One task, no cron item
  // and no poll route — a migration is started by an operator and its jobs
  // are enqueued per media object by the service itself. See
  // `storage-migration.ts`'s module doc for the `addJob` cycle.
  const storageMigration = createStorageMigrationTasks({ services });

  const registry = createTaskRegistry([
    heartbeatTask,
    ...market.tasks,
    delivery.deliverTask,
    refresh.refreshTokensTask,
    ...commerce.tasks,
    inventoryPurchases.syncEbayPurchasesTask,
    ...infrastructureDomains.tasks,
    ...infrastructureMail.tasks,
    ...infrastructureTokens.tasks,
    ...infrastructureContainerHosts.tasks,
    ...infrastructureProxy.tasks,
    ...infrastructureProvisioning.tasks,
    ipAliasDetection.ipAliasDetectionTask,
    health.healthSweepTask,
    gatusPush.gatusPushTask,
    accountingPostFacts.accountingPostFactsTask,
    ...fleetEvidence.tasks,
    documentsExtraction.extractTextTask,
    ...storageMigration.tasks,
  ]);

  return {
    registry,
    cronItems: buildCronItems({
      marketDispatch: market.dispatchDueMonitorsCronItem,
      ebayRefreshTokens: refresh.refreshTokensCronItem,
      redactOrderPayloads: commerce.redactOrderPayloadsCronItem,
      healthSweep: health.healthSweepCronItem,
      gatusPush: gatusPush.gatusPushCronItem,
      accountingPostFacts: accountingPostFacts.accountingPostFactsCronItem,
      ipAliasDetection: ipAliasDetection.ipAliasDetectionCronItem,
    }),
    services,
    listings,
    commerce,
    close: async () => {
      if (ownsServices) await services.close();
    },
  };
}
