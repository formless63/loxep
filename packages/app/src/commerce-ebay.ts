/**
 * The `ebay_orders` {@link PollExecutor} (loxep-xh9.2) — Commerce's second
 * branch of the shared scheduling model, and the exact structural mirror of
 * `commerce.ts`'s WooCommerce branch.
 *
 * ```text
 * claimed ebay_orders target
 *   → market.poll-target
 *   → THIS executor
 *       → resolve the connection's eBay adapter (keyset + user token + budget)
 *       → @loxep/commerce syncConnection(...)      ← the REAL sync service
 *           → iterateEbayOrders(lastmodifieddate = stored cursor)
 *           → ingestEbayOrder per order  (idempotent)
 *           → writeOrderSyncCursor       (the watermark advance)
 *       → recordConnectionSuccess
 *   → recordPollSuccess(adaptive facts)            ← next_poll_at advance
 * ```
 *
 * ## The provider seam lives HERE, not in @loxep/commerce
 *
 * `@loxep/commerce` deliberately takes no dependency on
 * `@loxep/integration-ebay` (see that package's `ebay-sync.ts`), so the sync
 * service is handed an {@link EbayOrderPageIterator} — a plain async-generator
 * function — rather than an adapter factory. {@link createEbayOrderPageIterator}
 * is where that function is built, and it is the ONLY place in the wiring that
 * knows eBay's order calls exist. Everything provider-shaped stops there.
 *
 * ## User context is required, and its absence is an AUTH failure
 *
 * `GET /sell/fulfillment/v1/order` returns the SELLER's own orders, so unlike
 * the Browse item snapshots it cannot run on the application token. A
 * connection with no stored user token fails the poll with the adapter's own
 * `EbayKeysetMissingError` — the same contract the `ebay_watchlist` branch
 * has — and the poll records a failure with backoff rather than silently
 * reporting zero orders.
 *
 * The scope requirement is the one genuinely new failure mode: the Sell
 * Fulfillment API enforces
 * `https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly`, which the
 * base consent set does NOT include. A connection consented for the watchlist
 * vertical alone therefore fails `auth` here until it is re-consented with
 * `EBAY_ORDER_CONSENT_SCOPES`. That is the correct, diagnosable outcome: the
 * connection's error code says `ebay_auth`, and re-keying is an operator
 * action, not something a poll should paper over.
 *
 * ## Adaptive facts
 *
 * Identical in shape to the WooCommerce branch's, and for the same reasons:
 *
 * ```text
 * changed              ordersSeen > 0
 * recentChangeCount    ordersSeen
 * recentEventCount     0
 * secondsUntilListingEnd null      (an order is not a listing)
 * bounds.minSeconds    the connection's eBay rate-budget floor
 * deriveSignals        false       (an ebay_orders target links no
 *                                   monitor_items and produces no
 *                                   market_events — the derivation would
 *                                   spend a three-CTE query to be told zero)
 * ```
 *
 * ## Failure semantics
 *
 * A provider failure is recorded on the CONNECTION
 * (`recordConnectionFailure` with the eBay boundary's own error kind) and
 * then rethrown, so `market.poll-target` records the poll failure and its
 * backoff. Poll retry cadence stays owned by `backoff_until`, never by
 * Graphile retries. An `auth`-class failure additionally drops the cached
 * adapter, so a re-consented connection recovers on the next poll instead of
 * after the cache TTL.
 */
import type { EbayOrderPageIterator, EbayOrderSyncService } from "@loxep/commerce";
import type { PollExecutor, PollOutcome } from "@loxep/market";
import { EbayAdapterError, iterateEbayOrders } from "@loxep/integration-ebay";
import { AppConfigurationError } from "./errors.ts";
import type { AppServices } from "./services.ts";

/**
 * Bind `@loxep/integration-ebay`'s order pager to this composition's adapter
 * factory, producing the seam `@loxep/commerce`'s eBay sync service takes.
 *
 * The adapter is resolved INSIDE the generator so a connection re-keyed
 * between the executor's own resolution and the first page is picked up, and
 * so the sync service never holds a provider object.
 */
export function createEbayOrderPageIterator(
  services: AppServices,
): EbayOrderPageIterator {
  return (input) =>
    (async function* () {
      const ebay = await services.getEbayAdapterForConnection(
        input.connectionId,
      );
      for await (const page of iterateEbayOrders(
        ebay.requireUser(),
        {
          limit: input.perPage,
          includeFulfillments: input.includeFulfillments,
          ...(input.modifiedAfter === null
            ? {}
            : { modifiedAfter: input.modifiedAfter }),
        },
        { maxPages: input.maxPages },
      )) {
        yield page;
      }
    })();
}

export interface CreateEbayOrderPollExecutorOptions {
  services: AppServices;
  /**
   * The `@loxep/commerce` eBay sync service, already bound to the database and
   * to this composition's page iterator. Injected rather than constructed so
   * the registry builds exactly ONE sync service and shares it between the
   * poll path and the `commerce.sync-ebay-orders` task.
   */
  sync: EbayOrderSyncService;
}

export function createEbayOrderPollExecutor(
  options: CreateEbayOrderPollExecutorOptions,
): PollExecutor {
  const { services, sync } = options;

  return async (target, { logger }): Promise<PollOutcome> => {
    if (target.connectionId === null) {
      throw new AppConfigurationError(
        `monitor target ${target.id} (${target.targetType}) has no connection; ` +
          "eBay order sync needs a connection for its keyset, user token, " +
          "and rate budget",
      );
    }
    const connectionId = target.connectionId;

    // Resolved BEFORE the sync so a misconfigured or un-consented connection
    // fails the poll without the sync service having to construct anything,
    // and so the rate-budget floor is known even for a run that ingests
    // nothing.
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
          ordersSeen: result.ordersSeen,
          created: result.created,
          updated: result.updated,
          unchanged: result.unchanged,
          duplicatesMarked: result.duplicatesMarked,
          currencies: result.currencies,
          // A run full of these means eBay's status vocabulary moved; the
          // adapter degraded to `unknown` rather than inventing a state.
          unrecognizedStatuses: result.unrecognizedStatuses,
          nextModifiedAfter: result.nextModifiedAfter?.toISOString() ?? null,
        },
        "ebay order sync poll complete",
      );

      return {
        observations: result.ordersSeen,
        adaptive: {
          changed: result.ordersSeen > 0,
          secondsUntilListingEnd: null,
          recentEventCount: 0,
          recentChangeCount: result.ordersSeen,
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
