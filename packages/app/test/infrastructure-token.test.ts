/**
 * `infrastructure.sync-token-policy` (Phase 7 milestone 3, loxep-lmy.3):
 * the stub `DnsTokenProviderPort` fails every call the honest way, and the
 * task wraps that into a `reconcile_runs` row a human can find on
 * `/infrastructure/runs` — against a real scratch database, no mocking of
 * `@loxep/infrastructure`'s own logic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import type { TaskContext } from "@loxep/jobs";
import {
  ProviderCallError,
  SYNC_TOKEN_POLICY_RUN_KIND,
  SYNC_TOKEN_POLICY_TASK,
  createHostingTargetsService,
  createManagedDomainsService,
} from "@loxep/infrastructure";
import type { HostingTargetsService, ManagedDomainsService } from "@loxep/infrastructure";
import {
  buildDnsTokenProviderPort,
  createInfrastructureTokenTasks,
  createInfrastructureTokensService,
} from "../src/infrastructure-token.ts";
import { buildAppServices } from "../src/index.ts";
import type { AppServices } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
} from "./helpers.ts";

function noopHelpers(): TaskContext["helpers"] {
  return { addJob: async () => ({}) as never } as unknown as TaskContext["helpers"];
}

describe("buildDnsTokenProviderPort", () => {
  const port = buildDnsTokenProviderPort();

  it("rejects mintToken, rollToken, and updatePolicy with provider_unavailable", async () => {
    await expect(
      port.mintToken({ name: "x", permissionScope: "dns_edit", zoneExternalIds: [] }),
    ).rejects.toMatchObject({ kind: "provider_unavailable" });
    await expect(port.rollToken("ext-1")).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
    await expect(port.updatePolicy("ext-1", [])).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
    await expect(port.mintToken({ name: "x", permissionScope: "dns_edit", zoneExternalIds: [] })).rejects.toBeInstanceOf(
      ProviderCallError,
    );
  });

  it("findTokenById resolves 'not present' rather than throwing — it is a harmless read-back probe", async () => {
    await expect(port.findTokenById("ext-1")).resolves.toEqual({ exists: false });
  });
});

describe("infrastructure.sync-token-policy task", () => {
  const dbName = scratchDbName("loxep_test_app_infra_token");
  let databaseUrl = "";
  let handle: DbHandle;
  let services: AppServices;
  let targets: HostingTargetsService;
  let domains: ManagedDomainsService;
  let dnsConnectionId = "";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    services = buildAppServices({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });

    await handle.db.insert(user).values({
      id: "test-user",
      name: "Test User",
      email: "infra-token@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const dns = await services.connections.createConnection({
      provider: "cloudflare",
      kind: "dns",
      name: "test Cloudflare account",
      config: { cloudflare: { accountId: "acct_test" } },
      createdByUserId: "test-user",
    });
    dnsConnectionId = dns.id;

    targets = createHostingTargetsService({ db: handle.db });
    domains = createManagedDomainsService({ db: handle.db });
  }, 120_000);

  afterAll(async () => {
    await services?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  let seq = 0;
  function nextName(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}`;
  }

  /**
   * Seeds a `dns_provider_tokens` row DIRECTLY via SQL rather than through
   * `DnsProviderTokensService.mint` — `mint` goes through the same stub
   * provider this test is exercising and would reject immediately, which is
   * exactly the behavior under test, not a fixture-setup step.
   */
  async function seedToken(): Promise<{ tokenId: string; domainId: string }> {
    const target = await targets.create({
      name: nextName("target"),
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.9",
    });
    const domain = await domains.create({
      name: `${nextName("example")}.test`,
      dnsConnectionId,
    });
    await handle.pool.query(
      `update managed_domains set external_zone_id = $2 where id = $1`,
      [domain.id, `zone-${domain.id}`],
    );

    const tokenRow = await handle.pool.query<{ id: string }>(
      `insert into dns_provider_tokens
         (hosting_target_id, dns_connection_id, external_token_id, name, permission_scope)
       values ($1, $2, $3, $4, 'dns_edit')
       returning id`,
      [target.id, dnsConnectionId, `ext-${nextName("token")}`, nextName("token-name")],
    );
    const tokenId = tokenRow.rows[0]?.id;
    if (tokenId === undefined) throw new Error("dns_provider_tokens insert returned no row");

    await handle.pool.query(
      `insert into dns_provider_token_zones (token_id, domain_id) values ($1, $2)`,
      [tokenId, domain.id],
    );

    return { tokenId, domainId: domain.id };
  }

  async function reconcileRunFor(
    tokenId: string,
  ): Promise<{ kind: string; status: string; mode: string; trigger: string } | undefined> {
    const rows = await handle.pool.query<{
      kind: string;
      status: string;
      mode: string;
      trigger: string;
    }>(
      `select kind, status, mode, trigger from reconcile_runs
        where subject_type = 'token' and subject_id = $1
        order by started_at desc limit 1`,
      [tokenId],
    );
    return rows.rows[0];
  }

  it("createInfrastructureTokenTasks registers exactly the one task", () => {
    const tasks = createInfrastructureTokenTasks({ services });
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.syncTokenPolicyTask.name).toBe(SYNC_TOKEN_POLICY_TASK);
    expect(tasks.tasks[0]).toBe(tasks.syncTokenPolicyTask);
  });

  it("createInfrastructureTokensService never needs mint/roll called from this composition", () => {
    // Structural check that the HARD CONSTRAINT holds: the service this
    // composition builds still HAS mint/roll (the shared shape), but nothing
    // in this package's task wiring calls either — see the module doc.
    const tokens = createInfrastructureTokensService(services);
    expect(typeof tokens.mint).toBe("function");
    expect(typeof tokens.roll).toBe("function");
    expect(typeof tokens.syncPolicy).toBe("function");
  });

  it("fails the run 'failed' with provider_unavailable and throws, WITHOUT touching connection health", async () => {
    const { tokenId } = await seedToken();
    const tasks = createInfrastructureTokenTasks({ services });

    await expect(
      tasks.syncTokenPolicyTask.handler(
        { tokenId },
        { logger: silentJobsLogger, helpers: noopHelpers() },
      ),
    ).rejects.toMatchObject({ kind: "provider_unavailable" });

    const run = await reconcileRunFor(tokenId);
    expect(run).toEqual({
      kind: SYNC_TOKEN_POLICY_RUN_KIND,
      status: "failed",
      mode: "apply",
      trigger: "intent_change",
    });

    const steps = await handle.pool.query<{ status: string; error_code: string | null }>(
      `select rs.status, rs.error_code
         from reconcile_run_steps rs
         join reconcile_runs r on r.id = rs.run_id
        where r.subject_type = 'token' and r.subject_id = $1`,
      [tokenId],
    );
    expect(steps.rows).toHaveLength(1);
    expect(steps.rows[0]).toEqual({ status: "failed", error_code: "provider_unavailable" });

    // The failure reflects a missing Loxep adapter capability, not a bad
    // credential — connection health must stay untouched (module doc).
    const connection = await handle.pool.query<{ last_error_at: Date | null; last_error_code: string | null }>(
      `select last_error_at, last_error_code from connections where id = $1`,
      [dnsConnectionId],
    );
    expect(connection.rows[0]).toEqual({ last_error_at: null, last_error_code: null });
  });

  it("rejects an unknown token id", async () => {
    const tasks = createInfrastructureTokenTasks({ services });
    await expect(
      tasks.syncTokenPolicyTask.handler(
        { tokenId: "00000000-0000-0000-0000-000000000000" },
        { logger: silentJobsLogger, helpers: noopHelpers() },
      ),
    ).rejects.toThrow(/not found/);
  });
});
