/**
 * Browse search adapter unit tests (loxep-7dp.1). Pure: the provider call is
 * stubbed on the real client instance the adapter built, so the assertions
 * cover the exact query parameters Loxep sends and the exact normalization it
 * performs — including that every call still spends rate budget and that
 * provider failures still leave as {@link EbayAdapterError}.
 */
import { describe, expect, it, vi } from "vitest";
import { adapterInternals, createEbayAdapter } from "../src/adapter.ts";
import type { EbayAdapter } from "../src/adapter.ts";
import {
  EbayAdapterError,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_OFFSET,
  createRateBudget,
  encodeEbaySearchFilters,
  mapSearchSummary,
  nextCursorFrom,
  searchAllListings,
  searchListings,
} from "../src/index.ts";

const FAKE_CONFIG = {
  appId: "fake-app-id",
  certId: "fake-cert-id",
  devId: "fake-dev-id",
  environment: "sandbox",
} as const;

/**
 * A real adapter whose provider `buy.browse.search` is replaced. The rest of
 * the boundary (rate budget, error normalization, marketplace fallback) is
 * the production code path.
 */
function stubbedAdapter(
  search: (params: Record<string, string>) => Promise<unknown>,
): { adapter: EbayAdapter; calls: Record<string, string>[] } {
  const adapter = createEbayAdapter({
    ...FAKE_CONFIG,
    rateBudget: createRateBudget({ capacity: 50, refillPerSecond: 50 }),
  });
  const calls: Record<string, string>[] = [];
  const client = adapterInternals(adapter).client;
  vi.spyOn(client.buy.browse, "search").mockImplementation(
    (async (params: Record<string, string>) => {
      calls.push({ ...params });
      return search(params);
    }) as unknown as typeof client.buy.browse.search,
  );
  return { adapter, calls };
}

function page(
  summaries: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { itemSummaries: summaries, total: summaries.length, ...extra };
}

const FULL_SUMMARY: Record<string, unknown> = {
  itemId: "v1|110012345678|0",
  legacyItemId: "110012345678",
  listingMarketplaceId: "EBAY_GB",
  title: "Nikon FM2 body",
  price: { value: "249.95", currency: "GBP" },
  itemWebUrl: "https://www.ebay.co.uk/itm/110012345678",
  seller: {
    username: "camera_shop",
    feedbackScore: 4211,
    feedbackPercentage: "99.7",
  },
  condition: "Used",
  conditionId: "3000",
  leafCategoryIds: ["15230"],
  categories: [{ categoryId: "625", categoryName: "Cameras" }],
  buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
  itemCreationDate: "2026-08-10T09:00:00.000Z",
  itemEndDate: "2026-09-09T09:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Filter grammar
// ---------------------------------------------------------------------------

describe("encodeEbaySearchFilters", () => {
  it("encodes nothing when there is nothing to filter", () => {
    expect(encodeEbaySearchFilters(undefined)).toBeNull();
    expect(encodeEbaySearchFilters({})).toBeNull();
    expect(
      encodeEbaySearchFilters({ sellers: [], buyingOptions: [] }),
    ).toBeNull();
  });

  it("encodes a closed price range with its mandatory currency", () => {
    expect(
      encodeEbaySearchFilters({
        priceMin: "10.00",
        priceMax: "50.00",
        priceCurrency: "USD",
      }),
    ).toBe("price:[10.00..50.00],priceCurrency:USD");
  });

  it("encodes open-ended price bounds", () => {
    expect(
      encodeEbaySearchFilters({ priceMin: "10", priceCurrency: "USD" }),
    ).toBe("price:[10..],priceCurrency:USD");
    expect(
      encodeEbaySearchFilters({ priceMax: "50", priceCurrency: "USD" }),
    ).toBe("price:[..50],priceCurrency:USD");
  });

  it("rejects a price bound without a currency, and a currency without a bound", () => {
    expect(() => encodeEbaySearchFilters({ priceMin: "10" })).toThrow(
      EbayAdapterError,
    );
    expect(() => encodeEbaySearchFilters({ priceCurrency: "USD" })).toThrow(
      EbayAdapterError,
    );
  });

  it("rejects non-decimal, inverted, and non-ISO-4217 money input", () => {
    expect(() =>
      encodeEbaySearchFilters({ priceMin: "10,00", priceCurrency: "USD" }),
    ).toThrow(EbayAdapterError);
    expect(() =>
      encodeEbaySearchFilters({
        priceMin: "50",
        priceMax: "10",
        priceCurrency: "USD",
      }),
    ).toThrow(/priceMin is greater than priceMax/);
    // Exact decimal comparison, not float math: 10.00 == 10 is not inverted,
    // and a value past float precision still compares correctly.
    expect(
      encodeEbaySearchFilters({
        priceMin: "10.00",
        priceMax: "10",
        priceCurrency: "USD",
      }),
    ).toBe("price:[10.00..10],priceCurrency:USD");
    expect(() =>
      encodeEbaySearchFilters({
        priceMin: "9007199254740993",
        priceMax: "9007199254740992",
        priceCurrency: "USD",
      }),
    ).toThrow(/priceMin is greater than priceMax/);
    expect(() =>
      encodeEbaySearchFilters({ priceMin: "10", priceCurrency: "usd" }),
    ).toThrow(EbayAdapterError);
  });

  it("encodes set-valued filters with eBay's brace/pipe syntax", () => {
    expect(
      encodeEbaySearchFilters({
        buyingOptions: ["FIXED_PRICE", "AUCTION"],
        conditions: ["NEW", "USED"],
        conditionIds: ["1000", "3000"],
        sellers: ["alice", "bob"],
      }),
    ).toBe(
      "buyingOptions:{FIXED_PRICE|AUCTION}," +
        "conditions:{NEW|USED}," +
        "conditionIds:{1000|3000}," +
        "sellers:{alice|bob}",
    );
  });

  it("emits clauses in a stable order regardless of key order", () => {
    const a = encodeEbaySearchFilters({
      sellers: ["alice"],
      priceMin: "1",
      priceCurrency: "USD",
      conditions: ["NEW"],
    });
    const b = encodeEbaySearchFilters({
      conditions: ["NEW"],
      priceCurrency: "USD",
      priceMin: "1",
      sellers: ["alice"],
    });
    expect(a).toBe(b);
    expect(a).toBe(
      "price:[1..],priceCurrency:USD,conditions:{NEW},sellers:{alice}",
    );
  });

  it("encodes listedAfter as a second-precision UTC instant, from a Date or a string", () => {
    expect(
      encodeEbaySearchFilters({
        listedAfter: new Date("2026-08-11T12:34:56.789Z"),
      }),
    ).toBe("itemStartDate:[2026-08-11T12:34:56Z]");
    expect(
      encodeEbaySearchFilters({ listedAfter: "2026-08-11T12:34:56.789Z" }),
    ).toBe("itemStartDate:[2026-08-11T12:34:56Z]");
    expect(() => encodeEbaySearchFilters({ listedAfter: "not a date" })).toThrow(
      EbayAdapterError,
    );
  });

  it("refuses values carrying the grammar's reserved characters, without echoing them", () => {
    const error = (() => {
      try {
        encodeEbaySearchFilters({ sellers: ["alice},price:[0..1],x:{y"] });
        return null;
      } catch (e) {
        return e as EbayAdapterError;
      }
    })();
    expect(error).toBeInstanceOf(EbayAdapterError);
    expect(error?.kind).toBe("invalid_request");
    // The offending value must not travel into logs.
    expect(error?.message).not.toContain("alice}");
    expect(JSON.stringify(error?.detail)).not.toContain("alice}");
    expect(() => encodeEbaySearchFilters({ sellers: ["  "] })).toThrow(
      EbayAdapterError,
    );
  });

  it("rejects unknown enumerated values and non-numeric condition ids", () => {
    expect(() =>
      encodeEbaySearchFilters({
        buyingOptions: ["BUY_IT_NOW" as unknown as "AUCTION"],
      }),
    ).toThrow(EbayAdapterError);
    expect(() =>
      encodeEbaySearchFilters({ conditions: ["BROKEN" as unknown as "NEW"] }),
    ).toThrow(EbayAdapterError);
    expect(() => encodeEbaySearchFilters({ conditionIds: ["NEW"] })).toThrow(
      EbayAdapterError,
    );
  });
});

// ---------------------------------------------------------------------------
// Summary mapping
// ---------------------------------------------------------------------------

describe("mapSearchSummary", () => {
  it("maps every Loxep-owned field from a full summary", () => {
    const summary = mapSearchSummary(FULL_SUMMARY, {
      fallbackMarketplace: "EBAY_US",
    });
    expect(summary).toMatchObject({
      externalItemId: "v1|110012345678|0",
      legacyItemId: "110012345678",
      marketplace: "EBAY_GB",
      title: "Nikon FM2 body",
      price: "249.95",
      currency: "GBP",
      canonicalUrl: "https://www.ebay.co.uk/itm/110012345678",
      sellerExternalId: "camera_shop",
      sellerFeedbackScore: 4211,
      sellerFeedbackPct: "99.7",
      condition: "Used",
      conditionCode: "3000",
      categoryExternalId: "15230",
      buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
      listingType: "best_offer+fixed_price",
    });
    expect(summary.listingStartedAt?.toISOString()).toBe(
      "2026-08-10T09:00:00.000Z",
    );
    expect(summary.listingEndsAt?.toISOString()).toBe(
      "2026-09-09T09:00:00.000Z",
    );
    expect(summary.raw).toBe(FULL_SUMMARY);
  });

  it("keeps absent facts null and falls back to the adapter marketplace", () => {
    const summary = mapSearchSummary(
      { itemId: "v1|1|0" },
      { fallbackMarketplace: "EBAY_US" },
    );
    expect(summary).toEqual({
      externalItemId: "v1|1|0",
      legacyItemId: null,
      marketplace: "EBAY_US",
      title: null,
      price: null,
      currency: null,
      canonicalUrl: null,
      sellerExternalId: null,
      sellerFeedbackScore: null,
      sellerFeedbackPct: null,
      condition: null,
      conditionCode: null,
      categoryExternalId: null,
      buyingOptions: null,
      listingType: null,
      listingStartedAt: null,
      listingEndsAt: null,
      raw: { itemId: "v1|1|0" },
    });
  });

  it("falls back from leafCategoryIds to categories[0]", () => {
    const summary = mapSearchSummary(
      { itemId: "v1|1|0", categories: [{ categoryId: "625" }] },
      { fallbackMarketplace: "EBAY_US" },
    );
    expect(summary.categoryExternalId).toBe("625");
  });

  it("drops money that is not a decimal string rather than coercing it", () => {
    const summary = mapSearchSummary(
      { itemId: "v1|1|0", price: { value: 249.95, currency: "USD" } },
      { fallbackMarketplace: "EBAY_US" },
    );
    expect(summary.price).toBeNull();
    expect(summary.currency).toBe("USD");
  });

  it("refuses a summary with no itemId", () => {
    expect(() =>
      mapSearchSummary({ title: "no id" }, { fallbackMarketplace: "EBAY_US" }),
    ).toThrow(EbayAdapterError);
  });
});

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

describe("nextCursorFrom", () => {
  it("is null on the last page", () => {
    expect(nextCursorFrom({ next: undefined, offset: 0, returned: 5 })).toBeNull();
    expect(nextCursorFrom({ next: null, offset: 0, returned: 5 })).toBeNull();
  });

  it("prefers the offset eBay put in its own next href", () => {
    expect(
      nextCursorFrom({
        next: "https://api.ebay.com/buy/browse/v1/item_summary/search?q=x&limit=50&offset=150",
        offset: 100,
        returned: 50,
      }),
    ).toBe("150");
  });

  it("falls back to offset + returned when next carries no offset", () => {
    expect(
      nextCursorFrom({ next: "https://api.ebay.com/next", offset: 100, returned: 50 }),
    ).toBe("150");
    expect(
      nextCursorFrom({ next: "https://api.ebay.com/next", offset: null, returned: 25 }),
    ).toBe("25");
  });

  it("stops rather than pointing past eBay's maximum offset", () => {
    expect(
      nextCursorFrom({
        next: `https://api.ebay.com/next?offset=${MAX_SEARCH_OFFSET + 1}`,
        offset: MAX_SEARCH_OFFSET,
        returned: 200,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// searchListings
// ---------------------------------------------------------------------------

describe("searchListings", () => {
  it("sends exactly the parameters Loxep asked for", async () => {
    const { adapter, calls } = stubbedAdapter(async () =>
      page([FULL_SUMMARY], { offset: 0, limit: 2, total: 7 }),
    );
    await searchListings(adapter, {
      query: "  nikon fm2  ",
      categoryId: "625",
      sort: "newlyListed",
      limit: 2,
      filters: { conditions: ["USED"], sellers: ["camera_shop"] },
    });
    expect(calls[0]).toEqual({
      q: "nikon fm2",
      category_ids: "625",
      filter: "conditions:{USED},sellers:{camera_shop}",
      sort: "newlyListed",
      limit: "2",
    });
  });

  it("omits the filter and offset parameters when there is nothing to send", async () => {
    const { adapter, calls } = stubbedAdapter(async () => page([]));
    await searchListings(adapter, { query: "nikon" });
    expect(calls[0]).toEqual({ q: "nikon" });
  });

  it("normalizes summaries and reports pagination", async () => {
    const { adapter } = stubbedAdapter(async () =>
      page([FULL_SUMMARY], {
        offset: 100,
        limit: 50,
        total: 320,
        next: "https://api.ebay.com/next?offset=150",
      }),
    );
    const result = await searchListings(adapter, { query: "nikon" });
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]?.externalItemId).toBe("v1|110012345678|0");
    expect(result).toMatchObject({
      total: 320,
      offset: 100,
      limit: 50,
      cursor: "150",
      warnings: [],
    });
    expect(result.fetchedAt).toBeInstanceOf(Date);
  });

  it("round-trips its own cursor into the next request's offset", async () => {
    const { adapter, calls } = stubbedAdapter(async () =>
      page([], { next: "https://api.ebay.com/next?offset=300" }),
    );
    const first = await searchListings(adapter, { query: "nikon" });
    await searchListings(adapter, { query: "nikon", cursor: first.cursor });
    expect(calls[1]?.["offset"]).toBe("300");
  });

  it("tolerates a page with no results and one with unusable entries", async () => {
    const { adapter } = stubbedAdapter(async () =>
      page([{ title: "placeholder" }, FULL_SUMMARY], { total: 0 }),
    );
    const result = await searchListings(adapter, { query: "nikon" });
    expect(result.summaries).toHaveLength(1);
    expect(result.cursor).toBeNull();
  });

  it("refuses a filter-only search before spending budget (provider errorId 12001)", async () => {
    const { adapter, calls } = stubbedAdapter(async () => page([]));
    await expect(searchListings(adapter, {})).rejects.toThrow(EbayAdapterError);
    // A seller filter is NOT an anchor — verified against the live sandbox.
    await expect(
      searchListings(adapter, { filters: { sellers: ["camera_shop"] } }),
    ).rejects.toThrow(/needs a query or a categoryId/);
    expect(calls).toHaveLength(0);
    expect(adapter.stats().rateBudget.acquired).toBe(0);
  });

  it("accepts a category as the sole anchor", async () => {
    const { adapter, calls } = stubbedAdapter(async () => page([]));
    await searchListings(adapter, {
      categoryId: "625",
      filters: { sellers: ["camera_shop"] },
    });
    expect(calls[0]).toEqual({
      category_ids: "625",
      filter: "sellers:{camera_shop}",
    });
  });

  it("surfaces the warnings that mean eBay ignored a filter or a sort", async () => {
    const { adapter } = stubbedAdapter(async () =>
      page([], {
        warnings: [
          { errorId: 12002, message: "The x filter value is invalid." },
          "not an object",
          { message: "no id" },
        ],
      }),
    );
    const result = await searchListings(adapter, { query: "x" });
    expect(result.warnings).toEqual([
      { errorId: 12002, message: "The x filter value is invalid." },
      { errorId: null, message: "no id" },
    ]);
  });

  it("reports no warnings on a clean call", async () => {
    const { adapter } = stubbedAdapter(async () => page([FULL_SUMMARY]));
    expect((await searchListings(adapter, { query: "x" })).warnings).toEqual([]);
  });

  it("rejects more sellers than eBay accepts in one filter", async () => {
    const { adapter } = stubbedAdapter(async () => page([]));
    await expect(
      searchListings(adapter, {
        query: "x",
        filters: {
          sellers: Array.from({ length: 251 }, (_, i) => `seller${i}`),
        },
      }),
    ).rejects.toThrow(/at most 250 usernames/);
  });

  it("rejects out-of-range limits, unknown sorts, and foreign cursors", async () => {
    const { adapter } = stubbedAdapter(async () => page([]));
    await expect(
      searchListings(adapter, { query: "x", limit: 0 }),
    ).rejects.toThrow(EbayAdapterError);
    await expect(
      searchListings(adapter, { query: "x", limit: MAX_SEARCH_LIMIT + 1 }),
    ).rejects.toThrow(EbayAdapterError);
    await expect(
      searchListings(adapter, {
        query: "x",
        sort: "cheapest" as unknown as "price",
      }),
    ).rejects.toThrow(EbayAdapterError);
    await expect(
      searchListings(adapter, { query: "x", cursor: "https://evil/next" }),
    ).rejects.toThrow(EbayAdapterError);
    await expect(
      searchListings(adapter, {
        query: "x",
        cursor: String(MAX_SEARCH_OFFSET + 1),
      }),
    ).rejects.toThrow(EbayAdapterError);
  });

  it("spends the connection rate budget on every call", async () => {
    const { adapter } = stubbedAdapter(async () => page([]));
    await searchListings(adapter, { query: "a" });
    await searchListings(adapter, { query: "b" });
    expect(adapter.stats().rateBudget.acquired).toBe(2);
  });

  it("normalizes provider failures into the Loxep error taxonomy", async () => {
    const { adapter } = stubbedAdapter(async () => {
      throw Object.assign(new Error("boom"), { response: { status: 500 } });
    });
    const error = await searchListings(adapter, { query: "x" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EbayAdapterError);
    expect((error as EbayAdapterError).kind).toBe("provider_unavailable");
  });

  it("refuses a non-object payload rather than inventing an empty page", async () => {
    const { adapter } = stubbedAdapter(async () => "not a page");
    await expect(searchListings(adapter, { query: "x" })).rejects.toThrow(
      EbayAdapterError,
    );
  });
});

// ---------------------------------------------------------------------------
// searchAllListings
// ---------------------------------------------------------------------------

describe("searchAllListings", () => {
  function summary(n: number): Record<string, unknown> {
    return { ...FULL_SUMMARY, itemId: `v1|${n}|0` };
  }

  it("pages until maxItems is reached and never over-fetches", async () => {
    const { adapter, calls } = stubbedAdapter(async (params) => {
      const offset = Number(params["offset"] ?? "0");
      const limit = Number(params["limit"] ?? "200");
      const items = Array.from({ length: limit }, (_, i) =>
        summary(offset + i),
      );
      return page(items, {
        offset,
        limit,
        total: 500,
        next: `https://api.ebay.com/next?offset=${offset + limit}`,
      });
    });
    const result = await searchAllListings(adapter, {
      query: "nikon",
      limit: 4,
      maxItems: 10,
    });
    expect(result.summaries).toHaveLength(10);
    expect(result.pages).toBe(3);
    expect(result.total).toBe(500);
    // Last page asks only for what is still missing.
    expect(calls.map((c) => c["limit"])).toEqual(["4", "4", "2"]);
    expect(new Set(result.summaries.map((s) => s.externalItemId)).size).toBe(10);
  });

  it("stops when eBay runs out of pages", async () => {
    const { adapter } = stubbedAdapter(async () =>
      page([summary(1), summary(2)], { offset: 0, limit: 50, total: 2 }),
    );
    const result = await searchAllListings(adapter, {
      query: "nikon",
      maxItems: 100,
    });
    expect(result.summaries).toHaveLength(2);
    expect(result.pages).toBe(1);
  });

  it("stops on an empty page even when eBay keeps offering a next cursor", async () => {
    const { adapter } = stubbedAdapter(async () =>
      page([], { offset: 0, limit: 50, next: "https://api.ebay.com/next?offset=50" }),
    );
    const result = await searchAllListings(adapter, {
      query: "nikon",
      maxItems: 100,
    });
    expect(result.summaries).toHaveLength(0);
    expect(result.pages).toBe(1);
  });

  it("rejects a non-positive maxItems", async () => {
    const { adapter } = stubbedAdapter(async () => page([]));
    await expect(
      searchAllListings(adapter, { query: "x", maxItems: 0 }),
    ).rejects.toThrow(EbayAdapterError);
  });
});
