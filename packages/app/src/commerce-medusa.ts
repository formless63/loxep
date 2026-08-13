/**
 * The `medusa_orders` {@link PollExecutor} (loxep-xxz) — Commerce's THIRD
 * branch of the shared scheduling model, and the structural mirror of
 * `commerce-ebay.ts`'s eBay branch (itself mirroring `commerce.ts`'s
 * WooCommerce branch).
 *
 * ```text
 * claimed medusa_orders target
 *   → market.poll-target
 *   → THIS executor
 *       → resolve the connection's Medusa adapter (base URL + secret key + budget)
 *       → @loxep/commerce syncConnection(...)      ← the REAL sync service
 *           → iterateMedusaOrders(updatedAfter = stored cursor)
 *           → ingestMedusaOrder per order  (idempotent)
 *           → writeOrderSyncCursor        (the watermark advance)
 *       → recordConnectionSuccess
 *   → recordPollSuccess(adaptive facts)            ← next_poll_at advance
 * ```
 *
 * ## The provider seam lives HERE, not in @loxep/commerce
 *
 * `@loxep/commerce` deliberately takes no dependency on
 * `@loxep/integration-medusa` (see that package's `medusa-sync.ts`), so the
 * sync service is handed a {@link MedusaOrderPageIterator} — a plain
 * async-generator function — rather than an adapter factory.
 * {@link createMedusaOrderPageIterator} is where that function is built, and
 * it is the ONLY place in the wiring that knows Medusa's order calls exist.
 * Everything provider-shaped stops there.
 *
 * The adapter is resolved **INSIDE** the generator, exactly like the eBay
 * branch — a connection re-keyed between the executor's own resolution and
 * the first page is picked up mid-run, and the sync service never holds a
 * provider object.
 *
 * ## Medusa's filters fail open — the canary is `iterateMedusaOrders`'s, not this file's
 *
 * `@loxep/integration-medusa`'s `iterateMedusaOrders` asserts every returned
 * order's `updated_at` honors the requested watermark and throws a
 * `provider_unavailable` `MedusaAdapterError` the instant that invariant is
 * violated (`assertWatermarkHonored`) — a live-verified countermeasure for a
 * live-verified failure mode (a typo'd filter degrades to an unfiltered full
 * scan instead of erroring). Binding `iterateMedusaOrders` directly here,
 * with no try/catch around the loop, is what lets that canary propagate to
 * `market.poll-target` as a loud poll failure with backoff — an unfiltered
 * page is a provider fault, not a data event, and must never be swallowed or
 * silently accepted.
 *
 * ## Adaptive facts
 *
 * Identical in shape to the WooCommerce/eBay branches', and for the same
 * reasons:
 *
 * ```text
 * changed              ordersSeen > 0
 * recentChangeCount    ordersSeen
 * recentEventCount     0
 * secondsUntilListingEnd null      (an order is not a listing)
 * bounds.minSeconds    the connection's Medusa rate-budget floor
 * deriveSignals        false       (a medusa_orders target links no
 *                                   monitor_items and produces no
 *                                   market_events — the derivation would
 *                                   spend a three-CTE query to be told zero)
 * ```
 *
 * ## Failure semantics
 *
 * A provider failure is recorded on the CONNECTION (`recordConnectionFailure`
 * with `medusa_<kind>`) and then rethrown, so `market.poll-target` records
 * the poll failure and its backoff. Poll retry cadence stays owned by
 * `backoff_until`, never by Graphile retries. An `auth`-class failure
 * additionally drops the cached adapter, so a re-keyed connection recovers on
 * the next poll instead of after the cache TTL. `rate_limited` is
 * deliberately NOT special-cased — the backoff formula already doubles.
 *
 * `fact.statusRecognized === false` (an unmapped Medusa status vocabulary)
 * deserves a `logger.warn` here, not a column — see `@loxep/commerce`'s
 * `medusa.ts` module doc for why no `CommerceOrderFact` field carries it.
 * Unlike eBay's `unrecognizedStatuses` (aggregated inside `ebay-sync.ts`,
 * `@loxep/commerce`'s own package), `medusa-sync.ts`'s
 * `SyncMedusaOrdersResult` carries no such field, so the poll executor cannot
 * observe the flag from the sync result. The page iterator built here is the
 * one place in this wiring that still holds individual `MedusaOrderFact`
 * values before they cross into `@loxep/commerce`, so the warning is emitted
 * from there instead.
 */
import type {
  MedusaOrderPageIterator,
  MedusaOrderSyncService,
} from "@loxep/commerce";
import type { JobsLogger } from "@loxep/jobs";
import type { PollExecutor, PollOutcome } from "@loxep/market";
import { MedusaAdapterError, iterateMedusaOrders } from "@loxep/integration-medusa";
import { AppConfigurationError } from "./errors.ts";
import type { AppServices } from "./services.ts";

/**
 * Bind `@loxep/integration-medusa`'s order pager to this composition's
 * adapter factory, producing the seam `@loxep/commerce`'s Medusa sync service
 * takes.
 *
 * The adapter is resolved INSIDE the generator so a connection re-keyed
 * between the executor's own resolution and the first page is picked up, and
 * so the sync service never holds a provider object. This is also where an
 * unrecognized provider status vocabulary is logged (see the module doc) —
 * the composition root's only remaining touchpoint with an individual
 * `MedusaOrderFact`.
 */
export function createMedusaOrderPageIterator(
  services: AppServices,
  options: { logger?: JobsLogger } = {},
): MedusaOrderPageIterator {
  const { logger } = options;
  return (input) =>
    (async function* () {
      const medusa = await services.getMedusaAdapterForConnection(
        input.connectionId,
      );
      for await (const page of iterateMedusaOrders(
        medusa.adapter,
        {
          limit: input.perPage,
          ...(input.modifiedAfter === null
            ? {}
            : { updatedAfter: input.modifiedAfter }),
        },
        { maxPages: input.maxPages },
      )) {
        for (const order of page.orders) {
          if (!order.statusRecognized) {
            logger?.warn(
              {
                connectionId: input.connectionId,
                externalOrderId: order.externalOrderId,
                providerStatusRaw: order.providerStatusRaw,
                providerPaymentStatusRaw: order.providerPaymentStatusRaw,
                providerFulfillmentStatusRaw: order.providerFulfillmentStatusRaw,
              },
              "medusa order carries an unrecognized status vocabulary; the adapter degraded to a fallback status rather than inventing one",
            );
          }
        }
        yield page;
      }
    })();
}

export interface CreateMedusaOrderPollExecutorOptions {
  services: AppServices;
  /**
   * The `@loxep/commerce` Medusa sync service, already bound to the database
   * and to this composition's page iterator. Injected rather than
   * constructed so the registry builds exactly ONE sync service and shares it
   * between the poll path and the `commerce.sync-medusa-orders` task.
   */
  sync: MedusaOrderSyncService;
}

export function createMedusaOrderPollExecutor(
  options: CreateMedusaOrderPollExecutorOptions,
): PollExecutor {
  const { services, sync } = options;

  return async (target, { logger }): Promise<PollOutcome> => {
    if (target.connectionId === null) {
      throw new AppConfigurationError(
        `monitor target ${target.id} (${target.targetType}) has no connection; ` +
          "Medusa order sync needs a connection for its backend URL, " +
          "secret API key, and rate budget",
      );
    }
    const connectionId = target.connectionId;

    // Resolved BEFORE the sync so a misconfigured connection fails the poll
    // without the sync service having to construct anything, and so the
    // rate-budget floor is known even for a run that ingests nothing.
    const medusa = await services.getMedusaAdapterForConnection(connectionId);

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
        "medusa order sync poll complete",
      );

      return {
        observations: result.ordersSeen,
        adaptive: {
          changed: result.ordersSeen > 0,
          secondsUntilListingEnd: null,
          recentEventCount: 0,
          recentChangeCount: result.ordersSeen,
          bounds: { minSeconds: medusa.minIntervalSeconds },
          deriveSignals: false,
        },
      };
    } catch (error) {
      if (error instanceof MedusaAdapterError) {
        if (error.kind === "auth") {
          // Force a connection + credential re-read on the next poll — the
          // usual cause here is a rotated or revoked secret API key.
          services.invalidateMedusaAdapter(connectionId);
        }
        await services.connections
          .recordConnectionFailure(connectionId, {
            errorCode: `medusa_${error.kind}`,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  };
}
