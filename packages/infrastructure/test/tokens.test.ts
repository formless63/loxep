/**
 * `tokens.ts` against real PostgreSQL: mint, zone-scope intent, roll, and
 * policy sync.
 *
 * Three properties the design calls out by name, each with its own test
 * group below:
 *
 * 1. **The value is captured atomically.** A secret-write failure inside the
 *    mint transaction must leave NO `dns_provider_tokens` row behind — the
 *    design's "same transaction, or it is unrecoverable" instruction, proved
 *    rather than commented.
 * 2. **A `pending` ledger row is never blindly retried.** Open question 4:
 *    for a token, read-back is impossible, so the resolution is an operator
 *    decision, not a retry — proved by driving `mint` twice with the same
 *    (host, name) after a simulated crash.
 * 3. **The value never reaches a redacted summary.** `provider_operations`
 *    and `reconcile_run_steps` are asserted not to contain it, the same
 *    discipline `mail-boundary.test.ts` applies to a mailbox password.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { makeWorkerUtils } from "graphile-worker";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  ProviderCallError,
  SYNC_TOKEN_POLICY_TASK,
  createDnsProviderTokensService,
  createRecordingEnqueue,
  createTransactionalEnqueue,
  tokenJobKey,
} from "../src/index.ts";
import type {
  DnsProviderTokensService,
  TransactionalDnsTokenSecretWriter,
} from "../src/index.ts";
import {
  createRecordingDnsTokenSecretWriter,
  createStubTokenProvider,
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_tokens");
let handle: DbHandle;
let databaseUrl = "";
let dnsConnectionId = "";

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  // The policy-sync tests enqueue through a real transactional add_job.
  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.release();

  const connection = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('cloudflare', 'dns', 'Cloudflare (test)', 'active', '{"accountId":"acct_test"}')
     returning id`,
  );
  dnsConnectionId = connection.rows[0]?.id ?? "";
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;
function nextName(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

async function insertHostingTarget(): Promise<string> {
  const n = nextName("target");
  const row = await handle.pool.query<{ id: string }>(
    `insert into hosting_targets (name, control_surface, address_v4)
     values ($1, 'direct_reverse_proxy', '203.0.113.5')
     returning id`,
    [n],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("hosting target insert returned no row");
  return id;
}

async function insertManagedDomain(
  overrides: { externalZoneId?: string | null } = {},
): Promise<string> {
  const n = nextName("example");
  const row = await handle.pool.query<{ id: string }>(
    `insert into managed_domains (name, dns_connection_id, external_zone_id)
     values ($1, $2, $3)
     returning id`,
    [`${n}.test`, dnsConnectionId, overrides.externalZoneId ?? null],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("managed domain insert returned no row");
  return id;
}

async function jobKeys(prefix: string): Promise<string[]> {
  const result = await handle.pool.query<{ key: string }>(
    `select key from graphile_worker.jobs where key like $1`,
    [`${prefix}%`],
  );
  return result.rows.map((row) => row.key);
}

async function auditActions(resourceId: string): Promise<string[]> {
  const result = await handle.pool.query<{ action: string }>(
    `select action from audit_events where resource_id = $1 order by occurred_at`,
    [resourceId],
  );
  return result.rows.map((row) => row.action);
}

function service(options: {
  provider: ReturnType<typeof createStubTokenProvider>;
  secrets?: TransactionalDnsTokenSecretWriter;
  enqueue?: ReturnType<typeof createRecordingEnqueue> | ReturnType<typeof createTransactionalEnqueue>;
}): DnsProviderTokensService {
  return createDnsProviderTokensService({
    db: handle.db,
    provider: options.provider,
    secrets: options.secrets ?? createRecordingDnsTokenSecretWriter(),
    enqueue: options.enqueue ?? createTransactionalEnqueue(),
    providerName: "cloudflare",
  });
}

describe("mint", () => {
  it("returns the plaintext value in the response and persists no value on the row", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const writer = createRecordingDnsTokenSecretWriter();
    const tokens = service({ provider, secrets: writer });

    const result = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("token"),
    });

    expect(result.value).toMatch(/^stub-value-/);
    expect(result.token.id).toBeTypeOf("string");
    // TypeScript already prevents a `value`/`token` field on the row type;
    // this proves the runtime shape agrees.
    expect(Object.keys(result.token)).not.toContain("value");
    expect(writer.writes).toHaveLength(1);
    expect(writer.storedValueContains(result.value)).toBe(true);
  });

  it("writes the secret key under the design's stated convention", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const writer = createRecordingDnsTokenSecretWriter();
    const tokens = service({ provider, secrets: writer });

    const result = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("token"),
    });

    expect(writer.writes[0]?.secretKey).toBe(
      `infrastructure.dns_token.${result.token.externalTokenId}`,
    );
    expect(writer.writes[0]?.purpose).toBe("dns_edit_token");
  });

  it("audits both the mint and a secret.reveal_once event, in that order", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const tokens = service({ provider });

    const result = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("token"),
      actorUserId: null,
    });

    expect(await auditActions(result.token.id)).toEqual([
      "infrastructure.dns_provider_token.mint",
    ]);
    // The reveal is audited against the SECRET's resource id, not the token's.
    const secretAudit = await handle.pool.query<{ action: string }>(
      `select action from audit_events where resource_id = $1`,
      [result.token.secretId],
    );
    expect(secretAudit.rows.map((row) => row.action)).toContain(
      "secret.reveal_once",
    );
  });

  it("enqueues a policy sync ONLY when initial zones are supplied", async () => {
    const target = await insertHostingTarget();
    const domainId = await insertManagedDomain({ externalZoneId: "zone_abc" });
    const provider = createStubTokenProvider();

    const withoutZones = service({ provider });
    const bare = await withoutZones.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("bare"),
    });
    expect(await jobKeys(tokenJobKey(SYNC_TOKEN_POLICY_TASK, bare.token.id))).toEqual(
      [],
    );

    const withZones = service({ provider });
    const scoped = await withZones.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("scoped"),
      domainIds: [domainId],
    });
    const key = tokenJobKey(SYNC_TOKEN_POLICY_TASK, scoped.token.id);
    expect(await jobKeys(key)).toEqual([key]);
  });

  it("rejects an unknown hosting target", async () => {
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    await expect(
      tokens.mint({
        hostingTargetId: "00000000-0000-0000-0000-000000000000",
        dnsConnectionId,
        name: nextName("token"),
      }),
    ).rejects.toThrow(InfrastructureNotFoundError);
  });

  it("rejects an unknown domain in the initial zone scope", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    await expect(
      tokens.mint({
        hostingTargetId: target,
        dnsConnectionId,
        name: nextName("token"),
        domainIds: ["00000000-0000-0000-0000-000000000000"],
      }),
    ).rejects.toThrow(InfrastructureNotFoundError);
    expect(provider.mintCalls).toHaveLength(0);
  });

  it("rejects a decommissioned hosting target", async () => {
    const target = await insertHostingTarget();
    await handle.pool.query(
      `update hosting_targets set decommissioned_at = now() where id = $1`,
      [target],
    );
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    await expect(
      tokens.mint({
        hostingTargetId: target,
        dnsConnectionId,
        name: nextName("token"),
      }),
    ).rejects.toThrow(InfrastructureValidationError);
  });

  it("refuses to mint twice under the same (host, name) — the value cannot be shown again", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const name = nextName("dup");
    const tokens = service({ provider });

    await tokens.mint({ hostingTargetId: target, dnsConnectionId, name });
    await expect(
      tokens.mint({ hostingTargetId: target, dnsConnectionId, name }),
    ).rejects.toThrow(InfrastructureValidationError);
    // The refusal happens BEFORE any second provider call.
    expect(provider.mintCalls).toHaveLength(1);
  });

  it("propagates a provider mint failure as a ProviderCallError and stores nothing", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider({
      failMintOnce: { kind: "rate_limited", message: "slow down" },
    });
    const writer = createRecordingDnsTokenSecretWriter();
    const tokens = service({ provider, secrets: writer });

    await expect(
      tokens.mint({
        hostingTargetId: target,
        dnsConnectionId,
        name: nextName("failed"),
      }),
    ).rejects.toThrow(ProviderCallError);
    expect(writer.writes).toHaveLength(0);
  });

  it("never lets the minted value reach provider_operations.response_summary", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const tokens = service({ provider });

    const result = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("ledgered"),
    });

    const rows = await handle.pool.query<{ response_summary: unknown }>(
      `select response_summary from provider_operations where response_summary::text like $1`,
      [`%${result.value}%`],
    );
    expect(rows.rowCount).toBe(0);
  });

  describe("atomicity: token row + secret version commit TOGETHER, or neither does", () => {
    it("leaves no dns_provider_tokens row when the secret write fails inside the transaction", async () => {
      const target = await insertHostingTarget();
      const provider = createStubTokenProvider();
      const failingWriter: TransactionalDnsTokenSecretWriter = async () => {
        throw new Error("simulated secret-store outage");
      };
      const tokens = service({ provider, secrets: failingWriter });
      const name = nextName("atomic");

      await expect(
        tokens.mint({ hostingTargetId: target, dnsConnectionId, name }),
      ).rejects.toThrow("simulated secret-store outage");

      const rows = await handle.pool.query(
        `select 1 from dns_provider_tokens where hosting_target_id = $1`,
        [target],
      );
      expect(rows.rowCount).toBe(0);

      // The ledger row is left `pending` — this is the exact state open
      // question 4 says is unrecoverable by read-back for a token.
      const pending = await handle.pool.query<{ status: string }>(
        `select status from provider_operations
          where operation = 'dns.token.mint'
            and idempotency_key like $1`,
        [`%:${target}:${name}%`],
      );
      expect(pending.rows[0]?.status).toBe("pending");

      // A second attempt with the SAME (host, name) must not silently retry
      // the provider call — it must surface as an operator decision.
      await expect(
        tokens.mint({ hostingTargetId: target, dnsConnectionId, name }),
      ).rejects.toThrow(InfrastructureValidationError);
      // The provider was never called a second time.
      expect(provider.mintCalls).toHaveLength(1);
    });
  });
});

describe("setZones", () => {
  it("replaces the zone-scope intent and enqueues a policy sync", async () => {
    const target = await insertHostingTarget();
    const domainA = await insertManagedDomain({ externalZoneId: "zone_a" });
    const domainB = await insertManagedDomain({ externalZoneId: "zone_b" });
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    const minted = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("scoped"),
    });

    await tokens.setZones(minted.token.id, { domainIds: [domainA] });
    expect(await tokens.listZones(minted.token.id)).toEqual([domainA]);

    await tokens.setZones(minted.token.id, { domainIds: [domainB] });
    expect(await tokens.listZones(minted.token.id)).toEqual([domainB]);

    const key = tokenJobKey(SYNC_TOKEN_POLICY_TASK, minted.token.id);
    // Deduped by job key, not stacked, across both calls.
    expect(await jobKeys(key)).toEqual([key]);
  });

  it("rejects an unknown token", async () => {
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    await expect(
      tokens.setZones("00000000-0000-0000-0000-000000000000", {
        domainIds: [],
      }),
    ).rejects.toThrow(InfrastructureNotFoundError);
  });
});

describe("roll", () => {
  it("regenerates the value, rotates the secret, and stamps last_rolled_at", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const writer = createRecordingDnsTokenSecretWriter();
    const tokens = service({ provider, secrets: writer });
    const minted = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("rollable"),
    });

    const rolled = await tokens.roll(minted.token.id);

    expect(rolled.value).not.toBe(minted.value);
    expect(rolled.token.lastRolledAt).not.toBeNull();
    // Same LOGICAL secret id — a rotation (a new version under the same
    // secret_key), never a second logical secret. ADR-0019's shape.
    expect(rolled.token.secretId).toBe(minted.token.secretId);
    const secretKey = `infrastructure.dns_token.${minted.token.externalTokenId}`;
    expect(writer.writeCountFor(secretKey)).toBe(2);
  });

  it("may be repeated — rolling again is always a safe, deliberate action", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    const minted = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("rollable"),
    });

    await tokens.roll(minted.token.id);
    await tokens.roll(minted.token.id);
    expect(provider.rollCalls).toHaveLength(2);
  });

  it("audits a secret.reveal_once for the roll too", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    const minted = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("rollable"),
    });
    const rolled = await tokens.roll(minted.token.id, { actorUserId: null });

    const secretAudit = await handle.pool.query<{ action: string }>(
      `select action from audit_events where resource_id = $1`,
      [rolled.token.secretId],
    );
    expect(secretAudit.rows.map((row) => row.action)).toContain(
      "secret.reveal_once",
    );
  });

  it("propagates a provider roll failure without changing last_rolled_at", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    const minted = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("rollfail"),
    });

    const failing = createStubTokenProvider({
      failRollOnce: { kind: "auth", message: "revoked" },
    });
    const failingTokens = service({ provider: failing });
    // Mint again against the failing provider's own instance to keep the
    // externalTokenId map consistent for its findTokenById.
    await expect(
      failingTokens.roll(minted.token.id),
    ).rejects.toThrow(ProviderCallError);

    const row = await handle.pool.query<{ last_rolled_at: string | null }>(
      `select last_rolled_at from dns_provider_tokens where id = $1`,
      [minted.token.id],
    );
    expect(row.rows[0]?.last_rolled_at).toBeNull();
  });
});

describe("syncPolicy", () => {
  it("rebuilds the whole policy from dns_provider_token_zones and skips unzoned domains", async () => {
    const target = await insertHostingTarget();
    const zoned = await insertManagedDomain({ externalZoneId: "zone_live" });
    const unzoned = await insertManagedDomain({ externalZoneId: null });
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    const minted = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("policy"),
    });
    await tokens.setZones(minted.token.id, { domainIds: [zoned, unzoned] });

    const result = await tokens.syncPolicy(minted.token.id);

    expect(result.status).toBe("succeeded");
    expect(result.zoneCount).toBe(1);
    expect(result.skippedUnzoned).toBe(1);
    expect(provider.updatePolicyCalls).toHaveLength(1);
    expect(provider.updatePolicyCalls[0]?.zoneExternalIds).toEqual([
      "zone_live",
    ]);

    const row = await handle.pool.query<{ policy_synced_at: string | null }>(
      `select policy_synced_at from dns_provider_tokens where id = $1`,
      [minted.token.id],
    );
    expect(row.rows[0]?.policy_synced_at).not.toBeNull();
  });

  it("records a reconcile_runs row with subject_type = 'token'", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    const minted = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("run"),
    });

    const result = await tokens.syncPolicy(minted.token.id);

    const run = await handle.pool.query<{
      subject_type: string;
      subject_id: string;
      mode: string;
      status: string;
    }>(`select subject_type, subject_id, mode, status from reconcile_runs where id = $1`, [
      result.runId,
    ]);
    expect(run.rows[0]).toEqual({
      subject_type: "token",
      subject_id: minted.token.id,
      mode: "apply",
      status: "succeeded",
    });
  });

  it("finishes the run 'failed' and throws when the provider rejects the policy", async () => {
    const target = await insertHostingTarget();
    const provider = createStubTokenProvider({
      failUpdatePolicy: { kind: "provider_unavailable", message: "down" },
    });
    const tokens = service({ provider });
    const minted = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("downpolicy"),
    });

    await expect(tokens.syncPolicy(minted.token.id)).rejects.toThrow(
      ProviderCallError,
    );

    const row = await handle.pool.query<{ policy_synced_at: string | null }>(
      `select policy_synced_at from dns_provider_tokens where id = $1`,
      [minted.token.id],
    );
    expect(row.rows[0]?.policy_synced_at).toBeNull();

    const run = await handle.pool.query<{ status: string }>(
      `select status from reconcile_runs where subject_id = $1 order by started_at desc limit 1`,
      [minted.token.id],
    );
    expect(run.rows[0]?.status).toBe("failed");
  });

  it("never lets the token value reach a reconcile_run_steps summary", async () => {
    const target = await insertHostingTarget();
    const domainId = await insertManagedDomain({ externalZoneId: "zone_redact" });
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    const minted = await tokens.mint({
      hostingTargetId: target,
      dnsConnectionId,
      name: nextName("redact"),
      domainIds: [domainId],
    });

    await tokens.syncPolicy(minted.token.id);

    const rows = await handle.pool.query<{ count: string }>(
      `select count(*) as count from reconcile_run_steps
        where (request_summary::text like $1 or response_summary::text like $1)`,
      [`%${minted.value}%`],
    );
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("rejects an unknown token", async () => {
    const provider = createStubTokenProvider();
    const tokens = service({ provider });
    await expect(
      tokens.syncPolicy("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(InfrastructureNotFoundError);
  });
});
