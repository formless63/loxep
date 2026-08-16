/**
 * `proxy.ts`'s M7 (`loxep-acj.7`) retirement orchestration:
 * `retireRule`/`enableRule` (the tier-2 disable/re-enable pair on ONE
 * `proxy_resource_rules` row) and `retireAliasFanOutRule` (the M5
 * add-then-retire fan-out's retire half, completed for real). Against real
 * PostgreSQL, matching `proxy.test.ts`'s own harness shape — a separate file
 * per this milestone's own "keep proxy.ts edits additive" constraint, so this
 * milestone's tests never touch the sibling M6 session's own working set of
 * `proxy.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import type { IpAliasMap } from "@loxep/domain";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  ProxyWritePolicyError,
  createProxyResourcesService,
} from "../src/index.ts";
import type {
  ObservedProxyResource,
  ProxyOperation,
  ProxyProviderPort,
  ProxyResourcesService,
  ProxyWriteAuthorizationContext,
} from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentLogger } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_proxy_retire");
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

async function insertHostingTarget(): Promise<{ id: string }> {
  const row = await handle.pool.query<{ id: string }>(
    `insert into hosting_targets (name, control_surface, proxy_connection_id)
     values ($1, 'direct_reverse_proxy', $2)
     returning id`,
    [nextName("target"), pangolinConnectionId],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("hosting_targets insert returned no row");
  return { id };
}

async function insertProxyResource(input: {
  domainId: string;
  hostingTargetId: string;
  subdomain?: string | null;
}): Promise<{ id: string }> {
  const row = await handle.pool.query<{ id: string }>(
    `insert into proxy_resources (domain_id, hosting_target_id, subdomain)
     values ($1, $2, $3)
     returning id`,
    [input.domainId, input.hostingTargetId, input.subdomain ?? "api"],
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
  enabled?: boolean;
  externalRuleId?: string | null;
}): Promise<{ id: string }> {
  const row = await handle.pool.query<{ id: string }>(
    `insert into proxy_resource_rules (proxy_resource_id, action, match, value, priority, owner, enabled, external_rule_id)
     values ($1, 'ACCEPT', 'CIDR', $2, $3, $4, $5, $6)
     returning id`,
    [
      input.proxyResourceId,
      input.value ?? "203.0.113.7/32",
      input.priority ?? 100,
      input.owner ?? "template",
      input.enabled ?? true,
      input.externalRuleId ?? null,
    ],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error("proxy_resource_rules insert returned no row");
  return { id };
}

async function readRuleRow(
  id: string,
): Promise<{ enabled: boolean; externalRuleId: string | null }> {
  const result = await handle.pool.query<{ enabled: boolean; external_rule_id: string | null }>(
    `select enabled, external_rule_id from proxy_resource_rules where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("proxy_resource_rules row not found");
  return { enabled: row.enabled, externalRuleId: row.external_rule_id };
}

async function readSteps(
  runId: string | null,
): Promise<Array<{ step: string; status: string; error_code: string | null; error_detail: string | null }>> {
  if (runId === null) return [];
  const result = await handle.pool.query<{
    step: string;
    status: string;
    error_code: string | null;
    error_detail: string | null;
  }>(
    `select step, status, error_code, error_detail from reconcile_run_steps where run_id = $1 order by sequence`,
    [runId],
  );
  return result.rows;
}

async function countProviderOperations(): Promise<number> {
  const result = await handle.pool.query<{ count: string }>(
    `select count(*)::text as count from provider_operations where provider = 'pangolin'`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

function accessAffectingPolicy(
  connectionId: string,
  overrides: Partial<ProxyWriteAuthorizationContext> = {},
): ProxyWriteAuthorizationContext {
  return { connectionId, policyTier: "access_affecting", actorIsAdmin: true, ...overrides };
}

function observedResource(overrides: Partial<ObservedProxyResource> = {}): ObservedProxyResource {
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

/** A directly-driven fake — full control over `observed`/`apply`, matching `proxy.test.ts`'s own "add-then-retire in practice" test's style. */
function createFakeProvider(
  observed: ObservedProxyResource[],
  options: { failApply?: boolean } = {},
): ProxyProviderPort & { operations: ProxyOperation[] } {
  const operations: ProxyOperation[] = [];
  return {
    operations,
    async read() {
      return observed;
    },
    async apply(operation: ProxyOperation) {
      operations.push(operation);
      if (options.failApply === true) {
        const error = new Error("provider unavailable") as Error & { kind: string };
        error.kind = "provider_unavailable";
        throw error;
      }
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

async function makeResource(): Promise<{ domainId: string; domainName: string; resourceId: string }> {
  const domain = await insertDomain();
  const target = await insertHostingTarget();
  const resource = await insertProxyResource({ domainId: domain.id, hostingTargetId: target.id });
  return { domainId: domain.id, domainName: domain.name, resourceId: resource.id };
}

describe("retireRule — the ordinary superseded-rule case (loxep-acj.7)", () => {
  let service: ProxyResourcesService;
  beforeAll(() => {
    service = createProxyResourcesService({ db: handle.db });
  });

  it("disables the rule at the provider, sets enabled:false and persists externalRuleId on the intent row, records no provider_operations row (convergent, never ledgered)", async () => {
    const { domainName, resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId });
    const before = await countProviderOperations();

    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        // ssoEnabled: true gives the operator a non-address way in, so the
        // self-lockout preflight's no_operator_access clause does not fire
        // just because this is the only address-granting rule — that clause
        // gets its own dedicated test below.
        ssoEnabled: true,
        rules: [
          { externalRuleId: "900", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: true },
        ],
      }),
    ]);

    const result = await service.retireRule(rule.id, {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("succeeded");
    expect(result.alreadyDisabled).toBe(false);
    expect(provider.operations).toHaveLength(1);
    expect(provider.operations[0]).toMatchObject({
      kind: "update-rule",
      externalRuleId: "900",
      rule: { enabled: false, action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100 },
    });

    const row = await readRuleRow(rule.id);
    expect(row.enabled).toBe(false);
    expect(row.externalRuleId).toBe("900");

    // Ledger convergent-update semantics: an `update-rule` retire never
    // writes a `provider_operations` row — see proxy.ts's own module doc.
    expect(await countProviderOperations()).toBe(before);
  });

  it("refuses a 'manual'-owned rule outright — never rewrites a human's record, no run row created", async () => {
    const { resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId, owner: "manual" });
    const provider = createFakeProvider([]);

    await expect(
      service.retireRule(rule.id, {
        trigger: "manual",
        provider,
        orgId: "home-lab",
        writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
      }),
    ).rejects.toThrow(InfrastructureValidationError);
    expect(provider.operations).toHaveLength(0);
  });

  it("refuses when the connection's write policy is below access_affecting — recorded 'blocked', run 'partial', never reaches provider.apply()", async () => {
    const { domainName, resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId });
    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          { externalRuleId: "901", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: true },
        ],
      }),
    ]);

    const result = await service.retireRule(rule.id, {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: { connectionId: pangolinConnectionId, policyTier: "additive", actorIsAdmin: true },
    });

    expect(result.status).toBe("blocked");
    expect(provider.operations).toHaveLength(0);
    const steps = await readSteps(result.runId);
    expect(steps.find((s) => s.step === "retire.blocked")?.error_code).toBe("write_policy");

    const row = await readRuleRow(rule.id);
    expect(row.enabled).toBe(true);
  });

  it("refuses a non-admin actor — writes are admin-only, regardless of policy tier", async () => {
    const { domainName, resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId });
    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          { externalRuleId: "902", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: true },
        ],
      }),
    ]);

    const result = await service.retireRule(rule.id, {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId, { actorIsAdmin: false }),
    });

    expect(result.status).toBe("blocked");
    expect(provider.operations).toHaveLength(0);
  });

  it("a 'sweep' trigger can never retire a rule — refused at the type/runtime boundary before any database write", async () => {
    const { resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId });
    const provider = createFakeProvider([]);

    await expect(
      service.retireRule(rule.id, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the narrower type to prove the runtime guard, not just the compiler
        trigger: "sweep" as any,
        provider,
        orgId: "home-lab",
        writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
      }),
    ).rejects.toThrow(ProxyWritePolicyError);
    expect(provider.operations).toHaveLength(0);

    const row = await readRuleRow(rule.id);
    expect(row.enabled).toBe(true);
  });

  it("a 'poll' trigger can never retire a rule either — the same rule 3 refusal, structurally, not just for 'sweep'", async () => {
    const { resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId });
    const provider = createFakeProvider([]);

    await expect(
      service.retireRule(rule.id, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        trigger: "poll" as any,
        provider,
        orgId: "home-lab",
        writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
      }),
    ).rejects.toThrow(ProxyWritePolicyError);
  });

  it("convergent semantics: retiring a rule the provider already shows disabled is a safe no-op — no provider.apply() call, no ledger row, run 'succeeded'", async () => {
    const { domainName, resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId });
    const before = await countProviderOperations();
    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          { externalRuleId: "903", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: false },
        ],
      }),
    ]);

    const result = await service.retireRule(rule.id, {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("succeeded");
    expect(result.alreadyDisabled).toBe(true);
    expect(provider.operations).toHaveLength(0);
    expect(await countProviderOperations()).toBe(before);

    const row = await readRuleRow(rule.id);
    expect(row.enabled).toBe(false);
    expect(row.externalRuleId).toBe("903");
  });

  it("refuses a rule the provider does not have — nothing to retire", async () => {
    const { domainName, resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId });
    const provider = createFakeProvider([observedResource({ fullDomain: `api.${domainName}`, rules: [] })]);

    await expect(
      service.retireRule(rule.id, {
        trigger: "manual",
        provider,
        orgId: "home-lab",
        writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
      }),
    ).rejects.toThrow(InfrastructureNotFoundError);
  });

  it("the self-lockout preflight refuses retiring the operator's only address-granting rule (no_operator_access)", async () => {
    const { domainName, resourceId } = await makeResource();
    // The ONLY enabled ACCEPT/CIDR rule on this resource — retiring it would
    // leave the resulting set with nothing granting the operator's address.
    const rule = await insertRule({ proxyResourceId: resourceId, value: "198.51.100.9/32" });
    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          { externalRuleId: "904", action: "ACCEPT", match: "CIDR", value: "198.51.100.9/32", priority: 100, enabled: true },
        ],
      }),
    ]);

    // No registered alias holds this address, and the resource has no SSO —
    // resolveLockoutOperatorContext's operatorContext is therefore empty.
    const result = await service.retireRule(rule.id, {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("blocked");
    expect(provider.operations).toHaveLength(0);
    const steps = await readSteps(result.runId);
    expect(steps.find((s) => s.step === "retire.blocked")?.error_code).toBe("no_operator_access");
  });

  it("the self-lockout preflight refuses retiring the last LIVE rule referencing a dynamic-IP alias — even when another rule still grants the operator access", async () => {
    const aliases: IpAliasMap = {
      home: {
        address: "203.0.113.7",
        source: "manual",
        hostname: null,
        connectionId: null,
        siteId: null,
        previousAddress: null,
        observedAt: null,
        confirmedAt: "2026-08-16T00:00:00.000Z",
        autoApply: false,
      },
      // Registering this alias is what gives the operator a currentAddress
      // matching the SECOND rule below — see resolveLockoutOperatorContext's
      // own doc for why every registered alias counts as an address the
      // operator holds.
      office: {
        address: "198.51.100.9",
        source: "manual",
        hostname: null,
        connectionId: null,
        siteId: null,
        previousAddress: null,
        observedAt: null,
        confirmedAt: "2026-08-16T00:00:00.000Z",
        autoApply: false,
      },
    };
    const service2 = createProxyResourcesService({
      db: handle.db,
      settings: { get: async () => aliases as never },
    });
    const { domainName, resourceId } = await makeResource();
    const aliasRule = await insertRule({
      proxyResourceId: resourceId,
      owner: "dynamic_ip",
      value: "alias:home",
      priority: 100,
    });
    await insertRule({ proxyResourceId: resourceId, value: "198.51.100.9/32", priority: 110 });

    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          { externalRuleId: "905", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: true },
          { externalRuleId: "906", action: "ACCEPT", match: "CIDR", value: "198.51.100.9/32", priority: 110, enabled: true },
        ],
      }),
    ]);

    const result = await service2.retireRule(aliasRule.id, {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("blocked");
    expect(provider.operations).toHaveLength(0);
    const steps = await readSteps(result.runId);
    expect(steps.find((s) => s.step === "retire.blocked")?.error_code).toBe(
      "retires_only_live_alias_rule",
    );
  });
});

describe("enableRule — the re-enable round trip (loxep-acj.7)", () => {
  let service: ProxyResourcesService;
  beforeAll(() => {
    service = createProxyResourcesService({ db: handle.db });
  });

  it("retire then re-enable round-trips the intent row and issues a second provider update", async () => {
    const { domainName, resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId });

    const disableProvider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        ssoEnabled: true,
        rules: [
          { externalRuleId: "950", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: true },
        ],
      }),
    ]);
    const retireResult = await service.retireRule(rule.id, {
      trigger: "manual",
      provider: disableProvider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });
    expect(retireResult.status).toBe("succeeded");
    expect((await readRuleRow(rule.id)).enabled).toBe(false);

    const enableProvider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        ssoEnabled: true,
        rules: [
          { externalRuleId: "950", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: false },
        ],
      }),
    ]);
    const enableResult = await service.enableRule(rule.id, {
      trigger: "manual",
      provider: enableProvider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });

    expect(enableResult.status).toBe("succeeded");
    expect(enableResult.alreadyEnabled).toBe(false);
    expect(enableProvider.operations).toHaveLength(1);
    expect(enableProvider.operations[0]).toMatchObject({ kind: "update-rule", rule: { enabled: true } });

    const row = await readRuleRow(rule.id);
    expect(row.enabled).toBe(true);
    expect(row.externalRuleId).toBe("950");
  });

  it("convergent semantics: re-enabling an already-enabled provider rule is a safe no-op", async () => {
    const { domainName, resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId, enabled: false });
    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          { externalRuleId: "951", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: true },
        ],
      }),
    ]);

    const result = await service.enableRule(rule.id, {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("succeeded");
    expect(result.alreadyEnabled).toBe(true);
    expect(provider.operations).toHaveLength(0);
    expect((await readRuleRow(rule.id)).enabled).toBe(true);
  });

  it("refuses a 'sweep'-triggered re-enable at the runtime boundary", async () => {
    const { resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId, enabled: false });
    const provider = createFakeProvider([]);

    await expect(
      service.enableRule(rule.id, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        trigger: "sweep" as any,
        provider,
        orgId: "home-lab",
        writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
      }),
    ).rejects.toThrow(ProxyWritePolicyError);
  });
});

describe("drift-aware: a rule Loxep disabled that reality re-enabled (loxep-acj.7)", () => {
  it("reconcile()'s diff step counts a desired-disabled rule the provider still shows enabled, and emits a dedicated 'diff.retired-rule-reenabled' step", async () => {
    const service = createProxyResourcesService({ db: handle.db });
    const { domainName, resourceId } = await makeResource();
    const rule = await insertRule({ proxyResourceId: resourceId, enabled: false, externalRuleId: "960" });

    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          // Loxep's own intent says disabled; the provider still reports it
          // enabled — "reality re-enabled it".
          { externalRuleId: "960", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: true },
        ],
      }),
    ]);

    const result = await service.reconcile(resourceId, {
      mode: "check",
      trigger: "manual",
      provider,
      orgId: "home-lab",
    });
    expect(result.status).toBe("succeeded");

    const steps = await readSteps(result.runId);
    const diffStep = steps.find((s) => s.step === "diff");
    expect(diffStep).toBeDefined();
    const finding = steps.find((s) => s.step === "diff.retired-rule-reenabled");
    expect(finding).toBeDefined();
    expect(finding?.status).toBe("succeeded");

    // Sanity: the row Loxep intends disabled really is, in the DB.
    expect((await readRuleRow(rule.id)).enabled).toBe(false);
  });

  it("reports zero when every desired-disabled rule is genuinely disabled at the provider too — never a false positive", async () => {
    const service = createProxyResourcesService({ db: handle.db });
    const { domainName, resourceId } = await makeResource();
    await insertRule({ proxyResourceId: resourceId, enabled: false, externalRuleId: "961" });

    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          { externalRuleId: "961", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: false },
        ],
      }),
    ]);

    const result = await service.reconcile(resourceId, {
      mode: "check",
      trigger: "manual",
      provider,
      orgId: "home-lab",
    });

    const steps = await readSteps(result.runId);
    expect(steps.find((s) => s.step === "diff.retired-rule-reenabled")).toBeUndefined();
  });
});

describe("retireAliasFanOutRule — completing the M5 add-then-retire fan-out for real (loxep-acj.7)", () => {
  it("disables the OLD (previous-address) rule at the provider while leaving the NEW rule (current alias reference) untouched", async () => {
    const aliases: IpAliasMap = {
      home: {
        address: "203.0.113.7",
        source: "manual",
        hostname: null,
        connectionId: null,
        siteId: null,
        previousAddress: "203.0.113.4",
        observedAt: "2026-08-16T00:00:00.000Z",
        confirmedAt: "2026-08-15T00:00:00.000Z",
        autoApply: false,
      },
    };
    const service = createProxyResourcesService({
      db: handle.db,
      settings: { get: async () => aliases as never },
    });
    const { domainName, resourceId } = await makeResource();
    // The SAME row represents the alias forever — its value never changes.
    await insertRule({ proxyResourceId: resourceId, owner: "dynamic_ip", value: "alias:home" });

    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          // The OLD rule — still live at the provider, add-then-retire's
          // "keep the old one" half from M5.
          { externalRuleId: "970", action: "ACCEPT", match: "CIDR", value: "203.0.113.4/32", priority: 100, enabled: true },
          // The NEW rule — already added by M5's ordinary create-rule path.
          { externalRuleId: "971", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: true },
        ],
      }),
    ]);

    const result = await service.retireAliasFanOutRule(resourceId, "home", {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("succeeded");
    expect(result.retiredCount).toBe(1);
    expect(result.blockedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(provider.operations).toHaveLength(1);
    expect(provider.operations[0]).toMatchObject({
      kind: "update-rule",
      externalRuleId: "970",
      rule: { value: "203.0.113.4/32", enabled: false },
    });

    // The intent row itself is untouched — it still represents 'alias:home'
    // going forward, per ip-aliases.ts's own "the row's OWN value column
    // never changes" rule.
    const rows = await handle.pool.query<{ value: string; enabled: boolean }>(
      `select value, enabled from proxy_resource_rules where proxy_resource_id = $1`,
      [resourceId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ value: "alias:home", enabled: true });
  });

  it("is a legitimate no-op ('skipped') when the alias has no previousAddress yet — nothing has ever changed", async () => {
    const aliases: IpAliasMap = {
      home: {
        address: "203.0.113.7",
        source: "manual",
        hostname: null,
        connectionId: null,
        siteId: null,
        previousAddress: null,
        observedAt: null,
        confirmedAt: "2026-08-16T00:00:00.000Z",
        autoApply: false,
      },
    };
    const service = createProxyResourcesService({
      db: handle.db,
      settings: { get: async () => aliases as never },
    });
    const { resourceId } = await makeResource();
    await insertRule({ proxyResourceId: resourceId, owner: "dynamic_ip", value: "alias:home" });
    const provider = createFakeProvider([]);

    const result = await service.retireAliasFanOutRule(resourceId, "home", {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("skipped");
    expect(result.runId).toBeNull();
    expect(provider.operations).toHaveLength(0);
  });

  it("is a legitimate no-op when the old rule is already gone/disabled at the provider — never an error", async () => {
    const aliases: IpAliasMap = {
      home: {
        address: "203.0.113.7",
        source: "manual",
        hostname: null,
        connectionId: null,
        siteId: null,
        previousAddress: "203.0.113.4",
        observedAt: "2026-08-16T00:00:00.000Z",
        confirmedAt: "2026-08-15T00:00:00.000Z",
        autoApply: false,
      },
    };
    const service = createProxyResourcesService({
      db: handle.db,
      settings: { get: async () => aliases as never },
    });
    const { domainName, resourceId } = await makeResource();
    await insertRule({ proxyResourceId: resourceId, owner: "dynamic_ip", value: "alias:home" });

    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          { externalRuleId: "972", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100, enabled: true },
        ],
      }),
    ]);

    const result = await service.retireAliasFanOutRule(resourceId, "home", {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("skipped");
    expect(result.retiredCount).toBe(0);
    expect(provider.operations).toHaveLength(0);
  });

  it("refuses when the connection's write policy is below access_affecting", async () => {
    const aliases: IpAliasMap = {
      home: {
        address: "203.0.113.7",
        source: "manual",
        hostname: null,
        connectionId: null,
        siteId: null,
        previousAddress: "203.0.113.4",
        observedAt: "2026-08-16T00:00:00.000Z",
        confirmedAt: "2026-08-15T00:00:00.000Z",
        autoApply: false,
      },
    };
    const service = createProxyResourcesService({
      db: handle.db,
      settings: { get: async () => aliases as never },
    });
    const { domainName, resourceId } = await makeResource();
    await insertRule({ proxyResourceId: resourceId, owner: "dynamic_ip", value: "alias:home" });

    const provider = createFakeProvider([
      observedResource({
        fullDomain: `api.${domainName}`,
        rules: [
          { externalRuleId: "973", action: "ACCEPT", match: "CIDR", value: "203.0.113.4/32", priority: 100, enabled: true },
        ],
      }),
    ]);

    const result = await service.retireAliasFanOutRule(resourceId, "home", {
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: { connectionId: pangolinConnectionId, policyTier: "additive", actorIsAdmin: true },
    });

    expect(result.status).toBe("partial");
    expect(result.blockedCount).toBe(1);
    expect(provider.operations).toHaveLength(0);
  });

  it("a 'poll'/'sweep' trigger can never fan-out-retire — refused at the runtime boundary", async () => {
    const aliases: IpAliasMap = {
      home: {
        address: "203.0.113.7",
        source: "manual",
        hostname: null,
        connectionId: null,
        siteId: null,
        previousAddress: "203.0.113.4",
        observedAt: "2026-08-16T00:00:00.000Z",
        confirmedAt: "2026-08-15T00:00:00.000Z",
        autoApply: false,
      },
    };
    const service = createProxyResourcesService({
      db: handle.db,
      settings: { get: async () => aliases as never },
    });
    const { resourceId } = await makeResource();
    await insertRule({ proxyResourceId: resourceId, owner: "dynamic_ip", value: "alias:home" });
    const provider = createFakeProvider([]);

    await expect(
      service.retireAliasFanOutRule(resourceId, "home", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        trigger: "poll" as any,
        provider,
        orgId: "home-lab",
        writeAuthorization: accessAffectingPolicy(pangolinConnectionId),
      }),
    ).rejects.toThrow(ProxyWritePolicyError);
    expect(provider.operations).toHaveLength(0);
  });
});
