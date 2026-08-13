/**
 * The real Reverb {@link PollExecutor} (loxep-g4t.3) — serves
 * `reverb_listing` and `reverb_shop`, the two m1 observation target types.
 *
 * ## `reverb_listing`
 *
 * ```text
 * resolve the per-connection adapter (see reverb.ts)
 *   -> mint observationBatchId + observedAt ONCE
 *   -> adapter.getListing(externalItemId)
 *   -> mapListingToSnapshot -> snapshotToObservation
 *   -> upsertMarketplaceItem  (canonical identity)
 *   -> load PREVIOUS latest observation   <- before the batch insert
 *   -> recordObservationBatch  (ON CONFLICT DO NOTHING, retry-safe)
 *   -> linkItemToMonitor
 *   -> deriveMarketEvents (previous -> current)
 *   -> evaluateRulesForEvent (opportunity attribution)
 *   -> enqueueDeliveriesForEvent (the explicit detection->delivery bridge)
 *   -> recordConnectionSuccess
 * ```
 *
 * Structurally identical to Etsy's `pollListing` in `etsy-poll-executor.ts`
 * — the batch identity is minted exactly once and reused for every write
 * derived from it, which is what makes an at-least-once replay of this
 * handler a no-op instead of a duplicate.
 *
 * ## `reverb_shop`
 *
 * UNLIKE Etsy's `etsy_shop` (which can page ANY shop's public listings by
 * id), Reverb's `reverb_shop` always means "the connected account's own
 * listings" (`GET /my/listings`, needs `read_listings`) — see the binding
 * design's "Monitor target types". Pagination follows the response's
 * `_links.next.href` VERBATIM (Reverb's own documented HAL convention),
 * never a guessed `page`/`offset` query parameter:
 *
 * ```text
 * resolve the per-connection adapter
 *   -> mint observationBatchId + observedAt ONCE
 *   -> page adapter.getMyListings({state: "all", pageHref}), bounded by
 *      maxItems and a hard page-count safety cap
 *   -> for each fetched listing: map -> snapshotToObservation -> upsert
 *      -> observe (read-previous-then-insert, same ordering as
 *         reverb_listing) -> link to monitor -> derive events -> publish
 *   -> recordConnectionSuccess
 * ```
 *
 * `maxItems` is therefore both the discovery cost knob AND the observation
 * cap in one — fetching IS observing here, the same shape Etsy's
 * `etsy_shop` uses for the identical reason (Reverb's `/my/listings`
 * collection returns full listing objects, not a thin summary requiring a
 * follow-up per-item read).
 *
 * ## Failure semantics
 *
 * A provider failure is recorded on the CONNECTION
 * (`recordConnectionFailure`) with the boundary's own error kind, then
 * rethrown, so `market.poll-target` records the poll failure and its
 * backoff — identical to the Etsy/eBay executors' contract. An `auth`-class
 * failure additionally drops the cached per-connection adapter entry.
 */
import { randomUUID } from "node:crypto";
import type { AddJob, JobsLogger } from "@loxep/jobs";
import {
  deriveMarketEvents,
  evaluateRulesForEvent,
  latestObservations,
  linkItemToMonitor,
  monitorTargetConfigSchemas,
  recordObservationBatch,
  upsertMarketplaceItem,
} from "@loxep/market";
import type {
  MarketEventRow,
  MarketplaceItemRecord,
  ObservationItemInput,
  ObservationRow,
  ObservationSnapshot,
  PollExecutor,
  PollOutcome,
} from "@loxep/market";
import {
  mapListingToSnapshot,
  ReverbAdapterError,
  snapshotToObservation,
} from "../../integrations/reverb/src/index.ts";
import type { ReverbListingSnapshot } from "../../integrations/reverb/src/index.ts";
import { AppConfigurationError } from "./errors.ts";
import type { ListingContextCache } from "./listing-context.ts";
import type { ReverbConnectionAdapter } from "./reverb.ts";
import type { AppServices } from "./services.ts";

/** `marketplace_item_observations.source` written by each poll kind. */
export const REVERB_LISTING_OBSERVATION_SOURCE = "reverb:listing";
export const REVERB_SHOP_OBSERVATION_SOURCE = "reverb:shop";

/** How far a `reverb_shop` poll pages when its config names no `maxItems`. */
export const REVERB_SHOP_DEFAULT_MAX_ITEMS = 100;
/** Safety bound: no poll follows more `_links.next` hops than this, regardless of maxItems. */
const REVERB_SHOP_MAX_PAGES = 20;

function snapshotFromObservationRow(row: ObservationRow): ObservationSnapshot {
  return {
    observedAt: row.observedAt,
    price: row.price,
    currency: row.currency,
    quantityAvailable: row.quantityAvailable,
    availability: row.availability,
    listingState: row.listingState,
  };
}

function snapshotFromObservationItem(
  item: Omit<ObservationItemInput, "marketplaceItemId">,
  observedAt: Date,
): ObservationSnapshot {
  return {
    observedAt,
    price: item.price ?? null,
    currency: item.currency ?? null,
    quantityAvailable: item.quantityAvailable ?? null,
    availability: null,
    listingState: item.listingState ?? null,
  };
}

export interface CreateReverbPollExecutorOptions {
  services: AppServices;
  /**
   * The explicit detection->delivery bridge, matching the eBay/Etsy
   * executors' contract exactly.
   */
  enqueueDeliveriesForEvent: (
    addJob: AddJob,
    marketEvent: { id: string; eventType: string; monitorTargetId: string | null },
  ) => Promise<{ endpointIds: string[] }>;
  addJob: AddJob;
  listings?: ListingContextCache;
}

export function createReverbPollExecutor(
  options: CreateReverbPollExecutorOptions,
): PollExecutor {
  const { services, enqueueDeliveriesForEvent, addJob, listings } = options;
  const db = services.db;

  async function adapterFor(target: {
    id: string;
    targetType: string;
    connectionId: string | null;
  }): Promise<ReverbConnectionAdapter> {
    if (target.connectionId === null) {
      throw new AppConfigurationError(
        `monitor target ${target.id} (${target.targetType}) has no connection; ` +
          "Reverb polling needs a connection for its Personal Access Token",
      );
    }
    return services.getReverbAdapterForConnection(target.connectionId);
  }

  async function publishEvent(
    event: MarketEventRow,
    item: MarketplaceItemRecord,
    logger: JobsLogger,
  ): Promise<void> {
    try {
      const evaluation = await evaluateRulesForEvent(db, {
        id: event.id,
        marketplaceItemId: event.marketplaceItemId,
        monitorTargetId: event.monitorTargetId,
        eventType: event.eventType,
        fromObservedAt: event.fromObservedAt,
        toObservedAt: event.toObservedAt,
      });
      if (evaluation.ruleId !== null) {
        logger.info(
          {
            marketEventId: event.id,
            ruleId: evaluation.ruleId,
            matches: evaluation.matches.length,
          },
          "market event attributed to an opportunity rule",
        );
      }
    } catch (error) {
      logger.error(
        {
          marketEventId: event.id,
          err: error instanceof Error ? error.message : String(error),
        },
        "opportunity rule evaluation failed",
      );
    }
    listings?.remember(item.id, {
      provider: item.provider,
      marketplace: item.marketplace,
      externalItemId: item.externalItemId,
      canonicalUrl: item.canonicalUrl,
      title: item.title,
    });
    try {
      const { endpointIds } = await enqueueDeliveriesForEvent(addJob, {
        id: event.id,
        eventType: event.eventType,
        monitorTargetId: event.monitorTargetId,
      });
      if (endpointIds.length > 0) {
        logger.info(
          { marketEventId: event.id, endpoints: endpointIds.length },
          "enqueued notification deliveries",
        );
      }
    } catch (error) {
      logger.error(
        {
          marketEventId: event.id,
          err: error instanceof Error ? error.message : String(error),
        },
        "failed to enqueue notification deliveries",
      );
    }
  }

  async function observeSnapshot(input: {
    snapshot: ReverbListingSnapshot;
    batch: { observationBatchId: string; observedAt: Date; source: string };
    connectionId: string;
    monitorTargetId: string;
    logger: JobsLogger;
  }): Promise<{ item: MarketplaceItemRecord; inserted: number; changed: boolean }> {
    const { snapshot, batch, connectionId, monitorTargetId, logger } = input;
    const mapped = snapshotToObservation(snapshot, {
      observationBatchId: batch.observationBatchId,
      observedAt: batch.observedAt,
      connectionId,
      source: batch.source,
    });
    const item = await upsertMarketplaceItem({ db, item: mapped.item });

    // PREVIOUS must be read before the insert, or it would return this batch.
    const previousRows = await latestObservations(db, item.id, 1);
    const previousRow = previousRows[0] ?? null;

    const { inserted } = await recordObservationBatch({
      db,
      batch: {
        observationBatchId: batch.observationBatchId,
        observedAt: batch.observedAt,
        connectionId,
        source: batch.source,
        items: [{ ...mapped.observation, marketplaceItemId: item.id }],
      },
    });
    await linkItemToMonitor(db, {
      monitorTargetId,
      marketplaceItemId: item.id,
      at: batch.observedAt,
    });

    const changed =
      inserted > 0 &&
      (previousRow === null ||
        previousRow.rawStateHash === null ||
        previousRow.rawStateHash !== mapped.observation.rawStateHash);

    if (previousRow !== null && inserted > 0) {
      const { inserted: events } = await deriveMarketEvents({
        db,
        marketplaceItemId: item.id,
        previous: snapshotFromObservationRow(previousRow),
        current: snapshotFromObservationItem(mapped.observation, batch.observedAt),
        monitorTargetId,
        detectedAt: batch.observedAt,
      });
      for (const event of events) {
        await publishEvent(event, item, logger);
      }
    }
    return { item, inserted, changed };
  }

  // -------------------------------------------------------------------
  // reverb_listing
  // -------------------------------------------------------------------

  async function pollListing(
    target: { id: string; connectionId: string | null; config: unknown },
    adapter: ReverbConnectionAdapter,
    logger: JobsLogger,
  ): Promise<PollOutcome> {
    const config = monitorTargetConfigSchemas.reverb_listing.parse(target.config ?? {});
    const observationBatchId = randomUUID();
    const observedAt = new Date();

    const raw = await adapter.adapter.getListing(config.externalItemId);
    const snapshot = mapListingToSnapshot(raw, { fetchedAt: observedAt });

    const result = await observeSnapshot({
      snapshot,
      batch: {
        observationBatchId,
        observedAt,
        source: REVERB_LISTING_OBSERVATION_SOURCE,
      },
      connectionId: adapter.connectionId,
      monitorTargetId: target.id,
      logger,
    });

    return {
      observations: result.inserted,
      adaptive: {
        changed: result.changed,
        secondsUntilListingEnd: null,
        bounds: { minSeconds: adapter.minIntervalSeconds },
        deriveSignals: true,
      },
    };
  }

  // -------------------------------------------------------------------
  // reverb_shop
  // -------------------------------------------------------------------

  async function fetchMyListings(
    adapter: ReverbConnectionAdapter,
    maxItems: number,
  ): Promise<{ raw: Array<Record<string, unknown>>; pages: number }> {
    const raw: Array<Record<string, unknown>> = [];
    let pageHref: string | undefined;
    let pages = 0;
    while (raw.length < maxItems && pages < REVERB_SHOP_MAX_PAGES) {
      const page = await adapter.adapter.getMyListings(
        pageHref !== undefined ? { pageHref } : { state: "all" },
      );
      pages += 1;
      if (page.results.length === 0) break;
      raw.push(...page.results);
      if (page.nextHref === null) break;
      pageHref = page.nextHref;
    }
    return { raw: raw.slice(0, maxItems), pages };
  }

  async function pollShop(
    target: { id: string; connectionId: string | null; config: unknown },
    adapter: ReverbConnectionAdapter,
    logger: JobsLogger,
  ): Promise<PollOutcome> {
    const config = monitorTargetConfigSchemas.reverb_shop.parse(target.config ?? {});
    const observationBatchId = randomUUID();
    const observedAt = new Date();
    const maxItems = config.maxItems ?? REVERB_SHOP_DEFAULT_MAX_ITEMS;

    const { raw, pages } = await fetchMyListings(adapter, maxItems);

    let observations = 0;
    let changed = false;
    for (const listing of raw) {
      const snapshot = mapListingToSnapshot(listing, { fetchedAt: observedAt });
      const result = await observeSnapshot({
        snapshot,
        batch: {
          observationBatchId,
          observedAt,
          source: REVERB_SHOP_OBSERVATION_SOURCE,
        },
        connectionId: adapter.connectionId,
        monitorTargetId: target.id,
        logger,
      });
      observations += result.inserted;
      changed ||= result.changed;
    }

    logger.info(
      { monitorTargetId: target.id, fetched: raw.length, pages, observed: observations },
      "Reverb shop poll complete",
    );

    return {
      observations,
      adaptive: {
        changed,
        secondsUntilListingEnd: null,
        bounds: { minSeconds: adapter.minIntervalSeconds },
        deriveSignals: true,
      },
    };
  }

  // -------------------------------------------------------------------
  // executor
  // -------------------------------------------------------------------

  return async (target, { logger }) => {
    const adapter = await adapterFor(target);
    try {
      const outcome =
        target.targetType === "reverb_listing"
          ? await pollListing(target, adapter, logger)
          : target.targetType === "reverb_shop"
            ? await pollShop(target, adapter, logger)
            : null;
      if (outcome === null) {
        throw new AppConfigurationError(
          `monitor target ${target.id} has unsupported target type "${target.targetType}"`,
        );
      }
      await services.connections.recordConnectionSuccess(adapter.connectionId);
      return outcome;
    } catch (error) {
      if (error instanceof ReverbAdapterError) {
        if (error.kind === "auth") {
          services.invalidateReverbAdapter(adapter.connectionId);
        }
        await services.connections
          .recordConnectionFailure(adapter.connectionId, {
            errorCode: `reverb_${error.kind}`,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  };
}
