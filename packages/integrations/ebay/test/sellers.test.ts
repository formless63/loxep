/**
 * Seller enumeration unit tests (loxep-7dp.2). The point of these is the
 * REQUEST: seller monitoring is Browse search plus the `sellers` filter, so
 * what matters is that the filter clause, the default ordering, and the
 * one-seller-per-target rule are exactly what the adapter sends.
 */
import { describe, expect, it, vi } from "vitest";
import { adapterInternals, createEbayAdapter } from "../src/adapter.ts";
import type { EbayAdapter } from "../src/adapter.ts";
import {
  DEFAULT_SELLER_SORT,
  EBAY_ROOT_CATEGORY_ID,
  EbayAdapterError,
  SELLER_FILTER_FIELD,
  UNKNOWN_SELLER_WARNING_ID,
  createRateBudget,
  fetchAllSellerListings,
  fetchSellerListings,
  hasUnknownSellerWarning,
} from "../src/index.ts";

function stubbedAdapter(
  search: (params: Record<string, string>) => Promise<unknown>,
): { adapter: EbayAdapter; calls: Record<string, string>[] } {
  const adapter = createEbayAdapter({
    appId: "fake-app-id",
    certId: "fake-cert-id",
    devId: "fake-dev-id",
    environment: "sandbox",
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

const SUMMARY: Record<string, unknown> = {
  itemId: "v1|220000000001|0",
  title: "Seller item",
  price: { value: "12.00", currency: "USD" },
  seller: { username: "camera_shop", feedbackScore: 10, feedbackPercentage: "100.0" },
  buyingOptions: ["FIXED_PRICE"],
};

describe("fetchSellerListings", () => {
  it("enumerates one seller through the documented `sellers` filter", async () => {
    const { adapter, calls } = stubbedAdapter(async () => ({
      itemSummaries: [SUMMARY],
      total: 1,
      offset: 0,
      limit: 50,
    }));
    const result = await fetchSellerListings(adapter, {
      sellerUsername: "camera_shop",
    });
    expect(SELLER_FILTER_FIELD).toBe("sellers");
    // The whole-site category anchor is mandatory: eBay rejects a
    // filter-only search with errorId 12001.
    expect(calls[0]).toEqual({
      category_ids: EBAY_ROOT_CATEGORY_ID,
      filter: "sellers:{camera_shop}",
      sort: DEFAULT_SELLER_SORT,
    });
    expect(DEFAULT_SELLER_SORT).toBe("newlyListed");
    // Same normalized shape as a plain search.
    expect(result.summaries[0]).toMatchObject({
      externalItemId: "v1|220000000001|0",
      price: "12.00",
      currency: "USD",
      sellerExternalId: "camera_shop",
      sellerFeedbackScore: 10,
      sellerFeedbackPct: "100.0",
      listingType: "fixed_price",
    });
  });

  it("trims the username and refuses an empty one", async () => {
    const { adapter, calls } = stubbedAdapter(async () => ({ itemSummaries: [] }));
    await fetchSellerListings(adapter, { sellerUsername: "  camera_shop \n" });
    expect(calls[0]?.["filter"]).toBe("sellers:{camera_shop}");
    await expect(
      fetchSellerListings(adapter, { sellerUsername: "   " }),
    ).rejects.toThrow(EbayAdapterError);
  });

  it("uses an explicit anchor instead of the root category when given one", async () => {
    const { adapter, calls } = stubbedAdapter(async () => ({ itemSummaries: [] }));
    await fetchSellerListings(adapter, {
      sellerUsername: "camera_shop",
      categoryId: "625",
    });
    expect(calls[0]?.["category_ids"]).toBe("625");

    await fetchSellerListings(adapter, {
      sellerUsername: "camera_shop",
      query: "nikon",
    });
    // A keyword anchor satisfies eBay on its own; no category is invented.
    expect(calls[1]?.["q"]).toBe("nikon");
    expect(calls[1]?.["category_ids"]).toBeUndefined();
  });

  it("refuses a page eBay produced by DROPPING the seller filter", async () => {
    // eBay's real behaviour for an unrecognized username: warning 12003 plus
    // the anchor's entire result set. Returning that would attribute a whole
    // category to one seller.
    const { adapter } = stubbedAdapter(async () => ({
      itemSummaries: [SUMMARY, { ...SUMMARY, itemId: "v1|other|0" }],
      total: 566,
      warnings: [
        {
          errorId: UNKNOWN_SELLER_WARNING_ID,
          message: "A seller 'username' provided in the request filters is invalid.",
        },
      ],
    }));
    const error = await fetchSellerListings(adapter, {
      sellerUsername: "no_such_seller",
      categoryId: "9355",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EbayAdapterError);
    expect((error as EbayAdapterError).kind).toBe("invalid_request");
    expect((error as EbayAdapterError).detail["sellerUsername"]).toBe(
      "no_such_seller",
    );
    await expect(
      fetchAllSellerListings(adapter, {
        sellerUsername: "no_such_seller",
        categoryId: "9355",
        maxItems: 100,
        limit: 2,
      }),
    ).rejects.toThrow(EbayAdapterError);
    // Aborted on page one rather than paging to maxItems: 1 call for the
    // single-page attempt above + 1 for the paging attempt.
    expect(adapter.stats().rateBudget.acquired).toBe(2);
  });

  it("still returns a genuinely empty page for a real seller with no listings", async () => {
    const { adapter } = stubbedAdapter(async () => ({
      itemSummaries: [],
      total: 0,
    }));
    const page = await fetchSellerListings(adapter, {
      sellerUsername: "quiet_shop",
    });
    expect(page.summaries).toEqual([]);
    expect(hasUnknownSellerWarning(page.warnings)).toBe(false);
    expect(
      hasUnknownSellerWarning([
        { errorId: UNKNOWN_SELLER_WARNING_ID, message: null },
      ]),
    ).toBe(true);
  });

  it("keeps sellerUsername authoritative over anything smuggled into filters", async () => {
    const { adapter, calls } = stubbedAdapter(async () => ({ itemSummaries: [] }));
    await fetchSellerListings(adapter, {
      sellerUsername: "camera_shop",
      filters: { sellers: ["someone_else"] } as never,
    });
    expect(calls[0]?.["filter"]).toBe("sellers:{camera_shop}");
  });

  it("refuses a username carrying filter-grammar characters", async () => {
    const { adapter, calls } = stubbedAdapter(async () => ({ itemSummaries: [] }));
    await expect(
      fetchSellerListings(adapter, { sellerUsername: "a},sellers:{b" }),
    ).rejects.toThrow(EbayAdapterError);
    expect(calls).toHaveLength(0);
  });

  it("combines the seller filter with narrowing filters, query, and category", async () => {
    const { adapter, calls } = stubbedAdapter(async () => ({ itemSummaries: [] }));
    await fetchSellerListings(adapter, {
      sellerUsername: "camera_shop",
      query: "nikon",
      categoryId: "625",
      sort: "endingSoonest",
      limit: 25,
      filters: {
        priceMax: "100.00",
        priceCurrency: "USD",
        buyingOptions: ["FIXED_PRICE"],
      },
    });
    expect(calls[0]).toEqual({
      q: "nikon",
      category_ids: "625",
      filter:
        "price:[..100.00],priceCurrency:USD," +
        "buyingOptions:{FIXED_PRICE},sellers:{camera_shop}",
      sort: "endingSoonest",
      limit: "25",
    });
    expect(EBAY_ROOT_CATEGORY_ID).toBe("0");
  });

  it("round-trips the search cursor", async () => {
    const { adapter, calls } = stubbedAdapter(async () => ({
      itemSummaries: [],
      offset: 0,
      limit: 50,
      next: "https://api.ebay.com/next?offset=50",
    }));
    const first = await fetchSellerListings(adapter, {
      sellerUsername: "camera_shop",
    });
    expect(first.cursor).toBe("50");
    await fetchSellerListings(adapter, {
      sellerUsername: "camera_shop",
      cursor: first.cursor,
    });
    expect(calls[1]?.["offset"]).toBe("50");
  });
});

describe("fetchAllSellerListings", () => {
  it("pages a seller up to maxItems", async () => {
    const { adapter, calls } = stubbedAdapter(async (params) => {
      const offset = Number(params["offset"] ?? "0");
      const limit = Number(params["limit"] ?? "200");
      return {
        itemSummaries: Array.from({ length: limit }, (_, i) => ({
          ...SUMMARY,
          itemId: `v1|${offset + i}|0`,
        })),
        total: 100,
        offset,
        limit,
        next: `https://api.ebay.com/next?offset=${offset + limit}`,
      };
    });
    const result = await fetchAllSellerListings(adapter, {
      sellerUsername: "camera_shop",
      limit: 3,
      maxItems: 7,
    });
    expect(result.summaries).toHaveLength(7);
    expect(result.pages).toBe(3);
    expect(calls.every((c) => c["filter"] === "sellers:{camera_shop}")).toBe(
      true,
    );
  });
});
