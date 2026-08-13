/**
 * `infrastructure_domain_reconcile` poll-executor tests (Phase 7 milestone 1
 * composition-root wiring, loxep-lmy.1) through the REAL Graphile Worker
 * runtime and the REAL composed registry:
 *
 * ```text
 * due infrastructure_domain_reconcile target
 *   -> market.dispatch-due-monitors -> market.poll-target
 *   -> the ROUTED poll executor -> @loxep/app's infrastructure branch
 *   -> @loxep/infrastructure createRecordSyncService(...).run(...)
 *      -> read intent -> read observed -> diff -> record findings
 *   -> recordPollSuccess (next_poll_at advance)
 * ```
 *
 * The ONLY mock is the provider: `services.getCloudflareAdapterForConnection`
 * is replaced with `fakeCloudflareConnectionAdapter`, a stub at the
 * `DnsProviderPort` boundary (`findZoneByName`/`read`/`apply`/`capabilities`,
 * scoped per zone exactly as the real adapter is) — the same "only the
 * touched surface" discipline `commerce-ebay-sync.test.ts` and
 * `etsy-poll-executor.test.ts` use for their own provider seams. Everything
 * else — PostgreSQL, the real `@loxep/infrastructure` reconciler, the real
 * worker, the real `@loxep/market` scheduler — is the real thing.
 *
 * What this file is here to prove:
 *
 * 1. `infrastructure_domain_reconcile` is registered in `@loxep/market`'s
 *    closed target-type list AND routed by the composed registry;
 * 2. the dispatcher claims a due target, the app executor resolves the
 *    managed domain via `reconcile_target_id`, and a real `check`-mode sync
 *    run reads intent, reads the (stubbed) provider, diffs, and PERSISTS
 *    `dns_drift_findings` — all without a single write at the provider;
 * 3. a provider failure records a poll failure with backoff AND puts the
 *    connection into its error state, exactly the `ebay_orders`/`woo_orders`
 *    contract;
 * 4. an `auth` failure additionally invalidates the cached Cloudflare
 *    adapter, so a rotated token recovers on the next poll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { MONITOR_TARGET_TYPES, createMarketTasks, createMonitorService } from "@loxep/market";
import type { MonitorService, MonitorTargetRow } from "@loxep/market";
import {
  INFRASTRUCTURE_DOMAIN_RECONCILE_TARGET_TYPE,
  createManagedDomainsService,
} from "@loxep/infrastructure";
import type { ManagedDomainsService } from "@loxep/infrastructure";
import { buildAppServices, buildWorkerRegistry } from "../src/index.ts";
import type { AppServices, WorkerComposition } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  fakeCloudflareConnectionAdapter,
  fakeCloudflareRecord,
  fakeCloudflareState,
  fakeCloudflareZone,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";
import type { FakeCloudflareState, FakeCloudflareZone } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_infra_reconcile");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let monitors: MonitorService;
let domains: ManagedDomainsService;
let connectionId = "";
let failingConnectionId = "";

/** One fake Cloudflare "account" per connection; each may hold several zones. */
const states = new Map<string, FakeCloudflareState>();
const invalidated: string[] = [];

function stateFor(connection: string): FakeCloudflareState {
  let state = states.get(connection);
  if (state === undefined) {
    state = fakeCloudflareState();
    states.set(connection, state);
  }
  return state;
}

async function dispatch(): Promise<void> {
  const market = createMarketTasks({ db: handle.db });
  await runtime.addJob(market.dispatchDueMonitorsTask, {});
}

/**
 * Force a claim on the next dispatch. Clears `backoff_until` as well as
 * `next_poll_at` — a target polled once past a failure carries a real
 * exponential backoff (with `intervalSeconds = 3600` here, a single failure
 * already pushes `backoff_until` hours out), so re-arming only `next_poll_at`
 * would leave the dispatcher's `backoff_until is null or <= now` guard
 * blocking every subsequent poll in a chained failure-path scenario. Mirrors
 * `commerce-ebay-sync.test.ts`'s `makeDue`.
 */
async function makeDue(targetId: string): Promise<void> {
  await handle.pool.query(
    `update monitor_targets
        set next_poll_at = now() - interval '1 second', backoff_until = null
      where id = $1`,
    [targetId],
  );
}

async function pollOnce(targetId: string): Promise<MonitorTargetRow> {
  const before = (await monitors.getTarget(targetId)).lastSuccessAt;
  await makeDue(targetId);
  await dispatch();
  return waitFor(
    async () => {
      const row = await monitors.getTarget(targetId);
      const advanced =
        row.lastSuccessAt !== null &&
        (before === null || row.lastSuccessAt.getTime() > before.getTime());
      return advanced ? row : undefined;
    },
    { timeoutMs: 30_000, label: `poll of infrastructure_domain_reconcile target ${targetId}` },
  );
}

async function pollOnceExpectingFailure(targetId: string): Promise<MonitorTargetRow> {
  const before = (await monitors.getTarget(targetId)).consecutiveErrors;
  await makeDue(targetId);
  await dispatch();
  return waitFor(
    async () => {
      const row = await monitors.getTarget(targetId);
      return row.consecutiveErrors > before ? row : undefined;
    },
    { timeoutMs: 30_000, label: `poll failure of infrastructure_domain_reconcile target ${targetId}` },
  );
}

/**
 * Create a managed domain past `zone_created` (an `external_zone_id` and
 * `state = 'zone_active'`), so record sync has a zone to talk to — the exact
 * shape `packages/infrastructure/test/sync.test.ts`'s `freshDomain` sets up.
 * The zone id is derived from the DOMAIN, not the connection, because one
 * connection fronts several domains/zones in these tests.
 */
async function freshDomain(
  dnsConnectionId: string,
  name: string,
): Promise<{ id: string; externalZoneId: string }> {
  const row = await domains.create({ name, dnsConnectionId });
  const externalZoneId = `zone-${row.id}`;
  await handle.pool.query(
    `update managed_domains
        set external_zone_id = $2, state = 'zone_active', provider_zone_status = 'active'
      where id = $1`,
    [row.id, externalZoneId],
  );
  return { id: row.id, externalZoneId };
}

/**
 * Register the recurring target and point the domain back at it —
 * `managed_domains.reconcile_target_id`, the FK the design chose over a
 * `domainId` inside `monitor_targets.config` (see `monitors.ts`'s module
 * doc). `createManagedDomainsService.create()` deliberately accepts no such
 * field (state and this FK are reconciler/scheduler concerns), so the link
 * is written directly, exactly like `sync.test.ts` sets `external_zone_id`
 * directly.
 */
async function registerReconcileTarget(input: {
  connectionId: string;
  domainId: string;
  name: string;
}): Promise<MonitorTargetRow> {
  const target = await monitors.createTarget({
    targetType: INFRASTRUCTURE_DOMAIN_RECONCILE_TARGET_TYPE,
    name: input.name,
    intervalSeconds: 3600,
    connectionId: input.connectionId,
    // The market-activity adaptive policy MUST be opted out on these rows —
    // the design's own rule, see monitors.ts's module doc.
    config: { adaptive: { enabled: false } },
  });
  await handle.pool.query(
    `update managed_domains set reconcile_target_id = $2 where id = $1`,
    [input.domainId, target.id],
  );
  return target;
}

async function findingsFor(domainId: string): Promise<
  Array<{ kind: string; resolution: string | null }>
> {
  const rows = await handle.pool.query<{ kind: string; resolution: string | null }>(
    `select kind, resolution from dns_drift_findings where domain_id = $1 order by kind`,
    [domainId],
  );
  return rows.rows;
}

async function reconcileRunsFor(domainId: string): Promise<
  Array<{ mode: string; trigger: string; status: string }>
> {
  const rows = await handle.pool.query<{ mode: string; trigger: string; status: string }>(
    `select mode, trigger, status from reconcile_runs where subject_id = $1 order by started_at`,
    [domainId],
  );
  return rows.rows;
}

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  const real = buildAppServices({ config, logger: silentJobsLogger });
  // The one mock, at the provider boundary: the Cloudflare connection
  // adapter. `invalidateCloudflareAdapter` is captured rather than stubbed
  // away, because the auth-failure contract asserts it.
  services = {
    ...real,
    getCloudflareAdapterForConnection: async (id) =>
      fakeCloudflareConnectionAdapter(id, stateFor(id), { minIntervalSeconds: 3600 }),
    invalidateCloudflareAdapter: (id) => {
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
    email: "infra-reconcile@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const connection = await services.connections.createConnection({
    provider: "cloudflare",
    kind: "dns",
    name: "test Cloudflare account",
    config: { cloudflare: { accountId: "acct_test" } },
    createdByUserId: "test-user",
  });
  connectionId = connection.id;

  const failing = await services.connections.createConnection({
    provider: "cloudflare",
    kind: "dns",
    name: "broken Cloudflare account",
    config: { cloudflare: { accountId: "acct_broken" } },
    createdByUserId: "test-user",
  });
  failingConnectionId = failing.id;

  monitors = createMonitorService({ db: handle.db });
  domains = createManagedDomainsService({ db: handle.db });
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("'infrastructure_domain_reconcile' registration state", () => {
  it("is registered in @loxep/market's target-type union", () => {
    expect(MONITOR_TARGET_TYPES).toContain(INFRASTRUCTURE_DOMAIN_RECONCILE_TARGET_TYPE);
  });

  it("createMonitorService CRUD accepts it (no ebay_orders-style registration gap)", async () => {
    const domain = await freshDomain(connectionId, "registration-check.test");
    const target = await registerReconcileTarget({
      connectionId,
      domainId: domain.id,
      name: "registration check",
    });
    const read = await monitors.getTarget(target.id);
    expect(read.targetType).toBe(INFRASTRUCTURE_DOMAIN_RECONCILE_TARGET_TYPE);
  });
});

describe("infrastructure_domain_reconcile poll executor", () => {
  it("claims the due target, runs a drift-mode sync, and persists findings", async () => {
    const zoneName = "reconcile-a.test";
    const domain = await freshDomain(connectionId, zoneName);
    // Intent: one desired A record. The stubbed provider has NOTHING for
    // this zone, so the diff must find it `missing`.
    await domains.addManualRecord(domain.id, {
      type: "A",
      name: "@",
      content: "203.0.113.10",
    });
    const zone = fakeCloudflareZone(stateFor(connectionId), {
      zoneName,
      externalZoneId: domain.externalZoneId,
    });
    const target = await registerReconcileTarget({
      connectionId,
      domainId: domain.id,
      name: `reconcile ${zoneName}`,
    });

    const polled = await pollOnce(target.id);
    expect(polled.consecutiveErrors).toBe(0);
    expect(polled.backoffUntil).toBeNull();

    const findings = await findingsFor(domain.id);
    expect(findings).toEqual([{ kind: "missing", resolution: null }]);

    const runs = await reconcileRunsFor(domain.id);
    expect(runs).toHaveLength(1);
    // The recurring cadence is drift-mode ('check') by design — an apply run
    // is an operator action, never something the scheduler decides.
    expect(runs[0]).toEqual({ mode: "check", trigger: "poll", status: "succeeded" });

    // Never converged: 'check' mode changed nothing at the provider.
    expect(zone.applyCalls).toHaveLength(0);
    expect(zone.records.size).toBe(0);

    const connection = await services.connections.getConnection(connectionId);
    expect(connection.lastErrorCode).toBeNull();
  });

  it("is idempotent across polls: a re-run with no intent change upserts the same finding", async () => {
    const zoneName = "reconcile-b.test";
    const domain = await freshDomain(connectionId, zoneName);
    await domains.addManualRecord(domain.id, {
      type: "A",
      name: "@",
      content: "203.0.113.20",
    });
    fakeCloudflareZone(stateFor(connectionId), {
      zoneName,
      externalZoneId: domain.externalZoneId,
    });
    const target = await registerReconcileTarget({
      connectionId,
      domainId: domain.id,
      name: `reconcile ${zoneName}`,
    });

    await pollOnce(target.id);
    await pollOnce(target.id);

    const runs = await reconcileRunsFor(domain.id);
    expect(runs).toHaveLength(2);

    // Upserted against the unresolved partial unique, not accumulated.
    const rows = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count from dns_drift_findings
        where domain_id = $1 and resolved_at is null`,
      [domain.id],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("finds no drift and records zero unresolved findings when intent matches observed state", async () => {
    const zoneName = "reconcile-c.test";
    const domain = await freshDomain(connectionId, zoneName);
    await domains.addManualRecord(domain.id, {
      type: "A",
      name: "@",
      content: "203.0.113.30",
    });
    // The provider already has exactly what intent describes.
    fakeCloudflareZone(stateFor(connectionId), {
      zoneName,
      externalZoneId: domain.externalZoneId,
      records: [
        fakeCloudflareRecord({ externalRecordId: "already-there", content: "203.0.113.30" }),
      ],
    });
    const target = await registerReconcileTarget({
      connectionId,
      domainId: domain.id,
      name: `reconcile ${zoneName}`,
    });

    await pollOnce(target.id);
    expect(await findingsFor(domain.id)).toEqual([]);
  });
});

describe("infrastructure_domain_reconcile failure path", () => {
  let failingTargetId = "";
  let failingDomainId = "";
  let failingZone: FakeCloudflareZone;

  it("records a poll failure with backoff and a connection error", async () => {
    const zoneName = "reconcile-broken.test";
    const domain = await freshDomain(failingConnectionId, zoneName);
    failingDomainId = domain.id;
    const target = await registerReconcileTarget({
      connectionId: failingConnectionId,
      domainId: domain.id,
      name: `reconcile ${zoneName}`,
    });
    failingTargetId = target.id;

    failingZone = fakeCloudflareZone(stateFor(failingConnectionId), {
      zoneName,
      externalZoneId: domain.externalZoneId,
    });
    failingZone.failReadWith = { kind: "provider_unavailable", message: "Cloudflare is down" };

    const row = await pollOnceExpectingFailure(failingTargetId);
    expect(row.consecutiveErrors).toBeGreaterThan(0);
    expect(row.backoffUntil).not.toBeNull();

    const connection = await services.connections.getConnection(failingConnectionId);
    expect(connection.lastErrorCode).toBe("cloudflare_provider_unavailable");
  });

  it("an auth failure additionally drops the cached adapter", async () => {
    invalidated.length = 0;
    failingZone.failReadWith = { kind: "auth", message: "token revoked" };
    await pollOnceExpectingFailure(failingTargetId);
    expect(invalidated).toContain(failingConnectionId);

    const connection = await services.connections.getConnection(failingConnectionId);
    expect(connection.lastErrorCode).toBe("cloudflare_auth");
  });

  it("recovers once the provider answers again", async () => {
    failingZone.failReadWith = null;
    await pollOnce(failingTargetId);

    const row = await monitors.getTarget(failingTargetId);
    expect(row.consecutiveErrors).toBe(0);
    expect(row.backoffUntil).toBeNull();
    // No drift and no intent — a clean, empty sweep.
    expect(await findingsFor(failingDomainId)).toEqual([]);
  });
});
