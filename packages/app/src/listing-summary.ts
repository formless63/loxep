/**
 * `EbayListingSummary` → observation mapping for the discovery executors
 * (loxep-7dp.7).
 *
 * `@loxep/integration-ebay` owns `snapshotToObservation` for the rich
 * `getItem` snapshot. A SEARCH summary is deliberately a different type — it
 * is thinner (no quantities, no availability, no shipping price) — and the
 * integration package exposes no summary equivalent, so the composition root
 * maps it here, obeying exactly the same rules:
 *
 * - money is a decimal STRING, verbatim from the provider, never a JS float;
 * - an absent fact is omitted (→ SQL NULL), NEVER 0 and never `""` — a
 *   summary that does not report quantity means "unknown", not "none in
 *   stock". This matters twice over, because `@loxep/market`'s event
 *   derivation treats NULL as "does not participate", so a search observation
 *   can never fabricate a `sold_out`/`restocked` transition against an item
 *   whose quantity a `getItem` poll actually measured;
 * - `listingState` follows `snapshot.ts`'s rule: `"ended"` when the listing's
 *   end instant has already passed at fetch time, else `"active"`. Browse
 *   only returns currently purchasable listings, so in practice this is
 *   `"active"` — and note that a listing's DISAPPEARANCE from a search page is
 *   never evidence it ended (that stays an observation comparison on the item
 *   itself);
 * - `rawStateHash` is computed by the integration boundary's own
 *   {@link observationStateHash} over a snapshot-shaped view of the summary,
 *   so the documented field order stays in ONE place.
 *
 * ### A note on hashes across sources
 *
 * The hash covers observation-relevant fields, and a summary genuinely
 * carries fewer of them than a `getItem` snapshot. An item observed by both a
 * search monitor and an item monitor therefore alternates between two hashes,
 * which the adaptive policy reads as "changed". That is a cadence nudge on an
 * item two monitors care about, not a derived event: events compare
 * field-by-field with NULL excluded, so nothing user-visible is fabricated.
 */
import { observationStateHash } from "@loxep/integration-ebay";
import type {
  EbayItemSnapshot,
  EbayListingSummary,
  EbayObservationItem,
  EbayMarketplaceItemIdentity,
} from "@loxep/integration-ebay";

/** `marketplace_item_observations.source` for the two discovery kinds. */
export const SEARCH_OBSERVATION_SOURCE = "ebay:search";
export const SELLER_OBSERVATION_SOURCE = "ebay:seller";

export interface SummaryObservation {
  item: EbayMarketplaceItemIdentity;
  observation: EbayObservationItem;
}

/**
 * The snapshot-shaped view {@link observationStateHash} hashes. Every field a
 * summary cannot know is explicitly `null`, which is exactly how the hash
 * treats an absent fact — so this is a faithful projection, not a stub.
 */
function hashableSnapshot(
  summary: EbayListingSummary,
  listingState: string,
  observedAt: Date,
): EbayItemSnapshot {
  return {
    externalItemId: summary.externalItemId,
    marketplace: summary.marketplace,
    title: summary.title,
    sellerExternalId: summary.sellerExternalId,
    canonicalUrl: summary.canonicalUrl,
    conditionCode: summary.conditionCode,
    categoryExternalId: summary.categoryExternalId,
    listingType: summary.listingType,
    price:
      summary.price !== null && summary.currency !== null
        ? { value: summary.price, currency: summary.currency }
        : null,
    shippingPrice: null,
    quantityAvailable: null,
    quantitySold: null,
    availability: null,
    listingState,
    watchCount: null,
    sellerFeedbackScore: summary.sellerFeedbackScore,
    sellerFeedbackPct: summary.sellerFeedbackPct,
    listingEndsAt: summary.listingEndsAt,
    raw: summary.raw,
    // Neither field participates in the hash; both are carried so the
    // projection is a real snapshot value rather than a cast.
    fetchedAt: observedAt,
  };
}

/**
 * Map one search/seller summary into the canonical item identity plus the
 * observation item `recordObservationBatch` consumes (minus
 * `marketplaceItemId`, which only exists after the upsert).
 *
 * `observedAt` is the poll's ONE fetch-time instant — this function never
 * mints a timestamp, exactly like the integration boundary's
 * `snapshotToObservation`.
 */
export function summaryToObservation(
  summary: EbayListingSummary,
  context: { observedAt: Date },
): SummaryObservation {
  const listingState =
    summary.listingEndsAt !== null &&
    summary.listingEndsAt.getTime() <= context.observedAt.getTime()
      ? "ended"
      : "active";

  const observation: EbayObservationItem = {
    ...(summary.currency !== null ? { currency: summary.currency } : {}),
    ...(summary.price !== null ? { price: summary.price } : {}),
    // quantityAvailable / quantitySold / availability / shippingPrice /
    // watchCount are NOT reported by a search summary — omitted, never 0.
    listingState,
    ...(summary.sellerFeedbackScore !== null
      ? { sellerFeedbackScore: summary.sellerFeedbackScore }
      : {}),
    ...(summary.sellerFeedbackPct !== null
      ? { sellerFeedbackPct: summary.sellerFeedbackPct }
      : {}),
    ...(summary.listingEndsAt !== null
      ? { listingEndsAt: summary.listingEndsAt }
      : {}),
    rawStateHash: observationStateHash(
      hashableSnapshot(summary, listingState, context.observedAt),
    ),
  };

  const item: EbayMarketplaceItemIdentity = {
    provider: "ebay",
    marketplace: summary.marketplace,
    externalItemId: summary.externalItemId,
    seenAt: context.observedAt,
    currentState: listingState,
    ...(summary.sellerExternalId !== null
      ? { sellerExternalId: summary.sellerExternalId }
      : {}),
    ...(summary.canonicalUrl !== null
      ? { canonicalUrl: summary.canonicalUrl }
      : {}),
    ...(summary.title !== null ? { title: summary.title } : {}),
    ...(summary.conditionCode !== null
      ? { conditionCode: summary.conditionCode }
      : {}),
    ...(summary.categoryExternalId !== null
      ? { categoryExternalId: summary.categoryExternalId }
      : {}),
    ...(summary.listingType !== null
      ? { listingType: summary.listingType }
      : {}),
    ...(summary.listingEndsAt !== null
      ? { listingEndsAt: summary.listingEndsAt }
      : {}),
  };

  return { item, observation };
}
