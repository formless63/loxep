/**
 * Buy-side purchase retrieval: Trading `GetMyeBayBuying` `WonList` (Flipping
 * milestone 5, loxep-dgf.5).
 *
 * ## Why this needed no adapter change
 *
 * `EbayUserAdapter.tradingCall(callName, fields)` is already a generic
 * dispatcher over every one of the 139 Trading calls (see `adapter.ts`), and
 * Trading APIs use NO OAuth scopes — the user token rides in the
 * `X-EBAY-API-IAF-TOKEN` header, so the base `watchlist`-tier token this
 * package already mints is sufficient. `WonList` is a sibling container of
 * the `WatchList` container `watchlist.ts` already requests on the exact same
 * `GetMyeBayBuying` call:
 *
 * ```
 * { WonList: { Include: true, Pagination: { EntriesPerPage, PageNumber } },
 *   DetailLevel: "ReturnAll" }
 * ```
 *
 * ## Response shape — DESIGN-DERIVED, NOT LIVE-VERIFIED
 *
 * Unlike `watchlist.ts` and `orders.ts`, the shape below could not be read out
 * of an installed OpenAPI/WSDL type file — `ebay-api@10.0.0`'s traditional
 * surface is untyped (`tradingCall` returns `Record<string, unknown>` for
 * every one of its 139 calls) — and it could not be captured from a live
 * response either; see the sandbox note below. It is instead taken from
 * eBay's published Trading API reference for `GetMyeBayBuying`, which
 * documents `WonList` as sharing its complex type with `BidList`/`LostList`
 * and with `GetItemsAwaitingFeedback`'s own container: a
 * `OrderTransactionArray` of `OrderTransaction` entries, each carrying a
 * `Transaction` (the line: item, price, quantity, seller, ship/tax detail)
 * and, when the buyer's checkout combined several purchases from one seller
 * into one payment, an `Order` (the checkout: order id, status, seller-level
 * totals) shared verbatim across every entry in that group:
 *
 * ```
 * WonList: {
 *   OrderTransactionArray: { OrderTransaction: [
 *     { Transaction: { TransactionID, Item: { ItemID, Title, SKU },
 *                       Seller: { UserID }, TransactionPrice: { value, currencyID },
 *                       QuantityPurchased, CreatedDate,
 *                       ShippingDetails: { ShippingServiceOptions, SalesTax },
 *                       AmountPaid: { value, currencyID } },
 *       Order?: { OrderID, OrderStatus, CreatedTime,
 *                 Total, Subtotal, ShippingServiceSelected } },
 *     ...
 *   ] },
 *   PaginationResult: { TotalNumberOfPages, TotalNumberOfEntries },
 * }
 * ```
 *
 * Every field is read defensively — an absent or differently-shaped
 * container degrades to `null`/`"0.00"` rather than throwing, exactly
 * `watchlist.ts`'s and `orders.ts`'s discipline — because nothing downstream
 * of this mapper writes inventory from an ingested purchase without a human
 * confirming it (see `@loxep/inventory`'s purchase-sync module doc), so a
 * mis-mapped field degrades to a reviewable candidate rather than corrupting
 * a database write.
 *
 * ## The sandbox cannot verify this, and the reason is already reproduced
 *
 * On 2026-08-12 (loxep-76k), sandbox `GetMyeBayBuying` was found to return
 * `Ack: Success` with **no container at all** — not `WatchList`, not
 * `BuyingSummary`, not `BidList`/`WonList`/`LostList` — across every argument
 * shape and every compatibility level tried, even though the data provably
 * exists on the test account (see `watchlist.ts`'s module doc for the full
 * experimental record). `WonList` inherits that defect: it cannot be
 * exercised against a live response in this environment, sandbox or
 * otherwise. `GetItemsAwaitingFeedback` DOES return its container in
 * sandbox and is documented to share `WonList`'s `OrderTransactionArray`
 * shape, which makes it a plausible smoke path for the mapper/provenance/
 * queue end to end — but this change does not add a live test against it,
 * because the container name and field set for THAT call were not
 * independently confirmed either. A live sandbox smoke test is a documented
 * follow-up, not a checked-in assumption. Ship this behind the same posture
 * `watchlist.ts` shipped under: built, tested against fixtures, and marked
 * unverified until a production account runs it.
 *
 * ## Grouping: one Loxep purchase per eBay checkout, not per line
 *
 * `WonList` reports one `OrderTransaction` per PURCHASED LINE, not per
 * checkout — a buyer who wins three listings from one seller in one payment
 * gets three entries sharing one `Order`. {@link groupWonListEntries} folds
 * entries sharing an `Order.OrderID` into one {@link EbayPurchaseFact}
 * (Loxep's `acquisitions` unit is the lot/checkout, not the line); an entry
 * with no `Order` — a standalone, uncombined purchase — becomes its own
 * single-line fact keyed by a synthetic `txn:<TransactionID>` id, because
 * `acquisitions.external_reference` must always be populated for the
 * idempotency lookup to work.
 *
 * ## The id space, again
 *
 * `Transaction.Item.ItemID` is the LEGACY numeric Trading item id, the same
 * space `watchlist.ts` returns and NOT the RESTful `v1|…|0` id Browse
 * (`snapshot.ts`) or Sell Fulfillment (`orders.ts`'s `legacyItemId`, notably
 * NOT `orders.ts`'s primary item id either — Sell Fulfillment's line items key
 * by variation, not by legacy item) use. Never compare the two id spaces as
 * strings; bridge through `browseGetItemByLegacyId` if a canonical listing
 * lookup is ever needed here.
 */
import type { EbayUserAdapter } from "./adapter.ts";
import { EbayAdapterError } from "./errors.ts";
import { decimalFromUnknown, sumDecimals } from "./money.ts";

/* ------------------------------------------------------------------ types */

export interface EbayPurchaseLineFact {
  /** `Transaction.TransactionID` — stable per purchased line. */
  externalTransactionId: string;
  /** `Transaction.Item.ItemID` — LEGACY numeric id; see the module doc. */
  externalItemId: string | null;
  title: string | null;
  sku: string | null;
  /** Decimal string — `Transaction.QuantityPurchased`. */
  quantity: string;
  /** `Transaction.TransactionPrice` — this line's paid item price. */
  lineAmount: string;
  /** `Transaction.ShippingDetails`' selected service cost for this line. */
  shippingAmount: string;
  /** `Transaction.ShippingDetails.SalesTax.SalesTaxAmount`. */
  taxAmount: string;
  /** ISO-8601 UTC, or null when `CreatedDate` is absent/unparseable. */
  purchasedAt: string | null;
  sellerExternalId: string | null;
  canonicalUrl: string | null;
}

/**
 * One eBay checkout, Loxep's `acquisitions` unit — see the module doc's
 * grouping rule. `currency` is read from the first line reporting one; a
 * purchase whose lines disagree on currency (never observed, not ruled out)
 * keeps that first value rather than guessing, and every amount stays in the
 * currency the provider reported it in (no FX, matching every other eBay
 * money boundary in this repository).
 */
export interface EbayPurchaseFact {
  /** `Order.OrderID`, or `txn:<TransactionID>` for a standalone purchase. */
  externalOrderId: string;
  /** Whether this fact is a real combined checkout (`Order` was present). */
  isCombinedOrder: boolean;
  sellerExternalId: string | null;
  currency: string;
  /** The single line's title, or `"N items from <seller>"` for a group. */
  title: string;
  /** Sum of `lines[].lineAmount`. */
  itemPriceAmount: string;
  /** Sum of `lines[].shippingAmount`. */
  shippingAmount: string;
  /** Sum of `lines[].taxAmount`. */
  taxAmount: string;
  /** `itemPriceAmount + shippingAmount + taxAmount`. */
  totalAmount: string;
  /** ISO-8601 UTC — `Order.CreatedTime`, else the earliest line's. */
  purchasedAt: string;
  lines: EbayPurchaseLineFact[];
  /**
   * The provider `OrderTransaction` entries this fact was built from,
   * retained verbatim for `provider_objects` (ADR-0009 #3). One entry per
   * line; never a domain column.
   */
  raw: readonly Record<string, unknown>[];
}

export interface EbayWonListPage {
  /** Provider entries, ungrouped — see {@link groupWonListEntries}. */
  entries: readonly Record<string, unknown>[];
  page: number;
  entriesPerPage: number;
  totalPages: number | null;
  totalEntries: number | null;
  hasMore: boolean;
  fetchedAt: Date;
}

export interface FetchWonListInput {
  /** 1-based page number; default 1. */
  page?: number;
  /** eBay caps this at 200; default 100. */
  entriesPerPage?: number;
}

export const WON_LIST_CALL_NAME = "GetMyeBayBuying";
export const DEFAULT_WON_LIST_ENTRIES_PER_PAGE = 100;
const MAX_WON_LIST_ENTRIES_PER_PAGE = 200;

/* ---------------------------------------------------------------- helpers */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record !== null) out.push(record);
  }
  return out;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  return null;
}

/** Identifiers may arrive as numbers — the XML parser coerces them. */
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

function asIso(value: unknown): string | null {
  const date = asDate(value);
  return date === null ? null : date.toISOString();
}

const ZERO = "0.00";

/**
 * Read a Trading XML money element, `{ value, currencyID }` — the
 * ATTRIBUTE-CARRYING shape `fast-xml-parser` produces for every eBay Trading
 * `AmountType` under this package's parse options
 * (`attributeNamePrefix: ''`, `textNodeName: 'value'`; see
 * `ebay-api`'s `XMLRequest.js`). Deliberately distinct from `money.ts`'s
 * `amountValue`/`amountCurrency`, which read the RESTful `{ value, currency }`
 * shape Sell Fulfillment uses — the same discipline that keeps `orders.ts`
 * and `watchlist.ts` from sharing a money reader across the XML/REST
 * boundary.
 */
function tradingAmountValue(value: unknown): string | null {
  const record = asRecord(value);
  return record === null ? null : decimalFromUnknown(record["value"]);
}

function tradingAmountCurrency(value: unknown): string | null {
  const record = asRecord(value);
  if (record === null) return null;
  const currency = record["currencyID"];
  return typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)
    ? currency.toUpperCase()
    : null;
}

/**
 * `OrderTransactionArray.OrderTransaction` is normally an array; be lenient
 * about a lone entry the same way `watchlist.ts`'s `itemsOf` is.
 */
function orderTransactionsOf(wonList: unknown): Array<Record<string, unknown>> {
  const container = asRecord(wonList);
  if (container === null) return [];
  const array = asRecord(container["OrderTransactionArray"]);
  if (array === null) return [];
  const entries = array["OrderTransaction"];
  if (Array.isArray(entries)) return asRecordArray(entries);
  const single = asRecord(entries);
  return single === null ? [] : [single];
}

/** This line's shipping cost — the selected service option, if any. */
function lineShippingAmount(transaction: Record<string, unknown>): string {
  const shippingDetails = asRecord(transaction["ShippingDetails"]);
  if (shippingDetails === null) return ZERO;
  const options = shippingDetails["ShippingServiceOptions"];
  const selected = Array.isArray(options)
    ? asRecord(options[0])
    : asRecord(options);
  return selected === null
    ? ZERO
    : (tradingAmountValue(selected["ShippingServiceCost"]) ?? ZERO);
}

/** This line's sales tax — `ShippingDetails.SalesTax.SalesTaxAmount`. */
function lineTaxAmount(transaction: Record<string, unknown>): string {
  const shippingDetails = asRecord(transaction["ShippingDetails"]);
  if (shippingDetails === null) return ZERO;
  const salesTax = asRecord(shippingDetails["SalesTax"]);
  return salesTax === null
    ? ZERO
    : (tradingAmountValue(salesTax["SalesTaxAmount"]) ?? ZERO);
}

/**
 * Pure mapping from one `OrderTransaction.Transaction` payload to a Loxep
 * purchase line. Exported for tests; callers normally reach this through
 * {@link groupWonListEntries}.
 */
export function mapWonListTransaction(
  transaction: Record<string, unknown>,
): EbayPurchaseLineFact {
  const externalTransactionId = asIdString(transaction["TransactionID"]);
  if (externalTransactionId === null) {
    throw new EbayAdapterError(
      "provider_unavailable",
      "eBay WonList transaction payload has no TransactionID",
    );
  }
  const item = asRecord(transaction["Item"]);
  const seller = asRecord(transaction["Seller"]);
  const listingDetails = item === null ? null : asRecord(item["ListingDetails"]);
  const quantity =
    decimalFromUnknown(transaction["QuantityPurchased"]) ?? "1";
  const lineAmount =
    tradingAmountValue(transaction["TransactionPrice"]) ??
    tradingAmountValue(transaction["AmountPaid"]) ??
    ZERO;

  return {
    externalTransactionId,
    externalItemId: item === null ? null : asIdString(item["ItemID"]),
    title: item === null ? null : asString(item["Title"]),
    sku: item === null ? null : asString(item["SKU"]),
    quantity,
    lineAmount,
    shippingAmount: lineShippingAmount(transaction),
    taxAmount: lineTaxAmount(transaction),
    purchasedAt: asIso(transaction["CreatedDate"]),
    sellerExternalId: seller === null ? null : asIdString(seller["UserID"]),
    canonicalUrl:
      listingDetails === null ? null : asString(listingDetails["ViewItemURL"]),
  };
}

/**
 * `Transaction.TransactionPrice.currencyID`, falling back to `AmountPaid`.
 * The currency a line's own price was reported in — used to resolve the
 * fact-level currency when grouping.
 */
function lineCurrency(transaction: Record<string, unknown>): string | null {
  return (
    tradingAmountCurrency(transaction["TransactionPrice"]) ??
    tradingAmountCurrency(transaction["AmountPaid"])
  );
}

/**
 * Fold `WonList` entries into Loxep purchase facts — see the module doc's
 * "Grouping" section. Entry ORDER is preserved: the first entry seen for a
 * group's key determines that group's position in the result.
 */
export function groupWonListEntries(
  entries: readonly Record<string, unknown>[],
): EbayPurchaseFact[] {
  const order: string[] = [];
  const groups = new Map<
    string,
    {
      orderRaw: Record<string, unknown> | null;
      lines: EbayPurchaseLineFact[];
      rawEntries: Record<string, unknown>[];
      currency: string | null;
    }
  >();

  for (const entry of entries) {
    const transactionRaw = asRecord(entry["Transaction"]) ?? entry;
    const line = mapWonListTransaction(transactionRaw);
    const orderRaw = asRecord(entry["Order"]);
    const orderId = orderRaw === null ? null : asIdString(orderRaw["OrderID"]);
    const key = orderId ?? `txn:${line.externalTransactionId}`;

    const existing = groups.get(key);
    if (existing === undefined) {
      order.push(key);
      groups.set(key, {
        orderRaw,
        lines: [line],
        rawEntries: [entry],
        currency: lineCurrency(transactionRaw),
      });
    } else {
      existing.lines.push(line);
      existing.rawEntries.push(entry);
      existing.currency ??= lineCurrency(transactionRaw);
      // A later entry in the same group may carry the `Order` block when an
      // earlier one (defensively) did not; never drop one already captured.
      existing.orderRaw ??= orderRaw;
    }
  }

  return order.map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      throw new EbayAdapterError(
        "provider_unavailable",
        `WonList grouping lost key "${key}"`,
      );
    }
    const { orderRaw, lines, rawEntries, currency } = group;
    const itemPriceAmount = sumDecimals(
      lines.map((line) => line.lineAmount),
      ZERO,
    );
    const shippingFromOrder =
      orderRaw === null
        ? null
        : (tradingAmountValue(
            asRecord(orderRaw["ShippingServiceSelected"])?.[
              "ShippingServiceCost"
            ],
          ) ??
          tradingAmountValue(orderRaw["ShippingServiceCost"]));
    const shippingAmount =
      shippingFromOrder ??
      sumDecimals(
        lines.map((line) => line.shippingAmount),
        ZERO,
      );
    const taxAmount = sumDecimals(
      lines.map((line) => line.taxAmount),
      ZERO,
    );
    const totalFromOrder = orderRaw === null ? null : tradingAmountValue(orderRaw["Total"]);
    const totalAmount =
      totalFromOrder ?? sumDecimals([itemPriceAmount, shippingAmount, taxAmount], ZERO);

    const earliestLineDate = lines
      .map((line) => line.purchasedAt)
      .filter((value): value is string => value !== null)
      .sort()[0];
    const purchasedAt =
      (orderRaw === null ? null : asIso(orderRaw["CreatedTime"])) ??
      earliestLineDate ??
      new Date(0).toISOString();

    const sellerExternalId =
      lines.find((line) => line.sellerExternalId !== null)?.sellerExternalId ??
      null;

    const firstLine = lines[0];
    const title =
      lines.length === 1 && firstLine !== undefined
        ? (firstLine.title ?? `eBay purchase ${firstLine.externalTransactionId}`)
        : `${lines.length} items from ${sellerExternalId ?? "eBay seller"}`;

    return {
      externalOrderId: key,
      isCombinedOrder: orderRaw !== null,
      sellerExternalId,
      currency: currency ?? "",
      title,
      itemPriceAmount,
      shippingAmount,
      taxAmount,
      totalAmount,
      purchasedAt,
      lines,
      raw: rawEntries,
    };
  });
}

/**
 * Pure mapping from a `GetMyeBayBuying` response to one Loxep won-list page
 * of UNGROUPED provider entries. Exported for tests against captured
 * payloads; {@link fetchAllWonPurchases} groups the accumulated entries once
 * paging is done, because a checkout's transactions are not guaranteed to
 * land on the same page.
 */
export function mapWonListResponse(
  response: Record<string, unknown>,
  options: { fetchedAt: Date; page: number; entriesPerPage: number },
): EbayWonListPage {
  const wonList = asRecord(response["WonList"]);
  const entries = orderTransactionsOf(wonList);
  const pagination = wonList === null ? null : asRecord(wonList["PaginationResult"]);
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
    hasMore:
      totalPages !== null
        ? options.page < totalPages
        : entries.length >= options.entriesPerPage,
    fetchedAt: options.fetchedAt,
  };
}

/**
 * Fetch one page of the connected user's won items, UNGROUPED. Errors arrive
 * already normalized through the taxonomy by the adapter's call wrapper.
 */
export async function fetchWonList(
  userAdapter: EbayUserAdapter,
  input: FetchWonListInput = {},
): Promise<EbayWonListPage> {
  const page = input.page ?? 1;
  const entriesPerPage = input.entriesPerPage ?? DEFAULT_WON_LIST_ENTRIES_PER_PAGE;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new EbayAdapterError(
      "invalid_request",
      "WonList page must be a positive integer",
      { page },
    );
  }
  if (
    !Number.isSafeInteger(entriesPerPage) ||
    entriesPerPage < 1 ||
    entriesPerPage > MAX_WON_LIST_ENTRIES_PER_PAGE
  ) {
    throw new EbayAdapterError(
      "invalid_request",
      "WonList entriesPerPage must be between 1 and 200",
      { entriesPerPage },
    );
  }
  const response = await userAdapter.tradingCall(WON_LIST_CALL_NAME, {
    WonList: {
      Include: true,
      Pagination: { EntriesPerPage: entriesPerPage, PageNumber: page },
    },
    DetailLevel: "ReturnAll",
  });
  return mapWonListResponse(response, { fetchedAt: new Date(), page, entriesPerPage });
}

/**
 * Walk every page of `WonList`, then group the accumulated entries into
 * purchase facts. `maxPages` is a safety stop, not a paging preference — the
 * rate budget still governs call spacing, and purchase-history cadence is
 * measured in HOURS (see `@loxep/inventory`'s purchase-sync module doc), not
 * the 60-second monitor baseline.
 */
export async function fetchAllWonPurchases(
  userAdapter: EbayUserAdapter,
  input: FetchWonListInput & { maxPages?: number } = {},
): Promise<{ purchases: EbayPurchaseFact[]; pages: number; truncated: boolean }> {
  const maxPages = input.maxPages ?? 20;
  const entries: Record<string, unknown>[] = [];
  let page = input.page ?? 1;
  let pages = 0;
  let truncated = false;
  for (; pages < maxPages; ) {
    const result = await fetchWonList(userAdapter, { ...input, page });
    pages += 1;
    entries.push(...result.entries);
    if (!result.hasMore || result.entries.length === 0) {
      return { purchases: groupWonListEntries(entries), pages, truncated: false };
    }
    page += 1;
  }
  truncated = true;
  return { purchases: groupWonListEntries(entries), pages, truncated };
}
