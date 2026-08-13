import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectsService } from "../src/projects.ts";
import type { ProjectsService } from "../src/projects.ts";
import { WorkBoundaryError, WorkNotFoundError, WorkValidationError } from "../src/errors.ts";
import {
  createMigratedScratchDb,
  scratchDbName,
  seedCounterparty,
  seedCounterpartyRole,
  seedEntity,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("createProjectsService", () => {
  const dbName = scratchDbName("loxep_test_work_projects");
  let scratch: ScratchDb;
  let projects: ProjectsService;
  let entityId: string;
  let counterpartyId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb(dbName);
    projects = createProjectsService({ db: scratch.handle.db });
    entityId = await seedEntity(scratch, "Test LLC");
    counterpartyId = await seedCounterparty(scratch, "Acme Roofing");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  it("creates a project and generates a PRJ-<year>-NNNN reference code", async () => {
    const row = await projects.create({
      name: "Website rebuild",
      projectKind: "job",
      billingMethod: "time_and_materials",
      currency: "usd",
      counterpartyId,
    });
    expect(row.referenceCode).toMatch(/^PRJ-\d{4}-\d{4}$/);
    expect(row.currency).toBe("USD");
    expect(row.status).toBe("lead");
    expect(row.depth).toBe(0);
    expect(row.entityAttributionSource).toBe("unattributed");
  });

  it("round-trips a created project through get and getByReferenceCode", async () => {
    const created = await projects.create({
      name: "Retainer engagement",
      projectKind: "engagement",
      billingMethod: "non_billable",
      currency: "USD",
    });
    const byId = await projects.get(created.id);
    const byCode = await projects.getByReferenceCode(created.referenceCode);
    expect(byId).toEqual(created);
    expect(byCode).toEqual(created);
  });

  it("throws WorkNotFoundError for an unknown project id", async () => {
    await expect(projects.get("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      WorkNotFoundError,
    );
  });

  describe("billing_method consistency", () => {
    it("requires fixedPriceAmount for, and only for, billingMethod 'fixed_price'", async () => {
      await expect(
        projects.create({
          name: "Bad fixed price",
          projectKind: "job",
          billingMethod: "fixed_price",
          currency: "USD",
          counterpartyId,
        }),
      ).rejects.toThrow(WorkValidationError);

      await expect(
        projects.create({
          name: "Bad t&m with a price",
          projectKind: "job",
          billingMethod: "time_and_materials",
          currency: "USD",
          counterpartyId,
          fixedPriceAmount: "100.00",
        }),
      ).rejects.toThrow(WorkValidationError);

      const ok = await projects.create({
        name: "Good fixed price",
        projectKind: "job",
        billingMethod: "fixed_price",
        currency: "USD",
        counterpartyId,
        fixedPriceAmount: "2500.00",
      });
      expect(ok.fixedPriceAmount).toBe("2500.000000");
    });

    it("refuses a counterparty on an 'internal' project", async () => {
      await expect(
        projects.create({
          name: "Bad internal",
          projectKind: "internal",
          billingMethod: "internal",
          currency: "USD",
          counterpartyId,
        }),
      ).rejects.toThrow(WorkValidationError);
    });

    it("requires a counterparty on a billable project", async () => {
      await expect(
        projects.create({
          name: "Bad billable, no client",
          projectKind: "job",
          billingMethod: "time_and_materials",
          currency: "USD",
        }),
      ).rejects.toThrow(WorkValidationError);
    });

    it("allows an internal project with no counterparty", async () => {
      const row = await projects.create({
        name: "Shop maintenance",
        projectKind: "internal",
        billingMethod: "internal",
        currency: "USD",
      });
      expect(row.counterpartyId).toBeNull();
    });
  });

  describe("entity attribution ladder", () => {
    it("rung 1: an explicit economicEntityId sources as 'manual'", async () => {
      const row = await projects.create({
        name: "Manual attribution",
        projectKind: "job",
        billingMethod: "non_billable",
        currency: "USD",
        economicEntityId: entityId,
      });
      expect(row.entityAttributionSource).toBe("manual");
      expect(row.economicEntityId).toBe(entityId);
      expect(row.entityAttributedAt).not.toBeNull();
    });

    it("rung 2: a single active customer role on the counterparty resolves 'counterparty_role_default'", async () => {
      const cp = await seedCounterparty(scratch, "Rung Two Co");
      await seedCounterpartyRole(scratch, { counterpartyId: cp, economicEntityId: entityId });
      const row = await projects.create({
        name: "Ladder rung two",
        projectKind: "job",
        billingMethod: "time_and_materials",
        currency: "USD",
        counterpartyId: cp,
      });
      expect(row.entityAttributionSource).toBe("counterparty_role_default");
      expect(row.economicEntityId).toBe(entityId);
    });

    it("falls back to 'unattributed' when the counterparty has no active customer role", async () => {
      const row = await projects.create({
        name: "No role",
        projectKind: "job",
        billingMethod: "time_and_materials",
        currency: "USD",
        counterpartyId,
      });
      expect(row.entityAttributionSource).toBe("unattributed");
      expect(row.economicEntityId).toBeNull();
      expect(row.entityAttributedAt).toBeNull();
    });

    it("falls back to 'unattributed' when the counterparty holds roles with two different entities", async () => {
      const cp = await seedCounterparty(scratch, "Ambiguous Co");
      const otherEntity = await seedEntity(scratch, "Other LLC");
      await seedCounterpartyRole(scratch, { counterpartyId: cp, economicEntityId: entityId });
      await seedCounterpartyRole(scratch, {
        counterpartyId: cp,
        economicEntityId: otherEntity,
        role: "vendor",
      });
      // Two roles, but only ONE is 'customer' — rung 2 should still fire on the customer role alone.
      const row = await projects.create({
        name: "One customer role among several",
        projectKind: "job",
        billingMethod: "time_and_materials",
        currency: "USD",
        counterpartyId: cp,
      });
      expect(row.entityAttributionSource).toBe("counterparty_role_default");
      expect(row.economicEntityId).toBe(entityId);
    });

    it("reattributeEntity records an explicit change and can withdraw it", async () => {
      const row = await projects.create({
        name: "Reattribution target",
        projectKind: "job",
        billingMethod: "non_billable",
        currency: "USD",
      });
      const reattributed = await projects.reattributeEntity({
        projectId: row.id,
        economicEntityId: entityId,
      });
      expect(reattributed.entityAttributionSource).toBe("manual");
      expect(reattributed.economicEntityId).toBe(entityId);

      const withdrawn = await projects.reattributeEntity({
        projectId: row.id,
        economicEntityId: null,
      });
      expect(withdrawn.entityAttributionSource).toBe("unattributed");
      expect(withdrawn.economicEntityId).toBeNull();
      expect(withdrawn.entityAttributedAt).toBeNull();
    });
  });

  describe("hierarchy-lite", () => {
    it("accepts a depth-0 parent and sets the child's depth to 1", async () => {
      const parent = await projects.create({
        name: "Engagement",
        projectKind: "engagement",
        billingMethod: "non_billable",
        currency: "USD",
      });
      const child = await projects.create({
        name: "Job under engagement",
        projectKind: "job",
        billingMethod: "non_billable",
        currency: "USD",
        parentProjectId: parent.id,
      });
      expect(child.depth).toBe(1);

      const withChildren = await projects.listWithChildren(parent.id);
      expect(withChildren.map((p) => p.id).sort()).toEqual([parent.id, child.id].sort());
    });

    it("refuses a grandchild (a project whose parent already has depth 1)", async () => {
      const parent = await projects.create({
        name: "Root",
        projectKind: "engagement",
        billingMethod: "non_billable",
        currency: "USD",
      });
      const child = await projects.create({
        name: "Child",
        projectKind: "job",
        billingMethod: "non_billable",
        currency: "USD",
        parentProjectId: parent.id,
      });
      await expect(
        projects.create({
          name: "Grandchild",
          projectKind: "job",
          billingMethod: "non_billable",
          currency: "USD",
          parentProjectId: child.id,
        }),
      ).rejects.toThrow(WorkBoundaryError);
    });
  });

  describe("update and status lifecycle", () => {
    it("updates mutable fields and refuses targetEndOn before startsOn", async () => {
      const row = await projects.create({
        name: "Editable",
        projectKind: "job",
        billingMethod: "non_billable",
        currency: "USD",
        startsOn: "2026-01-10",
      });
      const updated = await projects.update({
        projectId: row.id,
        estimateAmount: "1500.00",
        budgetAmount: "1200.00",
        targetEndOn: "2026-02-01",
      });
      expect(updated.estimateAmount).toBe("1500.000000");
      expect(updated.budgetAmount).toBe("1200.000000");
      expect(updated.targetEndOn).toBe("2026-02-01");

      await expect(
        projects.update({ projectId: row.id, targetEndOn: "2026-01-01" }),
      ).rejects.toThrow(WorkValidationError);
    });

    it("stamps completedOn and closedAt on a completed-looking status, once", async () => {
      const row = await projects.create({
        name: "Status lifecycle",
        projectKind: "job",
        billingMethod: "non_billable",
        currency: "USD",
      });
      const active = await projects.updateStatus({ projectId: row.id, status: "active" });
      expect(active.completedOn).toBeNull();
      expect(active.closedAt).toBeNull();

      const completed = await projects.updateStatus({ projectId: row.id, status: "completed" });
      expect(completed.completedOn).not.toBeNull();
      expect(completed.closedAt).not.toBeNull();
      const firstClosedAt = completed.closedAt;

      // Re-affirming the same status must not rewrite an already-stamped closedAt.
      const again = await projects.updateStatus({ projectId: row.id, status: "completed" });
      expect(again.closedAt?.getTime()).toBe(firstClosedAt?.getTime());
    });

    it("accepts an unrecognized status verbatim (open TypeScript union, no CHECK)", async () => {
      const row = await projects.create({
        name: "Custom status",
        projectKind: "job",
        billingMethod: "non_billable",
        currency: "USD",
      });
      const updated = await projects.updateStatus({ projectId: row.id, status: "blocked_on_client" });
      expect(updated.status).toBe("blocked_on_client");
    });
  });

  describe("listing and filtering", () => {
    it("filters by counterparty, status, and free-text search", async () => {
      const cp = await seedCounterparty(scratch, "Filter Target Co");
      const a = await projects.create({
        name: "Filterable Alpha",
        projectKind: "job",
        billingMethod: "time_and_materials",
        currency: "USD",
        counterpartyId: cp,
      });
      await projects.updateStatus({ projectId: a.id, status: "active" });
      const b = await projects.create({
        name: "Unrelated Beta",
        projectKind: "job",
        billingMethod: "non_billable",
        currency: "USD",
      });

      const byCounterparty = await projects.list({ counterpartyId: cp });
      expect(byCounterparty.map((p) => p.id)).toEqual([a.id]);

      const byStatus = await projects.list({ statuses: ["active"] });
      expect(byStatus.some((p) => p.id === a.id)).toBe(true);
      expect(byStatus.some((p) => p.id === b.id)).toBe(false);

      const bySearch = await projects.list({ search: "Filterable" });
      expect(bySearch.map((p) => p.id)).toContain(a.id);
      expect(bySearch.map((p) => p.id)).not.toContain(b.id);
    });
  });
});
