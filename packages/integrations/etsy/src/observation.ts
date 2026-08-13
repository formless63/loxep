/**
 * Listing → observation mapping (loxep-g4t.1): produce exactly the item
 * shape `@loxep/market`'s `recordObservationBatch` consumes (its
 * `observationItemSchema`), minus `marketplaceItemId` — mirroring
 * `@loxep/integration-ebay/observation.ts`'s contract (the canonical item
 * UUID only exists after `upsertMarketplaceItem`, so this package emits the
 * marketplace-item identity alongside and the ingestion orchestrator spreads
 * `{ ...observation, marketplaceItemId }` after the upsert).
 *
 * ONE mapper serves both m1 monitor types: `etsy_listing` calls
 * `adapter.getListing()` for a single Listing object, and `etsy_shop` calls
 * `adapter.getShopListingsActive()` for a page of them — Etsy's `/listings/
 * active` collection endpoint returns full Listing objects, not a lighter
 * summary shape the way eBay's Browse search does, so there is no separate
 * "summary" mapper to keep in sync.
 *
 * ## Field mapping — DESIGN-DERIVED, pending live verification (m1's fixtures
 * carry it; the field NAMES below are cross-checked against
 * `anitabyte/etsyv3`'s test fixtures and README examples — `main` branch,
 * fetched 2026-08-13 — for `listing_id`/`shop_id`/`price` (Money) and the
 * `state`/`quantity`/`title`/`url`/`taxonomy_id` shape Etsy's Open API v3 has
 * used across its public documentation and every third-party client
 * surveyed; NOT independently confirmed against a live authenticated Etsy
 * API response in this session, the same caveat
 * `@loxep/integration-ebay/orders.ts`'s module doc carries for its own
 * design-derived status enums — treat every field name as a hypothesis to
 * confirm during m1/m2's live-verification leg once the owner-prerequisite
 * Developer Portal app is approved):
 *
 * ```text
 * externalItemId      <- listing_id (stringified)
 * shopExternalId       <- shop_id (stringified)
 * title                 <- title
 * canonicalUrl           <- url
 * price                   <- price (Money -> decimalFromEtsyMoney)
 * quantityAvailable        <- quantity
 * categoryExternalId         <- taxonomy_id (stringified)
 * listingType                  <- listing_type
 * listingState                   <- state, mapped per ETSY_LISTING_STATE_MAP
 * favorersCount                    <- num_favorers  (Etsy's closest analogue
 *                                     to eBay's watchCount — a listing has no
 *                                     "watchers", but favorites are the same
 *                                     kind of buyer-interest signal)
 * ```
 *
 * Etsy has no per-listing "shipping price" field comparable to eBay's
 * `shippingOptions[0].shippingCost` (shipping on Etsy is a shop-level
 * shipping-profile concept, not a per-listing quoted amount at read time),
 * so `shippingPrice` is deliberately omitted rather than invented.
 *
 * ## raw_state_hash
 *
 * Same discipline as eBay's: a sha256 hex digest over a canonical JSON array
 * of exactly the observation-relevant normalized fields, in this fixed
 * order:
 *
 *   [currency, price, quantityAvailable, listingState, favorersCount]
 *
 * Absent fields participate as `null`. Identity/descriptive fields (title,
 * url, shop id, category, listing type, raw payload) and batch facts
 * (observedAt/fetchedAt/batch id) are deliberately EXCLUDED.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { EtsyAdapterError } from "./errors.ts";
import { normalizeEtsyMoney } from "./money.ts";

/** `@loxep/market` observationItemSchema shape, minus marketplaceItemId. */
export interface EtsyObservationItem {
  currency?: string;
  price?: string;
  quantityAvailable?: number;
  listingState?: string;
  watchCount?: number;
  rawStateHash: string;
}

/**
 * `@loxep/market`'s `marketplaceItemInputSchema.marketplace` is a required,
 * non-empty string (the `(provider, marketplace, external_item_id)` unique
 * identity) — Etsy has no sub-marketplace concept like eBay's `EBAY_US`, so
 * this fixed constant fills that column rather than a real per-listing
 * value. Every Etsy item shares it; it exists for schema uniformity with the
 * eBay-shaped identity, not because Etsy has a "marketplace" of its own.
 */
export const ETSY_MARKETPLACE = "etsy";

/** `@loxep/market` marketplaceItemInputSchema-compatible identity. */
export interface EtsyMarketplaceItemIdentity {
  provider: "etsy";
  marketplace: typeof ETSY_MARKETPLACE;
  externalItemId: string;
  seenAt: Date;
  currentState: string;
  sellerExternalId?: string;
  canonicalUrl?: string;
  title?: string;
  categoryExternalId?: string;
  listingType?: string;
}

export interface EtsyObservation {
  /** Minted by the caller at fetch time; passed through untouched. */
  observationBatchId: string;
  /** Fixed by the caller when the provider result was obtained. */
  observedAt: Date;
  connectionId?: string;
  source: string;
  item: EtsyMarketplaceItemIdentity;
  observation: EtsyObservationItem;
}

/** Etsy's `state` enum, and where each lands in Loxep's listing-state vocabulary. */
export const ETSY_LISTING_STATES = [
  "active",
  "inactive",
  "draft",
  "expired",
  "sold_out",
] as const;
export type EtsyListingState = (typeof ETSY_LISTING_STATES)[number];

/**
 * `expired` maps to Loxep's `"ended"` (the vocabulary `deriveMarketEvents`
 * checks for a `listing_ended` event, per `@loxep/market/events.ts`) because
 * it is the one Etsy state that unambiguously means the listing stopped
 * existing. `sold_out`/`inactive`/`draft` are kept distinct rather than
 * folded into `ended`: a sold-out or seller-deactivated listing can return,
 * so treating it as terminal would be a false "ended" signal. `active`
 * passes through unchanged.
 */
export const ETSY_LISTING_STATE_MAP: Readonly<Record<EtsyListingState, string>> = {
  active: "active",
  inactive: "inactive",
  draft: "draft",
  expired: "ended",
  sold_out: "sold_out",
};

export function mapEtsyListingState(state: unknown): string | null {
  return typeof state === "string" &&
    (ETSY_LISTING_STATES as readonly string[]).includes(state)
    ? (ETSY_LISTING_STATE_MAP[state as EtsyListingState] ?? state)
    : null;
}

/** Raw Etsy Listing object -> the fields this package cares about. */
export interface EtsyListingSnapshot {
  externalItemId: string;
  shopExternalId: string | null;
  title: string | null;
  canonicalUrl: string | null;
  price: { value: string; currency: string } | null;
  quantityAvailable: number | null;
  categoryExternalId: string | null;
  listingType: string | null;
  listingState: string;
  favorersCount: number | null;
  /** Full provider payload, retained for audit/replay (ADR-0009). */
  raw: Record<string, unknown>;
  fetchedAt: Date;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * Pure mapping from a raw Etsy Listing payload to the Loxep-owned snapshot.
 * Exported for tests; adapter callers should map through this after
 * `getListing`/`getShopListingsActive`/`getShopListings`.
 */
export function mapListingToSnapshot(
  raw: Record<string, unknown>,
  options: { fetchedAt: Date },
): EtsyListingSnapshot {
  const externalItemId = asString(raw["listing_id"]);
  if (externalItemId === null) {
    throw new EtsyAdapterError(
      "provider_unavailable",
      "Etsy listing payload has no listing_id; refusing to build a snapshot",
    );
  }
  const listingState = mapEtsyListingState(raw["state"]) ?? "active";

  return {
    externalItemId,
    shopExternalId: asString(raw["shop_id"]),
    title: asString(raw["title"]),
    canonicalUrl: asString(raw["url"]),
    price: normalizeEtsyMoney(raw["price"]),
    quantityAvailable: asInt(raw["quantity"]),
    categoryExternalId: asString(raw["taxonomy_id"]),
    listingType: asString(raw["listing_type"]),
    listingState,
    favorersCount: asInt(raw["num_favorers"]),
    raw,
    fetchedAt: options.fetchedAt,
  };
}

const contextSchema = z.strictObject({
  observationBatchId: z.uuid(),
  observedAt: z.date(),
  connectionId: z.uuid().optional(),
  source: z.string().min(1),
});

export type EtsyObservationContext = z.input<typeof contextSchema>;

/** Documented hash-field order — see the module doc before changing. */
export const OBSERVATION_HASH_FIELDS = [
  "currency",
  "price",
  "quantityAvailable",
  "listingState",
  "favorersCount",
] as const;

export function observationStateHash(snapshot: EtsyListingSnapshot): string {
  const canonical: Array<string | number | null> = [
    snapshot.price?.currency ?? null,
    snapshot.price?.value ?? null,
    snapshot.quantityAvailable,
    snapshot.listingState,
    snapshot.favorersCount,
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function snapshotToObservation(
  snapshot: EtsyListingSnapshot,
  context: EtsyObservationContext,
): EtsyObservation {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success) {
    throw new EtsyAdapterError(
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

  const observation: EtsyObservationItem = {
    ...(snapshot.price !== null ? { currency: snapshot.price.currency } : {}),
    ...(snapshot.price !== null ? { price: snapshot.price.value } : {}),
    ...(snapshot.quantityAvailable !== null
      ? { quantityAvailable: snapshot.quantityAvailable }
      : {}),
    listingState: snapshot.listingState,
    ...(snapshot.favorersCount !== null ? { watchCount: snapshot.favorersCount } : {}),
    rawStateHash: observationStateHash(snapshot),
  };

  const item: EtsyMarketplaceItemIdentity = {
    provider: "etsy",
    // Etsy has no sub-marketplace concept like eBay's EBAY_US — see
    // ETSY_MARKETPLACE's doc comment above.
    marketplace: ETSY_MARKETPLACE,
    externalItemId: snapshot.externalItemId,
    seenAt: observedAt,
    currentState: snapshot.listingState,
    ...(snapshot.shopExternalId !== null
      ? { sellerExternalId: snapshot.shopExternalId }
      : {}),
    ...(snapshot.canonicalUrl !== null ? { canonicalUrl: snapshot.canonicalUrl } : {}),
    ...(snapshot.title !== null ? { title: snapshot.title } : {}),
    ...(snapshot.categoryExternalId !== null
      ? { categoryExternalId: snapshot.categoryExternalId }
      : {}),
    ...(snapshot.listingType !== null ? { listingType: snapshot.listingType } : {}),
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
