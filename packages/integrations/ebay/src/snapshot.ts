/**
 * Item snapshot adapter (loxep-62y.1.4): Browse getItem /
 * getItemByLegacyId normalized into the Loxep-owned
 * {@link EbayItemSnapshot}. Field sources (verified against the
 * ebay-api@10.0.0 buy_browse_v1 OpenAPI types):
 *
 * - externalItemId      ← itemId (RESTful `v1|...` id)
 * - marketplace         ← listingMarketplaceId (fallback: adapter marketplace)
 * - sellerExternalId    ← seller.username
 * - canonicalUrl        ← itemWebUrl
 * - conditionCode       ← conditionId
 * - categoryExternalId  ← categoryId
 * - listingType         ← buyingOptions, lowercased, sorted, "+"-joined
 * - price/shippingPrice ← price / shippingOptions[0].shippingCost
 *                         (ConvertedAmount.value is already a decimal STRING
 *                         and is passed through verbatim — never parsed to a
 *                         JS float)
 * - quantityAvailable   ← estimatedAvailabilities[0].estimatedAvailableQuantity
 * - quantitySold        ← estimatedAvailabilities[0].estimatedSoldQuantity
 * - availability        ← estimatedAvailabilities[0].estimatedAvailabilityStatus
 *                         lowercased (IN_STOCK → "in_stock", matching the
 *                         market package's availability conventions)
 * - listingState        ← "ended" when itemEndDate ≤ fetchedAt, else "active"
 *                         (Browse only returns purchasable listings; ended
 *                         items normally surface as not_found)
 * - watchCount          ← watchCount
 * - sellerFeedbackScore ← seller.feedbackScore
 * - sellerFeedbackPct   ← seller.feedbackPercentage (decimal string,
 *                         passed through verbatim)
 * - listingEndsAt       ← itemEndDate
 *
 * Absent facts stay null — never 0, never "" (NULL-preservation rule of the
 * observation write path). `raw` retains the full provider payload for
 * source-event retention (ADR-0009 #3); it is provider-shaped and
 * deliberately typed as an untyped record.
 */
import type { EbayAdapter } from "./adapter.ts";
import { EbayAdapterError } from "./errors.ts";

export interface EbayMoney {
  /** Decimal string, verbatim from the provider (money is never a JS float). */
  value: string;
  /** ISO-4217 currency code. */
  currency: string;
}

export interface EbayItemSnapshot {
  externalItemId: string;
  marketplace: string;
  title: string | null;
  sellerExternalId: string | null;
  canonicalUrl: string | null;
  conditionCode: string | null;
  categoryExternalId: string | null;
  listingType: string | null;
  price: EbayMoney | null;
  shippingPrice: EbayMoney | null;
  quantityAvailable: number | null;
  quantitySold: number | null;
  availability: string | null;
  listingState: string;
  watchCount: number | null;
  sellerFeedbackScore: number | null;
  /** Decimal string (e.g. "99.7"), verbatim from the provider. */
  sellerFeedbackPct: string | null;
  listingEndsAt: Date | null;
  /** Full provider payload, retained for audit/replay (ADR-0009). */
  raw: Record<string, unknown>;
  fetchedAt: Date;
}

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function asMoney(value: unknown): EbayMoney | null {
  const record = asRecord(value);
  if (record === null) return null;
  const amount = asString(record["value"]);
  const currency = asString(record["currency"]);
  if (amount === null || currency === null) return null;
  if (!DECIMAL_STRING.test(amount)) return null;
  return { value: amount, currency };
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Pure mapping from a raw Browse item payload to the Loxep-owned snapshot.
 * Exported for tests; adapter users should call {@link fetchItemSnapshot}.
 */
export function mapItemToSnapshot(
  raw: Record<string, unknown>,
  options: { fetchedAt: Date; fallbackMarketplace: string },
): EbayItemSnapshot {
  const externalItemId = asString(raw["itemId"]);
  if (externalItemId === null) {
    throw new EbayAdapterError(
      "provider_unavailable",
      "eBay item payload has no itemId; refusing to build a snapshot",
    );
  }

  const seller = asRecord(raw["seller"]);
  const availabilities = Array.isArray(raw["estimatedAvailabilities"])
    ? asRecord(raw["estimatedAvailabilities"][0])
    : null;
  const shippingOptions = Array.isArray(raw["shippingOptions"])
    ? asRecord(raw["shippingOptions"][0])
    : null;

  const buyingOptions = Array.isArray(raw["buyingOptions"])
    ? raw["buyingOptions"].filter((v): v is string => typeof v === "string")
    : [];
  const listingType =
    buyingOptions.length > 0
      ? buyingOptions
          .map((option) => option.toLowerCase())
          .sort()
          .join("+")
      : null;

  const availabilityStatus = asString(
    availabilities?.["estimatedAvailabilityStatus"],
  );
  const listingEndsAt = asDate(raw["itemEndDate"]);
  const listingState =
    listingEndsAt !== null && listingEndsAt.getTime() <= options.fetchedAt.getTime()
      ? "ended"
      : "active";

  const feedbackPct = asString(seller?.["feedbackPercentage"]);

  return {
    externalItemId,
    marketplace:
      asString(raw["listingMarketplaceId"]) ?? options.fallbackMarketplace,
    title: asString(raw["title"]),
    sellerExternalId: asString(seller?.["username"]),
    canonicalUrl: asString(raw["itemWebUrl"]),
    conditionCode: asString(raw["conditionId"]),
    categoryExternalId: asString(raw["categoryId"]),
    listingType,
    price: asMoney(raw["price"]),
    shippingPrice: asMoney(shippingOptions?.["shippingCost"]),
    quantityAvailable: asInt(availabilities?.["estimatedAvailableQuantity"]),
    quantitySold: asInt(availabilities?.["estimatedSoldQuantity"]),
    availability:
      availabilityStatus !== null ? availabilityStatus.toLowerCase() : null,
    listingState,
    watchCount: asInt(raw["watchCount"]),
    sellerFeedbackScore: asInt(seller?.["feedbackScore"]),
    sellerFeedbackPct:
      feedbackPct !== null && DECIMAL_STRING.test(feedbackPct)
        ? feedbackPct
        : null,
    listingEndsAt,
    raw,
    fetchedAt: options.fetchedAt,
  };
}

/** Browse getItem by RESTful item id (`v1|...|0`). */
export async function fetchItemSnapshot(
  adapter: EbayAdapter,
  options: { itemId: string },
): Promise<EbayItemSnapshot> {
  const raw = await adapter.browseGetItem(options.itemId);
  return mapItemToSnapshot(raw, {
    fetchedAt: new Date(),
    fallbackMarketplace: adapter.marketplaceId,
  });
}

/**
 * Browse getItemByLegacyId for numeric Trading-era item ids (watchlist
 * sources often carry legacy ids rather than `v1|...` RESTful ids).
 */
export async function fetchItemSnapshotByLegacyId(
  adapter: EbayAdapter,
  options: { legacyItemId: string },
): Promise<EbayItemSnapshot> {
  const raw = await adapter.browseGetItemByLegacyId(options.legacyItemId);
  return mapItemToSnapshot(raw, {
    fetchedAt: new Date(),
    fallbackMarketplace: adapter.marketplaceId,
  });
}
