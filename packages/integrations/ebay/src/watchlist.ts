/**
 * Watchlist retrieval adapter (loxep-62y.1.3).
 *
 * SOURCE: eBay exposes a buyer's watch list only through the *traditional*
 * Trading API call `GetMyeBayBuying` (`WatchList.Include=true`). There is no
 * Browse/Buy REST watchlist resource, so this is the documented source. The
 * call authenticates with the OAuth **user** token via the IAF header — see
 * `adapter.ts` for the verified library path — which is why it takes an
 * {@link EbayUserAdapter} rather than the application-token adapter.
 *
 * REQUEST (verified shape, Trading `GetMyeBayBuyingRequestType`):
 *
 * ```
 * { WatchList: { Include: true, Pagination: { EntriesPerPage, PageNumber } },
 *   DetailLevel: "ReturnAll" }
 * ```
 *
 * RESPONSE (`GetMyeBayBuyingResponse`, unwrapped by ebay-api's XMLRequest):
 *
 * ```
 * { Ack, Timestamp, WatchList: { ItemArray: { Item: [...] },
 *                                PaginationResult: { TotalNumberOfPages,
 *                                                    TotalNumberOfEntries } } }
 * ```
 *
 * The library's XML parser is configured with `parseTagValue: true`, so
 * numeric-looking fields (ItemID, some UserIDs) arrive as JS numbers — every
 * identifier is coerced back to a string here, and identifiers are never used
 * in arithmetic.
 *
 * MAPPING (Loxep-owned, provider types never escape):
 * - externalItemId   ← Item.ItemID (legacy numeric Trading id, as string)
 * - title            ← Item.Title
 * - canonicalUrl     ← Item.ListingDetails.ViewItemURL
 * - listingEndsAt    ← Item.ListingDetails.EndTime
 * - sellerExternalId ← Item.Seller.UserID
 * - raw              ← the whole Item payload, retained per ADR-0009 #3
 *
 * NOTE the id space: Trading returns LEGACY numeric item ids, while Browse
 * (snapshot.ts) works in RESTful `v1|…|0` ids. `browseGetItemByLegacyId`
 * bridges the two; do not treat the two ids as interchangeable strings.
 *
 * SANDBOX CAVEAT: a sandbox watch list is only non-empty when a sandbox TEST
 * USER has watched sandbox listings, and only after that test user completes
 * the consent flow. Until then this call legitimately returns zero entries
 * (or `auth` if no user token has been granted) — that is not a mapping bug.
 */
import type { EbayUserAdapter } from "./adapter.ts";
import { EbayAdapterError } from "./errors.ts";

export interface EbayWatchlistEntry {
  /** Legacy numeric Trading item id, as a string. */
  externalItemId: string;
  title: string | null;
  canonicalUrl: string | null;
  listingEndsAt: Date | null;
  sellerExternalId: string | null;
  /** Full provider item payload, retained for audit/replay (ADR-0009). */
  raw: Record<string, unknown>;
}

export interface EbayWatchlistPage {
  entries: EbayWatchlistEntry[];
  page: number;
  entriesPerPage: number;
  totalPages: number | null;
  totalEntries: number | null;
  hasMore: boolean;
  fetchedAt: Date;
}

export interface FetchWatchlistInput {
  /** 1-based page number; default 1. */
  page?: number;
  /** eBay caps this at 200; default 100. */
  entriesPerPage?: number;
}

export const WATCHLIST_CALL_NAME = "GetMyeBayBuying";
export const DEFAULT_WATCHLIST_ENTRIES_PER_PAGE = 100;
const MAX_WATCHLIST_ENTRIES_PER_PAGE = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  return null;
}

/** Identifiers may arrive as numbers because the XML parser coerces them. */
function asIdString(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

function asCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `Item` is normally an array (the parser's `…Array`/`Item` rule); be lenient. */
function itemsOf(itemArray: unknown): Record<string, unknown>[] {
  const container = asRecord(itemArray);
  if (container === null) return [];
  const items = container["Item"];
  if (Array.isArray(items)) {
    return items
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== null);
  }
  const single = asRecord(items);
  return single === null ? [] : [single];
}

/**
 * Pure mapping from one `Item` payload to a Loxep watchlist entry. Exported
 * for tests; callers should use {@link fetchWatchlist}.
 */
export function mapWatchlistItem(
  raw: Record<string, unknown>,
): EbayWatchlistEntry {
  const externalItemId = asIdString(raw["ItemID"]);
  if (externalItemId === null) {
    throw new EbayAdapterError(
      "provider_unavailable",
      "eBay watchlist item payload has no ItemID",
    );
  }
  const listingDetails = asRecord(raw["ListingDetails"]);
  const seller = asRecord(raw["Seller"]);
  return {
    externalItemId,
    title: asString(raw["Title"]),
    canonicalUrl:
      listingDetails === null ? null : asString(listingDetails["ViewItemURL"]),
    listingEndsAt:
      listingDetails === null ? null : asDate(listingDetails["EndTime"]),
    sellerExternalId: seller === null ? null : asIdString(seller["UserID"]),
    raw,
  };
}

/**
 * Pure mapping from a `GetMyeBayBuying` response to one Loxep page.
 * Exported for tests against captured payloads.
 */
export function mapWatchlistResponse(
  response: Record<string, unknown>,
  options: { fetchedAt: Date; page: number; entriesPerPage: number },
): EbayWatchlistPage {
  const watchList = asRecord(response["WatchList"]);
  const entries =
    watchList === null ? [] : itemsOf(watchList["ItemArray"]).map(mapWatchlistItem);
  const pagination =
    watchList === null ? null : asRecord(watchList["PaginationResult"]);
  const totalPages =
    pagination === null ? null : asCount(pagination["TotalNumberOfPages"]);
  const totalEntries =
    pagination === null ? null : asCount(pagination["TotalNumberOfEntries"]);
  return {
    entries,
    page: options.page,
    entriesPerPage: options.entriesPerPage,
    totalPages,
    totalEntries,
    // Without pagination metadata, a full page is the only "there may be
    // more" signal available.
    hasMore:
      totalPages !== null
        ? options.page < totalPages
        : entries.length >= options.entriesPerPage,
    fetchedAt: options.fetchedAt,
  };
}

/**
 * Fetch one page of the connected user's watch list. Errors arrive already
 * normalized through the taxonomy by the adapter's call wrapper — Trading
 * failures surface as `EbayApiError` subclasses (`checkEBayTraditionalResponse`
 * throws on `Ack: "Failure"`), so an expired user token becomes `auth`, not a
 * silently empty page.
 */
export async function fetchWatchlist(
  userAdapter: EbayUserAdapter,
  input: FetchWatchlistInput = {},
): Promise<EbayWatchlistPage> {
  const page = input.page ?? 1;
  const entriesPerPage =
    input.entriesPerPage ?? DEFAULT_WATCHLIST_ENTRIES_PER_PAGE;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new EbayAdapterError(
      "invalid_request",
      "watchlist page must be a positive integer",
      { page },
    );
  }
  if (
    !Number.isSafeInteger(entriesPerPage) ||
    entriesPerPage < 1 ||
    entriesPerPage > MAX_WATCHLIST_ENTRIES_PER_PAGE
  ) {
    throw new EbayAdapterError(
      "invalid_request",
      "watchlist entriesPerPage must be between 1 and 200",
      { entriesPerPage },
    );
  }
  const response = await userAdapter.tradingCall(WATCHLIST_CALL_NAME, {
    WatchList: {
      Include: true,
      Pagination: { EntriesPerPage: entriesPerPage, PageNumber: page },
    },
    DetailLevel: "ReturnAll",
  });
  return mapWatchlistResponse(response, {
    fetchedAt: new Date(),
    page,
    entriesPerPage,
  });
}

/**
 * Walk every page of the watch list. `maxPages` is a safety stop, not a
 * paging preference — the rate budget still governs call spacing.
 */
export async function fetchAllWatchlistEntries(
  userAdapter: EbayUserAdapter,
  input: FetchWatchlistInput & { maxPages?: number } = {},
): Promise<{ entries: EbayWatchlistEntry[]; pages: number; truncated: boolean }> {
  const maxPages = input.maxPages ?? 20;
  const entries: EbayWatchlistEntry[] = [];
  const seen = new Set<string>();
  let page = input.page ?? 1;
  let pages = 0;
  for (; pages < maxPages; ) {
    const result = await fetchWatchlist(userAdapter, {
      ...input,
      page,
    });
    pages += 1;
    for (const entry of result.entries) {
      // eBay can repeat an item across page boundaries when the list changes
      // mid-walk; the first observation of an id wins.
      if (seen.has(entry.externalItemId)) continue;
      seen.add(entry.externalItemId);
      entries.push(entry);
    }
    if (!result.hasMore || result.entries.length === 0) {
      return { entries, pages, truncated: false };
    }
    page += 1;
  }
  return { entries, pages, truncated: true };
}
