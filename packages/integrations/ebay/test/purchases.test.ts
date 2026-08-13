/**
 * WonList mapper unit tests (loxep-dgf.5).
 *
 * SANDBOX-UNVERIFIABLE: unlike `watchlist.test.ts`/`orders.test.ts`, these
 * fixtures are not backed by a captured live response — `GetMyeBayBuying`
 * returns no container at all in this environment's sandbox (loxep-76k,
 * reproduced in `watchlist.ts`'s module doc), and `WonList` inherits that
 * defect. The payload shapes below are DESIGN-DERIVED from eBay's published
 * Trading API reference (see `purchases.ts`'s module doc) and exercise the
 * mapper's structure and defensive-null discipline, not provider fidelity.
 * Verifying the real shape needs a production account; until then this
 * mapper ships marked unverified, exactly as the watchlist vertical did.
 */
import { describe, expect, it, vi } from "vitest";
import type { EbayUserAdapter } from "../src/adapter.ts";
import {
  DEFAULT_WON_LIST_ENTRIES_PER_PAGE,
  EbayAdapterError,
  WON_LIST_CALL_NAME,
  fetchAllWonPurchases,
  fetchWonList,
  groupWonListEntries,
  mapWonListResponse,
  mapWonListTransaction,
} from "../src/index.ts";

function transaction(
  transactionId: number | string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    TransactionID: transactionId,
    Item: { ItemID: 110000000000 + Number(transactionId), Title: `Won item ${transactionId}`, SKU: "SKU-1" },
    Seller: { UserID: "sandbox_seller" },
    TransactionPrice: { value: 19.99, currencyID: "USD" },
    QuantityPurchased: 1,
    CreatedDate: "2026-08-10T12:00:00.000Z",
    ShippingDetails: {
      ShippingServiceOptions: { ShippingServiceCost: { value: 4.5, currencyID: "USD" } },
      SalesTax: { SalesTaxAmount: { value: 1.75, currencyID: "USD" } },
    },
    ...overrides,
  };
}

function entry(
  transactionId: number | string,
  overrides: {
    transaction?: Record<string, unknown>;
    order?: Record<string, unknown> | null;
  } = {},
): Record<string, unknown> {
  return {
    Transaction: overrides.transaction ?? transaction(transactionId),
    ...(overrides.order === undefined ? {} : { Order: overrides.order }),
  };
}

function wonListResponse(
  entries: Record<string, unknown>[],
  pagination?: { TotalNumberOfPages?: unknown; TotalNumberOfEntries?: unknown },
): Record<string, unknown> {
  return {
    Ack: "Success",
    WonList: {
      OrderTransactionArray: { OrderTransaction: entries },
      ...(pagination !== undefined ? { PaginationResult: pagination } : {}),
    },
  };
}

function stubUserAdapter(
  tradingCall: (
    callName: string,
    fields: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>,
): EbayUserAdapter {
  return { tradingCall: vi.fn(tradingCall) } as unknown as EbayUserAdapter;
}

describe("mapWonListTransaction", () => {
  it("maps the Loxep-owned fields", () => {
    const line = mapWonListTransaction(transaction(1));
    expect(line).toMatchObject({
      externalTransactionId: "1",
      externalItemId: "110000000001",
      title: "Won item 1",
      sku: "SKU-1",
      quantity: "1",
      lineAmount: "19.99",
      shippingAmount: "4.5",
      taxAmount: "1.75",
      purchasedAt: "2026-08-10T12:00:00.000Z",
      sellerExternalId: "sandbox_seller",
    });
  });

  it("keeps absent facts null/zero rather than inventing values", () => {
    const line = mapWonListTransaction({ TransactionID: "2" });
    expect(line).toMatchObject({
      externalTransactionId: "2",
      externalItemId: null,
      title: null,
      sku: null,
      quantity: "1",
      lineAmount: "0.00",
      shippingAmount: "0.00",
      taxAmount: "0.00",
      purchasedAt: null,
      sellerExternalId: null,
    });
  });

  it("refuses a transaction payload without a TransactionID", () => {
    expect(() => mapWonListTransaction({ Item: { Title: "orphan" } })).toThrowError(
      EbayAdapterError,
    );
  });

  it("falls back to AmountPaid when TransactionPrice is absent", () => {
    const line = mapWonListTransaction(
      transaction(3, { TransactionPrice: undefined, AmountPaid: { value: 9.5, currencyID: "USD" } }),
    );
    expect(line.lineAmount).toBe("9.5");
  });

  it("accepts a single (non-array) ShippingServiceOptions entry", () => {
    const line = mapWonListTransaction(
      transaction(4, {
        ShippingDetails: {
          ShippingServiceOptions: [{ ShippingServiceCost: { value: 2, currencyID: "USD" } }],
        },
      }),
    );
    expect(line.shippingAmount).toBe("2");
  });
});

describe("groupWonListEntries", () => {
  it("keeps a standalone purchase as its own single-line fact", () => {
    const [fact] = groupWonListEntries([entry(1)]);
    expect(fact).toBeDefined();
    expect(fact).toMatchObject({
      externalOrderId: "txn:1",
      isCombinedOrder: false,
      currency: "USD",
      title: "Won item 1",
      itemPriceAmount: "19.99",
      shippingAmount: "4.5",
      taxAmount: "1.75",
      totalAmount: "26.24",
      sellerExternalId: "sandbox_seller",
    });
    expect(fact?.lines).toHaveLength(1);
    expect(fact?.raw).toHaveLength(1);
  });

  it("folds transactions sharing one Order.OrderID into one fact", () => {
    const order = {
      OrderID: "11-22222-33333",
      OrderStatus: "Completed",
      CreatedTime: "2026-08-09T08:00:00.000Z",
    };
    const facts = groupWonListEntries([
      entry(10, { order, transaction: transaction(10, { TransactionPrice: { value: 10, currencyID: "USD" } }) }),
      entry(11, { order, transaction: transaction(11, { TransactionPrice: { value: 20, currencyID: "USD" } }) }),
    ]);
    expect(facts).toHaveLength(1);
    const [fact] = facts;
    expect(fact).toMatchObject({
      externalOrderId: "11-22222-33333",
      isCombinedOrder: true,
      itemPriceAmount: "30",
      purchasedAt: "2026-08-09T08:00:00.000Z",
      title: "2 items from sandbox_seller",
    });
    expect(fact?.lines).toHaveLength(2);
  });

  it("prefers the Order's own total/shipping when reported", () => {
    const order = {
      OrderID: "44-55555-66666",
      Total: { value: 100, currencyID: "USD" },
      ShippingServiceSelected: { ShippingServiceCost: { value: 7, currencyID: "USD" } },
    };
    const [fact] = groupWonListEntries([entry(20, { order })]);
    expect(fact).toMatchObject({ totalAmount: "100", shippingAmount: "7" });
  });

  it("derives purchasedAt from the earliest line when no Order.CreatedTime exists", () => {
    const order = { OrderID: "77-88888-99999" };
    const facts = groupWonListEntries([
      entry(30, { order, transaction: transaction(30, { CreatedDate: "2026-08-05T00:00:00.000Z" }) }),
      entry(31, { order, transaction: transaction(31, { CreatedDate: "2026-08-01T00:00:00.000Z" }) }),
    ]);
    expect(facts[0]?.purchasedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("preserves group first-seen order across the result array", () => {
    const facts = groupWonListEntries([entry(1), entry(2), entry(1)]);
    expect(facts.map((fact) => fact.externalOrderId)).toEqual(["txn:1", "txn:2"]);
    expect(facts[0]?.lines).toHaveLength(2);
  });
});

describe("mapWonListResponse", () => {
  const fetchedAt = new Date("2026-08-11T10:00:00.000Z");

  it("maps ungrouped entries plus pagination metadata", () => {
    const page = mapWonListResponse(
      wonListResponse([entry(1), entry(2)], { TotalNumberOfPages: 3, TotalNumberOfEntries: 210 }),
      { fetchedAt, page: 1, entriesPerPage: 100 },
    );
    expect(page.entries).toHaveLength(2);
    expect(page).toMatchObject({ page: 1, entriesPerPage: 100, totalPages: 3, totalEntries: 210, hasMore: true, fetchedAt });
  });

  it("handles a missing WonList container (the documented sandbox defect)", () => {
    const page = mapWonListResponse({ Ack: "Success" }, { fetchedAt, page: 1, entriesPerPage: 100 });
    expect(page.entries).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("accepts a single (non-array) OrderTransaction", () => {
    const page = mapWonListResponse(
      { WonList: { OrderTransactionArray: { OrderTransaction: entry(9) } } },
      { fetchedAt, page: 1, entriesPerPage: 100 },
    );
    expect(page.entries).toHaveLength(1);
  });
});

describe("fetchWonList", () => {
  it("issues GetMyeBayBuying with the WonList container and pagination", async () => {
    let seen: { callName: string; fields: Record<string, unknown> } | null = null;
    const adapter = stubUserAdapter(async (callName, fields) => {
      seen = { callName, fields };
      return wonListResponse([entry(1)], { TotalNumberOfPages: 1, TotalNumberOfEntries: 1 });
    });
    const page = await fetchWonList(adapter, { page: 2, entriesPerPage: 25 });
    expect(seen).toEqual({
      callName: WON_LIST_CALL_NAME,
      fields: {
        WonList: { Include: true, Pagination: { EntriesPerPage: 25, PageNumber: 2 } },
        DetailLevel: "ReturnAll",
      },
    });
    expect(page.entries).toHaveLength(1);
  });

  it("defaults to page 1 with the documented page size", async () => {
    const adapter = stubUserAdapter(async (_callName, fields) => {
      expect(fields).toMatchObject({
        WonList: { Pagination: { EntriesPerPage: DEFAULT_WON_LIST_ENTRIES_PER_PAGE, PageNumber: 1 } },
      });
      return wonListResponse([]);
    });
    await fetchWonList(adapter);
  });

  it("rejects out-of-range paging before spending a provider call", async () => {
    const tradingCall = vi.fn(async () => wonListResponse([]));
    const adapter = stubUserAdapter(tradingCall);
    for (const input of [{ page: 0 }, { entriesPerPage: 201 }]) {
      await expect(fetchWonList(adapter, input)).rejects.toThrowError(EbayAdapterError);
    }
    expect(tradingCall).not.toHaveBeenCalled();
  });

  it("propagates the adapter's normalized taxonomy errors unchanged", async () => {
    const adapter = stubUserAdapter(async () => {
      throw new EbayAdapterError("auth", "eBay rejected the user token");
    });
    const error = await fetchWonList(adapter).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EbayAdapterError);
    expect((error as EbayAdapterError).kind).toBe("auth");
  });
});

describe("fetchAllWonPurchases", () => {
  it("walks every page then groups the accumulated entries", async () => {
    const order = { OrderID: "combo-1" };
    const pages: Record<string, unknown>[] = [
      wonListResponse(
        [entry(1, { order, transaction: transaction(1) }), entry(2, { order, transaction: transaction(2) })],
        { TotalNumberOfPages: 2 },
      ),
      wonListResponse([entry(1, { order, transaction: transaction(3) })], { TotalNumberOfPages: 2 }),
    ];
    const adapter = stubUserAdapter(async (_callName, fields) => {
      const wonList = fields["WonList"] as { Pagination: { PageNumber: number } };
      return pages[wonList.Pagination.PageNumber - 1] as Record<string, unknown>;
    });
    const result = await fetchAllWonPurchases(adapter, { entriesPerPage: 2 });
    expect(result).toMatchObject({ pages: 2, truncated: false });
    expect(result.purchases).toHaveLength(1);
    expect(result.purchases[0]?.lines).toHaveLength(3);
  });

  it("stops at maxPages and reports truncation", async () => {
    const adapter = stubUserAdapter(async (_callName, fields) => {
      const wonList = fields["WonList"] as { Pagination: { PageNumber: number } };
      return wonListResponse([entry(wonList.Pagination.PageNumber)], { TotalNumberOfPages: 99 });
    });
    const result = await fetchAllWonPurchases(adapter, { entriesPerPage: 1, maxPages: 3 });
    expect(result).toMatchObject({ pages: 3, truncated: true });
    expect(result.purchases).toHaveLength(3);
  });

  it("handles the documented sandbox defect (Ack Success, no WonList container)", async () => {
    const adapter = stubUserAdapter(async () => ({ Ack: "Success" }));
    const result = await fetchAllWonPurchases(adapter);
    expect(result).toMatchObject({ purchases: [], pages: 1, truncated: false });
  });
});
