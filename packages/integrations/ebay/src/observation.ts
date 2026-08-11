/**
 * Snapshot → observation mapping (loxep-62y.1.4): produce exactly the item
 * shape `@loxep/market`'s `recordObservationBatch` consumes (its
 * `observationItemSchema`), minus `marketplaceItemId` — the canonical item
 * UUID only exists after `upsertMarketplaceItem`, so this package emits the
 * marketplace-item identity alongside and the ingestion orchestrator spreads
 * `{ ...observation, marketplaceItemId }` after the upsert.
 *
 * Retry identity (foundation-schema "Retry identity"): `observationBatchId`
 * and `observedAt` are minted ONCE by the caller when the provider fetch
 * result is obtained and retained across processing retries. This module
 * NEVER mints ids or timestamps — both are required inputs.
 *
 * Money discipline: decimal STRINGS end to end (`price.value` verbatim from
 * the provider), never JS float arithmetic. NULL preservation: absent facts
 * are omitted (→ SQL NULL), never coerced to 0.
 *
 * ## raw_state_hash
 *
 * `rawStateHash` is a sha256 hex digest over a canonical JSON array of
 * EXACTLY the observation-relevant normalized fields, in this fixed order:
 *
 *   [currency, price, shippingPrice, quantityAvailable, quantitySold,
 *    availability, listingState, watchCount, sellerFeedbackScore,
 *    sellerFeedbackPct, listingEndsAt(ISO-8601 UTC or null)]
 *
 * Absent fields participate as `null`, so the hash is stable regardless of
 * which optional keys are omitted. Identity/descriptive fields (title, url,
 * seller id, category, raw payload extras) and batch facts
 * (observedAt/fetchedAt/batch id) are deliberately EXCLUDED: the hash
 * answers "did the observed listing state change?", so two fetches seeing
 * identical state hash identically.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { EbayAdapterError } from "./errors.ts";
import type { EbayItemSnapshot } from "./snapshot.ts";

/** `@loxep/market` observationItemSchema shape, minus marketplaceItemId. */
export interface EbayObservationItem {
  currency?: string;
  price?: string;
  shippingPrice?: string;
  quantityAvailable?: number;
  quantitySold?: number;
  availability?: string;
  listingState?: string;
  watchCount?: number;
  sellerFeedbackScore?: number;
  sellerFeedbackPct?: string;
  listingEndsAt?: Date;
  rawStateHash: string;
}

/** `@loxep/market` marketplaceItemInputSchema-compatible identity. */
export interface EbayMarketplaceItemIdentity {
  provider: "ebay";
  marketplace: string;
  externalItemId: string;
  seenAt: Date;
  currentState: string;
  sellerExternalId?: string;
  canonicalUrl?: string;
  title?: string;
  conditionCode?: string;
  categoryExternalId?: string;
  listingType?: string;
  listingEndsAt?: Date;
}

export interface EbayObservation {
  /** Minted by the caller at fetch time; passed through untouched. */
  observationBatchId: string;
  /** Fixed by the caller when the provider result was obtained. */
  observedAt: Date;
  connectionId?: string;
  source: string;
  item: EbayMarketplaceItemIdentity;
  observation: EbayObservationItem;
}

const contextSchema = z.strictObject({
  observationBatchId: z.uuid(),
  observedAt: z.date(),
  connectionId: z.uuid().optional(),
  source: z.string().min(1),
});

export type EbayObservationContext = z.input<typeof contextSchema>;

/** Documented hash-field order — see the module doc before changing. */
export const OBSERVATION_HASH_FIELDS = [
  "currency",
  "price",
  "shippingPrice",
  "quantityAvailable",
  "quantitySold",
  "availability",
  "listingState",
  "watchCount",
  "sellerFeedbackScore",
  "sellerFeedbackPct",
  "listingEndsAt",
] as const;

export function observationStateHash(snapshot: EbayItemSnapshot): string {
  const canonical: Array<string | number | null> = [
    snapshot.price?.currency ?? snapshot.shippingPrice?.currency ?? null,
    snapshot.price?.value ?? null,
    snapshot.shippingPrice?.value ?? null,
    snapshot.quantityAvailable,
    snapshot.quantitySold,
    snapshot.availability,
    snapshot.listingState,
    snapshot.watchCount,
    snapshot.sellerFeedbackScore,
    snapshot.sellerFeedbackPct,
    snapshot.listingEndsAt !== null ? snapshot.listingEndsAt.toISOString() : null,
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function snapshotToObservation(
  snapshot: EbayItemSnapshot,
  context: EbayObservationContext,
): EbayObservation {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success) {
    throw new EbayAdapterError(
      "invalid_request",
      "invalid observation context (batch identity is minted by the caller at fetch time)",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  const { observationBatchId, observedAt, connectionId, source } = parsed.data;

  const currency =
    snapshot.price?.currency ?? snapshot.shippingPrice?.currency ?? null;

  const observation: EbayObservationItem = {
    // Absent facts omitted (→ NULL), never 0/"".
    ...(currency !== null ? { currency } : {}),
    ...(snapshot.price !== null ? { price: snapshot.price.value } : {}),
    ...(snapshot.shippingPrice !== null
      ? { shippingPrice: snapshot.shippingPrice.value }
      : {}),
    ...(snapshot.quantityAvailable !== null
      ? { quantityAvailable: snapshot.quantityAvailable }
      : {}),
    ...(snapshot.quantitySold !== null
      ? { quantitySold: snapshot.quantitySold }
      : {}),
    ...(snapshot.availability !== null
      ? { availability: snapshot.availability }
      : {}),
    listingState: snapshot.listingState,
    ...(snapshot.watchCount !== null
      ? { watchCount: snapshot.watchCount }
      : {}),
    ...(snapshot.sellerFeedbackScore !== null
      ? { sellerFeedbackScore: snapshot.sellerFeedbackScore }
      : {}),
    ...(snapshot.sellerFeedbackPct !== null
      ? { sellerFeedbackPct: snapshot.sellerFeedbackPct }
      : {}),
    ...(snapshot.listingEndsAt !== null
      ? { listingEndsAt: snapshot.listingEndsAt }
      : {}),
    rawStateHash: observationStateHash(snapshot),
  };

  const item: EbayMarketplaceItemIdentity = {
    provider: "ebay",
    marketplace: snapshot.marketplace,
    externalItemId: snapshot.externalItemId,
    seenAt: observedAt,
    currentState: snapshot.listingState,
    ...(snapshot.sellerExternalId !== null
      ? { sellerExternalId: snapshot.sellerExternalId }
      : {}),
    ...(snapshot.canonicalUrl !== null
      ? { canonicalUrl: snapshot.canonicalUrl }
      : {}),
    ...(snapshot.title !== null ? { title: snapshot.title } : {}),
    ...(snapshot.conditionCode !== null
      ? { conditionCode: snapshot.conditionCode }
      : {}),
    ...(snapshot.categoryExternalId !== null
      ? { categoryExternalId: snapshot.categoryExternalId }
      : {}),
    ...(snapshot.listingType !== null
      ? { listingType: snapshot.listingType }
      : {}),
    ...(snapshot.listingEndsAt !== null
      ? { listingEndsAt: snapshot.listingEndsAt }
      : {}),
  };

  return {
    observationBatchId,
    observedAt,
    ...(connectionId !== undefined ? { connectionId } : {}),
    source,
    item,
    observation,
  };
}
