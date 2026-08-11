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
import { EbayAdapterError } from "@loxep/integration-ebay";
import type {
  EbayAdapter,
  EbayUserAdapter,
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

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

export interface FakeEbayState {
  /** External item id (legacy or RESTful) → raw Browse payload. */
  items: Map<string, Record<string, unknown>>;
  /** Raw Trading watch-list `Item` payloads. */
  watchlist: Record<string, unknown>[];
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
    failWith: null,
    consented: true,
    calls: [],
    ...overrides,
  };
}

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
