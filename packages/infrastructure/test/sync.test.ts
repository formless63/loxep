/**
 * The reconcile run against real PostgreSQL and a STUBBED provider.
 *
 * The design's pre-implementation checklist item 6: *"write the reconcile
 * idempotency tests before the reconciler: same intent twice, a crash between
 * the `provider_operations` insert and the provider call, a drift finding
 * detected twice, and a soft-deleted record re-declared — all against real
 * PostgreSQL."* Every one of those is here, plus the two rules that must hold
 * in every mode: an `unexpected` record is never deleted, and a `manual`
 * record is never rewritten.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  createDriftService,
  createManagedDomainsService,
  createProviderOperationsLedger,
  createRecordSyncService,
  idempotencyKey,
} from "../src/index.ts";
import type {
  DriftService,
  ManagedDomainsService,
  ObservedDnsRecord,
} from "../src/index.ts";
import {
  createScratchDb,
  createStubProvider,
  dropScratchDb,
  observed,
  scratchDbName,
  silentLogger,
  type StubProvider,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_sync");
let handle: DbHandle;
let connectionId = "";
let domains: ManagedDomainsService;
let drift: DriftService;

const ZONE_ID = "zone-stub-1";

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  const connection = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('cloudflare', 'dns', 'Cloudflare (test)', 'active', '{"accountId":"acct_test"}')
     returning id`,
  );
  connectionId = connection.rows[0]?.id ?? "";
  domains = createManagedDomainsService({ db: handle.db });
  drift = createDriftService({ db: handle.db });
}, 180_000);

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;
let domainId = "";
let domainName = "";

/** A domain already past `zone_created`, so record sync has a zone to talk to. */
async function freshDomain(): Promise<{ id: string; name: string }> {
  seq += 1;
  const name = `sync-${seq}.test`;
  const row = await domains.create({ name, dnsConnectionId: connectionId });
  await handle.pool.query(
    `update managed_domains
        set external_zone_id = $2, state = 'zone_active', provider_zone_status = 'active'
      where id = $1`,
    [row.id, `${ZONE_ID}-${seq}`],
  );
  return { id: row.id, name };
}

function providerFor(records: ObservedDnsRecord[] = []): StubProvider {
  return createStubProvider({
    zoneName: domainName,
    externalZoneId: `${ZONE_ID}-${seq}`,
    records,
  });
}

const APEX = {
  type: "A" as const,
  name: "@",
  content: "203.0.113.10",
  ttlSeconds: null,
  priority: null,
  proxied: false,
  owner: "apex" as const,
};

beforeEach(async () => {
  const created = await freshDomain();
  domainId = created.id;
  domainName = created.name;
});

async function countSteps(runId: string): Promise<number> {
  const result = await handle.pool.query<{ count: string }>(
    `select count(*)::text as count from reconcile_run_steps where run_id = $1`,
    [runId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("mode = 'apply'", () => {
  it("creates the missing record and records runs, steps, and a resolved finding", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor();
    const sync = createRecordSyncService({ db: handle.db, provider });

    const result = await sync.run({
      domainId,
      mode: "apply",
      trigger: "intent_change",
    });

    expect(result.status).toBe("succeeded");
    expect(result.diff.missing).toHaveLength(1);
    expect(result.applied).toBe(1);
    expect(provider.state()).toHaveLength(1);
    expect(provider.state()[0]?.content).toBe("203.0.113.10");

    const run = await handle.pool.query<{
      mode: string;
      status: string;
      step_count: number;
    }>(`select mode, status, step_count from reconcile_runs where id = $1`, [
      result.runId,
    ]);
    expect(run.rows[0]?.mode).toBe("apply");
    expect(run.rows[0]?.status).toBe("succeeded");
    expect(run.rows[0]?.step_count).toBe(await countSteps(result.runId));

    // The finding is recorded and THEN resolved, so the history of what was
    // wrong survives the fix.
    const findings = await handle.pool.query<{
      kind: string;
      resolution: string | null;
    }>(`select kind, resolution from dns_drift_findings where domain_id = $1`, [
      domainId,
    ]);
    expect(findings.rows).toEqual([{ kind: "missing", resolution: "applied" }]);
  });

  it("captures the provider record id so the next update is one call", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor();
    const sync = createRecordSyncService({ db: handle.db, provider });
    await sync.run({ domainId, mode: "apply", trigger: "manual" });

    const rows = await handle.pool.query<{ external_record_id: string | null }>(
      `select external_record_id from dns_records where domain_id = $1`,
      [domainId],
    );
    expect(rows.rows[0]?.external_record_id).not.toBeNull();
  });

  it("is IDEMPOTENT: the same intent applied twice changes nothing the second time", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor();
    const sync = createRecordSyncService({ db: handle.db, provider });

    await sync.run({ domainId, mode: "apply", trigger: "intent_change" });
    const second = await sync.run({ domainId, mode: "apply", trigger: "sweep" });

    expect(second.diff.unchanged).toHaveLength(1);
    expect(second.applied).toBe(0);
    expect(provider.state()).toHaveLength(1);
  });

  it("RE-RUNS SAFELY after a crash mid-apply — at-least-once delivery", async () => {
    // Two records to create; the provider crashes on the second. The first is
    // really committed at the provider, so the rerun must converge rather than
    // duplicate it.
    await domains.applyMaterializedRecords(domainId, [
      APEX,
      { ...APEX, name: "*", owner: "wildcard" },
    ]);
    const provider = providerFor();
    provider.setFailApplyAtIndex(1);
    const sync = createRecordSyncService({ db: handle.db, provider });

    await expect(
      sync.run({ domainId, mode: "apply", trigger: "intent_change" }),
    ).rejects.toThrow();
    expect(provider.state()).toHaveLength(1);

    // The failed run is recorded as failed, not lost.
    const failed = await handle.pool.query<{ status: string }>(
      `select status from reconcile_runs where subject_id = $1 and status = 'failed'`,
      [domainId],
    );
    expect(failed.rows).toHaveLength(1);

    provider.setFailApplyAtIndex(undefined);
    const rerun = await sync.run({
      domainId,
      mode: "apply",
      trigger: "intent_change",
    });
    expect(rerun.status).toBe("succeeded");
    // One created, one already there — not three records.
    expect(provider.state()).toHaveLength(2);
  });

  it("updates a modified record rather than deleting and recreating it", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor([
      observed({ externalRecordId: "r1", content: "203.0.113.99" }),
    ]);
    const sync = createRecordSyncService({ db: handle.db, provider });

    const result = await sync.run({ domainId, mode: "apply", trigger: "manual" });
    expect(result.diff.modified).toHaveLength(1);
    expect(provider.applyCalls[0]?.[0]?.kind).toBe("update");
    expect(provider.state()).toHaveLength(1);
    expect(provider.state()[0]?.content).toBe("203.0.113.10");
  });

  it("deletes a record intent SOFT-DELETED, and only that one", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor([
      observed({ externalRecordId: "r1", content: "203.0.113.10" }),
    ]);
    const sync = createRecordSyncService({ db: handle.db, provider });
    await sync.run({ domainId, mode: "apply", trigger: "manual" });

    // Drop the record from intent: it becomes a tombstone.
    await domains.applyMaterializedRecords(domainId, []);
    const after = await sync.run({ domainId, mode: "apply", trigger: "manual" });
    expect(after.status).toBe("succeeded");
    expect(provider.state()).toHaveLength(0);
  });

  it("RESURRECTS a re-declared soft-deleted record and pushes it again", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor();
    const sync = createRecordSyncService({ db: handle.db, provider });
    await sync.run({ domainId, mode: "apply", trigger: "manual" });

    await domains.applyMaterializedRecords(domainId, []);
    await sync.run({ domainId, mode: "apply", trigger: "manual" });
    expect(provider.state()).toHaveLength(0);

    // Re-declare: the tombstone is cleared, not duplicated.
    await domains.applyMaterializedRecords(domainId, [APEX]);
    await sync.run({ domainId, mode: "apply", trigger: "manual" });
    expect(provider.state()).toHaveLength(1);

    const all = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count from dns_records where domain_id = $1`,
      [domainId],
    );
    expect(all.rows[0]?.count).toBe("1");
  });
});

describe("mode = 'check' — the drift path", () => {
  it("changes NOTHING at the provider and persists the findings", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor([
      observed({ externalRecordId: "r1", content: "203.0.113.99" }),
      observed({
        externalRecordId: "r2",
        type: "TXT",
        name: "_hand-edited",
        content: "somebody-added-this",
        proxiable: false,
      }),
    ]);
    const sync = createRecordSyncService({ db: handle.db, provider });

    const result = await sync.run({ domainId, mode: "check", trigger: "sweep" });

    expect(result.mode).toBe("check");
    expect(provider.applyCalls).toHaveLength(0);
    expect(provider.state()).toHaveLength(2);

    const findings = await handle.pool.query<{
      kind: string;
      record_name: string;
      desired_content: string | null;
      observed_content: string | null;
      resolution: string | null;
    }>(
      `select kind, record_name, desired_content, observed_content, resolution
         from dns_drift_findings where domain_id = $1 order by kind`,
      [domainId],
    );
    expect(findings.rows).toEqual([
      {
        kind: "modified",
        record_name: "@",
        desired_content: "203.0.113.10",
        observed_content: "203.0.113.99",
        resolution: null,
      },
      {
        kind: "unexpected",
        record_name: "_hand-edited",
        desired_content: null,
        observed_content: "somebody-added-this",
        resolution: null,
      },
    ]);
  });

  it("records an UNEXPECTED record with no intent row at all", async () => {
    // The drift class that cannot be modelled as columns on `dns_records`, and
    // the reason the findings table exists.
    const provider = providerFor([
      observed({ externalRecordId: "r1", type: "TXT", name: "surprise" }),
    ]);
    const sync = createRecordSyncService({ db: handle.db, provider });
    await sync.run({ domainId, mode: "check", trigger: "sweep" });

    const rows = await handle.pool.query<{ dns_record_id: string | null }>(
      `select dns_record_id from dns_drift_findings
        where domain_id = $1 and kind = 'unexpected'`,
      [domainId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.dns_record_id).toBeNull();
  });

  it("stamps the drift rollup on the domain and clears it when drift resolves", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor();
    const sync = createRecordSyncService({ db: handle.db, provider });
    await sync.run({ domainId, mode: "check", trigger: "sweep" });

    const drifted = await handle.pool.query<{ drift_detected_at: Date | null }>(
      `select drift_detected_at from managed_domains where id = $1`,
      [domainId],
    );
    expect(drifted.rows[0]?.drift_detected_at).not.toBeNull();

    await sync.run({ domainId, mode: "apply", trigger: "manual" });
    const clean = await sync.run({ domainId, mode: "check", trigger: "sweep" });
    expect(clean.unresolvedFindings).toBe(0);

    const cleared = await handle.pool.query<{ drift_detected_at: Date | null }>(
      `select drift_detected_at from managed_domains where id = $1`,
      [domainId],
    );
    expect(cleared.rows[0]?.drift_detected_at).toBeNull();
  });

  it("UPSERTS the same finding across sweeps instead of accumulating rows", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor([
      observed({ externalRecordId: "r1", content: "203.0.113.99" }),
    ]);
    const sync = createRecordSyncService({ db: handle.db, provider });

    const first = await sync.run({ domainId, mode: "check", trigger: "sweep" });
    await sync.run({ domainId, mode: "check", trigger: "sweep" });
    const third = await sync.run({ domainId, mode: "check", trigger: "sweep" });

    const rows = await handle.pool.query<{
      count: string;
      first_seen_run_id: string;
      last_seen_run_id: string;
    }>(
      `select count(*) over ()::text as count, first_seen_run_id, last_seen_run_id
         from dns_drift_findings where domain_id = $1 and resolved_at is null`,
      [domainId],
    );
    expect(rows.rows).toHaveLength(1);
    // "How long has this been wrong" survives; "when did we last see it" moves.
    expect(rows.rows[0]?.first_seen_run_id).toBe(first.runId);
    expect(rows.rows[0]?.last_seen_run_id).toBe(third.runId);
  });

  it("resolves a finding as 'disappeared' rather than deleting it", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor();
    const sync = createRecordSyncService({ db: handle.db, provider });
    await sync.run({ domainId, mode: "check", trigger: "sweep" });

    // The record appears at the provider by some other means.
    await provider.apply({
      externalZoneId: `${ZONE_ID}-${seq}`,
      zoneName: domainName,
      operations: [
        {
          kind: "create",
          record: {
            type: "A",
            name: "@",
            content: "203.0.113.10",
            ttlSeconds: null,
            priority: null,
            proxied: false,
          },
        },
      ],
    });
    const after = await sync.run({ domainId, mode: "check", trigger: "sweep" });
    expect(after.disappearedFindings).toBe(1);

    const rows = await handle.pool.query<{ resolution: string | null }>(
      `select resolution from dns_drift_findings where domain_id = $1`,
      [domainId],
    );
    expect(rows.rows).toEqual([{ resolution: "disappeared" }]);
  });
});

describe("the rules that hold in EVERY mode", () => {
  it("NEVER deletes an unexpected record, not even in apply mode", async () => {
    // Open question 3, PROVISIONAL: hold this line permanently.
    const provider = providerFor([
      observed({ externalRecordId: "r1", type: "TXT", name: "somebody-elses" }),
    ]);
    const sync = createRecordSyncService({ db: handle.db, provider });

    const result = await sync.run({ domainId, mode: "apply", trigger: "sweep" });
    expect(result.diff.unexpected).toHaveLength(1);
    expect(provider.applyCalls).toHaveLength(0);
    expect(provider.state()).toHaveLength(1);

    // And it stays unresolved after an apply run, because an apply never
    // touched it.
    const unresolved = await drift.listUnresolved(domainId);
    expect(unresolved.map((finding) => finding.kind)).toEqual(["unexpected"]);
  });

  it("NEVER rewrites a manual record, but DOES report that it drifted", async () => {
    await domains.addManualRecord(domainId, {
      type: "TXT",
      name: "_vendor",
      content: "authored-by-a-human",
    });
    const provider = providerFor([
      observed({
        externalRecordId: "r1",
        type: "TXT",
        name: "_vendor",
        content: "hand-edited-at-the-provider",
        proxiable: false,
      }),
    ]);
    const sync = createRecordSyncService({ db: handle.db, provider });

    const result = await sync.run({ domainId, mode: "apply", trigger: "manual" });
    // Compared — so the hand-edit is visible.
    expect(result.diff.modified).toHaveLength(1);
    // Never rewritten.
    expect(provider.applyCalls).toHaveLength(0);
    expect(provider.state()[0]?.content).toBe("hand-edited-at-the-provider");
  });

  it("ADOPTS an unexpected record into intent, so drift disappears by catching up", async () => {
    const provider = providerFor([
      observed({
        externalRecordId: "r1",
        type: "TXT",
        name: "_adopt-me",
        content: "vendor-verification",
        proxiable: false,
      }),
    ]);
    const sync = createRecordSyncService({ db: handle.db, provider });
    await sync.run({ domainId, mode: "check", trigger: "sweep" });
    expect(await drift.listUnresolved(domainId)).toHaveLength(1);

    // Adopt: write the observed value into desired state as a manual record.
    await domains.addManualRecord(domainId, {
      type: "TXT",
      name: "_adopt-me",
      content: "vendor-verification",
      externalRecordId: "r1",
    });

    const after = await sync.run({ domainId, mode: "check", trigger: "sweep" });
    expect(after.diff.unexpected).toHaveLength(0);
    expect(after.diff.unchanged).toHaveLength(1);
    // Reality was never overwritten; intent caught up with it.
    expect(provider.state()).toHaveLength(1);
    expect(after.disappearedFindings).toBe(1);
  });

  it("records the failure and the health columns when the provider read fails", async () => {
    const provider = createStubProvider({
      zoneName: domainName,
      externalZoneId: `${ZONE_ID}-${seq}`,
      failRead: { kind: "auth", message: "token revoked" },
    });
    const sync = createRecordSyncService({ db: handle.db, provider });

    await expect(
      sync.run({ domainId, mode: "check", trigger: "sweep" }),
    ).rejects.toThrow();

    const row = await handle.pool.query<{
      last_error_code: string | null;
      consecutive_errors: number;
      state: string;
    }>(
      `select last_error_code, consecutive_errors, state from managed_domains where id = $1`,
      [domainId],
    );
    // Health is ORTHOGONAL to state: the domain did not move backwards.
    expect(row.rows[0]?.last_error_code).toBe("auth");
    expect(row.rows[0]?.consecutive_errors).toBe(1);
    expect(row.rows[0]?.state).toBe("zone_active");
  });

  it("refuses to run against a domain with no provider zone yet", async () => {
    const draft = await domains.create({
      name: `draft-${seq}-only.test`,
      dnsConnectionId: connectionId,
    });
    const provider = providerFor();
    const sync = createRecordSyncService({ db: handle.db, provider });
    await expect(
      sync.run({ domainId: draft.id, mode: "check", trigger: "sweep" }),
    ).rejects.toThrow(/no provider zone yet/);
  });
});

describe("run steps never carry credential material", () => {
  it("summarizes operations and identities, and nothing that could be a secret", async () => {
    await domains.applyMaterializedRecords(domainId, [APEX]);
    const provider = providerFor();
    const sync = createRecordSyncService({ db: handle.db, provider });
    const result = await sync.run({
      domainId,
      mode: "apply",
      trigger: "manual",
    });

    const steps = await handle.pool.query<{
      step: string;
      request_summary: unknown;
      response_summary: unknown;
    }>(
      `select step, request_summary, response_summary
         from reconcile_run_steps where run_id = $1 order by sequence`,
      [result.runId],
    );
    const serialized = JSON.stringify(steps.rows);
    for (const forbidden of [
      "authorization",
      "Authorization",
      "Bearer",
      "apiToken",
      "password",
      "token",
    ]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
    expect(steps.rows.map((row) => row.step)).toEqual([
      "read-intent",
      "read-provider",
      "diff",
      "apply.create",
      "record-findings",
    ]);
  });
});

describe("provider_operations — the idempotency ledger", () => {
  it("lets the first caller proceed and short-circuits a succeeded retry", async () => {
    const ledger = createProviderOperationsLedger({ db: handle.db });
    const key = idempotencyKey("cloudflare", "zone-create", `${domainName}-a`);

    expect((await ledger.begin({ key, provider: "cloudflare", operation: "zone-create" })).decision).toBe(
      "proceed",
    );
    await ledger.succeed(key, { zoneId: "zone-abc" });
    const retry = await ledger.begin({
      key,
      provider: "cloudflare",
      operation: "zone-create",
    });
    expect(retry.decision).toBe("already_succeeded");
    expect(retry.row.responseSummary).toEqual({ zoneId: "zone-abc" });
    expect(retry.row.attempts).toBe(2);
  });

  it("NEVER auto-retries a pending row — it demands a read-back (open question 4)", async () => {
    // A `pending` row means "we may or may not have created something". A
    // blind retry is the one response that is always wrong: if the call did go
    // through, the retry creates a duplicate zone or a duplicate billable
    // mailbox.
    const ledger = createProviderOperationsLedger({ db: handle.db });
    const key = idempotencyKey("cloudflare", "zone-create", `${domainName}-b`);

    await ledger.begin({ key, provider: "cloudflare", operation: "zone-create" });
    // ... crash here, before succeed() or fail() ...
    const after = await ledger.begin({
      key,
      provider: "cloudflare",
      operation: "zone-create",
    });
    expect(after.decision).toBe("needs_read_back");
    expect(after.row.status).toBe("pending");

    // The read-back: ask the provider whether the object actually exists.
    const provider = providerFor();
    const zone = await provider.findZoneByName(domainName);
    if (zone === null) await ledger.fail(key, { readBack: "absent" });
    else await ledger.succeed(key, { readBack: "present", zoneId: zone.externalZoneId });

    const resolved = await ledger.get(key);
    expect(resolved?.status).toBe("succeeded");
    expect(resolved?.responseSummary).toMatchObject({ readBack: "present" });
  });

  it("lets a FAILED operation be retried, because failed means nothing was created", async () => {
    const ledger = createProviderOperationsLedger({ db: handle.db });
    const key = idempotencyKey("cloudflare", "zone-create", `${domainName}-c`);
    await ledger.begin({ key, provider: "cloudflare", operation: "zone-create" });
    await ledger.fail(key, { reason: "invalid_request" });
    const retry = await ledger.begin({
      key,
      provider: "cloudflare",
      operation: "zone-create",
    });
    expect(retry.decision).toBe("proceed");
  });

  it("surfaces every pending operation for the UI's decision list", async () => {
    const ledger = createProviderOperationsLedger({ db: handle.db });
    const key = idempotencyKey("cloudflare", "token-create", `${domainName}-d`);
    await ledger.begin({ key, provider: "cloudflare", operation: "token-create" });
    const pending = await ledger.listPending();
    expect(pending.map((row) => row.idempotencyKey)).toContain(key);
  });

  it("never stores a token value in a response summary", async () => {
    // The single highest-risk line in the design. A token value goes to
    // application_secrets and nowhere else.
    const ledger = createProviderOperationsLedger({ db: handle.db });
    const key = idempotencyKey("cloudflare", "token-create", `${domainName}-e`);
    await ledger.begin({ key, provider: "cloudflare", operation: "token-create" });
    // What a redactor produces, which is the only thing this API accepts.
    await ledger.succeed(key, {
      tokenId: "tok_1",
      status: "active",
      policyCount: 1,
      valueOmitted: true,
    });
    const row = await ledger.get(key);
    expect(JSON.stringify(row?.responseSummary)).not.toMatch(/v1\.0-/);
    expect(row?.responseSummary).toMatchObject({ valueOmitted: true });
  });
});
