/**
 * Project CRUD: a project, job, or engagement — migration 0011's `projects`
 * table, physical schema only until this slice (`bd show loxep-nw0`).
 *
 * ## Hierarchy-lite
 *
 * `depth between 0 and 1` at the database. This service enforces the modeling
 * claim behind that constraint at write time: a project may point at a
 * `depth = 0` parent, and a project that already has children (or is itself a
 * child) may not become a grandchild. See the design's "Hierarchy-lite means
 * two levels and no path cache".
 *
 * ## Entity attribution — three of the design's four rungs
 *
 * ```text
 * 1. explicit value chosen by the operator            'manual'
 * 2. the customer relationship's entity, from
 *    counterparty_entity_roles where role='customer'  'counterparty_role_default'
 * 3. the installation's default entity setting        'installation_default'
 * 4. no attribution available                         'unattributed'
 * ```
 *
 * Rung 3 needs an installation-wide default-entity SETTING, which lives in
 * `@loxep/domain` (`packages/domain/src/settings-defaults.ts`) — a package
 * `@loxep/work` does not depend on (only `@loxep/db` and `zod` are declared).
 * This service therefore resolves rungs 1, 2, and 4 automatically and accepts
 * `entityAttributionSource: 'installation_default'` only as an EXPLICIT,
 * caller-supplied value (the caller — e.g. a future orchestration layer that
 * holds both `@loxep/domain` and `@loxep/work` — resolves the setting and
 * hands the result in); it is never inferred here. This is the same kind of
 * honest seam as the unbilled-work read model's "billed" side (`unbilled.ts`):
 * documented rather than faked.
 *
 * ## Attribution mutability
 *
 * The design's rule is that attribution is "immutable once the project has an
 * issued invoice, and freely editable (audited) before." No invoice model
 * exists yet (`invoices`/`invoice_line_sources` are design-only — see
 * `unbilled.ts`), so there is nothing to check attribution against, and
 * {@link ProjectsService.reattributeEntity} is unconditionally editable today.
 * The gate belongs here once a billing package can answer "has this project's
 * work been invoiced".
 */
import type { LoxepDb } from "@loxep/db";
import { projects } from "@loxep/db/schema";
import { z } from "zod";
import { projectReferenceCode, withCodeRetry } from "./codes.ts";
import { WorkBoundaryError, WorkNotFoundError, WorkValidationError } from "./errors.ts";
import { dateLiteral, nullable, textLiteral, toDate, toDateOrNull, uuidLiteral } from "./sql.ts";

export type ProjectRow = typeof projects.$inferSelect;

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");

const currencyCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const BILLING_METHODS = [
  "time_and_materials",
  "fixed_price",
  "milestone",
  "subscription",
  "non_billable",
  "internal",
] as const;

const ENTITY_ATTRIBUTION_SOURCES = [
  "manual",
  "counterparty_role_default",
  "installation_default",
  "unattributed",
] as const;

const createSchema = z
  .strictObject({
    referenceCode: z.string().trim().min(1).optional(),
    parentProjectId: z.uuid().nullish(),
    counterpartyId: z.uuid().nullish(),
    counterpartySiteId: z.uuid().nullish(),
    economicEntityId: z.uuid().nullish(),
    /** Explicit override of the attribution ladder. See the module doc. */
    entityAttributionSource: z.enum(ENTITY_ATTRIBUTION_SOURCES).optional(),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).nullish(),
    /** Open set: any non-empty label. Nothing branches on an unknown member. */
    projectKind: z.string().trim().min(1),
    /** Open set: any non-empty label. Defaults to the schema's `'lead'`. */
    status: z.string().trim().min(1).optional(),
    billingMethod: z.enum(BILLING_METHODS),
    currency: currencyCode,
    /** The quote surrogate — Phase 6 owns no `quotes` table. */
    estimateAmount: decimalString.nullish(),
    budgetAmount: decimalString.nullish(),
    fixedPriceAmount: decimalString.nullish(),
    notToExceedAmount: decimalString.nullish(),
    startsOn: isoDate.nullish(),
    targetEndOn: isoDate.nullish(),
    createdByUserId: z.string().min(1).nullish(),
  })
  .refine(
    (input) =>
      (input.billingMethod === "fixed_price") ===
      (input.fixedPriceAmount !== undefined && input.fixedPriceAmount !== null),
    {
      message:
        "fixedPriceAmount is required for, and only for, billingMethod " +
        "'fixed_price' (projects_fixed_price_amount_check)",
      path: ["fixedPriceAmount"],
    },
  )
  .refine(
    (input) => input.billingMethod !== "internal" || input.counterpartyId == null,
    {
      message:
        "an 'internal' project may not name a counterparty " +
        "(projects_internal_no_counterparty_check)",
      path: ["counterpartyId"],
    },
  )
  .refine(
    (input) =>
      input.billingMethod === "internal" ||
      input.billingMethod === "non_billable" ||
      (input.counterpartyId !== undefined && input.counterpartyId !== null),
    {
      message:
        "a billable project must name a counterparty " +
        "(projects_billable_needs_counterparty_check)",
      path: ["counterpartyId"],
    },
  )
  .refine(
    (input) =>
      input.targetEndOn == null || input.startsOn == null || input.targetEndOn >= input.startsOn,
    {
      message: "targetEndOn must not precede startsOn (projects_target_end_check)",
      path: ["targetEndOn"],
    },
  )
  .refine(
    (input) =>
      input.entityAttributionSource !== "manual" ||
      (input.economicEntityId !== undefined && input.economicEntityId !== null),
    {
      message: "entityAttributionSource 'manual' requires economicEntityId",
      path: ["economicEntityId"],
    },
  );

export type CreateProjectInput = z.input<typeof createSchema>;

const updateSchema = z
  .strictObject({
    projectId: z.uuid(),
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).nullish(),
    projectKind: z.string().trim().min(1).optional(),
    counterpartySiteId: z.uuid().nullish(),
    estimateAmount: decimalString.nullish(),
    budgetAmount: decimalString.nullish(),
    notToExceedAmount: decimalString.nullish(),
    startsOn: isoDate.nullish(),
    targetEndOn: isoDate.nullish(),
    completedOn: isoDate.nullish(),
  })
  .refine(
    (input) =>
      input.targetEndOn == null || input.startsOn == null || input.targetEndOn >= input.startsOn,
    {
      message: "targetEndOn must not precede startsOn (projects_target_end_check)",
      path: ["targetEndOn"],
    },
  );

export type UpdateProjectInput = z.input<typeof updateSchema>;

const statusSchema = z.strictObject({
  projectId: z.uuid(),
  status: z.string().trim().min(1),
  completedOn: isoDate.nullish(),
  closedAt: z.boolean().optional(),
});

export type UpdateProjectStatusInput = z.input<typeof statusSchema>;

export interface ProjectListFilter {
  counterpartyId?: string;
  economicEntityId?: string;
  /** `null` matches only top-level (depth 0) projects. */
  parentProjectId?: string | null;
  statuses?: string[];
  billingMethods?: string[];
  /** Free-text over `name` and `reference_code`. */
  search?: string;
  limit?: number;
}

export interface ProjectsService {
  create: (input: CreateProjectInput) => Promise<ProjectRow>;
  get: (projectId: string) => Promise<ProjectRow>;
  getByReferenceCode: (referenceCode: string) => Promise<ProjectRow>;
  update: (input: UpdateProjectInput) => Promise<ProjectRow>;
  /**
   * Sets `status`, with two small conveniences: `completedOn` defaults to
   * today when omitted and the new status is `'completed'`, and `closedAt` is
   * stamped `now()` (once, never rewritten) when the new status is one of the
   * three closed-looking members the schema ships today. Both are
   * conveniences over an OPEN set, not a validation rule — an unrecognized
   * status is accepted and simply gets neither stamp.
   */
  updateStatus: (input: UpdateProjectStatusInput) => Promise<ProjectRow>;
  /** Explicit reattribution — see the module doc on mutability. */
  reattributeEntity: (input: {
    projectId: string;
    economicEntityId: string | null;
    source?: "manual" | "installation_default" | "unattributed";
    actorUserId?: string | null;
  }) => Promise<ProjectRow>;
  list: (filter?: ProjectListFilter) => Promise<ProjectRow[]>;
  /** `where parent_project_id = $1 or id = $1` — the design's cheap "everything under this project" query. */
  listWithChildren: (projectId: string) => Promise<ProjectRow[]>;
}

export function createProjectsService(options: { db: LoxepDb }): ProjectsService {
  const { db } = options;

  function toRow(row: Record<string, unknown>): ProjectRow {
    return {
      id: row["id"] as string,
      referenceCode: row["reference_code"] as string,
      parentProjectId: (row["parent_project_id"] as string | null) ?? null,
      counterpartyId: (row["counterparty_id"] as string | null) ?? null,
      counterpartySiteId: (row["counterparty_site_id"] as string | null) ?? null,
      economicEntityId: (row["economic_entity_id"] as string | null) ?? null,
      entityAttributionSource: row["entity_attribution_source"] as string,
      entityAttributedAt: toDateOrNull(row["entity_attributed_at"]),
      entityAttributedByUserId:
        (row["entity_attributed_by_user_id"] as string | null) ?? null,
      name: row["name"] as string,
      description: (row["description"] as string | null) ?? null,
      projectKind: row["project_kind"] as string,
      status: row["status"] as string,
      billingMethod: row["billing_method"] as string,
      currency: row["currency"] as string,
      estimateAmount: (row["estimate_amount"] as string | null) ?? null,
      budgetAmount: (row["budget_amount"] as string | null) ?? null,
      fixedPriceAmount: (row["fixed_price_amount"] as string | null) ?? null,
      notToExceedAmount: (row["not_to_exceed_amount"] as string | null) ?? null,
      depth: row["depth"] as number,
      startsOn: (row["starts_on"] as string | null) ?? null,
      targetEndOn: (row["target_end_on"] as string | null) ?? null,
      completedOn: (row["completed_on"] as string | null) ?? null,
      closedAt: toDateOrNull(row["closed_at"]),
      createdByUserId: (row["created_by_user_id"] as string | null) ?? null,
      createdAt: toDate(row["created_at"]),
      updatedAt: toDate(row["updated_at"]),
    };
  }

  async function load(executor: Pick<LoxepDb, "execute">, projectId: string): Promise<ProjectRow> {
    const result = await executor.execute(
      `select * from projects where id = ${uuidLiteral(projectId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WorkNotFoundError(`unknown project "${projectId}"`);
    }
    return toRow(row);
  }

  async function generateReferenceCode(
    executor: Pick<LoxepDb, "execute">,
    year: number,
  ): Promise<string> {
    const result = await executor.execute(
      `select coalesce(max(
                (substring(reference_code from '^PRJ-[0-9]{4}-([0-9]+)$'))::integer
              ), 0)::text as max_seq
         from projects
        where reference_code like ${textLiteral(`PRJ-${year}-%`)}`,
    );
    const next = Number(result.rows[0]?.["max_seq"] ?? "0") + 1;
    return projectReferenceCode(year, next);
  }

  /** Rung 2: the counterparty's single active customer-role entity, or `null` if zero or ambiguous. */
  async function resolveCounterpartyRoleEntity(
    executor: Pick<LoxepDb, "execute">,
    counterpartyId: string,
  ): Promise<string | null> {
    const result = await executor.execute(
      `select distinct economic_entity_id from counterparty_entity_roles
        where counterparty_id = ${uuidLiteral(counterpartyId)}
          and role = 'customer' and status = 'active'
          and economic_entity_id is not null`,
    );
    return result.rows.length === 1
      ? ((result.rows[0] as { economic_entity_id: string }).economic_entity_id)
      : null;
  }

  return {
    get: async (projectId) => load(db, projectId),

    getByReferenceCode: async (referenceCode) => {
      const result = await db.execute(
        `select * from projects where reference_code = ${textLiteral(referenceCode)}`,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new WorkNotFoundError(`unknown project reference code "${referenceCode}"`);
      }
      return toRow(row);
    },

    create: async (input) => {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new WorkValidationError(`invalid project: ${issues}`);
      }
      const value = parsed.data;
      const year = new Date().getUTCFullYear();

      return withCodeRetry(
        async () =>
          db.transaction(async (tx) => {
            let depth = 0;
            if (value.parentProjectId != null) {
              const parent = await load(tx, value.parentProjectId);
              if (parent.depth !== 0) {
                throw new WorkBoundaryError(
                  "a project may not become a grandchild: its parent already " +
                    "has depth 1 (hierarchy-lite, projects_depth_check)",
                );
              }
              depth = 1;
            }

            let economicEntityId = value.economicEntityId ?? null;
            let entityAttributionSource = value.entityAttributionSource;
            if (entityAttributionSource === undefined) {
              if (economicEntityId !== null) {
                entityAttributionSource = "manual";
              } else if (value.counterpartyId != null) {
                const resolved = await resolveCounterpartyRoleEntity(
                  tx,
                  value.counterpartyId,
                );
                if (resolved !== null) {
                  economicEntityId = resolved;
                  entityAttributionSource = "counterparty_role_default";
                } else {
                  entityAttributionSource = "unattributed";
                }
              } else {
                entityAttributionSource = "unattributed";
              }
            }

            const referenceCode =
              value.referenceCode ?? (await generateReferenceCode(tx, year));

            const inserted = await tx
              .insert(projects)
              .values({
                referenceCode,
                parentProjectId: value.parentProjectId ?? null,
                counterpartyId: value.counterpartyId ?? null,
                counterpartySiteId: value.counterpartySiteId ?? null,
                economicEntityId,
                entityAttributionSource,
                entityAttributedAt:
                  entityAttributionSource === "unattributed" ? null : new Date(),
                entityAttributedByUserId:
                  entityAttributionSource === "manual"
                    ? (value.createdByUserId ?? null)
                    : null,
                name: value.name,
                description: value.description ?? null,
                projectKind: value.projectKind,
                status: value.status ?? "lead",
                billingMethod: value.billingMethod,
                currency: value.currency.toUpperCase(),
                estimateAmount: value.estimateAmount ?? null,
                budgetAmount: value.budgetAmount ?? null,
                fixedPriceAmount: value.fixedPriceAmount ?? null,
                notToExceedAmount: value.notToExceedAmount ?? null,
                depth,
                startsOn: value.startsOn ?? null,
                targetEndOn: value.targetEndOn ?? null,
                createdByUserId: value.createdByUserId ?? null,
              })
              .returning();
            const row = inserted[0];
            if (row === undefined) {
              throw new WorkValidationError("projects insert returned no row");
            }
            return row;
          }),
        { label: "project reference code" },
      );
    },

    update: async (input) => {
      const parsed = updateSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new WorkValidationError(`invalid project update: ${issues}`);
      }
      const value = parsed.data;

      return db.transaction(async (tx) => {
        const before = await load(tx, value.projectId);

        const assignments = ["updated_at = now()"];
        if (value.name !== undefined) assignments.push(`name = ${textLiteral(value.name)}`);
        if (value.description !== undefined) {
          assignments.push(`description = ${nullable(value.description, textLiteral)}`);
        }
        if (value.projectKind !== undefined) {
          assignments.push(`project_kind = ${textLiteral(value.projectKind)}`);
        }
        if (value.counterpartySiteId !== undefined) {
          assignments.push(
            `counterparty_site_id = ${nullable(value.counterpartySiteId, uuidLiteral)}`,
          );
        }
        if (value.estimateAmount !== undefined) {
          assignments.push(
            `estimate_amount = ${value.estimateAmount === null ? "null" : value.estimateAmount}`,
          );
        }
        if (value.budgetAmount !== undefined) {
          assignments.push(
            `budget_amount = ${value.budgetAmount === null ? "null" : value.budgetAmount}`,
          );
        }
        if (value.notToExceedAmount !== undefined) {
          assignments.push(
            `not_to_exceed_amount = ${value.notToExceedAmount === null ? "null" : value.notToExceedAmount}`,
          );
        }
        const nextStartsOn = value.startsOn === undefined ? before.startsOn : value.startsOn;
        const nextTargetEndOn =
          value.targetEndOn === undefined ? before.targetEndOn : value.targetEndOn;
        if (
          nextTargetEndOn !== null &&
          nextStartsOn !== null &&
          nextTargetEndOn < nextStartsOn
        ) {
          throw new WorkValidationError(
            "targetEndOn must not precede startsOn (projects_target_end_check)",
          );
        }
        if (value.startsOn !== undefined) {
          assignments.push(`starts_on = ${nullable(value.startsOn, dateLiteral)}`);
        }
        if (value.targetEndOn !== undefined) {
          assignments.push(`target_end_on = ${nullable(value.targetEndOn, dateLiteral)}`);
        }
        if (value.completedOn !== undefined) {
          assignments.push(`completed_on = ${nullable(value.completedOn, dateLiteral)}`);
        }

        await tx.execute(
          `update projects set ${assignments.join(", ")} where id = ${uuidLiteral(before.id)}`,
        );
        return load(tx, before.id);
      });
    },

    updateStatus: async (input) => {
      const parsed = statusSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new WorkValidationError(`invalid status update: ${issues}`);
      }
      const value = parsed.data;
      return db.transaction(async (tx) => {
        const before = await load(tx, value.projectId);
        const assignments = [`status = ${textLiteral(value.status)}`, "updated_at = now()"];

        const completedOn =
          value.completedOn !== undefined
            ? value.completedOn
            : value.status === "completed" && before.completedOn === null
              ? new Date().toISOString().slice(0, 10)
              : undefined;
        if (completedOn !== undefined) {
          assignments.push(`completed_on = ${nullable(completedOn, dateLiteral)}`);
        }

        const closedLike = ["completed", "cancelled", "closed"];
        if (closedLike.includes(value.status) && before.closedAt === null) {
          assignments.push("closed_at = now()");
        }

        await tx.execute(
          `update projects set ${assignments.join(", ")} where id = ${uuidLiteral(before.id)}`,
        );
        return load(tx, before.id);
      });
    },

    reattributeEntity: async (input) => {
      const projectId = z.uuid().parse(input.projectId);
      const economicEntityId =
        input.economicEntityId === null ? null : z.uuid().parse(input.economicEntityId);
      const source = input.source ?? (economicEntityId === null ? "unattributed" : "manual");
      return db.transaction(async (tx) => {
        const before = await load(tx, projectId);
        await tx.execute(
          `update projects
              set economic_entity_id = ${nullable(economicEntityId, uuidLiteral)},
                  entity_attribution_source = ${textLiteral(source)},
                  entity_attributed_at = ${source === "unattributed" ? "null" : "now()"},
                  entity_attributed_by_user_id = ${
                    source === "manual" ? nullable(input.actorUserId ?? null, textLiteral) : "null"
                  },
                  updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        return load(tx, before.id);
      });
    },

    list: async (filter) => {
      const predicates: string[] = [];
      if (filter?.counterpartyId !== undefined) {
        predicates.push(`counterparty_id = ${uuidLiteral(filter.counterpartyId)}`);
      }
      if (filter?.economicEntityId !== undefined) {
        predicates.push(`economic_entity_id = ${uuidLiteral(filter.economicEntityId)}`);
      }
      if (filter?.parentProjectId !== undefined) {
        predicates.push(
          filter.parentProjectId === null
            ? "parent_project_id is null"
            : `parent_project_id = ${uuidLiteral(filter.parentProjectId)}`,
        );
      }
      if (filter?.statuses !== undefined && filter.statuses.length > 0) {
        predicates.push(`status in (${filter.statuses.map(textLiteral).join(", ")})`);
      }
      if (filter?.billingMethods !== undefined && filter.billingMethods.length > 0) {
        predicates.push(
          `billing_method in (${filter.billingMethods.map(textLiteral).join(", ")})`,
        );
      }
      if (filter?.search !== undefined && filter.search.trim() !== "") {
        const needle = textLiteral(`%${filter.search.trim()}%`);
        predicates.push(`(name ilike ${needle} or reference_code ilike ${needle})`);
      }
      const where = predicates.length === 0 ? "" : `where ${predicates.join(" and ")}`;
      const limit =
        filter?.limit === undefined ? "" : ` limit ${Math.max(1, Math.trunc(filter.limit))}`;
      const result = await db.execute(
        `select * from projects ${where} order by created_at desc, reference_code${limit}`,
      );
      return result.rows.map(toRow);
    },

    listWithChildren: async (projectId) => {
      const result = await db.execute(
        `select * from projects
          where parent_project_id = ${uuidLiteral(projectId)} or id = ${uuidLiteral(projectId)}
          order by depth, created_at`,
      );
      if (result.rows.length === 0) {
        throw new WorkNotFoundError(`unknown project "${projectId}"`);
      }
      return result.rows.map(toRow);
    },
  };
}
