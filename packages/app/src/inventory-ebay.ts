/**
 * The `ebay_purchases` {@link PollExecutor} (Flipping milestone 5,
 * loxep-dgf.5) — the structural mirror of `commerce-ebay.ts`'s `ebay_orders`
 * branch, one domain over: `@loxep/inventory` registered the target type,
 * this module is the composition root's wiring for it.
 *
 * ```text
 * claimed ebay_purchases target
 *   → market.poll-target
 *   → THIS executor
 *       → resolve the connection's eBay adapter (keyset + user token + budget)
 *       → @loxep/inventory syncConnection(...)   ← the REAL sync service
 *           → fetchAllWonPurchases (GetMyeBayBuying WonList, all pages)
 *           → ingestEbayPurchase per fact          (idempotent, draft-only)
 *           → writePurchaseSyncCursor              (the watermark advance)
 *       → recordConnectionSuccess
 *   → recordPollSuccess(adaptive facts)             ← next_poll_at advance
 * ```
 *
 * ## Why this file exists now and not when loxep-dgf.5 first landed
 *
 * `@loxep/inventory`'s `purchase-sync.ts` shipped first with this exact
 * executor undeliverable: `@loxep/app`'s `package.json` did not declare
 * `@loxep/inventory` as a dependency, so nothing here could import it without
 * a `package.json` edit outside that change's write fence. The dependency has
 * since been added and the workspace relinked, closing the gap that
 * module's doc and the design doc's "Implementation status" note describe —
 * this file is that follow-up.
 *
 * ## The provider seam lives HERE, not in @loxep/inventory
 *
 * `@loxep/inventory` deliberately does not depend on `@loxep/integration-ebay`
 * (see `purchase-sync.ts`'s module doc — `EbayPurchaseFactLike` is a
 * structural re-declaration, not an import), so its sync service is handed an
 * {@link EbayPurchasePageIterator} — a plain async function — rather than an
 * adapter factory. {@link createEbayPurchasePageIterator} is where that
 * function is built, and it is the ONLY place in this module's wiring that
 * knows `WonList`/`fetchAllWonPurchases` exist.
 *
 * ## User context is required, same as `ebay_orders` and `ebay_watchlist`
 *
 * `GetMyeBayBuying` is a Trading call authenticated with the connection's
 * OWN user token via the IAF header — see `purchases.ts`'s module doc: NO
 * OAuth scope is required beyond the base `watchlist`-tier consent, unlike
 * `ebay_orders`' Sell Fulfillment scope requirement. A connection with no
 * stored user token still fails with the adapter's own
 * `EbayKeysetMissingError`/`auth`-kind error, and the poll records a failure
 * with backoff rather than silently reporting zero purchases.
 *
 * ## Adaptive facts
 *
 * ```text
 * changed              purchasesSeen > 0
 * recentChangeCount    purchasesSeen
 * recentEventCount     0
 * secondsUntilListingEnd null      (a purchase is not a listing)
 * bounds.minSeconds    the connection's eBay rate-budget floor
 * deriveSignals        false       (an ebay_purchases target links no
 *                                   monitor_items and produces no
 *                                   market_events)
 * ```
 *
 * ## Failure semantics
 *
 * Identical shape to `ebay_orders`': a provider failure is recorded on the
 * CONNECTION (`recordConnectionFailure` with the eBay boundary's own error
 * kind) and rethrown, so `market.poll-target` records the poll failure and
 * its backoff. An `auth`-class failure additionally drops the cached
 * adapter.
 *
 * ## The on-demand task
 *
 * `inventory.sync-ebay-purchases` is the manual/backfill entry point — a
 * "sync now" action or a script — NOT how scheduled polling runs (that is
 * the route above, claimed by `market.poll-target`). It is defined here
 * rather than in `@loxep/inventory` for the same reason `health.sweep`/
 * `infrastructure.gatus-push` are defined in `@loxep/app` rather than their
 * owning domain packages: `@loxep/inventory` takes no `@loxep/jobs`
 * dependency, so the thin Graphile Worker wrapper lives in the composition
 * root that already has one.
 */
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
// `RawAddJob` (a structural, graphile-worker-free `addJob` signature) is
// @loxep/commerce's type, reused here rather than redefined — see that
// package's `tasks.ts` module doc for why it is shaped this way.
import type { RawAddJob } from "@loxep/commerce";
import { createEbayPurchaseSync } from "@loxep/inventory";
import type {
  EbayPurchasePageIterator,
  EbayPurchaseSyncService,
} from "@loxep/inventory";
import type { PollExecutor, PollOutcome } from "@loxep/market";
import { EbayAdapterError, fetchAllWonPurchases } from "@loxep/integration-ebay";
import { z } from "zod";
import { AppConfigurationError } from "./errors.ts";
import type { AppServices } from "./services.ts";

/**
 * Bind `@loxep/integration-ebay`'s `fetchAllWonPurchases` to this
 * composition's adapter factory, producing the seam `@loxep/inventory`'s
 * purchase-sync service takes. Resolved INSIDE the function so a connection
 * re-keyed between the executor's own resolution and this call is picked up.
 */
export function createEbayPurchasePageIterator(
  services: AppServices,
): EbayPurchasePageIterator {
  return async (input) => {
    const ebay = await services.getEbayAdapterForConnection(input.connectionId);
    return fetchAllWonPurchases(ebay.requireUser(), {
      entriesPerPage: input.entriesPerPage,
      maxPages: input.maxPages,
    });
  };
}

export interface CreateEbayPurchasePollExecutorOptions {
  services: AppServices;
  /**
   * The `@loxep/inventory` purchase-sync service, already bound to the
   * database and to this composition's page iterator. Injected rather than
   * constructed so the registry builds exactly ONE sync service and shares
   * it between the poll path and the `inventory.sync-ebay-purchases` task.
   */
  sync: EbayPurchaseSyncService;
}

export function createEbayPurchasePollExecutor(
  options: CreateEbayPurchasePollExecutorOptions,
): PollExecutor {
  const { services, sync } = options;

  return async (target, { logger }): Promise<PollOutcome> => {
    if (target.connectionId === null) {
      throw new AppConfigurationError(
        `monitor target ${target.id} (${target.targetType}) has no connection; ` +
          "eBay purchase sync needs a connection for its keyset, user token, " +
          "and rate budget",
      );
    }
    const connectionId = target.connectionId;

    // Resolved BEFORE the sync so a misconfigured or un-consented connection
    // fails the poll without the sync service having to construct anything.
    const ebay = await services.getEbayAdapterForConnection(connectionId);
    ebay.requireUser();

    try {
      const result = await sync.syncConnection({ connectionId });
      await services.connections.recordConnectionSuccess(connectionId);

      logger.info(
        {
          monitorTargetId: target.id,
          connectionId,
          pages: result.pages,
          truncated: result.truncated,
          purchasesSeen: result.purchasesSeen,
          created: result.created,
          skipped: result.skipped,
          currencies: result.currencies,
          lastPurchasedAt: result.lastPurchasedAt?.toISOString() ?? null,
        },
        "ebay purchase sync poll complete",
      );

      return {
        observations: result.purchasesSeen,
        adaptive: {
          changed: result.purchasesSeen > 0,
          secondsUntilListingEnd: null,
          recentEventCount: 0,
          recentChangeCount: result.purchasesSeen,
          bounds: { minSeconds: ebay.minIntervalSeconds },
          deriveSignals: false,
        },
      };
    } catch (error) {
      if (error instanceof EbayAdapterError) {
        if (error.kind === "auth") {
          // Force a connection + credential re-read on the next poll — the
          // usual cause here is a token re-consented with a wider scope.
          services.invalidateEbayAdapter(connectionId);
        }
        await services.connections
          .recordConnectionFailure(connectionId, {
            errorCode: `ebay_${error.kind}`,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  };
}

/* --------------------------------------------------------- on-demand task */

export const SYNC_EBAY_PURCHASES_TASK_NAME = "inventory.sync-ebay-purchases";

const syncEbayPurchasesPayloadSchema = z.object({
  connectionId: z.uuid(),
  maxPages: z.number().int().min(1).max(100).optional(),
  entriesPerPage: z.number().int().min(1).max(200).optional(),
  actorUserId: z.string().min(1).nullish(),
  correlationId: z.string().optional(),
});

export type SyncEbayPurchasesTask = LoxepTask<
  typeof syncEbayPurchasesPayloadSchema
>;

/** The canonical job key for one connection's eBay purchase sync. */
export function ebayPurchaseSyncJobKey(connectionId: string): string {
  return jobKeyFor(SYNC_EBAY_PURCHASES_TASK_NAME, connectionId);
}

/** Enqueue (or replace) one connection's eBay purchase-history sync. */
export async function enqueueEbayPurchaseSync(
  addJob: RawAddJob,
  input: {
    connectionId: string;
    maxPages?: number;
    entriesPerPage?: number;
    priority?: number;
    runAt?: Date;
  },
): Promise<void> {
  const { connectionId, priority, runAt, ...payload } = input;
  await addJob(
    SYNC_EBAY_PURCHASES_TASK_NAME,
    { connectionId, ...payload },
    {
      jobKey: ebayPurchaseSyncJobKey(connectionId),
      jobKeyMode: "replace",
      ...(priority === undefined ? {} : { priority }),
      ...(runAt === undefined ? {} : { runAt }),
    },
  );
}

export interface EbayPurchaseSyncTasks {
  syncEbayPurchasesTask: SyncEbayPurchasesTask;
  sync: EbayPurchaseSyncService;
}

/**
 * Build the on-demand task alongside the ONE sync service instance the poll
 * route above also runs — the same one-service-two-entry-points shape
 * `@loxep/commerce`'s `createCommerceTasks` uses for `ebay_orders`.
 */
export function createInventoryPurchaseSyncTasks(options: {
  services: AppServices;
  /** Reuse an already-built sync service (shares state with the poll route). */
  sync?: EbayPurchaseSyncService;
  /** Provider seam override (tests supply canned pages here). */
  fetchPurchases?: EbayPurchasePageIterator;
}): EbayPurchaseSyncTasks {
  const { services } = options;
  const sync =
    options.sync ??
    createEbayPurchaseSync({
      db: services.db,
      fetchPurchases:
        options.fetchPurchases ?? createEbayPurchasePageIterator(services),
    });

  const syncEbayPurchasesTask = defineTask({
    name: SYNC_EBAY_PURCHASES_TASK_NAME,
    payloadSchema: syncEbayPurchasesPayloadSchema,
    // On-demand backfill, not the terminal step of a dispatcher that owns
    // retry cadence — same reasoning as `commerce.sync-ebay-orders`.
    maxAttempts: 3,
    handler: async (payload, { logger }) => {
      const result = await sync.syncConnection({
        connectionId: payload.connectionId,
        ...(payload.maxPages === undefined ? {} : { maxPages: payload.maxPages }),
        ...(payload.entriesPerPage === undefined
          ? {}
          : { entriesPerPage: payload.entriesPerPage }),
        ...(payload.actorUserId === undefined || payload.actorUserId === null
          ? {}
          : { actorUserId: payload.actorUserId }),
      });
      logger.info(
        {
          connectionId: result.connectionId,
          pages: result.pages,
          truncated: result.truncated,
          purchasesSeen: result.purchasesSeen,
          created: result.created,
          skipped: result.skipped,
          currencies: result.currencies,
          lastPurchasedAt: result.lastPurchasedAt?.toISOString() ?? null,
        },
        "ebay purchase sync completed",
      );
      return result;
    },
  });

  return { syncEbayPurchasesTask, sync };
}
