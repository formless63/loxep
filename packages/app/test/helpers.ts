/**
 * Test helpers for the composition root: scratch-database lifecycle against
 * the dev database (docker/compose.dev.yml, host port 5433), a synthetic
 * {@link BootstrapConfig}, and the FAKE eBay adapter that stands in for the
 * provider.
 *
 * Provider I/O is the one thing mocked here — everything else (PostgreSQL,
 * TimescaleDB hypertables, the Graphile Worker runtime, the real market /
 * notifications / domain packages) is real. Every credential-shaped value in
 * this file is fake.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { closeDb, createDb } from "@loxep/db";
import { parseKeyring } from "@loxep/config";
import type { BootstrapConfig } from "@loxep/config";
import type { JobsLogger } from "@loxep/jobs";
import {
  EbayAdapterError,
  hasUnknownSellerWarning,
  mapSearchSummary,
} from "@loxep/integration-ebay";
import type {
  EbayAdapter,
  EbayListingSummary,
  EbaySearchPage,
  EbaySearchWarning,
  EbayUserAdapter,
  fetchAllSellerListings,
  searchAllListings,
} from "@loxep/integration-ebay";
import type { EbayConnectionAdapter } from "../src/index.ts";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:loxep-dev@localhost:5433/loxep_test";

export const baseDatabaseUrl =
  process.env["LOXEP_TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;

function maintenanceUrl(): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function databaseUrlFor(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function scratchDbName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

async function withMaintenanceDb(sql: string): Promise<void> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(sql);
  } finally {
    await closeDb(handle);
  }
}

export async function createScratchDb(databaseName: string): Promise<string> {
  await withMaintenanceDb(`create database "${databaseName}"`);
  return databaseUrlFor(databaseName);
}

export async function dropScratchDb(databaseName: string): Promise<void> {
  await withMaintenanceDb(
    `drop database if exists "${databaseName}" with (force)`,
  );
}

/** Silent logger so migration chatter does not pollute test output. */
export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noopJobsLogger: JobsLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopJobsLogger,
};

const consoleJobsLogger: JobsLogger = {
  /* eslint-disable no-console */
  debug: (obj, msg) => console.debug(obj, msg),
  info: (obj, msg) => console.info(obj, msg),
  warn: (obj, msg) => console.warn(obj, msg),
  error: (obj, msg) => console.error(obj, msg),
  /* eslint-enable no-console */
  child: () => consoleJobsLogger,
};

/**
 * Structural JobsLogger for worker runtimes under test: silent by default so
 * job chatter does not pollute output, verbose under `LOXEP_TEST_LOG=1` when
 * a failing pipeline needs to be watched.
 */
export const silentJobsLogger: JobsLogger =
  process.env["LOXEP_TEST_LOG"] === "1" ? consoleJobsLogger : noopJobsLogger;

/** Poll until `condition` returns a truthy value or `timeoutMs` elapses. */
export async function waitFor<T>(
  condition: () => Promise<T | undefined | false>,
  { timeoutMs = 20_000, intervalMs = 50, label = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** ADR-0019 keyring in the real document format (fake key material). */
export function testKeyring() {
  return parseKeyring(
    JSON.stringify({
      active_version: 1,
      keys: { "1": Buffer.alloc(32, 11).toString("base64") },
    }),
  );
}

/**
 * A worker-mode bootstrap config. Built directly rather than through
 * `loadBootstrapConfig` so a test never depends on ambient LOXEP_* env.
 */
export function testConfig(databaseUrl: string): BootstrapConfig {
  return {
    mode: "worker",
    databaseUrl,
    publicOrigin: undefined,
    port: 3090,
    authSecret: undefined,
    keyring: testKeyring(),
    oidc: undefined,
    smtp: undefined,
    bootstrapAdminEmail: undefined,
    mediaRoot: "./data/media",
    logLevel: "error",
  };
}

// ---------------------------------------------------------------------------
// Fake provider payloads
// ---------------------------------------------------------------------------

export interface BrowseItemInput {
  itemId: string;
  title?: string;
  price?: string;
  currency?: string;
  quantityAvailable?: number;
  availabilityStatus?: string;
  itemWebUrl?: string;
  itemEndDate?: Date | null;
  seller?: string;
}

/** A Buy Browse `getItem` payload, shaped exactly like the provider's. */
export function browseItemPayload(
  input: BrowseItemInput,
): Record<string, unknown> {
  return {
    itemId: input.itemId,
    title: input.title ?? `Item ${input.itemId}`,
    itemWebUrl:
      input.itemWebUrl ?? `https://www.ebay.com/itm/${input.itemId}`,
    listingMarketplaceId: "EBAY_US",
    categoryId: "9355",
    conditionId: "1000",
    buyingOptions: ["FIXED_PRICE"],
    seller: { username: input.seller ?? "fake-seller", feedbackScore: 42 },
    ...(input.price !== undefined
      ? { price: { value: input.price, currency: input.currency ?? "USD" } }
      : {}),
    estimatedAvailabilities: [
      {
        estimatedAvailableQuantity: input.quantityAvailable ?? 5,
        estimatedAvailabilityStatus: input.availabilityStatus ?? "IN_STOCK",
      },
    ],
    ...(input.itemEndDate !== undefined && input.itemEndDate !== null
      ? { itemEndDate: input.itemEndDate.toISOString() }
      : {}),
  };
}

/** One Trading `GetMyeBayBuying` watch-list `Item` payload. */
export function watchlistItemPayload(input: {
  itemId: string;
  title?: string;
  viewItemUrl?: string;
  endTime?: Date;
  seller?: string;
}): Record<string, unknown> {
  return {
    // The XML parser coerces numeric-looking ids to numbers; mirror that.
    ItemID: Number(input.itemId),
    Title: input.title ?? `Watched ${input.itemId}`,
    ListingDetails: {
      ViewItemURL:
        input.viewItemUrl ?? `https://www.ebay.com/itm/${input.itemId}`,
      ...(input.endTime !== undefined
        ? { EndTime: input.endTime.toISOString() }
        : {}),
    },
    Seller: { UserID: input.seller ?? "fake-seller" },
  };
}

/**
 * One Browse `item_summary/search` `ItemSummary` payload, shaped exactly like
 * the provider's — the fake search backend runs it through the REAL
 * `mapSearchSummary`, so normalization is never faked.
 */
export function browseSummaryPayload(input: {
  itemId: string;
  title?: string;
  price?: string;
  currency?: string;
  seller?: string;
  itemWebUrl?: string;
  itemCreationDate?: Date;
  itemEndDate?: Date;
  categoryId?: string;
}): Record<string, unknown> {
  return {
    itemId: input.itemId,
    title: input.title ?? `Listing ${input.itemId}`,
    itemWebUrl: input.itemWebUrl ?? `https://www.ebay.com/itm/${input.itemId}`,
    listingMarketplaceId: "EBAY_US",
    leafCategoryIds: [input.categoryId ?? "9355"],
    conditionId: "1000",
    condition: "New",
    buyingOptions: ["FIXED_PRICE"],
    seller: {
      username: input.seller ?? "fake-seller",
      feedbackScore: 42,
      feedbackPercentage: "99.7",
    },
    ...(input.price !== undefined
      ? { price: { value: input.price, currency: input.currency ?? "USD" } }
      : {}),
    ...(input.itemCreationDate !== undefined
      ? { itemCreationDate: input.itemCreationDate.toISOString() }
      : {}),
    ...(input.itemEndDate !== undefined
      ? { itemEndDate: input.itemEndDate.toISOString() }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

export interface FakeEbayState {
  /** External item id (legacy or RESTful) → raw Browse payload. */
  items: Map<string, Record<string, unknown>>;
  /** Raw Trading watch-list `Item` payloads. */
  watchlist: Record<string, unknown>[];
  /** Raw Browse `ItemSummary` payloads a search returns. */
  searchSummaries: Record<string, unknown>[];
  /** Seller username → the raw `ItemSummary` payloads that seller has. */
  sellerSummaries: Map<string, Record<string, unknown>[]>;
  /** Warnings eBay attaches to every search page (12002/12008 cases). */
  searchWarnings: EbaySearchWarning[];
  /** Warnings eBay attaches to every seller page (the 12003 refusal case). */
  sellerWarnings: EbaySearchWarning[];
  /** When set, every provider call throws it (connection-failure path). */
  failWith: EbayAdapterError | null;
  /** Whether the connection has a stored user token. */
  consented: boolean;
  /** Operation names, in call order. */
  calls: string[];
}

export function fakeEbayState(
  overrides: Partial<FakeEbayState> = {},
): FakeEbayState {
  return {
    items: new Map(),
    watchlist: [],
    searchSummaries: [],
    sellerSummaries: new Map(),
    searchWarnings: [],
    sellerWarnings: [],
    failWith: null,
    consented: true,
    calls: [],
    ...overrides,
  };
}

/**
 * Fake application adapter → its state. The discovery functions receive only
 * `adapter.application`, so this is how a canned page finds its connection —
 * the same trick the integration boundary uses for its own internals handle.
 */
const stateByApplicationAdapter = new WeakMap<object, FakeEbayState>();

/** Page size the fake backend emits, so paging/accumulation is exercised. */
export const FAKE_DISCOVERY_PAGE_SIZE = 2;

function fakeStateFor(adapter: object): FakeEbayState {
  const state = stateByApplicationAdapter.get(adapter);
  if (state === undefined) {
    throw new Error("fake discovery backend: adapter has no registered state");
  }
  return state;
}

function pageOf(
  raws: readonly Record<string, unknown>[],
  offset: number,
  limit: number,
  warnings: EbaySearchWarning[],
): EbaySearchPage {
  const slice = raws.slice(offset, offset + limit);
  const summaries = slice.map((raw) =>
    mapSearchSummary(raw, { fallbackMarketplace: "EBAY_US" }),
  );
  const next = offset + slice.length;
  return {
    summaries,
    total: raws.length,
    offset,
    limit,
    cursor: next < raws.length ? String(next) : null,
    warnings,
    fetchedAt: new Date(),
  };
}

function collect(
  raws: readonly Record<string, unknown>[],
  maxItems: number,
  warnings: EbaySearchWarning[],
  onPage?: (page: EbaySearchPage) => void,
): {
  summaries: EbayListingSummary[];
  pages: number;
  total: number | null;
  warnings: EbaySearchWarning[];
} {
  const summaries: EbayListingSummary[] = [];
  const seenWarnings: EbaySearchWarning[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const page = pageOf(
      raws,
      offset,
      Math.min(FAKE_DISCOVERY_PAGE_SIZE, maxItems - summaries.length),
      warnings,
    );
    pages += 1;
    onPage?.(page);
    summaries.push(...page.summaries);
    seenWarnings.push(...page.warnings);
    if (page.cursor === null || summaries.length >= maxItems) break;
    offset = Number(page.cursor);
  }
  return {
    summaries: summaries.slice(0, maxItems),
    pages,
    total: raws.length,
    warnings: seenWarnings,
  };
}

/**
 * The `discovery` seam of {@link createEbayPollExecutor}, backed by
 * {@link FakeEbayState}. Normalization (`mapSearchSummary`) and the seller
 * refusal rule (`hasUnknownSellerWarning`) are the REAL ones — only the HTTP
 * call is canned.
 */
export const fakeDiscoveryBackend: {
  searchAllListings: typeof searchAllListings;
  fetchAllSellerListings: typeof fetchAllSellerListings;
} = {
  searchAllListings: async (adapter, input) => {
    const state = fakeStateFor(adapter);
    state.calls.push(`search:${input.query ?? input.categoryId ?? ""}`);
    if (state.failWith !== null) throw state.failWith;
    return collect(
      state.searchSummaries,
      input.maxItems,
      state.searchWarnings,
      input.onPage,
    );
  },
  fetchAllSellerListings: async (adapter, input) => {
    const state = fakeStateFor(adapter);
    state.calls.push(`seller:${input.sellerUsername}`);
    if (state.failWith !== null) throw state.failWith;
    const raws = state.sellerSummaries.get(input.sellerUsername) ?? [];
    return collect(raws, input.maxItems, state.sellerWarnings, (page) => {
      // The real refusal: eBay DROPS an unrecognized seller filter and
      // returns the anchor's whole result set, so the page is refused rather
      // than ingested (see `sellers.ts`).
      if (hasUnknownSellerWarning(page.warnings)) {
        throw new EbayAdapterError(
          "invalid_request",
          "eBay does not recognize this seller username; it ignored the seller " +
            "filter and returned unrelated listings",
          { sellerUsername: input.sellerUsername, warningId: 12003 },
        );
      }
    });
  },
};

/**
 * A {@link EbayConnectionAdapter} whose provider clients are fakes. The
 * casts are deliberate: the executor only ever touches the Browse/Trading
 * operations implemented here, and implementing the whole provider surface
 * would test the fake rather than the pipeline.
 */
export function fakeConnectionAdapter(
  connectionId: string,
  state: FakeEbayState,
  options: { minIntervalSeconds?: number } = {},
): EbayConnectionAdapter {
  const getItem = (id: string): Record<string, unknown> => {
    state.calls.push(`getItem:${id}`);
    if (state.failWith !== null) throw state.failWith;
    const payload = state.items.get(id);
    if (payload === undefined) {
      throw new EbayAdapterError("not_found", "fake item not found", { id });
    }
    return payload;
  };

  const application = {
    environment: "sandbox" as const,
    marketplaceId: "EBAY_US",
    browseGetItem: async (itemId: string) => getItem(itemId),
    browseGetItemByLegacyId: async (legacyItemId: string) =>
      getItem(legacyItemId),
    browseSearch: async () => ({ total: 0, itemSummaries: [] }),
  } as unknown as EbayAdapter;
  // Lets {@link fakeDiscoveryBackend} find this connection's canned pages.
  stateByApplicationAdapter.set(application, state);

  const user = {
    environment: "sandbox" as const,
    marketplaceId: "EBAY_US",
    browseGetItem: async (itemId: string) => getItem(itemId),
    browseGetItemByLegacyId: async (legacyItemId: string) =>
      getItem(legacyItemId),
    tradingCall: async (callName: string) => {
      state.calls.push(`trading:${callName}`);
      if (state.failWith !== null) throw state.failWith;
      return {
        Ack: "Success",
        WatchList: {
          ItemArray: { Item: state.watchlist },
          PaginationResult: {
            TotalNumberOfPages: 1,
            TotalNumberOfEntries: state.watchlist.length,
          },
        },
      };
    },
  } as unknown as EbayUserAdapter;

  return {
    connectionId,
    environment: "sandbox",
    marketplaceId: "EBAY_US",
    keysetSource: "secret",
    application,
    user: state.consented ? user : null,
    minIntervalSeconds: options.minIntervalSeconds ?? 30,
    requireUser: () => {
      if (!state.consented) {
        throw new EbayAdapterError(
          "auth",
          "fake connection has no stored user token",
        );
      }
      return user;
    },
  };
}
