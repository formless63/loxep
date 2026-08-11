/**
 * Listing context for enriched notification rendering (loxep-62y.2 ×
 * loxep-62y.3.2).
 *
 * `packages/notifications/src/render.ts` renders a per-event-type message
 * that includes the canonical listing URL and title — but ONLY when the
 * caller hands it the event's `marketplace_items` row through the optional
 * `listing` field. The delivery pipeline's drop-in seam is
 * `createDeliveryPipeline({ renderMessage })`, whose contract is
 * **synchronous** (`(event) => NotificationMessage`), so the renderer itself
 * cannot perform the `marketplace_items` join.
 *
 * This module closes that gap the only way the seam allows: the poll executor
 * already HAS the item row it just upserted, and it remembers it here right
 * before enqueueing deliveries for the event; the renderer then looks the
 * listing up synchronously by `marketplace_item_id`. Both live in the worker
 * process that runs the delivery task, which is the Phase 1 deployment shape
 * (one worker per installation — the same assumption the eBay rate budget
 * documents).
 *
 * DEGRADATION IS SAFE AND SILENT: on a cache miss (worker restart between
 * detection and delivery, or a second worker process) `render.ts` renders the
 * same message without the URL line and with a generic item label. Nothing
 * fails, and no delivery is delayed.
 *
 * The durable fix is a pipeline-side listing join inside @loxep/notifications
 * (or an async `renderMessage`); it is filed as its own issue and is not
 * something the composition root can do from outside that package.
 */

/** The `marketplace_items` facts `render.ts`'s `listing` field needs. */
export interface ListingContext {
  provider: string;
  marketplace: string;
  externalItemId: string;
  canonicalUrl: string | null;
  title: string | null;
}

export interface ListingContextCache {
  remember: (marketplaceItemId: string, listing: ListingContext) => void;
  get: (marketplaceItemId: string) => ListingContext | null;
  readonly size: number;
}

/** Entries kept before the oldest is evicted (insertion-ordered Map). */
export const LISTING_CONTEXT_CACHE_LIMIT = 500;

/**
 * Bounded, insertion-ordered LRU-ish cache. Re-remembering an id refreshes
 * its position, so hot listings survive eviction.
 */
export function createListingContextCache(
  limit: number = LISTING_CONTEXT_CACHE_LIMIT,
): ListingContextCache {
  const entries = new Map<string, ListingContext>();
  return {
    remember(marketplaceItemId, listing) {
      entries.delete(marketplaceItemId);
      entries.set(marketplaceItemId, listing);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    get(marketplaceItemId) {
      const listing = entries.get(marketplaceItemId);
      if (listing === undefined) return null;
      entries.delete(marketplaceItemId);
      entries.set(marketplaceItemId, listing);
      return listing;
    },
    get size() {
      return entries.size;
    },
  };
}
