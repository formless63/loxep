/**
 * The real Etsy {@link PollExecutor} (loxep-g4t.1) — serves `etsy_listing`
 * and `etsy_shop`, the two m1 observation target types.
 *
 * ## `etsy_listing`
 *
 * ```text
 * resolve the shared adapter (installation-wide, see etsy.ts)
 *   -> mint observationBatchId + observedAt ONCE
 *   -> adapter.getListing(externalItemId)   (public auth)
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
 * Structurally identical to eBay's `pollItem` in `poll-executor.ts` — the
 * batch identity is minted exactly once and reused for every write derived
 * from it, which is what makes an at-least-once replay of this handler a
 * no-op instead of a duplicate.
 *
 * ## `etsy_shop`
 *
 * Unlike eBay's discovery polls (`ebay_search`/`ebay_seller`), Etsy's
 * `/shops/{id}/listings/active` collection endpoint already returns FULL
 * Listing objects, not a thin summary requiring a follow-up per-item read
 * (see `@loxep/integration-etsy/observation.ts`'s module doc) — so there is
 * no "select the stalest N members and fetch each individually" step the
 * way eBay's watchlist/discovery polls need. Every listing on every fetched
 * page is observed directly, inside the SAME batch, up to the target's
 * `maxItems` page-cost bound:
 *
 * ```text
 * resolve the shared adapter
 *   -> mint observationBatchId + observedAt ONCE
 *   -> page adapter.getShopListingsActive(shopId), bounded by maxItems
 *   -> for each fetched listing: map -> snapshotToObservation -> upsert
 *      -> observe (read-previous-then-insert, same ordering as etsy_listing)
 *      -> link to monitor -> derive events -> publish
 *   -> recordConnectionSuccess
 * ```
 *
 * `maxItems` is therefore both the discovery cost knob AND the observation
 * cap in one — there is no separate "observed vs fetched" split the way
 * eBay's search/seller polls need, because fetching IS observing here.
 *
 * ## Failure semantics
 *
 * A provider failure is recorded on the CONNECTION
 * (`recordConnectionFailure`) with the boundary's own error kind, then
 * rethrown, so `market.poll-target` records the poll failure and its
 * backoff — identical to the eBay executor's contract. An `auth`-class
 * failure additionally drops the cached per-connection adapter entry (the
 * shared installation-wide budget/adapter itself is untouched — only the
 * connection's cached OAuth view is invalidated).
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
  EtsyAdapterError,
  mapListingToSnapshot,
  snapshotToObservation,
} from "@loxep/integration-etsy";
import type { EtsyListingSnapshot } from "@loxep/integration-etsy";
import { AppConfigurationError } from "./errors.ts";
import type { EtsyConnectionAdapter } from "./etsy.ts";
import type { ListingContextCache } from "./listing-context.ts";
import type { AppServices } from "./services.ts";

/** `marketplace_item_observations.source` written by each poll kind. */
export const ETSY_LISTING_OBSERVATION_SOURCE = "etsy:listing";
export const ETSY_SHOP_OBSERVATION_SOURCE = "etsy:shop";

/** How far an `etsy_shop` poll pages when its config names no `maxItems`. */
export const ETSY_SHOP_DEFAULT_MAX_ITEMS = 100;
/** Etsy's own courtesy page-size ceiling this executor requests per call. */
const ETSY_SHOP_PAGE_SIZE = 100;
/** Safety bound: no poll pages more than this many times regardless of maxItems. */
const ETSY_SHOP_MAX_PAGES = 20;

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

export interface CreateEtsyPollExecutorOptions {
  services: AppServices;
  /**
   * The explicit detection->delivery bridge, matching
   * `CreateEbayPollExecutorOptions`'s contract exactly.
   */
  enqueueDeliveriesForEvent: (
    addJob: AddJob,
    marketEvent: { id: string; eventType: string; monitorTargetId: string | null },
  ) => Promise<{ endpointIds: string[] }>;
  addJob: AddJob;
  listings?: ListingContextCache;
}

export function createEtsyPollExecutor(
  options: CreateEtsyPollExecutorOptions,
): PollExecutor {
  const { services, enqueueDeliveriesForEvent, addJob, listings } = options;
  const db = services.db;

  async function adapterFor(target: {
    id: string;
    targetType: string;
    connectionId: string | null;
  }): Promise<EtsyConnectionAdapter> {
    if (target.connectionId === null) {
      throw new AppConfigurationError(
        `monitor target ${target.id} (${target.targetType}) has no connection; ` +
          "Etsy polling needs a connection for its shop id",
      );
    }
    return services.getEtsyAdapterForConnection(target.connectionId);
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
    snapshot: EtsyListingSnapshot;
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
  // etsy_listing
  // -------------------------------------------------------------------

  async function pollListing(
    target: { id: string; connectionId: string | null; config: unknown },
    adapter: EtsyConnectionAdapter,
    logger: JobsLogger,
  ): Promise<PollOutcome> {
    const config = monitorTargetConfigSchemas.etsy_listing.parse(target.config ?? {});
    const observationBatchId = randomUUID();
    const observedAt = new Date();

    const raw = await adapter.application.getListing(config.externalItemId);
    const snapshot = mapListingToSnapshot(raw, { fetchedAt: observedAt });

    const result = await observeSnapshot({
      snapshot,
      batch: {
        observationBatchId,
        observedAt,
        source: ETSY_LISTING_OBSERVATION_SOURCE,
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
  // etsy_shop
  // -------------------------------------------------------------------

  async function fetchShopListings(
    adapter: EtsyConnectionAdapter,
    shopId: string,
    maxItems: number,
  ): Promise<{ raw: Array<Record<string, unknown>>; pages: number }> {
    const raw: Array<Record<string, unknown>> = [];
    let offset = 0;
    let pages = 0;
    // Pagination stop condition is Etsy's reported `count` (total matches),
    // not "we got fewer than we asked for" — a server may cap a page below
    // the requested `limit` for reasons of its own (a lower server-side
    // maximum) while still having more results to give on the next page, so
    // relying on a short page as the stop signal would truncate silently.
    while (raw.length < maxItems && pages < ETSY_SHOP_MAX_PAGES) {
      const limit = Math.min(ETSY_SHOP_PAGE_SIZE, maxItems - raw.length);
      const page = await adapter.application.getShopListingsActive({
        shopId,
        limit,
        offset,
      });
      pages += 1;
      if (page.results.length === 0) break;
      raw.push(...page.results);
      offset += page.results.length;
      if (page.count !== null && offset >= page.count) break;
    }
    return { raw: raw.slice(0, maxItems), pages };
  }

  async function pollShop(
    target: { id: string; connectionId: string | null; config: unknown },
    adapter: EtsyConnectionAdapter,
    logger: JobsLogger,
  ): Promise<PollOutcome> {
    const config = monitorTargetConfigSchemas.etsy_shop.parse(target.config ?? {});
    const observationBatchId = randomUUID();
    const observedAt = new Date();
    const maxItems = config.maxItems ?? ETSY_SHOP_DEFAULT_MAX_ITEMS;

    const { raw, pages } = await fetchShopListings(
      adapter,
      config.shopExternalId,
      maxItems,
    );

    let observations = 0;
    let changed = false;
    for (const listing of raw) {
      const snapshot = mapListingToSnapshot(listing, { fetchedAt: observedAt });
      const result = await observeSnapshot({
        snapshot,
        batch: {
          observationBatchId,
          observedAt,
          source: ETSY_SHOP_OBSERVATION_SOURCE,
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
      "Etsy shop poll complete",
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
        target.targetType === "etsy_listing"
          ? await pollListing(target, adapter, logger)
          : target.targetType === "etsy_shop"
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
      if (error instanceof EtsyAdapterError) {
        if (error.kind === "auth") {
          services.invalidateEtsyAdapter(adapter.connectionId);
        }
        await services.connections
          .recordConnectionFailure(adapter.connectionId, {
            errorCode: `etsy_${error.kind}`,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  };
}
