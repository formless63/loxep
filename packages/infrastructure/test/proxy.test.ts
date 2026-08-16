/**
 * `proxy.ts` against real PostgreSQL: `reconcile` (the whole read -> diff ->
 * record flow, including the self-retiring identity write-back), the
 * `reconcileDomain` fan-out, and — from M4 (`loxep-acj.4`) — the tier-1
 * apply leg: the write-authorization gate, the ledgered create/read-back
 * flow, and the tier-2-not-implemented skip. M2's own headline test ("no
 * sweep can reach an apply") still passes for TIER 2 (`assertWritePolicy`'s
 * own rule 3 unconditionally refuses a `'poll'`/`'sweep'` trigger applying
 * tier ≥ 2 — see `write-policy.test.ts`); M5 (`loxep-acj.5`) deliberately
 * OPENS the tier-1 half of that gate for `'poll'` — the seam the dynamic-IP
 * auto-apply detector uses — so a `'poll'`-triggered tier-1 apply is now
 * PERMITTED here, still behind the connection's own write-policy tier.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import type { IpAliasMap, SettingsService } from "@loxep/domain";
import {
  InfrastructureValidationError,
  MaterializationError,
  ProviderCallError,
  WritePolicyError,
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

/** A minimal `Pick<SettingsService, "get">` that always answers the same alias map — every test here only ever asks for `infrastructure.ip_aliases`. */
function fakeAliasSettings(aliases: IpAliasMap): Pick<SettingsService, "get"> {
  return {
    async get<T>(): Promise<T> {
      return aliases as unknown as T;
    },
  };
}

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

async function insertPendingOperation(input: {
  idempotencyKey: string;
  operation: string;
  runId?: string | null;
}): Promise<void> {
  await handle.pool.query(
    `insert into provider_operations (idempotency_key, provider, operation, status, run_id)
     values ($1, 'pangolin', $2, 'pending', $3)`,
    [input.idempotencyKey, input.operation, input.runId ?? null],
  );
}

function additivePolicy(connectionId: string, overrides: Partial<ProxyWriteAuthorizationContext> = {}): ProxyWriteAuthorizationContext {
  return { connectionId, policyTier: "additive", actorIsAdmin: true, ...overrides };
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
  /** When set, call N of `read()` returns `observedSequence[N]` (clamped to the last entry) instead of the static `observed`. */
  observedSequence?: ObservedProxyResource[][];
  failReadOnce?: { kind: string; message: string };
  /** Fails every `apply()` call with this error, rather than synthesizing a result. */
  failApply?: { kind: string; message: string };
  /** Overrides the id `apply()`'s synthesized result carries, per kind. */
  nextIds?: { externalResourceId?: string; externalTargetId?: string; externalRuleId?: string };
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
      const thisCall = readCallCount;
      readCallCount += 1;
      if (failReadOnce !== undefined) {
        const failure = failReadOnce;
        failReadOnce = undefined;
        throw new StubProxyProviderError(failure.kind, failure.message);
      }
      if (options.observedSequence !== undefined) {
        const sequence = options.observedSequence;
        return sequence[thisCall] ?? sequence[sequence.length - 1] ?? [];
      }
      return options.observed ?? [];
    },
    async apply(operation: ProxyOperation) {
      applyCallCount += 1;
      if (options.failApply !== undefined) {
        throw new StubProxyProviderError(options.failApply.kind, options.failApply.message);
      }
      if (operation.kind === "create-resource") {
        return {
          kind: operation.kind,
          status: "applied" as const,
          externalResourceId: options.nextIds?.externalResourceId ?? "created-resource-1",
        };
      }
      if (operation.kind === "create-target") {
        return {
          kind: operation.kind,
          status: "applied" as const,
          externalTargetId: options.nextIds?.externalTargetId ?? "created-target-1",
        };
      }
      if (operation.kind === "create-rule") {
        return {
          kind: operation.kind,
          status: "applied" as const,
          externalRuleId: options.nextIds?.externalRuleId ?? "created-rule-1",
        };
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

describe("write-authorization gate — M2's headline constraint, M4-evolved", () => {
  let service: ProxyResourcesService;
  beforeAll(() => {
    service = createProxyResourcesService({ db: handle.db });
  });

  it("reconcile() now PERMITS a 'poll'-triggered tier-1 apply — M5 (loxep-acj.5) opens the seam M4 reserved for the dynamic-IP auto-apply detector, gated by the connection's write-policy tier exactly like a 'manual' apply", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    // observed: [] -> the planner emits a create-resource op, so the apply
    // path is actually exercised (an empty plan would never reach it).
    const provider = createStubProvider({ observed: [] });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "poll",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });
    expect(result.status).toBe("succeeded");
    expect(result.appliedCount).toBe(1);
    expect(provider.applyCallCount).toBe(1);
  });

  it("reconcile() still refuses a 'poll'-triggered apply at a 'read_only' policy tier — opening the trigger seam did not open the policy gate", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    const provider = createStubProvider({ observed: [] });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "poll",
      provider,
      orgId: "home-lab",
      writeAuthorization: { connectionId: pangolinConnectionId, policyTier: "read_only" },
    });
    expect(result.status).toBe("partial");
    expect(result.appliedCount).toBe(0);
    expect(provider.applyCallCount).toBe(0);
  });

  it("reconcileDomain() propagates a 'poll'-triggered apply through to reconcile() per resource, resolving a provider for each", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    await insertProxyResource({ domainId: domain.id, hostingTargetId: target.id });
    let resolveCalls = 0;

    const results = await service.reconcileDomain(domain.id, {
      mode: "apply",
      trigger: "poll",
      resolveProvider: async () => {
        resolveCalls += 1;
        return null;
      },
    });
    expect(resolveCalls).toBe(1);
    expect(results[0]?.status).toBe("skipped");
  });

  it("throws when mode:'apply' would apply a tier-1 op but no writeAuthorization was resolved — a caller bug, not a policy refusal", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    // observed: [] -> the planner emits a create-resource op, so the
    // writeAuthorization check is actually reached (an empty plan would
    // never need it).
    const provider = createStubProvider({ observed: [] });

    await expect(
      service.reconcile(resource.id, {
        mode: "apply",
        trigger: "manual",
        provider,
        orgId: "home-lab",
      }),
    ).rejects.toThrow(InfrastructureValidationError);
    expect(provider.applyCallCount).toBe(0);
  });

  it("a 'read_only' policy tier blocks the apply — recorded as 'blocked', run finishes 'partial', never reaches provider.apply()", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
    });
    const provider = createStubProvider({ observed: [] });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: { connectionId: pangolinConnectionId, policyTier: "read_only", actorIsAdmin: true },
    });

    expect(result.status).toBe("partial");
    expect(result.appliedCount).toBe(0);
    expect(provider.applyCallCount).toBe(0);

    const steps = await readSteps(result.runId);
    const blocked = steps.find((s) => s.status === "blocked");
    expect(blocked?.error_code).toBe("write_policy");
    expect(blocked?.error_detail).toContain("additive");

    const run = await handle.pool.query<{ status: string }>(
      `select status from reconcile_runs where id = $1`,
      [result.runId],
    );
    expect(run.rows[0]?.status).toBe("partial");
  });

  it("never has a code path that reaches provider.apply() in check mode", async () => {
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

describe("apply leg (M4, loxep-acj.4) — tier-1 writes, ledgered", () => {
  let service: ProxyResourcesService;
  beforeAll(() => {
    service = createProxyResourcesService({ db: handle.db });
  });

  it("createResource: applies, ledgers, and self-retires the external id", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
      externalResourceId: null,
    });
    const provider = createStubProvider({ observed: [], nextIds: { externalResourceId: "999" } });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("succeeded");
    expect(result.appliedCount).toBe(1);
    expect(provider.applyCallCount).toBe(1);
    expect((await readProxyResource(resource.id)).externalResourceId).toBe("999");

    const key = `pangolin:resource.create:${resource.id}`;
    const op = await handle.pool.query<{ status: string }>(
      `select status from provider_operations where idempotency_key = $1`,
      [key],
    );
    expect(op.rows[0]?.status).toBe("succeeded");
  });

  it("createRule: applies with the full payload and ledgers by the intent row's own id", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
      externalResourceId: "42",
    });
    await insertRule({ proxyResourceId: resource.id, value: "203.0.113.9/32", priority: 5 });
    const provider = createStubProvider({
      observed: [observedResource({ externalResourceId: "42", fullDomain: `api.${domain.name}`, rules: [] })],
      nextIds: { externalRuleId: "555" },
    });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "intent_change",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("succeeded");
    expect(result.appliedCount).toBe(1);
    expect(provider.applyCallCount).toBe(1);

    const rows = await handle.pool.query<{ idempotency_key: string; status: string }>(
      `select idempotency_key, status from provider_operations where operation = 'rule.create'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe("succeeded");
    // Keyed by the proxy_resource_rules row's OWN id — recomputable by the
    // caller, never by the rule's provider-assigned id (unknown pre-create).
    expect(rows.rows[0]?.idempotency_key).toMatch(/^pangolin:rule\.create:[0-9a-f-]{36}$/);
  });

  it("createRule is NOT idempotent from the provider's own perspective — the ledger is what prevents a re-run from double-creating", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
      externalResourceId: "42",
    });
    await insertRule({ proxyResourceId: resource.id, value: "203.0.113.10/32", priority: 6 });
    // The provider read NEVER reflects the create (a static stub, or a slow
    // read replica) — the realistic case where a naive re-run would
    // otherwise double-create.
    const provider = createStubProvider({
      observed: [observedResource({ externalResourceId: "42", fullDomain: `api.${domain.name}`, rules: [] })],
    });

    const first = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });
    const second = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });

    expect(first.appliedCount).toBe(1);
    // The SAME operation is planned again (the stub's observed set never
    // changed), but the ledger short-circuits it — never a second create.
    expect(second.operationCount).toBe(1);
    expect(second.appliedCount).toBe(0);
    expect(provider.applyCallCount).toBe(1);

    const steps = await readSteps(second.runId);
    expect(steps.some((s) => s.step === "apply.create-rule" && (s.status === "succeeded"))).toBe(true);
  });

  it("a stuck 'pending' ledger row resolves by READING THE PROVIDER BACK, never by re-calling apply() — the ledger's ideal case", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
      externalResourceId: null,
    });
    const fullDomain = `api.${domain.name}`;
    await insertPendingOperation({
      idempotencyKey: `pangolin:resource.create:${resource.id}`,
      operation: "resource.create",
    });
    // The FIRST read (the diff step) sees nothing yet — matching the
    // situation that produced the stuck 'pending' row in the first place —
    // so the planner still emits a create-resource op and `ledger.begin()`
    // finds it already `pending`. The SECOND read (inside the read-back
    // resolution itself) is where the prior crashed attempt's actual result
    // becomes visible.
    const provider = createStubProvider({
      observedSequence: [[], [observedResource({ externalResourceId: "777", fullDomain, subdomain: "api" })]],
    });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("succeeded");
    expect(provider.applyCallCount).toBe(0);
    expect((await readProxyResource(resource.id)).externalResourceId).toBe("777");

    const op = await handle.pool.query<{ status: string; attempts: number }>(
      `select status, attempts from provider_operations where idempotency_key = $1`,
      [`pangolin:resource.create:${resource.id}`],
    );
    expect(op.rows[0]?.status).toBe("succeeded");
    expect(op.rows[0]?.attempts).toBe(2);
  });

  it("a stuck 'pending' row that read-back cannot find resolves to 'failed', safe to retry next run", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
      externalResourceId: null,
    });
    await insertPendingOperation({
      idempotencyKey: `pangolin:resource.create:${resource.id}`,
      operation: "resource.create",
    });
    const provider = createStubProvider({ observed: [] });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("succeeded");
    expect(result.appliedCount).toBe(0);
    expect(provider.applyCallCount).toBe(0);

    const op = await handle.pool.query<{ status: string }>(
      `select status from provider_operations where idempotency_key = $1`,
      [`pangolin:resource.create:${resource.id}`],
    );
    expect(op.rows[0]?.status).toBe("failed");
  });

  it("a tier-2 update-rule present in the plan is skipped, not applied — the run finishes 'partial'", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
      externalResourceId: "42",
    });
    await insertRule({ proxyResourceId: resource.id, value: "203.0.113.7/32", priority: 100 });
    // Observed carries the SAME rule at a DIFFERENT priority -> update-rule
    // (tier 2), which M4 ships no adapter verb for.
    const provider = createStubProvider({
      observed: [
        observedResource({
          externalResourceId: "42",
          fullDomain: `api.${domain.name}`,
          rules: [
            { externalRuleId: "1", action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 1, enabled: true },
          ],
        }),
      ],
    });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });

    expect(result.status).toBe("partial");
    expect(result.appliedCount).toBe(0);
    expect(provider.applyCallCount).toBe(0);

    const steps = await readSteps(result.runId);
    const skipped = steps.find((s) => s.step === "apply.tier2-not-implemented");
    expect(skipped?.status).toBe("skipped");
  });

  it("refuses to apply a create-rule against a resource whose fullDomain fronts Loxep itself — the self-lockout preflight", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
      subdomain: "api",
      externalResourceId: "42",
    });
    const fullDomain = `api.${domain.name}`;
    // A desired rule that Pangolin does not have yet -> a create-rule op is
    // planned, which is what makes the lockout preflight reachable at all
    // (an empty plan never calls it).
    await insertRule({ proxyResourceId: resource.id, value: "203.0.113.7/32", priority: 1 });
    const provider = createStubProvider({
      observed: [observedResource({ externalResourceId: "42", fullDomain, rules: [] })],
    });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId, { loxepSelfHosts: [fullDomain] }),
    });

    expect(result.status).toBe("partial");
    expect(provider.applyCallCount).toBe(0);
    const steps = await readSteps(result.runId);
    const blocked = steps.find((s) => s.status === "blocked");
    expect(blocked?.error_detail).toContain("fronts Loxep itself");
  });

  it("classifies a genuine provider failure as ProviderCallError and records a failed run, distinctly from a policy block", async () => {
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({
      domainId: domain.id,
      hostingTargetId: target.id,
      externalResourceId: null,
    });
    const provider = createStubProvider({
      observed: [],
      failApply: { kind: "provider_unavailable", message: "pangolin is down" },
    });

    await expect(
      service.reconcile(resource.id, {
        mode: "apply",
        trigger: "manual",
        provider,
        orgId: "home-lab",
        writeAuthorization: additivePolicy(pangolinConnectionId),
      }),
    ).rejects.toThrow(ProviderCallError);

    const runs = await service.listRuns(resource.id);
    expect(runs.some((run) => run.status === "failed")).toBe(true);

    const op = await handle.pool.query<{ status: string }>(
      `select status from provider_operations where idempotency_key = $1`,
      [`pangolin:resource.create:${resource.id}`],
    );
    expect(op.rows[0]?.status).toBe("failed");
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
        appliedCount: 0,
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

describe("listRulesReferencingAlias() (loxep-acj.5)", () => {
  let service: ProxyResourcesService;
  beforeAll(() => {
    service = createProxyResourcesService({ db: handle.db });
  });

  it("finds every dynamic_ip rule referencing an alias, ACROSS domains and hosting targets", async () => {
    const domainA = await insertDomain();
    const domainB = await insertDomain();
    const targetA = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const targetB = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resourceA = await insertProxyResource({ domainId: domainA.id, hostingTargetId: targetA.id });
    const resourceB = await insertProxyResource({ domainId: domainB.id, hostingTargetId: targetB.id });
    await insertRule({ proxyResourceId: resourceA.id, owner: "dynamic_ip", value: "alias:home" });
    await insertRule({ proxyResourceId: resourceB.id, owner: "dynamic_ip", value: "alias:home", priority: 50 });
    // A decoy: a different alias, and a manual/template rule — neither should surface.
    await insertRule({ proxyResourceId: resourceA.id, owner: "dynamic_ip", value: "alias:office" });
    await insertRule({ proxyResourceId: resourceA.id, owner: "manual", value: "198.51.100.1/32" });

    const found = await service.listRulesReferencingAlias("alias:home");
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.resource.id).sort()).toEqual([resourceA.id, resourceB.id].sort());
    expect(found.every((f) => f.rule.owner === "dynamic_ip" && f.rule.value === "alias:home")).toBe(true);
  });

  it("returns an empty list when no rule references the alias", async () => {
    const found = await service.listRulesReferencingAlias("alias:nonexistent");
    expect(found).toEqual([]);
  });
});

/**
 * Dynamic-IP alias materialization wired into `reconcile()` (Pangolin chain
 * design milestone 5, `loxep-acj.5`). `buildDesired()` resolves a
 * `dynamic_ip`-owned rule's stored `alias:<name>` reference into today's
 * literal address before ANY provider call — an unresolvable alias fails the
 * run loudly (never a fallback), and a resolvable one diffs/applies exactly
 * like an ordinary literal rule from here on.
 */
describe("dynamic-IP alias materialization (loxep-acj.5)", () => {
  it("an unresolvable alias reference fails the run before any provider read, with a 'materialize-aliases' step", async () => {
    const service = createProxyResourcesService({ db: handle.db, settings: fakeAliasSettings({}) });
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({ domainId: domain.id, hostingTargetId: target.id });
    await insertRule({ proxyResourceId: resource.id, owner: "dynamic_ip", value: "alias:home" });
    const provider = createStubProvider();

    await expect(
      service.reconcile(resource.id, { mode: "check", trigger: "manual", provider, orgId: "home-lab" }),
    ).rejects.toThrow(MaterializationError);
    expect(provider.readCallCount).toBe(0);

    const runs = await service.listRuns(resource.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    const steps = await readSteps(runs[0]?.id ?? null);
    expect(steps.find((s) => s.step === "materialize-aliases")?.status).toBe("failed");
  });

  it("resolves an alias to its current address and diffs an existing observed resource against the LITERAL value, producing a create-rule op for a genuinely new address", async () => {
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
    const service = createProxyResourcesService({ db: handle.db, settings: fakeAliasSettings(aliases) });
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({ domainId: domain.id, hostingTargetId: target.id });
    await insertRule({ proxyResourceId: resource.id, owner: "dynamic_ip", value: "alias:home" });

    const operations: ProxyOperation[] = [];
    const provider: ProxyProviderPort = {
      async read() {
        return [observedResource({ fullDomain: `api.${domain.name}`, rules: [] })];
      },
      async apply(operation) {
        operations.push(operation);
        if (operation.kind === "create-rule") {
          return { kind: operation.kind, status: "applied", externalRuleId: "created-rule-1" };
        }
        return { kind: operation.kind, status: "applied" };
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

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "manual",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });
    expect(result.status).toBe("succeeded");
    expect(result.appliedCount).toBe(1);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ kind: "create-rule", rule: { value: "203.0.113.7/32" } });
  });

  it("add-then-retire in practice: when the alias's address changes, reconcile() ADDS a rule for the new address and leaves the old (still-observed) rule completely untouched", async () => {
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
    const service = createProxyResourcesService({ db: handle.db, settings: fakeAliasSettings(aliases) });
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({ domainId: domain.id, hostingTargetId: target.id });
    await insertRule({ proxyResourceId: resource.id, owner: "dynamic_ip", value: "alias:home" });

    const operations: ProxyOperation[] = [];
    const provider: ProxyProviderPort = {
      async read() {
        return [
          observedResource({
            fullDomain: `api.${domain.name}`,
            rules: [
              {
                externalRuleId: "900",
                action: "ACCEPT",
                match: "CIDR",
                value: "203.0.113.4/32",
                priority: 100,
                enabled: true,
              },
            ],
          }),
        ];
      },
      async apply(operation) {
        operations.push(operation);
        if (operation.kind === "create-rule") {
          return { kind: operation.kind, status: "applied", externalRuleId: "created-rule-2" };
        }
        return { kind: operation.kind, status: "applied" };
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

    // 'poll' — the trigger the alias-detection sweep uses, now permitted for
    // a tier-1 op behind an 'additive' policy (this milestone's own change).
    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "poll",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });
    expect(result.status).toBe("succeeded");
    expect(result.appliedCount).toBe(1);
    // ONLY a create-rule for the NEW address — never an update-rule against
    // the old one, and never a retire. Add-then-retire's "keep the old one"
    // half falls out of the planner naturally (see ip-aliases.ts's module
    // doc): there is exactly one operation here, and it is a create.
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ kind: "create-rule", rule: { value: "203.0.113.7/32" } });
  });

  it("an unchanged alias value is idempotent: the resolved literal matches the observed rule, so no operation is emitted at all", async () => {
    const aliases: IpAliasMap = {
      home: {
        address: "203.0.113.7",
        source: "manual",
        hostname: null,
        connectionId: null,
        siteId: null,
        previousAddress: null,
        observedAt: "2026-08-16T00:00:00.000Z",
        confirmedAt: "2026-08-15T00:00:00.000Z",
        autoApply: false,
      },
    };
    const service = createProxyResourcesService({ db: handle.db, settings: fakeAliasSettings(aliases) });
    const domain = await insertDomain();
    const target = await insertHostingTarget({ proxyConnectionId: pangolinConnectionId });
    const resource = await insertProxyResource({ domainId: domain.id, hostingTargetId: target.id });
    await insertRule({ proxyResourceId: resource.id, owner: "dynamic_ip", value: "alias:home" });

    const provider = createStubProvider({
      observed: [
        observedResource({
          fullDomain: `api.${domain.name}`,
          rules: [
            {
              externalRuleId: "900",
              action: "ACCEPT",
              match: "CIDR",
              value: "203.0.113.7/32",
              priority: 100,
              enabled: true,
            },
          ],
        }),
      ],
    });

    const result = await service.reconcile(resource.id, {
      mode: "apply",
      trigger: "poll",
      provider,
      orgId: "home-lab",
      writeAuthorization: additivePolicy(pangolinConnectionId),
    });
    expect(result.status).toBe("succeeded");
    expect(result.operationCount).toBe(0);
    expect(result.appliedCount).toBe(0);
    expect(provider.applyCallCount).toBe(0);
  });
});
