/**
 * The provisioning-template engine (Pangolin chain design milestone 6,
 * `loxep-acj.6`): the compiler's determinism and freeze semantics, the
 * driver's advance/stop/resume shape, blocked-state naming, per-step
 * `reconcile_run_id` evidence, and — the design's central promise — NO
 * ROLLBACK, ever: a failed/blocked step leaves every prior step's effects
 * standing, and "Abandon" only ever flips the run's own status.
 *
 * Everything here drives fakes: a stub `DnsProviderPort` (`helpers.ts`'s
 * existing Cloudflare stub), a stub `MailProviderPort` (`helpers.ts`'s
 * existing Purelymail stub), and a small STATEFUL `ProxyProviderPort` this
 * file builds locally (Pangolin has no stub in `helpers.ts` today — every
 * Pangolin-touching suite in this package builds its own, matching
 * `proxy.test.ts`'s own `createStubProvider`). No live provider is ever
 * reached, matching the milestone's own testing constraint.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createSettingsService, providerWritePolicySetting } from "@loxep/domain";
import type { ProviderWritePolicyTier } from "@loxep/domain";
import {
  InfrastructureValidationError,
  compileTemplate,
  createProvisioningDriver,
  createProvisioningTemplatesService,
  createProxyResourcesService,
  extractTemplateInputKeys,
} from "../src/index.ts";
import type {
  CompiledPlan,
  CreateTemplateStepInput,
  ObservedProxyResource,
  ObservedProxyRule,
  ProvisioningDriver,
  ProvisioningProviders,
  ProvisioningTemplatesService,
  ProxyOperation,
  ProxyProviderPort,
} from "../src/index.ts";
import {
  createRecordingSecretWriter,
  createScratchDb,
  createStubMailProvider,
  createStubProvider,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

/* ============================================================= compiler === */

describe("compileTemplate — pure, deterministic, and the freeze boundary", () => {
  const stepDefs: CreateTemplateStepInput[] = [
    {
      stepKind: "domain.declare",
      provider: "cloudflare",
      params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}" },
    },
    {
      stepKind: "dns.point-at-target",
      provider: "cloudflare",
      params: { apexTargetId: "${hostingTargetId}" },
    },
    {
      stepKind: "mail.enable",
      provider: "purelymail",
      params: { mailConnectionId: "${mailConnectionId}" },
    },
  ];

  const inputs = {
    domain: "example.test",
    dnsConnectionId: "11111111-1111-4111-8111-111111111111",
    hostingTargetId: "22222222-2222-4222-8222-222222222222",
    mailConnectionId: "33333333-3333-4333-8333-333333333333",
  };

  it("is deterministic: the same (version, steps, inputs) compiles to the same plan every time", () => {
    const first = compileTemplate({
      templateVersion: 1,
      steps: stepDefs.map((s, i) => ({ ...s, provider: s.provider ?? null, sequence: i, optional: false })),
      inputs,
    });
    const second = compileTemplate({
      templateVersion: 1,
      steps: stepDefs.map((s, i) => ({ ...s, provider: s.provider ?? null, sequence: i, optional: false })),
      inputs,
    });
    expect(second).toStrictEqual(first);
  });

  it("substitutes ${placeholder} strings at any depth, and nothing else", () => {
    const plan = compileTemplate({
      templateVersion: 1,
      steps: [
        {
          sequence: 0,
          stepKind: "domain.declare",
          provider: "cloudflare",
          params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}" },
          optional: false,
        },
      ],
      inputs,
    });
    expect(plan.steps[0]?.params["name"]).toBe("example.test");
    expect(plan.steps[0]?.params["dnsConnectionId"]).toBe(inputs.dnsConnectionId);
  });

  it("fails to compile when a referenced input was not supplied", () => {
    expect(() =>
      compileTemplate({
        templateVersion: 1,
        steps: [
          {
            sequence: 0,
            stepKind: "domain.declare",
            provider: "cloudflare",
            params: { name: "${nonexistent}", dnsConnectionId: "${dnsConnectionId}" },
            optional: false,
          },
        ],
        inputs,
      }),
    ).toThrow(InfrastructureValidationError);
  });

  it("computes dependsOnSequence from the nearest earlier structural parent", () => {
    const plan = compileTemplate({
      templateVersion: 1,
      steps: stepDefs.map((s, i) => ({ ...s, provider: s.provider ?? null, sequence: i, optional: false })),
      inputs,
    });
    expect(plan.steps[0]?.stepKind).toBe("domain.declare");
    expect(plan.steps[0]?.dependsOnSequence).toBeNull();
    expect(plan.steps[1]?.stepKind).toBe("dns.point-at-target");
    expect(plan.steps[1]?.dependsOnSequence).toBe(0);
    expect(plan.steps[2]?.stepKind).toBe("mail.enable");
    expect(plan.steps[2]?.dependsOnSequence).toBe(0);
  });

  it("refuses a template whose structural parent never appears earlier", () => {
    expect(() =>
      compileTemplate({
        templateVersion: 1,
        steps: [
          {
            sequence: 0,
            stepKind: "proxy.ensure-rules",
            provider: "pangolin",
            params: { rules: [{ action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100 }] },
            optional: false,
          },
        ],
        inputs,
      }),
    ).toThrow(InfrastructureValidationError);
  });

  it("validates each step's params against its OWN step_kind schema after substitution", () => {
    expect(() =>
      compileTemplate({
        templateVersion: 1,
        steps: [
          {
            sequence: 0,
            stepKind: "domain.declare",
            provider: "cloudflare",
            // Not a UUID — the substituted value must still satisfy the schema.
            params: { name: "example.test", dnsConnectionId: "not-a-uuid" },
            optional: false,
          },
        ],
        inputs,
      }),
    ).toThrow();
  });

  it("extractTemplateInputKeys discovers every ${placeholder} in first-appearance order — what the run wizard renders a field for", () => {
    const keys = extractTemplateInputKeys(
      stepDefs.map((s, i) => ({ ...s, provider: s.provider ?? null, sequence: i, optional: false })),
    );
    expect(keys).toStrictEqual(["domain", "dnsConnectionId", "hostingTargetId", "mailConnectionId"]);
  });
});

/* ===================================================== DB-backed suites === */

const dbName = scratchDbName("loxep_test_infra_provisioning");
let handle: DbHandle;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let domainSeq = 0;
function nextDomainName(): string {
  domainSeq += 1;
  return `example-${domainSeq}.test`;
}

/**
 * `infrastructure.provider_write_policy` is a SINGLE registered setting
 * keyed by connection id — sharing a connection across tests would leak one
 * test's policy flip into the next. Every harness therefore gets its OWN
 * fresh `connections` rows (and its own hosting target), the same isolation
 * `nextDomainName()` already gives the managed domain.
 */
async function insertConnection(
  provider: string,
  kind: string,
  config: string = "{}",
): Promise<string> {
  const result = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ($1, $2, $3, 'active', $4::jsonb)
     returning id`,
    [provider, kind, `${provider} (test)`, config],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("connections insert returned no row");
  return id;
}

async function insertHostingTarget(proxyConnectionId: string): Promise<string> {
  const result = await handle.pool.query<{ id: string }>(
    `insert into hosting_targets (name, control_surface, address_v4, proxy_connection_id)
     values ($1, 'direct_reverse_proxy', '203.0.113.5', $2)
     returning id`,
    [`origin-${Math.random().toString(36).slice(2, 8)}`, proxyConnectionId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("hosting_targets insert returned no row");
  return id;
}

/* --------------------------------------------------- stateful proxy stub */

interface StoredProxyResource {
  externalResourceId: string;
  fullDomain: string;
  subdomain: string | null;
  domainId: string;
  rules: ObservedProxyRule[];
}

function createStatefulProxyProvider(): ProxyProviderPort & {
  applyCallCount: number;
} {
  let resourceSeq = 0;
  let ruleSeq = 0;
  let applyCallCount = 0;
  const resources = new Map<string, StoredProxyResource>();

  return {
    get applyCallCount() {
      return applyCallCount;
    },
    async read(): Promise<ObservedProxyResource[]> {
      return [...resources.values()].map((r) => ({
        externalResourceId: r.externalResourceId,
        niceId: r.externalResourceId,
        name: r.subdomain,
        fullDomain: r.fullDomain,
        domainId: r.domainId,
        subdomain: r.subdomain,
        mode: "http",
        proxyPort: null,
        ssl: true,
        enabled: true,
        ssoEnabled: null,
        blockAccess: false,
        applyRules: true,
        emailWhitelistEnabled: null,
        targets: [],
        rules: r.rules.map((rule) => ({ ...rule })),
      }));
    },
    async apply(operation: ProxyOperation) {
      applyCallCount += 1;
      if (operation.kind === "create-resource") {
        resourceSeq += 1;
        const externalResourceId = `stub-resource-${resourceSeq}`;
        resources.set(externalResourceId, {
          externalResourceId,
          fullDomain: operation.resource.name,
          subdomain: operation.resource.subdomain,
          domainId: operation.resource.domainId,
          rules: [],
        });
        return { kind: "create-resource" as const, status: "applied" as const, externalResourceId };
      }
      if (operation.kind === "create-rule") {
        ruleSeq += 1;
        const externalRuleId = `stub-rule-${ruleSeq}`;
        const resource = resources.get(operation.externalResourceId);
        if (resource !== undefined) {
          resource.rules.push({
            externalRuleId,
            action: operation.rule.action,
            match: operation.rule.match,
            value: operation.rule.value,
            priority: operation.rule.priority,
            enabled: operation.rule.enabled,
          });
        }
        return { kind: "create-rule" as const, status: "applied" as const, externalRuleId };
      }
      if (operation.kind === "create-target") {
        return { kind: "create-target" as const, status: "applied" as const, externalTargetId: "stub-target-1" };
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

/**
 * The seeded 'new domain' example's own step shape (see
 * `guides/provisioning-templates.md` / the app's create-from-example
 * affordance): declare -> point DNS -> ensure the Pangolin resource -> ensure
 * its bypass rule -> enable mail -> ensure the `noreply` mailbox.
 */
function newDomainTemplateSteps(): CreateTemplateStepInput[] {
  return [
    {
      stepKind: "domain.declare",
      provider: "cloudflare",
      params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}", mailEnabled: true },
    },
    {
      stepKind: "dns.point-at-target",
      provider: "cloudflare",
      params: { apexTargetId: "${hostingTargetId}" },
    },
    {
      stepKind: "proxy.ensure-resource",
      provider: "pangolin",
      params: { hostingTargetId: "${hostingTargetId}", externalDomainId: "pangolin-domain-1" },
    },
    {
      stepKind: "proxy.ensure-rules",
      provider: "pangolin",
      params: {
        rules: [{ action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 100 }],
      },
    },
    {
      stepKind: "mail.enable",
      provider: "purelymail",
      params: { mailConnectionId: "${mailConnectionId}" },
    },
    {
      stepKind: "mail.ensure-mailbox",
      provider: "purelymail",
      params: { localPart: "noreply", kind: "mailbox" },
    },
  ];
}

interface Harness {
  templates: ProvisioningTemplatesService;
  driver: ProvisioningDriver;
  dnsProvider: ReturnType<typeof createStubProvider>;
  mailProvider: ReturnType<typeof createStubMailProvider>;
  proxyProvider: ReturnType<typeof createStatefulProxyProvider>;
  pangolinTier: { current: ProviderWritePolicyTier };
  settings: ReturnType<typeof createSettingsService>;
  cloudflareConnectionId: string;
  purelymailConnectionId: string;
  pangolinConnectionId: string;
  hostingTargetId: string;
}

async function buildHarness(domainName: string): Promise<Harness> {
  const cloudflareConnectionId = await insertConnection("cloudflare", "dns");
  const purelymailConnectionId = await insertConnection("purelymail", "mail");
  const pangolinConnectionId = await insertConnection(
    "pangolin",
    "proxy",
    '{"pangolin":{"orgId":"home-lab"}}',
  );
  const hostingTargetId = await insertHostingTarget(pangolinConnectionId);

  const settings = createSettingsService({ db: handle.db });
  const dnsProvider = createStubProvider({
    zoneName: domainName,
    externalZoneId: `zone-${domainName}`,
  });
  const mailProvider = createStubMailProvider();
  const proxyProvider = createStatefulProxyProvider();
  const pangolinTier: { current: ProviderWritePolicyTier } = { current: "read_only" };

  const providers: ProvisioningProviders = {
    resolveDnsProvider: async () => dnsProvider,
    resolveMailProvider: async () => mailProvider,
    resolveProxyProvider: async () => ({
      provider: proxyProvider,
      orgId: "home-lab",
      writeAuthorization: {
        connectionId: pangolinConnectionId,
        policyTier: pangolinTier.current,
        actorIsAdmin: true,
      },
    }),
  };

  const proxyResourceService = createProxyResourcesService({ db: handle.db });
  const secrets = createRecordingSecretWriter({ pool: handle.pool });

  const templates = createProvisioningTemplatesService({ db: handle.db });
  const driver = createProvisioningDriver({
    db: handle.db,
    proxyResourceService,
    providers,
    secrets,
    settings,
  });

  return {
    templates,
    driver,
    dnsProvider,
    mailProvider,
    proxyProvider,
    pangolinTier,
    settings,
    cloudflareConnectionId,
    purelymailConnectionId,
    pangolinConnectionId,
    hostingTargetId,
  };
}

async function readReconcileRunKind(runId: string | null): Promise<string | null> {
  if (runId === null) return null;
  const result = await handle.pool.query<{ kind: string }>(
    `select kind from reconcile_runs where id = $1`,
    [runId],
  );
  return result.rows[0]?.kind ?? null;
}

describe("template CRUD + freeze semantics", () => {
  it("startRun freezes compiled_plan; editing the template afterward does not change the running run", async () => {
    const harness = await buildHarness(nextDomainName());
    const template = await harness.templates.create({
      name: `freeze-test-${nextDomainName()}`,
      steps: [
        {
          stepKind: "domain.declare",
          provider: "cloudflare",
          params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}" },
        },
      ],
    });

    const run = await harness.templates.startRun({
      templateId: template.id,
      inputs: { domain: "frozen.test", dnsConnectionId: harness.cloudflareConnectionId },
    });
    const frozenPlan = run.compiledPlan as CompiledPlan;
    expect(frozenPlan.steps).toHaveLength(1);

    // Edit the template: add a second step. Version bumps.
    const edited = await harness.templates.replaceSteps(template.id, [
      {
        stepKind: "domain.declare",
        provider: "cloudflare",
        params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}" },
      },
      {
        stepKind: "dns.manual-record",
        provider: "cloudflare",
        params: { type: "TXT", name: "@", content: "v=verify" },
      },
    ]);
    expect(edited.version).toBe(template.version + 1);

    // The ALREADY-STARTED run's frozen plan is untouched.
    const reloaded = await harness.templates.getRun(run.id);
    expect(reloaded.compiledPlan).toStrictEqual(frozenPlan);
    expect((reloaded.compiledPlan as CompiledPlan).steps).toHaveLength(1);
    expect(reloaded.templateVersion).toBe(template.version);

    // A NEW run against the same template compiles against the edited step list.
    const secondRun = await harness.templates.startRun({
      templateId: template.id,
      inputs: { domain: "frozen-2.test", dnsConnectionId: harness.cloudflareConnectionId },
    });
    expect((secondRun.compiledPlan as CompiledPlan).steps).toHaveLength(2);
    expect(secondRun.templateVersion).toBe(edited.version);
  });

  it("previewRun compiles without writing any run row", async () => {
    const harness = await buildHarness(nextDomainName());
    const template = await harness.templates.create({
      name: `preview-test-${nextDomainName()}`,
      steps: [
        {
          stepKind: "domain.declare",
          provider: "cloudflare",
          params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}" },
        },
      ],
    });
    const before = await harness.templates.listRuns(template.id);
    const plan = await harness.templates.previewRun(template.id, {
      domain: "preview.test",
      dnsConnectionId: harness.cloudflareConnectionId,
    });
    expect(plan.steps).toHaveLength(1);
    const after = await harness.templates.listRuns(template.id);
    expect(after.length).toBe(before.length);
  });
});

describe("the driver: advance as far as it currently can, stop, resume", () => {
  it("blocks two independent tracks honestly on the first pass, then resumes as policy is granted — the exact shape the design's own worked example draws", async () => {
    const domainName = nextDomainName();
    const harness = await buildHarness(domainName);

    const template = await harness.templates.create({
      name: `new-domain-${domainName}`,
      steps: newDomainTemplateSteps(),
    });

    const run = await harness.templates.startRun({
      templateId: template.id,
      inputs: {
        domain: domainName,
        dnsConnectionId: harness.cloudflareConnectionId,
        hostingTargetId: harness.hostingTargetId,
        mailConnectionId: harness.purelymailConnectionId,
      },
    });

    /* ---- pass 1: Cloudflare additive, Pangolin + Purelymail read_only --- */
    await harness.settings.set(
      providerWritePolicySetting,
      { [harness.cloudflareConnectionId]: "additive" },
      {},
    );

    let advanced = await harness.driver.advance(run.id, { actorIsAdmin: true });
    expect(advanced.status).toBe("partial");

    let steps = await harness.templates.listRunSteps(run.id);
    const byKind = new Map(steps.map((s) => [s.stepKind, s]));

    expect(byKind.get("domain.declare")?.status).toBe("succeeded");
    expect(byKind.get("domain.declare")?.reconcileRunId).toBeNull();

    expect(byKind.get("dns.point-at-target")?.status).toBe("succeeded");
    expect(byKind.get("dns.point-at-target")?.reconcileRunId).not.toBeNull();
    expect(
      await readReconcileRunKind(byKind.get("dns.point-at-target")?.reconcileRunId ?? null),
    ).toBe("sync-records");

    // Two INDEPENDENT tracks, both correctly evaluated and blocked on the
    // SAME pass — the design's own worked example ("step 5 is blocked even
    // though step 3 already failed and step 4 never ran").
    const proxyResourceStep = byKind.get("proxy.ensure-resource");
    expect(proxyResourceStep?.status).toBe("blocked");
    expect(proxyResourceStep?.blockedReason).toBe("credential_scope");
    expect(proxyResourceStep?.errorDetail).toContain("/settings/connections");

    const mailEnableStep = byKind.get("mail.enable");
    expect(mailEnableStep?.status).toBe("blocked");
    expect(mailEnableStep?.blockedReason).toBe("credential_scope");
    expect(mailEnableStep?.errorDetail).toContain("/settings/connections");

    // Dependents of the still-blocked steps were never even attempted.
    expect(byKind.get("proxy.ensure-rules")?.status).toBe("pending");
    expect(byKind.get("mail.ensure-mailbox")?.status).toBe("pending");
    expect(harness.proxyProvider.applyCallCount).toBe(0);
    expect(harness.mailProvider.calls.addDomain).toBe(0);

    /* ---- pass 2: grant Pangolin only — its whole track clears in ONE pass */
    harness.pangolinTier.current = "additive";
    advanced = await harness.driver.advance(run.id, { actorIsAdmin: true });
    expect(advanced.status).toBe("partial");

    steps = await harness.templates.listRunSteps(run.id);
    const byKind2 = new Map(steps.map((s) => [s.stepKind, s]));
    expect(byKind2.get("proxy.ensure-resource")?.status).toBe("succeeded");
    expect(byKind2.get("proxy.ensure-rules")?.status).toBe("succeeded");
    expect(
      await readReconcileRunKind(byKind2.get("proxy.ensure-resource")?.reconcileRunId ?? null),
    ).toBe("reconcile-proxy-resource");
    // Mail is still blocked; unaffected by the Pangolin flip.
    expect(byKind2.get("mail.enable")?.status).toBe("blocked");

    /* ---- pass 3: grant Purelymail — the run completes ------------------- */
    await harness.settings.set(
      providerWritePolicySetting,
      { [harness.cloudflareConnectionId]: "additive", [harness.purelymailConnectionId]: "additive" },
      {},
    );
    advanced = await harness.driver.advance(run.id, { actorIsAdmin: true });
    expect(advanced.status).toBe("succeeded");
    expect(advanced.finishedAt).not.toBeNull();

    steps = await harness.templates.listRunSteps(run.id);
    for (const step of steps) {
      expect(step.status, `${step.stepKind} should have succeeded`).toBe("succeeded");
    }
    const mailboxStep = steps.find((s) => s.stepKind === "mail.ensure-mailbox");
    expect(
      await readReconcileRunKind(mailboxStep?.reconcileRunId ?? null),
    ).toBe("sync-mailboxes");

    /* ---- resume is safe: re-advancing a succeeded run is a pure no-op --- */
    const beforeApplyCalls = harness.proxyProvider.applyCallCount;
    const beforeMailboxCreates = harness.mailProvider.calls.createUser;
    const again = await harness.driver.advance(run.id, { actorIsAdmin: true });
    expect(again.status).toBe("succeeded");
    expect(harness.proxyProvider.applyCallCount).toBe(beforeApplyCalls);
    expect(harness.mailProvider.calls.createUser).toBe(beforeMailboxCreates);
  });

  it("names the exact policy flip in every blocked step's detail, per-provider", async () => {
    const domainName = nextDomainName();
    const harness = await buildHarness(domainName);
    const template = await harness.templates.create({
      name: `blocked-naming-${domainName}`,
      steps: [
        {
          stepKind: "domain.declare",
          provider: "cloudflare",
          params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}" },
        },
        {
          stepKind: "dns.point-at-target",
          provider: "cloudflare",
          params: { apexTargetId: "${hostingTargetId}" },
        },
      ],
    });
    const run = await harness.templates.startRun({
      templateId: template.id,
      inputs: {
        domain: domainName,
        dnsConnectionId: harness.cloudflareConnectionId,
        hostingTargetId: harness.hostingTargetId,
      },
    });

    // Cloudflare stays read_only throughout.
    await harness.driver.advance(run.id, { actorIsAdmin: true });
    const steps = await harness.templates.listRunSteps(run.id);
    const dnsStep = steps.find((s) => s.stepKind === "dns.point-at-target");
    expect(dnsStep?.status).toBe("blocked");
    expect(dnsStep?.blockedReason).toBe("credential_scope");
    expect(dnsStep?.errorDetail).toMatch(/allow writes for this connection/i);
    expect(dnsStep?.errorDetail).toMatch(/\/settings\/connections/);
  });

  it("blocks domain.declare honestly with zone_not_found when no Cloudflare zone resolves — the adapter has no zone-create verb", async () => {
    const domainName = nextDomainName();
    const harness = await buildHarness(domainName);
    // Point the stub DNS provider at a DIFFERENT zone name, so findZoneByName
    // returns null for this domain.
    const noZoneProvider = createStubProvider({
      zoneName: "a-different-zone.test",
      externalZoneId: "zone-different",
    });
    const providers: ProvisioningProviders = {
      resolveDnsProvider: async () => noZoneProvider,
      resolveMailProvider: async () => harness.mailProvider,
      resolveProxyProvider: async () => null,
    };
    const driver = createProvisioningDriver({
      db: handle.db,
      proxyResourceService: createProxyResourcesService({ db: handle.db }),
      providers,
      secrets: createRecordingSecretWriter({ pool: handle.pool }),
      settings: harness.settings,
    });

    const template = await harness.templates.create({
      name: `zone-block-${domainName}`,
      steps: [
        {
          stepKind: "domain.declare",
          provider: "cloudflare",
          params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}" },
        },
      ],
    });
    const run = await harness.templates.startRun({
      templateId: template.id,
      inputs: { domain: domainName, dnsConnectionId: harness.cloudflareConnectionId },
    });

    const advanced = await driver.advance(run.id);
    expect(advanced.status).toBe("partial");
    const steps = await harness.templates.listRunSteps(run.id);
    expect(steps[0]?.status).toBe("blocked");
    expect(steps[0]?.blockedReason).toBe("zone_not_found");
    expect(steps[0]?.errorDetail).toContain("Cloudflare");
  });

  it("no rollback: abandoning a partial run touches ONLY the run's own status — every effect already applied stays exactly as it was", async () => {
    const domainName = nextDomainName();
    const harness = await buildHarness(domainName);
    const template = await harness.templates.create({
      name: `no-rollback-${domainName}`,
      steps: newDomainTemplateSteps(),
    });
    const run = await harness.templates.startRun({
      templateId: template.id,
      inputs: {
        domain: domainName,
        dnsConnectionId: harness.cloudflareConnectionId,
        hostingTargetId: harness.hostingTargetId,
        mailConnectionId: harness.purelymailConnectionId,
      },
    });

    await harness.settings.set(
      providerWritePolicySetting,
      { [harness.cloudflareConnectionId]: "additive" },
      {},
    );
    harness.pangolinTier.current = "additive";
    await harness.driver.advance(run.id, { actorIsAdmin: true });

    const beforeAbandon = await harness.templates.listRunSteps(run.id);
    const beforeByKind = new Map(beforeAbandon.map((s) => [s.stepKind, { ...s }]));
    expect(beforeByKind.get("proxy.ensure-resource")?.status).toBe("succeeded");
    expect(beforeByKind.get("mail.enable")?.status).toBe("blocked");

    // The proxy resource this run created is real, in Loxep's own table.
    const resourceRows = await handle.pool.query<{ id: string; external_resource_id: string | null }>(
      `select id, external_resource_id from proxy_resources where domain_id = (select id from managed_domains where name = $1)`,
      [domainName],
    );
    expect(resourceRows.rows).toHaveLength(1);
    expect(resourceRows.rows[0]?.external_resource_id).not.toBeNull();

    const abandoned = await harness.templates.abandonRun(run.id, { actorUserId: null });
    expect(abandoned.status).toBe("failed");
    expect(abandoned.finishedAt).not.toBeNull();

    // Every step's own status is UNCHANGED — no step is rewritten by abandon.
    const afterAbandon = await harness.templates.listRunSteps(run.id);
    for (const step of afterAbandon) {
      const before = beforeByKind.get(step.stepKind as never);
      expect(step.status).toBe(before?.status);
      expect(step.blockedReason).toBe(before?.blockedReason);
      expect(step.reconcileRunId).toBe(before?.reconcileRunId);
    }

    // The Pangolin resource this run created still exists, untouched.
    const afterResourceRows = await handle.pool.query<{ external_resource_id: string | null }>(
      `select external_resource_id from proxy_resources where domain_id = (select id from managed_domains where name = $1)`,
      [domainName],
    );
    expect(afterResourceRows.rows[0]?.external_resource_id).toBe(
      resourceRows.rows[0]?.external_resource_id,
    );
    expect(harness.proxyProvider.applyCallCount).toBeGreaterThan(0);

    // Abandoning again is a safe no-op.
    const again = await harness.templates.abandonRun(run.id);
    expect(again.status).toBe("failed");
  });

  it("every driver PASS opens its own reconcile_runs evidence row (subject_type = 'template_run'), distinguishing it from an ordinary reconciler run", async () => {
    const domainName = nextDomainName();
    const harness = await buildHarness(domainName);
    const template = await harness.templates.create({
      name: `spine-evidence-${domainName}`,
      steps: [
        {
          stepKind: "domain.declare",
          provider: "cloudflare",
          params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}" },
        },
      ],
    });
    const run = await harness.templates.startRun({
      templateId: template.id,
      inputs: { domain: domainName, dnsConnectionId: harness.cloudflareConnectionId },
    });
    await harness.driver.advance(run.id);

    const spineRows = await handle.pool.query<{ status: string; subject_type: string; kind: string }>(
      `select status, subject_type, kind from reconcile_runs where subject_id = $1`,
      [run.id],
    );
    expect(spineRows.rows).toHaveLength(1);
    expect(spineRows.rows[0]?.subject_type).toBe("template_run");
    expect(spineRows.rows[0]?.kind).toBe("run-provisioning-template");
  });
});
