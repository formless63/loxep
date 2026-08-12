/**
 * eBay commerce sync wiring (loxep-xh9.2) through the REAL Graphile Worker
 * runtime and the REAL composed registry:
 *
 * ```text
 * ebay_orders target (created by @loxep/commerce's direct insert)
 *   → market.dispatch-due-monitors  → market.poll-target
 *   → the ROUTED poll executor      → @loxep/app's ebay_orders branch
 *   → @loxep/commerce syncConnection → orders/lines/fees/provenance rows
 *   → config.commerceSync watermark  → recordPollSuccess (next_poll_at)
 * ```
 *
 * The ONLY mock is the provider network. The order FACTS the seam yields are
 * produced by the REAL `mapEbayOrder` from `@loxep/integration-ebay` against
 * the same fixture shape the adapter suite uses — which is what makes this
 * file the structural-compatibility guard for `@loxep/commerce`'s deliberate
 * re-declaration of the adapter's fact types. If those two shapes ever drift,
 * this file stops compiling.
 *
 * The four things it is here to prove:
 *
 * 1. an `ebay_orders` row is claimable and routable even though
 *    `@loxep/market`'s closed target-type enum does not list it (the
 *    registration gap is narrow and documented, not silent);
 * 2. the dispatcher claims it and the app executor runs the commerce sync,
 *    advancing the cursor so a second poll asks for only what is newer;
 * 3. a provider failure records a poll failure with backoff AND puts the
 *    connection into its error state — the same contract the Woo branch has;
 * 4. an `auth` failure (the expected outcome for a connection consented
 *    without the Sell Fulfillment scope) additionally invalidates the cached
 *    adapter so a re-consent recovers on the next poll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { MONITOR_TARGET_TYPES, createMarketTasks } from "@loxep/market";
import {
  COMMERCE_SYNC_CONFIG_KEY,
  EBAY_ORDERS_TARGET_TYPE,
  SYNC_EBAY_ORDERS_TASK_NAME,
  ensureEbayOrderSyncTarget,
  readEbayOrderSyncCursor,
} from "@loxep/commerce";
import type { EbayOrderPageIterator, EbayOrderPageLike } from "@loxep/commerce";
import { EbayAdapterError, mapEbayOrder } from "@loxep/integration-ebay";
import type { EbayOrderFact } from "@loxep/integration-ebay";
import { buildAppServices, buildWorkerRegistry } from "../src/index.ts";
import type { AppServices, WorkerComposition } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  fakeConnectionAdapter,
  fakeEbayState,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";
import type { FakeEbayState } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_ebay_orders");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let connectionId = "";
let failingConnectionId = "";

const ebayStates = new Map<string, FakeEbayState>();
const invalidated: string[] = [];

function ebayStateFor(id: string): FakeEbayState {
  let state = ebayStates.get(id);
  if (state === undefined) {
    state = fakeEbayState();
    ebayStates.set(id, state);
  }
  return state;
}

/* ------------------------------------------------------- the provider seam */

/**
 * A raw Sell Fulfillment order payload. A LOCAL copy of the adapter suite's
 * fixture rather than an import: a package's test directory is not part of
 * its published surface, and reaching across `../../integrations/ebay/test/`
 * would make this suite break on a refactor it cannot see. No fixture carries
 * real personal data.
 */
function ebayOrderPayload(input: {
  orderId: string;
  lastModifiedDate: string;
  fulfillmentStatus?: string;
  total?: string;
}): Record<string, unknown> {
  return {
    orderId: input.orderId,
    creationDate: "2026-08-01T12:00:00.000Z",
    lastModifiedDate: input.lastModifiedDate,
    orderPaymentStatus: "PAID",
    orderFulfillmentStatus: input.fulfillmentStatus ?? "FULFILLED",
    sellerId: "sandbox-seller-01",
    salesRecordReference: "8241",
    buyer: { username: "sandbox-buyer-01" },
    pricingSummary: {
      priceSubtotal: { value: "50.00", currency: "USD" },
      deliveryCost: { value: "5.00", currency: "USD" },
      tax: { value: "4.00", currency: "USD" },
      total: { value: input.total ?? "59.00", currency: "USD" },
    },
    paymentSummary: {
      payments: [
        {
          paymentDate: "2026-08-01T12:05:00.000Z",
          paymentStatus: "PAID",
          amount: { value: "59.00", currency: "USD" },
        },
      ],
      refunds: [],
    },
    totalMarketplaceFee: { value: "7.42", currency: "USD" },
    fulfillmentStartInstructions: [
      {
        shippingStep: {
          shipTo: { contactAddress: { countryCode: "US", stateOrProvince: "NY" } },
        },
      },
    ],
    lineItems: [
      {
        lineItemId: `${input.orderId}-1`,
        legacyItemId: "110485231234",
        title: "Alpha widget",
        sku: "SKU-ALPHA",
        quantity: 2,
        listingMarketplaceId: "EBAY_US",
        lineItemFulfillmentStatus: input.fulfillmentStatus ?? "FULFILLED",
        lineItemCost: { value: "50.00", currency: "USD" },
        deliveryCost: { shippingCost: { value: "5.00", currency: "USD" } },
        taxes: [{ taxType: "STATE_SALES_TAX", amount: { value: "4.00", currency: "USD" } }],
        refunds: [],
      },
    ],
  };
}

/** REAL adapter facts — the structural-compatibility guard. */
function orderFact(input: {
  orderId: string;
  lastModifiedDate: string;
  fulfillmentStatus?: string;
  total?: string;
}): EbayOrderFact {
  return mapEbayOrder(ebayOrderPayload(input), {
    fallbackSourceAccountKey: "ebay:EBAY_US",
    marketplaceId: "EBAY_US",
    fulfillments: [],
  });
}

interface FakeOrderSource {
  /** Every order the account has, newest `lastModifiedDate` last. */
  orders: EbayOrderFact[];
  /** When set, the iterator throws it instead of yielding. */
  failWith: EbayAdapterError | null;
  /** `modifiedAfter` values the seam was asked for, in call order. */
  modifiedAfter: Array<Date | null>;
  /** Page sizes the seam was asked for. */
  perPage: number[];
}

const orderSources = new Map<string, FakeOrderSource>();

function orderSourceFor(connection: string): FakeOrderSource {
  let source = orderSources.get(connection);
  if (source === undefined) {
    source = { orders: [], failWith: null, modifiedAfter: [], perPage: [] };
    orderSources.set(connection, source);
  }
  return source;
}

/**
 * The injected page iterator, honouring the INCLUSIVE lower bound eBay's
 * `lastmodifieddate:[from..]` range uses — so the cursor's boundary behaviour
 * across polls is the real one, not a convenient approximation.
 */
const fakeEbayOrders: EbayOrderPageIterator = (input) => {
  const source = orderSourceFor(input.connectionId);
  source.modifiedAfter.push(input.modifiedAfter);
  source.perPage.push(input.perPage);
  return (async function* (): AsyncGenerator<EbayOrderPageLike> {
    if (source.failWith !== null) throw source.failWith;
    const after = input.modifiedAfter;
    const matching = source.orders.filter((order) => {
      if (after === null || order.updatedAt === null) return true;
      return Date.parse(order.updatedAt) >= after.getTime();
    });
    for (let offset = 0; offset < matching.length; offset += input.perPage) {
      yield { orders: matching.slice(offset, offset + input.perPage) };
    }
  })();
};

/* ------------------------------------------------------------------ harness */

async function dispatch(): Promise<void> {
  const market = createMarketTasks({ db: handle.db });
  await runtime.addJob(market.dispatchDueMonitorsTask, {});
}

interface TargetRow {
  id: string;
  lastSuccessAt: Date | null;
  consecutiveErrors: number;
  backoffUntil: Date | null;
  config: Record<string, unknown>;
}

/**
 * Read the target with plain SQL rather than `createMonitorService.getTarget`.
 * `@loxep/market`'s service validates `target_type` against a closed enum that
 * does not list `ebay_orders` yet (see the registration caveat in
 * `src/registry.ts`), so its CRUD path refuses these rows even though every
 * scheduling primitive handles them fine.
 */
async function readTarget(id: string): Promise<TargetRow> {
  const rows = await handle.pool.query<{
    id: string;
    last_success_at: Date | null;
    consecutive_errors: number;
    backoff_until: Date | null;
    config: Record<string, unknown> | null;
  }>(
    `select id, last_success_at, consecutive_errors, backoff_until, config
       from monitor_targets where id = $1`,
    [id],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error(`no monitor target ${id}`);
  return {
    id: row.id,
    lastSuccessAt: row.last_success_at,
    consecutiveErrors: row.consecutive_errors,
    backoffUntil: row.backoff_until,
    config: row.config ?? {},
  };
}

async function makeDue(id: string): Promise<void> {
  await handle.pool.query(
    `update monitor_targets
        set next_poll_at = now() - interval '1 second', backoff_until = null
      where id = $1`,
    [id],
  );
}

async function pollOnce(targetId: string): Promise<TargetRow> {
  const before = (await readTarget(targetId)).lastSuccessAt;
  await makeDue(targetId);
  await dispatch();
  return waitFor(
    async () => {
      const row = await readTarget(targetId);
      const advanced =
        row.lastSuccessAt !== null &&
        (before === null || row.lastSuccessAt.getTime() > before.getTime());
      return advanced ? row : undefined;
    },
    { timeoutMs: 30_000, label: `poll of ebay_orders target ${targetId}` },
  );
}

async function pollOnceExpectingFailure(targetId: string): Promise<TargetRow> {
  const before = (await readTarget(targetId)).consecutiveErrors;
  await makeDue(targetId);
  await dispatch();
  return waitFor(
    async () => {
      const row = await readTarget(targetId);
      return row.consecutiveErrors > before ? row : undefined;
    },
    { timeoutMs: 30_000, label: `poll failure of ebay_orders target ${targetId}` },
  );
}

function commerceSyncState(target: TargetRow): Record<string, unknown> {
  const state = target.config[COMMERCE_SYNC_CONFIG_KEY];
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>)
    : {};
}

async function orderCount(connection: string): Promise<number> {
  const rows = await handle.pool.query<{ n: string }>(
    `select count(*)::text as n from orders where connection_id = $1`,
    [connection],
  );
  return Number(rows.rows[0]?.n ?? "0");
}

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  const real = buildAppServices({ config, logger: silentJobsLogger });
  // Two mocks, both at the provider boundary: the connection adapter (so the
  // executor's user-token requirement is exercised without a real keyset) and
  // the order page seam. `invalidateEbayAdapter` is captured rather than
  // stubbed away, because the auth-failure contract asserts it.
  services = {
    ...real,
    getEbayAdapterForConnection: async (id) =>
      fakeConnectionAdapter(id, ebayStateFor(id)),
    invalidateEbayAdapter: (id) => {
      invalidated.push(id);
    },
  };

  composition = buildWorkerRegistry({
    config,
    services,
    logger: silentJobsLogger,
    ebayOrders: fakeEbayOrders,
  });

  runtime = await startWorkerRuntime({
    databaseUrl,
    logger: silentJobsLogger,
    concurrency: 2,
    pollInterval: 200,
    registry: composition.registry,
    cronItems: [],
  });

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "ebay-commerce@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const connection = await services.connections.createConnection({
    provider: "ebay",
    kind: "marketplace",
    name: "sandbox seller",
    createdByUserId: "test-user",
  });
  connectionId = connection.id;

  const failing = await services.connections.createConnection({
    provider: "ebay",
    kind: "marketplace",
    name: "broken seller",
    createdByUserId: "test-user",
  });
  failingConnectionId = failing.id;
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("'ebay_orders' registration state", () => {
  it("registers the on-demand task in the composed registry", () => {
    expect(composition.registry.has(SYNC_EBAY_ORDERS_TASK_NAME)).toBe(true);
    // The poll route and the on-demand task share ONE sync service.
    expect(composition.commerce.ebaySync).not.toBeNull();
  });

  /**
   * The documented gap, asserted rather than described. `packages/market` was
   * outside loxep-xh9.2's write fence, so `ebay_orders` is not in the closed
   * enum yet. Nothing about POLLING depends on that list — the tests below
   * prove the full claim → route → sync path — but monitor-service CRUD does.
   * When the follow-up lands, this expectation flips and the raw-SQL helpers
   * above can go.
   */
  it("is NOT yet in @loxep/market's closed target-type union", () => {
    expect(MONITOR_TARGET_TYPES).not.toContain(EBAY_ORDERS_TARGET_TYPE);
  });
});

describe("ebay_orders poll executor", () => {
  let targetId = "";

  it("creates exactly one sync target for the connection", async () => {
    const cursor = await ensureEbayOrderSyncTarget(handle.db, { connectionId });
    targetId = cursor.monitorTargetId;
    const again = await ensureEbayOrderSyncTarget(handle.db, { connectionId });
    expect(again.monitorTargetId).toBe(targetId);
    expect(cursor.modifiedAfter).toBeNull();
  });

  it("ingests every page and advances the cursor", async () => {
    const source = orderSourceFor(connectionId);
    source.orders = [
      orderFact({ orderId: "E-9001", lastModifiedDate: "2026-08-01T10:00:00.000Z" }),
      orderFact({ orderId: "E-9002", lastModifiedDate: "2026-08-01T11:00:00.000Z" }),
      orderFact({ orderId: "E-9003", lastModifiedDate: "2026-08-01T12:00:00.000Z" }),
    ];

    const polled = await pollOnce(targetId);
    expect(await orderCount(connectionId)).toBe(3);

    const state = commerceSyncState(polled);
    expect(state["lastOrderCount"]).toBe(3);
    expect(typeof state["modifiedAfter"]).toBe("string");
    // The first poll had no watermark at all.
    expect(source.modifiedAfter[0]).toBeNull();
  });

  it("stores a real seller-side fee, unlike the WooCommerce leg", async () => {
    const rows = await handle.pool.query<{
      fee_amount: string;
      fee_direction: string;
      provider: string;
      marketplace: string | null;
    }>(
      `select o.fee_amount, f.fee_direction, o.provider, o.marketplace
         from orders o
         join order_fees f on f.order_id = o.id
        where o.connection_id = $1 and o.external_order_id = $2`,
      [connectionId, "E-9001"],
    );
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0]?.fee_amount)).toBeCloseTo(7.42, 6);
    expect(rows.rows[0]?.fee_direction).toBe("seller_charge");
    expect(rows.rows[0]?.provider).toBe("ebay");
    expect(rows.rows[0]?.marketplace).toBe("EBAY_US");
  });

  it("hands the stored watermark to the next poll and ingests only what is newer", async () => {
    const source = orderSourceFor(connectionId);
    const cursor = await readEbayOrderSyncCursor(handle.db, connectionId);
    expect(cursor?.modifiedAfter).not.toBeNull();

    source.orders.push(
      orderFact({ orderId: "E-9004", lastModifiedDate: "2026-08-02T09:00:00.000Z" }),
    );
    await pollOnce(targetId);

    // The second call carried the stored watermark…
    expect(source.modifiedAfter[1]?.toISOString()).toBe(
      cursor?.modifiedAfter?.toISOString(),
    );
    // …and the new order landed without duplicating the first three.
    expect(await orderCount(connectionId)).toBe(4);
  });

  it("is idempotent across polls: a re-read creates nothing", async () => {
    const before = await orderCount(connectionId);
    await pollOnce(targetId);
    expect(await orderCount(connectionId)).toBe(before);
  });
});

describe("ebay_orders failure path", () => {
  let failingTargetId = "";

  it("records a poll failure with backoff and a connection error", async () => {
    const cursor = await ensureEbayOrderSyncTarget(handle.db, {
      connectionId: failingConnectionId,
    });
    failingTargetId = cursor.monitorTargetId;
    orderSourceFor(failingConnectionId).failWith = new EbayAdapterError(
      "provider_unavailable",
      "eBay is down",
    );

    const row = await pollOnceExpectingFailure(failingTargetId);
    expect(row.consecutiveErrors).toBeGreaterThan(0);
    expect(row.backoffUntil).not.toBeNull();

    const connection = await services.connections.getConnection(
      failingConnectionId,
    );
    expect(connection.lastErrorCode).toBe("ebay_provider_unavailable");
  });

  it("an auth failure additionally drops the cached adapter", async () => {
    invalidated.length = 0;
    orderSourceFor(failingConnectionId).failWith = new EbayAdapterError(
      "auth",
      "insufficient scope for sell.fulfillment",
    );
    await pollOnceExpectingFailure(failingTargetId);
    // The expected shape of "consented for the watchlist, not for orders":
    // re-consent must be picked up on the next poll, not after the cache TTL.
    expect(invalidated).toContain(failingConnectionId);

    const connection = await services.connections.getConnection(
      failingConnectionId,
    );
    expect(connection.lastErrorCode).toBe("ebay_auth");
  });

  it("recovers once the provider answers again", async () => {
    orderSourceFor(failingConnectionId).failWith = null;
    orderSourceFor(failingConnectionId).orders = [
      orderFact({ orderId: "E-8001", lastModifiedDate: "2026-08-05T09:00:00.000Z" }),
    ];
    await pollOnce(failingTargetId);
    expect(await orderCount(failingConnectionId)).toBe(1);
    const row = await readTarget(failingTargetId);
    expect(row.consecutiveErrors).toBe(0);
  });
});
