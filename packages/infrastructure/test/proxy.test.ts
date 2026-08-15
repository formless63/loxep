/**
 * `proxy.ts` against real PostgreSQL: `reconcile` (the whole read -> diff ->
 * record flow, including the self-retiring identity write-back), the
 * `reconcileDomain` fan-out, and the CHECK-MODE-ONLY refusal that is this
 * milestone's headline constraint.
 *
 * `apply()` is never called anywhere in this suite — there is no code path in
 * `proxy.ts` that calls it. Every test drives a stub `ProxyProviderPort`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  ProviderCallError,
  ProxyWritePolicyError,
  createProxyResourcesService,
} from "../src/index.ts";
import type {
  ObservedProxyResource,
  ProxyOperation,
  ProxyProviderPort,
  ProxyResourcesService,
} from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentLogger } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_proxy");
let handle: DbHandle;
let dnsConnectionId = "";
let pangolinConnectionId = "";

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  const dns = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('cloudflare', 'dns', 'Cloudflare (test)', 'active', '{}')
     returning id`,
  );
  dnsConnectionId = dns.rows[0]?.id ?? "";

  const pangolin = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('pangolin', 'proxy', 'Pangolin (test)', 'active', '{"pangolin":{"orgId":"home-lab"}}')
     returning id`,
  );
  pangolinConnectionId = pangolin.rows[0]?.id ?? "";
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

async function insertDomain(): Promise<{ id: string; name: string }> {
  const name = `${nextName("example")}.test`;
  const row = await handle.pool.query<{ id: string }>(
    `insert into managed_domains (name, dns_connection_id)
     values ($1, $2)
     returning id`,
    [name, dnsConnectionId],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("managed_domains insert returned no row");
  return { id, name };
}

async function insertHostingTarget(
  options: { proxyConnectionId?: string | null } = {},
): Promise<{ id: string }> {
  const row = await handle.pool.query<{ id: string }>(
    `insert into hosting_targets (name, control_surface, address_v4, proxy_connection_id)
     values ($1, 'direct_reverse_proxy', '203.0.113.5', $2)
     returning id`,
    [nextName("target"), options.proxyConnectionId ?? null],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("hosting_targets insert returned no row");
  return { id };
}

async function insertProxyResource(input: {
  domainId: string;
  hostingTargetId: string;
  subdomain?: string | null;
  externalResourceId?: string | null;
}): Promise<{ id: string }> {
  const row = await handle.pool.query<{ id: string }>(
    `insert into proxy_resources (domain_id, hosting_target_id, subdomain, external_resource_id)
     values ($1, $2, $3, $4)
     returning id`,
    [input.domainId, input.hostingTargetId, input.subdomain ?? "api", input.externalResourceId ?? null],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("proxy_resources insert returned no row");
  return { id };
}

async function insertRule(input: {
  proxyResourceId: string;
  owner?: "template" | "manual" | "dynamic_ip";
  value?: string;
  priority?: number;
}): Promise<void> {
  await handle.pool.query(
    `insert into proxy_resource_rules (proxy_resource_id, action, match, value, priority, owner)
     values ($1, 'ACCEPT', 'CIDR', $2, $3, $4)`,
    [
      input.proxyResourceId,
      input.value ?? "203.0.113.7/32",
      input.priority ?? 100,
      input.owner ?? "template",
    ],
  );
}

async function readProxyResource(
  id: string,
): Promise<{ externalResourceId: string | null }> {
  const result = await handle.pool.query<{ external_resource_id: string | null }>(
    `select external_resource_id from proxy_resources where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("proxy_resources row not found");
  return { externalResourceId: row.external_resource_id };
}

class StubProxyProviderError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

function createStubProvider(options: {
  observed?: ObservedProxyResource[];
  failReadOnce?: { kind: string; message: string };
} = {}): ProxyProviderPort & { readCallCount: number; applyCallCount: number } {
  let readCallCount = 0;
  let applyCallCount = 0;
  let failReadOnce = options.failReadOnce;
  return {
    get readCallCount() {
      return readCallCount;
    },
    get applyCallCount() {
      return applyCallCount;
    },
    async read() {
      readCallCount += 1;
      if (failReadOnce !== undefined) {
        const failure = failReadOnce;
        failReadOnce = undefined;
        throw new StubProxyProviderError(failure.kind, failure.message);
      }
      return options.observed ?? [];
    },
    async apply(operation: ProxyOperation) {
      applyCallCount += 1;
      return { kind: operation.kind, status: "applied" as const };
    },
    capabilities() {
      return {
        provider: "pangolin",
        bulkRuleSet: false,
        ruleAliases: false,
        ruleDisable: true,
        domainCreate: false,
        siteCreate: false,
        ruleMatches: ["CIDR", "IP"],
        ruleActions: ["ACCEPT", "DROP", "PASS"],
      };
    },
  };
}

function observedResource(
  overrides: Partial<ObservedProxyResource> = {},
): ObservedProxyResource {
  return {
    externalResourceId: "42",
    niceId: "brave-otter",
    name: "api",
    fullDomain: null,
    domainId: "7",
    subdomain: "api",
    mode: "http",
    proxyPort: null,
    ssl: true,
    enabled: true,
    ssoEnabled: null,
    blockAccess: false,
    applyRules: true,
    emailWhitelistEnabled: null,
    targets: [],
    rules: [],
    ...overrides,
  };
}

describe("check-mode-only refusal", () => {
  let service: ProxyResourcesService;
  beforeAll(() => {
    service = createProxyResourcesService({ db: handle.db });
  });

  it("reconcile() refuses mode: 'apply' before any provider call", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    const provider = createStubProvider();

    await expect(
      service.reconcile(resource.id, {
        mode: "apply",
        trigger: "manual",
        provider,
        orgId: "home-lab",
      }),
    ).rejects.toThrow(ProxyWritePolicyError);
    expect(provider.readCallCount).toBe(0);
    expect(provider.applyCallCount).toBe(0);
  });

  it("reconcileDomain() refuses mode: 'apply' before resolving any provider", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    await insertProxyResource({ domainId: domain.id, hostingTargetId: target.id });
    let resolveCalls = 0;

    await expect(
      service.reconcileDomain(domain.id, {
        mode: "apply",
        trigger: "manual",
        resolveProvider: async () => {
          resolveCalls += 1;
          return null;
        },
      }),
    ).rejects.toThrow(ProxyWritePolicyError);
    expect(resolveCalls).toBe(0);
  });

  it("never has a code path that reaches provider.apply()", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    const provider = createStubProvider({
      observed: [observedResource({ fullDomain: `api.${domain.name}` })],
    });

    const result = await service.reconcile(resource.id, {
      mode: "check",
      trigger: "manual",
      provider,
      orgId: "home-lab",
    });
    expect(result.status).toBe("succeeded");
    expect(provider.applyCallCount).toBe(0);
  });
});

describe("reconcile()", () => {
  let service: ProxyResourcesService;
  beforeAll(() => {
    service = createProxyResourcesService({ db: handle.db });
  });

  it("records a reconcile_runs row with subject_type='proxy_resource'", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    const provider = createStubProvider({ observed: [] });

    const result = await service.reconcile(resource.id, {
      mode: "check",
      trigger: "manual",
      provider,
      orgId: "home-lab",
    });
    expect(result.runId).not.toBeNull();

    const run = await handle.pool.query<{ subject_type: string; subject_id: string; mode: string }>(
      `select subject_type, subject_id, mode from reconcile_runs where id = $1`,
      [result.runId],
    );
    expect(run.rows[0]?.subject_type).toBe("proxy_resource");
    expect(run.rows[0]?.subject_id).toBe(resource.id);
    expect(run.rows[0]?.mode).toBe("check");
  });

  it("self-retires the external resource id the first time a check matches by fullDomain", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
      externalResourceId: null,
    });
    const provider = createStubProvider({
      observed: [observedResource({ externalResourceId: "77", fullDomain: `api.${domain.name}` })],
    });

    expect((await readProxyResource(resource.id)).externalResourceId).toBeNull();
    await service.reconcile(resource.id, {
      mode: "check",
      trigger: "manual",
      provider,
      orgId: "home-lab",
    });
    expect((await readProxyResource(resource.id)).externalResourceId).toBe("77");
  });

  it("surfaces unmatchedObserved without creating any operation for it", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    const provider = createStubProvider({
      observed: [
        observedResource({ externalResourceId: "77", fullDomain: `api.${domain.name}` }),
        observedResource({ externalResourceId: "88", fullDomain: "unrelated.example.net" }),
      ],
    });

    const result = await service.reconcile(resource.id, {
      mode: "check",
      trigger: "manual",
      provider,
      orgId: "home-lab",
    });
    expect(result.unmatchedObservedCount).toBe(1);
  });

  it("never creates or updates a manual-owned rule", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    await insertRule({ proxyResourceId: resource.id, owner: "manual" });
    const provider = createStubProvider({
      observed: [observedResource({ fullDomain: `api.${domain.name}`, rules: [] })],
    });

    const result = await service.reconcile(resource.id, {
      mode: "check",
      trigger: "manual",
      provider,
      orgId: "home-lab",
    });
    expect(result.operationCount).toBe(0);
  });

  it("wraps a provider read failure in ProviderCallError and records a failed run", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    const provider = createStubProvider({
      failReadOnce: { kind: "provider_unavailable", message: "boom" },
    });

    await expect(
      service.reconcile(resource.id, {
        mode: "check",
        trigger: "manual",
        provider,
        orgId: "home-lab",
      }),
    ).rejects.toThrow(ProviderCallError);

    const runs = await service.listRuns(resource.id);
    expect(runs.some((run) => run.status === "failed")).toBe(true);
  });
});

describe("reconcileDomain()", () => {
  let service: ProxyResourcesService;
  beforeAll(() => {
    service = createProxyResourcesService({ db: handle.db });
  });

  it("fans out to one reconcile() call per proxy_resources row, resolving each provider independently", async () => {
    const domain = await insertDomain();
    const targetA = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const targetB = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resourceA = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: targetA.id,
      subdomain: "api",
    });
    const resourceB = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: targetB.id,
      subdomain: "app",
    });

    const resolvedFor: string[] = [];
    const results = await service.reconcileDomain(domain.id, {
      mode: "check",
      trigger: "manual",
      resolveProvider: async (hostingTargetId) => {
        resolvedFor.push(hostingTargetId);
        return { provider: createStubProvider({ observed: [] }), orgId: "home-lab" };
      },
    });

    expect(resolvedFor.sort()).toEqual([targetA.id, targetB.id].sort());
    expect(results.map((r) => r.proxyResourceId).sort()).toEqual(
      [resourceA.id, resourceB.id].sort(),
    );
    expect(results.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("records a resource as skipped, not failed, when its hosting target has no linked connection", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: null });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });

    const results = await service.reconcileDomain(domain.id, {
      mode: "check",
      trigger: "manual",
      resolveProvider: async () => null,
    });

    expect(results).toEqual([
      {
        proxyResourceId: resource.id,
        runId: null,
        status: "skipped",
        mode: "check",
        operationCount: 0,
        unmatchedObservedCount: 0,
      },
    ]);
  });

  it("returns an empty result set for a domain with no declared proxy resources", async () => {
    const domain = await insertDomain();
    const results = await service.reconcileDomain(domain.id, {
      mode: "check",
      trigger: "manual",
      resolveProvider: async () => null,
    });
    expect(results).toEqual([]);
  });
});

describe("listResourcesForHostingTarget()", () => {
  let service: ProxyResourcesService;
  beforeAll(() => {
    service = createProxyResourcesService({ db: handle.db });
  });

  it("lists every declared resource fronted by one hosting target, with its rules", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    await insertRule({ proxyResourceId: resource.id, owner: "template" });

    const results = await service.listResourcesForHostingTarget(target.id);
    expect(results).toHaveLength(1);
    expect(results[0]?.resource.id).toBe(resource.id);
    expect(results[0]?.rules).toHaveLength(1);
  });

  it("returns an empty list for a hosting target with no declared resources", async () => {
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const results = await service.listResourcesForHostingTarget(target.id);
    expect(results).toEqual([]);
  });
});
