/**
 * Materials consumed on a job — migration 0011's `project_material_uses`
 * table, physical schema only until this slice (`bd show loxep-nw0`).
 *
 * ## The link points inward, and this service writes no `inventory_movements` row
 *
 * Per the design's "The link points inward, and Phase 4 gains no columns":
 * `inventory_item_id`, `inventory_allocation_id`, and `inventory_movement_id`
 * are all NULLABLE, and this service only ever REFERENCES an existing
 * inventory row — it never creates one. `@loxep/work` declares no dependency
 * on `@loxep/inventory` (only `@loxep/db` and `zod`), so "consuming stock on a
 * job calls the Phase 4 inventory service... in the same transaction as the
 * `project_material_uses` insert" (the design's own words) is composition
 * this package cannot do by itself. A caller that holds both packages —
 * `@loxep/app`, or a future orchestration layer — is expected to write the
 * `inventory_movements` consumption row first (through `@loxep/inventory`,
 * same transaction) and pass the resulting `inventoryMovementId` in here.
 * Recording a material use with `costBasisSource` other than
 * `'inventory_basis'` (`manual`, `purchased_for_job`, `none`) needs no
 * inventory reference at all and works standalone.
 *
 * ## Cost is snapshotted at consumption, never a read-time join
 *
 * When `costBasisSource = 'inventory_basis'`, `unitCostAmount` defaults to
 * `inventory_items.landed_cost_amount` and `currency` to the item's own
 * currency, read ONCE at record time (Phase 4 has no FX, so a caller-supplied
 * currency that disagrees with the item's is refused rather than silently
 * accepted). Passing `unitCostAmount` explicitly overrides the snapshot for a
 * documented correction.
 */
import type { LoxepDb } from "@loxep/db";
import { projectMaterialUses } from "@loxep/db/schema";
import { z } from "zod";
import { divideByInteger, multiplyDecimals, sumDecimals } from "./decimal.ts";
import {
  WorkBoundaryError,
  WorkConflictError,
  WorkNotFoundError,
  WorkValidationError,
} from "./errors.ts";
import { isUniqueViolation } from "./codes.ts";
import { decimalLiteral, nullable, textLiteral, toDate, uuidLiteral } from "./sql.ts";

export type ProjectMaterialUseRow = typeof projectMaterialUses.$inferSelect;

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const positiveDecimal = decimalString.refine((value) => Number(value) > 0, {
  message: "expected a positive decimal string",
});
const currencyCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const COST_BASIS_SOURCES = [
  "inventory_basis",
  "manual",
  "purchased_for_job",
  "none",
] as const;

const recordSchema = z
  .strictObject({
    projectId: z.uuid(),
    inventoryItemId: z.uuid().nullish(),
    catalogItemId: z.uuid().nullish(),
    inventoryAllocationId: z.uuid().nullish(),
    inventoryMovementId: z.uuid().nullish(),
    description: z.string().trim().min(1),
    quantity: positiveDecimal,
    consumedOn: isoDate,
    costBasisSource: z.enum(COST_BASIS_SOURCES),
    /** Overrides the inventory-basis snapshot, or sets a manual/purchased-for-job cost. Defaults to `'0'`. */
    unitCostAmount: decimalString.optional(),
    currency: currencyCode.nullish(),
    billable: z.boolean().default(true),
    markupPercent: decimalString.refine((v) => Number(v) >= -100, {
      message: "markupPercent must be >= -100 (project_material_uses_markup_check)",
    }).nullish(),
    unitChargeAmount: decimalString.nullish(),
    createdByUserId: z.string().min(1).nullish(),
  })
  .refine(
    (input) => (input.costBasisSource === "inventory_basis") === (input.inventoryItemId != null),
    {
      message:
        "inventoryItemId is required for, and only for, costBasisSource " +
        "'inventory_basis' (project_material_uses_cost_basis_item_check)",
      path: ["inventoryItemId"],
    },
  )
  .refine((input) => input.billable || input.unitChargeAmount == null, {
    message:
      "unitChargeAmount must be null when billable is false " +
      "(project_material_uses_billable_charge_check)",
    path: ["unitChargeAmount"],
  });

export type RecordMaterialUseInput = z.input<typeof recordSchema>;

const updateSchema = z
  .strictObject({
    materialUseId: z.uuid(),
    description: z.string().trim().min(1).optional(),
    billable: z.boolean().optional(),
    markupPercent: decimalString.refine((v) => Number(v) >= -100, {
      message: "markupPercent must be >= -100 (project_material_uses_markup_check)",
    }).nullish(),
    unitChargeAmount: decimalString.nullish(),
  })
  .refine((input) => input.billable !== false || input.unitChargeAmount == null, {
    message:
      "unitChargeAmount must be null when billable is false " +
      "(project_material_uses_billable_charge_check)",
    path: ["unitChargeAmount"],
  });

export type UpdateMaterialUseInput = z.input<typeof updateSchema>;

export interface MaterialsService {
  record: (input: RecordMaterialUseInput) => Promise<ProjectMaterialUseRow>;
  get: (materialUseId: string) => Promise<ProjectMaterialUseRow>;
  update: (input: UpdateMaterialUseInput) => Promise<ProjectMaterialUseRow>;
  listForProject: (
    projectId: string,
    options?: { billableOnly?: boolean; limit?: number },
  ) => Promise<ProjectMaterialUseRow[]>;
}

/**
 * `unitCostAmount * (1 + markupPercent / 100)`, rounded to `numeric(20,6)` at
 * each of its two arithmetic steps (an exact single-division decimal routine
 * for an arbitrary-scale percentage is beyond what this package needs) —
 * still exclusively BigInt decimal-string arithmetic, never a JS float.
 */
export function applyMarkupPercent(unitCostAmount: string, markupPercent: string): string {
  const rawMarkup = multiplyDecimals(unitCostAmount, markupPercent, 6).value;
  const markupAmount = divideByInteger(rawMarkup, 100, 6).value;
  return sumDecimals([unitCostAmount, markupAmount], 6);
}

/** `quantity * unitChargeAmount`. `null` when the use has no charge set (not billable, or unpriced). */
export function materialUseLineAmount(row: ProjectMaterialUseRow): string | null {
  if (row.unitChargeAmount === null) return null;
  return multiplyDecimals(row.quantity, row.unitChargeAmount, 6).value;
}

/**
 * Maps a raw `db.execute` row from `project_material_uses` to a
 * {@link ProjectMaterialUseRow}. Exported so `unbilled.ts` reads this table
 * through the identical mapping rather than a second, driftable copy.
 */
export function mapMaterialUseRow(row: Record<string, unknown>): ProjectMaterialUseRow {
  return {
    id: row["id"] as string,
    projectId: row["project_id"] as string,
    inventoryItemId: (row["inventory_item_id"] as string | null) ?? null,
    catalogItemId: (row["catalog_item_id"] as string | null) ?? null,
    inventoryAllocationId: (row["inventory_allocation_id"] as string | null) ?? null,
    inventoryMovementId: (row["inventory_movement_id"] as string | null) ?? null,
    description: row["description"] as string,
    quantity: row["quantity"] as string,
    consumedOn: row["consumed_on"] as string,
    currency: row["currency"] as string,
    unitCostAmount: row["unit_cost_amount"] as string,
    costBasisSource: row["cost_basis_source"] as string,
    billable: row["billable"] as boolean,
    markupPercent: (row["markup_percent"] as string | null) ?? null,
    unitChargeAmount: (row["unit_charge_amount"] as string | null) ?? null,
    lockedAt: row["locked_at"] === null ? null : toDate(row["locked_at"]),
    createdByUserId: (row["created_by_user_id"] as string | null) ?? null,
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
  };
}

export function createMaterialsService(options: { db: LoxepDb }): MaterialsService {
  const { db } = options;
  const toRow = mapMaterialUseRow;

  async function load(
    executor: Pick<LoxepDb, "execute">,
    materialUseId: string,
  ): Promise<ProjectMaterialUseRow> {
    const result = await executor.execute(
      `select * from project_material_uses where id = ${uuidLiteral(materialUseId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WorkNotFoundError(`unknown material use "${materialUseId}"`);
    }
    return toRow(row);
  }

  async function requireProject(
    executor: Pick<LoxepDb, "execute">,
    projectId: string,
  ): Promise<void> {
    const result = await executor.execute(
      `select id from projects where id = ${uuidLiteral(projectId)}`,
    );
    if (result.rows.length === 0) {
      throw new WorkNotFoundError(`unknown project "${projectId}"`);
    }
  }

  async function loadInventoryItem(
    executor: Pick<LoxepDb, "execute">,
    inventoryItemId: string,
  ): Promise<{ currency: string; landedCostAmount: string }> {
    const result = await executor.execute(
      `select currency, landed_cost_amount from inventory_items
        where id = ${uuidLiteral(inventoryItemId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WorkNotFoundError(`unknown inventory item "${inventoryItemId}"`);
    }
    return {
      currency: row["currency"] as string,
      landedCostAmount: row["landed_cost_amount"] as string,
    };
  }

  return {
    get: async (materialUseId) => load(db, materialUseId),

    record: async (input) => {
      const parsed = recordSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new WorkValidationError(`invalid material use: ${issues}`);
      }
      const value = parsed.data;

      return db.transaction(async (tx) => {
        await requireProject(tx, value.projectId);

        let currency = value.currency ?? null;
        let unitCostAmount = value.unitCostAmount ?? null;
        if (value.costBasisSource === "inventory_basis") {
          // inventoryItemId is guaranteed present by the schema refine above.
          const item = await loadInventoryItem(tx, value.inventoryItemId as string);
          if (currency !== null && currency.toUpperCase() !== item.currency) {
            throw new WorkValidationError(
              `currency "${currency}" disagrees with inventory item ` +
                `"${value.inventoryItemId}"'s own currency "${item.currency}" ` +
                "— Phase 4 carries no FX conversion",
            );
          }
          currency = currency ?? item.currency;
          unitCostAmount = unitCostAmount ?? item.landedCostAmount;
        } else if (currency === null) {
          throw new WorkValidationError(
            "currency is required when costBasisSource is not 'inventory_basis'",
          );
        }
        unitCostAmount = unitCostAmount ?? "0";

        let unitChargeAmount = value.unitChargeAmount ?? null;
        if (
          unitChargeAmount === null &&
          value.markupPercent != null &&
          value.billable
        ) {
          unitChargeAmount = applyMarkupPercent(unitCostAmount, value.markupPercent);
        }

        try {
          const inserted = await tx
            .insert(projectMaterialUses)
            .values({
              projectId: value.projectId,
              inventoryItemId: value.inventoryItemId ?? null,
              catalogItemId: value.catalogItemId ?? null,
              inventoryAllocationId: value.inventoryAllocationId ?? null,
              inventoryMovementId: value.inventoryMovementId ?? null,
              description: value.description,
              quantity: value.quantity,
              consumedOn: value.consumedOn,
              currency: currency.toUpperCase(),
              unitCostAmount,
              costBasisSource: value.costBasisSource,
              billable: value.billable,
              markupPercent: value.markupPercent ?? null,
              unitChargeAmount,
              createdByUserId: value.createdByUserId ?? null,
            })
            .returning();
          const row = inserted[0];
          if (row === undefined) {
            throw new WorkValidationError("project_material_uses insert returned no row");
          }
          return row;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new WorkConflictError(
              `inventory movement "${value.inventoryMovementId}" is already ` +
                "linked to a material use (project_material_uses_movement_uq) " +
                "— a consumption movement backs at most one use",
            );
          }
          throw error;
        }
      });
    },

    update: async (input) => {
      const parsed = updateSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new WorkValidationError(`invalid material use update: ${issues}`);
      }
      const value = parsed.data;

      return db.transaction(async (tx) => {
        const before = await load(tx, value.materialUseId);
        if (before.lockedAt !== null) {
          throw new WorkBoundaryError(
            `material use "${before.id}" is locked (attached to an issued invoice ` +
              "line) and cannot be edited",
          );
        }

        const nextBillable = value.billable ?? before.billable;
        const nextUnitCharge =
          value.unitChargeAmount === undefined ? before.unitChargeAmount : value.unitChargeAmount;
        if (!nextBillable && nextUnitCharge !== null) {
          throw new WorkValidationError(
            "unitChargeAmount must be null when billable is false " +
              "(project_material_uses_billable_charge_check)",
          );
        }

        const assignments = ["updated_at = now()"];
        if (value.description !== undefined) {
          assignments.push(`description = ${textLiteral(value.description)}`);
        }
        if (value.billable !== undefined) assignments.push(`billable = ${value.billable}`);
        if (value.markupPercent !== undefined) {
          assignments.push(`markup_percent = ${nullable(value.markupPercent, decimalLiteral)}`);
        }
        if (value.unitChargeAmount !== undefined) {
          assignments.push(`unit_charge_amount = ${nullable(value.unitChargeAmount, decimalLiteral)}`);
        }

        await tx.execute(
          `update project_material_uses set ${assignments.join(", ")}
            where id = ${uuidLiteral(before.id)}`,
        );
        return load(tx, before.id);
      });
    },

    listForProject: async (projectId, options) => {
      const predicates = [`project_id = ${uuidLiteral(projectId)}`];
      if (options?.billableOnly === true) predicates.push("billable");
      const limit =
        options?.limit === undefined ? "" : ` limit ${Math.max(1, Math.trunc(options.limit))}`;
      const result = await db.execute(
        `select * from project_material_uses where ${predicates.join(" and ")}
          order by consumed_on desc, created_at desc${limit}`,
      );
      return result.rows.map(toRow);
    },
  };
}
