/**
 * `ip-alias-detection.ts` — the dynamic-IP alias detection sweep (Pangolin
 * chain design milestone 5, `loxep-acj.5`). Traces:
 *
 * ```text
 * runIpAliasDetectionSweep
 *   -> per non-manual alias: a detector (dns / pangolin_site)
 *   -> on a genuine change: infrastructure.ip_aliases updated, unconditionally
 *   -> proxyResources.listRulesReferencingAlias -> every dynamic_ip rule,
 *      across every domain and hosting target
 *   -> proxyResources.reconcile(trigger:'poll'), mode 'apply' only when the
 *      alias's own autoApply flag AND the connection's write-policy tier
 *      both permit it — never a retire, only the ADD half
 *   -> ONE notification event, dedup-keyed on the change itself
 * ```
 *
 * Only the provider boundary (`getPangolinAdapterForConnection`) and the DNS
 * resolver are stubbed — everything else (settings, connections, the proxy
 * reconciler, the notification ledger) is real, matching
 * `infrastructure-proxy.test.ts`'s own "only the touched surface" discipline.
 *
 * This file deliberately does NOT build a full `WorkerComposition`
 * (`buildWorkerRegistry`) — `registry.test.ts` already proves
 * `IP_ALIAS_DETECTION_TASK_NAME` is registered in the composed registry with
 * a cron item, so duplicating that heavy whole-app composition here would
 * only add load to the suite for no new coverage; `createIpAliasDetectionTasks`
 * alone is enough to prove this module's OWN task/cron shape.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import {
  createRecordingNotificationEnqueue,
  ipAliasesSetting,
  providerWritePolicySetting,
} from "@loxep/domain";
import type { IpAliasMap } from "@loxep/domain";
import {
  IP_ALIAS_DETECTION_TASK_NAME,
  createIpAliasDetectionTasks,
  extractAddressFromPangolinEndpoint,
  runIpAliasDetectionSweep,
} from "../src/ip-alias-detection.ts";
import { buildAppServices } from "../src/index.ts";
import type { AppServices } from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentJobsLogger, silentLogger, testConfig } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_ip_alias_detection");
let handle: DbHandle;
let services: AppServices;
let dnsConnectionId = "";
let pangolinConnectionId = "";

/** A stateful fake Pangolin adapter: `createRule` actually appends, so `listRules` reflects prior applies within the same test. */
function createStatefulPangolinAdapter(input: { resourceId: number; fullDomain: string; endpoint?: string | null }) {
  const rules: Array<{ ruleId: number; action: string; match: string; value: string; priority: number; enabled: boolean }> = [];
  let nextRuleId = 1;
  return {
    async listResources() {
      return [
        {
          resourceId: input.resourceId,
          niceId: "r1",
          name: "api",
          fullDomain: input.fullDomain,
          domainId: "d1",
          subdomain: "api",
          mode: "http",
          ssl: true,
          enabled: true,
          sso: null,
          blockAccess: false,
          applyRules: true,
          emailWhitelistEnabled: null,
        },
      ];
    },
    async listTargets() {
      return [];
    },
    async listRules(resourceId: string) {
      if (Number(resourceId) !== input.resourceId) return [];
      return rules.map((r) => ({ ...r }));
    },
    async createRule(resourceId: string, payload: { action: string; match: string; value: string; priority: number; enabled: boolean }) {
      if (Number(resourceId) !== input.resourceId) throw new Error("unexpected resourceId");
      const ruleId = nextRuleId++;
      rules.push({ ruleId, ...payload });
      return { ruleId };
    },
    async createResource(): Promise<never> {
      throw new Error("not exercised by this suite");
    },
    async addTarget(): Promise<never> {
      throw new Error("not exercised by this suite");
    },
    async getSite() {
      return input.endpoint === undefined
        ? null
        : { siteId: 1, niceId: "site1", orgId: "home-lab", name: "home", type: "newt", online: true, address: null, subnet: null, endpoint: input.endpoint, listenPort: null, status: "online" };
    },
    async listOrgs() {
      return [{ orgId: "home-lab", name: "Home Lab" }];
    },
    capabilities: () => ({
      provider: "pangolin" as const,
      bulkRuleSet: false,
      ruleAliases: false as const,
      ruleDisable: true,
      domainCreate: false,
      siteCreate: false,
      ruleMatches: ["CIDR"],
      ruleActions: ["ACCEPT"],
    }),
  };
}

let statefulAdapter: ReturnType<typeof createStatefulPangolinAdapter> | null = null;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  const real = buildAppServices({ config, logger: silentJobsLogger });
  services = {
    ...real,
    getPangolinAdapterForConnection: async (id) => {
      if (statefulAdapter === null) throw new Error("no stateful adapter configured for this test");
      return {
        connectionId: id,
        baseUrl: "https://pangolin.test",
        orgId: "home-lab",
        sourceAccountKey: "https://pangolin.test",
        adapter: statefulAdapter as never,
        minIntervalSeconds: 3600,
      };
    },
    invalidatePangolinAdapter: () => undefined,
  };

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "ip-alias-detection@example.invalid",
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
  await services?.close();
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
    `insert into managed_domains (name, dns_connection_id) values ($1, $2) returning id`,
    [name, dnsConnectionId],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("managed_domains insert returned no row");
  return { id, name };
}

async function insertHostingTarget(proxyConnectionId: string | null): Promise<{ id: string }> {
  const row = await handle.pool.query<{ id: string }>(
    `insert into hosting_targets (name, control_surface, proxy_connection_id)
     values ($1, 'direct_reverse_proxy', $2)
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

async function insertDynamicIpRule(proxyResourceId: string, aliasName: string): Promise<void> {
  await handle.pool.query(
    `insert into proxy_resource_rules (proxy_resource_id, action, match, value, priority, owner)
     values ($1, 'ACCEPT', 'CIDR', $2, 100, 'dynamic_ip')`,
    [proxyResourceId, `alias:${aliasName}`],
  );
}

function baseAliases(overrides: Partial<IpAliasMap[string]> = {}): IpAliasMap {
  return {
    home: {
      address: "203.0.113.4",
      source: "dns",
      hostname: "home.example.dyndns.test",
      connectionId: null,
      siteId: null,
      previousAddress: null,
      observedAt: null,
      confirmedAt: "2026-08-16T00:00:00.000Z",
      autoApply: false,
      ...overrides,
    },
  };
}

describe("runIpAliasDetectionSweep — the dns/manual/pangolin_site detectors", () => {
  it("skips a 'manual' alias entirely — no detector to run", async () => {
    await services.settings.set(
      ipAliasesSetting,
      { office: { address: "198.51.100.1", source: "manual", hostname: null, connectionId: null, siteId: null, previousAddress: null, observedAt: null, confirmedAt: null, autoApply: false } },
      {},
    );
    const outcomes = await runIpAliasDetectionSweep({
      services,
      dnsResolver: async () => {
        throw new Error("must never be called for a manual alias");
      },
    });
    expect(outcomes).toEqual([]);
  });

  it("is idempotent: the dns detector returning the SAME address as stored produces no write and no plan", async () => {
    await services.settings.set(ipAliasesSetting, baseAliases(), {});
    const outcomes = await runIpAliasDetectionSweep({
      services,
      dnsResolver: async () => ["203.0.113.4"],
    });
    expect(outcomes).toEqual([
      {
        aliasName: "home",
        changed: false,
        previousAddress: null,
        newAddress: "203.0.113.4",
        resourceCount: 0,
        ruleCount: 0,
        autoApplied: false,
        notified: false,
      },
    ]);
    const stored = await services.settings.get(ipAliasesSetting);
    expect(stored["home"]?.address).toBe("203.0.113.4");
    expect(stored["home"]?.previousAddress).toBeNull();
  });

  it("a dns resolver failure is treated as 'no detection this round', never a crash", async () => {
    await services.settings.set(ipAliasesSetting, baseAliases(), {});
    const outcomes = await runIpAliasDetectionSweep({
      services,
      dnsResolver: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(outcomes[0]?.changed).toBe(false);
  });

  it("extractAddressFromPangolinEndpoint parses a bare IPv4 and an 'ip:port' pair; refuses anything else", () => {
    expect(extractAddressFromPangolinEndpoint("203.0.113.9")).toBe("203.0.113.9");
    expect(extractAddressFromPangolinEndpoint("203.0.113.9:51820")).toBe("203.0.113.9");
    expect(extractAddressFromPangolinEndpoint("home.example.com")).toBeNull();
    expect(extractAddressFromPangolinEndpoint("::1")).toBeNull();
  });

  it("pangolin_site detector: a malformed/absent endpoint is 'no detection', never an error", async () => {
    statefulAdapter = createStatefulPangolinAdapter({ resourceId: 1, fullDomain: "unused.test", endpoint: null });
    await services.settings.set(
      ipAliasesSetting,
      {
        site: {
          address: "203.0.113.5",
          source: "pangolin_site",
          hostname: null,
          connectionId: pangolinConnectionId,
          siteId: "1",
          previousAddress: null,
          observedAt: null,
          confirmedAt: "2026-08-16T00:00:00.000Z",
          autoApply: false,
        },
      },
      {},
    );
    const outcomes = await runIpAliasDetectionSweep({ services });
    expect(outcomes[0]?.changed).toBe(false);
  });
});

describe("runIpAliasDetectionSweep — the fan-out, notification, and auto-apply gate", () => {
  it("a genuine change updates the alias (address/previousAddress/observedAt), runs a CHECK against every referencing rule, and notifies ONCE — autoApply stays off by default", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget(pangolinConnectionId);
    const resource = await insertProxyResource(domain.id, target.id);
    await insertDynamicIpRule(resource.id, "home");

    statefulAdapter = createStatefulPangolinAdapter({ resourceId: 501, fullDomain: `api.${domain.name}` });
    await services.settings.set(ipAliasesSetting, baseAliases(), {});

    const enqueue = createRecordingNotificationEnqueue();
    const outcomes = await runIpAliasDetectionSweep({
      services,
      dnsResolver: async () => ["203.0.113.7"],
      enqueue,
      now: new Date("2026-08-16T12:00:00.000Z"),
    });

    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    expect(outcome?.changed).toBe(true);
    expect(outcome?.previousAddress).toBe("203.0.113.4");
    expect(outcome?.newAddress).toBe("203.0.113.7");
    expect(outcome?.resourceCount).toBe(1);
    expect(outcome?.ruleCount).toBe(1);
    // autoApply defaults false — the mode-'check' path still ran (proving
    // the fan-out itself worked) but applied nothing.
    expect(outcome?.autoApplied).toBe(false);
    expect(outcome?.notified).toBe(true);

    const stored = await services.settings.get(ipAliasesSetting);
    expect(stored["home"]).toMatchObject({
      address: "203.0.113.7",
      previousAddress: "203.0.113.4",
      observedAt: "2026-08-16T12:00:00.000Z",
    });

    expect(enqueue.calls).toHaveLength(0); // no notification_rules configured to route to — recorded, not delivered
  });

  it("autoApply true + the connection's write-policy at 'additive' -> the ADD rule is actually created at the provider", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget(pangolinConnectionId);
    const resource = await insertProxyResource(domain.id, target.id);
    await insertDynamicIpRule(resource.id, "home");

    statefulAdapter = createStatefulPangolinAdapter({ resourceId: 502, fullDomain: `api.${domain.name}` });
    await services.settings.set(ipAliasesSetting, baseAliases({ autoApply: true }), {});
    await services.settings.set(providerWritePolicySetting, { [pangolinConnectionId]: "additive" }, {});

    const outcomes = await runIpAliasDetectionSweep({
      services,
      dnsResolver: async () => ["203.0.113.8"],
    });

    expect(outcomes[0]?.autoApplied).toBe(true);

    const rulesAtProvider = await statefulAdapter.listRules("502");
    expect(rulesAtProvider).toHaveLength(1);
    expect(rulesAtProvider[0]).toMatchObject({ value: "203.0.113.8/32", enabled: true });
  });

  it("autoApply true but the connection is still read_only (the default) -> nothing applies, the auto-apply gate is REAL policy, not a suggestion", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget(pangolinConnectionId);
    const resource = await insertProxyResource(domain.id, target.id);
    await insertDynamicIpRule(resource.id, "home");

    statefulAdapter = createStatefulPangolinAdapter({ resourceId: 503, fullDomain: `api.${domain.name}` });
    // No write-policy flip this time — stays read_only.
    await services.settings.set(providerWritePolicySetting, {}, {});
    await services.settings.set(ipAliasesSetting, baseAliases({ autoApply: true }), {});

    const outcomes = await runIpAliasDetectionSweep({
      services,
      dnsResolver: async () => ["203.0.113.9"],
    });

    expect(outcomes[0]?.autoApplied).toBe(false);
    const rulesAtProvider = await statefulAdapter.listRules("503");
    expect(rulesAtProvider).toHaveLength(0);
  });
});

describe("task/cron shape (registration in the composed registry is registry.test.ts's job)", () => {
  it("createIpAliasDetectionTasks names the task infrastructure.detect-ip-aliases and gives it a matching cron item", () => {
    const tasks = createIpAliasDetectionTasks({ services });
    expect(tasks.ipAliasDetectionTask.name).toBe(IP_ALIAS_DETECTION_TASK_NAME);
    expect(tasks.ipAliasDetectionCronItem.task).toBe(IP_ALIAS_DETECTION_TASK_NAME);
  });
});
