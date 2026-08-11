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
 *
 * Cron: `maintenance.heartbeat` (@loxep/jobs' defaults),
 * `market.dispatch-due-monitors` (every minute), `ebay.refresh-tokens`
 * (every 15 minutes). @loxep/commerce deliberately defines NO cron item —
 * its scheduled work is a `woo_orders` monitor target claimed by the market
 * dispatcher, which is the whole point of registering a target type instead
 * of adding a second scheduler (see the routing note below).
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
 * ```
 *
 * Each branch is built by the domain that owns the type and joined here,
 * which is Domain Boundaries' PROVISIONAL rule that "the executor for a
 * target type belongs to the domain that registered it, wired in the
 * composition root — never in the scheduling package".
 *
 * The `commerce.sync-woo-orders` TASK is registered alongside it and shares
 * the very same sync service instance. It is not how scheduled syncs run —
 * the dispatcher/poll path above is — it is the on-demand entry point (a
 * backfill, a "sync now" button, a script), which is why it keeps its own
 * job-key-per-connection and its own Graphile retry budget.
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
import { WOO_ORDERS_TARGET_TYPE, createCommerceTasks } from "@loxep/commerce";
import type { CommerceTasks } from "@loxep/commerce";
import {
  addJob as standaloneAddJob,
  createTaskRegistry,
  defaultCronItems,
  heartbeatTask,
} from "@loxep/jobs";
import type { AddJob, JobsLogger, TaskRegistry } from "@loxep/jobs";
import { createMarketTasks } from "@loxep/market";
import type { PollExecutor } from "@loxep/market";
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
import { createListingContextCache } from "./listing-context.ts";
import type { ListingContextCache } from "./listing-context.ts";
import {
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
}): readonly JobsCronItem[] {
  return [
    // @loxep/jobs' own defaults (heartbeat) stay first so the maintenance
    // path is scheduled even if a later item is misconfigured.
    ...defaultCronItems,
    input.marketDispatch,
    input.ebayRefreshTokens,
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
  // Built before the market tasks because its sync service is what the
  // `woo_orders` poll route runs; the task and the route share this instance.
  const commerce = createCommerceTasks({
    db: services.db,
    adapterFactory: async ({ connectionId }) =>
      (await services.getWooAdapterForConnection(connectionId)).adapter,
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
  const pollExecutor: PollExecutor = createRoutedPollExecutor({
    routes: { [WOO_ORDERS_TARGET_TYPE]: wooOrderPollExecutor },
    fallback: ebayPollExecutor,
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
    }),
    services,
    listings,
    commerce,
    close: async () => {
      if (ownsServices) await services.close();
    },
  };
}
