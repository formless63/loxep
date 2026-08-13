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
 * | `commerce.redact-order-payloads` | @loxep/commerce | ADR-0021 retention sweep (daily) |
 *
 * Cron: `maintenance.heartbeat` (@loxep/jobs' defaults),
 * `market.dispatch-due-monitors` (every minute), `ebay.refresh-tokens`
 * (every 15 minutes), `commerce.redact-order-payloads` (daily).
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
 * etsy_listing | etsy_shop                              → createEtsyPollExecutor
 * infrastructure_domain_reconcile                       → createInfrastructureReconcilePollExecutor
 * ```
 *
 * Each branch is built by the domain that owns the type and joined here,
 * which is Domain Boundaries' PROVISIONAL rule that "the executor for a
 * target type belongs to the domain that registered it, wired in the
 * composition root — never in the scheduling package".
 *
 * REGISTRATION CAVEAT: `woo_orders` is in `@loxep/market`'s
 * `MONITOR_TARGET_TYPES` and `monitorTargetConfigSchemas`; **`ebay_orders` is
 * not yet**, because `packages/market` was outside loxep-xh9.2's write fence.
 * Nothing about polling depends on that list — `claimDueTargets`,
 * `recordPollSuccess`, and `recordPollFailure` read `target_type` as text —
 * so the route below works end to end. What does not work is creating such a
 * row through `createMonitorService`, whose `targetType` is a closed enum;
 * `@loxep/commerce`'s `ensureEbayOrderSyncTarget` inserts it directly. See
 * that module's doc for the follow-up.
 *
 * `etsy_listing`/`etsy_shop` (loxep-g4t.1) deliberately do NOT repeat that
 * gap: both are in `@loxep/market`'s `MONITOR_TARGET_TYPES` AND
 * `monitorTargetConfigSchemas` from the same change that adds this route, so
 * `createMonitorService`'s CRUD accepts them immediately — no follow-up bead
 * needed the way `ebay_orders` still has one.
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
  WOO_ORDERS_TARGET_TYPE,
  createCommerceTasks,
} from "@loxep/commerce";
import type { CommerceCronItem } from "@loxep/commerce";
import type {
  CommerceTasks,
  EbayOrderPageIterator,
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
import { createOrderPayloadRedactors } from "./commerce-retention.ts";
import { createEtsyPollExecutor } from "./etsy-poll-executor.ts";
import { createInfrastructureReconcilePollExecutor } from "./infrastructure-poll-executor.ts";
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
   * ADR-0021 redaction seam for `commerce.redact-order-payloads`. Defaults to
   * `createOrderPayloadRedactors()`, which binds each order adapter's
   * `redact*OrderFact` helper. A test supplies a stub here instead of feeding
   * the sweep real provider payloads.
   */
  orderPayloadRedactors?: OrderPayloadRedactors;
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
}): readonly JobsCronItem[] {
  return [
    // @loxep/jobs' own defaults (heartbeat) stay first so the maintenance
    // path is scheduled even if a later item is misconfigured.
    ...defaultCronItems,
    input.marketDispatch,
    input.ebayRefreshTokens,
    input.redactOrderPayloads,
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
    // ADR-0021: the only place in the wiring that knows a provider's redacted
    // payload shape. See `commerce-retention.ts`.
    orderPayloadRedactors:
      options.orderPayloadRedactors ?? createOrderPayloadRedactors(),
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
        etsy_listing: etsyPollExecutor,
        etsy_shop: etsyPollExecutor,
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

  const registry = createTaskRegistry([
    heartbeatTask,
    ...market.tasks,
    delivery.deliverTask,
    refresh.refreshTokensTask,
    ...commerce.tasks,
  ]);

  return {
    registry,
    cronItems: buildCronItems({
      marketDispatch: market.dispatchDueMonitorsCronItem,
      ebayRefreshTokens: refresh.refreshTokensCronItem,
      redactOrderPayloads: commerce.redactOrderPayloadsCronItem,
    }),
    services,
    listings,
    commerce,
    close: async () => {
      if (ownsServices) await services.close();
    },
  };
}
