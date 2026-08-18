/**
 * `infrastructure.materialize-records` / `infrastructure.sync-records` —
 * loxep-vdt's two newly-registered handlers, through the REAL Graphile
 * Worker runtime and the REAL composed registry:
 *
 * ```text
 * ManagedDomainsService.create(...)            ← an operator creating a domain
 *   -> transactional enqueue infrastructure.materialize-records
 *   -> the composed registry's handler
 *      -> materializeDesiredRecords(intent) -> applyMaterializedRecords
 *      -> (zone permitting) chains infrastructure.sync-records, same tx
 *   -> the composed registry's OTHER handler
 *      -> @loxep/infrastructure createRecordSyncService(...).run({apply})
 *         -> write-policy gate -> diff -> apply -> findings
 * ```
 *
 * The ONLY mock is the provider, at the `DnsProviderPort` boundary
 * (`fakeCloudflareConnectionAdapter`) — the same discipline
 * `infrastructure-poll-executor.test.ts` uses. PostgreSQL, the real
 * reconciler, the real settings service, and the real worker are the real
 * things.
 *
 * What this file is here to prove:
 *
 * 1. creating a managed domain now actually materializes its DNS records —
 *    the headline symptom of loxep-vdt, where the enqueued name had no
 *    handler at all and the job died after 25 attempts;
 * 2. both handlers are IDEMPOTENT: a second materialize over unchanged
 *    intent writes no new row and deletes nothing, and a second sync against
 *    an already-converged zone applies nothing;
 * 3. the chained apply is genuinely gated — `read_only` (the default) is
 *    refused as a `'blocked'` step with the run finishing `'partial'`, and
 *    raising the connection's tier is what makes DNS apply reachable;
 * 4. a domain with no provider zone is skipped honestly instead of burning a
 *    retry budget against a condition no retry can fix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { providerWritePolicySetting } from "@loxep/domain";
import {
  createHostingTargetsService,
  createManagedDomainsService,
  createTransactionalEnqueue,
} from "@loxep/infrastructure";
import type {
  HostingTargetsService,
  ManagedDomainsService,
} from "@loxep/infrastructure";
import {
  buildAppServices,
  buildWorkerRegistry,
  createInfrastructureDomainTasks,
  materializeDomainRecords,
} from "../src/index.ts";
import type {
  AppServices,
  InfrastructureDomainTasks,
  WorkerComposition,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  fakeCloudflareConnectionAdapter,
  fakeCloudflareState,
  fakeCloudflareZone,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";
import type { FakeCloudflareState, FakeCloudflareZone } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_infra_domains");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
/** Enqueues for real: `create`/`updateIntent` put a job in the queue. */
let domains: ManagedDomainsService;
/**
 * The SAME service with the enqueue seam left at its no-op default. Used by
 * every case that drives `materializeDomainRecords` directly, so the running
 * worker is not racing the test for the same `dns_records` rows — the
 * enqueueing service above is what the end-to-end cases use, and is the only
 * thing that needs the worker involved.
 */
let quietDomains: ManagedDomainsService;
let targets: HostingTargetsService;
let domainTasks: InfrastructureDomainTasks;
let connectionId = "";
let apexTargetId = "";

const states = new Map<string, FakeCloudflareState>();

function stateFor(connection: string): FakeCloudflareState {
  let state = states.get(connection);
  if (state === undefined) {
    state = fakeCloudflareState();
    states.set(connection, state);
  }
  return state;
}

interface RecordRow {
  type: string;
  name: string;
  content: string;
  owner: string;
  proxied: boolean;
  desired_deleted_at: Date | null;
}

async function recordsFor(domainId: string): Promise<RecordRow[]> {
  const rows = await handle.pool.query<RecordRow>(
    `select type, name, content, owner, proxied, desired_deleted_at
       from dns_records where domain_id = $1
      order by owner, type, name`,
    [domainId],
  );
  return rows.rows;
}

async function liveRecordsFor(domainId: string): Promise<RecordRow[]> {
  return (await recordsFor(domainId)).filter(
    (row) => row.desired_deleted_at === null,
  );
}

async function runsFor(
  domainId: string,
): Promise<Array<{ mode: string; trigger: string; status: string; id: string }>> {
  const rows = await handle.pool.query<{
    id: string;
    mode: string;
    trigger: string;
    status: string;
  }>(
    `select id, mode, trigger, status from reconcile_runs
      where subject_type = 'domain' and subject_id = $1 order by started_at`,
    [domainId],
  );
  return rows.rows;
}

async function stepsFor(runId: string): Promise<Array<{ step: string; status: string }>> {
  const rows = await handle.pool.query<{ step: string; status: string }>(
    `select step, status from reconcile_run_steps where run_id = $1 order by sequence`,
    [runId],
  );
  return rows.rows;
}

/** A domain past `zone_created`, the shape record sync requires. */
async function giveZone(domainId: string): Promise<string> {
  const externalZoneId = `zone-${domainId}`;
  await handle.pool.query(
    `update managed_domains
        set external_zone_id = $2, state = 'zone_active', provider_zone_status = 'active'
      where id = $1`,
    [domainId, externalZoneId],
  );
  return externalZoneId;
}

/** The newest run for a domain, once one more than `before` exists. */
async function waitForRun(
  domainId: string,
  before: number,
  label: string,
): Promise<{ id: string; mode: string; trigger: string; status: string }> {
  return waitFor(
    async () => {
      const runs = await runsFor(domainId);
      if (runs.length <= before) return undefined;
      const latest = runs[runs.length - 1];
      // `running` means the handler is mid-flight; wait for a terminal one.
      return latest !== undefined && latest.status !== "running" ? latest : undefined;
    },
    { timeoutMs: 30_000, label },
  );
}

async function setWritePolicy(tier: string): Promise<void> {
  await services.settings.set(
    providerWritePolicySetting,
    { [connectionId]: tier } as Record<string, never>,
    { actorUserId: "test-user" },
  );
}

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  const real = buildAppServices({ config, logger: silentJobsLogger });
  services = {
    ...real,
    getCloudflareAdapterForConnection: async (id) =>
      fakeCloudflareConnectionAdapter(id, stateFor(id), { minIntervalSeconds: 3600 }),
    invalidateCloudflareAdapter: () => undefined,
  };

  composition = buildWorkerRegistry({ config, services, logger: silentJobsLogger });
  domainTasks = createInfrastructureDomainTasks({ services });

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
    email: "infra-domains@example.invalid",
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

  targets = createHostingTargetsService({ db: handle.db });
  const apex = await targets.create({
    name: "edge-1",
    controlSurface: "proxy_node",
    addressV4: "203.0.113.10",
    createdByUserId: "test-user",
  });
  apexTargetId = apex.id;

  // The REAL transactional enqueue, so `create`/`updateIntent` put a genuine
  // `infrastructure.materialize-records` job in the queue the running worker
  // then claims — the exact path that was dead before loxep-vdt.
  domains = createManagedDomainsService({
    db: handle.db,
    enqueue: createTransactionalEnqueue(),
  });
  quietDomains = createManagedDomainsService({ db: handle.db });
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("infrastructure.materialize-records", () => {
  it("materializes a created domain's records through the real worker", async () => {
    const domain = await domains.create({
      name: "materialize-a.test",
      dnsConnectionId: connectionId,
      apexTargetId,
      createdByUserId: "test-user",
    });

    const records = await waitFor(
      async () => {
        const rows = await liveRecordsFor(domain.id);
        return rows.length > 0 ? rows : undefined;
      },
      { timeoutMs: 30_000, label: "materialized dns_records for materialize-a.test" },
    );

    expect(
      records.map((row) => `${row.owner} ${row.type} ${row.name} ${row.content}`),
    ).toEqual(["apex A @ 203.0.113.10", "wildcard A * 203.0.113.10"]);
    // No CAA: `infrastructure.caa_policy` ships unreviewed, and the
    // materializer refuses to emit one until an owner reviews it.
    expect(records.some((row) => row.owner === "caa")).toBe(false);

    // The domain has no provider zone yet (only the template engine ever sets
    // one), so no sync was chained — and, crucially, no job was left to burn
    // a retry budget against a run that cannot start.
    expect(await runsFor(domain.id)).toEqual([]);
  });

  it("is idempotent: a second run over unchanged intent writes nothing new", async () => {
    const domain = await quietDomains.create({
      name: "materialize-b.test",
      dnsConnectionId: connectionId,
      apexTargetId,
      createdByUserId: "test-user",
    });

    const first = await materializeDomainRecords(services, domain.id);
    expect(first.created).toBe(2);
    expect(first.softDeleted).toBe(0);
    const afterFirst = await liveRecordsFor(domain.id);

    const second = await materializeDomainRecords(services, domain.id);
    // The whole idempotency contract in three numbers: nothing created,
    // nothing removed, the same rows converged onto themselves.
    expect(second.created).toBe(0);
    expect(second.softDeleted).toBe(0);
    expect(second.updated).toBe(2);
    expect(await liveRecordsFor(domain.id)).toEqual(afterFirst);
    expect(second.syncEnqueued).toBe(false);
    expect(second.syncSkippedReason).toBe("no_provider_zone");
  });

  it("converges: intent that no longer describes a record soft-deletes it", async () => {
    const domain = await quietDomains.create({
      name: "materialize-c.test",
      dnsConnectionId: connectionId,
      apexTargetId,
      createdByUserId: "test-user",
    });
    await materializeDomainRecords(services, domain.id);
    expect(await liveRecordsFor(domain.id)).toHaveLength(2);

    await quietDomains.updateIntent(domain.id, { apexTargetId: null });
    const dropped = await materializeDomainRecords(services, domain.id);
    expect(dropped.softDeleted).toBe(2);
    expect(await liveRecordsFor(domain.id)).toEqual([]);
    // Soft-deleted, not gone: the tombstone is what tells the reconciler to
    // REMOVE the record at the provider.
    expect(await recordsFor(domain.id)).toHaveLength(2);
  });

  it("never rewrites a manual record", async () => {
    const domain = await quietDomains.create({
      name: "materialize-d.test",
      dnsConnectionId: connectionId,
      apexTargetId,
      createdByUserId: "test-user",
    });
    // A human authored exactly what the materializer would have emitted.
    await quietDomains.addManualRecord(domain.id, {
      type: "A",
      name: "@",
      content: "203.0.113.10",
    });

    await materializeDomainRecords(services, domain.id);
    const apex = (await liveRecordsFor(domain.id)).filter(
      (row) => row.type === "A" && row.name === "@",
    );
    expect(apex).toHaveLength(1);
    expect(apex[0]?.owner).toBe("manual");
  });
});

describe("infrastructure.sync-records", () => {
  let domainId = "";
  let zone: FakeCloudflareZone;

  it("chains from materialize and is REFUSED while the connection is read_only", async () => {
    const domain = await quietDomains.create({
      name: "sync-a.test",
      dnsConnectionId: connectionId,
      apexTargetId,
      createdByUserId: "test-user",
    });
    domainId = domain.id;
    const externalZoneId = await giveZone(domain.id);
    zone = fakeCloudflareZone(stateFor(connectionId), {
      zoneName: "sync-a.test",
      externalZoneId,
    });

    const outcome = await materializeDomainRecords(services, domain.id);
    expect(outcome.syncEnqueued).toBe(true);

    const run = await waitForRun(domain.id, 0, "chained sync run for sync-a.test");
    // An apply the operator has not authorized: never a silent skip, never a
    // failure — a 'blocked' step and a 'partial' run.
    expect({ mode: run.mode, trigger: run.trigger, status: run.status }).toEqual({
      mode: "apply",
      trigger: "intent_change",
      status: "partial",
    });
    const steps = await stepsFor(run.id);
    expect(steps).toContainEqual({ step: "apply.blocked", status: "blocked" });
    expect(zone.applyCalls).toHaveLength(0);
    expect(zone.records.size).toBe(0);
  });

  it("publishes once an admin raises the connection's write policy", async () => {
    await setWritePolicy("additive");
    const before = (await runsFor(domainId)).length;

    await materializeDomainRecords(services, domainId);
    const run = await waitForRun(domainId, before, "authorized sync run for sync-a.test");
    expect(run.status).toBe("succeeded");

    expect(
      [...zone.records.values()]
        .map((record) => `${record.type} ${record.name} ${record.content}`)
        .sort(),
    ).toEqual(["A * 203.0.113.10", "A @ 203.0.113.10"]);
  });

  it("is idempotent: a second sync against a converged zone applies nothing", async () => {
    const before = (await runsFor(domainId)).length;
    const applyCallsBefore = zone.applyCalls.length;

    await materializeDomainRecords(services, domainId);
    const run = await waitForRun(domainId, before, "second sync run for sync-a.test");
    expect(run.status).toBe("succeeded");

    // Nothing differed, so the operation builder produced nothing and the
    // provider was never called to write — `apply.none`, not a repeated
    // create. A second reconcile_runs row IS expected: two runs happened.
    expect(await stepsFor(run.id)).toContainEqual({
      step: "apply.none",
      status: "skipped",
    });
    expect(zone.applyCalls).toHaveLength(applyCallsBefore);
    expect(zone.records.size).toBe(2);
  });

  it("skips a domain with no provider zone instead of burning its retry budget", async () => {
    const domain = await quietDomains.create({
      name: "sync-zoneless.test",
      dnsConnectionId: connectionId,
      apexTargetId,
      createdByUserId: "test-user",
    });

    const jobKey = `infrastructure.sync-records:domain:${domain.id}`;
    await runtime.addJob(
      domainTasks.syncRecordsTask,
      { domainId: domain.id, mode: "check", trigger: "manual" },
      { jobKey },
    );

    // The job LEAVES the queue (it succeeded) rather than sitting there
    // accumulating attempts, and it records no run — `run()` would have
    // thrown before inserting one, so 25 retries would have produced nothing
    // an operator could read. Scoped by THIS domain's job key so an
    // unrelated in-flight sync cannot make the assertion pass or fail.
    await waitFor(
      async () => {
        const rows = await handle.pool.query<{ count: string }>(
          `select count(*)::text as count from graphile_worker.jobs where key = $1`,
          [jobKey],
        );
        return rows.rows[0]?.count === "0" ? true : undefined;
      },
      { timeoutMs: 30_000, label: "zoneless sync-records job to drain" },
    );
    expect(await runsFor(domain.id)).toEqual([]);
  });
});
