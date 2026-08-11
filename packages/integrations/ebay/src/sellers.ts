/**
 * Seller enumeration (loxep-7dp.2): list a seller's currently purchasable
 * listings.
 *
 * ## Source verification (eBay docs + live SANDBOX calls, 2026-08-11)
 *
 * There is no "get a seller's inventory" resource in the Buy Browse API. The
 * documented way to enumerate one seller is Browse `item_summary/search` with
 * the **`sellers`** filter, `sellers:{username1|username2}`, capped at
 * {@link MAX_SELLERS_PER_FILTER} usernames. Two facts were confirmed by
 * calling the real sandbox rather than trusting the field name:
 *
 * - `filter=sellers:{<real sandbox seller>}` returned HTTP 200 with NO
 *   `warnings` and a REDUCED result count, while a deliberately bogus filter
 *   name returned warning 12002 and an unchanged count. The field name is
 *   therefore real and actually applied — a filter eBay does not recognize is
 *   silently dropped, which would otherwise look like "the seller has lots of
 *   listings".
 * - A username eBay does not know produces warning 12003 ("A seller
 *   'username' provided in the request filters is invalid") — a 200, not an
 *   error — and eBay then DROPS the filter and returns the anchor's full
 *   result set. Verified: `category_ids=9355` + an invented username returned
 *   the entire category's 566 items with a 12003 warning. Ingesting that as
 *   "this seller's listings" would attribute a whole category to one seller,
 *   so {@link fetchSellerListings} REFUSES a page carrying 12003 instead of
 *   returning it. This is the single most important reason seller
 *   enumeration is its own module rather than a one-line filter helper.
 *
 * ## An anchor is mandatory — the seller filter is not one
 *
 * A filter-only call (`sellers` with no `q`/`category_ids`) is rejected with
 * HTTP 400 errorId 12001: *"The call must have a valid 'q', 'category_ids',
 * 'charity_ids', 'epid' or 'gtin' query parameter."* Verified live. Seller
 * enumeration therefore always sends an anchor:
 *
 * - the caller's `categoryId`/`query` when given — the precise, documented
 *   option, and the right one when a monitor only cares about part of a
 *   seller's catalogue;
 * - otherwise {@link EBAY_ROOT_CATEGORY_ID}, the whole-site anchor. Be aware
 *   of what that is: `category_ids=0` is NOT documented by eBay. Verified
 *   against the sandbox on 2026-08-11: `category_ids=0` + a valid `sellers`
 *   filter returns the seller's listings across ALL categories (1610 items,
 *   versus 540 for the same seller inside one category), while
 *   `category_ids=0` on its own — or with an unrecognized username — is
 *   rejected with 12001. In other words eBay accepts the pair, not the
 *   category. Treat it as observed behaviour, not a promise: a monitor that
 *   must not break should pin an explicit `categoryId`.
 *
 * ## What a seller page is and is not
 *
 * - Browse returns only listings currently purchasable on the configured
 *   marketplace. Ended, scheduled, and out-of-marketplace listings are
 *   absent, so absence from a page is NOT evidence a listing ended —
 *   `listing_ended` stays an observation comparison on the item itself, never
 *   an inference from a missing search hit.
 * - Paging is bounded (`MAX_SEARCH_OFFSET`), so a very large seller is
 *   enumerated only down to `maxItems`. {@link DEFAULT_SELLER_SORT} keeps the
 *   listings new-listing detection cares about on the first page.
 * - Loxep monitors ONE seller per target even though `sellers` accepts many,
 *   so each seller keeps its own cadence, backoff, and event provenance.
 *
 * Everything else — the normalized {@link EbayListingSummary}, the opaque
 * cursor, the filter shape — is `search.ts`'s, deliberately unduplicated.
 */
import type { EbayAdapter } from "./adapter.ts";
import { EbayAdapterError } from "./errors.ts";
import {
  searchAllListings,
  searchListings,
  type EbayListingSummary,
  type EbaySearchFilters,
  type EbaySearchPage,
  type EbaySearchSort,
  type EbaySearchWarning,
} from "./search.ts";

/** Browse filter field that restricts results to given sellers. */
export const SELLER_FILTER_FIELD = "sellers";

/**
 * Whole-site anchor used when a seller monitor names no category. See the
 * module doc: observed, not documented.
 */
export const EBAY_ROOT_CATEGORY_ID = "0";

/**
 * Default ordering for seller enumeration: newest listings first, so a
 * bounded page still contains everything the seller listed since the last
 * poll.
 */
export const DEFAULT_SELLER_SORT: EbaySearchSort = "newlyListed";

/** eBay warning id for "that seller username is not valid". */
export const UNKNOWN_SELLER_WARNING_ID = 12003;

export interface FetchSellerListingsInput {
  /** eBay seller username, exactly as eBay spells it. */
  sellerUsername: string;
  /** Page size, 1…200. */
  limit?: number;
  /** Opaque cursor from a previous page. */
  cursor?: string | null;
  /**
   * Additional narrowing (price band, condition, buying options). A
   * `sellers` entry here is ignored — `sellerUsername` is authoritative.
   */
  filters?: Omit<EbaySearchFilters, "sellers">;
  /** Overrides {@link DEFAULT_SELLER_SORT}. */
  sort?: EbaySearchSort;
  /** Keyword anchor/narrowing within the seller's listings. */
  query?: string;
  /** Category anchor; defaults to {@link EBAY_ROOT_CATEGORY_ID}. */
  categoryId?: string;
}

/** Shared request construction — the anchor rule lives in exactly one place. */
function sellerSearchInput(input: FetchSellerListingsInput): {
  username: string;
  query?: string;
  categoryId?: string;
  filters: EbaySearchFilters;
  sort: EbaySearchSort;
  limit?: number;
  cursor?: string | null;
} {
  const username = input.sellerUsername.trim();
  if (username === "") {
    throw new EbayAdapterError(
      "invalid_request",
      "sellerUsername is required to enumerate a seller's listings",
    );
  }
  const query = input.query?.trim();
  const categoryId = input.categoryId?.trim();
  const hasQuery = query !== undefined && query !== "";
  const hasCategory = categoryId !== undefined && categoryId !== "";
  return {
    username,
    ...(hasQuery ? { query } : {}),
    // eBay needs an anchor even when the seller filter fully determines the
    // result set (errorId 12001); fall back to the whole-site category.
    ...(hasCategory
      ? { categoryId }
      : hasQuery
        ? {}
        : { categoryId: EBAY_ROOT_CATEGORY_ID }),
    // `sellers` is written LAST, so any stray value in `filters` is
    // overridden rather than merged — `sellerUsername` is the only source.
    filters: { ...input.filters, sellers: [username] },
    sort: input.sort ?? DEFAULT_SELLER_SORT,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
}

/**
 * Reject a result set eBay produced by DROPPING the seller filter. Without
 * this, an unrecognized username silently yields the anchor's whole result
 * set — an entire category attributed to one seller.
 */
function assertSellerFilterApplied(
  warnings: readonly EbaySearchWarning[],
  sellerUsername: string,
): void {
  if (hasUnknownSellerWarning(warnings)) {
    throw new EbayAdapterError(
      "invalid_request",
      "eBay does not recognize this seller username; it ignored the seller " +
        "filter and returned unrelated listings",
      { sellerUsername, warningId: UNKNOWN_SELLER_WARNING_ID },
    );
  }
}

/** One page of a seller's listings, normalized exactly like a search page. */
export async function fetchSellerListings(
  adapter: EbayAdapter,
  input: FetchSellerListingsInput,
): Promise<EbaySearchPage> {
  const { username, ...request } = sellerSearchInput(input);
  const page = await searchListings(adapter, request);
  assertSellerFilterApplied(page.warnings, username);
  return page;
}

/**
 * Page a seller's listings up to `maxItems` — the `maxItems` knob on an
 * `ebay_seller` monitor target.
 */
export async function fetchAllSellerListings(
  adapter: EbayAdapter,
  input: FetchSellerListingsInput & { maxItems: number },
): Promise<{
  summaries: EbayListingSummary[];
  pages: number;
  total: number | null;
  warnings: EbaySearchWarning[];
}> {
  const { username, ...request } = sellerSearchInput(input);
  // Checked per page, so a dropped seller filter aborts on page one instead
  // of paying `maxItems` worth of budget for another seller's listings.
  return searchAllListings(adapter, {
    ...request,
    maxItems: input.maxItems,
    onPage: (page) => {
      assertSellerFilterApplied(page.warnings, username);
    },
  });
}

/** True when eBay reported that the seller username itself is not valid. */
export function hasUnknownSellerWarning(
  warnings: readonly EbaySearchWarning[],
): boolean {
  return warnings.some(
    (warning) => warning.errorId === UNKNOWN_SELLER_WARNING_ID,
  );
}
