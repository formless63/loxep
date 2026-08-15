/**
 * `infrastructure-proxy.ts` — the composition-root wiring for
 * `infrastructure.sync-proxy-resource` (Pangolin chain design milestone 2,
 * loxep-acj.2). Traces:
 *
 * ```text
 * infrastructure.sync-proxy-resource job
 *   -> the composed task registry -> @loxep/app's proxy branch
 *   -> resolve the PROXY connection from hosting_targets.proxy_connection_id
 *      (never from the payload)
 *   -> the Pangolin adapter, wrapped as a ProxyProviderPort
 *   -> @loxep/infrastructure createProxyResourcesService(...).reconcileDomain(...)
 * ```
 *
 * What this file proves, and why each item earns a place here rather than in
 * `packages/infrastructure`'s own suite (which already exhaustively covers
 * the planner and the service's own check-mode refusal):
 *
 * 1. **The structural port re-declaration still matches the REAL adapter.**
 *    `proxy-port.ts` promises this is "guarded by a compile-time
 *    assignability test in `@loxep/app`'s suite"; this is that test, against
 *    a real `PangolinAdapter` — the `fleet.ts` `ContainerHostAdapterLike`
 *    precedent this milestone's brief names explicitly.
 * 2. **The task is actually registered** in the COMPOSED worker registry —
 *    the exact gap `SYNC_PROXY_RESOURCE_TASK` sat in since Phase 7 milestone
 *    3 until this milestone closed it.
 * 3. **`hosting_targets.proxy_connection_id` drives the provider
 *    resolution** — `null` when unset (recorded as `skipped`, never a
 *    failure), a real connection when set.
 * 4. **A stray `mode: 'apply'` in the job payload fails the job loudly**,
 *    through the real worker, rather than being silently downgraded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { addJob, startWorkerRuntime } from "@loxep/jobs";
import type { WorkerRuntime } from "@loxep/jobs";
import { SYNC_PROXY_RESOURCE_TASK, createHostingTargetsService } from "@loxep/infrastructure";
import type { ProxyProviderPort } from "@loxep/infrastructure";
import { createPangolinAdapter } from "@loxep/integration-pangolin";
import {
  createInfrastructureProxyTasks,
  proxyProviderPortFromPangolinAdapter,
  resolveProxyProviderForHostingTarget,
} from "../src/infrastructure-proxy.ts";
import { buildAppServices, buildWorkerRegistry } from "../src/index.ts";
import type { AppServices, WorkerComposition } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
  waitFor,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_infra_proxy");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let composition: WorkerComposition;
let runtime: WorkerRuntime;
let dnsConnectionId = "";
let pangolinConnectionId = "";
let tasks: ReturnType<typeof createInfrastructureProxyTasks>;

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  const real = buildAppServices({ config, logger: silentJobsLogger });
  services = {
    ...real,
    // Only the provider boundary is stubbed — the same "only the touched
    // surface" discipline `infrastructure-mail.test.ts` uses for Purelymail.
    getPangolinAdapterForConnection: async (id) => ({
      connectionId: id,
      baseUrl: "https://pangolin.test",
      orgId: "home-lab",
      sourceAccountKey: "https://pangolin.test",
      adapter: {
        async listResources() {
          return [];
        },
        async listTargets() {
          return [];
        },
        async listRules() {
          return [];
        },
        capabilities: () => ({
          provider: "pangolin" as const,
          readOnly: true as const,
          bulkRuleSet: false,
          ruleAliases: false as const,
          ruleDisable: true,
          domainCreate: false,
          siteCreate: false,
          ruleMatches: ["CIDR"],
          ruleActions: ["ACCEPT"],
        }),
      } as never,
      minIntervalSeconds: 3600,
    }),
    invalidatePangolinAdapter: () => undefined,
  };

  composition = buildWorkerRegistry({ config, services, logger: silentJobsLogger });
  tasks = createInfrastructureProxyTasks({ services });

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
    email: "infra-proxy@example.invalid",
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

  const pangolin = await services.connections.createConnection({
    provider: "pangolin",
    kind: "proxy",
    name: "test Pangolin instance",
    config: { pangolin: { baseUrl: "https://pangolin.test", orgId: "home-lab" } },
    createdByUserId: "test-user",
  });
  pangolinConnectionId = pangolin.id;
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  await composition?.close();
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;
function nextName(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

async function insertDomain(): Promise<{ id: string }> {
  const row = await handle.pool.query<{ id: string }>(
    `insert into managed_domains (name, dns_connection_id) values ($1, $2) returning id`,
    [`${nextName("example")}.test`, dnsConnectionId],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("managed_domains insert returned no row");
  return { id };
}

async function insertHostingTarget(
  proxyConnectionId: string | null,
): Promise<{ id: string }> {
  const row = await handle.pool.query<{ id: string }>(
    `insert into hosting_targets (name, control_surface, address_v4, proxy_connection_id)
     values ($1, 'direct_reverse_proxy', '203.0.113.5', $2)
     returning id`,
    [nextName("target"), proxyConnectionId],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("hosting_targets insert returned no row");
  return { id };
}

async function insertProxyResource(domainId: string, hostingTargetId: string): Promise<{ id: string }> {
  const row = await handle.pool.query<{ id: string }>(
    `insert into proxy_resources (domain_id, hosting_target_id, subdomain) values ($1, $2, 'api') returning id`,
    [domainId, hostingTargetId],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("proxy_resources insert returned no row");
  return { id };
}

describe("the structural port re-declaration", () => {
  it("accepts a REAL PangolinAdapter where a ProxyProviderPort is required", () => {
    // The compile-time half of the guarantee `proxy-port.ts` promises: if the
    // adapter and the re-declared port ever drift, THIS LINE stops compiling.
    const adapter = createPangolinAdapter({
      config: { baseUrl: "https://pangolin.test" },
      credentials: { apiKeyId: "fake-id", apiKeySecret: "fake-secret" },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const port: ProxyProviderPort = proxyProviderPortFromPangolinAdapter(adapter);
    expect(typeof port.read).toBe("function");
    expect(typeof port.apply).toBe("function");
    expect(typeof port.capabilities).toBe("function");
  });

  it("apply() throws — no write verb exists in the milestone-1 adapter", async () => {
    const adapter = createPangolinAdapter({
      config: { baseUrl: "https://pangolin.test" },
      credentials: { apiKeyId: "fake-id", apiKeySecret: "fake-secret" },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const port = proxyProviderPortFromPangolinAdapter(adapter);
    await expect(
      port.apply({
        kind: "create-resource",
        resource: { name: "x", domainId: "1", subdomain: null, mode: "http" },
      }),
    ).rejects.toThrow(/no write verb/);
  });
});

describe("task registration", () => {
  it("registers infrastructure.sync-proxy-resource in the COMPOSED registry", () => {
    // Milestone 1 deliberately left this unregistered so an accidental
    // enqueue would fail loudly. This is the assertion that it is real now.
    expect(composition.registry.has(SYNC_PROXY_RESOURCE_TASK)).toBe(true);
  });
});

describe("resolveProxyProviderForHostingTarget", () => {
  it("returns null when the hosting target has no proxy_connection_id", async () => {
    const target = await insertHostingTarget(null);
    const resolved = await resolveProxyProviderForHostingTarget(services, target.id);
    expect(resolved).toBeNull();
  });

  it("returns a provider + orgId when the hosting target is linked", async () => {
    const target = await insertHostingTarget(pangolinConnectionId);
    const resolved = await resolveProxyProviderForHostingTarget(services, target.id);
    expect(resolved).not.toBeNull();
    expect(resolved?.orgId).toBe("home-lab");
    expect(typeof resolved?.provider.read).toBe("function");
  });

  it("returns null for a hosting target id that does not exist", async () => {
    const resolved = await resolveProxyProviderForHostingTarget(
      services,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(resolved).toBeNull();
  });
});

describe("infrastructure.sync-proxy-resource, end to end", () => {
  it("reconciles every declared proxy_resources row for the domain, hosting_targets.proxy_connection_id driving the provider", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget(pangolinConnectionId);
    const resource = await insertProxyResource(domain.id, target.id);

    const before = await handle.pool.query(
      `select count(*)::int as n from reconcile_runs where subject_type = 'proxy_resource' and subject_id = $1`,
      [resource.id],
    );

    await addJob(handle.pool, tasks.syncProxyResourceTask, { domainId: domain.id });

    await waitFor(
      async () => {
        const after = await handle.pool.query<{ n: number }>(
          `select count(*)::int as n from reconcile_runs where subject_type = 'proxy_resource' and subject_id = $1`,
          [resource.id],
        );
        const beforeCount = (before.rows[0] as { n: number }).n;
        return after.rows[0]!.n > beforeCount ? after.rows[0] : undefined;
      },
      { timeoutMs: 30_000, label: `proxy resource reconcile run for ${resource.id}` },
    );
  });

  it("fails the job loudly on a stray mode: 'apply' payload, rather than silently downgrading it", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget(pangolinConnectionId);
    await insertProxyResource(domain.id, target.id);

    const job = await addJob(handle.pool, tasks.syncProxyResourceTask, {
      domainId: domain.id,
      mode: "apply",
    });

    const failed = await waitFor(
      async () => {
        const row = await handle.pool.query<{ last_error: string | null }>(
          `select last_error from graphile_worker.jobs
             where id = $1 and attempts >= 1 and locked_at is null`,
          [job.id],
        );
        return row.rows[0];
      },
      { timeoutMs: 30_000, label: `job ${job.id} to fail at least once` },
    );
    expect(failed?.last_error ?? "").toMatch(/check-mode only/);
  });
});

describe("HostingTargetsService, for context", () => {
  it("still reports the (now-driven) proxy_connection_id", async () => {
    const target = await insertHostingTarget(pangolinConnectionId);
    const row = await createHostingTargetsService({ db: handle.db }).get(target.id);
    expect(row.proxyConnectionId).toBe(pangolinConnectionId);
  });
});
