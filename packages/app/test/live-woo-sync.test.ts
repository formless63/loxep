/**
 * LIVE tier for the commerce wiring — one bounded order sync against a REAL
 * production WooCommerce store, driven end to end through the REAL composed
 * worker registry. Requires `LOXEP_LIVE_TESTS=woo` (or `=all`) before
 * inspecting `~/.config/loxep/woo.env`; an opted-in run skips cleanly when
 * that file is absent.
 *
 * ## What this tier proves that the mocked e2e cannot
 *
 * `packages/commerce`'s own live test drives `createWooOrderSync` directly
 * with an adapter it constructs from the env file. This one proves the
 * COMPOSITION: the store's key pair is stored as an ADR-0019
 * `woo_credentials` connection credential (encrypted, with the real keyring
 * cipher), the store URL is stored as the non-secret
 * `connections.config.woo.baseUrl`, and `@loxep/app`'s adapter factory
 * resolves both — so the whole "where does a Woo connection keep its two
 * halves" contract in `woo.ts` is exercised against a store that actually
 * answers. From there the dispatcher claims the registered `woo_orders`
 * target, `market.poll-target` runs the routed executor, and the commerce
 * sync service ingests.
 *
 * ABSOLUTE RULES honored here, and how:
 *
 * - **Read-only against the provider.** Every provider call is a GET through
 *   the adapter, which has no other method, using a read-only key pair.
 * - **Polite volume.** At most TWO pages of FIVE orders — the convention
 *   `packages/commerce/test/live-store.test.ts` established — enforced by the
 *   target's own `config.commerceSync.perPage`/`maxPages`, and the rate
 *   budget is set deliberately low.
 * - **No credential material and no customer PII in any output.** Every
 *   assertion receives booleans, numbers, or regex-checked scalars that are
 *   structurally incapable of being personal data. Order payloads — which
 *   carry billing/shipping addresses, email, phone, IP, and user agent — are
 *   never passed to `expect()`, never logged, never snapshotted. The
 *   {@link check} wrapper replaces any thrown assertion output with a message
 *   built solely from a hand-written label, so a vitest diff cannot print a
 *   payload.
 * - **The scratch database is dropped afterwards**, so the retained payloads
 *   do not outlive the test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { createMarketTasks, createMonitorService } from "@loxep/market";
import type { MonitorService, MonitorTargetRow } from "@loxep/market";
import {
  COMMERCE_SYNC_CONFIG_KEY,
  WOO_ORDERS_TARGET_TYPE,
} from "@loxep/commerce";
import { loadWooCredentialsFromEnvFile } from "@loxep/integration-woo";
import {
  WOO_ABSOLUTE_MIN_INTERVAL_SECONDS,
  WOO_CONNECTION_CONFIG_KEY,
  WOO_CREDENTIAL_TYPE,
  buildWorkerRegistry,
} from "../src/index.ts";
import type { WorkerComposition } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const optedIn = liveTestsEnabledFor("woo");
const creds = optedIn ? loadWooCredentialsFromEnvFile() : null;

if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-woo-sync] skipped: not opted in — set " +
      "LOXEP_LIVE_TESTS=woo (or =all) to run against the live instance.",
  );
} else if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-woo-sync] skipped: no credentials at ~/.config/loxep/woo.env",
  );
}

const describeLive = creds === null || !optedIn ? describe.skip : describe;

/** A bounded slice: five orders per page, at most two pages per sync. */
const PER_PAGE = 5;
const MAX_PAGES = 2;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const dbName = scratchDbName("loxep_test_app_live_woo");
let databaseUrl = "";
let handle: DbHandle;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let monitors: MonitorService;
let connectionId = "";
let targetId = "";
let polled: MonitorTargetRow;

/**
 * Run assertions with SCRUBBED failure output. Vitest prints the thrown
 * message and, for `expect` failures, a diff of the compared values — which
 * against a live store could be a customer's address.
 */
function check(label: string, assertions: () => void): void {
  try {
    assertions();
  } catch {
    throw new Error(`live-woo-sync assertion failed: ${label}`);
  }
}

function commerceSyncState(target: MonitorTargetRow): Record<string, unknown> {
  const config = target.config as Record<string, unknown> | null;
  const state = config?.[COMMERCE_SYNC_CONFIG_KEY];
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>)
    : {};
}

async function countOf(table: string): Promise<number> {
  const rows = await handle.pool.query<{ n: string }>(
    `select count(*)::text as n from ${table}`,
  );
  return Number(rows.rows[0]?.n ?? "0");
}

describeLive("live WooCommerce order sync through the worker", () => {
  beforeAll(async () => {
    if (creds === null) return;
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    const config = testConfig(databaseUrl);

    composition = buildWorkerRegistry({
      config,
      logger: silentJobsLogger,
      // Deliberately gentle against someone's production shop; this also
      // exercises the explicit-override-wins branch of the factory.
      wooRateBudget: { capacity: 4, refillPerSecond: 1 },
    });
    const services = composition.services;

    runtime = await startWorkerRuntime({
      databaseUrl,
      logger: silentJobsLogger,
      concurrency: 1,
      pollInterval: 200,
      registry: composition.registry,
      cronItems: [],
    });

    await handle.db.insert(user).values({
      id: "live-woo-user",
      name: "Live Woo User",
      email: "live-woo@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The NON-secret half on the connection…
    const connection = await services.connections.createConnection({
      provider: "woocommerce",
      kind: "store",
      name: "examplestore (live, read-only)",
      config: { [WOO_CONNECTION_CONFIG_KEY]: { baseUrl: creds.baseUrl } },
      createdByUserId: "live-woo-user",
    });
    connectionId = connection.id;

    // …and the secret half as an encrypted ADR-0019 bundle.
    await services.connectionCredentials.setCredential({
      connectionId,
      credentialType: WOO_CREDENTIAL_TYPE,
      payload: {
        consumerKey: creds.consumerKey,
        consumerSecret: creds.consumerSecret,
      },
      actorUserId: "live-woo-user",
    });

    monitors = createMonitorService({ db: handle.db });
    const target = await monitors.createTarget({
      targetType: WOO_ORDERS_TARGET_TYPE,
      name: "examplestore orders",
      connectionId,
      intervalSeconds: 900,
      // The page bound lives in the target's own config, so the worker
      // enforces it without this test injecting anything into the sync.
      config: {
        [COMMERCE_SYNC_CONFIG_KEY]: { perPage: PER_PAGE, maxPages: MAX_PAGES },
      },
      nextPollAt: new Date(Date.now() - 1000),
    });
    targetId = target.id;

    const market = createMarketTasks({ db: handle.db });
    await runtime.addJob(market.dispatchDueMonitorsTask, {});
    polled = await waitFor(
      async () => {
        const row = await monitors.getTarget(targetId);
        return row.lastSuccessAt !== null ? row : undefined;
      },
      { timeoutMs: 120_000, label: "live woo_orders poll recorded success" },
    );
  }, 240_000);

  afterAll(async () => {
    if (creds === null) return;
    await runtime?.stop();
    await composition?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("ingested a bounded slice of real orders through the poll path", async () => {
    const orders = await countOf("orders");
    const lines = await countOf("order_lines");
    const links = await countOf("order_source_links");
    const objects = await countOf("provider_objects");
    check("slice is bounded, non-empty, and fully provenanced", () => {
      expect(orders).toBeGreaterThan(0);
      expect(orders).toBeLessThanOrEqual(PER_PAGE * MAX_PAGES);
      expect(lines).toBeGreaterThan(0);
      // One provenance link and one retained payload per order.
      expect(links).toBe(orders);
      expect(objects).toBe(orders);
    });
  });

  it("advanced the cursor and recorded the poll on both target and connection", async () => {
    const state = commerceSyncState(polled);
    const orders = await countOf("orders");
    const connection =
      await composition.services.connections.getConnection(connectionId);
    check("cursor and health state are exactly what a poll should leave", () => {
      // The watermark is an ISO instant, not a payload-derived value.
      expect(ISO_INSTANT.test(String(state["modifiedAfter"]))).toBe(true);
      expect(ISO_INSTANT.test(String(state["lastSyncedAt"]))).toBe(true);
      expect(state["lastOrderCount"]).toBe(orders);
      expect(polled.consecutiveErrors).toBe(0);
      expect(polled.backoffUntil).toBeNull();
      expect(connection.status).toBe("active");
      expect(connection.lastSuccessAt).not.toBeNull();
    });
  });

  it("never schedules the store faster than the politeness floor", () => {
    check("next_poll_at respects the Woo interval floor", () => {
      expect(polled.nextPollAt).not.toBeNull();
      const seconds =
        ((polled.nextPollAt as Date).getTime() -
          (polled.lastSuccessAt as Date).getTime()) /
        1000;
      expect(seconds).toBeGreaterThanOrEqual(WOO_ABSOLUTE_MIN_INTERVAL_SECONDS);
    });
  });

  it("re-polls incrementally and ingests idempotently", async () => {
    const before = await countOf("orders");
    const beforeRow = await monitors.getTarget(targetId);
    await monitors.updateTarget(targetId, {
      nextPollAt: new Date(Date.now() - 1000),
    });
    const market = createMarketTasks({ db: handle.db });
    await runtime.addJob(market.dispatchDueMonitorsTask, {});
    const second = await waitFor(
      async () => {
        const row = await monitors.getTarget(targetId);
        const advanced =
          row.lastSuccessAt !== null &&
          beforeRow.lastSuccessAt !== null &&
          row.lastSuccessAt.getTime() > beforeRow.lastSuccessAt.getTime();
        return advanced ? row : undefined;
      },
      { timeoutMs: 120_000, label: "second live woo_orders poll" },
    );

    const after = await countOf("orders");
    const state = commerceSyncState(second);
    check("a second poll fetched only the cursor's slice and created nothing", () => {
      // Whatever the overlap re-read was ingested idempotently.
      expect(after).toBe(before);
      expect(Number(state["lastOrderCount"])).toBeLessThanOrEqual(
        PER_PAGE * MAX_PAGES,
      );
      expect(second.consecutiveErrors).toBe(0);
    });
  }, 240_000);

  it("keeps buyer personal data out of every domain column", async () => {
    // The retained payload in provider_objects DOES carry PII — that is the
    // designed provenance boundary. The domain columns must not.
    const leaks = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n
         from orders
        where buyer_display_name is not null
           or buyer_external_id like '%@%'`,
    );
    check("no buyer PII in domain columns", () => {
      expect(Number(leaks.rows[0]?.n)).toBe(0);
    });
  });
});
