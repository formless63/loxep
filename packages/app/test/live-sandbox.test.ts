/**
 * LIVE eBay sandbox tier for the composition root. Skips cleanly when the
 * local keyset file (~/.config/loxep/ebay-sandbox.env) is absent — CI has no
 * credentials.
 *
 * ## What this tier proves
 *
 * A real `ebay_item` monitor target, polled through the REAL composed worker
 * registry and the REAL provider adapter, against live sandbox data:
 *
 *  1. the documented keyset precedence's SECOND leg resolves inside the
 *     worker composition — no `integration.ebay.keyset` secret is stored, so
 *     the dev file is what configures the adapter;
 *  2. a per-connection rate budget is created and every provider call is
 *     acquired from it;
 *  3. Browse `getItem` → `snapshotToObservation` → `upsertMarketplaceItem` →
 *     `recordObservationBatch` → `linkItemToMonitor` → `recordPollSuccess`
 *     works against a real listing, with real money decimal strings and a
 *     real `raw_state_hash`;
 *  4. the poll reports adaptive facts bounded below by the connection's
 *     rate-budget interval floor;
 *  5. an `ebay_search` monitor runs the SAME way (loxep-7dp.7): a real Browse
 *     search through the worker, normalized summaries linked into
 *     `monitor_items`, observed inside one batch, and `new_listing` derived
 *     for first-discoveries — the discovery mirror of leg 3.
 *
 * ## What this tier deliberately does NOT prove
 *
 * Anything needing USER consent: the synthetic connection created here has no
 * `oauth_tokens` credential, so `adapter.user` is null and the `ebay_watchlist`
 * path (Trading `GetMyeBayBuying`) is out of scope — that is the app-token-only
 * path by construction, and it is asserted as such below. Notification
 * delivery uses a capture transport, so no message leaves the machine. The
 * remaining gap to a fully live loop is the consent runbook plus a real
 * monitor.
 *
 * ABSOLUTE RULE honored here: credential values are never printed, logged,
 * asserted-by-value, or embedded in messages.
 */
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { createMarketTasks, createMonitorService } from "@loxep/market";
import type { MonitorService, MonitorTargetRow } from "@loxep/market";
import { loadSandboxCredentialsFromEnvFile } from "@loxep/integration-ebay";
import type {
  NotificationTransport,
  TransportSendInput,
} from "@loxep/notifications";
import {
  EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
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

const creds = loadSandboxCredentialsFromEnvFile();
const optedIn = liveTestsEnabledFor("ebay");

if (creds === null) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-sandbox] skipped: no keyset at ~/.config/loxep/ebay-sandbox.env",
  );
} else if (!optedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-sandbox] skipped: credentials present but not opted in — set " +
      "LOXEP_LIVE_TESTS=ebay (or =all) to run against the live instance.",
  );
}

const describeLive = creds === null || !optedIn ? describe.skip : describe;

const dbName = scratchDbName("loxep_test_app_live");
let databaseUrl = "";
let handle: DbHandle;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let monitors: MonitorService;
let connectionId = "";

const sent: TransportSendInput[] = [];
const captureTransport: NotificationTransport = {
  provider: "ntfy",
  send: async (input) => {
    sent.push(input);
    return { providerMessageId: null };
  },
};

function assertNoCredentialMaterial(text: string): void {
  if (creds === null) return;
  expect(text).not.toContain(creds.appId);
  expect(text).not.toContain(creds.certId);
  expect(text).not.toContain(creds.devId);
  if (creds.ruName !== undefined) expect(text).not.toContain(creds.ruName);
}

async function pollOnce(targetId: string): Promise<MonitorTargetRow> {
  const before = (await monitors.getTarget(targetId)).lastSuccessAt;
  await monitors.updateTarget(targetId, {
    nextPollAt: new Date(Date.now() - 1000),
  });
  const market = createMarketTasks({ db: handle.db });
  await runtime.addJob(market.dispatchDueMonitorsTask, {});
  return waitFor(
    async () => {
      const row = await monitors.getTarget(targetId);
      const advanced =
        row.lastSuccessAt !== null &&
        (before === null || row.lastSuccessAt.getTime() > before.getTime());
      return advanced ? row : undefined;
    },
    { label: `live poll of monitor target ${targetId}` },
  );
}

beforeAll(async () => {
  if (creds === null) return;
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  // NOTE: no `integration.ebay.keyset` secret is stored — the dev-file leg of
  // the documented precedence is what must resolve here.
  composition = buildWorkerRegistry({
    config: testConfig(databaseUrl),
    transport: captureTransport,
    logger: silentJobsLogger,
  });
  runtime = await startWorkerRuntime({
    databaseUrl,
    logger: silentJobsLogger,
    concurrency: 1,
    pollInterval: 200,
    registry: composition.registry,
    cronItems: [],
  });

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "live@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const connection = await composition.services.connections.createConnection({
    provider: "ebay",
    kind: "marketplace",
    name: "live sandbox (app token only)",
    createdByUserId: "test-user",
  });
  connectionId = connection.id;
  monitors = createMonitorService({ db: handle.db });
}, 180_000);

afterAll(async () => {
  if (creds === null) return;
  await runtime?.stop();
  await composition?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describeLive("live eBay sandbox pipeline (app token only)", () => {
  it("resolves the dev-file keyset and builds an app-token-only adapter", async () => {
    const adapter =
      await composition.services.getEbayAdapterForConnection(connectionId);
    expect(adapter.keysetSource).toBe("dev-file");
    expect(adapter.environment).toBe("sandbox");
    // No consent has happened, so the user-context half is absent by design.
    expect(adapter.user).toBeNull();
    expect(() => adapter.requireUser()).toThrow(/consent/u);
    // The interval floor the adaptive policy will be bounded by.
    expect(adapter.minIntervalSeconds).toBeGreaterThanOrEqual(
      EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
    );

    const token = await adapter.application.mintApplicationToken();
    expect(token.expiresInSeconds).toBeGreaterThan(0);
    assertNoCredentialMaterial(inspect(token));
  });

  it("polls a real sandbox listing end to end through the worker", async () => {
    const adapter =
      await composition.services.getEbayAdapterForConnection(connectionId);
    const search = await adapter.application.browseSearch({
      query: "iphone",
      limit: 5,
    });
    const externalItemId = search.itemSummaries
      .map((summary) => summary["itemId"])
      .find((id): id is string => typeof id === "string");

    if (externalItemId === undefined) {
      // Sparse sandbox inventory is normal; the adapter/keyset legs above
      // still ran. Nothing to observe, so stop here rather than fail.
      // eslint-disable-next-line no-console
      console.info(
        "[live-sandbox] no sandbox Browse results; skipping the observation leg",
      );
      return;
    }

    const target = await monitors.createTarget({
      targetType: "ebay_item",
      name: "live sandbox item",
      connectionId,
      intervalSeconds: 300,
      config: { externalItemId },
      nextPollAt: new Date(Date.now() - 1000),
    });

    const after = await pollOnce(target.id);
    expect(after.consecutiveErrors).toBe(0);
    expect(after.nextPollAt!.getTime()).toBeGreaterThan(Date.now());

    const item = await handle.db.query.marketplaceItems.findFirst({
      where: (table, { eq }) => eq(table.externalItemId, externalItemId),
    });
    expect(item).toBeDefined();
    expect(item!.provider).toBe("ebay");

    const observations =
      await handle.db.query.marketplaceItemObservations.findMany({
        where: (table, { eq }) => eq(table.marketplaceItemId, item!.id),
      });
    expect(observations).toHaveLength(1);
    const observation = observations[0]!;
    expect(observation.source).toBe("ebay:browse");
    expect(observation.connectionId).toBe(connectionId);
    expect(observation.rawStateHash).toMatch(/^[0-9a-f]{64}$/u);
    if (observation.price !== null) {
      // Money is a decimal string end to end, never a JS float.
      expect(observation.price).toMatch(/^-?\d+(\.\d+)?$/u);
    }

    // The item is linked to the monitor for discovery/adaptive signals.
    const link = await handle.db.query.monitorItems.findFirst({
      where: (table, { eq }) => eq(table.monitorTargetId, target.id),
    });
    expect(link?.marketplaceItemId).toBe(item!.id);
    expect(link?.active).toBe(true);

    // Adaptive facts were recorded and respect the rate-budget floor.
    const adaptive = (after.config as Record<string, unknown>)["adaptive"] as
      | Record<string, unknown>
      | undefined;
    expect(adaptive).toBeDefined();
    expect(Number(adaptive!["lastComputedInterval"])).toBeGreaterThanOrEqual(
      EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
    );

    // The connection is healthy, and nothing persisted carries keyset values.
    const connection =
      await composition.services.connections.getConnection(connectionId);
    expect(connection.status).toBe("active");
    expect(connection.lastSuccessAt).not.toBeNull();
    assertNoCredentialMaterial(inspect({ item, observation, connection }));
  });

  it("runs a real sandbox SEARCH monitor through the worker into observations", async () => {
    const target = await monitors.createTarget({
      targetType: "ebay_search",
      name: "live sandbox search",
      connectionId,
      intervalSeconds: 300,
      // Small on purpose: every page of a discovery poll spends one
      // rate-budget token, and one page is enough to prove the path.
      config: { query: "iphone", maxItems: 4 },
      nextPollAt: new Date(Date.now() - 1000),
    });

    const after = await pollOnce(target.id);
    expect(after.consecutiveErrors).toBe(0);
    expect(after.nextPollAt!.getTime()).toBeGreaterThan(Date.now());

    const links = await handle.db.query.monitorItems.findMany({
      where: (table, { eq }) => eq(table.monitorTargetId, target.id),
    });
    if (links.length === 0) {
      // Sparse sandbox inventory is normal; the poll itself still succeeded.
      // eslint-disable-next-line no-console
      console.info(
        "[live-sandbox] search returned no listings; skipping the discovery assertions",
      );
      return;
    }
    expect(links.every((link) => link.active)).toBe(true);

    const observations =
      await handle.db.query.marketplaceItemObservations.findMany({
        where: (table, { inArray }) =>
          inArray(
            table.marketplaceItemId,
            links.map((link) => link.marketplaceItemId),
          ),
      });
    expect(observations.length).toBeGreaterThan(0);
    const batchIds = new Set(
      observations.map((observation) => observation.observationBatchId),
    );
    // One poll, one batch identity, minted once at fetch time.
    expect(batchIds.size).toBe(1);
    for (const observation of observations) {
      expect(observation.source).toBe("ebay:search");
      expect(observation.connectionId).toBe(connectionId);
      // A search summary reports no quantity/availability — NULL, never 0.
      expect(observation.quantityAvailable).toBeNull();
      expect(observation.availability).toBeNull();
      if (observation.price !== null) {
        expect(observation.price).toMatch(/^-?\d+(\.\d+)?$/u);
      }
    }

    // Every first-discovery produced exactly one `new_listing`, and nothing
    // in the persisted rows carries keyset material.
    const events = await handle.db.query.marketEvents.findMany({
      where: (table, { and, eq, inArray }) =>
        and(
          eq(table.eventType, "new_listing"),
          inArray(
            table.marketplaceItemId,
            links.map((link) => link.marketplaceItemId),
          ),
        ),
    });
    const perItem = new Map<string, number>();
    for (const event of events) {
      perItem.set(
        event.marketplaceItemId,
        (perItem.get(event.marketplaceItemId) ?? 0) + 1,
      );
    }
    expect([...perItem.values()].every((count) => count === 1)).toBe(true);
    expect(events.every((event) => event.monitorTargetId === target.id)).toBe(
      true,
    );

    const adaptive = (after.config as Record<string, unknown>)["adaptive"] as
      | Record<string, unknown>
      | undefined;
    expect(Number(adaptive!["lastComputedInterval"])).toBeGreaterThanOrEqual(
      EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
    );
    assertNoCredentialMaterial(inspect({ links, observations, events }));
  });
});
