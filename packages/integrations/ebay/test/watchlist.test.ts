/**
 * Watchlist adapter unit tests (loxep-62y.1.3). Pure: the Trading call is
 * stubbed with payloads shaped exactly as ebay-api's XML parser produces
 * them — `GetMyeBayBuyingResponse` unwrapped, `Item` as an array, and
 * numeric-looking identifiers already coerced to JS numbers.
 */
import { describe, expect, it, vi } from "vitest";
import type { EbayUserAdapter } from "../src/adapter.ts";
import {
  DEFAULT_WATCHLIST_ENTRIES_PER_PAGE,
  EbayAdapterError,
  WATCHLIST_CALL_NAME,
  fetchAllWatchlistEntries,
  fetchWatchlist,
  mapWatchlistItem,
  mapWatchlistResponse,
} from "../src/index.ts";

function item(
  id: number | string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ItemID: id,
    Title: `Watched item ${id}`,
    ListingDetails: {
      StartTime: "2026-08-01T09:00:00.000Z",
      EndTime: "2026-08-20T09:00:00.000Z",
      ViewItemURL: `https://www.sandbox.ebay.com/itm/${id}`,
    },
    Seller: { UserID: "sandbox_seller", FeedbackScore: 42 },
    SellingStatus: { CurrentPrice: { value: 19.99, currencyID: "USD" } },
    ...overrides,
  };
}

function response(
  items: Record<string, unknown>[],
  pagination?: { TotalNumberOfPages?: unknown; TotalNumberOfEntries?: unknown },
): Record<string, unknown> {
  return {
    Ack: "Success",
    Timestamp: "2026-08-11T10:00:00.000Z",
    Version: "1349",
    WatchList: {
      ItemArray: { Item: items },
      ...(pagination !== undefined ? { PaginationResult: pagination } : {}),
    },
  };
}

/** Structural user adapter whose only real behavior is the Trading stub. */
function stubUserAdapter(
  tradingCall: (
    callName: string,
    fields: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>,
): EbayUserAdapter {
  return { tradingCall: vi.fn(tradingCall) } as unknown as EbayUserAdapter;
}

describe("mapWatchlistItem", () => {
  it("maps the Loxep-owned fields and retains the raw payload", () => {
    const raw = item(110012345678);
    const entry = mapWatchlistItem(raw);
    expect(entry.externalItemId).toBe("110012345678");
    expect(entry.title).toBe("Watched item 110012345678");
    expect(entry.canonicalUrl).toBe(
      "https://www.sandbox.ebay.com/itm/110012345678",
    );
    expect(entry.listingEndsAt?.toISOString()).toBe("2026-08-20T09:00:00.000Z");
    expect(entry.sellerExternalId).toBe("sandbox_seller");
    expect(entry.raw).toBe(raw);
  });

  it("keeps absent facts null rather than inventing empties", () => {
    const entry = mapWatchlistItem({ ItemID: "110000000001" });
    expect(entry).toMatchObject({
      externalItemId: "110000000001",
      title: null,
      canonicalUrl: null,
      listingEndsAt: null,
      sellerExternalId: null,
    });
  });

  it("stringifies numeric seller ids and rejects unusable timestamps", () => {
    const entry = mapWatchlistItem(
      item("110000000002", {
        Seller: { UserID: 987654 },
        ListingDetails: { EndTime: "not-a-date", ViewItemURL: "" },
      }),
    );
    expect(entry.sellerExternalId).toBe("987654");
    expect(entry.listingEndsAt).toBeNull();
    expect(entry.canonicalUrl).toBeNull();
  });

  it("refuses an item payload without an ItemID", () => {
    expect(() => mapWatchlistItem({ Title: "orphan" })).toThrowError(
      EbayAdapterError,
    );
  });
});

describe("mapWatchlistResponse", () => {
  const fetchedAt = new Date("2026-08-11T10:00:00.000Z");

  it("maps entries plus pagination metadata", () => {
    const page = mapWatchlistResponse(
      response([item(1), item(2)], {
        TotalNumberOfPages: 3,
        TotalNumberOfEntries: 210,
      }),
      { fetchedAt, page: 1, entriesPerPage: 100 },
    );
    expect(page.entries.map((entry) => entry.externalItemId)).toEqual([
      "1",
      "2",
    ]);
    expect(page).toMatchObject({
      page: 1,
      entriesPerPage: 100,
      totalPages: 3,
      totalEntries: 210,
      hasMore: true,
      fetchedAt,
    });
  });

  it("reports hasMore false on the last page", () => {
    const page = mapWatchlistResponse(
      response([item(1)], { TotalNumberOfPages: 2, TotalNumberOfEntries: 101 }),
      { fetchedAt, page: 2, entriesPerPage: 100 },
    );
    expect(page.hasMore).toBe(false);
  });

  it("handles an empty watch list (the normal sandbox case)", () => {
    const page = mapWatchlistResponse(
      response([], { TotalNumberOfPages: 0, TotalNumberOfEntries: 0 }),
      { fetchedAt, page: 1, entriesPerPage: 100 },
    );
    expect(page.entries).toEqual([]);
    expect(page.totalEntries).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("handles a missing WatchList container and a single non-array Item", () => {
    expect(
      mapWatchlistResponse(
        { Ack: "Success" },
        { fetchedAt, page: 1, entriesPerPage: 100 },
      ).entries,
    ).toEqual([]);
    const single = mapWatchlistResponse(
      { WatchList: { ItemArray: { Item: item(7) } } },
      { fetchedAt, page: 1, entriesPerPage: 100 },
    );
    expect(single.entries.map((entry) => entry.externalItemId)).toEqual(["7"]);
  });

  it("falls back to a full-page heuristic without PaginationResult", () => {
    const items = Array.from({ length: 5 }, (_unused, index) => item(index + 1));
    expect(
      mapWatchlistResponse(response(items), {
        fetchedAt,
        page: 1,
        entriesPerPage: 5,
      }).hasMore,
    ).toBe(true);
    expect(
      mapWatchlistResponse(response(items), {
        fetchedAt,
        page: 1,
        entriesPerPage: 10,
      }).hasMore,
    ).toBe(false);
  });

  it("accepts numeric-string pagination counts", () => {
    const page = mapWatchlistResponse(
      response([item(1)], {
        TotalNumberOfPages: "1",
        TotalNumberOfEntries: "1",
      }),
      { fetchedAt, page: 1, entriesPerPage: 100 },
    );
    expect(page).toMatchObject({ totalPages: 1, totalEntries: 1 });
  });
});

describe("fetchWatchlist", () => {
  it("issues GetMyeBayBuying with the watch-list container and pagination", async () => {
    let seen: { callName: string; fields: Record<string, unknown> } | null =
      null;
    const adapter = stubUserAdapter(async (callName, fields) => {
      seen = { callName, fields };
      return response([item(1)], {
        TotalNumberOfPages: 1,
        TotalNumberOfEntries: 1,
      });
    });

    const page = await fetchWatchlist(adapter, { page: 2, entriesPerPage: 25 });
    expect(seen).toEqual({
      callName: WATCHLIST_CALL_NAME,
      fields: {
        WatchList: {
          Include: true,
          Pagination: { EntriesPerPage: 25, PageNumber: 2 },
        },
        DetailLevel: "ReturnAll",
      },
    });
    expect(page.entries).toHaveLength(1);
    expect(page.page).toBe(2);
  });

  it("defaults to page 1 with the documented page size", async () => {
    const adapter = stubUserAdapter(async (_callName, fields) => {
      expect(fields).toMatchObject({
        WatchList: {
          Pagination: {
            EntriesPerPage: DEFAULT_WATCHLIST_ENTRIES_PER_PAGE,
            PageNumber: 1,
          },
        },
      });
      return response([]);
    });
    await fetchWatchlist(adapter);
  });

  it("rejects out-of-range paging before spending a provider call", async () => {
    const tradingCall = vi.fn(async () => response([]));
    const adapter = stubUserAdapter(tradingCall);
    for (const input of [
      { page: 0 },
      { page: -1 },
      { page: 1.5 },
      { entriesPerPage: 0 },
      { entriesPerPage: 201 },
    ]) {
      await expect(fetchWatchlist(adapter, input)).rejects.toThrowError(
        EbayAdapterError,
      );
    }
    expect(tradingCall).not.toHaveBeenCalled();
  });

  it("propagates the adapter's normalized taxonomy errors unchanged", async () => {
    const adapter = stubUserAdapter(async () => {
      throw new EbayAdapterError("auth", "eBay rejected the user token");
    });
    const error = await fetchWatchlist(adapter).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EbayAdapterError);
    expect((error as EbayAdapterError).kind).toBe("auth");
  });
});

describe("fetchAllWatchlistEntries", () => {
  it("walks pages until the provider says there are no more", async () => {
    const pages: Record<string, unknown>[] = [
      response([item(1), item(2)], {
        TotalNumberOfPages: 2,
        TotalNumberOfEntries: 3,
      }),
      response([item(3)], {
        TotalNumberOfPages: 2,
        TotalNumberOfEntries: 3,
      }),
    ];
    const adapter = stubUserAdapter(async (_callName, fields) => {
      const watchList = fields["WatchList"] as {
        Pagination: { PageNumber: number };
      };
      return pages[watchList.Pagination.PageNumber - 1] as Record<
        string,
        unknown
      >;
    });
    const result = await fetchAllWatchlistEntries(adapter, {
      entriesPerPage: 2,
    });
    expect(result.entries.map((entry) => entry.externalItemId)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(result).toMatchObject({ pages: 2, truncated: false });
  });

  it("de-duplicates ids repeated across a page boundary", async () => {
    const pages: Record<string, unknown>[] = [
      response([item(1), item(2)], { TotalNumberOfPages: 2 }),
      response([item(2), item(3)], { TotalNumberOfPages: 2 }),
    ];
    const adapter = stubUserAdapter(async (_callName, fields) => {
      const watchList = fields["WatchList"] as {
        Pagination: { PageNumber: number };
      };
      return pages[watchList.Pagination.PageNumber - 1] as Record<
        string,
        unknown
      >;
    });
    const result = await fetchAllWatchlistEntries(adapter, {
      entriesPerPage: 2,
    });
    expect(result.entries.map((entry) => entry.externalItemId)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("stops at maxPages and reports truncation", async () => {
    const adapter = stubUserAdapter(async (_callName, fields) => {
      const watchList = fields["WatchList"] as {
        Pagination: { PageNumber: number };
      };
      return response([item(watchList.Pagination.PageNumber)], {
        TotalNumberOfPages: 99,
      });
    });
    const result = await fetchAllWatchlistEntries(adapter, {
      entriesPerPage: 1,
      maxPages: 3,
    });
    expect(result).toMatchObject({ pages: 3, truncated: true });
    expect(result.entries).toHaveLength(3);
  });
});
