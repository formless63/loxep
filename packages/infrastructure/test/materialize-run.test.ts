/**
 * `runMaterializeRecords` (loxep-ejs) — the observability half loxep-vdt
 * deliberately left out: `infrastructure.materialize-records` now owns its
 * own `reconcile_runs`/`reconcile_run_steps` machinery, exactly as
 * `sync.ts`, `mail-sync.ts`, and `container-hosts.ts` already do for their
 * own verbs.
 *
 * What this file proves:
 *
 * 1. a successful materialize writes a completed run + steps, and reports
 *    honestly when there is no zone to chain a sync against;
 * 2. the chained `sync-records` enqueue happens, in the same transaction as
 *    the record write, when the domain HAS a zone;
 * 3. a `MaterializationError` writes a FAILED run whose `materialize` step
 *    names the exact reason, and leaves `dns_records` completely untouched —
 *    no half-written set;
 * 4. re-running is idempotent: the SECOND run over unchanged intent updates
 *    the same rows rather than duplicating them, and only the run row (which
 *    should exist twice — two runs really did happen) differs;
 * 5. a domain with a mail registration and no injected mail-provider
 *    resolver fails LOUDLY (a failed run naming the gap) rather than
 *    silently materializing with the mail records missing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { makeWorkerUtils } from "graphile-worker";
import {
  MaterializationError,
  SYNC_RECORDS_TASK,
  createHostingTargetsService,
  createManagedDomainsService,
  createTransactionalEnqueue,
  domainJobKey,
  runMaterializeRecords,
} from "../src/index.ts";
import type {
  HostingTargetsService,
  ManagedDomainsService,
} from "../src/index.ts";
import {
  createScratchDb,
  createStubProvider,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";
import type { StubProvider } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_materialize_run");
let handle: DbHandle;
let databaseUrl = "";
let connectionId = "";
let targets: HostingTargetsService;
let domains: ManagedDomainsService;
let dnsProvider: StubProvider;

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  // Installs `graphile_worker.jobs` so `createTransactionalEnqueue()` has a
  // real table to insert into for the chained-sync test.
  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.release();

  const connection = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('cloudflare', 'dns', 'Cloudflare (test)', 'active', '{"accountId":"acct_test"}')
     returning id`,
  );
  connectionId = connection.rows[0]?.id ?? "";

  targets = createHostingTargetsService({ db: handle.db });
  domains = createManagedDomainsService({ db: handle.db });
  dnsProvider = createStubProvider({
    zoneName: "stub.test",
    externalZoneId: "zone-stub",
  });
}, 120_000);

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;
function nextName(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}.test`;
}

interface RecordRow {
  type: string;
  name: string;
  content: string;
  owner: string;
  desired_deleted_at: Date | null;
}

async function recordsFor(domainId: string): Promise<RecordRow[]> {
  const rows = await handle.pool.query<RecordRow>(
    `select type, name, content, owner, desired_deleted_at
       from dns_records where domain_id = $1
      order by owner, type, name`,
    [domainId],
  );
  return rows.rows;
}

async function liveRecordsFor(domainId: string): Promise<RecordRow[]> {
  return (await recordsFor(domainId)).filter((row) => row.desired_deleted_at === null);
}

interface RunRow {
  id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  mode: string;
  trigger: string;
  status: string;
  error_summary: string | null;
}

async function runsFor(domainId: string): Promise<RunRow[]> {
  const rows = await handle.pool.query<RunRow>(
    `select id, kind, subject_type, subject_id, mode, trigger, status, error_summary
       from reconcile_runs where subject_type = 'domain' and subject_id = $1
      order by started_at`,
    [domainId],
  );
  return rows.rows;
}

interface StepRow {
  step: string;
  status: string;
  error_code: string | null;
  error_detail: string | null;
}

async function stepsFor(runId: string): Promise<StepRow[]> {
  const rows = await handle.pool.query<StepRow>(
    `select step, status, error_code, error_detail
       from reconcile_run_steps where run_id = $1
      order by sequence`,
    [runId],
  );
  return rows.rows;
}

describe("runMaterializeRecords", () => {
  it("writes a completed run and honestly skips the chained sync with no zone", async () => {
    const target = await targets.create({
      name: nextName("edge"),
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.20",
    });
    const domain = await domains.create({
      name: nextName("materialize-ok"),
      dnsConnectionId: connectionId,
      apexTargetId: target.id,
    });

    const outcome = await runMaterializeRecords(domain.id, { db: handle.db, dnsProvider });

    expect(outcome.created).toBe(2);
    expect(outcome.updated).toBe(0);
    expect(outcome.softDeleted).toBe(0);
    expect(outcome.syncEnqueued).toBe(false);
    expect(outcome.syncSkippedReason).toBe("no_provider_zone");
    expect(await liveRecordsFor(domain.id)).toHaveLength(2);

    const runs = await runsFor(domain.id);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run).toBeDefined();
    expect(run?.id).toBe(outcome.runId);
    expect({ kind: run?.kind, mode: run?.mode, trigger: run?.trigger, status: run?.status }).toEqual(
      {
        kind: "materialize-records",
        mode: "apply",
        trigger: "intent_change",
        status: "succeeded",
      },
    );

    const steps = await stepsFor(run?.id ?? "");
    expect(steps.map((step) => step.step)).toEqual([
      "read-intent",
      "materialize",
      "apply-records",
      "enqueue-sync",
    ]);
    expect(steps.every((step) => step.step !== "enqueue-sync" || step.status === "skipped")).toBe(
      true,
    );
    const enqueueStep = steps.find((step) => step.step === "enqueue-sync");
    expect(enqueueStep?.error_code).toBe("no_provider_zone");
  });

  it("chains sync-records in the same transaction when the domain has a zone", async () => {
    const target = await targets.create({
      name: nextName("edge"),
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.21",
    });
    const domain = await domains.create({
      name: nextName("materialize-zoned"),
      dnsConnectionId: connectionId,
      apexTargetId: target.id,
    });
    await handle.pool.query(
      `update managed_domains set external_zone_id = $2 where id = $1`,
      [domain.id, `zone-${domain.id}`],
    );

    const outcome = await runMaterializeRecords(domain.id, {
      db: handle.db,
      dnsProvider,
      enqueue: createTransactionalEnqueue(),
    });

    expect(outcome.syncEnqueued).toBe(true);
    expect(outcome.syncSkippedReason).toBeNull();

    const jobKey = domainJobKey(SYNC_RECORDS_TASK, domain.id);
    const jobs = await handle.pool.query<{ key: string }>(
      `select key from graphile_worker.jobs where key = $1`,
      [jobKey],
    );
    expect(jobs.rows).toHaveLength(1);

    const run = (await runsFor(domain.id))[0];
    const steps = await stepsFor(run?.id ?? "");
    expect(steps).toContainEqual({
      step: "enqueue-sync",
      status: "succeeded",
      error_code: null,
      error_detail: null,
    });
  });

  it("fails the run, names the reason, and leaves no half-written record set", async () => {
    // A hand-typed CGNAT address in a `wan`/`operator_declared` row: the
    // publish-guard `resolveHostingAddress` enforces as defense in depth
    // (`materialize.ts`'s own doc, "the one case the builder cannot catch").
    const tailnetTarget = await targets.create({
      name: nextName("tailnet-leak"),
      controlSurface: "direct_reverse_proxy",
      addressV4: "100.64.0.5",
    });
    const domain = await domains.create({
      name: nextName("materialize-broken"),
      dnsConnectionId: connectionId,
      apexTargetId: tailnetTarget.id,
    });

    await expect(
      runMaterializeRecords(domain.id, { db: handle.db, dnsProvider }),
    ).rejects.toBeInstanceOf(MaterializationError);

    // No half-written set: the pure decision threw before any dns_records
    // write was ever attempted.
    expect(await recordsFor(domain.id)).toEqual([]);

    const runs = await runsFor(domain.id);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.status).toBe("failed");
    expect(run?.error_summary).toMatch(/tailscale/i);

    const steps = await stepsFor(run?.id ?? "");
    expect(steps.map((step) => step.step)).toEqual(["read-intent", "materialize"]);
    const materializeStep = steps.find((step) => step.step === "materialize");
    expect(materializeStep?.status).toBe("failed");
    expect(materializeStep?.error_code).toBe("materialization_error");
    expect(materializeStep?.error_detail).toMatch(/tailscale/i);
  });

  it("is idempotent: a second run over unchanged intent updates rather than duplicates, and only the run row repeats", async () => {
    const target = await targets.create({
      name: nextName("edge"),
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.22",
    });
    const domain = await domains.create({
      name: nextName("materialize-rerun"),
      dnsConnectionId: connectionId,
      apexTargetId: target.id,
    });

    const first = await runMaterializeRecords(domain.id, { db: handle.db, dnsProvider });
    expect(first.created).toBe(2);
    const afterFirst = await liveRecordsFor(domain.id);

    const second = await runMaterializeRecords(domain.id, { db: handle.db, dnsProvider });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(2);
    expect(second.softDeleted).toBe(0);
    expect(await liveRecordsFor(domain.id)).toEqual(afterFirst);

    // Two runs really did happen — both recorded, both succeeded.
    const runs = await runsFor(domain.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    expect(runs[0]?.id).not.toBe(runs[1]?.id);
  });

  it("fails loudly rather than silently dropping mail records when no mail-provider resolver is supplied", async () => {
    const domain = await domains.create({
      name: nextName("materialize-mail-gap"),
      dnsConnectionId: connectionId,
      mailEnabled: true,
    });
    await handle.pool.query(
      `insert into mail_domains (domain_id, mail_connection_id) values ($1, $2)`,
      [domain.id, connectionId],
    );

    await expect(
      runMaterializeRecords(domain.id, { db: handle.db, dnsProvider }),
    ).rejects.toThrow(/mail provider/);

    expect(await recordsFor(domain.id)).toEqual([]);

    const runs = await runsFor(domain.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    const steps = await stepsFor(runs[0]?.id ?? "");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: "read-intent", status: "failed" });
  });
});
