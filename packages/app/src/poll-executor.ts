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
 *   → observe the STALEST members, capped by the `monitors.observation_caps`
 *     setting, all inside the SAME observation batch
 *   → per-item event derivation / rules / deliveries, as above
 * ```
 *
 * Member observation is capped because every snapshot is one rate-budget
 * token: with the documented budget (capacity 10, refill 1.5/s) and the
 * default cap of 20, a full poll costs `1 + 20 = 21` calls and its worst-case
 * in-budget wait is `(21 − 10) / 1.5 ≈ 7 s`, comfortably inside the budget's
 * 30 s per-acquire ceiling — which is why raising
 * `monitors.observation_caps.watchlistItemsPerPoll` is a real cost decision.
 * Members are chosen stalest-first (least recently observed), so a watchlist
 * larger than the cap is covered round-robin across polls rather than leaving
 * its tail permanently unobserved.
 *
 * Absence marking deactivates `monitor_items` links only when the membership
 * fetch was COMPLETE (not truncated by the page bound) — a partial view of
 * the watchlist must never be read as "these items are gone".
 *
 * ## `ebay_search` / `ebay_seller` (the discovery pair)
 *
 * ```text
 * resolve adapter (APPLICATION token — Browse search needs no user context)
 *   → mint observationBatchId + observedAt ONCE
 *   → searchAllListings / fetchAllSellerListings, bounded by config.maxItems
 *   → inspect page warnings   ← BEFORE anything is written
 *   → knownExternalItemIds + diffDiscoveredItems   ← BEFORE the upsert
 *   → upsert + linkItemToMonitor for every fetched summary
 *   → observe the STALEST linked items, capped, inside the SAME batch
 *   → deriveNewListingEvents(newItems)   ← AFTER linking
 *   → rules / deliveries for every derived event
 * ```
 *
 * Two orderings in that pipeline are LOAD-BEARING and neither is obvious:
 *
 * 1. **Diff before upsert.** `knownExternalItemIds` answers "which of these
 *    did Loxep already have a canonical identity for". After the upsert the
 *    answer is "all of them", so a diff taken later would report no
 *    discoveries at all and `new_listing` would never fire.
 * 2. **Derive after linking.** `deriveNewListingEvents` keys on
 *    `monitor_items.first_discovered_at` and fires only when THIS monitor's
 *    link is the global first, so the link must exist before the derivation
 *    runs. That predicate — plus the deduplication key built from the global
 *    minimum — is what makes a re-poll, an at-least-once retry, and two
 *    overlapping monitors all collapse to exactly one event.
 *
 * Discovery observations come from the SUMMARIES the search already fetched,
 * not from extra `getItem` calls: a summary carries price and seller facts
 * but no quantity or availability, and those stay NULL rather than 0 (see
 * `listing-summary.ts`). The observation count per poll is still capped
 * stalest-first — a 200-item search should not write 200 hypertable rows a
 * minute — so a large search is covered round-robin, exactly like a large
 * watchlist. A listing missing from a page is NEVER read as ended: Browse
 * only returns currently purchasable listings, so absence is not evidence.
 *
 * ### Warnings are refusals, not colour
 *
 * eBay answers a bad filter with HTTP 200 and a warning, having silently
 * IGNORED it. `errorId 12002` therefore means the page is not the page the
 * monitor asked for — an unfiltered result set masquerading as a filtered
 * one — and this executor treats it as a monitor CONFIGURATION error: the
 * poll fails before a single row is written, and the connection is left
 * healthy because nothing is wrong with the connection. `12008` (ignored
 * sort) is logged but tolerated: the result set is still the right one, only
 * ordered differently. `12003` (unknown seller) never reaches here —
 * `fetchSellerListings` refuses that page inside the integration boundary,
 * because eBay drops the seller filter and returns the anchor's ENTIRE result
 * set, which would attribute a whole category to one seller.
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
 * A discovery poll is the one place that error taxonomy needs a twist: an
 * `invalid_request` rejection there is caused by the monitor's own config (an
 * unknown seller username, a filter value the encoder rejects, a cursor past
 * the paging bound), not by the connection. Marking every monitor on the
 * connection unhealthy for one mistyped seller would be misleading, so the
 * discovery branch re-raises `invalid_request` as an
 * {@link AppConfigurationError}: still a poll failure with backoff, still the
 * provider's own message, but the connection stays `active`.
 *
 * ## Settings
 *
 * The observation caps come from the registered `monitors.observation_caps`
 * setting, read per poll through `services.monitorSettings` (briefly cached).
 * An explicit constructor option still wins, so a caller that names a cap
 * means it. The rate-budget floor arrives on the adapter itself, already
 * derived from `integration.ebay.rate_budget`.
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
  deactivateAbsentMonitorItems,
  deriveMarketEvents,
  deriveNewListingEvents,
  diffDiscoveredItems,
  evaluateRulesForEvent,
  knownExternalItemIds,
  latestObservations,
  linkItemToMonitor,
  monitorTargetConfigSchemas,
  recordObservationBatch,
  upsertMarketplaceItem,
} from "@loxep/market";
import type {
  MarketEventRow,
  MarketplaceItemRecord,
  NewlyLinkedItem,
  ObservationItemInput,
  ObservationRow,
  ObservationSnapshot,
  PollExecutor,
  PollOutcome,
} from "@loxep/market";
import {
  EbayAdapterError,
  fetchAllSellerListings,
  fetchAllWatchlistEntries,
  fetchItemSnapshot,
  fetchItemSnapshotByLegacyId,
  searchAllListings,
  snapshotToObservation,
} from "@loxep/integration-ebay";
import type {
  EbayItemSnapshot,
  EbayListingSummary,
  EbaySearchWarning,
  EbayWatchlistEntry,
} from "@loxep/integration-ebay";
import { isConnectionArchived } from "@loxep/domain";
import { AppConfigurationError } from "./errors.ts";
import type { EbayConnectionAdapter } from "./ebay.ts";
import type { ListingContextCache } from "./listing-context.ts";
import {
  SEARCH_OBSERVATION_SOURCE,
  SELLER_OBSERVATION_SOURCE,
  summaryToObservation,
} from "./listing-summary.ts";
import type { AppServices } from "./services.ts";
import { intLiteral, uuidLiteral } from "./sql.ts";

/**
 * Route one claimed target to the executor that owns its target type.
 *
 * `market.poll-target` takes exactly ONE {@link PollExecutor}, and Phase 3
 * added a target type this file does not serve: `woo_orders` belongs to
 * Commerce (see `commerce.ts`). Rather than teach the eBay executor about a
 * domain it has no business knowing, the composition root builds one executor
 * per registering domain and joins them here.
 *
 * That is the mechanical form of Domain Boundaries' rule that a target type's
 * executor belongs to its registering domain and is wired in the composition
 * root. A target type with no route falls through to `fallback` — the eBay
 * executor, which already raises {@link AppConfigurationError} for anything
 * it does not recognize, so an unregistered type still fails the poll with a
 * clear message and a backoff rather than silently succeeding.
 */
export function createRoutedPollExecutor(options: {
  routes: Readonly<Record<string, PollExecutor>>;
  fallback: PollExecutor;
}): PollExecutor {
  const { routes, fallback } = options;
  return (target, context) =>
    (routes[target.targetType] ?? fallback)(target, context);
}

/**
 * Wrap a poll executor so a target bound to an ARCHIVED connection never
 * reaches a provider (loxep-o7h).
 *
 * Archiving is the answer for a connection whose data must survive — orders,
 * observations, provenance all keep resolving — so its `monitor_targets` rows
 * survive too, and the dispatcher's claim (`enabled = true and next_poll_at
 * <= now`) knows nothing about connection status. This gate is where that
 * status becomes a polling decision, and it sits ABOVE the routed executor so
 * every target type — eBay item/watchlist/discovery, `woo_orders`,
 * `ebay_orders` — inherits it rather than each executor re-checking.
 *
 * A gated poll reports zero observations instead of throwing: an archived
 * connection is a deliberate operator state, not a failure, and failing the
 * poll would burn `consecutive_errors`/`backoff_until` and make a healthy
 * decision look like an outage. `disabled` deliberately does NOT gate here —
 * that flag keeps the meaning it already has elsewhere (token refresh skips
 * it; polling always has); only `archived` is terminal.
 */
export function createArchivedConnectionGate(options: {
  services: Pick<AppServices, "connections">;
  executor: PollExecutor;
}): PollExecutor {
  const { services, executor } = options;
  return async (target, context) => {
    if (target.connectionId !== null) {
      const connection = await services.connections.getConnection(
        target.connectionId,
      );
      if (isConnectionArchived(connection.status)) {
        context.logger.info(
          {
            monitorTargetId: target.id,
            connectionId: target.connectionId,
            targetType: target.targetType,
          },
          "poll skipped: connection archived",
        );
        return { observations: 0 };
      }
    }
    return executor(target, context);
  };
}

/** `marketplace_item_observations.source` written by each poll kind. */
export const ITEM_OBSERVATION_SOURCE = "ebay:browse";
export const WATCHLIST_OBSERVATION_SOURCE = "ebay:watchlist";

/** Safety bound on watchlist paging (200 entries/page × 5 = 1000 entries). */
export const WATCHLIST_MAX_PAGES = 5;
/**
 * How far one discovery poll pages when the target's config names no
 * `maxItems`. Each page spends a rate-budget token, so this is the cost
 * ceiling a monitor inherits by saying nothing.
 */
export const DISCOVERY_DEFAULT_MAX_ITEMS = 200;
/** Browse sort that keeps the freshest listings on page one. */
const DISCOVERY_SORT = "newlyListed" as const;

/** eBay warning ids that matter to a monitor (see the module doc). */
export const IGNORED_FILTER_WARNING_ID = 12002;
export const IGNORED_SORT_WARNING_ID = 12008;

/** The two discovery target types this executor serves. */
const DISCOVERY_TARGET_TYPES = ["ebay_search", "ebay_seller"] as const;
type DiscoveryTargetType = (typeof DISCOVERY_TARGET_TYPES)[number];

function isDiscoveryTargetType(value: string): value is DiscoveryTargetType {
  return (DISCOVERY_TARGET_TYPES as readonly string[]).includes(value);
}

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
  /**
   * Member snapshots per watchlist poll. Omitted → the registered
   * `monitors.observation_caps` setting (default 20).
   */
  watchlistItemsPerPoll?: number;
  /**
   * Summaries observed per discovery poll. Omitted → the registered
   * `monitors.observation_caps` setting (default 50).
   */
  searchItemsPerPoll?: number;
  /**
   * Provider seam for the two discovery calls, mirroring `ebay.ts`'s
   * `createAdapter` seam. Defaults to the integration boundary's own
   * `searchAllListings`/`fetchAllSellerListings`.
   *
   * It exists because those functions reach the provider client through the
   * boundary-internal `adapterInternals()` handle, which is deliberately not
   * part of `@loxep/integration-ebay`'s public surface — a fake adapter
   * therefore cannot be given one. Injecting the two functions lets a test
   * drive the executor with canned pages (including warning-bearing ones)
   * while everything else in the pipeline stays real.
   */
  discovery?: {
    searchAllListings?: typeof searchAllListings;
    fetchAllSellerListings?: typeof fetchAllSellerListings;
  };
}

export function createEbayPollExecutor(
  options: CreateEbayPollExecutorOptions,
): PollExecutor {
  const { services, enqueueDeliveriesForEvent, addJob, listings } = options;
  const db = services.db;
  const searchAll = options.discovery?.searchAllListings ?? searchAllListings;
  const sellerAll =
    options.discovery?.fetchAllSellerListings ?? fetchAllSellerListings;

  /**
   * Per-poll observation caps: an explicit constructor option wins, otherwise
   * the registered setting (read through the briefly-cached reader, so an
   * operator's change lands on the next poll rather than the next restart).
   */
  async function observationCaps(): Promise<{
    watchlistItemsPerPoll: number;
    searchItemsPerPoll: number;
  }> {
    if (
      options.watchlistItemsPerPoll !== undefined &&
      options.searchItemsPerPoll !== undefined
    ) {
      return {
        watchlistItemsPerPoll: options.watchlistItemsPerPoll,
        searchItemsPerPoll: options.searchItemsPerPoll,
      };
    }
    const settings = await services.monitorSettings.read();
    return {
      watchlistItemsPerPoll:
        options.watchlistItemsPerPoll ?? settings.watchlistItemsPerPoll,
      searchItemsPerPoll:
        options.searchItemsPerPoll ?? settings.searchItemsPerPoll,
    };
  }

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
      const result = await deactivateAbsentMonitorItems(db, {
        monitorTargetId: target.id,
        presentMarketplaceItemIds: presentIds,
        at: observedAt,
      });
      deactivated = result.deactivated;
    }

    const { watchlistItemsPerPoll } = await observationCaps();
    const toObserve = await selectStaleMembers(
      target.id,
      presentIds,
      watchlistItemsPerPoll,
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
  // ebay_search / ebay_seller
  // -------------------------------------------------------------------

  /**
   * Turn eBay's non-fatal complaints into a decision. An ignored FILTER means
   * the returned page is not the page the monitor asked for, so it is refused
   * before anything is written; an ignored SORT only reorders the right
   * results, so it is logged.
   */
  function inspectWarnings(
    warnings: readonly EbaySearchWarning[],
    context: { monitorTargetId: string; targetType: string; logger: JobsLogger },
  ): void {
    if (warnings.length === 0) return;
    const ignoredSort = warnings.filter(
      (warning) => warning.errorId === IGNORED_SORT_WARNING_ID,
    );
    if (ignoredSort.length > 0) {
      context.logger.warn(
        {
          monitorTargetId: context.monitorTargetId,
          errorId: IGNORED_SORT_WARNING_ID,
        },
        "eBay ignored the requested sort; newest listings may not be on page one",
      );
    }
    const ignoredFilter = warnings.filter(
      (warning) => warning.errorId === IGNORED_FILTER_WARNING_ID,
    );
    if (ignoredFilter.length > 0) {
      // The provider's own message is the actionable part; it names the
      // offending filter and contains no credential material.
      throw new AppConfigurationError(
        `monitor target ${context.monitorTargetId} (${context.targetType}): ` +
          `eBay IGNORED a search filter (errorId ${IGNORED_FILTER_WARNING_ID}) and ` +
          "returned unfiltered results, which must not be ingested as discovery " +
          `data — fix the monitor's filters. Provider detail: ${
            ignoredFilter
              .map((warning) => warning.message ?? "(no message)")
              .join("; ")
          }`,
      );
    }
    const other = warnings.filter(
      (warning) =>
        warning.errorId !== IGNORED_FILTER_WARNING_ID &&
        warning.errorId !== IGNORED_SORT_WARNING_ID,
    );
    if (other.length > 0) {
      context.logger.info(
        {
          monitorTargetId: context.monitorTargetId,
          warnings: other.map((warning) => warning.errorId),
        },
        "eBay returned search warnings",
      );
    }
  }

  /**
   * Which external ids Loxep already has canonical identities for. Grouped by
   * the marketplace each SUMMARY reports (eBay echoes
   * `listingMarketplaceId`), so a cross-marketplace result can never be
   * checked against the wrong marketplace's items and mis-diffed.
   */
  async function knownIdsForSummaries(
    summaries: readonly EbayListingSummary[],
  ): Promise<Set<string>> {
    const byMarketplace = new Map<string, string[]>();
    for (const summary of summaries) {
      const ids = byMarketplace.get(summary.marketplace);
      if (ids === undefined) {
        byMarketplace.set(summary.marketplace, [summary.externalItemId]);
      } else {
        ids.push(summary.externalItemId);
      }
    }
    const known = new Set<string>();
    for (const [marketplace, externalItemIds] of byMarketplace) {
      const found = await knownExternalItemIds(db, {
        provider: "ebay",
        marketplace,
        externalItemIds,
      });
      for (const id of found) known.add(id);
    }
    return known;
  }

  /**
   * Record ONE summary's observation inside the poll's batch and publish the
   * comparison events it implies. The summary-shaped sibling of
   * {@link observeSnapshot}; the item row already exists (the caller upserted
   * and linked the whole page first), so this only observes.
   */
  async function observeSummary(input: {
    summary: EbayListingSummary;
    item: MarketplaceItemRecord;
    batch: { observationBatchId: string; observedAt: Date; source: string };
    connectionId: string;
    monitorTargetId: string;
    logger: JobsLogger;
  }): Promise<{ inserted: number; changed: boolean }> {
    const { summary, item, batch, connectionId, monitorTargetId, logger } =
      input;
    const mapped = summaryToObservation(summary, {
      observedAt: batch.observedAt,
    });

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
    return { inserted, changed };
  }

  /** The provider fetch for one discovery kind, bounded by `maxItems`. */
  async function fetchDiscovery(
    targetType: DiscoveryTargetType,
    config: Record<string, unknown>,
    adapter: EbayConnectionAdapter,
    context: { monitorTargetId: string; logger: JobsLogger },
  ): Promise<{
    summaries: EbayListingSummary[];
    pages: number;
    total: number | null;
    warnings: EbaySearchWarning[];
  }> {
    const maxItems =
      (config["maxItems"] as number | undefined) ?? DISCOVERY_DEFAULT_MAX_ITEMS;
    // `config.filters.listedAfter` is an ISO STRING in jsonb; the encoder
    // accepts Date | string, so it travels unchanged.
    const filters = config["filters"] as
      | Parameters<typeof searchAllListings>[1]["filters"]
      | undefined;
    const query = config["query"] as string | undefined;
    const categoryId = config["categoryId"] as string | undefined;

    // Refuse a page the provider did not really filter, per page, so a bad
    // filter costs one call rather than `maxItems` worth of budget.
    const onPage = (page: { warnings: EbaySearchWarning[] }): void => {
      inspectWarnings(page.warnings, { ...context, targetType });
    };

    if (targetType === "ebay_seller") {
      // NOTE: `fetchAllSellerListings` owns its own per-page hook (it refuses
      // a dropped seller filter there), so this kind's warnings are inspected
      // once the paging returns — still BEFORE any write.
      return sellerAll(adapter.application, {
        sellerUsername: config["sellerUsername"] as string,
        ...(query !== undefined ? { query } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(filters !== undefined ? { filters } : {}),
        maxItems,
      });
    }
    return searchAll(adapter.application, {
      ...(query !== undefined ? { query } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(filters !== undefined ? { filters } : {}),
      sort: DISCOVERY_SORT,
      maxItems,
      onPage,
    });
  }

  async function pollDiscovery(
    target: { id: string; targetType: string; config: unknown },
    targetType: DiscoveryTargetType,
    adapter: EbayConnectionAdapter,
    logger: JobsLogger,
  ): Promise<PollOutcome> {
    const config = monitorTargetConfigSchemas[targetType].parse(
      target.config ?? {},
    ) as Record<string, unknown>;
    const observationBatchId = randomUUID();
    const observedAt = new Date();
    const source =
      targetType === "ebay_seller"
        ? SELLER_OBSERVATION_SOURCE
        : SEARCH_OBSERVATION_SOURCE;

    const fetched = await fetchDiscovery(targetType, config, adapter, {
      monitorTargetId: target.id,
      logger,
    });
    // Belt and braces for the seller path, whose paging helper owns `onPage`.
    inspectWarnings(fetched.warnings, {
      monitorTargetId: target.id,
      targetType,
      logger,
    });
    const summaries = fetched.summaries;

    // --- ORDERING (1): diff BEFORE the upsert --------------------------
    const known = await knownIdsForSummaries(summaries);
    const { newItems } = diffDiscoveredItems({
      knownExternalIds: known,
      fetchedSummaries: summaries,
    });

    // --- canonical identity + discovery link for EVERY summary ---------
    const itemByExternalId = new Map<string, MarketplaceItemRecord>();
    const summaryByExternalId = new Map<string, EbayListingSummary>();
    for (const summary of summaries) {
      if (itemByExternalId.has(summary.externalItemId)) continue;
      const mapped = summaryToObservation(summary, { observedAt });
      const item = await upsertMarketplaceItem({ db, item: mapped.item });
      await linkItemToMonitor(db, {
        monitorTargetId: target.id,
        marketplaceItemId: item.id,
        at: observedAt,
      });
      itemByExternalId.set(summary.externalItemId, item);
      summaryByExternalId.set(summary.externalItemId, summary);
    }

    // --- observations, stalest-first and capped ------------------------
    const { searchItemsPerPoll } = await observationCaps();
    const presentIds = [...itemByExternalId.values()].map((item) => item.id);
    const toObserve = await selectStaleMembers(
      target.id,
      presentIds,
      searchItemsPerPoll,
    );
    const summaryByItemId = new Map(
      [...itemByExternalId.entries()].map(([externalItemId, item]) => [
        item.id,
        summaryByExternalId.get(externalItemId) as EbayListingSummary,
      ]),
    );
    const itemById = new Map(
      [...itemByExternalId.values()].map((item) => [item.id, item]),
    );

    let observations = 0;
    let changed = false;
    let soonestEnd: number | null = null;
    for (const marketplaceItemId of toObserve) {
      const summary = summaryByItemId.get(marketplaceItemId);
      const item = itemById.get(marketplaceItemId);
      if (summary === undefined || item === undefined) continue;
      const result = await observeSummary({
        summary,
        item,
        batch: { observationBatchId, observedAt, source },
        connectionId: adapter.connectionId,
        monitorTargetId: target.id,
        logger,
      });
      observations += result.inserted;
      changed ||= result.changed;
      const endsIn = secondsUntil(summary.listingEndsAt, observedAt);
      if (endsIn !== null && (soonestEnd === null || endsIn < soonestEnd)) {
        soonestEnd = endsIn;
      }
    }

    // --- ORDERING (2): derive new_listing AFTER linking ----------------
    const newlyLinked: NewlyLinkedItem[] = [];
    for (const summary of newItems) {
      const item = itemByExternalId.get(summary.externalItemId);
      if (item === undefined) continue;
      newlyLinked.push({
        marketplaceItemId: item.id,
        externalItemId: summary.externalItemId,
        title: summary.title,
        price: summary.price,
        currency: summary.currency,
        canonicalUrl: summary.canonicalUrl,
        sellerExternalId: summary.sellerExternalId,
        listingEndsAt: summary.listingEndsAt,
      });
    }
    const discovery = await deriveNewListingEvents(db, {
      monitorTargetId: target.id,
      newlyLinkedItems: newlyLinked,
      detectedAt: observedAt,
    });
    for (const event of discovery.inserted) {
      const item = itemById.get(event.marketplaceItemId);
      if (item === undefined) continue;
      await publishEvent(event, item, logger);
    }

    logger.info(
      {
        monitorTargetId: target.id,
        targetType,
        fetched: summaries.length,
        pages: fetched.pages,
        total: fetched.total,
        discovered: newItems.length,
        newListingEvents: discovery.inserted.length,
        rediscovered: discovery.rediscovered.length,
        observed: toObserve.length,
      },
      "discovery poll complete",
    );

    return {
      observations,
      adaptive: {
        // A discovery is activity even when no observation state moved.
        changed: changed || newItems.length > 0 || discovery.inserted.length > 0,
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
    const discoveryType = isDiscoveryTargetType(target.targetType)
      ? target.targetType
      : null;
    try {
      const outcome =
        discoveryType !== null
          ? await pollDiscovery(target, discoveryType, adapter, logger)
          : target.targetType === "ebay_watchlist"
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
        // A discovery poll's `invalid_request` is the MONITOR's fault (an
        // unknown seller username, a rejected filter value), not the
        // connection's — see the module doc. Fail the poll, leave the
        // connection healthy for every other target that shares it.
        if (discoveryType !== null && error.kind === "invalid_request") {
          throw new AppConfigurationError(
            `monitor target ${target.id} (${discoveryType}) was refused by eBay: ${error.message}`,
            { cause: error },
          );
        }
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
