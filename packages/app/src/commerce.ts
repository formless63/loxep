/**
 * The `woo_orders` {@link PollExecutor} (loxep-xh9.7.2) — Commerce's branch of
 * the shared scheduling model.
 *
 * ```text
 * claimed woo_orders target
 *   → market.poll-target
 *   → THIS executor
 *       → resolve the connection's Woo adapter (baseUrl + credential + budget)
 *       → @loxep/commerce syncConnection(...)      ← the REAL sync service
 *           → iterateWooOrders(modified_after = stored cursor)
 *           → ingestWooOrder per order  (idempotent)
 *           → writeWooOrderSyncCursor   (the watermark advance)
 *       → recordConnectionSuccess
 *   → recordPollSuccess(adaptive facts)            ← next_poll_at advance
 * ```
 *
 * ## Why this lives in @loxep/app and not in @loxep/commerce
 *
 * Domain Boundaries' PROVISIONAL scheduling rule says the executor for a
 * target type belongs to the domain that registered it, **wired in the
 * composition root** — never in the scheduling package. @loxep/commerce owns
 * the sync service and the cursor; this module owns nothing but the
 * translation between one claimed `monitor_targets` row and one call to that
 * service. Everything provider-shaped stops at the adapter factory in
 * `woo.ts`, and nothing here knows what a WooCommerce order looks like.
 *
 * ## The cursor is NOT this module's business
 *
 * `syncConnection` reads and writes `config.commerceSync` itself, so the
 * watermark advance is atomic with the ingestion that earned it and identical
 * whether the sync ran from a poll, from `commerce.sync-woo-orders`, or from
 * a script. This executor deliberately does not touch that namespace — the
 * registration rule's "no domain reads or writes another's namespace" cuts
 * both ways, and the composition root is not Commerce.
 *
 * ## Adaptive facts
 *
 * ```text
 * changed              ordersSeen > 0
 * recentChangeCount    ordersSeen
 * recentEventCount     0
 * secondsUntilListingEnd null
 * bounds.minSeconds    the connection's Woo rate-budget floor
 * deriveSignals        false
 * ```
 *
 * `changed = ordersSeen > 0` is the honest reading of this poll: an order
 * that came back through `modified_after` was created or modified since the
 * last watermark, which is precisely the "something happened" signal the
 * adaptive policy wants. `unchanged` ingestion results are still counted —
 * seeing the same order twice is the CURSOR's deliberate one-second overlap
 * re-reading a boundary, not the absence of activity, and treating a poll
 * that fetched orders as idle would relax cadence exactly when the store is
 * busiest.
 *
 * `recentChangeCount = ordersSeen` feeds the same policy the eBay path uses:
 * ≥ 3 orders in a poll is `activity_warm` (half the base interval), ≥ 8 is
 * `activity_hot` (a quarter), and a quiet store relaxes through the idle
 * tiers — all clamped from below by the rate-budget floor, which for a
 * self-hosted store is the binding constraint almost every time.
 *
 * `deriveSignals` is FALSE, unlike every eBay branch, and that is not an
 * oversight: `collectAdaptiveSignals` derives its counts from
 * `market_events` and `marketplace_item_observations` for the target's linked
 * `monitor_items`. A `woo_orders` target links no marketplace items and
 * produces no market events — it would spend a three-CTE query to be told
 * zero. The facts above are the ones that exist.
 *
 * `secondsUntilListingEnd` is null for the same reason: an order is not a
 * listing and has no end time, so the auction-proximity tiers cannot fire.
 *
 * ## Failure semantics
 *
 * Identical in shape to the eBay executor's: a provider failure is recorded
 * on the CONNECTION (`recordConnectionFailure` with the Woo boundary's own
 * error kind) and then rethrown, so `market.poll-target` records the poll
 * failure and its backoff. Poll retry cadence stays owned by `backoff_until`,
 * never by Graphile retries. An `auth`-class failure additionally drops the
 * cached adapter, so a re-keyed connection recovers on the next poll instead
 * of after the cache TTL.
 *
 * A `rate_limited` failure is deliberately treated like any other provider
 * failure rather than specially: the backoff formula already doubles the
 * interval, which is the correct response to a store (or its host's WAF)
 * saying "slower".
 */
import type { WooOrderSyncService } from "@loxep/commerce";
import type { PollExecutor, PollOutcome } from "@loxep/market";
import { WooAdapterError } from "@loxep/integration-woo";
import { AppConfigurationError } from "./errors.ts";
import type { AppServices } from "./services.ts";

export interface CreateWooOrderPollExecutorOptions {
  services: AppServices;
  /**
   * The `@loxep/commerce` sync service, already bound to the database and to
   * this composition's adapter factory. Injected rather than constructed so
   * the registry builds exactly ONE sync service and shares it between the
   * poll path and the `commerce.sync-woo-orders` task.
   */
  sync: WooOrderSyncService;
}

export function createWooOrderPollExecutor(
  options: CreateWooOrderPollExecutorOptions,
): PollExecutor {
  const { services, sync } = options;

  return async (target, { logger }): Promise<PollOutcome> => {
    if (target.connectionId === null) {
      throw new AppConfigurationError(
        `monitor target ${target.id} (${target.targetType}) has no connection; ` +
          "WooCommerce order sync needs a connection for its store URL, " +
          "credential, and rate budget",
      );
    }
    const connectionId = target.connectionId;

    // Resolved BEFORE the sync so a misconfigured connection fails the poll
    // without the sync service having to construct anything, and so the
    // rate-budget floor is known even for a run that ingests nothing.
    const woo = await services.getWooAdapterForConnection(connectionId);

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
          nextModifiedAfter: result.nextModifiedAfter?.toISOString() ?? null,
        },
        "woocommerce order sync poll complete",
      );

      return {
        observations: result.ordersSeen,
        adaptive: {
          changed: result.ordersSeen > 0,
          secondsUntilListingEnd: null,
          recentEventCount: 0,
          recentChangeCount: result.ordersSeen,
          bounds: { minSeconds: woo.minIntervalSeconds },
          deriveSignals: false,
        },
      };
    } catch (error) {
      if (error instanceof WooAdapterError) {
        if (error.kind === "auth") {
          // Force a connection + credential re-read on the next poll.
          services.invalidateWooAdapter(connectionId);
        }
        await services.connections
          .recordConnectionFailure(connectionId, {
            errorCode: `woo_${error.kind}`,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  };
}
