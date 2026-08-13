import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMarkupPercent,
  createMaterialsService,
  materialUseLineAmount,
} from "../src/materials.ts";
import type { MaterialsService } from "../src/materials.ts";
import { createProjectsService } from "../src/projects.ts";
import type { ProjectsService } from "../src/projects.ts";
import { WorkBoundaryError, WorkConflictError, WorkValidationError } from "../src/errors.ts";
import {
  createMigratedScratchDb,
  scratchDbName,
  seedCounterparty,
  seedInventoryItem,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("createMaterialsService", () => {
  const dbName = scratchDbName("loxep_test_work_materials");
  let scratch: ScratchDb;
  let projects: ProjectsService;
  let materials: MaterialsService;
  let projectId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb(dbName);
    projects = createProjectsService({ db: scratch.handle.db });
    materials = createMaterialsService({ db: scratch.handle.db });
    const counterpartyId = await seedCounterparty(scratch, "Materials Co");
    const project = await projects.create({
      name: "Kitchen remodel",
      projectKind: "job",
      billingMethod: "time_and_materials",
      currency: "USD",
      counterpartyId,
    });
    projectId = project.id;
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  it("snapshots unitCostAmount and currency from the inventory item at consumption", async () => {
    const itemId = await seedInventoryItem(scratch, { landedCostAmount: "42.500000", currency: "USD" });
    const row = await materials.record({
      projectId,
      inventoryItemId: itemId,
      description: "Copper fitting",
      quantity: "3",
      consumedOn: "2026-03-05",
      costBasisSource: "inventory_basis",
    });
    expect(row.unitCostAmount).toBe("42.500000");
    expect(row.currency).toBe("USD");
    expect(row.costBasisSource).toBe("inventory_basis");
  });

  it("refuses a caller-supplied currency that disagrees with the inventory item's own currency", async () => {
    const itemId = await seedInventoryItem(scratch, { landedCostAmount: "10.00", currency: "GBP" });
    await expect(
      materials.record({
        projectId,
        inventoryItemId: itemId,
        description: "Mismatched currency",
        quantity: "1",
        consumedOn: "2026-03-05",
        costBasisSource: "inventory_basis",
        currency: "USD",
      }),
    ).rejects.toThrow(WorkValidationError);
  });

  it("requires inventoryItemId for, and only for, costBasisSource 'inventory_basis'", async () => {
    await expect(
      materials.record({
        projectId,
        description: "No item given",
        quantity: "1",
        consumedOn: "2026-03-05",
        costBasisSource: "inventory_basis",
        currency: "USD",
      }),
    ).rejects.toThrow(WorkValidationError);

    const itemId = await seedInventoryItem(scratch, { landedCostAmount: "5.00" });
    await expect(
      materials.record({
        projectId,
        inventoryItemId: itemId,
        description: "Item given but manual basis",
        quantity: "1",
        consumedOn: "2026-03-05",
        costBasisSource: "manual",
        currency: "USD",
      }),
    ).rejects.toThrow(WorkValidationError);
  });

  it("defaults unitCostAmount to '0' for non-inventory cost bases and requires an explicit currency", async () => {
    await expect(
      materials.record({
        projectId,
        description: "No currency given",
        quantity: "1",
        consumedOn: "2026-03-05",
        costBasisSource: "none",
      }),
    ).rejects.toThrow(WorkValidationError);

    const row = await materials.record({
      projectId,
      description: "Free part",
      quantity: "1",
      consumedOn: "2026-03-05",
      costBasisSource: "none",
      currency: "USD",
    });
    expect(row.unitCostAmount).toBe("0.000000");
  });

  it("accepts 'purchased_for_job' with an explicit unitCostAmount", async () => {
    const row = await materials.record({
      projectId,
      description: "Rented scaffold, bought same day",
      quantity: "1",
      consumedOn: "2026-03-05",
      costBasisSource: "purchased_for_job",
      currency: "USD",
      unitCostAmount: "120.00",
    });
    expect(row.unitCostAmount).toBe("120.000000");
  });

  describe("markup and the derived line amount", () => {
    it("applyMarkupPercent computes unit_cost * (1 + markup/100) exactly", () => {
      expect(applyMarkupPercent("100.000000", "20")).toBe("120.000000");
      expect(applyMarkupPercent("33.330000", "15")).toBe("38.329500");
      expect(applyMarkupPercent("50.000000", "-10")).toBe("45.000000");
    });

    it("computes unitChargeAmount from markupPercent when not given explicitly", async () => {
      const row = await materials.record({
        projectId,
        description: "Marked-up part",
        quantity: "2",
        consumedOn: "2026-03-05",
        costBasisSource: "purchased_for_job",
        currency: "USD",
        unitCostAmount: "50.00",
        markupPercent: "20",
      });
      expect(row.unitChargeAmount).toBe("60.000000");
      // quantity(2) * unitChargeAmount(60.00) = 120.00, exact.
      expect(materialUseLineAmount(row)).toBe("120.000000");
    });

    it("an explicit unitChargeAmount wins over a computed markup", async () => {
      const row = await materials.record({
        projectId,
        description: "Explicit charge wins",
        quantity: "1",
        consumedOn: "2026-03-05",
        costBasisSource: "purchased_for_job",
        currency: "USD",
        unitCostAmount: "50.00",
        markupPercent: "20",
        unitChargeAmount: "999.00",
      });
      expect(row.unitChargeAmount).toBe("999.000000");
    });

    it("returns null from materialUseLineAmount when there is no charge (unpriced)", async () => {
      const row = await materials.record({
        projectId,
        description: "Unpriced",
        quantity: "1",
        consumedOn: "2026-03-05",
        costBasisSource: "none",
        currency: "USD",
      });
      expect(row.unitChargeAmount).toBeNull();
      expect(materialUseLineAmount(row)).toBeNull();
    });

    it("refuses a nonzero unitChargeAmount on a non-billable use", async () => {
      await expect(
        materials.record({
          projectId,
          description: "Non-billable with a charge",
          quantity: "1",
          consumedOn: "2026-03-05",
          costBasisSource: "none",
          currency: "USD",
          billable: false,
          unitChargeAmount: "10.00",
        }),
      ).rejects.toThrow(WorkValidationError);
    });

    it("does not compute a markup-derived charge on a non-billable use", async () => {
      const row = await materials.record({
        projectId,
        description: "Non-billable, has markup input but no charge",
        quantity: "1",
        consumedOn: "2026-03-05",
        costBasisSource: "purchased_for_job",
        currency: "USD",
        unitCostAmount: "50.00",
        markupPercent: "20",
        billable: false,
      });
      expect(row.unitChargeAmount).toBeNull();
    });
  });

  it("refuses markupPercent below -100 (project_material_uses_markup_check)", async () => {
    await expect(
      materials.record({
        projectId,
        description: "Impossible markdown",
        quantity: "1",
        consumedOn: "2026-03-05",
        costBasisSource: "none",
        currency: "USD",
        markupPercent: "-150",
      }),
    ).rejects.toThrow();
  });

  it("a consumption movement backs at most one material use (idempotency probe)", async () => {
    const itemId = await seedInventoryItem(scratch, { landedCostAmount: "10.00" });
    const dedupeKey = `dedupe-${randomBytes(4).toString("hex")}`;
    const movement = await scratch.handle.pool.query<{ id: string }>(
      `insert into inventory_movements
         (inventory_item_id, movement_kind, quantity, deduplication_key, occurred_at)
       values ($1, 'consumption', -1, $2, now())
       returning id`,
      [itemId, dedupeKey],
    );
    const movementId = movement.rows[0]?.id;
    if (movementId === undefined) throw new Error("movement insert returned no row");

    const first = await materials.record({
      projectId,
      inventoryItemId: itemId,
      inventoryMovementId: movementId,
      description: "Linked to a real movement",
      quantity: "1",
      consumedOn: "2026-03-05",
      costBasisSource: "inventory_basis",
    });
    expect(first.inventoryMovementId).toBe(movementId);

    await expect(
      materials.record({
        projectId,
        inventoryItemId: itemId,
        inventoryMovementId: movementId,
        description: "Same movement again",
        quantity: "1",
        consumedOn: "2026-03-05",
        costBasisSource: "inventory_basis",
      }),
    ).rejects.toThrow(WorkConflictError);
  });

  it("round-trips through get and listForProject", async () => {
    const row = await materials.record({
      projectId,
      description: "Listable",
      quantity: "1",
      consumedOn: "2026-03-06",
      costBasisSource: "none",
      currency: "USD",
    });
    const fetched = await materials.get(row.id);
    expect(fetched).toEqual(row);
    const listed = await materials.listForProject(projectId);
    expect(listed.map((r) => r.id)).toContain(row.id);
  });

  it("refuses to edit a locked material use", async () => {
    const row = await materials.record({
      projectId,
      description: "Will be locked",
      quantity: "1",
      consumedOn: "2026-03-06",
      costBasisSource: "none",
      currency: "USD",
    });
    await scratch.handle.pool.query(
      "update project_material_uses set locked_at = now() where id = $1",
      [row.id],
    );
    await expect(
      materials.update({ materialUseId: row.id, description: "edited" }),
    ).rejects.toThrow(WorkBoundaryError);
  });
});
