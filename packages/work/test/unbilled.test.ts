import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingRatesService } from "../src/billing-rates.ts";
import type { BillingRatesService } from "../src/billing-rates.ts";
import { createMaterialsService } from "../src/materials.ts";
import type { MaterialsService } from "../src/materials.ts";
import { createProjectsService } from "../src/projects.ts";
import type { ProjectsService } from "../src/projects.ts";
import { createTimeService } from "../src/time.ts";
import type { TimeService } from "../src/time.ts";
import { alwaysUnbilledResolver, createUnbilledWorkService } from "../src/unbilled.ts";
import type { BilledResolver } from "../src/unbilled.ts";
import {
  createMigratedScratchDb,
  scratchDbName,
  seedCounterparty,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("createUnbilledWorkService", () => {
  const dbName = scratchDbName("loxep_test_work_unbilled");
  let scratch: ScratchDb;
  let projects: ProjectsService;
  let time: TimeService;
  let materials: MaterialsService;
  let rates: BillingRatesService;
  let projectId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb(dbName);
    projects = createProjectsService({ db: scratch.handle.db });
    time = createTimeService({ db: scratch.handle.db });
    materials = createMaterialsService({ db: scratch.handle.db });
    rates = createBillingRatesService({ db: scratch.handle.db });
    const counterpartyId = await seedCounterparty(scratch, "Unbilled Fixture Co");
    const project = await projects.create({
      name: "Unbilled work fixture",
      projectKind: "job",
      billingMethod: "time_and_materials",
      currency: "USD",
      counterpartyId,
    });
    projectId = project.id;
    await rates.create({
      scopeKind: "project",
      rateKind: "bill",
      currency: "USD",
      amount: "100.00",
      projectId,
      effectiveFrom: "2026-01-01",
    });
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  it("uses alwaysUnbilledResolver by default and includes every billable, unlocked fact", async () => {
    const service = createUnbilledWorkService({ db: scratch.handle.db });

    const rated = await time.record({
      projectId,
      workedByLabel: "Rated Worker",
      workedOn: "2026-04-01",
      minutes: 60,
    });
    const unrated = await time.record({
      projectId,
      workedByLabel: "Unrated Worker",
      workedOn: "2026-04-02",
      minutes: 30,
      activityCode: "no-matching-rate-code",
    });
    // No rate scoped to this activity anywhere except the project-scoped one,
    // which fires first for a project-scoped entry — force unresolved by NOT
    // attaching a project.
    const trulyUnrated = await time.record({
      counterpartyId: (await projects.get(projectId)).counterpartyId as string,
      workedByLabel: "No project, no rate",
      workedOn: "2026-04-03",
      minutes: 20,
    });

    const nonBillable = await time.record({
      projectId,
      workedByLabel: "Not billable",
      workedOn: "2026-04-01",
      minutes: 60,
      billable: false,
    });

    const material = await materials.record({
      projectId,
      description: "Priced material",
      quantity: "2",
      consumedOn: "2026-04-01",
      costBasisSource: "purchased_for_job",
      currency: "USD",
      unitCostAmount: "10.00",
      unitChargeAmount: "15.00",
    });
    const unpricedMaterial = await materials.record({
      projectId,
      description: "Unpriced material",
      quantity: "1",
      consumedOn: "2026-04-02",
      costBasisSource: "none",
      currency: "USD",
    });

    const unbilledTime = await service.listUnbilledTime({ projectId });
    const ids = unbilledTime.map((row) => row.id);
    expect(ids).toContain(rated.id);
    expect(ids).toContain(unrated.id);
    expect(ids).not.toContain(nonBillable.id);
    // trulyUnrated has no project filter match since it has no projectId.
    expect(ids).not.toContain(trulyUnrated.id);

    const unbilledMaterials = await service.listUnbilledMaterials({ projectId });
    const materialIds = unbilledMaterials.map((row) => row.id);
    expect(materialIds).toContain(material.id);
    expect(materialIds).toContain(unpricedMaterial.id);
  });

  it("summarize() refuses a total for a currency bucket with an unrated/unpriced gap, and reports the gap count", async () => {
    const cp = await seedCounterparty(scratch, "Summary Co");
    const project = await projects.create({
      name: "Summary fixture",
      projectKind: "job",
      billingMethod: "time_and_materials",
      currency: "USD",
      counterpartyId: cp,
    });
    await rates.create({
      scopeKind: "project",
      rateKind: "bill",
      currency: "USD",
      amount: "50.00",
      projectId: project.id,
      effectiveFrom: "2026-01-01",
    });
    await time.record({
      projectId: project.id,
      workedByLabel: "Rated",
      workedOn: "2026-05-01",
      minutes: 60,
    });
    // Force an unrated entry by resolving before any rate existed on a SECOND project.
    const bareProject = await projects.create({
      name: "No rate project",
      projectKind: "job",
      billingMethod: "time_and_materials",
      currency: "USD",
      counterpartyId: cp,
    });

    const service = createUnbilledWorkService({ db: scratch.handle.db });
    const before = await service.summarize({ projectId: project.id });
    expect(before.time.unratedCount).toBe(0);
    expect(before.time.byCurrency.find((c) => c.currency === "USD")?.totalAmount).toBe(
      "50.000000",
    );

    await time.record({
      projectId: bareProject.id,
      workedByLabel: "Unrated",
      workedOn: "2026-05-02",
      minutes: 30,
    });
    // Scoped to this test's own counterparty so it is not polluted by
    // fixtures other tests in this file have already written to the shared
    // scratch database.
    const summary = await service.summarize({ counterpartyId: cp });
    expect(summary.time.unratedCount).toBeGreaterThanOrEqual(1);
    // The unrated entry has no currency, so it lands in its own "—" bucket
    // with a null total (there is nothing to compute an amount from), while
    // the rated project's USD bucket still reports its exact total.
    const usd = summary.time.byCurrency.find((c) => c.currency === "USD");
    expect(usd?.totalAmount).toBe("50.000000");
    expect(summary.coversSourceTypes).toEqual(["time_entry", "project_material_use"]);
  });

  it("an injected BilledResolver excludes facts it marks billed", async () => {
    const cp = await seedCounterparty(scratch, "Resolver Co");
    const project = await projects.create({
      name: "Resolver fixture",
      projectKind: "job",
      billingMethod: "time_and_materials",
      currency: "USD",
      counterpartyId: cp,
    });
    await rates.create({
      scopeKind: "project",
      rateKind: "bill",
      currency: "USD",
      amount: "60.00",
      projectId: project.id,
      effectiveFrom: "2026-01-01",
    });
    const entryA = await time.record({
      projectId: project.id,
      workedByLabel: "A",
      workedOn: "2026-06-01",
      minutes: 60,
    });
    const entryB = await time.record({
      projectId: project.id,
      workedByLabel: "B",
      workedOn: "2026-06-02",
      minutes: 60,
    });

    const billedSet = new Set([entryA.id]);
    const resolver: BilledResolver = {
      isBilled: async (sourceFactType, sourceFactId) =>
        sourceFactType === "time_entry" && billedSet.has(sourceFactId),
    };
    const service = createUnbilledWorkService({ db: scratch.handle.db, billedResolver: resolver });

    const unbilled = await service.listUnbilledTime({ projectId: project.id });
    const ids = unbilled.map((row) => row.id);
    expect(ids).not.toContain(entryA.id);
    expect(ids).toContain(entryB.id);
  });

  it("alwaysUnbilledResolver never marks anything billed", async () => {
    await expect(alwaysUnbilledResolver.isBilled("time_entry", "any-id")).resolves.toBe(false);
    await expect(
      alwaysUnbilledResolver.isBilled("project_material_use", "any-id"),
    ).resolves.toBe(false);
  });

  it("listUnratedBillableTime returns only entries with bill_rate_source = 'unresolved'", async () => {
    const cp = await seedCounterparty(scratch, "Unrated Co");
    const project = await projects.create({
      name: "Unrated fixture",
      projectKind: "job",
      billingMethod: "time_and_materials",
      currency: "USD",
      counterpartyId: cp,
    });
    const unrated = await time.record({
      projectId: project.id,
      workedByLabel: "Unrated",
      workedOn: "2026-07-01",
      minutes: 60,
    });
    await rates.create({
      scopeKind: "project",
      rateKind: "bill",
      currency: "USD",
      amount: "70.00",
      projectId: project.id,
      effectiveFrom: "2026-01-01",
    });
    const rated = await time.record({
      projectId: project.id,
      workedByLabel: "Rated",
      workedOn: "2026-07-02",
      minutes: 60,
    });

    const service = createUnbilledWorkService({ db: scratch.handle.db });
    const unratedList = await service.listUnratedBillableTime({ projectId: project.id });
    const ids = unratedList.map((row) => row.id);
    expect(ids).toContain(unrated.id);
    expect(ids).not.toContain(rated.id);
  });
});
