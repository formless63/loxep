/**
 * Medusa commerce sync wiring (loxep-xxz) through the REAL Graphile Worker
 * runtime and the REAL composed registry:
 *
 * ```text
 * medusa_orders target (created by @loxep/commerce's ensureMedusaOrderSyncTarget)
 *   → market.dispatch-due-monitors  → market.poll-target
 *   → the ROUTED poll executor      → @loxep/app's medusa_orders branch
 *   → @loxep/commerce syncConnection → orders/lines/refunds/fulfillments rows
 *   → config.commerceSync watermark  → recordPollSuccess (next_poll_at)
 * ```
 *
 * Unlike `commerce-ebay-sync.test.ts`, which stubs at the PAGE-ITERATOR
 * option (`ebayOrders`), this file stubs at the ADAPTER level
 * (`getMedusaAdapterForConnection`) — `registry.ts`'s module doc names this
 * as the pattern to copy. The default `createMedusaOrderPageIterator` and
 * the REAL `iterateMedusaOrders` (including its fail-open watermark canary,
 * `assertWatermarkHonored`) run unmodified against a fake `MedusaAdapter`
 * whose `.paginate()` serves canned RAW order payloads — so this file is also
 * the structural-compatibility guard for `@loxep/commerce`'s deliberate
 * re-declaration of `MedusaOrderFactLike`: the facts flowing through
 * `ingestMedusaOrder` are produced by the REAL `mapMedusaOrder`.
 *
 * The things it is here to prove:
 *
 * 1. `medusa_orders` is claimable, routable, AND covered by `@loxep/market`'s
 *    `createMonitorService` CRUD (registered from the start, unlike
 *    `ebay_orders`'s original split-registration gap);
 * 2. the dispatcher claims it and the app executor runs the commerce sync,
 *    advancing the cursor so a second poll asks for only what is newer, and
 *    the fail-open watermark filter is genuinely exercised (not bypassed);
 * 3. a provider failure records a poll failure with backoff AND puts the
 *    connection into its error state;
 * 4. an `auth` failure additionally invalidates the cached adapter so a
 *    re-keyed connection recovers on the next poll.
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
  MEDUSA_ORDERS_TARGET_TYPE,
  SYNC_MEDUSA_ORDERS_TASK_NAME,
  ensureMedusaOrderSyncTarget,
  readMedusaOrderSyncCursor,
} from "@loxep/commerce";
import { MedusaAdapterError } from "@loxep/integration-medusa";
import type {
  MedusaAdapter,
  MedusaListPage,
  MedusaPaginateOptions,
} from "@loxep/integration-medusa";
import { buildAppServices, buildWorkerRegistry } from "../src/index.ts";
import type {
  AppServices,
  MedusaConnectionAdapter,
  WorkerComposition,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_medusa_orders");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let connectionId = "";
let failingConnectionId = "";

const invalidated: string[] = [];

/* ------------------------------------------------------- the provider seam */

/** One raw Medusa order payload — the Admin API's own shape, not a fact. */
function medusaOrderPayload(input: {
  id: string;
  updatedAt: string;
  status?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  total?: number;
  originalTotal?: number;
}): Record<string, unknown> {
  return {
    id: input.id,
    display_id: 1,
    status: input.status ?? "completed",
    payment_status: input.paymentStatus ?? "captured",
    fulfillment_status: input.fulfillmentStatus ?? "not_fulfilled",
    currency_code: "usd",
    total: input.total ?? 59,
    original_total: input.originalTotal ?? input.total ?? 59,
    subtotal: 55,
    shipping_total: 5,
    tax_total: 4,
    discount_total: 0,
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: input.updatedAt,
    customer_id: "cus_TEST",
    items: [
      {
        id: `${input.id}-line-1`,
        title: "Alpha widget",
        variant_sku: "SKU-ALPHA",
        product_id: "prod_TEST",
        variant_id: "variant_TEST",
        quantity: 2,
        unit_price: 25,
        subtotal: 50,
        total: 50,
        tax_total: 4,
        discount_total: 0,
      },
    ],
    payment_collections: [],
    fulfillments: [],
  };
}

interface FakeMedusaOrderSource {
  /** Every order the backend has, RAW payload shape. */
  orders: Record<string, unknown>[];
  /** When set, `.paginate()` throws it instead of yielding. */
  failWith: MedusaAdapterError | null;
  /** `updated_at[$gte]` values `.paginate()` was called with, in call order. */
  updatedAfterCalls: Array<string | undefined>;
}

const orderSources = new Map<string, FakeMedusaOrderSource>();

function orderSourceFor(connection: string): FakeMedusaOrderSource {
  let source = orderSources.get(connection);
  if (source === undefined) {
    source = { orders: [], failWith: null, updatedAfterCalls: [] };
    orderSources.set(connection, source);
  }
  return source;
}

/**
 * A fake `MedusaAdapter` whose `.paginate()` filters and pages RAW order
 * payloads itself — the same "only the HTTP call is canned" discipline
 * `helpers.ts`'s `fakeConnectionAdapter` uses for eBay. Because
 * `iterateMedusaOrders` (the REAL function from `@loxep/integration-medusa`)
 * drives this adapter unmodified, its `assertWatermarkHonored` canary is
 * genuinely exercised: an incorrect filter here would trip it, exactly as it
 * would against a real misbehaving backend.
 */
function fakeMedusaAdapter(
  connectionId: string,
  source: FakeMedusaOrderSource,
): MedusaAdapter {
  const baseUrl = `https://medusa-fake.example.invalid/${connectionId}`;
  const sourceAccountKey = `medusa:${baseUrl}`;
  async function* paginate(
    _path: string,
    _resultKey: string,
    options: MedusaPaginateOptions = {},
  ): AsyncGenerator<MedusaListPage, void, undefined> {
    if (source.failWith !== null) throw source.failWith;
    const watermark = options.query?.["updated_at[$gte]"];
    const watermarkText = typeof watermark === "string" ? watermark : undefined;
    source.updatedAfterCalls.push(watermarkText);
    const matching =
      watermarkText === undefined
        ? source.orders
        : source.orders.filter(
            (order) => String(order["updated_at"]) >= watermarkText,
          );
    const sorted = [...matching].sort((a, b) =>
      String(a["updated_at"]).localeCompare(String(b["updated_at"])),
    );
    const limit = options.limit ?? 50;
    const start = options.startOffset ?? 0;
    for (let offset = start; offset < sorted.length; offset += limit) {
      const items = sorted.slice(offset, offset + limit);
      yield {
        items,
        page: {
          offset,
          limit,
          count: sorted.length,
          hasNextPage: offset + items.length < sorted.length,
        },
      };
    }
  }
  return {
    baseUrl,
    sourceAccountKey,
    get: () => {
      throw new Error("fakeMedusaAdapter.get is not implemented");
    },
    list: () => {
      throw new Error("fakeMedusaAdapter.list is not implemented");
    },
    paginate,
    stats: () => ({
      baseUrl,
      sourceAccountKey,
      rateBudget: {
        capacity: 5,
        refillPerSecond: 2,
        available: 5,
        pending: 0,
        acquired: 0,
        rejected: 0,
      },
      requests: 0,
    }),
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
    { timeoutMs: 30_000, label: `poll of medusa_orders target ${targetId}` },
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
    { timeoutMs: 30_000, label: `poll failure of medusa_orders target ${targetId}` },
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
  // Stub at the ADAPTER level, per `registry.ts`'s module doc — the default
  // page iterator and the REAL `iterateMedusaOrders` run unmodified against
  // this fake adapter, so the fail-open watermark canary is exercised for
  // real. `invalidateMedusaAdapter` is captured rather than stubbed away,
  // because the auth-failure contract asserts it.
  services = {
    ...real,
    getMedusaAdapterForConnection: async (id): Promise<MedusaConnectionAdapter> => {
      const source = orderSourceFor(id);
      const adapter = fakeMedusaAdapter(id, source);
      return {
        connectionId: id,
        baseUrl: adapter.baseUrl,
        sourceAccountKey: adapter.sourceAccountKey,
        adapter,
        minIntervalSeconds: 60,
      };
    },
    invalidateMedusaAdapter: (id) => {
      invalidated.push(id);
    },
  };

  composition = buildWorkerRegistry({
    config,
    services,
    logger: silentJobsLogger,
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
    id: "test-user-medusa",
    name: "Test User",
    email: "medusa-commerce@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const connection = await services.connections.createConnection({
    provider: "medusa",
    kind: "store",
    name: "verification backend",
    createdByUserId: "test-user-medusa",
  });
  connectionId = connection.id;

  const failing = await services.connections.createConnection({
    provider: "medusa",
    kind: "store",
    name: "broken backend",
    createdByUserId: "test-user-medusa",
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

describe("'medusa_orders' registration state", () => {
  it("registers the on-demand task in the composed registry", () => {
    expect(composition.registry.has(SYNC_MEDUSA_ORDERS_TASK_NAME)).toBe(true);
    // The poll route and the on-demand task share ONE sync service.
    expect(composition.commerce.medusaSync).not.toBeNull();
  });

  it("IS registered in @loxep/market's target-type union from the start", () => {
    expect(MONITOR_TARGET_TYPES).toContain(MEDUSA_ORDERS_TARGET_TYPE);
  });
});

describe("medusa_orders poll executor", () => {
  let targetId = "";

  it("creates exactly one sync target for the connection", async () => {
    const cursor = await ensureMedusaOrderSyncTarget(handle.db, { connectionId });
    targetId = cursor.monitorTargetId;
    const again = await ensureMedusaOrderSyncTarget(handle.db, { connectionId });
    expect(again.monitorTargetId).toBe(targetId);
    expect(cursor.modifiedAfter).toBeNull();
  });

  it("ingests every page and advances the cursor", async () => {
    const source = orderSourceFor(connectionId);
    source.orders = [
      medusaOrderPayload({ id: "order_9001", updatedAt: "2026-08-01T10:00:00.000Z" }),
      medusaOrderPayload({ id: "order_9002", updatedAt: "2026-08-01T11:00:00.000Z" }),
      medusaOrderPayload({ id: "order_9003", updatedAt: "2026-08-01T12:00:00.000Z" }),
    ];

    const polled = await pollOnce(targetId);
    expect(await orderCount(connectionId)).toBe(3);

    const state = commerceSyncState(polled);
    expect(state["lastOrderCount"]).toBe(3);
    expect(typeof state["modifiedAfter"]).toBe("string");
    // The first poll had no watermark at all.
    expect(source.updatedAfterCalls[0]).toBeUndefined();
  });

  it("records zero fees — the adapter's own honest gap, not a translation bug", async () => {
    const rows = await handle.pool.query<{ fee_amount: string }>(
      `select o.fee_amount
         from orders o
        where o.connection_id = $1 and o.external_order_id = $2`,
      [connectionId, "order_9001"],
    );
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0]?.fee_amount)).toBe(0);
    const fees = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n
         from order_fees f
         join orders o on o.id = f.order_id
        where o.connection_id = $1`,
      [connectionId],
    );
    expect(Number(fees.rows[0]?.n)).toBe(0);
  });

  it("hands the stored watermark to the next poll and ingests only what is newer", async () => {
    const source = orderSourceFor(connectionId);
    const cursor = await readMedusaOrderSyncCursor(handle.db, connectionId);
    expect(cursor?.modifiedAfter).not.toBeNull();

    source.orders.push(
      medusaOrderPayload({ id: "order_9004", updatedAt: "2026-08-02T09:00:00.000Z" }),
    );
    await pollOnce(targetId);

    // The second call carried the stored (rewound) watermark…
    expect(source.updatedAfterCalls[1]).toBe(cursor?.modifiedAfter?.toISOString());
    // …and the new order landed without duplicating the first three.
    expect(await orderCount(connectionId)).toBe(4);
  });

  it("is idempotent across polls: a re-read creates nothing", async () => {
    const before = await orderCount(connectionId);
    await pollOnce(targetId);
    expect(await orderCount(connectionId)).toBe(before);
  });
});

describe("medusa_orders failure path", () => {
  let failingTargetId = "";

  it("records a poll failure with backoff and a connection error", async () => {
    const cursor = await ensureMedusaOrderSyncTarget(handle.db, {
      connectionId: failingConnectionId,
    });
    failingTargetId = cursor.monitorTargetId;
    orderSourceFor(failingConnectionId).failWith = new MedusaAdapterError(
      "provider_unavailable",
      "Medusa backend is down",
    );

    const row = await pollOnceExpectingFailure(failingTargetId);
    expect(row.consecutiveErrors).toBeGreaterThan(0);
    expect(row.backoffUntil).not.toBeNull();

    const connection = await services.connections.getConnection(
      failingConnectionId,
    );
    expect(connection.lastErrorCode).toBe("medusa_provider_unavailable");
  });

  it("an auth failure additionally drops the cached adapter", async () => {
    invalidated.length = 0;
    orderSourceFor(failingConnectionId).failWith = new MedusaAdapterError(
      "auth",
      "secret API key rejected",
    );
    await pollOnceExpectingFailure(failingTargetId);
    expect(invalidated).toContain(failingConnectionId);

    const connection = await services.connections.getConnection(
      failingConnectionId,
    );
    expect(connection.lastErrorCode).toBe("medusa_auth");
  });

  it("recovers once the provider answers again", async () => {
    orderSourceFor(failingConnectionId).failWith = null;
    orderSourceFor(failingConnectionId).orders = [
      medusaOrderPayload({ id: "order_8001", updatedAt: "2026-08-05T09:00:00.000Z" }),
    ];
    await pollOnce(failingTargetId);
    expect(await orderCount(failingConnectionId)).toBe(1);
    const row = await readTarget(failingTargetId);
    expect(row.consecutiveErrors).toBe(0);
  });
});
