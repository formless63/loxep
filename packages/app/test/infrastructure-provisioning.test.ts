/**
 * Infrastructure PROVISIONING-TEMPLATE composition-root wiring (Pangolin
 * chain design milestone 6, `loxep-acj.6`) — proves
 * `infrastructure-provisioning.ts`'s three provider resolvers really do
 * reach a REAL Cloudflare adapter factory the way every other reconciler in
 * this composition already does, and that the registered
 * `infrastructure.run-provisioning-template` task drives a real
 * `@loxep/infrastructure` `ProvisioningDriver` against real PostgreSQL.
 *
 * The step-kind BUSINESS LOGIC (compiler determinism, blocked-state naming,
 * per-step evidence, no-rollback) is exhaustively covered in
 * `packages/infrastructure/test/provisioning.test.ts` against fakes with no
 * `@loxep/app` in the graph at all — this file's whole job is the ONE thing
 * that suite cannot prove: that THIS composition's adapter-factory wiring
 * (`buildProvisioningProviders`) actually compiles against, and correctly
 * calls, the real `providerPortFromCloudflareAdapter` seam every other
 * Cloudflare-touching task in `@loxep/app` already uses.
 *
 * The ONLY mock is the provider, at the same boundary
 * `infrastructure-poll-executor.test.ts` and `infrastructure-mail.test.ts`
 * already use: `services.getCloudflareAdapterForConnection`. PostgreSQL, the
 * real driver, and the real `ProvisioningTemplatesService` are the real
 * thing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import {
  RUN_PROVISIONING_TEMPLATE_TASK,
  createProvisioningTemplatesService,
} from "@loxep/infrastructure";
import type { CompiledPlan } from "@loxep/infrastructure";
import {
  buildProvisioningDriver,
  buildProvisioningProviders,
  createInfrastructureProvisioningTasks,
} from "../src/infrastructure-provisioning.ts";
import { buildAppServices } from "../src/index.ts";
import type { AppServices } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  fakeCloudflareConnectionAdapter,
  fakeCloudflareState,
  fakeCloudflareZone,
  scratchDbName,
  silentJobsLogger,
  testConfig,
} from "./helpers.ts";
import type { FakeCloudflareState } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_provisioning");
let databaseUrl: string;
let handle: DbHandle;
let services: AppServices;
let cloudflareConnectionId = "";
const cloudflareState: FakeCloudflareState = fakeCloudflareState();

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentJobsLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  const real = buildAppServices({ config, logger: silentJobsLogger });
  services = {
    ...real,
    // The one mock — see the module doc.
    getCloudflareAdapterForConnection: async (id) =>
      fakeCloudflareConnectionAdapter(id, cloudflareState, {
        minIntervalSeconds: 3600,
      }),
  };

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "provisioning-wiring@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const connection = await services.connections.createConnection({
    provider: "cloudflare",
    kind: "dns",
    name: "test Cloudflare account (provisioning)",
    config: {},
    createdByUserId: "test-user",
  });
  cloudflareConnectionId = connection.id;
});

afterAll(async () => {
  await closeDb(handle);
  await services.close();
  await dropScratchDb(dbName);
});

describe("infrastructure-provisioning.ts — composition-root wiring", () => {
  it("registers infrastructure.run-provisioning-template under its exact task name", () => {
    const tasks = createInfrastructureProvisioningTasks({ services });
    expect(tasks.runProvisioningTemplateTask.name).toBe(
      RUN_PROVISIONING_TEMPLATE_TASK,
    );
    expect(tasks.tasks).toHaveLength(1);
  });

  it("buildProvisioningProviders.resolveDnsProvider reaches the REAL Cloudflare adapter factory and resolves a zone", async () => {
    const providers = buildProvisioningProviders(services);
    const zoneName = "provisioning-wiring.test";
    fakeCloudflareZone(cloudflareState, {
      zoneName,
      externalZoneId: "zone-provisioning-wiring",
    });

    const dnsProvider = await providers.resolveDnsProvider(
      cloudflareConnectionId,
    );
    const zone = await dnsProvider.findZoneByName(zoneName);
    expect(zone?.externalZoneId).toBe("zone-provisioning-wiring");
    expect(zone?.status).toBe("active");
  });

  it("the registered task drives a real ProvisioningTemplatesService run through a real ProvisioningDriver, end to end for domain.declare", async () => {
    const domainName = "provisioning-task.test";
    fakeCloudflareZone(cloudflareState, {
      zoneName: domainName,
      externalZoneId: "zone-provisioning-task",
    });

    const templates = createProvisioningTemplatesService({ db: services.db });
    const template = await templates.create({
      name: "app-wiring-smoke-test",
      steps: [
        {
          stepKind: "domain.declare",
          provider: "cloudflare",
          params: { name: "${domain}", dnsConnectionId: "${dnsConnectionId}" },
        },
      ],
    });
    const run = await templates.startRun({
      templateId: template.id,
      inputs: { domain: domainName, dnsConnectionId: cloudflareConnectionId },
    });
    expect((run.compiledPlan as CompiledPlan).steps).toHaveLength(1);

    const tasks = createInfrastructureProvisioningTasks({ services });
    await tasks.runProvisioningTemplateTask.handler(
      { runId: run.id },
      { logger: silentJobsLogger, helpers: {} as never },
    );

    const advanced = await templates.getRun(run.id);
    expect(advanced.status).toBe("succeeded");

    const steps = await templates.listRunSteps(run.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe("succeeded");

    const domain = await handle.pool.query<{ external_zone_id: string | null }>(
      `select external_zone_id from managed_domains where name = $1`,
      [domainName],
    );
    expect(domain.rows[0]?.external_zone_id).toBe("zone-provisioning-task");
  });

  it("buildProvisioningDriver builds a real ProvisioningDriver instance (compile-time assignability + construction smoke)", () => {
    const driver = buildProvisioningDriver(services);
    expect(typeof driver.advance).toBe("function");
  });
});
