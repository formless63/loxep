import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingRatesService } from "../src/billing-rates.ts";
import type { BillingRatesService } from "../src/billing-rates.ts";
import { createProjectsService } from "../src/projects.ts";
import type { ProjectsService } from "../src/projects.ts";
import { createTimeService, timeEntryBillableAmount, timeEntryCostAmount } from "../src/time.ts";
import type { TimeService } from "../src/time.ts";
import { WorkBoundaryError, WorkValidationError } from "../src/errors.ts";
import {
  createMigratedScratchDb,
  scratchDbName,
  seedCounterparty,
  seedEntity,
  seedUser,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("createTimeService (rate resolution and time-entry recording)", () => {
  const dbName = scratchDbName("loxep_test_work_time");
  let scratch: ScratchDb;
  let projects: ProjectsService;
  let time: TimeService;
  let rates: BillingRatesService;
  let counterpartyId: string;
  let workerId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb(dbName);
    projects = createProjectsService({ db: scratch.handle.db });
    time = createTimeService({ db: scratch.handle.db });
    rates = createBillingRatesService({ db: scratch.handle.db });
    await seedEntity(scratch, "Test LLC");
    counterpartyId = await seedCounterparty(scratch, "Ladder Co");
    workerId = await seedUser(scratch, "worker-1");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function makeProject(overrides: Partial<Parameters<ProjectsService["create"]>[0]> = {}) {
    return projects.create({
      name: `Project ${Math.random().toString(36).slice(2)}`,
      projectKind: "job",
      billingMethod: "time_and_materials",
      currency: "USD",
      counterpartyId,
      ...overrides,
    });
  }

  it("records a minimal billable entry and resolves 'unresolved' when no rate exists", async () => {
    const project = await makeProject();
    const entry = await time.record({
      projectId: project.id,
      workedByLabel: "Solo Operator",
      workedOn: "2026-03-01",
      minutes: 90,
    });
    expect(entry.billRateSource).toBe("unresolved");
    expect(entry.billRateAmount).toBeNull();
    expect(entry.currency).toBeNull();
    expect(entry.billable).toBe(true);
    expect(entry.billableMinutes).toBe(90);
    expect(timeEntryBillableAmount(entry)).toBeNull();
  });

  describe("the resolution ladder, rung by rung", () => {
    it("rung 6: falls back to the installation rate when nothing more specific matches", async () => {
      await rates.create({
        scopeKind: "installation",
        rateKind: "bill",
        currency: "USD",
        amount: "80.00",
        effectiveFrom: "2026-01-01",
      });
      const project = await makeProject();
      const entry = await time.record({
        projectId: project.id,
        workedByLabel: "Anonymous",
        workedOn: "2026-03-02",
        minutes: 60,
      });
      expect(entry.billRateSource).toBe("installation");
      expect(entry.billRateAmount).toBe("80.000000");
      expect(entry.currency).toBe("USD");
    });

    it("rung 5 (activity) outranks rung 6 (installation)", async () => {
      await rates.create({
        scopeKind: "activity",
        rateKind: "bill",
        currency: "USD",
        amount: "95.00",
        activityCode: "consulting",
        effectiveFrom: "2026-01-01",
      });
      const project = await makeProject();
      const entry = await time.record({
        projectId: project.id,
        workedByLabel: "Anonymous",
        workedOn: "2026-03-02",
        minutes: 60,
        activityCode: "consulting",
      });
      expect(entry.billRateSource).toBe("activity");
      expect(entry.billRateAmount).toBe("95.000000");
    });

    it("rung 4 (person) outranks rung 5 (activity)", async () => {
      await rates.create({
        scopeKind: "person",
        rateKind: "bill",
        currency: "USD",
        amount: "110.00",
        subjectUserId: workerId,
        effectiveFrom: "2026-01-01",
      });
      const project = await makeProject();
      const entry = await time.record({
        projectId: project.id,
        workedByUserId: workerId,
        workedByLabel: "Worker One",
        workedOn: "2026-03-02",
        minutes: 60,
        activityCode: "consulting",
      });
      expect(entry.billRateSource).toBe("person");
      expect(entry.billRateAmount).toBe("110.000000");
    });

    it("rung 3 (counterparty) outranks rung 4 (person)", async () => {
      await rates.create({
        scopeKind: "counterparty",
        rateKind: "bill",
        currency: "USD",
        amount: "125.00",
        counterpartyId,
        effectiveFrom: "2026-01-01",
      });
      const project = await makeProject();
      const entry = await time.record({
        projectId: project.id,
        workedByUserId: workerId,
        workedByLabel: "Worker One",
        workedOn: "2026-03-02",
        minutes: 60,
      });
      expect(entry.billRateSource).toBe("counterparty");
      expect(entry.billRateAmount).toBe("125.000000");
    });

    it("rung 2 (project) outranks rung 3 (counterparty)", async () => {
      const project = await makeProject();
      await rates.create({
        scopeKind: "project",
        rateKind: "bill",
        currency: "USD",
        amount: "150.00",
        projectId: project.id,
        effectiveFrom: "2026-01-01",
      });
      const entry = await time.record({
        projectId: project.id,
        workedByUserId: workerId,
        workedByLabel: "Worker One",
        workedOn: "2026-03-02",
        minutes: 60,
      });
      expect(entry.billRateSource).toBe("project");
      expect(entry.billRateAmount).toBe("150.000000");
      expect(entry.billingRateId).not.toBeNull();
    });

    it("rung 1 (project_person) outranks rung 2 (project) and everything below it", async () => {
      const project = await makeProject();
      await rates.create({
        scopeKind: "project",
        rateKind: "bill",
        currency: "USD",
        amount: "150.00",
        projectId: project.id,
        effectiveFrom: "2026-01-01",
      });
      await rates.create({
        scopeKind: "project_person",
        rateKind: "bill",
        currency: "USD",
        amount: "175.00",
        projectId: project.id,
        subjectUserId: workerId,
        effectiveFrom: "2026-01-01",
      });
      const entry = await time.record({
        projectId: project.id,
        workedByUserId: workerId,
        workedByLabel: "Worker One",
        workedOn: "2026-03-02",
        minutes: 60,
      });
      expect(entry.billRateSource).toBe("project_person");
      expect(entry.billRateAmount).toBe("175.000000");
    });

    it("a later effective_from wins within the same scope for an overlapping date", async () => {
      const project = await makeProject();
      await rates.create({
        scopeKind: "project",
        rateKind: "bill",
        currency: "USD",
        amount: "100.00",
        projectId: project.id,
        effectiveFrom: "2026-01-01",
      });
      await rates.create({
        scopeKind: "project",
        rateKind: "bill",
        currency: "USD",
        amount: "120.00",
        projectId: project.id,
        effectiveFrom: "2026-02-01",
      });
      const march = await time.record({
        projectId: project.id,
        workedByLabel: "Anon",
        workedOn: "2026-03-15",
        minutes: 60,
      });
      expect(march.billRateAmount).toBe("120.000000");

      const january = await time.record({
        projectId: project.id,
        workedByLabel: "Anon",
        workedOn: "2026-01-15",
        minutes: 60,
      });
      expect(january.billRateAmount).toBe("100.000000");
    });

    it("respects effective_to: a rate that has expired is not selected", async () => {
      // A fresh counterparty with no rates of its own: earlier rungs in this
      // block deliberately left counterparty/person/activity/installation
      // rates in place on the SHARED counterparty and worker so later rungs
      // could be shown outranking them — this test needs a clean slate below
      // "installation" so the expired project rate's fallback is unambiguous.
      const freshCounterpartyId = await seedCounterparty(scratch, "Effective-To Co");
      const project = await makeProject({ counterpartyId: freshCounterpartyId });
      await rates.create({
        scopeKind: "project",
        rateKind: "bill",
        currency: "USD",
        amount: "60.00",
        projectId: project.id,
        effectiveFrom: "2025-01-01",
        effectiveTo: "2025-12-31",
      });
      await rates.create({
        scopeKind: "installation",
        rateKind: "bill",
        currency: "USD",
        amount: "80.00",
        effectiveFrom: "2026-01-01",
      });
      const entry = await time.record({
        projectId: project.id,
        workedByLabel: "Anon",
        workedOn: "2026-03-02",
        minutes: 60,
      });
      // The expired project rate must not fire; falls through to installation.
      expect(entry.billRateSource).toBe("installation");
      expect(entry.billRateAmount).toBe("80.000000");
    });
  });

  it("a manual override sources as 'manual' and skips the ladder entirely", async () => {
    const project = await makeProject();
    await rates.create({
      scopeKind: "project",
      rateKind: "bill",
      currency: "USD",
      amount: "150.00",
      projectId: project.id,
      effectiveFrom: "2026-01-01",
    });
    const entry = await time.record({
      projectId: project.id,
      workedByLabel: "Anon",
      workedOn: "2026-03-02",
      minutes: 60,
      billRateAmount: "999.00",
      currency: "USD",
    });
    expect(entry.billRateSource).toBe("manual");
    expect(entry.billRateAmount).toBe("999.000000");
  });

  it("resolves bill and cost rates independently through the same ladder", async () => {
    const project = await makeProject();
    await rates.create({
      scopeKind: "project",
      rateKind: "bill",
      currency: "USD",
      amount: "150.00",
      projectId: project.id,
      effectiveFrom: "2026-01-01",
    });
    await rates.create({
      scopeKind: "project",
      rateKind: "cost",
      currency: "USD",
      amount: "70.00",
      projectId: project.id,
      effectiveFrom: "2026-01-01",
    });
    const entry = await time.record({
      projectId: project.id,
      workedByLabel: "Anon",
      workedOn: "2026-03-02",
      minutes: 60,
    });
    expect(entry.billRateAmount).toBe("150.000000");
    expect(entry.costRateAmount).toBe("70.000000");
    expect(timeEntryCostAmount(entry)).toBe("70.000000");
  });

  it("refuses to record when bill and cost rates resolve in different currencies", async () => {
    const project = await makeProject();
    await rates.create({
      scopeKind: "project",
      rateKind: "bill",
      currency: "USD",
      amount: "150.00",
      projectId: project.id,
      effectiveFrom: "2026-01-01",
    });
    await rates.create({
      scopeKind: "project",
      rateKind: "cost",
      currency: "GBP",
      amount: "70.00",
      projectId: project.id,
      effectiveFrom: "2026-01-01",
    });
    await expect(
      time.record({
        projectId: project.id,
        workedByLabel: "Anon",
        workedOn: "2026-03-02",
        minutes: 60,
      }),
    ).rejects.toThrow(WorkValidationError);
  });

  describe("derived billable amount: exact decimal-string arithmetic", () => {
    it("computes billable_minutes/60 * bill_rate_amount exactly, without floating-point drift", async () => {
      const project = await makeProject();
      await rates.create({
        scopeKind: "project",
        rateKind: "bill",
        currency: "USD",
        amount: "97.50",
        projectId: project.id,
        effectiveFrom: "2026-01-01",
      });
      // 50 minutes is exactly what breaks a naive `50/60*97.5` float computation
      // in ways that don't round to a clean 6-decimal numeric.
      const entry = await time.record({
        projectId: project.id,
        workedByLabel: "Anon",
        workedOn: "2026-03-02",
        minutes: 50,
      });
      expect(entry.billableMinutes).toBe(50);
      // 50/60 * 97.50 = 81.25 exactly.
      expect(timeEntryBillableAmount(entry)).toBe("81.250000");
    });

    it("returns null (never a silent zero) when billable but the rate is unresolved", async () => {
      const project = await makeProject();
      // Every rate seeded anywhere in this file has effective_from on or
      // after 2025-01-01 (see the ladder-rung tests above, which
      // deliberately leave an installation-scope rate in place for the rest
      // of the file). Working a date well before that guarantees NOTHING
      // resolves, regardless of what earlier tests left behind.
      const entry = await time.record({
        projectId: project.id,
        workedByLabel: "Anon",
        workedOn: "2020-03-02",
        minutes: 45,
      });
      expect(entry.billRateSource).toBe("unresolved");
      expect(timeEntryBillableAmount(entry)).toBeNull();
    });

    it("returns null when the entry is not billable, even with a resolved rate", async () => {
      const project = await makeProject();
      await rates.create({
        scopeKind: "project",
        rateKind: "bill",
        currency: "USD",
        amount: "100.00",
        projectId: project.id,
        effectiveFrom: "2026-01-01",
      });
      const entry = await time.record({
        projectId: project.id,
        workedByLabel: "Anon",
        workedOn: "2026-03-02",
        minutes: 60,
        billable: false,
      });
      expect(entry.billableMinutes).toBe(0);
      expect(timeEntryBillableAmount(entry)).toBeNull();
    });
  });

  describe("billable_minutes vs minutes", () => {
    it("defaults billableMinutes to minutes when billable", async () => {
      const project = await makeProject();
      const entry = await time.record({
        projectId: project.id,
        workedByLabel: "Anon",
        workedOn: "2026-03-02",
        minutes: 40,
      });
      expect(entry.billableMinutes).toBe(40);
    });

    it("allows billableMinutes to differ from minutes (a courtesy write-down)", async () => {
      const project = await makeProject();
      const entry = await time.record({
        projectId: project.id,
        workedByLabel: "Anon",
        workedOn: "2026-03-02",
        minutes: 90,
        billableMinutes: 60,
      });
      expect(entry.minutes).toBe(90);
      expect(entry.billableMinutes).toBe(60);
    });

    it("refuses a nonzero billableMinutes on a non-billable entry", async () => {
      const project = await makeProject();
      await expect(
        time.record({
          projectId: project.id,
          workedByLabel: "Anon",
          workedOn: "2026-03-02",
          minutes: 60,
          billable: false,
          billableMinutes: 30,
        }),
      ).rejects.toThrow(WorkValidationError);
    });
  });

  it("refuses to edit a locked time entry", async () => {
    const project = await makeProject();
    const entry = await time.record({
      projectId: project.id,
      workedByLabel: "Anon",
      workedOn: "2026-03-02",
      minutes: 60,
    });
    await scratch.handle.pool.query(
      "update time_entries set locked_at = now() where id = $1",
      [entry.id],
    );
    await expect(time.update({ timeEntryId: entry.id, minutes: 30 })).rejects.toThrow(
      WorkBoundaryError,
    );
    await expect(time.reresolveRates(entry.id)).rejects.toThrow(WorkBoundaryError);
  });

  it("reresolveRates backfills a rate for an entry recorded before one existed", async () => {
    const project = await makeProject();
    // Worked well before any rate seeded anywhere in this file is effective
    // (see the note in the "unresolved" test above), so this starts out
    // genuinely unresolved regardless of test order.
    const entry = await time.record({
      projectId: project.id,
      workedByLabel: "Anon",
      workedOn: "2020-03-02",
      minutes: 60,
    });
    expect(entry.billRateSource).toBe("unresolved");
    await rates.create({
      scopeKind: "project",
      rateKind: "bill",
      currency: "USD",
      amount: "88.00",
      projectId: project.id,
      effectiveFrom: "2019-01-01",
    });
    const resolved = await time.reresolveRates(entry.id);
    expect(resolved.billRateSource).toBe("project");
    expect(resolved.billRateAmount).toBe("88.000000");
  });
});
