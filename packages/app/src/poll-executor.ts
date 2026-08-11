/**
 * The real eBay {@link PollExecutor} (loxep-62y.2.1 / .2.2) — the Phase 1
 * replacement for `@loxep/market`'s no-I/O stub.
 *
 * ## `ebay_item`
 *
 * ```text
 * resolve adapter by target.connection_id
 *   → mint observationBatchId + observedAt ONCE
 *   → Browse getItem / getItemByLegacyId
 *   → snapshotToObservation
 *   → upsertMarketplaceItem  (canonical identity)
 *   → load PREVIOUS latest observation   ← before the batch insert
 *   → recordObservationBatch  (ON CONFLICT DO NOTHING, retry-safe)
 *   → linkItemToMonitor
 *   → deriveMarketEvents (previous → current)
 *   → evaluateRulesForEvent   (opportunity attribution)
 *   → enqueueDeliveriesForEvent (the explicit detection→delivery bridge)
 *   → recordConnectionSuccess
 * ```
 *
 * The batch identity is minted exactly once, at the moment the provider
 * result is obtained, and reused for every write derived from it — that is
 * the foundation schema's retry identity rule, and it is what makes an
 * at-least-once replay of this handler a no-op instead of a duplicate.
 *
 * ## `ebay_watchlist`
 *
 * ```text
 * resolve adapter (USER token required — Trading GetMyeBayBuying)
 *   → fetchAllWatchlistEntries (bounded by WATCHLIST_MAX_PAGES)
 *   → upsert every entry + linkItemToMonitor  (membership sync)
 *   → deactivate links absent from the fetched membership
 *   → observe the STALEST members, capped at WATCHLIST_MAX_ITEMS_PER_POLL,
 *     all inside the SAME observation batch
 *   → per-item event derivation / rules / deliveries, as above
 * ```
 *
 * Member observation is capped because every snapshot is one rate-budget
 * token: with the documented budget (capacity 10, refill 1.5/s) a full poll
 * costs `1 + 20 = 21` calls and its worst-case in-budget wait is
 * `(21 − 10) / 1.5 ≈ 7 s`, comfortably inside the budget's 30 s per-acquire
 * ceiling. Members are chosen stalest-first (least recently observed), so a
 * watchlist larger than the cap is covered round-robin across polls rather
 * than leaving its tail permanently unobserved.
 *
 * Absence marking deactivates `monitor_items` links only when the membership
 * fetch was COMPLETE (not truncated by the page bound) — a partial view of
 * the watchlist must never be read as "these items are gone".
 *
 * ## Failure semantics
 *
 * A provider failure is recorded on the CONNECTION (`recordConnectionFailure`
 * with the boundary's own error kind) and then rethrown, so
 * `market.poll-target` records the poll failure and its backoff. Poll retry
 * cadence stays owned by `backoff_until`, never by Graphile retries. An
 * `auth`-class failure additionally drops the cached adapter, so the next
 * poll re-reads and re-refreshes the stored credential.
 *
 * ## Adaptive facts
 *
 * Every successful poll reports `changed`, the seconds until the soonest
 * listing end, and `bounds.minSeconds` = the connection's rate-budget
 * interval floor. `deriveSignals: true` lets `recordPollSuccess` fill the
 * recent event/change counts from stored history in ONE extra read
 * (`collectAdaptiveSignals`) rather than making this executor re-query the
 * hypertable itself.
 */
import { randomUUID } from "node:crypto";
import type { LoxepDb } from "@loxep/db";
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
  EbayAdapterError,
  fetchAllWatchlistEntries,
  fetchItemSnapshot,
  fetchItemSnapshotByLegacyId,
  snapshotToObservation,
} from "@loxep/integration-ebay";
import type {
  EbayItemSnapshot,
  EbayWatchlistEntry,
} from "@loxep/integration-ebay";
import { AppConfigurationError } from "./errors.ts";
import type { EbayConnectionAdapter } from "./ebay.ts";
import type { ListingContextCache } from "./listing-context.ts";
import type { AppServices } from "./services.ts";
import { intLiteral, uuidLiteral } from "./sql.ts";

/** `marketplace_item_observations.source` written by each poll kind. */
export const ITEM_OBSERVATION_SOURCE = "ebay:browse";
export const WATCHLIST_OBSERVATION_SOURCE = "ebay:watchlist";

/** Safety bound on watchlist paging (200 entries/page × 5 = 1000 entries). */
export const WATCHLIST_MAX_PAGES = 5;
/** Member snapshots fetched per watchlist poll — see the module doc. */
export const WATCHLIST_MAX_ITEMS_PER_POLL = 20;

/** Trading/watchlist ids are numeric (legacy); Browse ids are `v1|…|0`. */
function isLegacyItemId(externalItemId: string): boolean {
  return /^\d+$/u.test(externalItemId);
}

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
    availability: item.availability ?? null,
    listingState: item.listingState ?? null,
  };
}

/** Seconds until a listing ends, or null when it has none / already ended. */
function secondsUntil(endsAt: Date | null, from: Date): number | null {
  if (endsAt === null) return null;
  const seconds = (endsAt.getTime() - from.getTime()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export interface CreateEbayPollExecutorOptions {
  services: AppServices;
  /**
   * The explicit detection→delivery bridge from
   * `createDeliveryPipeline(...)`. Detection and delivery stay separate
   * concepts: the executor calls this deliberately, event derivation never
   * does.
   */
  enqueueDeliveriesForEvent: (
    addJob: AddJob,
    marketEvent: { id: string; eventType: string; monitorTargetId: string | null },
  ) => Promise<{ endpointIds: string[] }>;
  /** Typed enqueue used for delivery jobs (`@loxep/jobs` standalone addJob). */
  addJob: AddJob;
  /** Listing context handed to the enriched notification renderer. */
  listings?: ListingContextCache;
  /** Member snapshots per watchlist poll (default 20). */
  watchlistItemsPerPoll?: number;
}

export function createEbayPollExecutor(
  options: CreateEbayPollExecutorOptions,
): PollExecutor {
  const { services, enqueueDeliveriesForEvent, addJob, listings } = options;
  const db = services.db;
  const itemsPerPoll =
    options.watchlistItemsPerPoll ?? WATCHLIST_MAX_ITEMS_PER_POLL;

  /** Resolve the connection-bound adapter, or fail the poll with a clear reason. */
  async function adapterFor(target: {
    id: string;
    targetType: string;
    connectionId: string | null;
  }): Promise<EbayConnectionAdapter> {
    if (target.connectionId === null) {
      throw new AppConfigurationError(
        `monitor target ${target.id} (${target.targetType}) has no connection; ` +
          "eBay polling needs a connection for its keyset, rate budget, and token",
      );
    }
    return services.getEbayAdapterForConnection(target.connectionId);
  }

  /**
   * Bridge one newly derived event into opportunity attribution and
   * deliveries. Never throws into the poll: a notification problem must not
   * roll back a recorded observation or trip the connection's error state.
   */
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
    // Listing context for the enriched renderer (see listing-context.ts).
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

  /**
   * Record one item's observation inside an already-minted batch and publish
   * whatever it implies. Returns the facts the adaptive policy needs.
   */
  async function observeSnapshot(input: {
    snapshot: EbayItemSnapshot;
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

    // "Changed" drives adaptive tightening/relaxation: a replayed batch
    // inserts nothing and is not a change; a first observation is.
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
        current: snapshotFromObservationItem(
          mapped.observation,
          batch.observedAt,
        ),
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
  // ebay_item
  // -------------------------------------------------------------------

  async function pollItem(
    target: { id: string; connectionId: string | null; targetType: string; config: unknown },
    adapter: EbayConnectionAdapter,
    logger: JobsLogger,
  ): Promise<PollOutcome> {
    const config = monitorTargetConfigSchemas.ebay_item.parse(
      target.config ?? {},
    );
    const observationBatchId = randomUUID();
    const observedAt = new Date();

    // Browse authorizes with the APPLICATION token; see `ebay.ts`.
    const browse = adapter.application;
    const snapshot = isLegacyItemId(config.externalItemId)
      ? await fetchItemSnapshotByLegacyId(browse, {
          legacyItemId: config.externalItemId,
        })
      : await fetchItemSnapshot(browse, { itemId: config.externalItemId });

    const result = await observeSnapshot({
      snapshot,
      batch: { observationBatchId, observedAt, source: ITEM_OBSERVATION_SOURCE },
      connectionId: adapter.connectionId,
      monitorTargetId: target.id,
      logger,
    });

    return {
      observations: result.inserted,
      adaptive: {
        changed: result.changed,
        secondsUntilListingEnd: secondsUntil(snapshot.listingEndsAt, observedAt),
        bounds: { minSeconds: adapter.minIntervalSeconds },
        deriveSignals: true,
      },
    };
  }

  // -------------------------------------------------------------------
  // ebay_watchlist
  // -------------------------------------------------------------------

  /** Membership sync: canonical identity + discovery link for every entry. */
  async function syncMembership(
    entries: readonly EbayWatchlistEntry[],
    context: {
      monitorTargetId: string;
      marketplace: string;
      observedAt: Date;
    },
  ): Promise<MarketplaceItemRecord[]> {
    const items: MarketplaceItemRecord[] = [];
    for (const entry of entries) {
      const item = await upsertMarketplaceItem({
        db,
        item: {
          provider: "ebay",
          marketplace: context.marketplace,
          externalItemId: entry.externalItemId,
          seenAt: context.observedAt,
          currentState: "active",
          ...(entry.title !== null ? { title: entry.title } : {}),
          ...(entry.canonicalUrl !== null
            ? { canonicalUrl: entry.canonicalUrl }
            : {}),
          ...(entry.sellerExternalId !== null
            ? { sellerExternalId: entry.sellerExternalId }
            : {}),
          ...(entry.listingEndsAt !== null
            ? { listingEndsAt: entry.listingEndsAt }
            : {}),
        },
      });
      await linkItemToMonitor(db, {
        monitorTargetId: context.monitorTargetId,
        marketplaceItemId: item.id,
        at: context.observedAt,
      });
      items.push(item);
    }
    return items;
  }

  /**
   * Deactivate `monitor_items` links whose item is no longer in the fetched
   * membership.
   *
   * NOTE (documented gap): @loxep/market exposes `linkItemToMonitor` but no
   * absence-marking counterpart, and that package is not this one's to
   * change. This is the minimal safe equivalent — one idempotent set-based
   * UPDATE using the same escaped-literal discipline as `@loxep/market`'s own
   * raw statements — and it should move into @loxep/market as
   * `deactivateAbsentMonitorItems` (filed separately).
   */
  async function deactivateAbsentLinks(
    monitorTargetId: string,
    presentItemIds: readonly string[],
  ): Promise<number> {
    const present =
      presentItemIds.length === 0
        ? "array[]::uuid[]"
        : `array[${presentItemIds.map(uuidLiteral).join(", ")}]::uuid[]`;
    const result = await db.execute(
      `update monitor_items
          set active = false
        where monitor_target_id = ${uuidLiteral(monitorTargetId)}
          and active = true
          and marketplace_item_id <> all (${present})
        returning marketplace_item_id`,
    );
    return result.rows.length;
  }

  /**
   * The members to snapshot this poll: stalest first (never observed wins),
   * capped so one poll cannot drain the connection's rate budget.
   */
  async function selectStaleMembers(
    monitorTargetId: string,
    candidateIds: readonly string[],
    limit: number,
  ): Promise<string[]> {
    if (candidateIds.length === 0 || limit < 1) return [];
    const candidates = `array[${candidateIds.map(uuidLiteral).join(", ")}]::uuid[]`;
    const result = await db.execute(
      `select mi.marketplace_item_id::text as id
         from monitor_items mi
         left join marketplace_item_observations o
           on o.marketplace_item_id = mi.marketplace_item_id
        where mi.monitor_target_id = ${uuidLiteral(monitorTargetId)}
          and mi.active = true
          and mi.marketplace_item_id = any (${candidates})
        group by mi.marketplace_item_id
        order by max(o.observed_at) asc nulls first, mi.marketplace_item_id asc
        limit ${intLiteral(limit)}`,
    );
    return result.rows.map((row) => String(row["id"]));
  }

  async function pollWatchlist(
    target: { id: string; connectionId: string | null; config: unknown },
    adapter: EbayConnectionAdapter,
    logger: JobsLogger,
  ): Promise<PollOutcome> {
    const user = adapter.requireUser();
    const observationBatchId = randomUUID();
    const observedAt = new Date();

    const { entries, pages, truncated } = await fetchAllWatchlistEntries(user, {
      maxPages: WATCHLIST_MAX_PAGES,
    });
    const items = await syncMembership(entries, {
      monitorTargetId: target.id,
      marketplace: adapter.marketplaceId,
      observedAt,
    });
    const presentIds = items.map((item) => item.id);

    let deactivated = 0;
    if (truncated) {
      logger.warn(
        { monitorTargetId: target.id, pages },
        "watchlist membership truncated by the page bound; skipping absence marking",
      );
    } else {
      deactivated = await deactivateAbsentLinks(target.id, presentIds);
    }

    const toObserve = await selectStaleMembers(
      target.id,
      presentIds,
      itemsPerPoll,
    );
    const byId = new Map(items.map((item) => [item.id, item]));

    let observations = 0;
    let changed = false;
    let soonestEnd: number | null = null;
    for (const marketplaceItemId of toObserve) {
      const item = byId.get(marketplaceItemId);
      if (item === undefined) continue;
      // Watchlist ids are legacy Trading ids; Browse bridges them.
      const snapshot = await fetchItemSnapshotByLegacyId(adapter.application, {
        legacyItemId: item.externalItemId,
      });
      const result = await observeSnapshot({
        snapshot,
        batch: {
          observationBatchId,
          observedAt,
          source: WATCHLIST_OBSERVATION_SOURCE,
        },
        connectionId: adapter.connectionId,
        monitorTargetId: target.id,
        logger,
      });
      observations += result.inserted;
      changed ||= result.changed;
      const endsIn = secondsUntil(snapshot.listingEndsAt, observedAt);
      if (endsIn !== null && (soonestEnd === null || endsIn < soonestEnd)) {
        soonestEnd = endsIn;
      }
    }

    logger.info(
      {
        monitorTargetId: target.id,
        members: entries.length,
        observed: toObserve.length,
        deactivated,
        pages,
      },
      "watchlist poll complete",
    );

    return {
      observations,
      adaptive: {
        // Membership churn is activity even when no member was re-observed.
        changed: changed || deactivated > 0,
        secondsUntilListingEnd: soonestEnd,
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
        target.targetType === "ebay_watchlist"
          ? await pollWatchlist(target, adapter, logger)
          : target.targetType === "ebay_item"
            ? await pollItem(target, adapter, logger)
            : null;
      if (outcome === null) {
        throw new AppConfigurationError(
          `monitor target ${target.id} has unsupported target type "${target.targetType}"`,
        );
      }
      await services.connections.recordConnectionSuccess(adapter.connectionId);
      return outcome;
    } catch (error) {
      if (error instanceof EbayAdapterError) {
        if (error.kind === "auth") {
          // Force a credential re-read + refresh on the next poll.
          services.invalidateEbayAdapter(adapter.connectionId);
        }
        await services.connections
          .recordConnectionFailure(adapter.connectionId, {
            errorCode: `ebay_${error.kind}`,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  };
}
