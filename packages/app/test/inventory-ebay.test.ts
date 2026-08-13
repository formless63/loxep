/**
 * eBay purchase-sync wiring (Flipping M5, loxep-dgf.5) through the REAL
 * Graphile Worker runtime and the REAL composed registry — the structural
 * mirror of `commerce-ebay-sync.test.ts`, one domain over:
 *
 * ```text
 * ebay_purchases target (created by @loxep/inventory's ensurePurchaseSyncTarget)
 *   → market.dispatch-due-monitors  → market.poll-target
 *   → the ROUTED poll executor      → @loxep/app's ebay_purchases branch
 *   → @loxep/inventory syncConnection → fetchAllWonPurchases (REAL mapper,
 *                                       via `fakeConnectionAdapter`'s
 *                                       `tradingCall` stub — only the HTTP
 *                                       call is canned)
 *                                     → draft acquisitions + acquisition_costs
 *   → config.purchaseSync watermark  → recordPollSuccess (next_poll_at)
 * ```
 *
 * The provider seam is NOT overridden with a fake `EbayPurchasePageIterator`:
 * `createEbayPurchasePageIterator` and `fetchAllWonPurchases`/
 * `groupWonListEntries`/`mapWonListTransaction` all run for real, against
 * `fakeConnectionAdapter`'s `tradingCall`, which now returns a `WonList`
 * container alongside its existing `WatchList` one (see `helpers.ts`'s
 * `FakeEbayState.wonList`) — so this file also stands in as the
 * structural-compatibility guard `commerce-ebay-sync.test.ts`'s module doc
 * describes for the order mapper.
 *
 * Four things this file proves:
 *
 * 1. `ebay_purchases` is claimable, routable, AND covered by
 *    `@loxep/market`'s `createMonitorService` CRUD (registered together with
 *    its config schema, unlike the `ebay_orders` split-registration gap);
 * 2. the dispatcher claims it and the app executor runs the REAL purchase
 *    sync, creating one `draft` acquisition per won checkout with its
 *    goods/shipping/tax costs, and advancing the watermark;
 * 3. a re-poll of the same `WonList` data is a full idempotent no-op — no
 *    duplicate acquisitions — proving the (connection, external_reference)
 *    look-then-insert this design's missing migration will eventually back
 *    with a real constraint;
 * 4. a provider failure records a poll failure with backoff AND puts the
 *    connection into its error state, and an `auth` failure additionally
 *    invalidates the cached adapter — identical contract to `ebay_orders`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { MONITOR_TARGET_TYPES, createMarketTasks } from "@loxep/market";
import {
  EBAY_PURCHASES_TARGET_TYPE,
  PURCHASE_SYNC_CONFIG_KEY,
  ensurePurchaseSyncTarget,
  readPurchaseSyncCursor,
} from "@loxep/inventory";
import { EbayAdapterError } from "@loxep/integration-ebay";
import {
  SYNC_EBAY_PURCHASES_TASK_NAME,
  buildAppServices,
  buildWorkerRegistry,
} from "../src/index.ts";
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

const dbName = scratchDbName("loxep_test_app_ebay_purchases");
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

/** One raw `WonList` `OrderTransaction` entry — the shape `purchases.ts` maps. */
function wonEntry(input: {
  orderId: string;
  transactionId: string;
  itemPrice?: number;
  shipping?: number;
  tax?: number;
  purchasedAt?: string;
}): Record<string, unknown> {
  return {
    Transaction: {
      TransactionID: input.transactionId,
      Item: {
        ItemID: 110000000000 + Number(input.transactionId.replace(/\D/g, "") || 0),
        Title: `Won item ${input.transactionId}`,
        SKU: "SKU-1",
      },
      Seller: { UserID: "sandbox_seller" },
      TransactionPrice: { value: input.itemPrice ?? 19.99, currencyID: "USD" },
      QuantityPurchased: 1,
      CreatedDate: input.purchasedAt ?? "2026-08-10T12:00:00.000Z",
      ShippingDetails: {
        ShippingServiceOptions: {
          ShippingServiceCost: { value: input.shipping ?? 4.5, currencyID: "USD" },
        },
        SalesTax: { SalesTaxAmount: { value: input.tax ?? 1.75, currencyID: "USD" } },
      },
    },
    Order: { OrderID: input.orderId, CreatedTime: input.purchasedAt ?? "2026-08-10T12:00:00.000Z" },
  };
}

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
    { timeoutMs: 30_000, label: `poll of ebay_purchases target ${targetId}` },
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
    { timeoutMs: 30_000, label: `poll failure of ebay_purchases target ${targetId}` },
  );
}

async function acquisitionCount(connection: string): Promise<number> {
  const rows = await handle.pool.query<{ n: string }>(
    `select count(*)::text as n from acquisitions where connection_id = $1`,
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
  services = {
    ...real,
    getEbayAdapterForConnection: async (id) =>
      fakeConnectionAdapter(id, ebayStateFor(id)),
    invalidateEbayAdapter: (id) => {
      invalidated.push(id);
    },
  };

  composition = buildWorkerRegistry({ config, services, logger: silentJobsLogger });

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
    email: "ebay-purchases@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const connection = await services.connections.createConnection({
    provider: "ebay",
    kind: "marketplace",
    name: "sandbox buyer",
    createdByUserId: "test-user",
  });
  connectionId = connection.id;

  const failing = await services.connections.createConnection({
    provider: "ebay",
    kind: "marketplace",
    name: "broken buyer",
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

describe("'ebay_purchases' registration state", () => {
  it("registers the on-demand task in the composed registry", () => {
    expect(composition.registry.has(SYNC_EBAY_PURCHASES_TASK_NAME)).toBe(true);
  });

  it("IS registered in @loxep/market's target-type union", () => {
    expect(MONITOR_TARGET_TYPES).toContain(EBAY_PURCHASES_TARGET_TYPE);
  });
});

describe("ebay_purchases poll executor", () => {
  let targetId = "";

  it("creates exactly one sync target for the connection", async () => {
    const cursor = await ensurePurchaseSyncTarget(handle.db, { connectionId });
    targetId = cursor.monitorTargetId;
    const again = await ensurePurchaseSyncTarget(handle.db, { connectionId });
    expect(again.monitorTargetId).toBe(targetId);
    expect(cursor.lastPurchasedAt).toBeNull();
  });

  it("ingests won items into draft acquisitions and advances the watermark", async () => {
    ebayStateFor(connectionId).wonList = [
      wonEntry({ orderId: "ORD-1", transactionId: "1001", purchasedAt: "2026-08-01T10:00:00.000Z" }),
      wonEntry({ orderId: "ORD-2", transactionId: "1002", purchasedAt: "2026-08-02T10:00:00.000Z" }),
    ];

    const polled = await pollOnce(targetId);
    expect(await acquisitionCount(connectionId)).toBe(2);

    const state = polled.config[PURCHASE_SYNC_CONFIG_KEY] as Record<string, unknown>;
    expect(state["lastPurchaseCount"]).toBe(2);
    expect(state["lastPurchasedAt"]).toBe("2026-08-02T10:00:00.000Z");

    const rows = await handle.pool.query<{
      status: string;
      source_kind: string;
      external_reference: string;
    }>(
      `select status, source_kind, external_reference from acquisitions
        where connection_id = $1 order by external_reference`,
      [connectionId],
    );
    expect(rows.rows.map((row) => row.external_reference)).toEqual([
      "ORD-1",
      "ORD-2",
    ]);
    for (const row of rows.rows) {
      expect(row.status).toBe("draft");
      expect(row.source_kind).toBe("online_marketplace");
    }
  });

  it("writes goods/inbound_freight/sales_tax costs for the ingested lot", async () => {
    const rows = await handle.pool.query<{
      cost_type: string;
      cost_class: string;
      amount: string;
    }>(
      `select ac.cost_type, ac.cost_class, ac.amount::text as amount
         from acquisition_costs ac
         join acquisitions a on a.id = ac.acquisition_id
        where a.connection_id = $1 and a.external_reference = 'ORD-1'
        order by ac.cost_type`,
      [connectionId],
    );
    expect(rows.rows.map((row) => row.cost_type).sort()).toEqual([
      "goods",
      "inbound_freight",
      "sales_tax",
    ]);
    const goods = rows.rows.find((row) => row.cost_type === "goods");
    expect(goods?.cost_class).toBe("goods");
    expect(Number(goods?.amount)).toBeCloseTo(19.99, 6);
  });

  it("is idempotent across polls: a re-read creates nothing", async () => {
    const before = await acquisitionCount(connectionId);
    await pollOnce(targetId);
    expect(await acquisitionCount(connectionId)).toBe(before);
  });
});

describe("ebay_purchases failure path", () => {
  let failingTargetId = "";

  it("records a poll failure with backoff and a connection error", async () => {
    const cursor = await ensurePurchaseSyncTarget(handle.db, {
      connectionId: failingConnectionId,
    });
    failingTargetId = cursor.monitorTargetId;
    ebayStateFor(failingConnectionId).failWith = new EbayAdapterError(
      "provider_unavailable",
      "eBay is down",
    );

    const row = await pollOnceExpectingFailure(failingTargetId);
    expect(row.consecutiveErrors).toBeGreaterThan(0);
    expect(row.backoffUntil).not.toBeNull();

    const connection = await services.connections.getConnection(failingConnectionId);
    expect(connection.lastErrorCode).toBe("ebay_provider_unavailable");
  });

  it("an auth failure additionally drops the cached adapter", async () => {
    invalidated.length = 0;
    ebayStateFor(failingConnectionId).failWith = new EbayAdapterError(
      "auth",
      "expired user token",
    );
    await pollOnceExpectingFailure(failingTargetId);
    expect(invalidated).toContain(failingConnectionId);

    const connection = await services.connections.getConnection(failingConnectionId);
    expect(connection.lastErrorCode).toBe("ebay_auth");
  });

  it("recovers once the provider answers again", async () => {
    ebayStateFor(failingConnectionId).failWith = null;
    ebayStateFor(failingConnectionId).wonList = [
      wonEntry({ orderId: "ORD-9001", transactionId: "9001" }),
    ];
    await pollOnce(failingTargetId);
    expect(await acquisitionCount(failingConnectionId)).toBe(1);
    const row = await readTarget(failingTargetId);
    expect(row.consecutiveErrors).toBe(0);
  });
});

/** Read the stored purchase-sync cursor directly, for a sanity cross-check. */
describe("readPurchaseSyncCursor", () => {
  it("agrees with the monitor_targets row @loxep/market's service reads", async () => {
    const cursor = await readPurchaseSyncCursor(handle.db, connectionId);
    expect(cursor?.lastPurchaseCount).toBe(2);
    expect(cursor?.lastPurchasedAt?.toISOString()).toBe("2026-08-02T10:00:00.000Z");
  });
});
