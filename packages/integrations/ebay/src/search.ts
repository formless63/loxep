/**
 * Browse **search** adapter (loxep-7dp.1): persistent search rules and
 * new-listing discovery run through `buy.browse.search`, normalized into the
 * Loxep-owned {@link EbayListingSummary}.
 *
 * ## Why this module talks to the client through `adapterInternals()`
 *
 * `adapter.browseSearch()` is the minimal Browse probe used by the Phase 1
 * live leg; it deliberately exposes only `q`/`category_ids`/`limit`/`offset`
 * and drops pagination metadata. Search rules need the `filter` and `sort`
 * grammar plus `next`/`offset`/`limit`, so this module issues the call itself
 * through the boundary-internal handle — the SAME `call()` wrapper, hence the
 * same per-connection rate-budget acquisition and the same
 * {@link EbayAdapterError} normalization. Nothing here reaches the network
 * without spending budget first, and no provider SDK type escapes.
 *
 * ## Application token only
 *
 * Browse search is an application-scoped (client-credentials) call. This
 * module takes {@link EbayAdapter}, never {@link EbayUserAdapter}: binding a
 * user token to a public search buys nothing and would silently re-authorize
 * the request as that user.
 *
 * ## Loxep filter shape, not eBay's filter grammar
 *
 * eBay's `filter` query parameter is a stringly-typed mini-language
 * (`price:[10..50],priceCurrency:USD,buyingOptions:{FIXED_PRICE|AUCTION}`).
 * Handing that string to callers would leak provider syntax across the
 * integration boundary and make monitor configs unvalidatable. Instead
 * {@link EbaySearchFilters} is a SMALL typed shape covering exactly what the
 * Phase 2 monitors need — price range + currency, buying options, condition
 * groups/ids, sellers, and a "listed after" lower bound — and
 * {@link encodeEbaySearchFilters} is the single place that speaks eBay's
 * grammar. Values are validated and rejected when they contain the grammar's
 * reserved characters, so a monitor config can never inject extra filter
 * clauses.
 *
 * ## Verified provider behaviour (eBay SANDBOX, 2026-08-11)
 *
 * These are observations from real calls, not remembered API lore, and they
 * are why the local validation below exists:
 *
 * - **An anchor is mandatory.** A `filter`-only search is rejected with HTTP
 *   400 / errorId 12001: *"The call must have a valid 'q', 'category_ids',
 *   'charity_ids', 'epid' or 'gtin' query parameter."* A seller filter is NOT
 *   an anchor — see `sellers.ts`.
 * - **An unknown filter is a WARNING, not an error.** `filter=notARealFilter:{x}`
 *   returned HTTP 200 with `warnings[0].errorId = 12002` and an UNCHANGED
 *   result count: eBay silently ignored it. `filter=sellers:{…}` by contrast
 *   produced no warning and a changed count, which is how the `sellers` field
 *   name was confirmed to be real. A silently ignored filter would give a
 *   monitor wrong data, so {@link EbaySearchPage} surfaces `warnings`.
 * - **An unknown sort is likewise only a warning** (errorId 12008), so the
 *   local sort enum is the actual protection.
 * - **`limit` really is capped at 200**: 201 is rejected with *"The 'limit'
 *   value should be between 1 and 200 (inclusive)."*
 * - `price:[…]` without `priceCurrency` warns (12002) and is dropped, hence
 *   the local requirement that the two travel together.
 * - `itemStartDate` accepts both second- and millisecond-precision UTC
 *   instants; eBay's own examples use second precision, which is what this
 *   module emits.
 *
 * ## Verified surface (ebay-api@10.0.0, `buy_browse_v1_oas3`)
 *
 * `search` query parameters: `q`, `category_ids`, `filter`, `sort`, `limit`,
 * `offset`, `aspect_filter`, `auto_correct`, `charity_ids`,
 * `compatibility_filter`, `epid`, `fieldgroups`, `gtin` — all strings.
 * The 200 response is `SearchPagedCollection`:
 * `{ href, itemSummaries, limit, next, offset, prev, refinement, total,
 * warnings }`. `ItemSummary` carries `itemId`, `legacyItemId`, `title`,
 * `price`, `itemWebUrl`, `seller`, `itemEndDate`, `itemCreationDate`,
 * `buyingOptions`, `condition`, `conditionId`, `leafCategoryIds`,
 * `categories`, `listingMarketplaceId`, `shippingOptions`, `watchCount`.
 *
 * ## Field mapping
 *
 * - externalItemId      ← itemId (RESTful `v1|…|0`; NOT interchangeable with
 *                         the legacy numeric id, which is kept separately)
 * - legacyItemId        ← legacyItemId
 * - marketplace         ← listingMarketplaceId (fallback: adapter marketplace)
 * - title               ← title
 * - price / currency    ← price.value / price.currency. `value` is already a
 *                         decimal STRING and is passed through verbatim —
 *                         money is never parsed into a JS float. The pair is
 *                         kept split (not an `EbayMoney`) because that is the
 *                         shape the observation/marketplace-item write path
 *                         consumes.
 * - canonicalUrl        ← itemWebUrl
 * - sellerExternalId    ← seller.username
 * - sellerFeedbackScore ← seller.feedbackScore
 * - sellerFeedbackPct   ← seller.feedbackPercentage (decimal string, verbatim)
 * - condition           ← condition (human label, e.g. "New")
 * - conditionCode       ← conditionId (stable code, e.g. "1000")
 * - categoryExternalId  ← leafCategoryIds[0] ?? categories[0].categoryId
 * - buyingOptions       ← buyingOptions
 * - listingType         ← buyingOptions lowercased, sorted, "+"-joined
 *                         (identical convention to `snapshot.ts`)
 * - listingStartedAt    ← itemCreationDate
 * - listingEndsAt       ← itemEndDate
 * - raw                 ← the whole summary payload (ADR-0009 #3)
 *
 * Absent facts stay `null` — never 0, never "". A search summary is a
 * SUMMARY: it is thinner than `getItem` (no quantities, no availability), so
 * it is deliberately a different type from {@link EbayItemSnapshot} rather
 * than a snapshot with holes.
 *
 * ## Pagination
 *
 * `cursor` is an OPAQUE Loxep token. Today it encodes the next `offset`
 * (eBay's own `next` href is parsed for it, falling back to
 * `offset + returned`), and it is `null` when the page is the last one.
 * Callers must treat it as opaque so the encoding can change.
 */
import { adapterInternals, type EbayAdapter } from "./adapter.ts";
import { EbayAdapterError } from "./errors.ts";

/** eBay Browse buying options (filter `buyingOptions`). */
export const EBAY_BUYING_OPTIONS = [
  "FIXED_PRICE",
  "AUCTION",
  "BEST_OFFER",
  "CLASSIFIED_AD",
] as const;
export type EbayBuyingOption = (typeof EBAY_BUYING_OPTIONS)[number];

/** eBay Browse condition groups (filter `conditions`). */
export const EBAY_CONDITION_GROUPS = [
  "NEW",
  "USED",
  "UNSPECIFIED",
  "CERTIFIED_REFURBISHED",
  "EXCELLENT_REFURBISHED",
  "VERY_GOOD_REFURBISHED",
  "GOOD_REFURBISHED",
  "SELLER_REFURBISHED",
] as const;
export type EbayConditionGroup = (typeof EBAY_CONDITION_GROUPS)[number];

/**
 * Browse `sort` values. `newlyListed` is the one that matters for
 * new-listing detection: it puts the freshest listings on page one, so a
 * bounded `maxItems` search still sees everything new since the last poll.
 */
export const EBAY_SEARCH_SORTS = [
  "newlyListed",
  "endingSoonest",
  "price",
  "-price",
  "distance",
] as const;
export type EbaySearchSort = (typeof EBAY_SEARCH_SORTS)[number];

/**
 * The SMALL Loxep-owned filter shape (see the module doc). Every field is
 * optional; an empty/absent filter set produces no `filter` parameter at all.
 */
export interface EbaySearchFilters {
  /** Inclusive lower price bound, decimal string. Needs `priceCurrency`. */
  priceMin?: string;
  /** Inclusive upper price bound, decimal string. Needs `priceCurrency`. */
  priceMax?: string;
  /** ISO-4217 code; REQUIRED by eBay whenever a price bound is given. */
  priceCurrency?: string;
  buyingOptions?: readonly EbayBuyingOption[];
  conditions?: readonly EbayConditionGroup[];
  /** Numeric eBay condition ids (e.g. "1000", "3000"). */
  conditionIds?: readonly string[];
  /**
   * Restrict to these seller usernames (Browse filter `sellers`, documented
   * maximum {@link MAX_SELLERS_PER_FILTER}). This narrows a search; it does
   * NOT anchor one — see the module doc.
   */
  sellers?: readonly string[];
  /** Only listings created at/after this instant (Browse `itemStartDate`). */
  listedAfter?: Date | string;
}

export interface EbayListingSummary {
  /** RESTful Browse item id (`v1|…|0`). */
  externalItemId: string;
  /** Legacy numeric Trading item id when eBay supplies it. */
  legacyItemId: string | null;
  marketplace: string;
  title: string | null;
  /** Decimal string, verbatim from the provider (never a JS float). */
  price: string | null;
  /** ISO-4217 code that goes with `price`. */
  currency: string | null;
  canonicalUrl: string | null;
  sellerExternalId: string | null;
  sellerFeedbackScore: number | null;
  /** Decimal string (e.g. "99.7"), verbatim from the provider. */
  sellerFeedbackPct: string | null;
  /** Human condition label, e.g. "New". */
  condition: string | null;
  /** Stable numeric condition code, e.g. "1000". */
  conditionCode: string | null;
  categoryExternalId: string | null;
  buyingOptions: string[] | null;
  /** buyingOptions lowercased/sorted/"+"-joined — same as `snapshot.ts`. */
  listingType: string | null;
  listingStartedAt: Date | null;
  listingEndsAt: Date | null;
  /** Full provider summary payload, retained for audit/replay (ADR-0009). */
  raw: Record<string, unknown>;
}

/**
 * A non-fatal complaint eBay returned alongside a 200. The ones that matter
 * are 12002 (a filter was invalid and IGNORED) and 12008 (an invalid sort was
 * ignored): both mean the page is not the page Loxep asked for.
 */
export interface EbaySearchWarning {
  errorId: number | null;
  message: string | null;
}

export interface EbaySearchPage {
  summaries: EbayListingSummary[];
  /** eBay's reported match count, or null when it did not report one. */
  total: number | null;
  /** The offset this page starts at, when reported. */
  offset: number | null;
  /** The page size eBay actually applied, when reported. */
  limit: number | null;
  /** Opaque next-page token; null when this is the last page. */
  cursor: string | null;
  /** Ignored-filter/ignored-sort complaints; empty on a clean call. */
  warnings: EbaySearchWarning[];
  fetchedAt: Date;
}

export interface SearchListingsInput {
  /** Free-text keywords. */
  query?: string;
  /** A single eBay category id to scope the search to. */
  categoryId?: string;
  filters?: EbaySearchFilters;
  sort?: EbaySearchSort;
  /** Page size, 1…{@link MAX_SEARCH_LIMIT}. Defaults to eBay's own default. */
  limit?: number;
  /** Opaque cursor from a previous {@link EbaySearchPage}. */
  cursor?: string | null;
}

/** eBay's maximum `limit` for Browse search (verified: 201 is rejected). */
export const MAX_SEARCH_LIMIT = 200;
/**
 * Deepest offset Loxep will page to. eBay documents 9999; the sandbox did
 * not reject 10000, so treat this as Loxep's own paging bound rather than a
 * provider-enforced one. Monitors that would need to page deeper should
 * narrow their search or sort by `newlyListed` instead.
 */
export const MAX_SEARCH_OFFSET = 9999;
/** eBay's documented maximum number of usernames in one `sellers` filter. */
export const MAX_SELLERS_PER_FILTER = 250;

/**
 * Characters that carry meaning in eBay's filter grammar. A value containing
 * any of them is rejected rather than escaped: there is no documented escape,
 * and silently accepting one would let a stored monitor config append
 * arbitrary filter clauses.
 */
const FILTER_RESERVED = /[,:{}[\]|]/;

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

/**
 * Exact decimal-string comparison (-1/0/1) over already-validated input.
 * Money never becomes a JS float, not even for a bounds sanity check.
 */
function compareDecimals(a: string, b: string): number {
  const parse = (value: string): { sign: bigint; int: string; frac: string } => {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value) as
      | [string, string, string, string | undefined]
      | null;
    if (match === null) {
      invalid("expected a decimal string");
    }
    return {
      sign: match[1] === "-" ? -1n : 1n,
      int: match[2],
      frac: match[3] ?? "",
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  const scale = Math.max(pa.frac.length, pb.frac.length);
  const va = pa.sign * BigInt(pa.int + pa.frac.padEnd(scale, "0"));
  const vb = pb.sign * BigInt(pb.int + pb.frac.padEnd(scale, "0"));
  return va < vb ? -1 : va > vb ? 1 : 0;
}

function invalid(message: string, detail?: Record<string, unknown>): never {
  throw new EbayAdapterError("invalid_request", message, detail ?? {});
}

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

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** eBay filter timestamps are UTC ISO-8601 with SECOND precision, no `.mmm`. */
function filterTimestamp(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    invalid(`eBay search filter "${field}" is not a valid date`, { field });
  }
  return `${date.toISOString().slice(0, 19)}Z`;
}

function checkedTerm(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    invalid(`eBay search filter "${field}" contains an empty value`, { field });
  }
  if (FILTER_RESERVED.test(trimmed)) {
    // Never echo the value: monitor configs are user data, and the message
    // travels into logs.
    invalid(
      `eBay search filter "${field}" contains a reserved character (,:{}[]|)`,
      { field },
    );
  }
  return trimmed;
}

function set(field: string, values: readonly string[]): string {
  return `${field}:{${values.join("|")}}`;
}

/**
 * Encode {@link EbaySearchFilters} into eBay's `filter` query-parameter
 * grammar. Exported for tests and for anyone who needs to see exactly what
 * Loxep sends. Returns `null` when nothing is filtered.
 *
 * Grammar produced (clauses comma-joined, in this stable order):
 *
 * ```text
 * price:[10.00..50.00]        price:[10.00]        price:[..50.00]
 * priceCurrency:USD
 * buyingOptions:{FIXED_PRICE|AUCTION}
 * conditions:{NEW|USED}
 * conditionIds:{1000|3000}
 * sellers:{alice|bob}
 * itemStartDate:[2026-08-11T00:00:00Z]
 * ```
 */
export function encodeEbaySearchFilters(
  filters: EbaySearchFilters | undefined,
): string | null {
  if (filters === undefined) return null;
  const clauses: string[] = [];

  const { priceMin, priceMax, priceCurrency } = filters;
  if (priceMin !== undefined || priceMax !== undefined) {
    for (const [field, bound] of [
      ["priceMin", priceMin],
      ["priceMax", priceMax],
    ] as const) {
      if (bound !== undefined && !DECIMAL_STRING.test(bound)) {
        invalid(`eBay search filter "${field}" must be a decimal string`, {
          field,
        });
      }
    }
    if (priceCurrency === undefined) {
      invalid(
        "eBay search price filters require priceCurrency (ISO-4217 code)",
        { field: "priceCurrency" },
      );
    }
    if (!/^[A-Z]{3}$/.test(priceCurrency)) {
      invalid("eBay search filter \"priceCurrency\" must be an ISO-4217 code", {
        field: "priceCurrency",
      });
    }
    if (
      priceMin !== undefined &&
      priceMax !== undefined &&
      compareDecimals(priceMin, priceMax) > 0
    ) {
      // Comparison only — neither bound is rewritten, both travel verbatim.
      invalid("eBay search filter priceMin is greater than priceMax");
    }
    clauses.push(`price:[${priceMin ?? ""}..${priceMax ?? ""}]`);
    clauses.push(`priceCurrency:${priceCurrency}`);
  } else if (priceCurrency !== undefined) {
    invalid("eBay search filter priceCurrency needs a price bound", {
      field: "priceCurrency",
    });
  }

  if (filters.buyingOptions !== undefined && filters.buyingOptions.length > 0) {
    for (const option of filters.buyingOptions) {
      if (!EBAY_BUYING_OPTIONS.includes(option)) {
        invalid(`unknown eBay buyingOption "${option}"`, {
          field: "buyingOptions",
        });
      }
    }
    clauses.push(set("buyingOptions", [...filters.buyingOptions]));
  }

  if (filters.conditions !== undefined && filters.conditions.length > 0) {
    for (const condition of filters.conditions) {
      if (!EBAY_CONDITION_GROUPS.includes(condition)) {
        invalid(`unknown eBay condition group "${condition}"`, {
          field: "conditions",
        });
      }
    }
    clauses.push(set("conditions", [...filters.conditions]));
  }

  if (filters.conditionIds !== undefined && filters.conditionIds.length > 0) {
    const ids = filters.conditionIds.map((id) => {
      const checked = checkedTerm(id, "conditionIds");
      if (!/^\d+$/.test(checked)) {
        invalid("eBay search filter \"conditionIds\" must be numeric ids", {
          field: "conditionIds",
        });
      }
      return checked;
    });
    clauses.push(set("conditionIds", ids));
  }

  if (filters.sellers !== undefined && filters.sellers.length > 0) {
    if (filters.sellers.length > MAX_SELLERS_PER_FILTER) {
      invalid(
        `eBay accepts at most ${MAX_SELLERS_PER_FILTER} usernames in one sellers filter`,
        { field: "sellers", max: MAX_SELLERS_PER_FILTER },
      );
    }
    clauses.push(
      set(
        "sellers",
        filters.sellers.map((seller) => checkedTerm(seller, "sellers")),
      ),
    );
  }

  if (filters.listedAfter !== undefined) {
    clauses.push(
      `itemStartDate:[${filterTimestamp(filters.listedAfter, "listedAfter")}]`,
    );
  }

  return clauses.length > 0 ? clauses.join(",") : null;
}

/**
 * Pure mapping from one raw Browse `ItemSummary` payload to the Loxep-owned
 * summary. Exported for tests; callers should use {@link searchListings}.
 */
export function mapSearchSummary(
  raw: Record<string, unknown>,
  options: { fallbackMarketplace: string },
): EbayListingSummary {
  const externalItemId = asString(raw["itemId"]);
  if (externalItemId === null) {
    throw new EbayAdapterError(
      "provider_unavailable",
      "eBay search summary has no itemId; refusing to build a listing summary",
    );
  }

  const seller = asRecord(raw["seller"]);
  const price = asRecord(raw["price"]);
  const priceValue = asString(price?.["value"]);
  const feedbackPct = asString(seller?.["feedbackPercentage"]);

  const buyingOptions = Array.isArray(raw["buyingOptions"])
    ? raw["buyingOptions"].filter((v): v is string => typeof v === "string")
    : [];

  const leafCategoryIds = Array.isArray(raw["leafCategoryIds"])
    ? raw["leafCategoryIds"].filter((v): v is string => typeof v === "string")
    : [];
  const firstCategory = Array.isArray(raw["categories"])
    ? asRecord(raw["categories"][0])
    : null;

  return {
    externalItemId,
    legacyItemId: asString(raw["legacyItemId"]),
    marketplace:
      asString(raw["listingMarketplaceId"]) ?? options.fallbackMarketplace,
    title: asString(raw["title"]),
    price:
      priceValue !== null && DECIMAL_STRING.test(priceValue)
        ? priceValue
        : null,
    currency: asString(price?.["currency"]),
    canonicalUrl: asString(raw["itemWebUrl"]),
    sellerExternalId: asString(seller?.["username"]),
    sellerFeedbackScore: asInt(seller?.["feedbackScore"]),
    sellerFeedbackPct:
      feedbackPct !== null && DECIMAL_STRING.test(feedbackPct)
        ? feedbackPct
        : null,
    condition: asString(raw["condition"]),
    conditionCode: asString(raw["conditionId"]),
    categoryExternalId:
      leafCategoryIds[0] ?? asString(firstCategory?.["categoryId"]),
    buyingOptions: buyingOptions.length > 0 ? buyingOptions : null,
    listingType:
      buyingOptions.length > 0
        ? buyingOptions
            .map((option) => option.toLowerCase())
            .sort()
            .join("+")
        : null,
    listingStartedAt: asDate(raw["itemCreationDate"]),
    listingEndsAt: asDate(raw["itemEndDate"]),
    raw,
  };
}

/** Decode an opaque cursor back into the eBay `offset` it stands for. */
function offsetFromCursor(cursor: string): number {
  if (!/^\d+$/.test(cursor)) {
    invalid("eBay search cursor is not a cursor issued by Loxep");
  }
  const offset = Number(cursor);
  if (offset > MAX_SEARCH_OFFSET) {
    invalid(
      `eBay search cannot page past offset ${MAX_SEARCH_OFFSET}; ` +
        "narrow the search or sort by newlyListed",
      { maxOffset: MAX_SEARCH_OFFSET },
    );
  }
  return offset;
}

/**
 * Derive the next cursor. eBay reports `next` as a full href; its `offset`
 * query parameter is authoritative, with `offset + returned` as the fallback
 * for a `next` we cannot parse.
 */
export function nextCursorFrom(options: {
  next: unknown;
  offset: number | null;
  returned: number;
}): string | null {
  const next = asString(options.next);
  if (next === null) return null;
  const parsedOffset = /[?&]offset=(\d+)/.exec(next)?.[1];
  const offset =
    parsedOffset !== undefined
      ? Number(parsedOffset)
      : (options.offset ?? 0) + options.returned;
  if (!Number.isSafeInteger(offset) || offset > MAX_SEARCH_OFFSET) return null;
  return String(offset);
}

/**
 * Run one page of a Browse search and return normalized summaries plus a
 * pagination cursor.
 *
 * `query` or `categoryId` is REQUIRED: eBay rejects a filter-only search with
 * errorId 12001 (verified — see the module doc), and a seller filter does not
 * satisfy it. The check is local so a guaranteed 400 never spends rate
 * budget.
 */
export async function searchListings(
  adapter: EbayAdapter,
  input: SearchListingsInput = {},
): Promise<EbaySearchPage> {
  const internals = adapterInternals(adapter);

  const query = input.query?.trim();
  const categoryId = input.categoryId?.trim();
  if (
    (query === undefined || query === "") &&
    (categoryId === undefined || categoryId === "")
  ) {
    invalid(
      "eBay search needs a query or a categoryId; the provider rejects a " +
        "filter-only search (errorId 12001)",
    );
  }
  if (categoryId !== undefined && categoryId !== "") {
    checkedTerm(categoryId, "categoryId");
  }

  if (input.limit !== undefined) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_SEARCH_LIMIT
    ) {
      invalid(`eBay search limit must be an integer 1…${MAX_SEARCH_LIMIT}`, {
        maxLimit: MAX_SEARCH_LIMIT,
      });
    }
  }
  if (input.sort !== undefined && !EBAY_SEARCH_SORTS.includes(input.sort)) {
    invalid(`unknown eBay search sort "${input.sort}"`);
  }

  const offset =
    input.cursor === undefined || input.cursor === null
      ? undefined
      : offsetFromCursor(input.cursor);
  const filter = encodeEbaySearchFilters(input.filters);

  const params: Record<string, string> = {
    ...(query !== undefined && query !== "" ? { q: query } : {}),
    ...(categoryId !== undefined && categoryId !== ""
      ? { category_ids: categoryId }
      : {}),
    ...(filter !== null ? { filter } : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : {}),
    ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
    ...(offset !== undefined ? { offset: String(offset) } : {}),
  };

  return internals.call("buy.browse.search", async () => {
    const fetchedAt = new Date();
    const response = asRecord(
      await internals.client.buy.browse.search(
        params as Parameters<typeof internals.client.buy.browse.search>[0],
      ),
    );
    if (response === null) {
      throw new EbayAdapterError(
        "provider_unavailable",
        "eBay search returned a non-object payload",
      );
    }
    const rawSummaries = Array.isArray(response["itemSummaries"])
      ? (response["itemSummaries"] as unknown[])
      : [];
    const summaries = rawSummaries.flatMap((entry) => {
      const record = asRecord(entry);
      // A summary without an itemId is unusable; skip it rather than failing
      // the whole page (eBay occasionally returns placeholder entries).
      if (record === null || asString(record["itemId"]) === null) return [];
      return [
        mapSearchSummary(record, {
          fallbackMarketplace: adapter.marketplaceId,
        }),
      ];
    });
    const responseOffset = asInt(response["offset"]);
    const warnings = (
      Array.isArray(response["warnings"]) ? response["warnings"] : []
    ).flatMap((entry): EbaySearchWarning[] => {
      const record = asRecord(entry);
      if (record === null) return [];
      return [
        {
          errorId: asInt(record["errorId"]),
          message: asString(record["message"]),
        },
      ];
    });
    return {
      summaries,
      total: asInt(response["total"]),
      offset: responseOffset,
      limit: asInt(response["limit"]),
      cursor: nextCursorFrom({
        next: response["next"],
        offset: responseOffset,
        returned: rawSummaries.length,
      }),
      warnings,
      fetchedAt,
    };
  });
}

/**
 * Page a search until `maxItems` normalized summaries are collected or eBay
 * runs out of pages. Every page spends rate budget, so `maxItems` is the
 * monitor's cost knob — `config.maxItems` on an `ebay_search` target.
 *
 * `onPage` sees each page as it arrives and may THROW to abort the rest of
 * the paging — which is how seller enumeration refuses an ignored seller
 * filter on page one instead of paying for `maxItems` worth of wrong results.
 */
export async function searchAllListings(
  adapter: EbayAdapter,
  input: SearchListingsInput & {
    maxItems: number;
    onPage?: (page: EbaySearchPage) => void;
  },
): Promise<{
  summaries: EbayListingSummary[];
  pages: number;
  total: number | null;
  /** Every page's warnings, concatenated (see {@link EbaySearchWarning}). */
  warnings: EbaySearchWarning[];
}> {
  const { maxItems, onPage, ...rest } = input;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    invalid("maxItems must be a positive integer");
  }
  const summaries: EbayListingSummary[] = [];
  const warnings: EbaySearchWarning[] = [];
  let cursor: string | null = rest.cursor ?? null;
  let pages = 0;
  let total: number | null = null;
  do {
    const remaining = maxItems - summaries.length;
    const page: EbaySearchPage = await searchListings(adapter, {
      ...rest,
      limit: Math.min(rest.limit ?? MAX_SEARCH_LIMIT, remaining, MAX_SEARCH_LIMIT),
      cursor,
    });
    pages += 1;
    onPage?.(page);
    total ??= page.total;
    summaries.push(...page.summaries);
    warnings.push(...page.warnings);
    cursor = page.cursor;
    if (page.summaries.length === 0) break;
  } while (cursor !== null && summaries.length < maxItems);
  return { summaries: summaries.slice(0, maxItems), pages, total, warnings };
}
