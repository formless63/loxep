/**
 * Discovery diff and `new_listing` derivation (loxep-7dp.1/.2).
 *
 * A search or seller poll returns a PAGE of provider listing summaries. Two
 * questions follow: which of them has Loxep never seen, and which of those
 * deserve a user-visible "new listing" event. This module answers the first
 * purely ({@link diffDiscoveredItems}) and the second against the database
 * ({@link deriveNewListingEvents}), and deliberately owns neither the
 * provider call nor the `marketplace_items`/`monitor_items` writes — those
 * stay in the integration package and `observations.ts` respectively.
 *
 * ## `new_listing` semantics: first GLOBAL discovery wins
 *
 * `monitor_items` is many-to-many, so one public listing can be discovered by
 * several monitors: a "vintage Nikon" search rule, a seller monitor for the
 * shop that listed it, and a watchlist that already contained it. The
 * question is what "new" means when the second monitor arrives.
 *
 * Two candidate semantics:
 *
 * 1. **per-monitor**: every monitor that links an item for the first time
 *    emits its own `new_listing`;
 * 2. **first global discovery**: exactly one `new_listing` per marketplace
 *    item, ever, attributed to whichever monitor got there first.
 *
 * Loxep implements (2). The reasons:
 *
 * - `market_events` are facts about the ITEM, not about the monitor —
 *   `marketplace_item_id` is the NOT NULL column and `monitor_target_id` is
 *   the nullable provenance one. "This listing appeared" is true once; "my
 *   search also matched it" is a link, not an event, and `monitor_items`
 *   already records it with its own `first_discovered_at`.
 * - Under (1) an item matched by five overlapping search rules produces five
 *   notifications for one listing — precisely the duplicate-alert problem the
 *   deduplication convention exists to prevent.
 * - Under (1) the `<item>:<type>:<timestamp>` deduplication key has to carry
 *   the monitor id to stay unique, breaking the documented convention that a
 *   key is `<marketplace_item_id>:<event_type>:<ISO instant>`.
 * - Downstream metrics (`itemActivitySummary`, restock/sellout pairing)
 *   count events per item; per-monitor duplicates would inflate them and, via
 *   `collectAdaptiveSignals`, make cadence react to Loxep's own configuration
 *   rather than to the market.
 *
 * The cost is that a monitor's *own* first sighting of a pre-existing item is
 * not an event. That is the right trade: it is not news that a listing
 * exists, only that it appeared. The link itself is still recorded, and
 * `monitor_items.first_discovered_at` answers "when did THIS monitor first
 * match it" exactly.
 *
 * ### How it is enforced (two independent mechanisms)
 *
 * - **Predicate.** An event is inserted only when this monitor's
 *   `monitor_items.first_discovered_at` equals `min(first_discovered_at)`
 *   across ALL monitors for that item — i.e. this discovery *is* the global
 *   first. A monitor arriving later fails the predicate and emits nothing,
 *   and so does a search monitor that re-finds an item a watchlist had
 *   already introduced.
 * - **Deduplication key.** The key is
 *   `<marketplace_item_id>:new_listing:<global first_discovered_at ISO>` —
 *   derived from the GLOBAL minimum, not from the calling monitor's link — so
 *   even a race between two monitors linking in the same instant collapses to
 *   one row through `market_events.deduplication_key`'s UNIQUE constraint.
 *   Re-running a poll after an at-least-once retry recomputes the identical
 *   key and inserts nothing.
 *
 * Attribution lives where provenance belongs: `market_events.monitor_target_id`
 * carries the discovering monitor, and the payload repeats it alongside the
 * listing facts that make the event readable on its own.
 *
 * `from_observed_at` is NULL: there is no earlier observation. `to_observed_at`
 * is the first-discovery instant, so the event sorts into the item's timeline
 * at the moment the listing entered Loxep.
 */
import { marketEvents } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { MarketValidationError } from "./errors.ts";
import { NEW_LISTING_EVENT_TYPE, type MarketEventRow } from "./events.ts";
import { jsonbLiteral, textLiteral, timestamptzLiteral, uuidLiteral } from "./sql.ts";

/** The minimum a fetched provider summary must carry to be diffable. */
export interface DiscoveredSummary {
  externalItemId: string;
}

export interface DiffDiscoveredItemsInput<T extends DiscoveredSummary> {
  /** External ids Loxep already has canonical `marketplace_items` rows for. */
  knownExternalIds: Iterable<string>;
  /** The summaries this poll fetched, in provider order. */
  fetchedSummaries: readonly T[];
}

export interface DiffDiscoveredItemsResult<T extends DiscoveredSummary> {
  /** Summaries whose external id was not previously known, in fetch order. */
  newItems: T[];
  /** Summaries Loxep already knew (including intra-page repeats). */
  seenItems: T[];
}

/**
 * Pure discovery diff: split a fetched page into never-before-seen and
 * already-known summaries. No I/O, no ordering assumptions beyond preserving
 * the provider's order.
 *
 * A repeated external id WITHIN one page counts as new only the first time —
 * paging overlap (eBay's search offsets shift as listings are added) must not
 * produce the same "new" item twice inside a single poll.
 *
 * Ids are compared exactly as the provider spells them. eBay's RESTful
 * (`v1|…|0`) and legacy numeric ids are different id spaces; a caller must
 * diff consistently in one of them (the executors use the RESTful id, which
 * is what `marketplace_items.external_item_id` stores for search discovery).
 */
export function diffDiscoveredItems<T extends DiscoveredSummary>(
  input: DiffDiscoveredItemsInput<T>,
): DiffDiscoveredItemsResult<T> {
  const known = new Set(input.knownExternalIds);
  const newItems: T[] = [];
  const seenItems: T[] = [];
  for (const summary of input.fetchedSummaries) {
    const externalItemId = summary.externalItemId;
    if (typeof externalItemId !== "string" || externalItemId === "") {
      throw new MarketValidationError(
        "discovered summary has no externalItemId",
      );
    }
    if (known.has(externalItemId)) {
      seenItems.push(summary);
      continue;
    }
    known.add(externalItemId);
    newItems.push(summary);
  }
  return { newItems, seenItems };
}

/**
 * Which of `externalItemIds` already exist as canonical
 * `(provider, marketplace, external_item_id)` identities. This is the input
 * an executor feeds to {@link diffDiscoveredItems} BEFORE upserting the page,
 * because after the upsert everything looks known.
 */
export async function knownExternalItemIds(
  db: LoxepDb,
  options: {
    provider: string;
    marketplace: string;
    externalItemIds: readonly string[];
  },
): Promise<Set<string>> {
  if (options.externalItemIds.length === 0) return new Set();
  const ids = [...new Set(options.externalItemIds)];
  const result = await db.execute(
    `select external_item_id
       from marketplace_items
      where provider = ${textLiteral(options.provider)}
        and marketplace = ${textLiteral(options.marketplace)}
        and external_item_id in (${ids.map(textLiteral).join(", ")})`,
  );
  return new Set(result.rows.map((row) => row["external_item_id"] as string));
}

/** A just-linked item, plus the listing facts worth keeping in the payload. */
export interface NewlyLinkedItem {
  /** `marketplace_items.id` — the item this monitor just linked. */
  marketplaceItemId: string;
  externalItemId?: string | null;
  title?: string | null;
  /** Decimal string; money never becomes a JS number here. */
  price?: string | null;
  currency?: string | null;
  canonicalUrl?: string | null;
  sellerExternalId?: string | null;
  listingEndsAt?: Date | null;
}

export interface DeriveNewListingEventsInput {
  /** The monitor whose poll made the discovery (provenance). */
  monitorTargetId: string;
  /** Items {@link diffDiscoveredItems} called new and the caller just linked. */
  newlyLinkedItems: readonly NewlyLinkedItem[];
  /** Wall-clock detection stamp; defaults to now. */
  detectedAt?: Date;
}

export interface DeriveNewListingEventsResult {
  /** Rows actually inserted (empty on a retry, or on re-discovery). */
  inserted: MarketEventRow[];
  /**
   * Item ids that were NOT first-global discoveries for this monitor — the
   * re-discovery case. Useful for logging and for the poll's `changed` signal.
   */
  rediscovered: string[];
}

function payloadFor(
  item: NewlyLinkedItem,
  monitorTargetId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    // Provenance is duplicated from the column so a payload read in
    // isolation (a notification body, an opportunity rule) is self-contained.
    discoveredByMonitorTargetId: monitorTargetId,
  };
  if (item.externalItemId != null) {
    payload["externalItemId"] = item.externalItemId;
  }
  if (item.title != null) payload["title"] = item.title;
  if (item.price != null) payload["price"] = item.price;
  if (item.currency != null) payload["currency"] = item.currency;
  if (item.canonicalUrl != null) payload["canonicalUrl"] = item.canonicalUrl;
  if (item.sellerExternalId != null) {
    payload["sellerExternalId"] = item.sellerExternalId;
  }
  if (item.listingEndsAt != null) {
    payload["listingEndsAt"] = item.listingEndsAt.toISOString();
  }
  return payload;
}

/**
 * Insert `new_listing` events for items this monitor just discovered,
 * idempotently and only for FIRST GLOBAL discoveries (module doc).
 *
 * One statement does the work so the "is this the global first?" test and the
 * insert cannot interleave with a concurrent monitor's link:
 *
 * ```sql
 * insert into market_events (...)
 * select ... from candidates c
 *   join monitor_items mine on (this monitor's link)
 *   join lateral (select min(first_discovered_at) ...) g on true
 *  where mine.first_discovered_at = g.first_discovered_at
 * on conflict (deduplication_key) do nothing
 * ```
 *
 * The caller must have linked the items already (`linkItemToMonitor`);
 * without a `monitor_items` row there is no discovery instant to key on and
 * the item is reported as `rediscovered` rather than silently dropped.
 */
export async function deriveNewListingEvents(
  db: LoxepDb,
  input: DeriveNewListingEventsInput,
): Promise<DeriveNewListingEventsResult> {
  const items = input.newlyLinkedItems;
  if (items.length === 0) return { inserted: [], rediscovered: [] };

  const monitorTargetId = uuidLiteral(input.monitorTargetId);
  const detectedAt = timestamptzLiteral(input.detectedAt ?? new Date());

  // De-duplicate by item id: the same item must contribute one candidate row.
  const byItemId = new Map<string, NewlyLinkedItem>();
  for (const item of items) {
    if (!byItemId.has(item.marketplaceItemId)) {
      byItemId.set(item.marketplaceItemId, item);
    }
  }
  const candidates = [...byItemId.values()]
    .map(
      (item) =>
        // Explicit casts: a bare quoted literal is `text`, and `uuid = text`
        // has no operator in PostgreSQL.
        `(${uuidLiteral(item.marketplaceItemId)}::uuid, ${jsonbLiteral(
          payloadFor(item, input.monitorTargetId),
        )})`,
    )
    .join(", ");

  const result = await db.execute(
    `with candidates (marketplace_item_id, payload) as (
        values ${candidates}
      ),
      discovery as (
        select c.marketplace_item_id,
               c.payload,
               mine.first_discovered_at as mine_first_discovered_at,
               (
                 select min(all_links.first_discovered_at)
                   from monitor_items all_links
                  where all_links.marketplace_item_id = c.marketplace_item_id
               ) as global_first_discovered_at
          from candidates c
          join monitor_items mine
            on mine.marketplace_item_id = c.marketplace_item_id
           and mine.monitor_target_id = ${monitorTargetId}
      )
      insert into market_events (
        marketplace_item_id, monitor_target_id, event_type, detected_at,
        from_observed_at, to_observed_at, payload, deduplication_key
      )
      select d.marketplace_item_id,
             ${monitorTargetId},
             ${textLiteral(NEW_LISTING_EVENT_TYPE)},
             ${detectedAt},
             null,
             d.global_first_discovered_at,
             d.payload || jsonb_build_object(
               'firstDiscoveredAt',
               to_char(
                 d.global_first_discovered_at at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               )
             ),
             d.marketplace_item_id::text
               || ':' || ${textLiteral(NEW_LISTING_EVENT_TYPE)}
               || ':' || to_char(
                    d.global_first_discovered_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  )
        from discovery d
       where d.mine_first_discovered_at = d.global_first_discovered_at
      on conflict (deduplication_key) do nothing
      returning id, marketplace_item_id`,
  );

  const insertedIds = result.rows.map((row) => row["id"] as string);
  const insertedItemIds = new Set(
    result.rows.map((row) => row["marketplace_item_id"] as string),
  );
  const rediscovered = [...byItemId.keys()].filter(
    (id) => !insertedItemIds.has(id),
  );
  if (insertedIds.length === 0) {
    return { inserted: [], rediscovered };
  }
  const inserted = await db.query.marketEvents.findMany({
    where: (table, { inArray }) => inArray(table.id, insertedIds),
    orderBy: (table, { asc }) => [asc(table.toObservedAt), asc(table.id)],
  });
  return { inserted, rediscovered };
}
