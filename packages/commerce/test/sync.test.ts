/**
 * Incremental sync and scheduling-state tests.
 *
 * The WooCommerce adapter is exercised for real — `createWooAdapter` with an
 * injected `fetchImpl`, not a hand-rolled fake — so the pagination headers,
 * the `modified_after` query construction, and `mapWooOrder`'s payload quirks
 * are all in the path under test. Only the network is stubbed.
 */
import { createRateBudget, createWooAdapter } from "@loxep/integration-woo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMMERCE_SYNC_CONFIG_KEY,
  CURSOR_OVERLAP_SECONDS,
  WOO_ORDERS_TARGET_TYPE,
  createWooOrderSync,
  ensureWooOrderSyncTarget,
  readWooOrderSyncCursor,
  wooOrdersTargetConfigSchema,
} from "../src/sync.ts";
import {
  SYNC_WOO_ORDERS_TASK_NAME,
  createCommerceTasks,
  wooOrderSyncJobKey,
} from "../src/tasks.ts";
import { wooOrderPayload } from "./fixtures.ts";
import { createMigratedScratchDb, seedConnection, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

const BASE_URL = "https://shop.example.test";

interface StubbedRequest {
  url: string;
  query: URLSearchParams;
}

/**
 * A stub `fetch` serving pages of order payloads with the WordPress pagination
 * headers the adapter drives itself from.
 */
function stubFetch(pages: Array<Array<Record<string, unknown>>>): {
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  requests: StubbedRequest[];
} {
  const requests: StubbedRequest[] = [];
  const total = pages.reduce((sum, page) => sum + page.length, 0);
  return {
    requests,
    fetchImpl: async (input: string) => {
      const url = new URL(input);
      requests.push({ url: input, query: url.searchParams });
      const page = Number(url.searchParams.get("page") ?? "1");
      const body = pages[page - 1] ?? [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-wp-total": String(total),
          "x-wp-totalpages": String(pages.length),
        },
      });
    },
  };
}

function adapterFor(pages: Array<Array<Record<string, unknown>>>) {
  const stub = stubFetch(pages);
  const adapter = createWooAdapter({
    baseUrl: BASE_URL,
    consumerKey: "ck_test",
    consumerSecret: "cs_test",
    fetchImpl: stub.fetchImpl,
    // A real budget with generous limits: the stub fetch is instant, so the
    // adapter's own limiter is the only thing that could slow the suite down.
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  return { adapter, requests: stub.requests };
}

describe("woocommerce order sync", () => {
  let scratch: ScratchDb;
  let connectionId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_sync");
    const entityId = await seedEntity(scratch, "Syracuse Synergy LLC");
    connectionId = await seedConnection(scratch, {
      name: "syracusesynergy",
      economicEntityId: entityId,
    });
  });

  afterAll(async () => {
    await scratch.close();
  });

  it("creates exactly one 'woo_orders' monitor target per connection", async () => {
    const first = await ensureWooOrderSyncTarget(scratch.handle.db, {
      connectionId,
    });
    const second = await ensureWooOrderSyncTarget(scratch.handle.db, {
      connectionId,
    });
    expect(second.monitorTargetId).toBe(first.monitorTargetId);

    const rows = await scratch.handle.pool.query<{
      target_type: string;
      enabled: boolean;
      next_poll_at: Date | null;
      interval_seconds: number;
    }>(
      `select target_type, enabled, next_poll_at, interval_seconds
         from monitor_targets where connection_id = $1`,
      [connectionId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.target_type).toBe(WOO_ORDERS_TARGET_TYPE);
    expect(rows.rows[0]?.enabled).toBe(true);
    // Immediately due, so the existing dispatcher can claim it.
    expect(rows.rows[0]?.next_poll_at).not.toBeNull();
  });

  it("validates the target-type config contract", () => {
    expect(
      wooOrdersTargetConfigSchema.safeParse({
        [COMMERCE_SYNC_CONFIG_KEY]: { modifiedAfter: "2026-08-01T00:00:00Z" },
      }).success,
    ).toBe(true);
    // Foreign namespaces (the scheduler's `adaptive`) pass through untouched.
    expect(
      wooOrdersTargetConfigSchema.safeParse({
        adaptive: { enabled: false, unchangedStreak: 3 },
      }).success,
    ).toBe(true);
    // A typo inside our own namespace is rejected.
    expect(
      wooOrdersTargetConfigSchema.safeParse({
        [COMMERCE_SYNC_CONFIG_KEY]: { modifedAfter: "2026-08-01T00:00:00Z" },
      }).success,
    ).toBe(false);
  });

  it("ingests every page and advances the cursor with a rewind", async () => {
    const { adapter, requests } = adapterFor([
      [
        wooOrderPayload({ id: 7001, dateModifiedGmt: "2026-08-01T10:00:00" }),
        wooOrderPayload({ id: 7002, dateModifiedGmt: "2026-08-01T11:00:00" }),
      ],
      [wooOrderPayload({ id: 7003, dateModifiedGmt: "2026-08-01T12:00:00" })],
    ]);
    const sync = createWooOrderSync({
      db: scratch.handle.db,
      adapterFactory: () => adapter,
    });

    const result = await sync.syncConnection({ connectionId, perPage: 2 });
    expect(result.pages).toBe(2);
    expect(result.ordersSeen).toBe(3);
    expect(result.created).toBe(3);
    expect(result.currencies).toEqual(["USD"]);

    // The high watermark is the newest `date_modified_gmt` seen, rewound by
    // the overlap so a same-second tie across a page boundary is re-read.
    const expected =
      new Date("2026-08-01T12:00:00Z").getTime() - CURSOR_OVERLAP_SECONDS * 1000;
    expect(result.nextModifiedAfter?.getTime()).toBe(expected);

    const cursor = await readWooOrderSyncCursor(scratch.handle.db, connectionId);
    expect(cursor?.modifiedAfter?.getTime()).toBe(expected);
    expect(cursor?.lastOrderCount).toBe(3);

    // The first request carried no watermark; the sort is ascending by
    // modification date when one is present.
    expect(requests[0]?.query.get("modified_after")).toBeNull();
    expect(requests[0]?.query.get("per_page")).toBe("2");
  });

  it("passes the stored cursor to the provider on the next run", async () => {
    const { adapter, requests } = adapterFor([[]]);
    const sync = createWooOrderSync({
      db: scratch.handle.db,
      adapterFactory: () => adapter,
    });
    const before = await readWooOrderSyncCursor(scratch.handle.db, connectionId);
    const result = await sync.syncConnection({ connectionId });

    expect(requests[0]?.query.get("modified_after")).toBe(
      before?.modifiedAfter?.toISOString(),
    );
    expect(requests[0]?.query.get("dates_are_gmt")).toBe("true");
    expect(requests[0]?.query.get("orderby")).toBe("modified");
    expect(requests[0]?.query.get("order")).toBe("asc");
    expect(result.ordersSeen).toBe(0);
    // An empty page must not move the watermark backwards.
    expect(result.nextModifiedAfter?.getTime()).toBe(
      before?.modifiedAfter?.getTime(),
    );
  });

  it("is idempotent: re-running the same slice creates nothing new", async () => {
    const payloads = [
      wooOrderPayload({ id: 7101, dateModifiedGmt: "2026-08-02T10:00:00" }),
      wooOrderPayload({ id: 7102, dateModifiedGmt: "2026-08-02T11:00:00" }),
    ];
    const sync = createWooOrderSync({
      db: scratch.handle.db,
      adapterFactory: () => adapterFor([payloads]).adapter,
    });

    const first = await sync.syncConnection({
      connectionId,
      modifiedAfter: null,
      persistCursor: false,
    });
    const second = await sync.syncConnection({
      connectionId,
      modifiedAfter: null,
      persistCursor: false,
    });

    expect(first.created).toBe(2);
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(2);

    const orders = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n from orders
        where connection_id = $1 and external_order_id = any($2::text[])`,
      [connectionId, ["7101", "7102"]],
    );
    expect(Number(orders.rows[0]?.n)).toBe(2);
  });

  it("exposes a task list and a per-connection job key for @loxep/app", async () => {
    const commerce = createCommerceTasks({
      db: scratch.handle.db,
      adapterFactory: () => adapterFor([[]]).adapter,
    });
    expect(commerce.tasks).toHaveLength(1);
    expect(commerce.syncWooOrdersTask.name).toBe(SYNC_WOO_ORDERS_TASK_NAME);
    expect(wooOrderSyncJobKey(connectionId)).toBe(
      `${SYNC_WOO_ORDERS_TASK_NAME}:${connectionId}`,
    );
    // The payload schema is what a registry validates before the handler runs.
    expect(
      commerce.syncWooOrdersTask.payloadSchema.safeParse({ connectionId })
        .success,
    ).toBe(true);
    expect(
      commerce.syncWooOrdersTask.payloadSchema.safeParse({
        connectionId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});
